import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,symlink,rm,realpath,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryStore,hash,type KV } from '../domain';
import { WorkspaceStore } from '../workspace';
import { AnalysisService,type AnalysisSdk,type AnalysisProviderSummary,type AnalysisModelSummary } from '../analysis';

class MemoryKV implements KV {values=new Map<string,unknown>();async get<T>(key:string){return structuredClone(this.values.get(key)) as T|undefined;}async set(key:string,value:unknown){this.values.set(key,structuredClone(value));}async delete(key:string){this.values.delete(key);}}
type ThreadFixture={id:string;projectId:string;status:string;originPluginId?:string;metadata:Record<string,unknown>|null};
function httpError(status:number,message:string,code:string|null='invalid_request'){return Object.assign(new Error(`HTTP ${status}: ${message}`),{name:'BbHttpError',status,code});}
async function setup(t:{after(fn:()=>void|Promise<void>):void}){
  const root=await mkdtemp(join(tmpdir(),'factory-analysis-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const selected=join(root,'selected');await mkdir(selected);const alias=join(root,'alias');await symlink(selected,alias);const canonical=await realpath(selected);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const files=['meeseeks-methodology/SKILL.md','meeseeks-project-init/SKILL.md'].map((path,i)=>({path,content:i?'PINNED_INIT':'PINNED_METHOD',hash:hash(i?'PINNED_INIT':'PINNED_METHOD')}));
  const factory=new FactoryStore(new MemoryKV(),{source:'test',files});await factory.init();
  const project=await factory.create({name:'Selected product',mode:'existing',repository:alias,baseline:'User supplied context'});
  const workspace=new WorkspaceStore(db,factory);
  const calls:{spawn:Parameters<AnalysisSdk['threads']['spawn']>[0][];create:Parameters<AnalysisSdk['projects']['create']>[0][];list:Parameters<AnalysisSdk['threads']['list']>[0][]}={spawn:[],create:[],list:[]};
  let candidates:{id:string;sources:{type:string;hostId:string;path:string}[]}[]=[{id:'bb-selected',sources:[{type:'local_path',hostId:'local-host',path:alias}]}];
  let spawnError:unknown=null;let connected=true;let threadStatus='active';let queuedMessageCount=0;let activeBackgroundAgentCount=0;let hostDirectory:((input:{hostId:string;path:string})=>Promise<{directory:string}>)|null=null;let fileContent='';const reads:{hostId:string;path:string}[]=[];
  let defaultProviderId:string|null=null;
  let projectDefaults:{providerId:string;model:string;permissionMode:string}|null=null;
  let modelLoadError:{code:string;detail:string|null}|null=null;
  let providers:AnalysisProviderSummary[]=[{id:'acp-deepseek',displayName:'DeepSeek Harness',available:true,capabilities:{permissionModes:['accept-edits','full']}}];
  let models:AnalysisModelSummary[]=[{model:'["deepseek-account","deepseek-flash"]',displayName:'DeepSeek-V4.1-Flash',isDefault:false},{model:'["deepseek-official","deepseek-v4-flash"]',displayName:'deepseek-v4-flash',isDefault:true}];
  let selectedOnlyModels:AnalysisModelSummary[]=[];
  let threadFixtures:ThreadFixture[]=[];
  const sdk:AnalysisSdk={system:{async config(){return {primaryHostId:'local-host',generalSettings:{defaultProviderId}};}},hosts:{async list(){return [{id:'local-host',status:connected?'connected':'disconnected',lifecycle:{phase:'active'}}];},async directory(input){if(hostDirectory)return hostDirectory(input);return {directory:await realpath(input.path)};}},projects:{async list(){return candidates;},async create(input){calls.create.push(input);return {id:'bb-created'};},async defaultExecutionOptions(){return projectDefaults;}},providers:{async list(){return providers;},async models(){return {models,selectedOnlyModels,modelLoadError};}},threads:{async spawn(input){calls.spawn.push(input);if(spawnError)throw spawnError;return {id:'thr-analysis'};},async get({threadId}){const fixture=threadFixtures.find(candidate=>candidate.id===threadId);return {id:threadId,projectId:fixture?.projectId??calls.spawn[calls.spawn.length-1]?.projectId??'bb-selected',status:fixture?.status??threadStatus,activeBackgroundAgentCount,queuedMessageCount};},async list(input){calls.list.push(input);return threadFixtures.filter(candidate=>(candidate.originPluginId??'meeseeks-factory')===input.originPluginId).slice(input.offset,input.offset+input.limit).map(({id,projectId,status})=>({id,projectId,status}));},async experimental_listPluginMetadata({threadIds}){return {threads:threadFixtures.filter(candidate=>threadIds.includes(candidate.id)&&candidate.metadata!==null).map(candidate=>({threadId:candidate.id,metadata:candidate.metadata!}))};}},files:{async read(input){reads.push(input);return {content:fileContent,contentEncoding:'utf8',sizeBytes:Buffer.byteLength(fileContent)};}}};
  const service=new AnalysisService(factory,workspace,sdk,'meeseeks-factory');
  const start=()=>service.start({projectId:project.id,requestId:randomUUID()});
  return {root,canonical,alias,db,factory,project,workspace,calls,sdk,service,start,setCandidates:(value:typeof candidates)=>{candidates=value;},setSpawnError:(error:unknown)=>{spawnError=error;},setDisconnected:()=>{connected=false;},setThreadStatus:(status:string)=>{threadStatus=status;},setPendingWork:(queued:number,children:number)=>{queuedMessageCount=queued;activeBackgroundAgentCount=children;},setHostDirectory:(fn:typeof hostDirectory)=>{hostDirectory=fn;},setFileContent:(content:string)=>{fileContent=content;},setDefaultProviderId:(value:string|null)=>{defaultProviderId=value;},setProjectDefaults:(value:typeof projectDefaults)=>{projectDefaults=value;},setProviders:(value:AnalysisProviderSummary[])=>{providers=value;},setModels:(value:AnalysisModelSummary[],selected:AnalysisModelSummary[]=[])=>{models=value;selectedOnlyModels=selected;},setModelLoadError:(value:typeof modelLoadError)=>{modelLoadError=value;},setThreads:(value:ThreadFixture[])=>{threadFixtures=value;},reads};
}

test('analysis picks the project execution default, keeps account Flash, and derives compatible permissions',async t=>{
  const fixture=await setup(t);
  fixture.setProjectDefaults({providerId:'acp-deepseek',model:'["deepseek-account","deepseek-flash"]',permissionMode:'full'});
  const {run}=await fixture.start();
  assert.equal(run.state,'running');
  assert.equal(fixture.calls.spawn.length,1);
  const spawn=fixture.calls.spawn[0]!;
  assert.equal(spawn.permissionMode,'accept-edits');
  assert.equal(spawn.prompt.includes('DeepSeek Harness'),true);
  assert.equal(spawn.prompt.includes('DeepSeek-V4.1-Flash'),true);
  assert.equal(spawn.prompt.includes('permissionMode=accept-edits'),true);
  assert.equal(spawn.prompt.includes('permissionMode=auto'),false);
  assert.equal(run.providerId,'acp-deepseek');
  assert.equal(run.providerName,'DeepSeek Harness');
  assert.equal(run.model,'["deepseek-account","deepseek-flash"]');
  assert.equal(run.modelName,'DeepSeek-V4.1-Flash');
  assert.equal(run.permissionMode,'accept-edits');
  assert.equal(run.attempts.length,1);
  assert.equal(run.attempts[0]!.state,'running');
  assert.equal(run.attempts[0]!.threadId,'thr-analysis');
});

test('analysis respects an explicit user default provider and its catalog default model',async t=>{
  const fixture=await setup(t);
  fixture.setDefaultProviderId('codex');
  fixture.setProviders([{id:'codex',displayName:'Codex',available:true,capabilities:{permissionModes:['accept-edits','auto','full']}},{id:'acp-deepseek',displayName:'DeepSeek Harness',available:true,capabilities:{permissionModes:['accept-edits','full']}}]);
  fixture.setModels([{model:'gpt-6.1',displayName:'GPT-6.1',isDefault:true}]);
  const {run}=await fixture.start();
  const spawn=fixture.calls.spawn[0]!;
  assert.equal(run.state,'running');
  assert.equal(spawn.permissionMode,'auto');
  assert.equal(run.providerId,'codex');
  assert.equal(run.model,'gpt-6.1');
  assert.equal(run.permissionMode,'auto');
  assert.equal(spawn.providerId,run.providerId);
  assert.equal(spawn.model,run.model);
});

test('spawn receives the exact provider/model reported by the run when an official project default falls back to account Flash',async t=>{
  const fixture=await setup(t);
  fixture.setProjectDefaults({providerId:'acp-deepseek',model:'["deepseek-official","deepseek-v4-flash"]',permissionMode:'full'});
  const {run}=await fixture.start();
  const spawn=fixture.calls.spawn[0]!;
  assert.equal(run.state,'running');
  assert.equal(spawn.providerId,'acp-deepseek');
  assert.equal(spawn.model,'["deepseek-account","deepseek-flash"]');
  assert.equal(spawn.providerId,run.providerId);
  assert.equal(spawn.model,run.model);
  assert.equal(run.providerId,'acp-deepseek');
  assert.equal(run.model,'["deepseek-account","deepseek-flash"]');
  assert.equal(run.modelName,'DeepSeek-V4.1-Flash');
  assert.match(spawn.prompt,/DeepSeek-V4.1-Flash/);
});

test('project default account Pro is overridden by the required account Flash and the actual spawn matches',async t=>{
  const fixture=await setup(t);
  fixture.setProjectDefaults({providerId:'acp-deepseek',model:'["deepseek-account","deepseek-v4-pro"]',permissionMode:'full'});
  fixture.setModels([{model:'["deepseek-account","deepseek-v4-pro"]',displayName:'DeepSeek-V4-Pro',isDefault:true},{model:'["deepseek-account","deepseek-flash"]',displayName:'DeepSeek-V4.1-Flash',isDefault:false}]);
  const {run}=await fixture.start();
  const spawn=fixture.calls.spawn[0]!;
  assert.equal(run.state,'running');
  assert.equal(run.model,'["deepseek-account","deepseek-flash"]');
  assert.equal(spawn.model,'["deepseek-account","deepseek-flash"]');
  assert.equal(spawn.providerId,'acp-deepseek');
  assert.equal(spawn.model,run.model);
});

test('analysis keeps the target project execution default provider and model ahead of global fallback',async t=>{
  const fixture=await setup(t);
  fixture.setProviders([{id:'codex',displayName:'Codex',available:true,capabilities:{permissionModes:['accept-edits','auto','full']}},{id:'acp-deepseek',displayName:'DeepSeek Harness',available:true,capabilities:{permissionModes:['accept-edits','full']}}]);
  fixture.setModels([{model:'gpt-6.1',displayName:'GPT-6.1',isDefault:true},{model:'gpt-6-astra',displayName:'GPT-6-Astra',isDefault:false}]);
  fixture.setProjectDefaults({providerId:'codex',model:'gpt-6-astra',permissionMode:'auto'});
  const {run}=await fixture.start();
  assert.equal(run.state,'running');
  assert.equal(run.providerId,'codex');
  assert.equal(run.model,'gpt-6-astra');
  assert.equal(run.permissionMode,'auto');
});

test('analysis falls back to the user DeepSeek preference without selecting the keyless official default',async t=>{
  const fixture=await setup(t);
  fixture.setProviders([{id:'codex',displayName:'Codex',available:true,capabilities:{permissionModes:['accept-edits','auto','full']}},{id:'acp-deepseek',displayName:'DeepSeek Harness',available:true,capabilities:{permissionModes:['accept-edits','full']}}]);
  fixture.setModels([{model:'["deepseek-official","deepseek-v4-flash"]',displayName:'deepseek-v4-flash',isDefault:true},{model:'["deepseek-account","deepseek-flash"]',displayName:'DeepSeek-V4.1-Flash',isDefault:false}]);
  const {run}=await fixture.start();
  const spawn=fixture.calls.spawn[0]!;
  assert.equal(run.state,'running');
  assert.equal(spawn.permissionMode,'accept-edits');
  assert.equal(run.providerId,'acp-deepseek');
  assert.equal(run.model,'["deepseek-account","deepseek-flash"]');
  assert.equal(spawn.providerId,run.providerId);
  assert.equal(spawn.model,run.model);
  assert.equal(run.permissionMode,'accept-edits');
});

test('analysis does not silently choose the keyless official DeepSeek model when account Flash is absent',async t=>{
  const fixture=await setup(t);
  fixture.setModels([{model:'["deepseek-official","deepseek-v4-flash"]',displayName:'deepseek-v4-flash',isDefault:true},{model:'["deepseek-account","deepseek-v4-pro"]',displayName:'DeepSeek-V4-Pro',isDefault:false}]);
  const {run}=await fixture.start();
  assert.equal(run.state,'failed');
  assert.match(run.error!,/нет доступной модели/);
  assert.equal(fixture.calls.spawn.length,0);
});

test('missing provider/model catalog fails before spawn and stays retryable',async t=>{
  const fixture=await setup(t);
  fixture.setModelLoadError({code:'auth_required',detail:'no API key'});
  const {run}=await fixture.start();
  assert.equal(run.state,'failed');
  assert.match(run.error!,/каталог моделей/);
  assert.match(run.error!,/DeepSeek Harness/);
  assert.equal(fixture.calls.spawn.length,0);
  fixture.setModelLoadError(null);
  const next=await fixture.start();
  assert.equal(next.run.state,'running');
  assert.equal(fixture.calls.spawn.length,1);
});

test('confirmed 4xx spawn rejection is failed with cause, records the attempt, and permits a new request',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(httpError(400,'Provider acp-deepseek only supports accept-edits, full permission mode.'));
  const input={projectId:fixture.project.id,requestId:randomUUID()};
  const {run}=await fixture.service.start(input);
  assert.equal(run.state,'failed');
  assert.match(run.error!,/HTTP 400/);
  assert.match(run.error!,/BB отклонил параметры запуска/);
  assert.match(run.error!,/invalid_request/);
  assert.match(run.error!,/DeepSeek Harness/);
  assert.equal(run.threadId,null);
  assert.equal(run.spawnFailure!.confirmed,true);
  assert.equal(run.spawnFailure!.status,400);
  assert.equal(run.attempts.length,1);
  assert.equal(run.attempts[0]!.state,'failed');
  assert.equal(run.attempts[0]!.spawnFailure!.confirmed,true);
  const replay=await fixture.service.start(input);
  assert.equal(replay.run.id,run.id);
  assert.equal(fixture.calls.spawn.length,1);
  fixture.setSpawnError(null);
  const fresh=await fixture.start();
  assert.notEqual(fresh.run.id,run.id);
  assert.equal(fresh.run.state,'running');
  assert.equal(fixture.calls.spawn.length,2);
  assert.equal((await fixture.workspace.analysisRuns({projectId:fixture.project.id})).total,2);
});

test('confirmed spawn errors and attempts never persist bearer, key, or URL credentials',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(Object.assign(new Error('HTTP 400: request failed for Bearer sk-live-SUPERSECRET123 at https://user:pass@example.com/path?token=querysecret&api_key=querykey and api_key=MYKEY token=LEAKED'),{status:400,code:'invalid_request'}));
  const {run}=await fixture.start();
  const serialized=JSON.stringify({error:run.error,spawnFailure:run.spawnFailure,attempts:run.attempts});
  for(const secret of ['SUPERSECRET123','querysecret','querykey','user:pass','MYKEY','LEAKED'])assert.equal(serialized.includes(secret),false);
  assert.match(run.error!,/BB отклонил параметры запуска/);
  assert.doesNotMatch(run.error!,/\[redacted\]/);
});

