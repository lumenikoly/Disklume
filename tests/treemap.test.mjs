import test from 'node:test';
import assert from 'node:assert/strict';
import { treemap } from '../dist/app/map/treemap.js';

test('empty and zero-byte files have no invented map area', () => {
  assert.deepEqual(treemap([], 800, 600), []);
  assert.deepEqual(treemap([{ bytes: 0 }], 800, 600), []);
  assert.deepEqual(treemap([{ bytes: 1 }], 0, 600), []);
});
test('rectangle area is proportional to bytes and covers the whole map', () => {
  const tiles = treemap([{ bytes: 100 }, { bytes: 400 }, { bytes: 0 }], 800, 600);
  assert.equal(tiles.length, 2);
  const area = t => t.width * t.height;
  assert.ok(Math.abs(area(tiles[0]) / area(tiles[1]) - 4) < 1e-10);
  assert.ok(Math.abs(tiles.reduce((s, t) => s + area(t), 0) - 480000) < 1e-8);
});
test('200 mixed sizes remain finite, in bounds and without overlaps at supported ratios', () => {
  const entries = Array.from({ length: 200 }, (_, i) => ({ bytes: 2 ** (i % 27), id: i }));
  for (const [w, h] of [[600,500], [440,300], [1000,900]]) {
    const tiles = treemap(entries, w, h);
    for (const t of tiles) {
      assert.ok([t.x,t.y,t.width,t.height].every(Number.isFinite));
      assert.ok(t.x >= 0 && t.y >= 0 && t.x+t.width <= w+1e-6 && t.y+t.height <= h+1e-6);
      for (const u of tiles) if (t !== u) {
        const overlapW = Math.min(t.x+t.width,u.x+u.width) - Math.max(t.x,u.x);
        const overlapH = Math.min(t.y+t.height,u.y+u.height) - Math.max(t.y,u.y);
        assert.ok(overlapW <= 1e-6 || overlapH <= 1e-6);
      }
    }
  }
});
test('layout is deterministic and preserves caller ordering', () => {
  const entries = [{ bytes: 1, id: 0 }, { bytes: 100, id: 1 }, { bytes: 5, id: 2 }];
  const original = structuredClone(entries);
  assert.deepEqual(treemap(entries, 800, 600), treemap(entries, 800, 600));
  assert.deepEqual(entries, original);
});
