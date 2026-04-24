import type { CharBox } from "./viewer-controller";

// Ratio of character height used as the gap threshold for inserting whitespace
// between two chars that are on the same line. Mirrors cherrypicker's value.
export const WHITE_SPACE_RATIO = 0.15;

// Line-break threshold in PDF points. Two chars whose top coordinates differ
// by more than this are considered to be on different lines.
export const LINE_BREAK_TOLERANCE = 5;

export interface CharMapEntry {
  charIndex: number;
  textStart: number;
  textEnd: number;
}

export interface PageText {
  text: string;
  charMap: CharMapEntry[];
}

/**
 * Build a page-level string with whitespace inserted at natural word/line
 * boundaries, along with a map from text offsets back to char indices.
 *
 * PDFs often omit explicit space characters; chars are simply positioned
 * with a gap. Without this inflation, substring search for "hello world"
 * cannot match a PDF that visually reads "hello world" because the backing
 * chars array is ["h","e","l","l","o","w","o","r","l","d"].
 */
export function buildPageText(chars: CharBox[]): PageText {
  if (chars.length === 0) return { text: "", charMap: [] };

  let text = chars[0].text;
  const charMap: CharMapEntry[] = [{ charIndex: 0, textStart: 0, textEnd: chars[0].text.length }];

  for (let i = 1; i < chars.length; i += 1) {
    const prev = chars[i - 1];
    const curr = chars[i];
    if (needsSpaceBetween(prev, curr)) text += " ";
    const start = text.length;
    text += curr.text;
    charMap.push({ charIndex: i, textStart: start, textEnd: text.length });
  }

  return { text, charMap };
}

/**
 * Space-aware join of a char slice — same whitespace heuristics as
 * `buildPageText` but operating on an arbitrary contiguous run.
 */
export function charsToText(chars: CharBox[]): string {
  if (chars.length === 0) return "";
  let result = chars[0].text;
  for (let i = 1; i < chars.length; i += 1) {
    if (needsSpaceBetween(chars[i - 1], chars[i])) result += " ";
    result += chars[i].text;
  }
  return result;
}

/**
 * Find the start/end char indices of the word containing `index`. Word
 * boundaries are detected via the same gap/line heuristic as space insertion
 * so it also works on PDFs whose chars array lacks explicit spaces.
 */
export function findWordBoundaries(chars: CharBox[], index: number): [number, number] | null {
  const target = chars[index];
  if (!target || target.text.trim() === "") return null;

  let start = index;
  while (start > 0) {
    const prev = chars[start - 1];
    const curr = chars[start];
    if (Math.abs(prev.top - target.top) > LINE_BREAK_TOLERANCE) break;
    if (prev.text.trim() === "") break;
    if (hasGapBetween(prev, curr)) break;
    start -= 1;
  }

  let end = index;
  while (end < chars.length - 1) {
    const curr = chars[end];
    const next = chars[end + 1];
    if (Math.abs(next.top - target.top) > LINE_BREAK_TOLERANCE) break;
    if (next.text.trim() === "") break;
    if (hasGapBetween(curr, next)) break;
    end += 1;
  }

  return [start, end];
}

/**
 * Map an offset in the string produced by `buildPageText` to its source char
 * index. If `offset` falls inside a char's extent, that char's index is
 * returned; if it falls on an inserted space, the nearest char bounding it
 * on the requested side is returned.
 */
export function textOffsetToCharIndex(charMap: CharMapEntry[], offset: number, side: "start" | "end"): number {
  if (charMap.length === 0) return -1;
  if (side === "start") {
    for (let i = 0; i < charMap.length; i += 1) {
      if (charMap[i].textStart <= offset && offset < charMap[i].textEnd) return charMap[i].charIndex;
      if (charMap[i].textStart > offset) return charMap[i].charIndex;
    }
    return charMap[charMap.length - 1].charIndex;
  }
  for (let i = charMap.length - 1; i >= 0; i -= 1) {
    if (charMap[i].textStart < offset && offset <= charMap[i].textEnd) return charMap[i].charIndex;
    if (charMap[i].textEnd < offset) return charMap[i].charIndex;
  }
  return charMap[0].charIndex;
}

export function hasGapBetween(prev: CharBox, curr: CharBox): boolean {
  const gap = curr.x0 - prev.x1;
  const charHeight = prev.bottom - prev.top;
  return gap > charHeight * WHITE_SPACE_RATIO;
}

export function needsSpaceBetween(prev: CharBox, curr: CharBox): boolean {
  if (Math.abs(curr.top - prev.top) > LINE_BREAK_TOLERANCE) return true;
  return hasGapBetween(prev, curr);
}
