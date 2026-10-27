import { CheckCheck, Clock3, FileText, Plus, Settings2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Scene } from "@/lib/storyboard";

const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;

export function SceneList({
  scenes,
  active,
  onSelect,
  reviewOnly,
  onToggleReviewOnly,
  reviewCount,
  onAdd,
}: {
  scenes: Scene[];
  active: number;
  onSelect: (index: number) => void;
  reviewOnly: boolean;
  onToggleReviewOnly: () => void;
  reviewCount: number;
  onAdd: () => void;
}) {
  return (
    <section className="scene-list">
      <div className="scene-list-heading">
        <h2>
          장면 목록 <span>{scenes.length}</span>
        </h2>
        <button
          aria-label="검토 필요한 장면만 보기"
          title="검토 필요한 장면만 보기"
          className={reviewOnly ? "filter-active" : ""}
          aria-pressed={reviewOnly}
          onClick={onToggleReviewOnly}
        >
          <Settings2 size={16} />
        </button>
      </div>
      {reviewOnly && <div className="filter-label">검토 필요한 장면만 표시</div>}
      {scenes.map(
        (s, i) =>
          (!reviewOnly || s.review) && (
            <button
              key={s.id}
              className={`scene-item ${i === active ? "active" : ""}`}
              onClick={() => onSelect(i)}
            >
              <div className="scene-mini-art">
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div className={`mini-landscape landscape-${i % 3}`}>
                  <FileText size={22} />
                </div>
              </div>
              <div className="scene-item-body">
                <strong>{s.title || "제목 없는 장면"}</strong>
                {s.phase && <em className="scene-phase">{phaseLabels[s.phase]}</em>}
                <span>
                  <Clock3 size={11} />
                  {s.duration}초{" "}
                  <span className={s.review ? "review-dot" : "done-dot"} />
                  {s.review ? "검토 필요" : "검토 완료"}
                </span>
              </div>
            </button>
          ),
      )}
      {reviewOnly && !reviewCount && (
        <p className="all-reviewed">
          <CheckCheck size={24} /> 모든 장면을 검토했어요.
        </p>
      )}
      <Button variant="outline" className="add-scene" onClick={onAdd}>
        <Plus size={15} /> 선택 장면 다음에 추가
      </Button>
      <div className="scene-list-note">
        <ShieldCheck size={15} />
        <p>
          원문 근거를 확인하고
          <br />
          검토를 완료해 주세요.
        </p>
      </div>
    </section>
  );
}
