"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, KeyRound, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CONNECTION_CHANGED } from "@/hooks/use-generator-status";
import type { Provider, PublicConnection } from "@/lib/server/connection-store";

type Action = Record<string, unknown> & { action: string };

const providerText: Record<Provider, { title: string; detail: string }> = {
  demo: { title: "무료 데모", detail: "원문을 나누는 데모 · 외부 AI 전송 없음" },
  "openai-api": { title: "OpenAI API 키", detail: "내 키로 결제 · 이 PC 하루 $5·월 $10 한도" },
  "anthropic-api": { title: "Claude API 키", detail: "Claude Console 키로 결제 · 같은 비용 한도" },
  "gemini-api": { title: "Gemini (팀 키)", detail: "운영자가 서버에 넣은 팀 키 사용 · 키 입력 없이 바로 생성" },
  chatgpt: { title: "ChatGPT 로그인", detail: "Plus·Pro 플랜 사용량으로 생성" },
  "claude-subscription": { title: "Claude 구독 (개인 실험)", detail: "이 PC의 Claude Code 로그인 사용 · 기본 꺼짐" },
};

const chatgptResults: Record<string, string> = {
  connected: "ChatGPT에 연결했어요. 생성할 모델을 확인해 주세요.",
  "no-plan": "로그인은 됐지만 ChatGPT 플랜 사용이 허용되지 않았어요. 다시 로그인해 플랜 사용을 허용하거나 다른 방식을 선택해 주세요.",
  denied: "ChatGPT 로그인을 취소했어요. 기존 연결은 그대로입니다.",
  expired: "로그인 시간이 지났어요. 다시 시도해 주세요.",
  invalid: "ChatGPT 로그인 결과를 확인하지 못했어요. 다시 시도해 주세요.",
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
        <span>유료 호출에 동의합니다. 이 PC 기준 하루 $5·월 $10 한도 안에서만 호출합니다.</span>
      </label>
      <Button disabled={busy || key.trim().length < 10 || !consent}
        onClick={async () => { if (await onSave(key.trim())) { setKey(""); setConsent(false); } }}>
        키 저장하고 사용
      </Button>
      <p className="connection-note">키는 이 PC의 <code>.eduflow-private</code> 폴더에만 저장하고 화면이나 브라우저로 다시 보내지 않습니다.</p>
    </div>
  );
}

