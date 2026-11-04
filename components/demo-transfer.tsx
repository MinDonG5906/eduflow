"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadText } from "@/lib/download";
import { exportWorkPackage, importWorkPackage } from "@/lib/work-package-browser";
import { MAX_WORK_PACKAGE_BYTES, parseWorkPackage } from "@/lib/work-package";
import { DRAFT_STORAGE_KEY, readDraft } from "@/lib/studio-state";

export default function DemoTransfer() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pending, setPending] = useState<{ raw: string; title: string; scenes: number } | null>(null);
  const [current, setCurrent] = useState("");
  useEffect(() => {
    function update() {
      try { const raw = localStorage.getItem(DRAFT_STORAGE_KEY); const draft = raw ? readDraft(raw) : null;
        setCurrent(draft ? `${draft.board?.title || "저장된 원고"} · ${draft.board?.scenes.length ?? 0}개 장면` : "이 브라우저에 저장된 작업이 없습니다.");
      } catch { setCurrent("현재 저장된 작업을 읽지 못했습니다."); }
    }
    update(); window.addEventListener("storage", update); return () => window.removeEventListener("storage", update);
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "작업 묶음을 처리하지 못했습니다."); }
    finally { setBusy(false); }
  }
  function preview(raw: string) {
    const { draft } = parseWorkPackage(raw);
    setPending({ raw, title: draft.board?.title || "저장된 원고", scenes: draft.board?.scenes.length ?? 0 });
  }
  return <main className="demo-transfer">
    <a href="/">← 스토리보드로 돌아가기</a>
    <h1>데모 전달</h1>
    <p>현재 작업의 근거 연결·이미지·편집 내용을 함께 저장하고 다른 PC에서 열 수 있습니다.</p>
    <section>
      <h2>현재 작업 담기</h2>
      <strong>{current}</strong>
      <p>작업 묶음을 내려받고, 다음 데모 패키지에 포함할 예제로 저장합니다. RAG 원문과 검색 데이터는 배포 패키지에 별도로 포함됩니다.</p>
      <Button disabled={busy} onClick={() => void run(async () => {
        const raw = await exportWorkPackage();
        const response = await fetch("/api/demo/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
        if (!response.ok) throw new Error((await response.json()).error);
        downloadText(raw, "application/json", "스토리보드.eduflow-work.json");
        setNotice("작업 묶음을 내려받고 데모 예제로 저장했습니다. 배포 패키지는 다시 만들어야 최신 예제가 포함됩니다.");
      })}>현재 작업 묶음 저장</Button>
    </section>
    <section>
      <h2>전달받은 작업 열기</h2>
      <div className="demo-transfer-actions">
        <label className="form-field">작업 묶음 파일
          <input type="file" accept=".json" disabled={busy} onChange={e => {
            const file = e.target.files?.[0]; e.target.value = "";
            if (file) void run(async () => { if (file.size > MAX_WORK_PACKAGE_BYTES) throw new Error("작업 묶음은 160MB까지 열 수 있습니다."); preview(await file.text()); });
          }} />
        </label>
        <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
          const response = await fetch("/api/demo/work", { method: "POST", headers: { "Content-Type": "application/json", "X-Demo-Action": "read" }, body: "{}" });
          if (!response.ok) throw new Error((await response.json()).error);
          preview(await response.text());
        })}>패키지의 예제 확인</Button>
      </div>
      {pending && <div className="demo-transfer-preview">
        <strong>{pending.title}</strong><p>{pending.scenes}개 장면 · 근거 연결과 첨부 이미지 포함</p>
        <p>열면 현재 작업이 바뀝니다. 기존 작업이 있으면 먼저 작업 묶음으로 내려받습니다.</p>
        <Button disabled={busy} onClick={() => void run(async () => {
          if (localStorage.getItem(DRAFT_STORAGE_KEY)) downloadText(await exportWorkPackage(), "application/json", "이전작업.eduflow-work.json");
          await importWorkPackage(pending.raw); window.location.assign("/");
        })}>기존 작업 백업 후 열기</Button>
      </div>}
    </section>
    <details><summary>전달 범위와 실행 방법</summary><p>작업 묶음에는 현재 브라우저의 작업 1개와 선택한 원고 PDF가 포함됩니다. 이전 작업 전체나 선택하지 않은 원고 페이지는 포함되지 않습니다. RAG는 별도 배포 패키지에 함께 들어가야 원문 확인과 새 검색이 가능합니다.</p><p>패키지는 Windows·macOS용 첫 실행 도구를 제공합니다. Node.js 24와 최초 설치 시 인터넷이 필요합니다. 기존 결과 열기·편집·PDF 출력은 AI 호출 없이 가능하며 새 AI 생성은 별도 모델 연결이 필요합니다.</p></details>
    {busy && <p role="status">작업 묶음을 처리하고 있습니다…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="demo-transfer-error">{error}</p>}
  </main>;
}
