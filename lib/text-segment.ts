// Line breaking shared by the storyboard preview, PNG and PDF.
// Words stay whole unless one word is wider than the line. Hangul and Han text
// may break between any two characters, as Korean subtitles always have.
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const clusters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const breaksAnywhere = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

// Scripts whose glyphs must be reordered or stacked by a shaping engine.
// pdf-lib and SVG rendering place these glyphs incorrectly; draw them with canvas.
export const needsShaping = (text: string) =>
  /[\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Thai}\p{Script=Lao}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Arabic}]/u.test(text);

export const graphemes = (text: string) => Array.from(clusters.segment(text), part => part.segment);

// Closing punctuation never starts a line; it stays with the unit before it.
const closing = /^[\p{Pe}\p{Pf}.,!?;:%…។៕៖、。，．！？；：]+$/u;
export function lineUnits(text: string) {
  return Array.from(words.segment(text), part => part.segment)
    .flatMap(unit => breaksAnywhere.test(unit) ? graphemes(unit) : [unit])
    .reduce<string[]>((units, unit) => {
      if (units.length && closing.test(unit)) units[units.length - 1] += unit; else units.push(unit);
      return units;
    }, []);
}

export function wrapLines(text: string, width: number, measure: (text: string) => number) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    const push = () => { if (line.trim()) lines.push(line.trim()); line = ""; };
    for (const unit of lineUnits(paragraph)) {
      if (measure(line + unit) <= width) { line += unit; continue; }
      push();
      if (!unit.trim()) continue;
      if (measure(unit) <= width) { line = unit; continue; }
      for (const part of graphemes(unit)) {
        if (line && measure(line + part) > width) push();
        line += part;
      }
    }
    push();
  }
  return lines;
}
