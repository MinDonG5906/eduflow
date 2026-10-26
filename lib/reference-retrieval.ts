import type { ReferenceInput } from "./storyboard";

export type RetrievedReference = {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  published: string;
  origin: "official" | "user";
};

// Short, dated source notes. They are retrieval material, not instructions to the model.
// Avoid unstable numeric rules and the unverified explanation of the former 2 m threshold.
const official: Array<RetrievedReference & { topic: RegExp }> = [
  {
    id: "official:fall-prevention", title: "고용노동부 산업안전보건기준 해석: 추락 위험 작업",
    url: "https://www.law.go.kr/LSW/cgmExpcInfoP.do?cgmExpcDatSeq=30944&mode=2&ofiClsCd=350101",
    published: "2021-07-29", origin: "official",
    excerpt: "추락할 위험이 있는 장소에서는 작업발판 등 설비를 우선 마련하고, 설치가 곤란한 경우에는 추락 위험을 막기 위한 다른 조치를 검토한다. 이 해석은 발표 당시 법령을 기준으로 하므로 현재 조문과 대조해야 한다.",
    topic: /고소|추락|높은\s*곳|작업발판|비계|안전난간|개구부|사다리/,
  },
  {
    id: "official:fall-controls", title: "안전보건공단: 높은 장소 작업 예방대책",
    url: "https://www.kosha.or.kr/ebook/fcatalog/access/ecatalogt.jsp?Dir=486&callmode=normal&catimage=&eclang=ko&start=202&um=s",
    published: "자료 발행일 확인 필요", origin: "official",
    excerpt: "높은 장소 작업의 예방대책으로 개구부·단부의 안전난간과 추락방호망, 안전대 부착설비, 이동식 비계와 사다리의 넘어짐 방지조치 등을 제시한다.",
    topic: /고소|추락|높은\s*곳|작업발판|비계|안전난간|개구부|사다리/,
  },
  {
    id: "official:confined-checks", title: "고용노동부: 질식사고 예방 3대 안전수칙",
    url: "https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=18506",
    published: "2025-10-27", origin: "official",
    excerpt: "밀폐공간 질식사고 예방을 위해 작업 전 산소·유해가스 농도 측정, 충분한 환기, 송기마스크 등 호흡보호구 착용을 안내한다.",
    topic: /밀폐\s*공간|산소\s*결핍|질식|유해\s*가스|맨홀|탱크\s*내부/,
  },
  {
    id: "official:confined-procedure", title: "안전보건공단: 밀폐공간 작업 절차",
    url: "https://www.kosha.or.kr/ebook/fcatalog/access/ecatalogt.jsp?Dir=445&callmode=normal&catimage=&eclang=ko&start=198&um=s",
    published: "자료 발행일 확인 필요", origin: "official",
    excerpt: "밀폐공간 작업에서는 사전 조사, 환기, 출입 전 공기상태 측정, 감시인 배치와 연락체계, 작업허가와 비상 구조 준비를 순서대로 점검하도록 안내한다.",
    topic: /밀폐\s*공간|산소\s*결핍|질식|유해\s*가스|맨홀|탱크\s*내부/,
  },
  {
    id: "official:hot-work-controls", title: "고용노동부: 화재·폭발 예방 현장 점검",
    url: "https://moel.go.kr/news/enews/report/enewsView.do?news_seq=20110",
    published: "2026-10-18", origin: "official",
    excerpt: "화재위험작업에서 불꽃·불티 비산방지, 화재감시자 배치, 가스농도 측정과 환기, 소화설비와 비상대피로 확보 등을 점검한다.",
    topic: /화기\s*작업|용접|용단|불티|화재|폭발|가연성/,
  },
  {
    id: "official:hot-work-permit", title: "안전보건공단: 정비·수리와 화기작업 예방대책",
    url: "https://www.kosha.or.kr/ebook/fcatalog/access/ecatalogt.jsp?Dir=486&callmode=normal&catimage=&eclang=ko&start=202&um=s",
    published: "자료 발행일 확인 필요", origin: "official",
    excerpt: "정비·수리 중 화기작업에는 소화기를 준비하고 주변 인화성 물질을 확인하며, 특별히 위험한 작업에는 안전작업 허가 절차를 마련하도록 안내한다.",
    topic: /화기\s*작업|용접|용단|불티|화재|폭발|가연성/,
  },
];

function words(value: string) {
  return [...new Set(value.toLocaleLowerCase("ko-KR").match(/[가-힣a-z0-9]{2,}/g) ?? [])]
    .filter((word) => !["작업", "교육", "내용", "안전", "방법", "확인"].includes(word));
}

function chunks(text: string) {
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const result: string[] = [];
  for (const paragraph of paragraphs) {
    for (let start = 0; start < paragraph.length; start += 900)
      result.push(paragraph.slice(start, start + 1000));
  }
  return result;
}

export function retrieveReferences(query: string, additions: ReferenceInput[] = []): RetrievedReference[] {
  const normalized = query.slice(0, 20000);
  const selected = official.filter((source) => source.topic.test(normalized));
  const terms = words(normalized);
  const user = additions.flatMap((source, sourceIndex) => chunks(source.text).map((excerpt, chunkIndex) => ({
    id: `user:${sourceIndex + 1}:${chunkIndex + 1}`,
    title: source.title,
    url: source.url ?? "",
    published: "사용자 제공 자료 · 기준일 미기재",
    origin: "user" as const,
    excerpt,
    score: terms.filter((term) => excerpt.toLocaleLowerCase("ko-KR").includes(term)).length,
  }))).filter((source) => source.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  return [...selected.slice(0, 4), ...user].slice(0, 6).map(({ id, title, url, excerpt, published, origin }) => ({
    id, title, url, excerpt, published, origin,
  }));
}
