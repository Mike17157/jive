import type { SessionStore } from "./store";

export async function excerptOversizedOutput(
  store: SessionStore,
  label: string,
  fullText: string,
  maxInlineCharacters: number,
): Promise<string> {
  if (fullText.length <= maxInlineCharacters) return fullText;
  const artifact = await store.saveArtifact(label, fullText, "application/json");
  const available = Math.max(256, maxInlineCharacters - 320);
  const headLength = Math.floor(available * 0.65);
  const tailLength = available - headLength;
  return [
    "[OVERSIZED OUTPUT EXCERPT — NOT COMPLETE]",
    `Full output (${fullText.length} characters, ${artifact.bytes} bytes) saved at: ${artifact.path}`,
    `--- first ${headLength} characters ---`,
    fullText.slice(0, headLength),
    `--- omitted ${fullText.length - headLength - tailLength} characters ---`,
    `--- last ${tailLength} characters ---`,
    fullText.slice(-tailLength),
  ].join("\n");
}
