import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactoryStore, hash, validPath, type KV, type Bundle } from '../domain';

class MemoryKV implements KV {
  values = new Map<string,unknown>();
  async get<T>(key:string) {return structuredClone(this.values.get(key)) as T|undefined;}
  async set(key:string,value:unknown) {this.values.set(key,structuredClone(value));}
  async delete(key:string) {this.values.delete(key);}
}
const path='meeseeks-methodology/SKILL.md';
const bundle:Bundle={source:'test',files:[{path,content:'Original rules',hash:hash('Original rules')}]};
const project={name:'Existing product',mode:'existing',repository:'/test/repo',baseline:'Manual baseline'};
async function setup(){const kv=new MemoryKV();const store=new FactoryStore(kv,bundle);await store.init();return {store,kv};}

test('project lifecycle: create, read, update pin, read, delete and missing read',async()=>{
  const {store}=await setup();
  const initial=await store.head();
  const created=await store.create(project);
  assert.equal(created.name,project.name);assert.equal(created.adoption,'baseline_recorded');assert.equal(created.repository,'/test/repo');assert.equal(created.revision,initial.id);
  assert.deepEqual(await store.get(created.id),created);
  const next=await store.edit({expectedRevision:initial.id,path,content:'New rules'});
  assert.equal((await store.get(created.id)).revision,initial.id);
  const updated=await store.update({id:created.id,expectedUpdatedAt:created.updatedAt,revision:next.id,adoption:'adopting',name:'Renamed',repository:'/updated/repo',baseline:'Verified new baseline'});
  assert.equal(updated.name,'Renamed');assert.equal(updated.repository,'/updated/repo');assert.equal(updated.baseline,'Verified new baseline');assert.equal(updated.revision,next.id);assert.equal(updated.adoption,'adopting');assert.deepEqual(await store.get(created.id),updated);
  await assert.rejects(store.update({id:created.id,expectedUpdatedAt:created.updatedAt,revision:initial.id,adoption:'planned'}),/изменён/);
  assert.deepEqual(await store.remove(created.id),{removed:true});assert.deepEqual(await store.list(),[]);
  await assert.rejects(store.get(created.id),/не найден/);await assert.rejects(store.remove(created.id),/не найден/);
});
test('revision edit keeps old file immutable and rejects stale save',async()=>{
  const {store,kv}=await setup();const first=await store.head();
  const second=await store.edit({expectedRevision:first.id,path,content:'Updated rules'});
  assert.notEqual(first.id,second.id);assert.equal(second.parent,first.id);
  assert.equal((await store.file(first.id,path)).content,'Original rules');assert.equal((await store.file(second.id,path)).content,'Updated rules');
  await assert.rejects(store.edit({expectedRevision:first.id,path,content:'Lost update'}),/Версия изменилась/);
  assert.equal((await store.head()).id,second.id);
  const reloaded=new FactoryStore(kv,bundle);await reloaded.init();assert.equal((await reloaded.head()).id,second.id);
});
test('serialized concurrent project creation loses no records; projects remain isolated',async()=>{
  const {store}=await setup();const projects=await Promise.all(Array.from({length:12},(_,i)=>store.create({...project,name:'Project '+i})));
  assert.equal((await store.list()).length,12);assert.equal(new Set(projects.map(p=>p.id)).size,12);
  const first=projects[0]!;await store.update({id:first.id,expectedUpdatedAt:first.updatedAt,revision:first.revision,adoption:'standard'});
  assert.equal((await store.get(first.id)).adoption,'standard');assert.equal((await store.get(projects[1]!.id)).adoption,'baseline_recorded');
});
test('concurrent edits produce one revision and conflict, preserving content',async()=>{
  const {store}=await setup();const first=await store.head();
  const results=await Promise.allSettled(['A','B'].map(content=>store.edit({expectedRevision:first.id,path,content})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal((await store.revisions()).length,2);assert.equal((await store.file((await store.head()).id,path)).content,'A');
});
test('invalid existing-project baseline, traversal, file limit and unknown pin fail without changes',async()=>{
  const {store}=await setup();await assert.rejects(store.create({...project,baseline:''}));await assert.rejects(store.create({...project,name:' '}));assert.deepEqual(await store.list(),[]);
  assert.throws(()=>validPath('meeseeks-methodology/../secret'));assert.throws(()=>validPath('/etc/passwd'));
  const head=await store.head();await assert.rejects(store.edit({expectedRevision:head.id,path,content:'x'.repeat(120001)}),/120/);assert.equal((await store.head()).id,head.id);
  const created=await store.create(project);await assert.rejects(store.update({id:created.id,expectedUpdatedAt:created.updatedAt,revision:'f'.repeat(64),adoption:'standard'}),/Ревизия не найдена/);assert.deepEqual(await store.get(created.id),created);
});
test('tampered bundle and corrupt blobs are rejected',async()=>{
  const bad=new FactoryStore(new MemoryKV(),{...bundle,files:[{...bundle.files[0]!,hash:'bad'}]});await assert.rejects(bad.init(),/Повреждён/);
  const {store,kv}=await setup();const rev=await store.head();await kv.set('blob:'+bundle.files[0]!.hash,'Corrupt');await assert.rejects(store.file(rev.id,path),/повреждено/);
});

test('project listing is paginated and output stays bounded with maximum baselines',async()=>{
  const {store}=await setup();await Promise.all(Array.from({length:25},(_,i)=>store.create({...project,name:'Project '+i,baseline:'я'.repeat(12000)})));
  const first=await store.list();const second=await store.list({offset:20,limit:20});
  assert.equal(first.length,20);assert.equal(second.length,5);assert.equal(await store.count(),25);
  assert.equal(new Set([...first,...second].map(p=>p.id)).size,25);assert.ok(Buffer.byteLength(JSON.stringify(first))<1_500_000);
  await assert.rejects(store.list({limit:21}));await assert.rejects(store.list({offset:-1}));
});