test('spawn classification trusts typed status rather than HTTP text in the message',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(Object.assign(new Error('HTTP 400: misleading message'),{status:503,code:'server_error'}));
  const {run}=await fixture.start();
  assert.equal(run.state,'unknown');
  assert.equal(run.spawnFailure!.confirmed,false);
  assert.equal(run.spawnFailure!.status,503);
  assert.doesNotMatch(run.error!,/misleading/);
});

test('unknown spawn is blocked, never auto-retried, and recorded without raw transport details',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('Uncertain transport with sensitive details'));
  const input={projectId:fixture.project.id,requestId:randomUUID()};
  const {run}=await fixture.service.start(input);
  assert.equal(run.state,'unknown');
  assert.equal(run.threadId,null);
  assert.equal(run.spawnFailure!.confirmed,false);
  assert.doesNotMatch(run.error!,/sensitive/);
  assert.match(run.error!,/Исход создания треда не подтверждён/);
  assert.equal((await fixture.service.start(input)).run.id,run.id);
  assert.equal((await fixture.start()).run.id,run.id);
  assert.equal(fixture.calls.spawn.length,1);
});

test('unknown is reconciled by plugin attribution and runId; one match attaches without a duplicate',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure after possible admission'));
  const {run}=await fixture.start();
  assert.equal(run.state,'unknown');
  fixture.setThreads([{id:'thr_match',projectId:run.bbProjectId!,status:'active',metadata:{runId:run.id,projectId:fixture.project.id,revisionId:run.revisionId}}]);
  const page=await fixture.service.runs({projectId:fixture.project.id});
  assert.equal(page.entries[0]!.state,'running');
  assert.equal(page.entries[0]!.threadId,'thr_match');
  assert.equal(page.entries[0]!.attempts.at(-1)!.state,'running');
  assert.equal(page.entries[0]!.attempts.at(-1)!.threadId,'thr_match');
  assert.equal(page.entries[0]!.recovery!.operator,'system');
  assert.equal(page.entries[0]!.recovery!.resolution,'attached');
  assert.equal(fixture.calls.list.at(-1)!.includeHidden,true);
  assert.equal(fixture.calls.list.at(-1)!.archived,undefined);
  assert.equal(fixture.calls.spawn.length,1);
  const adopted=await fixture.start();
  assert.equal(adopted.run.id,run.id);
  assert.equal(fixture.calls.spawn.length,1);
});

