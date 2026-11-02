import { Button } from "@/components/ui/button";
import { useState } from "react";
import { evidenceLabel } from "@/lib/grounding";
import { decisionInUse, decisionKey, evidenceKey } from "@/lib/evidence-review";
import { AlertCircle } from "lucide-react";
import type { Scene } from "@/lib/storyboard";
import { groundingFailureMessage } from "@/lib/grounding-failure";
import type { SceneImageGenerationState } from "@/components/studio/scene-image-panel";

const fields = { narration: "나레이션", subtitle: "자막", visual: "화면 설명", assets: "시각자료 제안" };

export function SceneEvidenceLinks({ scene, referenceId, onAccept }: { scene: Scene; referenceId: string; onAccept?: (key: string) => void }) {
  if (!scene.grounding) return <p className="scene-evidence-status">이전 연결 기록 · 적용 범위 미분류</p>;
  const links = scene.grounding.links.filter(link => link.referenceId === referenceId);
  const suggestions = (scene.grounding.suggestions ?? []).filter(link => link.referenceId === referenceId);
  const stale = scene.grounding.status === "stale";
  return <div className="scene-evidence-links">
    {stale && <p className="scene-evidence-status" role="status">장면이 수정되었습니다. 아래는 이전 검증 기록이며 재생성 시 다시 검증합니다.</p>}
    {[...links, ...suggestions].map((link, index) => {
      const proposed = suggestions.includes(link);
      const current = !stale && (proposed || scene[link.field].slice(link.start, link.end) === link.sentence);
      return <div className={`scene-evidence-link scene-evidence-compact${link.applicability === "transfer" ? " is-transfer" : ""}`} key={`${link.field}:${link.start}:${index}`}>
        <div className="evidence-link-heading"><strong className="evidence-field-badge">{fields[link.field]}</strong><span className={`evidence-verdict${current && link.applicability === "direct" ? " is-direct" : ""}`}>{evidenceLabel(link, !current)}</span></div>
        {proposed && <p className="scene-evidence-status">제안 · 본문에 아직 반영하지 않았습니다.</p>}
        <p className="evidence-applied-sentence">{link.sentence}</p>
        <details className="evidence-link-detail">
          <summary><span className="when-collapsed">근거 구절·연결 이유 보기</span><span className="when-expanded">근거 구절·연결 이유 접기</span></summary>
          <div className="evidence-link-detail-body">
            <span>{link.value === "visual_reference" ? "시각자료의 원문 설명" : link.applicability === "transfer" ? "참고한 원문 구절" : "근거 구절"}</span>
            <blockquote>{link.quote}</blockquote>
            <span>연결 이유</span><p>{link.reason}</p>
          </div>
        </details>
        {link.transfer && <dl className="evidence-transfer-details">
          <dt>원래 적용 대상</dt><dd>{link.transfer.sourceScope}</dd>
          <dt>현재 교육 대상</dt><dd>{link.transfer.targetScope}</dd>
          <dt>참고한 원칙</dt><dd>{link.transfer.principle}</dd>
          <dt>확인할 조건</dt><dd>{link.transfer.conditions}</dd>
        </dl>}
        {link.applicability === "transfer" && link.review !== "accepted" && onAccept && <Button variant="outline"
          disabled={!current} onClick={() => onAccept(evidenceKey(link))}>{proposed ? "조건 확인 후 본문에 반영" : "적용 조건 확인 완료"}</Button>}
      </div>;
    })}
  </div>;
}

