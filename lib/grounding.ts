import { z } from "zod";
import { searchNeedles, type RetrievedReference } from "./knowledge";
import { groundingFailureSchema } from "./grounding-failure";

export const transferContextSchema = z.object({
  sourceScope: z.string().trim().min(1).max(300),
  targetScope: z.string().trim().min(1).max(300),
  principle: z.string().trim().min(1).max(500),
  conditions: z.string().trim().min(1).max(500),
});
export const evidenceLinkSchema = z.object({
  referenceId: z.string().max(256),
  field: z.enum(["narration", "subtitle", "visual", "assets"]),
  sentence: z.string().min(1).max(5000),
  start: z.number().int().min(0), end: z.number().int().positive(),
  quote: z.string().min(3).max(1500),
  reason: z.string().min(1).max(500),
  value: z.enum(["corroboration", "explanation", "example", "visual_reference"]),
  applicability: z.enum(["direct", "transfer"]).optional(),
  transfer: transferContextSchema.optional(),
  review: z.enum(["pending", "accepted"]).optional(),
  visualId: z.string().max(320).optional(),
});
export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
export const groundingSchema = z.object({
  status: z.enum(["verified", "no_match", "unavailable", "budget_skipped", "stale", "review_required"]),
  links: z.array(evidenceLinkSchema).max(80),
  suggestions: z.array(evidenceLinkSchema).max(4).optional(),
  decisions: z.array(z.object({
    referenceId: z.string().max(256), field: z.enum(["narration", "subtitle", "visual", "assets"]),
    sentence: z.string().max(5000), quote: z.string().max(1500), reason: z.string().max(500),
    status: z.enum(["rejected", "deferred"]), sourceTitle: z.string().max(160), page: z.number().int().positive().optional(),
    used: z.boolean().optional(),
    // Track only text inserted by manual application, so undo cannot delete an
    // original sentence or overwrite a subsequent manual edit.
    application: z.object({
      start: z.number().int().min(0), text: z.string().min(1).max(5001), value: z.string(),
    }).optional(),
  })).max(80).optional(),
  failures: z.array(groundingFailureSchema).max(3).optional(),
  diagnostics: z.object({
    retrieved: z.number().int().min(0), shortlisted: z.number().int().min(0),
    checked: z.number().int().min(0), rejected: z.number().int().min(0),
    conflicts: z.number().int().min(0), supplementsAdded: z.number().int().min(0).optional(),
    supplementsRemoved: z.number().int().min(0).optional(),
  }).optional(),
});

/** Exact offsets are kept in the rendered field, including subtitle line breaks. */
export function exactSentences(text: string) {
  return [...text.matchAll(/[^\n]+?(?:[.!?。！？]+(?=\s|$)|(?=\n|$))/gu)].flatMap(match => {
    const sentence = match[0].trim();
    const start = match.index! + match[0].indexOf(sentence);
    return sentence ? [{ sentence, start, end: start + sentence.length }] : [];
  });
}

const actions: [string, RegExp][] = [
  ["stop", /작업\s*(?:을\s*)?(?:즉시\s*)?(?:중지|중단)|(?:가동|작동|운전)(?:을)?\s*(?:중지|중단|정지)|멈(?:추|춥|춘|출|춰|췄)|stop\s+work/i],
  ["power", /전원.{0,12}차단|전기.{0,8}차단|차단.{0,8}전원|disconnect.*power/i],
  ["aid", /응급\s*(?:조치|처치)|구급|first\s+aid/i],
  ["plan", /작업\s*계획|계획서|work\s+plan/i],
  ["evacuate", /대피|evacuat/i],
  ["report", /신고|연락|보고|(?:사고|재해)\s*(?:사실|상황)?(?:을|를)?\s*(?:(?:먼저|즉시)\s*)?알(?:리|립|려)|report/i],
  ["inspect", /점검|검사|inspect/i],
  ["ventilate", /환기|ventilat/i],
];
// These are vetoes for known applicability changes, not a semantic relevance score.
// An unqualified scene cannot generalize a source's special hazard/equipment rule.
const applicability: [string, RegExp][] = [
  ["밀폐공간", /밀폐\s*공간|confined\s*space/i],
  ["고소작업", /고소\s*작업|추락|고소\s*작업대|work(?:ing)?\s+at\s+height/i],
  ["중량물", /중량물|크레인|양중|crane|heavy\s+load/i],
  ["감전", /감전|electric\s*shock/i],
  ["화재", /화재|소화기|fire\s*(?:hazard|extinguisher)/i],
  ["기계사고", /사고\s*기계|기계\s*사고|끼임|협착|절단|machine\s*accident/i],
  ["온열질환", /온열\s*질환|열사병|열탈진|폭염|heat\s*(?:stroke|illness|exhaustion)/i],
  ["공기호흡기", /공기\s*호흡기|공기\s*탱크|호흡용\s*보호구|breathing\s*apparatus/i],
  ["화학물질", /화학\s*물질|유해\s*가스|급성\s*중독|chemical\s*(?:leak|exposure)/i],
];
export function teachingIntent(text: string, context = ""): { situation: string; actions: string[]; conditions: string[] } {
  const response = /사고\s*(?:발생|직후|후|발견|즉시)|재해\s*발생|응급|구급|emergency|after.*accident/i.test(text);
  const prevention = /사고\s*예방|작업\s*전|사전\s*점검|작업\s*계획서|before.*work|prevent/i.test(text);
  const contextual = context ? teachingIntent(context) : undefined;
  const conditions = applicability.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { situation: response ? "response" : prevention ? "prevention" : contextual?.situation ?? "unspecified",
    actions: actions.filter(([, re]) => re.test(text)).map(([name]) => name),
    conditions: [...new Set([...conditions, ...(contextual?.conditions ?? [])])],
  };
}

