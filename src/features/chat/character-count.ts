/** Count Unicode code points in the original Markdown, excluding whitespace. */
export function countCharacters(text: string): number {
  let count = 0;
  for (const character of text) if (!/\s/u.test(character)) count++;
  return count;
}
