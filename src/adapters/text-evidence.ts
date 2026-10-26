// Case conversion can change UTF-16 lengths, but preserves the order of line feeds.
export function originalLineRange(content: string, searchedContent: string, matchIndex: number): { start: number; end: number } {
  let original = 0;
  for (let newline = searchedContent.indexOf('\n'); newline >= 0 && newline <= matchIndex;
    newline = searchedContent.indexOf('\n', newline + 1)) {
    original = content.indexOf('\n', original) + 1;
  }
  const newline = content.indexOf('\n', original);
  return { start: original, end: newline < 0 ? content.length : newline };
}
