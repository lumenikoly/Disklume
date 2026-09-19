import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, zoomAt, hitTest } from '../dist/app/map/layout.js';
const node = (id, bytes, ageBucket = 0, category = 'video') => ({key:`f${id}`,label:`Файл ${id}`,bytes,count:1,ageBucket,category,fileId:id,duplicateGroup:null,screenshot:false,bucket:null});

test('empty map has a finite camera extent', () => {
  const map=buildLayout([]); assert.equal(map.circles.length,0); assert.ok(map.radius > 0);
});
test('circle AREA rather than radius is proportional to bytes', () => {
  const map=buildLayout([node(0,100),node(1,400)]);
  const a=map.circles.find(c=>c.node.fileId===0),b=map.circles.find(c=>c.node.fileId===1);
  assert.ok(Math.abs(b.r ** 2 / a.r ** 2 - 4) < 1e-10);
});
test('zero byte files remain zero area with a hit target', () => {
  const c=buildLayout([node(0,0)]).circles[0]; assert.equal(c.r,0); assert.ok(c.hitR > 0);
});
test('layout is deterministic, including shuffled input order', () => {
  const rows=Array.from({length:80},(_,i)=>node(i,1000+i*37,i%5,['video','image','archive','document'][i%4]));
  assert.deepEqual(buildLayout(rows),buildLayout([...rows].reverse()));
});
test('dense same-sector map has no overlapping hit circles', () => {
  const map=buildLayout(Array.from({length:480},(_,i)=>node(i,10000-i*10,2)));
  for(let i=0;i<map.circles.length;i++) for(let j=i+1;j<map.circles.length;j++) {
    const a=map.circles[i],b=map.circles[j];
    assert.ok(Math.hypot(a.x-b.x,a.y-b.y)+1e-7 >= a.hitR+b.hitR,`${i} / ${j}`);
  }
});
test('layout is independent of age and keeps legacy bands empty', () => {
  const rows=Array.from({length:120},(_,i)=>node(i,10000/(i+1),i%6));
  const aged=buildLayout(rows), uniform=buildLayout(rows.map(n=>({...n,ageBucket:0})));
  assert.deepEqual(aged.circles.map(c=>[c.node.fileId,c.x,c.y,c.r,c.hitR]),uniform.circles.map(c=>[c.node.fileId,c.x,c.y,c.r,c.hitR]));
  assert.equal(aged.radius,uniform.radius);
  assert.deepEqual(aged.bands,[]);
});
test('largest file is at the centre of the size-centric packing', () => {
  const map=buildLayout([node(0,100),node(1,400),node(2,25)]);
  const largest=map.circles.find(c=>c.node.fileId===1);
  assert.equal(largest.x,0); assert.equal(largest.y,0);
});
test('zoom keeps the world position under the pointer unchanged', () => {
  const old={x:100,y:150,scale:.5},x=330,y=140,next=zoomAt(old,x,y,1.7);
  assert.ok(Math.abs((x-old.x)/old.scale-(x-next.x)/next.scale)<1e-9);
  assert.ok(Math.abs((y-old.y)/old.scale-(y-next.y)/next.scale)<1e-9);
  assert.equal(zoomAt(old,x,y,1e10).scale,10);
});
test('hit testing returns a node, never the empty background', () => {
  const map=buildLayout([node(1,4096)]),c=map.circles[0];
  assert.equal(hitTest(map.circles,c.x,c.y,1),c); assert.equal(hitTest(map.circles,-10000,10000,1),null);
});
