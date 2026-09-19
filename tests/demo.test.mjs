import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { DemoBackend } from '../dist/app/demo.js';
import { defaultFilter, busy } from '../dist/app/types.js';
async function ready(backend,id) {
  for(let n=0;n<100;n++){const s=await backend.status(id);if(!busy(s.phase))return s;await sleep(20);}
  throw Error('Demo worker did not finish');
}
async function fixture(){const b=new DemoBackend(),id=await b.chooseFolder();await ready(b,id);return {b,id};}

test('demo is explicit; no native APIs are required', async()=>{
  const {b,id}=await fixture();assert.equal(b.demo,true);assert.equal((await b.status(id)).files,973);
  await assert.rejects(b.open(id,0,false),/пример/);await assert.rejects(b.reveal(id,0),/пример/);
});
test('aggregation preserves count and bytes with a bounded frontend', async()=>{
  const {b,id}=await fixture(),v=await b.query(id,defaultFilter(),0);
  assert.equal(v.nodes.reduce((s,n)=>s+n.count,0),v.total);
  assert.equal(v.nodes.reduce((s,n)=>s+n.bytes,0),v.bytes);
  assert.equal(v.files.length,200);assert.ok(v.nodes.length<=576);
  assert.equal(v.nodes.filter(n=>n.fileId!==null).length,480);
});
test('bucket cursor does not select files already drawn individually', async()=>{
  const {b,id}=await fixture(),filter=defaultFilter(),v=await b.query(id,filter,0),drawn=new Set(v.nodes.map(n=>n.fileId));
  for(const n of v.nodes.filter(n=>n.bucket)){
    const child=await b.query(id,{...filter,bucket:n.bucket},0);
    assert.equal(child.total,n.count);assert.equal(child.bytes,n.bytes);
    assert.ok(child.files.every(f=>!drawn.has(f.id)));assert.ok(child.total<v.total);
  }
});
test('search and screenshot classification are applied together', async()=>{
  const {b,id}=await fixture();
  const v=await b.query(id,{...defaultFilter(),screenshotsOnly:true,text:'СНИМОК'},0);
  assert.ok(v.total>0);assert.ok(v.files.every(f=>f.category==='image'&&f.screenshot));
});
test('empty query and out-of-range page are safe', async()=>{
  const {b,id}=await fixture();
  const empty=await b.query(id,{...defaultFilter(),text:'not-existing-unique'},900000);assert.equal(empty.total,0);assert.equal(empty.offset,0);
  const last=await b.query(id,defaultFilter(),900000);assert.equal(last.offset,800);assert.equal(last.files.length,173);
});
test('stale scan identifiers are rejected', async()=>{
  const {b,id}=await fixture();const next=await b.chooseFolder();await ready(b,next);
  await assert.rejects(b.planAdd(id,[0]),/устарела/);await assert.rejects(b.query(id,defaultFilter(),0),/устарела/);
});
test('adding to the plan is not deletion; invalid IDs do not partially mutate', async()=>{
  const {b,id}=await fixture();await assert.rejects(b.planAdd(id,[0,1e6]));assert.equal((await b.planPage(id,0)).count,0);
  const p=await b.planAdd(id,[0,0,1]);assert.equal(p.count,2);assert.equal((await b.status(id)).files,973);
  await b.planClear(id);assert.equal((await b.status(id)).files,973);assert.equal((await b.planPage(id,0)).count,0);
});
test('stale plan revision cannot execute', async()=>{
  const {b,id}=await fixture(),p=await b.planAdd(id,[0]);await b.planAdd(id,[1]);
  await assert.rejects(b.executePlan(id,p.revision),/изменился/);assert.equal((await b.status(id)).files,973);
});
test('confirmed demo deletion removes only selected objects', async()=>{
  const {b,id}=await fixture(),p=await b.planAdd(id,[0,2]);await b.executePlan(id,p.revision);
  await assert.rejects(b.planAdd(id,[1]),/операцию/);const s=await ready(b,id);
  assert.equal(s.files,971);assert.equal(s.operation.succeeded,2);assert.equal(s.planCount,0);
  await assert.rejects(b.details(id,0));assert.equal((await b.details(id,1)).file.id,1);
});
test('duplicate results appear only after the explicit check', async()=>{
  const {b,id}=await fixture(),filter={...defaultFilter(),duplicatesOnly:true};assert.equal((await b.query(id,filter,0)).total,0);
  await b.findDuplicates(id);await ready(b,id);assert.equal((await b.query(id,filter,0)).total,2);
  const p=await b.planAdd(id,[0]);await b.executePlan(id,p.revision);await ready(b,id);
  assert.equal((await b.query(id,filter,0)).total,0);
});
test('cancellation makes the synthetic worker stop',async()=>{
  const {b,id}=await fixture();await b.findDuplicates(id);await b.cancel(id);await sleep(450);
  assert.equal((await b.status(id)).phase,'cancelled');assert.equal((await b.status(id)).duplicateFiles,0);
});