export function ConnectionDialog({ open, onOpenChange, onNotice }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNotice: (text: string) => void;
}) {
  const [status, setStatus] = useState<PublicConnection | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<{ slug: string; name: string }[] | null>(null);
  const loopback = typeof window === "undefined" || window.location.hostname === "127.0.0.1";
  const [imageConsent, setImageConsent] = useState(false);

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
  async function loadModels() {
    const result = await send({ action: "chatgptModels" });
    if (result) setModels(result.models);
  }

  useEffect(() => {
    if (!open) return;
    send(null).then((next) => next && setStatus(next));
  }, [open]);
  useEffect(() => {
    if (open && status?.provider === "chatgpt" && status.chatgpt.planUsage && models === null) void loadModels();
  }, [open, status?.provider, status?.chatgpt.planUsage]);
  // Back from the ChatGPT sign-in page: report the result once and tidy the address.
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("chatgpt");
    if (!result) return;
    url.searchParams.delete("chatgpt");
    window.history.replaceState(null, "", url);
    onNotice(chatgptResults[result] ?? chatgptResults.invalid);
    window.dispatchEvent(new Event(CONNECTION_CHANGED));
    onOpenChange(true);
  }, []);

  const providers = (Object.keys(providerText) as Provider[])
    .filter((provider) => provider !== "claude-subscription" || status?.claudeSubscription.enabled);
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

          {selected === "gemini-api" && (status.gemini.teamKey && status.gemini.model ? <>
            <p className="connection-note">
              <KeyRound size={14} /> 팀 키가 이 PC의 서버에 설정되어 있습니다 · 모델 {status.gemini.label}
            </p>
            <p className="connection-note">
              키는 서버 설정 파일에만 있고 화면에는 나오지 않습니다. Google 무료 등급 키는 입력한 원고가 Google 제품
              개선에 쓰일 수 있으니 공개해도 되는 자료로 사용해 주세요.
            </p>
          </> : (
            <p className="connection-error" role="alert">
              {status.gemini.teamKey
                ? "서버의 EDUFLOW_GEMINI_MODEL이 지원하지 않는 모델입니다. 운영자에게 설정 확인을 요청해 주세요."
                : "이 PC의 서버에 Gemini 팀 키가 없습니다. 운영자가 .env.local에 EDUFLOW_GEMINI_API_KEY를 넣고 서버를 다시 시작해야 합니다."}
            </p>
          ))}

          {selected === "chatgpt" && <div className="connection-fields">
            {status.chatgpt.signedIn ? <>
              <div className="connection-saved">
                <PlugZap size={14} /> {status.chatgpt.email ?? "ChatGPT 계정"} 연결됨
                <Button variant="ghost" size="sm" disabled={busy} onClick={async () => {
                  const result = await send({ action: "chatgptSignOut" });
                  if (!result) return;
                  setStatus(result); setModels(null);
                  window.dispatchEvent(new Event(CONNECTION_CHANGED));
                  onNotice(result.revoked ? "ChatGPT 연결을 해제했어요." : "이 PC의 로그인 정보는 지웠지만 원격 해제를 확인하지 못했어요. ChatGPT 설정에서 앱 연결을 해제할 수 있습니다.");
                }}>로그아웃</Button>
              </div>
              {!status.chatgpt.planUsage && <p className="connection-warning"><AlertTriangle size={14} /> 플랜 사용 권한이 허용되지 않았습니다. 다시 로그인해 허용해 주세요.</p>}
              {status.chatgpt.planUsage && <label className="form-field" htmlFor="chatgpt-model">
                <span>생성 모델 <small>로그인한 계정에서 쓸 수 있는 모델</small></span>
                <select id="chatgpt-model" className="connection-select" disabled={busy || !models?.length}
                  value={status.chatgpt.model ?? models?.[0]?.slug ?? ""}
                  onChange={(e) => change({ action: "setChatGPTModel", model: e.target.value })}>
                  {!models?.length && <option value="">{models ? "사용 가능한 모델 없음" : "모델 목록을 불러오는 중"}</option>}
                  {models?.map((model) => <option key={model.slug} value={model.slug}>{model.name}</option>)}
                </select>
              </label>}
            </> : <>
              <Button className="chatgpt-button" disabled={busy || !loopback} onClick={async () => {
                const result = await send({ action: "chatgptStart" });
                if (result?.url) window.location.assign(result.url);
              }}>Continue with ChatGPT</Button>
              {!loopback && <p className="connection-warning"><AlertTriangle size={14} /> ChatGPT 로그인은 <code>http://127.0.0.1:3000</code> 주소로 연 화면에서만 할 수 있습니다.</p>}
            </>}
            <p className="connection-note">ChatGPT Plus·Pro 계정이 필요하며 사용량은 플랜 한도에서 차감됩니다. 로그인 정보는 이 PC에만 저장하며, ChatGPT 설정에서 언제든 연결을 해제할 수 있습니다.</p>
          </div>}

          {selected === "claude-subscription" && <div className="connection-fields">
            <div className="connection-warning">
              <AlertTriangle size={14} />
              <p>Anthropic은 승인 없이 제품에서 claude.ai 로그인이나 구독 한도를 제공하는 것을 허용하지 않습니다. 이 옵션은 <strong>본인 PC에서 본인 계정으로만</strong> 쓰는 개인 실험용이며, 팀원에게 제공하는 기능이 아닙니다. 계정 제한 등의 위험은 각자 부담합니다.</p>
            </div>
            <ol className="connection-steps">
              <li>터미널에서 <code>claude</code>를 실행해 본인 Claude 계정으로 로그인합니다.</li>
              <li>아래 확인란을 선택하면 이 PC의 로그인으로 생성합니다. API 키 환경 변수는 전달하지 않습니다.</li>
            </ol>
            <label className="connection-check">
              <input type="checkbox" checked={status.claudeSubscription.acknowledged} disabled={busy}
                onChange={(e) => change({ action: "acknowledgeClaudeSubscription", acknowledged: e.target.checked })} />
              <span>위 내용을 이해했으며 본인 계정으로만 사용합니다.</span>
            </label>
          </div>}

          <section className="connection-image-settings">
            <h3>스토리보드 이미지 생성</h3>
            <p className="connection-note">이미지 생성 연결: {status.sceneImages.vendor ?? "연결 필요"}. 기존 OpenAI 키 또는 Gemini 팀 키를 사용하며 글 생성 모델 선택은 유지합니다. 유료 호출은 하루 $5·월 $10 한도를 함께 사용합니다.</p>
            {!status.sceneImages.vendor ? <p className="connection-note">위에서 OpenAI 키를 연결하거나 운영자가 Gemini 팀 키를 연결하면 사용할 수 있습니다.</p>
              : status.sceneImages.enabled ? <><p className="connection-note" role="status">스토리보드 이미지 생성이 켜져 있습니다. 장면 편집에서 이미지를 생성하세요.</p>
                <Button variant="outline" disabled={busy} onClick={() => change({ action: "setImageEnabled", enabled: false, consent: true })}>이미지 생성 끄기</Button></>
              : <><label className="connection-check"><input type="checkbox" checked={imageConsent} disabled={busy} onChange={event => setImageConsent(event.target.checked)} />장면 내용·연결 근거·선택한 참고 이미지를 {status.sceneImages.vendor}로 전송하고 유료로 생성하는 데 동의합니다.</label>
                <Button disabled={busy || !imageConsent} onClick={async () => { if (await change({ action: "setImageEnabled", enabled: true, consent: true })) setImageConsent(false); }}>스토리보드 이미지 생성 켜기</Button></>}
          </section>
          {error && <p className="connection-error" role="alert">{error}</p>}
        </>}
      </DialogContent>
    </Dialog>
  );
}
