import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceStore, artifactKinds, type Artifact, type WorkspaceProjects } from '../workspace';
import type { Project } from '../domain';

function setup(t: {after(fn:()=>void):void}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const now=new Date().toISOString();
  const make=(name:string):Project=>({id:randomUUID(),name,mode:'new',repository:'',baseline:'',adoption:'planned',revision:'a'.repeat(64),createdAt:now,updatedAt:now});
  const first=make('First'),second=make('Second');const projects=new Map<string,Project>([[first.id,first],[second.id,second]]);
  const projectStore:WorkspaceProjects={async count(){return projects.size;},async list(options={}){return [...projects.values()].slice(options.offset??0,(options.offset??0)+(options.limit??20));},async get(id){const project=projects.get(id);if(!project)throw new Error('Проект не найден.');return structuredClone(project);},async remove(id){if(!projects.delete(id))throw new Error('Проект не найден.');return {removed:true};}};
  const store=new WorkspaceStore(db,projectStore);
  const create=(kind:string,title='Entry',fields:Record<string,string>={},links:Artifact['links']=[],projectId=first.id)=>store.create({projectId,kind,title,fields,links});
  return {db,store,first,second,projects,projectStore,create};
}

test('existing card opens empty workspace with every section; CRUD persists after re-open and CAS rejects stale writes',async t=>{
  const {db,store,first,projectStore,create}=setup(t);
  const empty=await store.workspace({projectId:first.id});assert.equal(empty.total,0);assert.deepEqual(empty.entries,[]);assert.deepEqual(Object.keys(empty.counts),[...artifactKinds]);assert.ok(Object.values(empty.counts).every(n=>n===0));assert.equal(empty.pinnedRevision,first.revision);
  const job=await create('job','Reduce effort',{situation:'Support load',desiredProgress:'Faster answer',futureField:'Keep me'});
  assert.equal(job.projectId,first.id);assert.equal(job.status,'draft');assert.equal(job.version,1);assert.deepEqual((await store.get({projectId:first.id,id:job.id})).fields,job.fields);
  const updated=await store.update({...job,expectedVersion:1,title:'Better title',fields:{...job.fields,successCriterion:'1 minute'},id:job.id,projectId:first.id,links:[],status:'accepted',kind:undefined,version:undefined,createdAt:undefined,updatedAt:undefined}).catch(()=>null);
  assert.equal(updated,null);
  const saved=await store.update({projectId:first.id,id:job.id,expectedVersion:1,title:'Better title',fields:{...job.fields,successCriterion:'1 minute'},links:[],status:'accepted'});
  assert.equal(saved.version,2);assert.equal(saved.fields.futureField,'Keep me');assert.equal(saved.fields.successCriterion,'1 minute');assert.equal(saved.status,'accepted');
  const reloaded=new WorkspaceStore(db,projectStore);assert.deepEqual(await reloaded.get({projectId:first.id,id:job.id}),saved);
  await assert.rejects(store.update({projectId:first.id,id:job.id,expectedVersion:1,title:'Overwrite',fields:{},links:[],status:'draft'}),/текущая версия 2/);
  await assert.rejects(store.remove({projectId:first.id,id:job.id,expectedVersion:1}),/текущая версия 2/);
  assert.deepEqual(await store.remove({projectId:first.id,id:job.id,expectedVersion:2}),{removed:true});await assert.rejects(store.get({projectId:first.id,id:job.id}),/не найден/);await assert.rejects(store.remove({projectId:first.id,id:job.id,expectedVersion:2}),/не найден/);
});

test('references stay in project; target type, duplicate and incoming references are checked atomically',async t=>{
  const {store,first,second,create}=setup(t);
  const job=await create('job','Job');
  const initiative=await create('initiative','Initiative',{},[{type:'solves_job',targetId:job.id}]);
  await assert.rejects(store.get({projectId:second.id,id:job.id}),/не найден/);
  await assert.rejects(create('initiative','Foreign',{},[{type:'solves_job',targetId:job.id}],second.id),/Цель связи не найдена/);
  await assert.rejects(create('initiative','Wrong kind',{},[{type:'solves_job',targetId:initiative.id}]),/Неверный вид/);
  await assert.rejects(create('initiative','Duplicate',{},[{type:'solves_job',targetId:job.id},{type:'solves_job',targetId:job.id}]),/Повторяющаяся/);
  await assert.rejects(store.remove({projectId:first.id,id:job.id,expectedVersion:1}),/входящая связь/);
  assert.equal((await store.workspace({projectId:first.id})).total,2);assert.equal((await store.workspace({projectId:second.id})).total,0);
  const unlink=await store.update({projectId:first.id,id:initiative.id,expectedVersion:1,title:initiative.title,fields:initiative.fields,links:[],status:'draft'});
  await store.remove({projectId:first.id,id:job.id,expectedVersion:1});await store.remove({projectId:first.id,id:initiative.id,expectedVersion:unlink.version});assert.equal((await store.workspace({projectId:first.id})).total,0);
});