export function SceneEvidenceDecisions({ scene, onUse, onUndo, onRegenerate, generation }: {
  scene: Scene; onUse?: (key: string) => void; onUndo?: (key: string) => void; onRegenerate?: (keys: string[]) => void; generation?: SceneImageGenerationState;
}) {
  const [selection, setSelection] = useState<string[]>([]);
  const decisions = scene.grounding?.decisions ?? [];
  const selectable = [...new Set(decisions.filter(item => item.sentence.trim()).map(decisionKey))];
  const selected = selection.filter(key => selectable.includes(key));
  const busy = Boolean(generation?.busy);
  if (!decisions.length) return null;
  return <details className="scene-evidence-decisions">
    <summary>판단 보류 <span className="evidence-decision-count">{decisions.length}건</span>{scene.grounding?.status === "stale" ? " · 이전 판정" : ""}</summary>
    {onRegenerate && <div className="evidence-selection-toolbar">
      <label><input type="checkbox" checked={selectable.length > 0 && selected.length === selectable.length} disabled={busy || !selectable.length}
        onChange={event => setSelection(event.target.checked ? selectable : [])} />전체 선택</label>
      <span>{selected.length}개 선택</span>
    </div>}
    {decisions.map((item, index) => <div className="scene-evidence-link scene-evidence-compact evidence-decision-compact" key={index}>
      <div className="evidence-decision-heading">
        <div className="evidence-link-heading"><strong className="evidence-field-badge">{fields[item.field]}</strong>
          <span className="evidence-verdict" role="status">{decisionInUse(scene, item) ? "사용자 선택 · 적용됨" : item.used ? "본문 변경됨" : "근거 검증 미통과"}</span>
        </div>
        {onRegenerate && <label><input type="checkbox" aria-label={`${fields[item.field]}: ${item.sentence} 선택`} checked={selected.includes(decisionKey(item))}
          disabled={busy || !item.sentence.trim()} onChange={event => setSelection(current => event.target.checked ? [...new Set([...current, decisionKey(item)])] : current.filter(key => key !== decisionKey(item)))} />선택</label>}
      </div>
      <p className="evidence-applied-sentence">{item.sentence}</p>
      <div className="evidence-decision-source"><span>{item.sourceTitle}</span>{item.page && <span className="evidence-source-page">원본 {item.page}페이지</span>}</div>
      <div className="evidence-decision-action">
      <details className="evidence-link-detail evidence-decision-reason">
        <summary><span className="when-collapsed">보류 사유 펼치기</span><span className="when-expanded">보류 사유 접기</span></summary>
        <div className="evidence-link-detail-body">
          <span>보류 사유</span><p>{item.reason || "기록된 보류 사유가 없습니다."}</p>
          {item.quote && <><span>검토한 원문 구절</span><blockquote>{item.quote}</blockquote></>}
          {item.used && <small>{decisionInUse(scene, item) ? `${fields[item.field]}에 사용자 선택으로 적용했습니다. AI 근거 검증은 통과하지 않았습니다.` : "적용했던 본문이 변경되었습니다. 다시 사용할 수 있습니다."}</small>}
        </div>
      </details>
        {item.used && onUndo ? <Button variant="outline" aria-label={`${fields[item.field]} 적용 취소`} disabled={busy}
          onClick={() => { const key = decisionKey(item); setSelection(current => current.filter(selected => selected !== key)); onUndo(key); }}>적용 취소</Button>
          : onUse && <Button variant="outline" aria-label={`${fields[item.field]}에 ${decisionInUse(scene, item) ? "적용됨" : "사용하기"}`} disabled={busy || !item.sentence.trim() || decisionInUse(scene, item)} onClick={() => onUse(decisionKey(item))}>{decisionInUse(scene, item) ? "적용됨" : "사용하기"}</Button>}
      </div>
    </div>)}
    {onRegenerate && <div className="evidence-batch-actions">
      <p>선택 문장 반영 · 중복 없이 이미지 1회 생성</p>
      <Button disabled={busy || !selected.length || !generation?.canGenerate} onClick={() => onRegenerate(selected)}>{busy ? "이미지 생성 중…" : `선택한 ${selected.length}개 반영해 이미지 재생성`}</Button>
      {!busy && !generation?.canGenerate && <small>스토리보드 영역에서 모델 연결·화면 설명·원문 근거를 확인해 주세요.</small>}
      {generation?.error && <p className="connection-error" role="alert">{generation.error}</p>}
      {generation?.message && <p role="status">{generation.message}</p>}
    </div>}
  </details>;
}

export function SceneEvidenceStatus({ scene }: { scene: Scene }) {
  const status = scene.grounding?.status;
  const diagnostic = scene.grounding?.diagnostics;
  const failures = scene.grounding?.failures;
  if (failures?.length) return <div className="scene-section-empty" role="status">
    {status === "stale" && <p>아래는 수정 전 장면의 처리 기록입니다. 재생성 시 다시 확인합니다.</p>}
    {failures.map((failure, index) => <p key={`${failure.stage}:${index}`}>{groundingFailureMessage(failure)}</p>)}
    <p>{scene.grounding?.links.length ? "검증을 통과한 근거만 연결했습니다." : "검증되지 않은 RAG 보충 문장과 출처 연결은 제외하고 기본 초안을 유지했습니다."}</p>
  </div>;
  const text = !status ? "이 장면에 연결된 지식베이스 근거가 없습니다."
    : status === "stale" ? "장면이 수정되었습니다. 이전 근거 판정은 유지되며, 재생성 시 다시 검증합니다."
    : status === "review_required" ? "타 자료 활용 또는 적용 범위의 확인이 필요한 문장이 있습니다."
    : status === "unavailable" ? "이전 실행에서 근거 검색·검증을 완료하지 못했습니다. 세부 원인은 기록되지 않았습니다. 장면 재생성부터 원인을 구분해 표시합니다."
    : status === "budget_skipped" ? "호출·검증 한도 안에서 대조하지 못해 원문만 사용했습니다."
    : diagnostic?.conflicts ? "검색한 근거와 문장의 조건·시점·수치가 일치하지 않아 연결하지 않았습니다. 원문과 대조해 주세요."
    : diagnostic?.checked ? "관련 자료를 대조했지만 문장 전체를 뒷받침하는 근거는 확인하지 못했습니다."
    : diagnostic?.retrieved ? "검색된 자료가 이 장면의 적용 조건과 맞지 않아 연결하지 않았습니다."
    : "현재 검색 범위에서 이 장면에 연결할 지식베이스 근거를 찾지 못했습니다.";
  return <p className={`scene-section-empty${status === "review_required" ? " is-evidence-attention" : ""}`}>{status === "review_required" && <AlertCircle size={18} aria-hidden="true" />}{text}</p>;
}
