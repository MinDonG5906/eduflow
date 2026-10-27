import type { Dispatch, SetStateAction } from "react";
import { ArrowRight, Plus, RotateCcw, ShieldCheck, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SourceFormat } from "@/lib/pdf-source";
import { audienceOptions, defaults, type Settings } from "@/lib/storyboard";
import { SelectField } from "./select-field";
import type { GeneratorStatus } from "./types";

export function SettingsPanel({
  settings,
  setSettings,
  keyword,
  setKeyword,
  busy,
  generator,
  notify,
}: {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  // Lifted: an unsubmitted keyword blocks generation.
  keyword: string;
  setKeyword: (value: string) => void;
  busy: boolean;
  generator: GeneratorStatus;
  notify: (text: string) => void;
}) {
  const setting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));
  function addKeyword() {
    const k = keyword.trim();
    if (!k) return;
    if (settings.keywords.length >= 10) {
      notify("키워드는 최대 10개까지 추가할 수 있어요.");
      return;
    }
    if (k.length > 40) {
      notify("키워드는 40자 이하로 입력해 주세요.");
      return;
    }
    if (!settings.keywords.includes(k)) setting("keywords", [...settings.keywords, k]);
    setKeyword("");
  }

  return (
    <section className="settings-panel panel">
      <div className="panel-title">
        <div>
          <span className="section-icon">
            <SlidersHorizontal size={18} />
          </span>
          <h2>생성 설정</h2>
        </div>
        <button
          className="icon-button"
          title="설정 초기화"
          aria-label="설정 초기화"
          disabled={busy}
          onClick={() => {
            setSettings(defaults);
            setKeyword("");
            notify("생성 설정을 초기화했어요.");
          }}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <fieldset disabled={busy} className="settings-fields">
        <SelectField
          label="누구를 위한 교육인가요?"
          value={settings.audience}
          options={[...audienceOptions]}
          onChange={(v) => setting("audience", v as Settings["audience"])}
        />
        <div className="form-field">
          <span>설명 난이도</span>
          <div className="segmented">
            {["쉬움", "보통", "심화"].map((v) => (
              <button
                key={v}
                aria-pressed={settings.difficulty === v}
                className={settings.difficulty === v ? "active" : ""}
                onClick={() => setting("difficulty", v as Settings["difficulty"])}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="field-row">
          <SelectField
            label="영상 길이"
            value={settings.minutes}
            options={Array.from({ length: 10 }, (_, i) => ({
              value: String(i + 1),
              label: `${i + 1}분`,
            }))}
            onChange={(v) => setting("minutes", Number(v))}
          />
          <SelectField
            label="장면 수"
            value={settings.count}
            options={[
              { value: "auto", label: "자동 추천" },
              ...Array.from({ length: 18 }, (_, i) => ({
                value: String(i + 3),
                label: `${i + 3}개`,
              })),
            ]}
            onChange={(v) => setting("count", v === "auto" ? "auto" : Number(v))}
          />
        </div>
        <SelectField
          label="톤앤매너"
          value={settings.tone}
          options={["친근한 설명", "차분한 교육", "공식적", "간결한 안내"]}
          onChange={(v) => setting("tone", v as Settings["tone"])}
        />
        <div className="form-field">
          <label htmlFor="keywords">
            강조 키워드 <small>선택 · 최대 10개</small>
          </label>
          <div className="keyword-input">
            <Input
              id="keywords"
              placeholder="키워드 입력 후 Enter"
              value={keyword}
              maxLength={40}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword();
                }
              }}
            />
            <button aria-label="키워드 추가" onClick={addKeyword}>
              <Plus size={15} />
            </button>
          </div>
          {settings.keywords.length > 0 && (
            <div className="keyword-tags">
              {settings.keywords.map((k) => (
                <span key={k}>
                  {k}
                  <button
                    aria-label={`${k} 키워드 삭제`}
                    onClick={() =>
                      setting(
                        "keywords",
                        settings.keywords.filter((v) => v !== k),
                      )
                    }
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {keyword.trim() && (
            <small>Enter 또는 + 버튼으로 키워드를 추가해 주세요.</small>
          )}
        </div>
        <div className="settings-divider" />
        <SelectField
          label="출력 언어"
          value={settings.language}
          options={["한국어", "영어"]}
          onChange={(v) => setting("language", v as Settings["language"])}
        />
        <details className="additional">
          <summary>
            <Plus size={14} /> 추가 요청 <span>선택</span>
          </summary>
          <label className="sr-only" htmlFor="instructions">
            추가 요청
          </label>
          <Textarea
            id="instructions"
            maxLength={500}
            value={settings.instructions}
            onChange={(e) => setting("instructions", e.target.value)}
            placeholder="예: 실천 방법을 중심으로 구성해 주세요."
          />
          <small>
            {settings.instructions.length} / 500자 · {generator?.mode === "ai" ? "AI 생성에 반영" : "데모에서는 제작 메모로 반영"}
          </small>
        </details>
      </fieldset>
    </section>
  );
}

export function GenerationBar({
  settings,
  isPdf,
  documentFormat,
  documentUnit,
  canGenerate,
  storageBlocked,
  generator,
  onGenerate,
}: {
  settings: Settings;
  isPdf: boolean;
  documentFormat: SourceFormat;
  documentUnit: string;
  canGenerate: boolean;
  storageBlocked: boolean;
  generator: GeneratorStatus;
  onGenerate: () => void;
}) {
  return (
    <>
      <div className="generation-bar">
        <div>
          <span className="round-spark">
            <Sparkles size={19} />
          </span>
          <div>
            <strong>생성 조건</strong>
            <p>
              {settings.audience} <span>·</span> {settings.minutes}분 <span>·</span>{" "}
              {settings.count === "auto" ? "장면 수 자동" : `${settings.count}개 장면`}{" "}
              <span>·</span> {settings.tone}
            </p>
          </div>
        </div>
        <Button
          className="generate-button"
          disabled={!canGenerate}
          onClick={onGenerate}
        >
          <Sparkles size={17} /> {isPdf ? `선택한 ${documentFormat}로 생성` : "스토리보드 생성"} <ArrowRight size={17} />
        </Button>
      </div>
      <div className="bottom-note">
        <ShieldCheck size={13} />
        <span>{storageBlocked ? "기존 저장 원본을 보호하는 동안 자동 저장이 중지됩니다." : "작업은 이 브라우저에 자동 저장됩니다."}</span>
        <span className="note-dot">·</span>
        <span>
          {generator?.mode === "ai" ? isPdf ? `생성 시 선택한 ${documentUnit}만 담은 PDF·추가 설명·설정·제작 요청을 OpenAI에 전송합니다. 선택본은 이 브라우저에 저장됩니다.` : "생성 시 선택한 원고·설정·제작 요청을 OpenAI에 전송합니다. 파일 읽기와 제목·본문 검색은 이 PC에서 처리합니다." : generator ? "원문 발췌 데모입니다. 외부 AI로 전송하지 않습니다. PDF·PPT·한글의 표·그림을 읽는 생성은 실제 AI 연결이 필요합니다." : "생성 연결을 확인하고 있습니다."}
        </span>
      </div>
    </>
  );
}