test('singleton passport/offer, durable journals, draft tasks and manual acceptance root checks',async t=>{
  const {store,first,second,create}=setup(t);
  for(const kind of ['passport','offer']){
    await create(kind,kind);await assert.rejects(create(kind,'Duplicate'),/уже есть/);await create(kind,'Other project',{},[],second.id);
  }
  for(const kind of ['decision','fork','adr']){const entry=await create(kind,kind);await assert.rejects(store.remove({projectId:first.id,id:entry.id,expectedVersion:1}),/Запись журнала сохраняется/);}
  const task=await create('task','Unfinished task');assert.equal(task.status,'draft');
  const input={projectId:first.id,id:task.id,expectedVersion:1,title:task.title,fields:{},links:[],status:'accepted'};
  await assert.rejects(store.update(input),/ровно один корень/);
  const initiative=await create('initiative','Technical initiative');
  const accepted=await store.update({...input,links:[{type:'root',targetId:initiative.id}]});assert.equal(accepted.status,'accepted');assert.equal(accepted.version,2);
});

test('workspace and target lists paginate/count/search, preserving unfamiliar future data on reads',async t=>{
  const {store,db,first,create}=setup(t);
  for(let i=0;i<25;i++)await create('job','Job '+i.toString().padStart(2,'0'),{situation:'x'.repeat(5000)});
  const firstPage=await store.workspace({projectId:first.id,kind:'job'});const next=await store.workspace({projectId:first.id,kind:'job',offset:20});assert.equal(firstPage.entries.length,20);assert.equal(firstPage.counts.job,25);assert.equal(next.entries.length,5);assert.equal(new Set([...firstPage.entries,...next.entries].map(entry=>entry.id)).size,25);
  const targets=await store.targets({projectId:first.id,query:'JOB 2',limit:2,offset:1});assert.equal(targets.total,5);assert.equal(targets.entries.length,2);assert.ok(targets.entries.every(entry=>!('fields' in entry)));
  const firstEntry=firstPage.entries[0]!;db.prepare('UPDATE factory_artifacts SET kind=?,fields_json=? WHERE id=?').run('future_kind',JSON.stringify({futureField:'Preserved'}),firstEntry.id);
  const future=await store.get({projectId:first.id,id:firstEntry.id});assert.equal(future.kind,'future_kind');assert.deepEqual(future.fields,{futureField:'Preserved'});assert.equal((await store.workspace({projectId:first.id})).counts.future_kind,1);
  await assert.rejects(store.create({projectId:first.id,kind:'future_kind',title:'Unknown',fields:{},links:[]}));
  await assert.rejects(store.workspace({projectId:first.id,limit:21}));await assert.rejects(store.targets({projectId:first.id,limit:101}));
});

test('concurrent CAS/singleton writes serialize and failed writes do not change records',async t=>{
  const {store,first,create}=setup(t);const entry=await create('job','Job');
  const edits=await Promise.allSettled(['One','Two'].map(title=>store.update({projectId:first.id,id:entry.id,expectedVersion:1,title,fields:{},links:[],status:'draft'})));
  assert.equal(edits.filter(result=>result.status==='fulfilled').length,1);assert.equal(edits.filter(result=>result.status==='rejected').length,1);assert.equal((await store.get({projectId:first.id,id:entry.id})).version,2);
  const passports=await Promise.allSettled([create('passport'),create('passport')]);assert.equal(passports.filter(result=>result.status==='fulfilled').length,1);
  await assert.rejects(create('job','Too big',Object.fromEntries(Array.from({length:10},(_,i)=>['field'+i,'x'.repeat(30000)]))),/120 КБ/);
  assert.equal((await store.workspace({projectId:first.id})).total,2);
});

test('project removal and artifact creation share one queue, preventing orphan workspace',async t=>{
  const {store,first,second,projects,create}=setup(t);
  const deleteFirst=await Promise.allSettled([store.removeProject(first.id),create('job','After delete')]);assert.equal(deleteFirst[0]!.status,'fulfilled');assert.equal(deleteFirst[1]!.status,'rejected');assert.equal(projects.has(first.id),false);
  const createFirst=await Promise.allSettled([create('job','Before delete',{},[],second.id),store.removeProject(second.id)]);assert.equal(createFirst[0]!.status,'fulfilled');assert.equal(createFirst[1]!.status,'rejected');assert.equal(projects.has(second.id),true);assert.equal((await store.workspace({projectId:second.id})).total,1);
});