test('reconciliation pages past the first 1000 threads and attaches the matching run',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const fixtures:ThreadFixture[]=[];
  for(let index=0;index<1_000;index++)fixtures.push({id:'thr_filler_'+index,projectId:run.bbProjectId!,status:'idle',metadata:null});
  fixtures.push({id:'thr_late_match',projectId:run.bbProjectId!,status:'active',metadata:{runId:run.id,projectId:fixture.project.id,revisionId:run.revisionId}});
  fixture.setThreads(fixtures);
  const page=await fixture.service.runs({projectId:fixture.project.id});
  assert.equal(page.entries[0]!.state,'running');
  assert.equal(page.entries[0]!.threadId,'thr_late_match');
  assert.ok(fixture.calls.list.length>=11);
  assert.equal(fixture.calls.list[0]!.originPluginId,'meeseeks-factory');
  assert.equal(fixture.calls.list[0]!.includeHidden,true);
});

test('truncated reconciliation fails closed instead of treating absence as proof',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const fixtures:ThreadFixture[]=[];
  for(let index=0;index<2_101;index++)fixtures.push({id:'thr_bulk_'+index,projectId:run.bbProjectId!,status:'idle',metadata:null});
  fixture.setThreads(fixtures);
  const page=await fixture.service.runs({projectId:fixture.project.id});
  assert.equal(page.entries[0]!.state,'unknown');
  assert.equal(page.entries[0]!.threadId,null);
  assert.match(page.entries[0]!.error!,/Сверка тредов неполна/);
});

