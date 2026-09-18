/** Copy to .jev/extractors/word-records.ts; available on the next graph call. */
export default {
  name: "word-records",
  description: "Split text into unique words with stable option IDs and original values.",
  inputSchema: { type: "string" },
  outputSchema: { type: "object", required: ["records", "options"] },
  examples: [{ input: "alpha beta alpha", output: { records: { word_0: "alpha", word_1: "beta" }, options: { word_0: "alpha", word_1: "beta", none: "No matching word" } } }],
  run(input: string) {
    const words = [...new Set(input.split(/\s+/).filter(Boolean))];
    if (words.length > 254) throw new Error("Narrow the input to at most 254 candidate words");
    const records = Object.fromEntries(words.map((word, index) => [`word_${index}`, word]));
    return { records, options: { ...records, none: "No matching word" } };
  },
};
