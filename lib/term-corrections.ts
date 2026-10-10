// Only reviewed, unambiguous misspellings belong here. Add pairs as the
// customer confirms terminology; never guess corrections by word similarity.
export const industrialTermCorrections = [
  { from: "껴임", to: "끼임" },
] as const;

export const TERM_CORRECTION_NOTICE_PREFIX = "자동 용어 교정:";
export type TermCorrection = { from: string; to: string; count: number };
export type FieldTermCorrection = TermCorrection & { field: string };

// Allow common particles and safety compounds, without replacing substrings
// inside unrelated names, identifiers, or unknown words.
const suffix = "(?:(?:사고|재해|위험)(?:방지|예방)?|방지|예방)?(?:이라고|이라는|이란|이라면|이므로|입니다|이다|에서는|에서도|에서|에는|에도|에게|으로는|으로|로는|처럼|까지|부터|보다|은|는|이|가|을|를|의|에|로|과|와|도|만)?";
const rules = industrialTermCorrections.map(({ from, to }) => ({
  from, to,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${from}(?=${suffix}(?![\\p{L}\\p{N}_]))`, "gu"),
}));

// Keep code, URLs, email addresses and filenames byte-for-byte intact.
const protectedText = /(```[\s\S]*?```|`[^`\n]*`|(?:https?:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-zA-Z]{2,}|[\p{L}\p{N}_./\\-]+\.[a-zA-Z0-9]{1,10})/giu;

export function correctIndustrialTerms(text: string): { text: string; corrections: TermCorrection[] } {
  const counts = new Map<string, TermCorrection>();
  const corrected = text.split(protectedText).map((part, index) => {
    if (index % 2) return part;
    for (const rule of rules) {
      part = part.replace(rule.pattern, () => {
        const correction = counts.get(rule.from) ?? { from: rule.from, to: rule.to, count: 0 };
        correction.count++;
        counts.set(rule.from, correction);
        return rule.to;
      });
    }
    return part;
  }).join("");
  return { text: corrected, corrections: [...counts.values()] };
}

export function termCorrectionNotice(corrections: FieldTermCorrection[]): string | null {
  if (!corrections.length) return null;
  const terms = new Map<string, { to: string; count: number; fields: Set<string> }>();
  for (const correction of corrections) {
    const term = terms.get(correction.from) ?? { to: correction.to, count: 0, fields: new Set<string>() };
    term.count += correction.count;
    term.fields.add(correction.field);
    terms.set(correction.from, term);
  }
  const details = [...terms].map(([from, term]) => `‘${from}’ → ‘${term.to}’ (${[...term.fields].join("·")}, ${term.count}곳)`);
  const notice = `${TERM_CORRECTION_NOTICE_PREFIX} ${details.join("; ")}.`;
  // Generation warnings have a 300-character contract, including future rules.
  return notice.length <= 300 ? notice : notice.slice(0, 299) + "…";
}