test('ambiguous or absent plugin attribution keeps unknown and does not attach or duplicate',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  assert.equal(run.threadId,null);
  const noMatch=await fixture.service.runs({projectId:fixture.project.id});
  assert.equal(noMatch.entries[0]!.state,'unknown');
  assert.match(noMatch.entries[0]!.error!,/подтверждённого отказа/);
  const other=await setup(t);
  other.setSpawnError(new Error('network failure'));
  const second=await other.start();
  other.setThreads([{id:'thr_wrong_project',projectId:'bb-other',status:'active',metadata:{runId:second.run.id,projectId:other.project.id,revisionId:second.run.revisionId}}]);
  const wrongProject=await other.service.runs({projectId:other.project.id});
  assert.equal(wrongProject.entries[0]!.state,'unknown');
  assert.equal(wrongProject.entries[0]!.threadId,null);
  other.setThreads([{id:'thr_other_run',projectId:second.run.bbProjectId!,status:'active',metadata:{runId:randomUUID(),projectId:other.project.id,revisionId:second.run.revisionId}}]);
  const unrelated=await other.service.runs({projectId:other.project.id});
  assert.equal(unrelated.entries[0]!.state,'unknown');
  assert.equal(unrelated.entries[0]!.threadId,null);
  other.setThreads([
    {id:'thr_one',projectId:second.run.bbProjectId!,status:'active',metadata:{runId:second.run.id,projectId:other.project.id,revisionId:second.run.revisionId}},
    {id:'thr_two',projectId:second.run.bbProjectId!,status:'active',metadata:{runId:second.run.id,projectId:other.project.id,revisionId:second.run.revisionId}},
  ]);
  const ambiguous=await other.service.runs({projectId:other.project.id});
  assert.equal(ambiguous.entries[0]!.state,'unknown');
  assert.equal(ambiguous.entries[0]!.threadId,null);
  assert.match(ambiguous.entries[0]!.error!,/несколько тредов/i);
  assert.equal(other.calls.spawn.length,1);
  const adopted=await other.start();
  assert.equal(adopted.run.id,second.run.id);
  assert.equal(other.calls.spawn.length,1);
});

test('stored confirmed refusal with zero matching threads reconciles to failed and allows a retry',async t=>{
  const fixture=await setup(t);
  const requestId=randomUUID();
  const reserved=await fixture.workspace.analysisReserve({projectId:fixture.project.id,requestId,revisionId:fixture.project.revision,sourcePath:fixture.canonical,instructionsHash:'hash',contextHash:'hash',snapshot:{files:[],context:{name:'Name',mode:'new',repository:fixture.canonical,baseline:''}}});
  await fixture.workspace.analysisPatch(reserved.run.id,{state:'unknown',hostId:'local-host',bbProjectId:'bb-selected',error:'legacy unknown',spawnFailure:{confirmed:true,status:400,code:'invalid_request',message:'Provider acp-deepseek only supports accept-edits, full permission mode.',at:new Date().toISOString()}});
  const fresh=await fixture.service.start({projectId:fixture.project.id,requestId:randomUUID()});
  assert.notEqual(fresh.run.id,reserved.run.id);
  assert.equal(fresh.run.state,'running');
  assert.equal(fixture.calls.spawn.length,1);
  const old=await fixture.workspace.analysisGet(fixture.project.id,reserved.run.id);
  assert.equal(old.state,'failed');
  assert.match(old.error!,/подтверждённое отклонение/);
  const sameRequest=await fixture.service.start({projectId:fixture.project.id,requestId});
  assert.equal(sameRequest.run.state,'failed');
});

test('operator recovery attaches only an owned matching thread and rejects arbitrary failure',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const restarted=new AnalysisService(fixture.factory,fixture.workspace,fixture.sdk,'meeseeks-factory');
  const base={projectId:fixture.project.id,runId:run.id,operator:'evgeny',reason:'checked traces',evidence:'deterministic 4xx reproduction'};
  fixture.setThreads([{id:'thr_match',projectId:run.bbProjectId!,status:'active',metadata:{runId:run.id,projectId:fixture.project.id,revisionId:run.revisionId}}]);
  await assert.rejects(restarted.recover({...base,outcome:'attach',threadId:'thr_unknown'}),/не имеет подтверждённой атрибуции/);
  await assert.rejects(restarted.recover({...base,outcome:'failed',confirmedFailure:{status:400,code:'invalid_request',message:'Provider acp-deepseek only supports accept-edits, full permission mode.'}}),/Найдены треды/);
  assert.equal((await fixture.workspace.analysisGet(fixture.project.id,run.id)).state,'unknown');
  const attached=await restarted.recover({...base,outcome:'attach',threadId:'thr_match'});
  assert.equal(attached.run.state,'running');
  assert.equal(attached.run.threadId,'thr_match');
  assert.equal(attached.run.recovery!.operator,'evgeny');
  assert.deepEqual(attached.run.recovery!.threadIds,['thr_match']);
  assert.equal(fixture.calls.spawn.length,1);
});

