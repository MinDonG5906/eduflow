"use client";

import { useEffect, useState } from "react";
import { KeyRound, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CONNECTION_CHANGED } from "@/hooks/use-generator-status";
import type { Provider, PublicConnection } from "@/lib/server/connection-store";

type Action = Record<string, unknown> & { action: string };

const providerText: Record<Provider, { title: string; detail: string }> = {
  demo: { title: "무료 데모", detail: "원문을 나누는 데모 · 외부 AI 전송 없음" },
  "openai-api": { title: "OpenAI API 키", detail: "내 키로 결제 · 이 PC 하루 $1·월 $5 한도" },
  "anthropic-api": { title: "Claude API 키", detail: "Claude Console 키로 결제 · 같은 비용 한도" },
};

function KeyForm({ vendor, saved, onSave, onRemove, busy }: {
  vendor: "openai" | "anthropic"; saved: string | null; busy: boolean;
  onSave: (key: string) => Promise<boolean>; onRemove: () => void;
}) {
  const [key, setKey] = useState("");
  const [consent, setConsent] = useState(false);
  const id = `${vendor}-key`;
  return (
    <div className="connection-fields">
      {saved && (
        <div className="connection-saved">
          <KeyRound size={14} /> 저장된 키 <code>{saved}</code>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove}>키 삭제</Button>
        </div>
      )}
      <label className="form-field" htmlFor={id}>
        <span>{saved ? "새 키로 바꾸기" : vendor === "openai" ? "OpenAI API 키" : "Claude API 키 (Claude Console)"}</span>
        <Input id={id} type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy}
          placeholder={vendor === "openai" ? "sk-..." : "sk-ant-..."} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="connection-check">
        <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} />
        <span>유료 호출에 동의합니다. 이 PC 기준 하루 $1·월 $5 한도 안에서만 호출합니다.</span>
      </label>
      <Button disabled={busy || key.trim().length < 10 || !consent}
        onClick={async () => { if (await onSave(key.trim())) { setKey(""); setConsent(false); } }}>
        키 저장하고 사용
      </Button>
      <p className="connection-note">키는 이 PC의 <code>.eduflow-private</code> 폴더에만 저장하고 화면이나 브라우저로 다시 보내지 않습니다.</p>
    </div>
  );
}

export function ConnectionDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<PublicConnection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(body: Action | null) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/connection", body ? {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
      } : { cache: "no-store" });
      const raw = await response.json();
      if (!response.ok) throw new Error(typeof raw.error === "string" ? raw.error : "연결 설정을 저장하지 못했습니다.");
      return raw;
    } catch (e) {
      setError(e instanceof Error ? e.message : "연결 설정을 저장하지 못했습니다.");
      return null;
    } finally { setBusy(false); }
  }
  async function change(body: Action) {
    const next = await send(body);
    if (next && "provider" in next) {
      setStatus(next);
      window.dispatchEvent(new Event(CONNECTION_CHANGED));
    }
    return Boolean(next);
  }
  useEffect(() => {
    if (!open) return;
    send(null).then((next) => next && setStatus(next));
  }, [open]);

  const providers = Object.keys(providerText) as Provider[];
  const selected = status?.provider;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="connection-dialog">
        <DialogHeader>
          <div className="modal-icon"><PlugZap size={22} /></div>
          <DialogTitle>모델 연결</DialogTitle>
          <DialogDescription>생성에 사용할 AI와 결제 방식을 고르세요. 설정은 이 PC의 EduFlow 서버에만 저장됩니다.</DialogDescription>
        </DialogHeader>
        {!status ? <p className="connection-note">{error || "연결 상태를 확인하고 있습니다."}</p> : <>
          <div className="provider-list" role="radiogroup" aria-label="생성 방식">
            {providers.map((provider) => (
              <label key={provider} className={`provider-option ${selected === provider ? "active" : ""}`}>
                <input type="radio" name="provider" checked={selected === provider} disabled={busy}
                  onChange={() => change({ action: "select", provider })} />
                <span><strong>{providerText[provider].title}</strong><small>{providerText[provider].detail}</small></span>
              </label>
            ))}
          </div>

          {selected === "openai-api" && <>
            {status.openai.fromEnv && <p className="connection-note">현재 <code>.env.local</code>의 키를 사용하고 있습니다. 화면에서 저장한 키가 있으면 그 키를 우선 사용합니다.</p>}
            <KeyForm vendor="openai" saved={status.openai.saved} busy={busy}
              onSave={(key) => change({ action: "saveKey", vendor: "openai", key, consent: true })}
              onRemove={() => change({ action: "removeKey", vendor: "openai" })} />
          </>}

          {selected === "anthropic-api" && <>
            <label className="form-field" htmlFor="claude-model">
              <span>Claude 모델 <small>100만 토큰당 입력/출력 가격</small></span>
              <select id="claude-model" className="connection-select" value={status.anthropic.model} disabled={busy}
                onChange={(e) => change({ action: "setClaudeModel", model: e.target.value })}>
                {status.anthropic.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.label} · ${model.inputUSD} / ${model.outputUSD}</option>
                ))}
              </select>
            </label>
            <KeyForm vendor="anthropic" saved={status.anthropic.saved} busy={busy}
              onSave={(key) => change({ action: "saveKey", vendor: "anthropic", key, consent: true })}
              onRemove={() => change({ action: "removeKey", vendor: "anthropic" })} />
          </>}

          {error && <p className="connection-error" role="alert">{error}</p>}
        </>}
      </DialogContent>
    </Dialog>
  );
}
