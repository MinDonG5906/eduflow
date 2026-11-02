import type { Dispatch, SetStateAction } from "react";
import { ArrowRight, ArrowUp, Plus, RotateCcw, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
      </fieldset>
    </section>
  );
}

export function GenerationActions({
  isPdf, documentFormat, canGenerate, generator, onGenerate, onOpenConnection,
}: {
  isPdf: boolean;
  documentFormat: SourceFormat;
  canGenerate: boolean;
  generator: GeneratorStatus;
  onGenerate: () => void;
  onOpenConnection: () => void;
}) {
  const needsAiConnection = isPdf && Boolean(generator) && (generator?.mode !== "ai" || !generator.available);
  return <div className="prompt-generation-actions">
    {needsAiConnection && <div className="generation-connection">
      <p id="generation-connection-hint" role="status">
        {generator?.mode === "demo"
          ? `${documentFormat} 생성은 실제 AI 연결이 필요해 데모 모드에서는 사용할 수 없습니다.`
          : "AI 연결이 준비되지 않아 생성할 수 없습니다. 연결 설정을 확인해 주세요."}
      </p>
      <Button variant="outline" onClick={onOpenConnection}>AI 연결하기</Button>
    </div>}
    <Button aria-describedby={needsAiConnection ? "generation-connection-hint" : undefined}
      aria-label={isPdf ? `생성하기: 선택한 ${documentFormat}` : undefined}
      title={isPdf ? `선택한 ${documentFormat}로 생성` : undefined}
      className={isPdf ? "generate-button prompt-send-button" : "generate-button"} disabled={!canGenerate} onClick={onGenerate}>
      {isPdf ? <>생성하기 <ArrowUp size={18} aria-hidden="true" /></> : <><Sparkles size={17} /> 스토리보드 생성 <ArrowRight size={17} /></>}
    </Button>
  </div>;
}