test('operator recovery closes an old unknown by reconciliation without claiming a proven 400',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const restarted=new AnalysisService(fixture.factory,fixture.workspace,fixture.sdk,'meeseeks-factory');
  const base={projectId:fixture.project.id,runId:run.id,operator:'evgeny',reason:'checked traces',evidence:'server restarted; no active thread with plugin metadata runId',verifiedServerRestartAt:new Date(Date.parse(run.createdAt)+1000).toISOString()};
  const failed=await restarted.recover({...base,outcome:'failed'});
  assert.equal(failed.run.state,'failed');
  assert.equal(failed.run.threadId,null);
  assert.match(failed.run.error!,/Старый исход не установлен/);
  assert.doesNotMatch(failed.run.error!,/подтверждённое отклонение/);
  assert.equal(failed.run.spawnFailure!.confirmed,false);
  assert.equal(failed.run.spawnFailure!.code,'operator_reconciled_absent');
  assert.equal(failed.run.recovery!.resolution,'reconciled_absent');
  assert.equal(failed.run.recovery!.operator,'evgeny');
  assert.equal(fixture.calls.spawn.length,1);
  fixture.setSpawnError(null);
  const fresh=await fixture.start();
  assert.equal(fresh.run.state,'running');
  assert.equal(fixture.calls.spawn.length,2);
});

test('operator recovery records a supplied structured 4xx as a confirmed refusal',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const restarted=new AnalysisService(fixture.factory,fixture.workspace,fixture.sdk,'meeseeks-factory');
  const base={projectId:fixture.project.id,runId:run.id,operator:'evgeny',reason:'checked traces',evidence:'deterministic 4xx reproduction'};
  await assert.rejects(restarted.recover({...base,outcome:'failed',confirmedFailure:{status:200,code:'ok',message:'not a rejection'}}));
  const failed=await restarted.recover({...base,outcome:'failed',confirmedFailure:{status:400,code:'invalid_request',message:'Provider acp-deepseek only supports accept-edits, full permission mode.'}});
  assert.equal(failed.run.state,'failed');
  assert.equal(failed.run.spawnFailure!.confirmed,true);
  assert.equal(failed.run.spawnFailure!.status,400);
  assert.equal(failed.run.recovery!.resolution,'confirmed_refusal');
  assert.match(failed.run.error!,/подтверждённое отклонение/);
});

test('recovery treats 408 and 429 as transient rather than confirmed refusals',async t=>{
  for(const status of [408,429]){
    const fixture=await setup(t);
    fixture.setSpawnError(new Error('network failure'));
    const {run}=await fixture.start();
    const base={projectId:fixture.project.id,runId:run.id,operator:'evgeny',outcome:'failed',reason:'checked',evidence:'checked'};
    await assert.rejects(fixture.service.recover({...base,confirmedFailure:{status,code:'transient',message:'retry later'}}),/408\/429/);
    assert.equal((await fixture.workspace.analysisGet(fixture.project.id,run.id)).state,'unknown');
  }
});

test('recovery audit fields and confirmedFailure text never persist secrets',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const failed=await fixture.service.recover({projectId:fixture.project.id,runId:run.id,operator:'evgeny',outcome:'failed',reason:'token=REASONLEAK',evidence:'https://user:pass@example.com/evidence?api_key=EVIDENCEKEY',confirmedFailure:{status:400,code:'invalid_request',message:'Bearer sk-live-RECOVERYLEAK'}});
  const serialized=JSON.stringify({error:failed.run.error,spawnFailure:failed.run.spawnFailure,recovery:failed.run.recovery});
  for(const secret of ['REASONLEAK','user:pass','EVIDENCEKEY','RECOVERYLEAK'])assert.equal(serialized.includes(secret),false);
  assert.match(failed.run.recovery!.reason,/\[redacted\]/);
  assert.match(failed.run.recovery!.evidence,/\[redacted\]/);
});

test('legacy absence closure requires a verified server restart later than the attempt, not a plugin reload',async t=>{
  const fixture=await setup(t);
  fixture.setSpawnError(new Error('network failure'));
  const {run}=await fixture.start();
  const base={projectId:fixture.project.id,runId:run.id,operator:'evgeny',outcome:'failed',reason:'checked',evidence:'server restart verified'};
  await assert.rejects(fixture.service.recover(base),/server restart/);
  await assert.rejects(fixture.service.recover({...base,verifiedServerRestartAt:new Date(Date.parse(run.createdAt)-1000).toISOString()}),/не позже создания/);
  const closed=await fixture.service.recover({...base,verifiedServerRestartAt:new Date(Date.parse(run.createdAt)+1000).toISOString()});
  assert.equal(closed.run.state,'failed');
  assert.equal(closed.run.recovery!.resolution,'reconciled_absent');
  assert.notEqual(closed.run.recovery!.serverRestartAt,null);
});

test('analysis maps exact host/canonical checkout, pins full instruction bytes, and concurrent request replay spawns once',async t=>{
  const {factory,project,canonical,service,calls,workspace}=await setup(t);
  await factory.edit({expectedRevision:project.revision,path:'meeseeks-methodology/SKILL.md',content:'NEW_LATEST_METHOD'});
  const input={projectId:project.id,requestId:randomUUID()};const results=await Promise.all([service.start(input),service.start(input)]);
  assert.equal(results[0]!.run.id,results[1]!.run.id);assert.equal(calls.spawn.length,1);assert.equal(calls.create.length,0);
  const spawn=calls.spawn[0]!;assert.equal(spawn.projectId,'bb-selected');assert.deepEqual(spawn.environment,{type:'host',hostId:'local-host',workspace:{type:'unmanaged',path:canonical}});assert.equal(spawn.permissionMode,'accept-edits');assert.equal(spawn.pluginMetadata.projectId,project.id);assert.equal(spawn.pluginMetadata.revisionId,project.revision);assert.match(spawn.prompt,/PINNED_METHOD/);assert.match(spawn.prompt,/PINNED_INIT/);assert.doesNotMatch(spawn.prompt,/NEW_LATEST_METHOD/);assert.match(spawn.prompt,/analysis complete --file/);
  const replay=await service.start(input);assert.equal(replay.run.state,'running');assert.equal(replay.run.threadId,'thr-analysis');assert.equal((await workspace.analysisRuns({projectId:project.id})).total,1);assert.equal((await service.start({projectId:project.id,requestId:randomUUID()})).run.id,replay.run.id);
});