test('manual pulse defaults, CAS, metrics and reload keep real values separate from methodology',async t=>{
  const {store,db,first,second,projectStore}=setup(t);
  const initial=await store.pulseGet({projectId:first.id});assert.equal(initial.version,0);assert.equal(initial.health,'unknown');assert.equal(initial.scope,'unassigned');assert.equal(initial.updatedAt,null);assert.deepEqual(initial.metrics,[]);
  const metric={id:randomUUID(),label:'Revenue',unit:'RUB',period:'2026-11',plan:100,fact:150,direction:'higher',source:'Manual report'};
  const input={projectId:first.id,expectedVersion:0,scope:'work',objective:'Deliver value',health:'blocked',nextStep:'Resolve dependency',blocker:'Missing contract',metrics:[metric]};
  const saved=await store.pulseUpdate(input);assert.equal(saved.version,1);assert.equal(saved.health,'blocked');assert.equal(saved.metrics[0]!.fact,150);assert.equal(saved.metrics[0]!.updatedAt,saved.updatedAt);assert.equal(saved.objective,'Deliver value');
  const reloaded=new WorkspaceStore(db,projectStore);assert.deepEqual(await reloaded.pulseGet({projectId:first.id}),saved);assert.equal((await store.pulseGet({projectId:second.id})).version,0);
  await assert.rejects(store.pulseUpdate({...input,objective:'Lost update'}),/текущая версия 1/);
  await assert.rejects(store.pulseUpdate({...input,expectedVersion:1,metrics:[{...metric,fact:Infinity}]}));
  await assert.rejects(store.pulseUpdate({...input,expectedVersion:1,metrics:[metric,metric]}),/уникальны/);
  await assert.rejects(store.pulseUpdate({...input,expectedVersion:1,metrics:Array.from({length:11},()=>({...metric,id:randomUUID()}))}));
  assert.deepEqual(await store.pulseGet({projectId:first.id}),saved);
  const {metrics,...withoutMetrics}=input;const preserved=await store.pulseUpdate({...withoutMetrics,expectedVersion:1,objective:'Updated goal'});assert.equal(preserved.version,2);assert.deepEqual(preserved.metrics,saved.metrics);
  const cleared=await store.pulseUpdate({...input,expectedVersion:2,metrics:[],health:'unknown'});assert.equal(cleared.version,3);assert.deepEqual(cleared.metrics,[]);
});

test('portfolio dashboard shows existing cards immediately, pages summaries and filters manual health/scope',async t=>{
  const {store,first,projects,create}=setup(t);
  for(let i=0;i<21;i++){const project={...first,id:randomUUID(),name:'Extra '+i,baseline:'Private baseline omitted'};projects.set(project.id,project);}
  await create('job','One real job');
  const initial=await store.dashboard({});assert.equal(initial.total,23);assert.equal(initial.entries.length,20);assert.equal(initial.summary.projects,23);assert.equal(initial.summary.unknown,23);assert.equal(initial.summary.artifacts,1);assert.ok(initial.entries.every(entry=>!('baseline' in entry.project)));assert.ok(initial.entries.every(entry=>entry.pulse.health==='unknown'&&entry.pulse.updatedAt===null));
  const secondPage=await store.dashboard({offset:20});assert.equal(secondPage.entries.length,3);assert.equal(new Set([...initial.entries,...secondPage.entries].map(entry=>entry.project.id)).size,23);
  await store.pulseUpdate({projectId:first.id,expectedVersion:0,scope:'work',objective:'Objective',health:'at_risk',nextStep:'Next',blocker:'',metrics:[]});
  const filtered=await store.dashboard({scope:'work',health:'at_risk',query:'FIRST'});assert.equal(filtered.total,1);assert.equal(filtered.entries[0]!.project.id,first.id);assert.equal(filtered.entries[0]!.artifactCounts.job,1);assert.equal(filtered.summary.atRisk,1);assert.equal(filtered.summary.onTrack,0);
  assert.equal((await store.dashboard({scope:'personal'})).total,0);await assert.rejects(store.dashboard({limit:21}));
});

test('project deletion cleans separate pulse without disturbing another project',async t=>{
  const {store,db,first,second}=setup(t);await store.pulseUpdate({projectId:first.id,expectedVersion:0,scope:'personal',objective:'Goal',health:'unknown',nextStep:'',blocker:'',metrics:[]});
  await store.removeProject(first.id);assert.deepEqual(db.prepare('SELECT project_id FROM factory_pulses').all(),[]);await assert.rejects(store.pulseGet({projectId:first.id}),/Проект не найден/);assert.equal((await store.pulseGet({projectId:second.id})).version,0);
});

