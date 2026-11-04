import { Clock3, FileText, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Scene } from "@/lib/storyboard";
import { useSceneImageUrl } from "@/hooks/use-scene-image-url";

const phaseLabels = { intro: "도입부", body: "정보전달부", outro: "마무리" } as const;

function SceneMiniArt({ scene, index }: { scene: Scene; index: number }) {
  const url = useSceneImageUrl(scene.image?.id);
  return <div className={`scene-mini-art ${url ? "has-image" : ""}`}>
    {url ? <img src={url} style={{ objectFit: "contain" }} alt={`${index + 1}번 장면 스토리보드`} /> : <><span>{String(index + 1).padStart(2, "0")}</span><div className={`mini-landscape landscape-${index % 3}`}><FileText size={22} /></div></>}
  </div>;
}

export function SceneList({
  scenes,
  active,
  onSelect,
  onAdd,
}: {
  scenes: Scene[];
  active: number;
  onSelect: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <section className="scene-list">
      <div className="scene-list-heading">
        <h2>
          장면 목록 <span>{scenes.length}</span>
        </h2>
      </div>
      {scenes.map(
        (s, i) =>
          (
            <button
              key={s.id}
              className={`scene-item ${i === active ? "active" : ""}`}
              onClick={() => onSelect(i)}
            >
              <SceneMiniArt scene={s} index={i} />
              <div className="scene-item-body">
                <strong>{s.title || "제목 없는 장면"}</strong>
                {s.phase && <em className="scene-phase">{phaseLabels[s.phase]}</em>}
                <span>
                  <Clock3 size={11} />
                  {s.duration}초
                </span>
              </div>
            </button>
          ),
      )}
      <Button variant="outline" className="add-scene" onClick={onAdd}>
        <Plus size={15} /> 선택 장면 다음에 추가
      </Button>
      <div className="scene-list-note">
        <ShieldCheck size={15} />
        <p>
          원문 근거와 적용 조건을
          <br />
          확인해 주세요.
        </p>
      </div>
    </section>
  );
}
