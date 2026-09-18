/** Words shown from the paragraph that names the current thought. */
const TITLE_WORDS = 8;
/** Hard cap so eight long words still fit a narrow terminal row. */
const TITLE_CHARS = 72;
/** A paragraph shorter than this keeps the previous title while it streams in. */
const MIN_STABLE_WORDS = 3;

/** Remove markdown decoration so bold headings and list items read as plain words. */
export function plainWords(paragraph: string): string[] {
  const text = paragraph
    .replace(/^[ \t]*(#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+|>[ \t]*)/gm, "")
    .replace(/\*\*|__|~~|`+/g, "")
    .replace(/(^|[\s(])[*_](?=\S)/g, "$1")
    .replace(/(?<=\S)[*_](?=[\s).,;:!?]|$)/g, "");
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Deterministic one-line title for a reasoning transcript entry. The newest
 * paragraph names what the planner is doing now, so its opening words become
 * the title and the title advances as further paragraphs stream in. A
 * paragraph that has only just started keeps the previous title so the row
 * does not flash a one-word stub.
 */
export function thinkingTitle(text: string): string {
  const paragraphs = text.split(/\n[ \t]*\n/).map(plainWords).filter((words) => words.length > 0);
  if (paragraphs.length === 0) return "Thinking…";
  let words = paragraphs[paragraphs.length - 1]!;
  if (paragraphs.length > 1 && words.length < MIN_STABLE_WORDS) words = paragraphs[paragraphs.length - 2]!;
  let title = words.slice(0, TITLE_WORDS).join(" ").replace(/[:;,]+$/, "");
  const truncated = words.length > TITLE_WORDS;
  if (title.length > TITLE_CHARS) return `${title.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
  return truncated ? `${title}…` : title;
}