test('analysis creates BB project only when exact source absent and refuses ambiguous source or disconnected primary',async t=>{
  const fixture=await setup(t);fixture.setCandidates([]);const created=await fixture.start();assert.equal(created.run.state,'running');assert.deepEqual(fixture.calls.create,[{name:fixture.project.name,source:{type:'local_path',hostId:'local-host',path:fixture.canonical}}]);assert.equal(fixture.calls.spawn[0]!.projectId,'bb-created');
  const ambiguous=await setup(t);ambiguous.setCandidates(['a','b'].map(id=>({id,sources:[{type:'local_path',hostId:'local-host',path:ambiguous.canonical}]})));const failed=await ambiguous.start();assert.equal(failed.run.state,'failed');assert.match(failed.run.error!,/Несколько проектов/);assert.equal(ambiguous.calls.spawn.length,0);
  const disconnected=await setup(t);disconnected.setDisconnected();const missingHost=await disconnected.start();assert.equal(missingHost.run.state,'failed');assert.match(missingHost.run.error!,/Основная машина/);assert.equal(disconnected.calls.spawn.length,0);
});

test('remote URL fails with persisted reason, uncertain spawn never auto-retries, pending recovery becomes unknown',async t=>{
  const fixture=await setup(t);const changed=await fixture.factory.update({id:fixture.project.id,expectedUpdatedAt:fixture.project.updatedAt,revision:fixture.project.revision,adoption:fixture.project.adoption,repository:'https://git.example/product.git'});const failed=await fixture.start();assert.equal(failed.run.state,'failed');assert.match(failed.run.error!,/локальный абсолютный путь/);assert.equal(fixture.calls.spawn.length,0);assert.equal((await fixture.workspace.analysisRuns({projectId:changed.id})).total,1);
  const uncertain=await setup(t);uncertain.setSpawnError(new Error('Uncertain transport with sensitive details'));const input={projectId:uncertain.project.id,requestId:randomUUID()};const result=await uncertain.service.start(input);assert.equal(result.run.state,'unknown');assert.doesNotMatch(result.run.error!,/sensitive/);await uncertain.service.start(input);assert.equal(uncertain.calls.spawn.length,1);assert.equal((await uncertain.start()).run.id,result.run.id);
  const recover=await setup(t);const requestId=randomUUID();await recover.workspace.analysisReserve({projectId:recover.project.id,requestId,revisionId:recover.project.revision,sourcePath:recover.canonical,instructionsHash:'hash',contextHash:'hash',snapshot:{files:[],context:{name:'Name',mode:'new',repository:recover.canonical,baseline:''}}});await recover.workspace.analysisRecover();assert.equal((await recover.service.start({projectId:recover.project.id,requestId})).run.state,'unknown');assert.equal(recover.calls.spawn.length,0);
});

function batchFor(run:{id:string;projectId:string;revisionId:string}){const provenance=[{sourceType:'file',locator:'README.md',quoteOrLine:'lines 1–4',observedAt:new Date().toISOString()}];return {runId:run.id,projectId:run.projectId,revisionId:run.revisionId,items:[{externalKey:'initiative',kind:'initiative',title:'Sourced initiative',fields:{approach:'Verified approach'},links:[{type:'solves_job',targetKey:'job'}],provenance},{externalKey:'job',kind:'job',title:'Sourced job',fields:{situation:'Verified source'},links:[],provenance}]};}

test('completion imports source-backed drafts/forward links transactionally, preserves history and replays same IDs',async t=>{
  const {start,workspace,db,project}=await setup(t);const {run}=await start();const batch=batchFor(run);const caller={threadId:run.threadId!,projectId:run.bbProjectId!};
  const result=await workspace.analysisComplete(batch,caller);assert.equal(result.run.state,'ready');assert.equal(result.artifactIds.length,2);
  const list=await workspace.workspace({projectId:project.id});assert.equal(list.total,2);assert.ok(list.entries.every(entry=>entry.status==='draft'&&entry.version===1&&entry.fields.analysisRunId===run.id));const initiative=list.entries.find(entry=>entry.kind==='initiative')!;const job=list.entries.find(entry=>entry.kind==='job')!;assert.deepEqual(initiative.links,[{type:'solves_job',targetId:job.id}]);assert.match(job.fields.analysisProvenance!,/README.md/);assert.equal((await workspace.history({projectId:project.id,id:job.id})).total,1);
  assert.deepEqual((await workspace.analysisComplete(batch,caller)).artifactIds,result.artifactIds);assert.equal((await workspace.workspace({projectId:project.id})).total,2);assert.equal((db.prepare('SELECT COUNT(*) AS count FROM factory_artifact_versions').get() as {count:number}).count,2);
  await assert.rejects(workspace.analysisComplete({...batch,items:batch.items.map((item,i)=>i?item:{...item,title:'Changed retry'})},caller),/другие данные/);await assert.rejects(workspace.analysisComplete(batch,{threadId:'other',projectId:caller.projectId}),/только агентскому/);assert.equal((await workspace.workspace({projectId:project.id})).total,2);
});

test('completion rollback retains run and existing records; bad provenance/status/project/version are rejected',async t=>{
  const {start,workspace,project,db,factory}=await setup(t);const passport=await workspace.create({projectId:project.id,kind:'passport',title:'Existing user passport',fields:{result:'Keep this'},links:[]});const {run}=await start();const caller={threadId:run.threadId!,projectId:run.bbProjectId!};const batch=batchFor(run);
  await assert.rejects(workspace.analysisComplete({...batch,items:[batch.items[1]!,{...batch.items[0]!,kind:'passport',links:[]}]},caller),/уже есть/);assert.equal((await workspace.workspace({projectId:project.id})).total,1);assert.deepEqual(await workspace.get({projectId:project.id,id:passport.id}),passport);assert.equal((db.prepare('SELECT COUNT(*) AS count FROM factory_draft_imports').get() as {count:number}).count,0);assert.equal((await workspace.analysisRuns({projectId:project.id})).entries[0]!.state,'running');
  await assert.rejects(workspace.analysisComplete({...batch,items:[{...batch.items[1]!,provenance:[]}]},caller));await assert.rejects(workspace.analysisComplete({...batch,items:[{...batch.items[1]!,status:'accepted'}]},caller));await assert.rejects(workspace.analysisComplete({...batch,revisionId:'wrong'},caller),/версия/);
  const other=await factory.create({name:'Other',mode:'new',repository:'',baseline:''});await assert.rejects(workspace.analysisComplete({...batch,projectId:other.id},caller),/Проект/);
  const imported=await workspace.analysisComplete(batch,caller);assert.equal(imported.run.state,'ready');assert.equal((await workspace.workspace({projectId:project.id})).total,3);assert.deepEqual(await workspace.get({projectId:project.id,id:passport.id}),passport);
});

