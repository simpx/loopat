export function gapToColumnFinalIndex(oldIdx: number, gapIdx: number, listLength: number): number {
  const finalIdx = oldIdx < gapIdx ? gapIdx - 1 : gapIdx
  return Math.max(0, Math.min(finalIdx, listLength - 1))
}
