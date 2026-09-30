import { z } from "zod";

export const settingsSchema = z.object({
  audience: z.enum(["초등 저학년", "초등 고학년", "중고등학생", "대학생/일반인", "실무자/전문가"]),
  difficulty: z.enum(["쉬움", "보통", "심화"]),
  minutes: z.number().int().min(1).max(10),
  count: z.union([z.literal("auto"), z.number().int().min(3).max(20)]),
  tone: z.enum(["친근한 설명", "차분한 교육", "공식적", "간결한 안내"]),
  keywords: z.array(z.string().trim().min(1).max(40)).max(10),
  language: z.enum(["한국어", "영어"]),
  instructions: z.string().max(500),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = {
  audience: "대학생/일반인",
  difficulty: "보통",
  minutes: 3,
  count: "auto",
  tone: "차분한 교육",
  keywords: [],
  language: "한국어",
  instructions: "",
};
export const sceneSchema = z.object({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  evidence: z.string(),
  sourceId: z.string(),
  visual: z.string(),
  assets: z.string(),
  narration: z.string(),
  subtitle: z.string(),
  duration: z.number().int().min(1).max(600),
  review: z.boolean(),
  reviewReason: z.string(),
  edited: z.array(z.string()),
});
export type Scene = z.infer<typeof sceneSchema>;
export const boardSchema = z.object({
  title: z.string(),
  summary: z.string(),
  objectives: z.array(z.string()).min(1).max(5),
  scenes: z.array(sceneSchema).min(1).max(30),
  settings: settingsSchema,
  mode: z.literal("demo"),
});
export type Board = z.infer<typeof boardSchema>;
export const requestSchema = z.object({
  manuscript: z
    .string()
    .max(20000)
    .refine((v) => v.replace(/\s/g, "").length >= 100),
  settings: settingsSchema,
  scene: sceneSchema.optional(),
  direction: z.string().max(300).optional(),
});

export const sample = `일상에서 시작하는 탄소중립

지구의 온도가 오르는 이유는 무엇일까요? 우리가 사용하는 전기, 매일 타는 자동차, 그리고 물건을 만들고 버리는 과정에서 온실가스가 발생합니다. 온실가스는 지구를 둘러싼 담요처럼 열이 우주로 빠져나가는 것을 막습니다.

탄소중립이란 우리가 배출하는 이산화탄소의 양과 흡수하거나 제거하는 양을 맞춰, 실질적인 배출량을 줄이는 것을 뜻합니다. 먼저 온실가스 배출 자체를 줄이는 노력이 중요합니다. 줄이기 어려운 배출은 숲을 보호하고 복원하는 등의 방법으로 흡수를 늘릴 수 있습니다.

우리의 작은 습관도 변화의 시작이 됩니다. 사용하지 않는 조명을 끄고, 냉난방 온도를 적절하게 유지해 보세요. 가까운 거리는 걷거나 자전거를 타고, 이동할 때 대중교통을 선택할 수 있습니다. 이런 선택은 에너지 사용을 줄이는 데 도움이 됩니다.

소비 습관도 살펴볼 수 있습니다. 물건을 사기 전에 꼭 필요한지 생각하고, 일회용품 대신 여러 번 쓸 수 있는 물건을 선택해 보세요. 고장 난 물건을 수리하고, 쓰지 않는 물건을 나누는 것도 좋은 방법입니다. 분리배출할 때는 지역별 안내에 따라 재질과 오염 여부를 확인합니다.

탄소중립은 개인의 노력만으로 완성되지 않습니다. 기업의 생산 방식 변화와 정부의 제도, 지역사회의 참여가 함께 필요합니다. 학교와 직장에서 에너지 절약 아이디어를 나누거나, 동네 환경 활동에 참여하는 것도 실천의 한 방법입니다.

오늘부터 실천할 수 있는 한 가지를 정해 보세요. 내가 할 수 있는 작은 행동을 꾸준히 이어가는 것이 중요합니다. 탄소중립을 향한 변화는 우리의 일상에서 시작됩니다.`;

export function newScene(): Scene {
  return {
    id: crypto.randomUUID(),
    title: "새로운 장면",
    purpose: "",
    evidence: "",
    sourceId: "manual",
    visual: "",
    assets: "",
    narration: "",
    subtitle: "",
    duration: 30,
    review: true,
    reviewReason: "직접 추가한 장면입니다. 원문 근거를 입력해 주세요.",
    edited: [],
  };
}

// Deliberately extractive: this prototype never invents claims or simulates a live model.
export function generateDemo(
  manuscript: string,
  settings: Settings,
  current?: Scene,
  direction = "",
): Board {
  const lines = manuscript
    .trim()
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const title = lines[0].length < 70 ? lines[0] : lines[0].slice(0, 40);
  const body =
    lines.length > 1 && lines[0].length < 70 ? lines.slice(1).join("\n\n") : manuscript.trim();
  const sentences = body
    .match(/[^.!?。！？\n]+[.!?。！？]?/g)
    ?.map((s) => s.trim())
    .filter(Boolean) || [body];
  const count =
    settings.count === "auto" ? Math.max(3, Math.min(12, settings.minutes * 2)) : settings.count;
  const english = settings.language === "영어";
  const scenes = Array.from({ length: current ? 1 : count }, (_, i): Scene => {
    const start = Math.floor((i * sentences.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * sentences.length) / count));
    const evidence =
      current?.evidence || sentences.slice(start, end).join(" ") || sentences[sentences.length - 1];
    const snippet = evidence.split(/[.!?。！？]/)[0].slice(0, 50);
    const simple = settings.difficulty === "쉬움" || settings.audience.startsWith("초등");
    const prefix = english
      ? "Let’s explore the source passage."
      : settings.tone === "친근한 설명"
        ? "우리 함께 알아볼까요?"
        : settings.tone === "공식적"
          ? "다음 내용을 확인하겠습니다."
          : settings.tone === "간결한 안내"
            ? "핵심 내용입니다."
            : "이번 장면에서는 다음 내용을 살펴봅니다.";
    const guide = english
      ? "Review the source and explain its main idea."
      : simple
        ? "어려운 단어를 찾아 쉬운 말로 바꾸고, 한 문장씩 설명합니다."
        : settings.difficulty === "심화"
          ? "핵심 개념의 관계와 적용 조건을 원문에 근거해 분석합니다."
          : "핵심 개념을 파악하고 일상의 실천과 연결합니다.";
    const production = direction || settings.instructions;
    return {
      id: current?.id || crypto.randomUUID(),
      title: current
        ? current.title
        : english
          ? `Scene ${i + 1} · Source overview`
          : `${i === 0 ? "시작하기 · " : i === count - 1 ? "마무리 · " : ""}${snippet.slice(0, 25)}`,
      purpose: guide,
      evidence,
      sourceId: current?.sourceId || `sentence:${start + 1}-${Math.min(end, sentences.length)}`,
      visual: english
        ? `Show a title card, then highlight this source excerpt: “${snippet}”.`
        : `밝은 배경에 “${snippet}”을 제목으로 배치합니다. 원문의 핵심 구절을 한 줄씩 강조하고, 마지막에 핵심 메시지를 화면 중앙에 보여줍니다.${production ? `\n제작 요청: ${production}` : ""}`,
      assets: english
        ? "Title card, highlighted source text, simple transition."
        : `타이포그래피 카드, 핵심어 강조 애니메이션, 부드러운 장면 전환${settings.keywords.length ? `\n강조 키워드: ${settings.keywords.join(", ")}` : ""}`,
      narration: `${prefix} ${evidence}`,
      subtitle: english
        ? "Understand the main idea of this source passage."
        : `${snippet.slice(0, 36)} — 핵심을 함께 살펴봅니다.`,
      duration:
        current?.duration ||
        Math.floor((settings.minutes * 60) / count) + (i < (settings.minutes * 60) % count ? 1 : 0),
      review: true,
      reviewReason: english
        ? "Extractive demo. Source text is not translated; audience adaptation and instructions need human review."
        : `원문 발췌 기반 데모입니다. ${settings.audience}·${settings.difficulty} 수준에 맞는 표현과 사실을 검토해 주세요.${production ? " 추가 지시는 화면 설명에 메모로 반영되었습니다." : ""}`,
      edited: [],
    };
  });
  return {
    title,
    summary: sentences.slice(0, 2).join(" "),
    objectives: english
      ? ["Identify the main idea in the source.", "Explain the key concepts in your own words."]
      : [
          "원고에 담긴 핵심 개념을 이해할 수 있다.",
          "주요 내용을 자신의 말로 설명할 수 있다.",
          "배운 내용을 일상과 연결해 생각할 수 있다.",
        ],
    scenes,
    settings,
    mode: "demo",
  };
}

export const fieldLabels: Record<string, string> = {
  title: "장면 제목",
  purpose: "장면 목적",
  evidence: "원문 근거",
  sourceId: "근거 위치",
  visual: "화면 설명",
  assets: "시각 자료 제안",
  narration: "나레이션",
  subtitle: "자막",
  duration: "예상 시간(초)",
  review: "검토 필요",
  reviewReason: "검토 사유",
  edited: "수정한 필드",
};
export function markdown(board: Board) {
  return (
    `# ${board.title}\n\n> 원문 발췌 기반 데모 · 제작 전 검토 필요\n\n## 콘텐츠 개요\n\n${board.summary}\n\n### 학습 목표\n${board.objectives.map((s) => `- ${s}`).join("\n")}\n\n전체 예상 시간: ${board.scenes.reduce((a, s) => a + s.duration, 0)}초\n\n### 생성 조건\n${Object.entries(
      board.settings,
    )
      .map(
        ([k, v]) =>
          `- ${{ audience: "학습 대상", difficulty: "난이도", minutes: "목표 길이(분)", count: "장면 수", tone: "톤앤매너", keywords: "강조 키워드", language: "출력 언어", instructions: "추가 요청" }[k]}: ${Array.isArray(v) ? v.join(", ") : v}`,
      )
      .join("\n")}\n\n` +
    board.scenes
      .map(
        (s, i) =>
          `## ${i + 1}. ${s.title}\n\n${Object.entries(fieldLabels)
            .filter(([k]) => k !== "title")
            .map(
              ([k, label]) =>
                `### ${label}\n${typeof s[k as keyof Scene] === "boolean" ? (s.review ? "검토 필요" : "검토 완료") : Array.isArray(s[k as keyof Scene]) ? (s[k as keyof Scene] as string[]).map((k) => fieldLabels[k] || k).join(", ") : s[k as keyof Scene]}\n`,
            )
            .join("\n")}`,
      )
      .join("\n")
  );
}
export function csv(board: Board) {
  const cell = (v: unknown) => {
    let s = Array.isArray(v) ? v.join(" / ") : String(v ?? "");
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const keys = Object.keys(fieldLabels) as (keyof Scene)[];
  const header = [
    "콘텐츠 제목",
    "핵심 요약",
    "학습 목표",
    "전체 예상 시간(초)",
    "생성 조건",
    "생성 방식",
    "장면 번호",
    ...Object.values(fieldLabels),
  ];
  return (
    "\uFEFF" +
    [
      header,
      ...board.scenes.map((s, i) => [
        board.title,
        board.summary,
        board.objectives,
        board.scenes.reduce((n, s) => n + s.duration, 0),
        JSON.stringify(board.settings),
        "원문 발췌 데모",
        i + 1,
        ...keys.map((k) => (k === "review" ? (s.review ? "검토 필요" : "검토 완료") : s[k])),
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}
