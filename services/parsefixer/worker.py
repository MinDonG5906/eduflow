"""Authenticated, single-worker adapter for the pinned upstream ParseFixer CLI.

Run on a machine that supports MinerU. No paid upstream fallbacks are enabled:
EduFlow performs correction and source verification under its own cost ledger.
"""
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

COMMIT = "c3d48d2a7d17a13c526ff0fa42731f389a3bbf83"
MAX_BODY = 22 * 1024 * 1024


def parse_page(image, source, model, backend):
    from PIL import Image
    with Image.open(io.BytesIO(image)) as picture:
        if picture.format != "PNG" or picture.width * picture.height > 30_000_000:
            raise ValueError("Invalid page image")
        picture.verify()
    with tempfile.TemporaryDirectory(prefix="eduflow-parsefixer-") as temp:
        root = Path(temp)
        images = root / "images" / "document"
        images.mkdir(parents=True)
        (images / "page_001.png").write_bytes(image)
        output = root / "output"
        command = [sys.executable, str(source / "run_parsefixer.py"),
                   "--image-root", str(root / "images"), "--out-root", str(output),
                   "--mineru-model-path", str(model), "--mineru-backend", backend,
                   "--page-model-provider", "none", "--table-model-provider", "none",
                   "--formula-model-provider", "none", "--resume", "false"]
        env = {key: value for key, value in os.environ.items()
               if key not in {"OPENAI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"}}
        with (root / "process.log").open("wb") as log:
            subprocess.run(command, cwd=source, env=env, stdout=log, stderr=log,
                           check=True, timeout=480)
        backbone = json.loads((output / "fbp_json/document/page_001.json").read_text())
        failures = json.loads((output / "logs/asc_failures.json").read_text())
        if backbone.get("status") != "ok" or failures:
            raise RuntimeError("Parser failed; do not accept a fallback as verified")
        initial = (output / "page_markdown/document/page_001.md").read_text(encoding="utf-8")
        final = (output / "final_page_markdown/document/page_001.md").read_text(encoding="utf-8")
        if not final.strip() or max(len(initial), len(final)) > 100_000:
            raise RuntimeError("Invalid parser output")
        return {"commit": COMMIT, "imageHash": hashlib.sha256(image).hexdigest(),
                "initial": initial, "markdown": final}


def main():
    source = Path(os.environ["PARSEFIXER_SOURCE"]).resolve()
    model = Path(os.environ["MINERU_MODEL_PATH"]).resolve()
    token = os.environ["EDUFLOW_PARSEFIXER_KEY"]
    if len(token) < 24 or not model.exists():
        raise RuntimeError("Configure a model and a token of at least 24 characters")
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True).strip()
    if actual != COMMIT or dirty:
        raise RuntimeError("ParseFixer must match the pinned, unmodified source revision")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Source contents, credentials and provider output never enter HTTP logs.

        def respond(self, code, data):
            payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                return self.respond(401, {"error": "Unauthorized"})
            if self.path != "/parse":
                return self.respond(404, {"error": "Not found"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_BODY:
                    return self.respond(413, {"error": "Invalid request size"})
                self.connection.settimeout(30)
                body = json.loads(self.rfile.read(length))
                image = base64.b64decode(body["image"], validate=True)
                if len(image) > 15 * 1024 * 1024:
                    return self.respond(413, {"error": "Invalid image size"})
                result = parse_page(image, source, model, os.environ.get("MINERU_BACKEND", "vllm-engine"))
                self.respond(200, result)
            except (ValueError, KeyError, TypeError):
                self.respond(400, {"error": "Invalid page request"})
            except Exception:
                self.respond(503, {"error": "Parser unavailable; page remains held"})

    HTTPServer(("127.0.0.1", int(os.environ.get("PARSEFIXER_PORT", "8765"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
