export type MashupClip = { name: string; url: string; mimeType: string };
export type MashupGroup = { name: string; clips: MashupClip[] };
export const groupNames = ["A", "B", "C", "D", "eval", "F"];

export function combinationCount(groups: readonly MashupClip[][]) {
  return groups.reduce((count, group) => count * group.length, 1);
}

export function combinationAt(groups: readonly MashupClip[][], index: number) {
  const clips: MashupClip[] = [];
  for (let slot = groups.length - 1; slot >= 0; slot--) {
    const group = groups[slot];
    clips.unshift(group[index % group.length]);
    index = Math.floor(index / group.length);
  }
  return clips;
}

export async function renderBatch(
  groups: readonly MashupClip[][], limit: number, completed: number,
  render: (clips: MashupClip[], index: number) => Promise<void>,
) {
  if (groups.length < 2 || groups.length > groupNames.length || !Number.isSafeInteger(limit) || limit < 1 || limit > combinationCount(groups)) {
    throw Error("请填满各素材组，并选择有效的导出数量");
  }
  for (let index = completed; index < limit; index++) await render(combinationAt(groups, index), index);
}