/** Split at sentences/paragraphs and context changes, never at an arbitrary token budget. */
export function educationUnits(text: string) {
  const units: { id: string; text: string; heading: string; intent: ReturnType<typeof teachingIntent> }[] = [];
  let heading = "";
  const lines = text.normalize("NFC").split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (const [index, line] of lines.entries()) {
    const headingShape = index === 0 && lines.length > 1 || /^(?:#{1,6}\s|제\s*\d+\s*[장절]|\d+[.)]\s)/.test(line);
    if (headingShape && line.length <= 70 && !/[.!?。！？]$/.test(line) && !teachingIntent(line).actions.length) {
      heading = line;
      continue; // A title is context, not an independent educational action to retrieve for.
    }
    for (const { sentence } of exactSentences(line)) {
      const intent = teachingIntent(sentence);
      const previous = units.at(-1);
      if (previous && previous.heading === heading && previous.intent.situation === intent.situation &&
          previous.intent.actions.join() === intent.actions.join() && previous.text.length + sentence.length < 600) {
        previous.text += ` ${sentence}`;
      } else units.push({ id: `unit:${units.length + 1}`, text: sentence, heading, intent });
    }
  }
  return units;
}

/** A local gate is deliberately conservative. Unknown semantics must pass the AI judge too. */
export function assessCandidate(text: string, reference: RetrievedReference, context = "") {
  const wanted = teachingIntent(text, context), found = teachingIntent(reference.excerpt,
    [reference.context?.sectionTitle, ...(reference.context?.tableHeaders ?? [])].filter(Boolean).join("\n"));
  const situation = !(wanted.situation !== "unspecified" && found.situation !== "unspecified" && wanted.situation !== found.situation);
  const sharedActions = wanted.actions.filter(action => found.actions.includes(action));
  const action = !wanted.actions.length || sharedActions.length > 0;
  const conditions = found.conditions.every(condition => wanted.conditions.includes(condition) ||
    // Hazardous-air measurement is part of confined-space work, not a different task.
    condition === "화학물질" && wanted.conditions.includes("밀폐공간") &&
      /유해\s*가스/.test(reference.excerpt) && !/화학\s*물질|급성\s*중독/.test(reference.excerpt));
  const needles = searchNeedles(text);
  // Titles only supply context, never lexical evidence for an unrelated excerpt.
  const overlap = needles.filter(n => reference.excerpt.toLocaleLowerCase("ko-KR").includes(n)).length;
  const eligible = situation && action && conditions && overlap >= Math.min(2, Math.max(1, needles.length));
  return { eligible, situation, action, conditions,
    score: overlap + sharedActions.length * 4 + (text.includes(reference.excerpt.trim()) ? 40 : 0),
    value: text.includes(reference.excerpt) ? "corroboration" : "potential_explanation" };
}

export function rankCandidates(text: string, references: RetrievedReference[], limit = 2, context = "") {
  const unique = new Map<string, RetrievedReference>();
  for (const reference of references) {
    const key = `${reference.documentId}:${reference.page ?? ""}:${reference.excerpt}`;
    const previous = unique.get(key);
    if (!previous || (reference.visuals?.length ?? 0) > (previous.visuals?.length ?? 0)) unique.set(key, reference);
  }
  return [...unique.values()].map(reference => {
    const overall = assessCandidate(text, reference, context);
    // A multi-topic page is a container, not a conjunction of every condition on it.
    // Keep its original excerpt/IDs for the judge, but rank by relevant complete sentences.
    const passages = [reference, ...exactSentences(reference.excerpt).map(part => ({ ...reference, excerpt: part.sentence }))];
    const assessment = [overall, ...passages.flatMap(passage => [text, ...exactSentences(text).map(p => p.sentence)]
      .map(claim => assessCandidate(claim, passage, context)))]
      .filter(item => item.eligible)
      .sort((a, b) => b.score - a.score)[0] ?? { ...overall, eligible: false };
    return { reference, assessment };
  })
    .filter(item => item.assessment.eligible).sort((a, b) => b.assessment.score - a.assessment.score || a.reference.id.localeCompare(b.reference.id))
    .slice(0, limit);
}

/** Veto demonstrable conflicts; lexical similarity is a ranking aid, not proof. */
export function evidenceConflict(claim: string, quote: string, reference: RetrievedReference, context = "") {
  // Include the containing sentence so a judge cannot omit an explicit if-clause.
  const container = exactSentences(reference.excerpt).find(part => part.sentence.includes(quote))?.sentence ?? quote;
  const assessment = assessCandidate(claim, { ...reference, excerpt: container }, context);
  if (!assessment.situation || !assessment.conditions) return "scope";
  const wanted = teachingIntent(claim), found = teachingIntent(quote);
  if (wanted.actions.filter(action => action !== "inspect").some(action => !found.actions.includes(action))) return "action";
  const periods = (text: string) => ({
    before: /작업(?:을)?\s*(?:시작(?:하기)?\s*)?전(?!원|기)|before\s+work/i.test(text),
    during: /작업\s*(?:하는\s*동안|중(?!지|단))|during\s+work/i.test(text),
  });
  const a = periods(claim), b = periods(quote);
  if (a.before && !b.before || a.during && !b.during) return "timing";
  // Compare polarity of the same action, not arbitrary '않/금지' elsewhere in a paragraph.
  for (const verb of ["차단", "환기", "착용", "설치", "측정", "정지", "중지", "신고", "대피"]) {
    const negative = new RegExp(`${verb}\\s*(?:하지\\s*(?:않|말)|금지)`);
    if (claim.includes(verb) && quote.includes(verb) && negative.test(claim) !== negative.test(quote)) return "polarity";
  }
  // Work phases and inspected objects are not interchangeable, even for analogies.
  const phase = (text: string) => [...text.matchAll(/(운반|운송|이송|하역|적재|출발)(?:을|를)?\s*(전|후|중)/g)].map(m => `${["운반", "운송", "이송"].includes(m[1]) ? "운반" : m[1]}:${m[2]}`);
  const claimPhases = phase(claim), quotePhases = phase(quote);
  if (claimPhases.some(item => !quotePhases.includes(item))) return "timing";
  if (/(?:적재|화물)(?:물)?\s*(?:상태|고정|안정)/.test(claim) && /바닥|데크|Deck/i.test(quote) &&
      !/(?:적재|화물)(?:물)?\s*(?:상태|고정|안정)|화물이?\s*움직|적재물/.test(quote)) return "object";
  const sourceNumbers = new Set(quote.match(/\d+(?:[.,]\d+)*/g) ?? []);
  if ((claim.match(/\d+(?:[.,]\d+)*/g) ?? []).some(number => !sourceNumbers.has(number))) return "number";
  return null;
}

/** Specific equipment found in the supporting passage/context must not silently
 * become direct evidence for a different device. Mixed equipment stays with the judge. */
export function equipmentMismatch(claim: string, quote: string, reference: RetrievedReference, context: string) {
  const equipment = (text: string) => ["지게차", "트레일러", "화물차", "견인차", "컨베이어", "크레인"].filter(word => text.includes(word));
  const wanted = equipment(`${claim} ${context}`);
  const explicit = equipment(quote);
  const found = explicit.length ? explicit : equipment(`${reference.context?.sectionTitle ?? ""} ${reference.context?.surroundingText ?? reference.excerpt}`);
  return wanted.length > 0 && found.length > 0 && !wanted.some(word => found.includes(word));
}

export function evidenceLabel(link: EvidenceLink, stale = false) {
  if (stale) return `${link.applicability === "transfer" ? "타 자료에서 활용" : link.applicability === "direct" ? "이전 직접 근거" : "이전 연결 기록"} · 재검증 필요`;
  if (link.value === "visual_reference") return "시각자료 관련성 · AI 대조 통과";
  if (link.applicability === "transfer") return `타 자료에서 활용 · ${link.review === "accepted" ? "작업자 확인" : "적용 검토 필요"}`;
  return link.applicability === "direct" ? "직접 근거 · AI 대조 통과" : "이전 연결 기록 · 적용 범위 미분류";
}
