import type { MapNode } from '../types.js';
import { hash } from '../format.js';
export interface Circle { node: MapNode; x: number; y: number; r: number; hitR: number }
export interface Band { age: number; inner: number; outer: number }
export interface Layout { circles: Circle[]; bands: Band[]; radius: number }
const TAU = Math.PI * 2;
const GAP = 3;
class CollisionGrid {
  private cells = new Map<string, Circle[]>();
  private keys(x: number, y: number, radius: number): string[] {
    const keys: string[] = [];
    for (let ix = Math.floor((x - radius) / 64); ix <= Math.floor((x + radius) / 64); ix++)
      for (let iy = Math.floor((y - radius) / 64); iy <= Math.floor((y + radius) / 64); iy++) keys.push(`${ix}:${iy}`);
    return keys;
  }
  collides(x: number, y: number, radius: number): boolean {
    for (const key of this.keys(x, y, radius + GAP)) {
      for (const c of this.cells.get(key) ?? []) {
        const distance = radius + c.hitR + GAP;
        if ((x - c.x) ** 2 + (y - c.y) ** 2 < distance ** 2) return true;
      }
    }
    return false;
  }
  add(circle: Circle): void {
    for (const key of this.keys(circle.x, circle.y, circle.hitR)) {
      const cell = this.cells.get(key) ?? []; cell.push(circle); this.cells.set(key, cell);
    }
  }
}
/** Area is linear in bytes. Tiny/zero files have a separate minimum hit target.
 * All layout decisions are deterministic; there is no permanent physics loop. */
export function buildLayout(nodes: MapNode[]): Layout {
  if (!nodes.length) return { circles: [], bands: [], radius: 300 };
  const max = Math.max(1, ...nodes.map((n) => n.bytes));
  const radii = (n: MapNode) => n.bytes > 0 ? Math.sqrt(n.bytes / max) * 100 : 0;
  // Larger files are placed first, so the visual centre remains size-centric.
  // ageBucket, category and other presentation metadata intentionally do not affect
  // the geometry. The key/fileId tie-breakers make shuffled input produce the same map.
  const sorted = [...nodes].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key) || Number(a.fileId ?? -1) - Number(b.fileId ?? -1));
  const all: Circle[] = [];
  const grid = new CollisionGrid();
  for (const node of sorted) {
    const r = radii(node), hitR = Math.max(2, r);
    let best: Circle | undefined;
    let bestDistance = Infinity;
    // Candidates tangent to existing circles give a compact, deterministic packing.
    // A node-specific phase avoids input-order patterns while remaining age-independent.
    // Two opposite candidates per anchor keep the search bounded.
    for (const anchor of all) {
      const phase = (hash(`${node.key}/${anchor.node.key}`) / 0xffffffff) * TAU;
      const distance = anchor.hitR + hitR + GAP;
      for (let i = 0; i < 2; i++) {
        const angle = phase + i * TAU / 2;
        const x = anchor.x + Math.cos(angle) * distance;
        const y = anchor.y + Math.sin(angle) * distance;
        // The objective is distance from the origin; avoid grid work for candidates
        // that cannot improve the best compact position found so far.
        const fromCentre = x * x + y * y;
        if (fromCentre >= bestDistance) continue;
        if (grid.collides(x, y, hitR)) continue;
        bestDistance = fromCentre; best = { node, x, y, r, hitR };
      }
    }
    // The first circle is centred. This fallback is also a proof of termination:
    // moving beyond every existing circle cannot collide with any of them.
    if (!best) {
      if (!all.length) best = { node, x: 0, y: 0, r, hitR };
      else {
        const x = all.reduce((right, c) => Math.max(right, c.x + c.hitR), 0) + hitR + GAP;
        best = { node, x, y: 0, r, hitR };
      }
    }
    all.push(best); grid.add(best);
  }
  const extent = all.reduce((outer, c) => Math.max(outer, Math.hypot(c.x, c.y) + c.hitR), 0);
  // Keep the legacy field for renderer compatibility; age rings no longer exist.
  return { circles: all, bands: [], radius: Math.max(300, extent + 35) };
}
export interface Camera { x: number; y: number; scale: number }
export function zoomAt(camera: Camera, x: number, y: number, factor: number, min = 0.04, max = 10): Camera {
  const scale = Math.min(max, Math.max(min, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, scale };
}
export function hitTest(circles: Circle[], x: number, y: number, scale: number): Circle | null {
  let best: Circle | null = null, nearest = Infinity;
  for (const c of circles) {
    const distance = Math.hypot(c.x - x, c.y - y);
    if (distance <= Math.max(c.r, 5 / scale) && distance < nearest) { best = c; nearest = distance; }
  }
  return best;
}