test('append-only artifact history retains original journal fields/links and rejects stale writes without snapshots',async t=>{
  const {store,db,first,second,projectStore,create}=setup(t);
  const job=await create('job','Source');
  const decision=await create('decision','Original basis',{decision:'Original',futureSource:'Keep original source'},[{type:'related',targetId:job.id}]);
  const firstHistory=await store.history({projectId:first.id,id:decision.id});assert.equal(firstHistory.total,1);assert.deepEqual(firstHistory.entries[0],decision);
  const updated=await store.update({projectId:first.id,id:decision.id,expectedVersion:1,title:'New basis',fields:{decision:'Changed'},links:[],status:'accepted'});
  const history=await store.history({projectId:first.id,id:decision.id});assert.equal(history.total,2);assert.deepEqual(history.entries.map(entry=>entry.version),[2,1]);assert.deepEqual(history.entries[0],updated);assert.deepEqual(history.entries[1],decision);assert.equal(history.entries[1]!.fields.futureSource,'Keep original source');assert.deepEqual(history.entries[1]!.links,[{type:'related',targetId:job.id}]);
  await assert.rejects(store.update({projectId:first.id,id:decision.id,expectedVersion:1,title:'Lost update',fields:{},links:[],status:'draft'}),/текущая версия 2/);
  assert.equal((await store.history({projectId:first.id,id:decision.id})).total,2);
  history.entries[1]!.fields.decision='Client mutation';assert.equal((await store.history({projectId:first.id,id:decision.id})).entries[1]!.fields.decision,'Original');
  const reloaded=new WorkspaceStore(db,projectStore);assert.deepEqual((await reloaded.history({projectId:first.id,id:decision.id,limit:1,offset:1})).entries,[decision]);
  await assert.rejects(store.history({projectId:second.id,id:decision.id}),/не найден/);await assert.rejects(store.history({projectId:first.id,id:decision.id,limit:21}));
});

test('legacy current row receives old/new snapshots lazily; explicit project deletion is required to discard history',async t=>{
  const {store,db,first,second,projects,create}=setup(t);
  const legacy=await create('job','Legacy',{situation:'Original source'});
  db.prepare('DELETE FROM factory_artifact_versions WHERE artifact_id=?').run(legacy.id);
  db.prepare('UPDATE factory_artifacts SET version=5 WHERE id=?').run(legacy.id);
  assert.equal((await store.history({projectId:first.id,id:legacy.id})).total,0);
  const saved=await store.update({projectId:first.id,id:legacy.id,expectedVersion:5,title:'Updated legacy',fields:{situation:'New source'},links:[],status:'draft'});
  const history=await store.history({projectId:first.id,id:legacy.id});assert.equal(saved.version,6);assert.deepEqual(history.entries.map(entry=>entry.version),[6,5]);assert.equal(history.entries[1]!.fields.situation,'Original source');
  const disposable=await create('job','Disposable QA',{},[],second.id);await store.remove({projectId:second.id,id:disposable.id,expectedVersion:1});assert.deepEqual((await store.history({projectId:second.id,id:disposable.id})).entries,[disposable]);
  await assert.rejects(store.removeProject(second.id),/discardHistory/);assert.equal(projects.has(second.id),true);
  await store.removeProject(second.id,true);assert.equal(projects.has(second.id),false);assert.deepEqual(db.prepare('SELECT artifact_id FROM factory_artifact_versions WHERE project_id=?').all(second.id),[]);
  assert.equal((await store.history({projectId:first.id,id:legacy.id})).total,2);
});

test('failed KV removal preserves history; cleanup failure leaves recoverable audit after confirmed project deletion',async t=>{
  const fixture=setup(t);const job=await fixture.create('job','History source');await fixture.store.remove({projectId:fixture.first.id,id:job.id,expectedVersion:1});const originalRemove=fixture.projectStore.remove;
  fixture.projectStore.remove=async()=>{throw new Error('KV delete failed');};await assert.rejects(fixture.store.removeProject(fixture.first.id,true),/KV delete failed/);assert.equal(fixture.projects.has(fixture.first.id),true);assert.deepEqual((await fixture.store.history({projectId:fixture.first.id,id:job.id})).entries,[job]);
  await fixture.store.recoverProjectAudit();assert.deepEqual((await fixture.store.history({projectId:fixture.first.id,id:job.id})).entries,[job]);
  fixture.projectStore.remove=originalRemove;fixture.db.exec("CREATE TRIGGER fail_audit_cleanup BEFORE DELETE ON factory_artifact_versions BEGIN SELECT RAISE(FAIL,'cleanup failed'); END;");await assert.rejects(fixture.store.removeProject(fixture.first.id,true),/cleanup failed/);assert.equal(fixture.projects.has(fixture.first.id),false);assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM factory_artifact_versions').get() as {count:number}).count,1);
  fixture.db.exec('DROP TRIGGER fail_audit_cleanup');await fixture.store.recoverProjectAudit();assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM factory_artifact_versions').get() as {count:number}).count,0);assert.equal(fixture.projects.has(fixture.second.id),true);
});