test('idle analysis needs attention, adopts active run across requests, closes only after SDK confirms inactivity',async t=>{
  const fixture=await setup(t);const {run}=await fixture.start();
  await assert.rejects(fixture.service.close({projectId:fixture.project.id,runId:run.id}),/ещё работает/);
  fixture.setThreadStatus('idle');const page=await fixture.service.runs({projectId:fixture.project.id});assert.equal(page.entries[0]!.state,'needs_attention');assert.match(page.entries[0]!.error!,/без импорта/);assert.deepEqual(page.entries[0]!.importedArtifactIds,[]);
  const otherRequest=randomUUID();const adopted=await fixture.service.start({projectId:fixture.project.id,requestId:otherRequest});assert.equal(adopted.run.id,run.id);assert.equal(fixture.calls.spawn.length,1);
  const lookup=await fixture.service.lookup({projectId:fixture.project.id,requestId:otherRequest});assert.equal(lookup.run!.id,run.id);assert.equal(lookup.activeRun!.id,run.id);
  await assert.rejects(fixture.workspace.removeProject(fixture.project.id,true),/активный анализ/);
  const closed=await fixture.service.close({projectId:fixture.project.id,runId:run.id});assert.equal(closed.run.state,'closed');const restart=await fixture.start();assert.notEqual(restart.run.id,run.id);assert.equal(fixture.calls.spawn.length,2);
});

test('thread errors become failed, resumed threads block new spawn, and needs-attention threads can deliver drafts',async t=>{
  const fixture=await setup(t);const {run}=await fixture.start();fixture.setThreadStatus('error');assert.equal((await fixture.service.runs({projectId:fixture.project.id})).entries[0]!.state,'failed');
  fixture.setThreadStatus('active');assert.equal((await fixture.start()).run.id,run.id);assert.equal(fixture.calls.spawn.length,1);
  fixture.setThreadStatus('idle');assert.equal((await fixture.service.runs({projectId:fixture.project.id})).entries[0]!.state,'needs_attention');
  const result=await fixture.workspace.analysisComplete(batchFor(run),{threadId:run.threadId!,projectId:run.bbProjectId!});assert.equal(result.run.state,'ready');await fixture.service.observeThread(run.threadId!);assert.equal((await fixture.workspace.analysisRuns({projectId:fixture.project.id})).entries[0]!.state,'ready');
  const empty=await setup(t);assert.deepEqual(await empty.service.lookup({projectId:empty.project.id,requestId:randomUUID()}),{run:null,activeRun:null});
});

test('checkout and completion file use selected host SDK, even when the same server path is missing or different',async t=>{
  const fixture=await setup(t);await fixture.factory.update({id:fixture.project.id,expectedUpdatedAt:fixture.project.updatedAt,revision:fixture.project.revision,adoption:fixture.project.adoption,repository:'/host-only/checkout'});
  const directoryCalls:{hostId:string;path:string}[]=[];fixture.setHostDirectory(async input=>{directoryCalls.push(input);if(input.path==='/host-only/checkout')return {directory:'/host-canonical/checkout'};throw new Error('Not available on selected host');});fixture.setCandidates([]);
  const {run}=await fixture.start();assert.equal(run.state,'running');assert.equal(run.sourcePath,'/host-canonical/checkout');assert.deepEqual(fixture.calls.spawn[0]!.environment,{type:'host',hostId:'local-host',workspace:{type:'unmanaged',path:'/host-canonical/checkout'}});assert.ok(directoryCalls.every(call=>call.hostId==='local-host'));
  const path=join(fixture.root,'result.json');await writeFile(path,'Wrong file on SERVER');fixture.setFileContent(JSON.stringify(batchFor(run)));
  const imported=await fixture.service.completeFile(path,{threadId:run.threadId!,projectId:run.bbProjectId!});assert.equal(imported.run.state,'ready');assert.deepEqual(fixture.reads,[{hostId:run.hostId,path}]);
});

test('all active analysis states block project removal; closed runs require explicit audit deletion',async t=>{
  const fixture=await setup(t);const requestId=randomUUID();const {run}=await fixture.workspace.analysisReserve({projectId:fixture.project.id,requestId,revisionId:fixture.project.revision,sourcePath:fixture.canonical,instructionsHash:'hash',contextHash:'hash',snapshot:{files:[],context:{name:'Name',mode:'new',repository:fixture.canonical,baseline:''}}});
  for(const state of ['pending','running','unknown','needs_attention'] as const){await fixture.workspace.analysisPatch(run.id,{state});await assert.rejects(fixture.workspace.removeProject(fixture.project.id,true),/активный анализ/);}
  await fixture.workspace.analysisPatch(run.id,{state:'closed'});await assert.rejects(fixture.workspace.removeProject(fixture.project.id),/discardHistory/);await fixture.workspace.removeProject(fixture.project.id,true);await assert.rejects(fixture.factory.get(fixture.project.id),/не найден/);
});

test('native thread context is scoped to stored thread ID and omits baseline/hidden metrics',async t=>{
  const fixture=await setup(t);const {run}=await fixture.start();await fixture.workspace.pulseUpdate({projectId:fixture.project.id,expectedVersion:0,scope:'work',objective:'Goal',health:'unknown',nextStep:'Next',blocker:'',metrics:[]});
  fixture.setThreadStatus('idle');const context=await fixture.service.context({threadId:run.threadId!});assert.equal(context.context!.run.state,'needs_attention');assert.equal(context.context!.project.id,fixture.project.id);assert.equal(context.context!.run.id,run.id);assert.equal(context.context!.pulse.objective,'Goal');assert.ok(!('baseline' in context.context!.project));assert.ok(!('metrics' in context.context!.pulse));assert.deepEqual(await fixture.workspace.threadContext({threadId:'thr_foreign'}),{context:null});
});

