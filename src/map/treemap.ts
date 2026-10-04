export interface Weighted { bytes: number }
export interface Tile<T> { item: T; x: number; y: number; width: number; height: number }

/** Squarified, deterministic layout. Zero-byte entries stay in the list, with no invented area. */
export function treemap<T extends Weighted>(items: readonly T[], width: number, height: number): Tile<T>[] {
  const ordered = items.filter(item => Number.isFinite(item.bytes) && item.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  const total = ordered.reduce((sum, item) => sum + item.bytes, 0);
  if (!total || width <= 0 || height <= 0) return [];
  const rows = ordered.map(item => ({ item, area: item.bytes / total * width * height }));
  const result: Tile<T>[] = [];
  let x = 0, y = 0, w = width, h = height, index = 0;
  function worst(row: typeof rows, side: number): number {
    const sum = row.reduce((s, cell) => s + cell.area, 0);
    return Math.max(side * side * row[0]!.area / (sum * sum), sum * sum / (side * side * row.at(-1)!.area));
  }
  while (index < rows.length) {
    const row = [rows[index++]!], side = Math.min(w, h);
    while (index < rows.length && worst([...row, rows[index]!], side) <= worst(row, side)) row.push(rows[index++]!);
    const area = row.reduce((sum, cell) => sum + cell.area, 0);
    if (w >= h) {
      const strip = area / h; let cy = y;
      for (const cell of row) { const ch = cell.area / strip; result.push({ item: cell.item, x, y: cy, width: strip, height: ch }); cy += ch; }
      x += strip; w = Math.max(0, w - strip);
    } else {
      const strip = area / w; let cx = x;
      for (const cell of row) { const cw = cell.area / strip; result.push({ item: cell.item, x: cx, y, width: cw, height: strip }); cx += cw; }
      y += strip; h = Math.max(0, h - strip);
    }
  }
  return result;
}