test('folder mode exposes stable nested totals, filters, and breadcrumbs', async()=>{
  const {b,id}=await fixture();
  const root=await b.query(id,{...defaultFilter(),folders:true,directoryId:0},0);
  const video=root.entries.find((entry)=>entry.name==='Видео'&&entry.directoryId!==null);
  assert.ok(video); assert.equal(video.file,null); assert.ok(video.count>0); assert.ok(root.files.length<=200); assert.equal(root.files.length,root.entries.filter((entry)=>entry.file!==null).length); assert.equal(root.nodes.length,0);
  const nested=await b.query(id,{...defaultFilter(),folders:true,directoryId:video.directoryId},0);
  assert.deepEqual(nested.breadcrumbs.map((crumb)=>crumb.id),[0,video.directoryId]); assert.ok(nested.total>=nested.entryTotal);
  assert.deepEqual(nested.files.map((file)=>file.id),nested.entries.filter((entry)=>entry.file!==null).map((entry)=>entry.file.id));
  const filtered=await b.query(id,{...defaultFilter(),folders:true,directoryId:video.directoryId,minBytes:1024**3},0);
  assert.ok(filtered.bytes<=nested.bytes); assert.ok(filtered.entries.length<=200);
  const before=video.count; const plan=await b.planAdd(id,[0]); await b.executePlan(id,plan.revision); await ready(b,id);
  const after=await b.query(id,{...defaultFilter(),folders:true,directoryId:0},0); const videoAfter=after.entries.find((entry)=>entry.name==='Видео');
  assert.ok(videoAfter); assert.equal(videoAfter.count,before-1);
});

test('folder directories remain addressable after their files are removed', async()=>{
  const {b,id}=await fixture(); const root=await b.query(id,{...defaultFilter(),folders:true,directoryId:0},0);
  const video=root.entries.find((entry)=>entry.name==='Видео'); assert.ok(video?.directoryId!==null);
  const all=(await b.query(id,defaultFilter(),0)).files.filter((file)=>file.relativePath.startsWith('Видео/'));
  const plan=await b.planAdd(id,all.map((file)=>file.id)); await b.executePlan(id,plan.revision); await ready(b,id);
  const after=await b.query(id,{...defaultFilter(),folders:true,directoryId:0},0); const retained=after.entries.find((entry)=>entry.directoryId===video.directoryId);
  assert.ok(retained); assert.equal(retained.count,0); assert.equal(retained.bytes,0);
});

test('folder pagination returns selectable files only from the displayed mixed page', async()=>{
  const {b,id}=await fixture();
  // Reshape synthetic data into a wide directory with both files and folders.
  b.files.forEach((file,index)=>{ if(index>11 && index%2===0) file.relativePath=file.name; });
  const filter={...defaultFilter(),folders:true};
  const first=await b.query(id,filter,0), second=await b.query(id,filter,200);
  assert.equal(first.entries.length,200);assert.equal(second.entries.length,200);
  for(const page of [first,second]) assert.deepEqual(page.files.map(f=>f.id),page.entries.flatMap(e=>e.file?[e.file.id]:[]));
  assert.ok(!first.files.some(f=>second.files.some(other=>other.id===f.id)));
  await assert.rejects(b.query(id,{...filter,directoryId:999999},0));
});
