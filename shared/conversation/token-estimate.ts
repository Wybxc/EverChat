// A bounded, model-independent approximation, not a supplier tokenizer or billing counter.
// Distribute 16 small samples across long text instead of scanning an entire conversation.
export const TOKEN_SAMPLE_UNITS = 256;
export function estimateTextTokens(text: string): number {
  if (!text.length) return 0;
  let weight = 0,
    sampled = 0;
  const sample = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      const code = text.charCodeAt(i);
      if (code <= 127) {
        const ordinary =
          code === 32 ||
          (code >= 9 && code <= 13) ||
          (code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122);
        weight += ordinary ? 1 / 3 : 1;
      } else weight += code >= 0xd800 && code <= 0xdfff ? 1.5 : 2;
      sampled++;
    }
  };
  if (text.length <= TOKEN_SAMPLE_UNITS) sample(0, text.length);
  else
    for (let block = 0; block < 16; block++) {
      const start = Math.floor((block * (text.length - 16)) / 15);
      sample(start, start + 16);
    }
  return Math.ceil((weight / sampled) * text.length);
}