test('idle thread with queued messages or active child agents cannot be closed or duplicated',async t=>{
  const fixture=await setup(t);const {run}=await fixture.start();fixture.setThreadStatus('idle');
  for(const [queued,children] of [[1,0],[0,1]]){fixture.setPendingWork(queued!,children!);assert.equal((await fixture.service.runs({projectId:fixture.project.id})).entries[0]!.state,'running');await assert.rejects(fixture.service.close({projectId:fixture.project.id,runId:run.id}),/ещё работает/);assert.equal((await fixture.start()).run.id,run.id);}
  assert.equal(fixture.calls.spawn.length,1);fixture.setPendingWork(0,0);assert.equal((await fixture.service.close({projectId:fixture.project.id,runId:run.id})).run.state,'closed');
});

test('same request retry can finish before delayed original admission without creating a second agent',async t=>{
  const fixture=await setup(t);const get=fixture.factory.get.bind(fixture.factory);let first=true;let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const waiting=new Promise<void>(resolve=>{entered=resolve;});
  fixture.factory.get=async id=>{if(first){first=false;entered();await gate;}return get(id);};
  const request={projectId:fixture.project.id,requestId:randomUUID()};const delayed=fixture.service.start(request);await waiting;
  const retryService=new AnalysisService(fixture.factory,fixture.workspace,fixture.sdk,'meeseeks-factory');
  assert.deepEqual(await retryService.lookup(request),{run:null,activeRun:null});
  try{
    const retried=await retryService.start(request);const imported=await fixture.workspace.analysisComplete(batchFor(retried.run),{threadId:retried.run.threadId!,projectId:retried.run.bbProjectId!});assert.equal(imported.run.state,'ready');
    release();const original=await delayed;assert.equal(original.run.id,retried.run.id);assert.equal(original.run.state,'ready');assert.deepEqual(original.run.importedArtifactIds,imported.artifactIds);assert.equal(fixture.calls.spawn.length,1);assert.equal((await fixture.workspace.analysisRuns({projectId:fixture.project.id})).total,1);
  }finally{release();await delayed;}
});

test('durable request intent precedes pinned-file preparation and same-process retry shares admission',async t=>{
  const fixture=await setup(t);const read=fixture.factory.file.bind(fixture.factory);let first=true;let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const waiting=new Promise<void>(resolve=>{entered=resolve;});
  fixture.factory.file=async(revision,path)=>{if(first){first=false;entered();await gate;}return read(revision,path);};
  const input={projectId:fixture.project.id,requestId:randomUUID()};const original=fixture.service.start(input);await waiting;
  try{assert.strictEqual(fixture.service.start(input),original);const records=await fixture.workspace.analysisRuns({projectId:fixture.project.id});assert.equal(records.total,1);assert.equal(records.entries[0]!.requestId,input.requestId);assert.equal(records.entries[0]!.state,'pending');assert.equal(fixture.calls.spawn.length,0);release();assert.equal((await original).run.state,'running');assert.equal(fixture.calls.spawn.length,1);}
  finally{release();await original;}
});

test('lookup adoption durably aliases delayed request to active run even after that run completes',async t=>{
  const fixture=await setup(t);const first=await fixture.start();const get=fixture.factory.get.bind(fixture.factory);let blocked=true;let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const waiting=new Promise<void>(resolve=>{entered=resolve;});
  fixture.factory.get=async id=>{if(blocked){blocked=false;entered();await gate;}return get(id);};
  const request={projectId:fixture.project.id,requestId:randomUUID()};const delayed=fixture.service.start(request);await waiting;
  try{
    const lookupService=new AnalysisService(fixture.factory,fixture.workspace,fixture.sdk,'meeseeks-factory');const lookup=await lookupService.lookup(request);assert.equal(lookup.run!.id,first.run.id);assert.equal(lookup.activeRun!.id,first.run.id);
    const reservedRequest=randomUUID();const adopted=await fixture.workspace.analysisReserve({projectId:fixture.project.id,requestId:reservedRequest,revisionId:fixture.project.revision,sourcePath:fixture.canonical,instructionsHash:'unused',contextHash:'unused',snapshot:{files:[],context:{name:'Name',mode:'existing',repository:fixture.canonical,baseline:''}}});assert.equal(adopted.created,false);assert.equal(adopted.run.id,first.run.id);
    const complete=await fixture.workspace.analysisComplete(batchFor(first.run),{threadId:first.run.threadId!,projectId:first.run.bbProjectId!});assert.equal(complete.run.state,'ready');release();const original=await delayed;assert.equal(original.run.id,first.run.id);assert.equal(original.run.state,'ready');assert.deepEqual(original.run.importedArtifactIds,complete.artifactIds);assert.equal(fixture.calls.spawn.length,1);
    const reloaded=new WorkspaceStore(fixture.db,fixture.factory);await reloaded.analysisRecover();assert.equal((await reloaded.analysisFind(request.projectId,request.requestId))!.id,first.run.id);assert.equal((await reloaded.analysisFind(request.projectId,reservedRequest))!.state,'ready');const checked=await new AnalysisService(fixture.factory,reloaded,fixture.sdk,'meeseeks-factory').lookup(request);assert.equal(checked.run!.id,first.run.id);assert.equal(checked.activeRun,null);
    const artifacts=await Promise.all(complete.artifactIds.map(id=>reloaded.get({projectId:fixture.project.id,id})));const initiative=artifacts.find(artifact=>artifact.kind==='initiative');const job=artifacts.find(artifact=>artifact.kind==='job');assert.ok(initiative);assert.ok(job);await reloaded.remove({projectId:fixture.project.id,id:initiative.id,expectedVersion:initiative.version});await reloaded.remove({projectId:fixture.project.id,id:job.id,expectedVersion:job.version});
    await reloaded.removeProject(fixture.project.id,true);assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM factory_analysis_request_aliases').get() as {count:number}).count,0);
  }finally{release();await delayed;}
});
