import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analysisRunSchema,analysisRunsInput,analysisCompleteInput,type AnalysisRun,type AnalysisSnapshot,type AnalysisExecution,type AnalysisAttempt,type AnalysisSpawnFailure,type AnalysisRecovery } from './analysis-contract';
import { projectSchema, type Project } from './domain';

export const artifactKinds = ['passport','sphere','external_context','audience','job','offer','initiative','role','story','adr','contract','task','role_right','subtask','slice','testcase','spec','implementation','review','decision','fork','question','principle'] as const;
export const artifactKindSchema = z.enum(artifactKinds);
export type {AnalysisRun} from './analysis-contract';
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
const uuid = z.string().uuid();
const fieldsSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),z.string().max(30_000)).refine(fields=>Object.keys(fields).length<=100,'Не более 100 полей.');
const linksSchema = z.array(z.object({type:z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),targetId:uuid}).strict()).max(100);
const artifactBase = {
  title:z.string().trim().min(1).max(200),fields:fieldsSchema,links:linksSchema,
};
export const artifactSchema = z.object({
  id:uuid,projectId:uuid,kind:z.string().min(1).max(80),...artifactBase,
  status:z.enum(['draft','accepted']),version:z.number().int().min(1),createdAt:z.string(),updatedAt:z.string(),
});
export type Artifact = z.infer<typeof artifactSchema>;
export const artifactCreateInput = z.object({projectId:uuid,kind:artifactKindSchema,...artifactBase}).strict();
export const artifactUpdateInput = z.object({projectId:uuid,id:uuid,expectedVersion:z.number().int().min(1),...artifactBase,status:z.enum(['draft','accepted'])}).strict();
export const artifactIdInput = z.object({projectId:uuid,id:uuid}).strict();
export const artifactHistoryInput=artifactIdInput.extend({limit:z.number().int().min(1).max(20).default(20),offset:z.number().int().min(0).max(1_000_000).default(0)}).strict();
export const artifactHistorySchema=z.object({entries:z.array(artifactSchema),total:z.number(),limit:z.number(),offset:z.number()});
export const artifactRemoveInput = artifactIdInput.extend({expectedVersion:z.number().int().min(1)}).strict();
export const workspaceInput = z.object({projectId:uuid,kind:z.string().min(1).max(80).optional(),limit:z.number().int().min(1).max(20).default(20),offset:z.number().int().min(0).max(500).default(0)}).strict();
export const targetsInput = z.object({projectId:uuid,kind:z.string().min(1).max(80).optional(),query:z.string().trim().max(200).default(''),limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).max(500).default(0)}).strict();
export const workspaceSchema = z.object({project:projectSchema,entries:z.array(artifactSchema),counts:z.record(z.string(),z.number()),total:z.number(),limit:z.number(),offset:z.number(),pinnedRevision:z.string(),warnings:z.array(z.string())});
export const targetsSchema = z.object({entries:z.array(artifactSchema.pick({id:true,kind:true,title:true,status:true,version:true})),total:z.number(),limit:z.number(),offset:z.number()});

export const metricInputSchema=z.object({id:uuid,label:z.string().trim().min(1).max(120),unit:z.string().max(30),period:z.string().max(100),plan:z.number().finite().nullable(),fact:z.number().finite().nullable(),direction:z.enum(['higher','lower']),source:z.string().max(1000)}).strict();
export const metricSchema=metricInputSchema.extend({updatedAt:z.string()});
export type Metric=z.infer<typeof metricSchema>;
const pulseFields={scope:z.enum(['personal','work','unassigned']),objective:z.string().max(5000),health:z.enum(['unknown','on_track','at_risk','blocked']),nextStep:z.string().max(5000),blocker:z.string().max(5000)};
export const pulseSchema=z.object({projectId:uuid,...pulseFields,metrics:z.array(metricSchema).max(10),version:z.number().int().min(0),updatedAt:z.string().nullable()});
export type Pulse=z.infer<typeof pulseSchema>;
export const pulseUpdateInput=z.object({projectId:uuid,expectedVersion:z.number().int().min(0),...pulseFields,metrics:z.array(metricInputSchema).max(10).optional()}).strict();
export const pulseGetInput=z.object({projectId:uuid}).strict();
export const dashboardInput=z.object({query:z.string().trim().max(200).default(''),scope:z.enum(['all','personal','work','unassigned']).default('all'),health:z.enum(['all','unknown','on_track','at_risk','blocked']).default('all'),limit:z.number().int().min(1).max(20).default(20),offset:z.number().int().min(0).max(500).default(0)}).strict();
export const projectSummarySchema=projectSchema.omit({baseline:true});
export const dashboardSchema=z.object({entries:z.array(z.object({project:projectSummarySchema,pulse:pulseSchema,artifactCounts:z.record(z.string(),z.number())})),total:z.number(),limit:z.number(),offset:z.number(),summary:z.object({projects:z.number(),unknown:z.number(),onTrack:z.number(),atRisk:z.number(),blocked:z.number(),artifacts:z.number()})});
export type Dashboard=z.infer<typeof dashboardSchema>;
export const factoryThreadContextInput=z.object({threadId:z.string().min(1).max(200)}).strict();
export const factoryThreadContextSchema=z.object({context:z.object({project:projectSummarySchema.pick({id:true,name:true,mode:true,repository:true,revision:true}),run:analysisRunSchema,pulse:pulseSchema.omit({metrics:true})}).nullable()});
export type FactoryThreadContext=z.infer<typeof factoryThreadContextSchema>;


const linkRules:Record<string,Record<string,readonly string[]|'*'>> = {
  passport:{},sphere:{},external_context:{},job:{},
  audience:{has_job:['job']},offer:{addresses_job:['job'],for_audience:['audience']},
  initiative:{solves_job:['job'],offer:['offer']},role:{holds_job:['job'],created_by:['initiative']},
  story:{role:['role'],initiative:['initiative']},adr:{source:['initiative','story','principle'],superseded_by:['adr']},
  contract:{source:['initiative','story','adr']},
  task:{root:['initiative'],behavior_frame:['story','role_right','principle'],design_frame:['adr','principle'],depends_on:['task'],contract:['contract']},
  role_right:{role:['role']},subtask:{parent:['task'],depends_on:['subtask'],contract:['contract']},
  slice:{parent:['task'],contains:['subtask'],depends_on:['slice'],contract:['contract']},
  testcase:{source:['subtask','slice','adr'],backlog_unit:['task'],contract:['contract']},spec:{slice:['slice']},
  implementation:{spec:['spec'],slice:['slice']},review:{slice:['slice'],implementation:['implementation']},
  decision:{related:'*'},fork:{basis:['decision','fork','adr','contract'],related:'*'},
  question:{closed_by:['decision','fork','adr','contract'],related:'*'},principle:{source:'*'},
};
export interface WorkspaceDatabase {
  exec(sql:string): unknown;
  prepare(sql:string): {run(...params: any[]): unknown;get(...params:any[]): unknown;all(...params:any[]): unknown[]};
}
export interface WorkspaceProjects { get(id:string):Promise<Project>; remove(id:string):Promise<{removed:boolean}>; list(options?:{limit?:number;offset?:number}):Promise<Project[]>; count():Promise<number> }
interface Row { id:string;project_id:string;kind:string;title:string;status:string;version:number;fields_json:string;links_json:string;created_at:string;updated_at:string }

export class WorkspaceStore {
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private db:WorkspaceDatabase,private projects:WorkspaceProjects){
    db.exec(`CREATE TABLE IF NOT EXISTS factory_artifacts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      fields_json TEXT NOT NULL, links_json TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS factory_artifact_versions(project_id TEXT NOT NULL,artifact_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,artifact_id,version));
    CREATE TABLE IF NOT EXISTS factory_analysis_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,snapshot TEXT NOT NULL,UNIQUE(project_id,request_id));
    DROP INDEX IF EXISTS factory_analysis_active;
    CREATE INDEX IF NOT EXISTS factory_analysis_thread ON factory_analysis_runs(json_extract(payload,'$.threadId'));
    CREATE UNIQUE INDEX factory_analysis_active ON factory_analysis_runs(project_id) WHERE state IN ('pending','running','unknown','needs_attention');
    CREATE TABLE IF NOT EXISTS factory_analysis_request_aliases(project_id TEXT NOT NULL,request_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(project_id,request_id),FOREIGN KEY(run_id) REFERENCES factory_analysis_runs(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS factory_draft_imports(run_id TEXT NOT NULL,external_key TEXT NOT NULL,artifact_id TEXT NOT NULL,payload_hash TEXT NOT NULL,PRIMARY KEY(run_id,external_key));
    CREATE TABLE IF NOT EXISTS factory_pulses(project_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS factory_artifacts_project ON factory_artifacts(project_id,kind);
    CREATE UNIQUE INDEX IF NOT EXISTS factory_singleton ON factory_artifacts(project_id,kind) WHERE kind IN ('passport','offer');`);
  }
  private mutate<T>(fn:()=>Promise<T>):Promise<T>{const result=this.queue.then(fn);this.queue=result.catch(()=>undefined);return result;}
  private transaction<T>(fn:()=>T):T{
    this.db.exec('BEGIN IMMEDIATE');
    try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  private decode(row:unknown):Artifact{
    if(!row)throw new Error('Артефакт не найден в этом проекте.');
    const r=row as Row;
    return artifactSchema.parse({id:r.id,projectId:r.project_id,kind:r.kind,title:r.title,fields:JSON.parse(r.fields_json),links:JSON.parse(r.links_json),status:r.status,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at});
  }
  private getSync(projectId:string,id:string):Artifact{return this.decode(this.db.prepare('SELECT * FROM factory_artifacts WHERE project_id=? AND id=?').get(projectId,id));}
  private countSync(projectId:string):number{return (this.db.prepare('SELECT COUNT(*) AS count FROM factory_artifacts WHERE project_id=?').get(projectId) as {count:number}).count;}
  private snapshot(artifact:Artifact){
    this.db.prepare('INSERT OR IGNORE INTO factory_artifact_versions(project_id,artifact_id,version,payload) VALUES(?,?,?,?)').run(artifact.projectId,artifact.id,artifact.version,JSON.stringify(artifactSchema.parse(artifact)));
  }
  async history(input:unknown){
    const {projectId,id,limit,offset}=artifactHistoryInput.parse(input);await this.projects.get(projectId);
    const total=(this.db.prepare('SELECT COUNT(*) AS count FROM factory_artifact_versions WHERE project_id=? AND artifact_id=?').get(projectId,id) as {count:number}).count;
    if(!total)this.getSync(projectId,id);
    const entries=(this.db.prepare('SELECT payload FROM factory_artifact_versions WHERE project_id=? AND artifact_id=? ORDER BY version DESC LIMIT ? OFFSET ?').all(projectId,id,limit,offset) as {payload:string}[]).map(row=>artifactSchema.parse(JSON.parse(row.payload)));
    return {entries,total,limit,offset};
  }
  private validate(artifact:Artifact){
    if(Buffer.byteLength(JSON.stringify(artifact))>120_000)throw new Error('Артефакт превышает 120 КБ JSON.');
    const seen=new Set<string>();
    for(const link of artifact.links){
      if(link.targetId===artifact.id)throw new Error('Артефакт не может ссылаться сам на себя.');
      const key=link.type+':'+link.targetId;if(seen.has(key))throw new Error('Повторяющаяся связь.');seen.add(key);
      const target=this.db.prepare('SELECT kind FROM factory_artifacts WHERE project_id=? AND id=?').get(artifact.projectId,link.targetId) as {kind:string}|undefined;
      if(!target)throw new Error('Цель связи не найдена в этом проекте.');
      const allowed=linkRules[artifact.kind]?.[link.type];
      if(allowed===undefined)throw new Error('Тип связи не поддерживается локальной схемой: '+link.type);
      if(allowed!=='*'&&!allowed.includes(target.kind))throw new Error('Неверный вид цели связи '+link.type+': '+target.kind);
    }
    if(artifact.status==='accepted'&&artifact.kind==='task'&&artifact.links.filter(link=>link.type==='root').length!==1)throw new Error('Для ручного принятия задачи нужен ровно один корень — инициатива. Сохраните незавершённую задачу как черновик.');
  }
  async get(input:unknown){const {projectId,id}=artifactIdInput.parse(input);await this.projects.get(projectId);return this.getSync(projectId,id);}
  async workspace(input:unknown){
    const {projectId,kind,limit,offset}=workspaceInput.parse(input);const project=await this.projects.get(projectId);
    const counts:Record<string,number>=Object.fromEntries(artifactKinds.map(kind=>[kind,0]));
    for(const row of this.db.prepare('SELECT kind,COUNT(*) AS count FROM factory_artifacts WHERE project_id=? GROUP BY kind').all(projectId) as {kind:string;count:number}[])counts[row.kind]=row.count;
    const filter=kind?' AND kind=?':'';const params=kind?[projectId,kind]:[projectId];
    const entries=this.db.prepare('SELECT * FROM factory_artifacts WHERE project_id=?'+filter+' ORDER BY created_at,id LIMIT ? OFFSET ?').all(...params,limit,offset).map(row=>this.decode(row));
    const total=kind?(counts[kind]??0):Object.values(counts).reduce((sum,n)=>sum+n,0);
    return {project,entries,counts,total,limit,offset,pinnedRevision:project.revision,warnings:['Локальная схема реестра. Поля и связи сверяйте со скиллами закреплённой версии; ручное принятие не является автоматической приёмкой.']};
  }
  async targets(input:unknown){
    const {projectId,kind,query,limit,offset}=targetsInput.parse(input);await this.projects.get(projectId);
    const needle=query.toLocaleLowerCase('ru');
    const filter=kind?' AND kind=?':'';const params=kind?[projectId,kind]:[projectId];
    const artifacts=(this.db.prepare('SELECT id,kind,title,status,version FROM factory_artifacts WHERE project_id=?'+filter+' ORDER BY created_at,id').all(...params) as Pick<Artifact,'id'|'kind'|'title'|'status'|'version'>[]).filter(artifact=>[artifact.title,artifact.kind,artifact.id].some(value=>value.toLocaleLowerCase('ru').includes(needle)));
    return {entries:artifacts.slice(offset,offset+limit),total:artifacts.length,limit,offset};
  }
  create(input:unknown){return this.mutate(async()=>{
    const parsed=artifactCreateInput.parse(input);await this.projects.get(parsed.projectId);
    return this.transaction(()=>{
      const count=this.countSync(parsed.projectId);
      if(count>=500)throw new Error('Не более 500 артефактов в проекте.');
      if((parsed.kind==='passport'||parsed.kind==='offer')&&this.db.prepare('SELECT id FROM factory_artifacts WHERE project_id=? AND kind=?').get(parsed.projectId,parsed.kind))throw new Error('В проекте уже есть '+(parsed.kind==='passport'?'паспорт.':'оффер.'));
      const now=new Date().toISOString();const artifact:Artifact={...parsed,id:randomUUID(),status:'draft',version:1,createdAt:now,updatedAt:now};
      this.validate(artifact);
      this.db.prepare('INSERT INTO factory_artifacts(id,project_id,kind,title,fields_json,links_json,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(artifact.id,artifact.projectId,artifact.kind,artifact.title,JSON.stringify(artifact.fields),JSON.stringify(artifact.links),artifact.status,artifact.version,now,now);
      this.snapshot(artifact);
      return artifact;
    });
  });}
  update(input:unknown){return this.mutate(async()=>{
    const parsed=artifactUpdateInput.parse(input);await this.projects.get(parsed.projectId);
    return this.transaction(()=>{
      const current=this.getSync(parsed.projectId,parsed.id);
      if(current.version!==parsed.expectedVersion)throw new Error('Конфликт версии: текущая версия '+current.version+'. Обновите запись.');
      const {expectedVersion,...changes}=parsed;
      const artifact:Artifact={...current,...changes,version:current.version+1,updatedAt:new Date().toISOString()};
      this.validate(artifact);
      this.snapshot(current);
      this.db.prepare('UPDATE factory_artifacts SET title=?,fields_json=?,links_json=?,status=?,version=?,updated_at=? WHERE project_id=? AND id=?').run(artifact.title,JSON.stringify(artifact.fields),JSON.stringify(artifact.links),artifact.status,artifact.version,artifact.updatedAt,artifact.projectId,artifact.id);
      this.snapshot(artifact);
      return artifact;
    });
  });}
  remove(input:unknown){return this.mutate(async()=>{
    const {projectId,id,expectedVersion}=artifactRemoveInput.parse(input);await this.projects.get(projectId);
    return this.transaction(()=>{
      const artifact=this.getSync(projectId,id);
      if(artifact.version!==expectedVersion)throw new Error('Конфликт версии: текущая версия '+artifact.version+'. Обновите запись.');
      if(['decision','fork','adr'].includes(artifact.kind))throw new Error('Запись журнала сохраняется. Укажите статус закрытия или замены в полях.');
      const incoming=(this.db.prepare('SELECT title,links_json FROM factory_artifacts WHERE project_id=?').all(projectId) as {title:string;links_json:string}[]).find(candidate=>(JSON.parse(candidate.links_json) as Artifact['links']).some(link=>link.targetId===id));
      if(incoming)throw new Error('Удаление запрещено: есть входящая связь из «'+incoming.title+'».');
      this.snapshot(artifact);
      this.db.prepare('DELETE FROM factory_artifacts WHERE project_id=? AND id=?').run(projectId,id);
      return {removed:true as const};
    });
  });}
  private pulseSync(projectId:string):Pulse{
    const row=this.db.prepare('SELECT payload FROM factory_pulses WHERE project_id=?').get(projectId) as {payload:string}|undefined;
    return row?pulseSchema.parse(JSON.parse(row.payload)):{projectId,scope:'unassigned',objective:'',health:'unknown',nextStep:'',blocker:'',version:0,updatedAt:null,metrics:[]};
  }
  async pulseGet(input:unknown){const {projectId}=pulseGetInput.parse(input);await this.projects.get(projectId);return this.pulseSync(projectId);}
  pulseUpdate(input:unknown){return this.mutate(async()=>{
    const parsed=pulseUpdateInput.parse(input);await this.projects.get(parsed.projectId);
    return this.transaction(()=>{
      const current=this.pulseSync(parsed.projectId);
      if(current.version!==parsed.expectedVersion)throw new Error('Конфликт показателей: текущая версия '+current.version+'. Обновите данные.');
      if(parsed.metrics&&new Set(parsed.metrics.map(metric=>metric.id)).size!==parsed.metrics.length)throw new Error('Идентификаторы метрик должны быть уникальны.');
      const now=new Date().toISOString();const {expectedVersion,...fields}=parsed;
      const pulse:Pulse={...fields,metrics:fields.metrics?fields.metrics.map(metric=>({...metric,updatedAt:now})):current.metrics,version:current.version+1,updatedAt:now};
      const payload=JSON.stringify(pulse);if(Buffer.byteLength(payload)>120_000)throw new Error('Показатели проекта превышают 120 КБ.');
      this.db.prepare('INSERT INTO factory_pulses(project_id,payload) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload').run(pulse.projectId,payload);
      return pulse;
    });
  });}
  async dashboard(input:unknown):Promise<Dashboard>{
    const {query,scope,health,limit,offset}=dashboardInput.parse(input);
    const count=Math.min(await this.projects.count(),500);const projects:Project[]=[];
    for(let start=0;start<count;start+=20)projects.push(...await this.projects.list({limit:20,offset:start}));
    const needle=query.toLocaleLowerCase('ru');
    const entries:Dashboard['entries']=[];
    for(const project of projects){
      const pulse=this.pulseSync(project.id);
      if((scope!=='all'&&pulse.scope!==scope)||(health!=='all'&&pulse.health!==health)||![project.name,project.repository].some(value=>value.toLocaleLowerCase('ru').includes(needle)))continue;
      const {baseline,...summary}=project;const artifactCounts:Record<string,number>={};
      for(const row of this.db.prepare('SELECT kind,COUNT(*) AS count FROM factory_artifacts WHERE project_id=? GROUP BY kind').all(project.id) as {kind:string;count:number}[])artifactCounts[row.kind]=row.count;
      entries.push({project:summary,pulse,artifactCounts});
    }
    return {entries:entries.slice(offset,offset+limit),total:entries.length,limit,offset,summary:{projects:entries.length,unknown:entries.filter(entry=>entry.pulse.health==='unknown').length,onTrack:entries.filter(entry=>entry.pulse.health==='on_track').length,atRisk:entries.filter(entry=>entry.pulse.health==='at_risk').length,blocked:entries.filter(entry=>entry.pulse.health==='blocked').length,artifacts:entries.reduce((sum,entry)=>sum+Object.values(entry.artifactCounts).reduce((n,count)=>n+count,0),0)}};
  }
  private analysisSync(id:string):AnalysisRun{
    const row=this.db.prepare('SELECT payload FROM factory_analysis_runs WHERE id=?').get(id) as {payload:string}|undefined;
    if(!row)throw new Error('Запуск анализа не найден.');return analysisRunSchema.parse(JSON.parse(row.payload));
  }
  private writeAnalysis(run:AnalysisRun){this.db.prepare('UPDATE factory_analysis_runs SET state=?,payload=? WHERE id=?').run(run.state,JSON.stringify(run),run.id);}
  private analysisRequestSync(projectId:string,requestId:string){const row=this.db.prepare('SELECT payload FROM factory_analysis_runs WHERE project_id=? AND request_id=? UNION ALL SELECT runs.payload AS payload FROM factory_analysis_request_aliases AS aliases JOIN factory_analysis_runs AS runs ON runs.id=aliases.run_id AND runs.project_id=aliases.project_id WHERE aliases.project_id=? AND aliases.request_id=? LIMIT 1').get(projectId,requestId,projectId,requestId) as {payload:string}|undefined;return row?analysisRunSchema.parse(JSON.parse(row.payload)):null;}
  private bindAnalysisRequest(projectId:string,requestId:string,run:AnalysisRun){if(run.projectId!==projectId)throw new Error('Запуск не найден в этом проекте.');this.db.prepare('INSERT INTO factory_analysis_request_aliases(project_id,request_id,run_id) VALUES(?,?,?)').run(projectId,requestId,run.id);return run;}
  async analysisFind(projectId:string,requestId:string){await this.projects.get(projectId);return this.analysisRequestSync(projectId,requestId);}
  analysisAdopt(projectId:string,requestId:string,runId:string){return this.mutate(async()=>{await this.projects.get(projectId);return this.transaction(()=>this.analysisRequestSync(projectId,requestId)??this.bindAnalysisRequest(projectId,requestId,this.analysisSync(runId)));});}
  analysisLookup(projectId:string,requestId:string){return this.mutate(async()=>{await this.projects.get(projectId);return this.transaction(()=>{const own=this.analysisRequestSync(projectId,requestId);const row=this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE project_id=? AND state IN ('pending','running','unknown','needs_attention')").get(projectId) as {payload:string}|undefined;const activeRun=row?analysisRunSchema.parse(JSON.parse(row.payload)):null;return {run:own??(activeRun?this.bindAnalysisRequest(projectId,requestId,activeRun):null),activeRun};});});}
  async analysisRuns(input:unknown){const {projectId,limit,offset}=analysisRunsInput.parse(input);await this.projects.get(projectId);const total=(this.db.prepare('SELECT COUNT(*) AS count FROM factory_analysis_runs WHERE project_id=?').get(projectId) as {count:number}).count;return {entries:(this.db.prepare('SELECT payload FROM factory_analysis_runs WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(projectId,limit,offset) as {payload:string}[]).map(row=>analysisRunSchema.parse(JSON.parse(row.payload))),total,limit,offset};}
  async threadContext(input:unknown):Promise<FactoryThreadContext>{const {threadId}=factoryThreadContextInput.parse(input);const rows=this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE json_extract(payload,'$.threadId')=? ORDER BY rowid DESC LIMIT 2").all(threadId) as {payload:string}[];if(rows.length!==1)return {context:null};const run=analysisRunSchema.parse(JSON.parse(rows[0]!.payload));let project:Project;try{project=await this.projects.get(run.projectId);}catch{return {context:null};}const {id,name,mode,repository,revision}=project;const {metrics,...pulse}=this.pulseSync(project.id);return {context:{project:{id,name,mode,repository,revision},run,pulse}};}
  async analysisGet(projectId:string,runId:string){await this.projects.get(projectId);const run=this.analysisSync(runId);if(run.projectId!==projectId)throw new Error('Запуск не найден в этом проекте.');return run;}
  async analysisActive(projectId:string){await this.projects.get(projectId);const row=this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE project_id=? AND state IN ('pending','running','unknown','needs_attention')").get(projectId) as {payload:string}|undefined;return row?analysisRunSchema.parse(JSON.parse(row.payload)):null;}
  analysisThreadRuns(threadId:string){return (this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE json_extract(payload,'$.threadId')=? AND state NOT IN ('ready','closed')").all(threadId) as {payload:string}[]).map(row=>analysisRunSchema.parse(JSON.parse(row.payload)));}
  analysisCaller(caller:{threadId?:string;projectId?:string}){if(!caller.threadId||!caller.projectId)throw new Error('Команду импорта нужно выполнить из агентского треда запуска.');const rows=this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE json_extract(payload,'$.threadId')=? AND json_extract(payload,'$.bbProjectId')=?").all(caller.threadId,caller.projectId) as {payload:string}[];if(rows.length!==1)throw new Error('Не найдена однозначная привязка треда к запуску.');const run=analysisRunSchema.parse(JSON.parse(rows[0]!.payload));if(!run.hostId||!['running','needs_attention','ready'].includes(run.state))throw new Error('Импорт для этого запуска сейчас недоступен.');return run;}
  analysisReserve(input:{projectId:string;requestId:string;revisionId:string;sourcePath:string;instructionsHash:string;contextHash:string;snapshot:AnalysisSnapshot}){return this.mutate(async()=>{
    await this.projects.get(input.projectId);
    return this.transaction(()=>{
      const existing=this.analysisRequestSync(input.projectId,input.requestId);
      if(existing)return {run:existing,created:false};
      const active=this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE project_id=? AND state IN ('pending','running','unknown','needs_attention')").get(input.projectId) as {payload:string}|undefined;
      if(active)return {run:this.bindAnalysisRequest(input.projectId,input.requestId,analysisRunSchema.parse(JSON.parse(active.payload))),created:false};
      const now=new Date().toISOString();const run:AnalysisRun={id:randomUUID(),projectId:input.projectId,requestId:input.requestId,revisionId:input.revisionId,sourcePath:input.sourcePath,instructionsHash:input.instructionsHash,contextHash:input.contextHash,state:'pending',hostId:null,bbProjectId:null,threadId:null,error:null,createdAt:now,updatedAt:now,importedArtifactIds:[],resultReason:null,providerId:null,providerName:null,model:null,modelName:null,permissionMode:null,attempts:[],spawnFailure:null,recovery:null};
      this.db.prepare('INSERT INTO factory_analysis_runs(id,project_id,request_id,state,payload,snapshot) VALUES(?,?,?,?,?,?)').run(run.id,run.projectId,run.requestId,run.state,JSON.stringify(run),JSON.stringify(input.snapshot));return {run,created:true};
    });
  });}
  analysisPrepare(id:string,snapshot:AnalysisSnapshot){return this.mutate(async()=>this.transaction(()=>{const run=this.analysisSync(id);if(run.state!=='pending'||run.threadId||run.bbProjectId)throw new Error('Подготовка этого запуска уже завершена или требует проверки.');const prepared={...run,instructionsHash:createHash('sha256').update(JSON.stringify(snapshot.files)).digest('hex'),contextHash:createHash('sha256').update(JSON.stringify(snapshot.context)).digest('hex'),updatedAt:new Date().toISOString()};this.db.prepare('UPDATE factory_analysis_runs SET payload=?,snapshot=? WHERE id=?').run(JSON.stringify(prepared),JSON.stringify(snapshot),id);return prepared;}));}
  analysisPatch(id:string,patch:Partial<Pick<AnalysisRun,'state'|'error'|'hostId'|'bbProjectId'|'threadId'|'sourcePath'|'providerId'|'providerName'|'model'|'modelName'|'permissionMode'|'spawnFailure'|'recovery'>>){return this.mutate(async()=>this.transaction(()=>{const current=this.analysisSync(id);const run=analysisRunSchema.parse({...current,...patch,...(['ready','closed'].includes(current.state)?{state:current.state,error:current.error}:{}),updatedAt:new Date().toISOString()});this.writeAnalysis(run);return run;}));}
  analysisBeginAttempt(id:string,execution:AnalysisExecution){return this.mutate(async()=>this.transaction(()=>{const current=this.analysisSync(id);if(current.state!=='pending'||current.threadId)throw new Error('Попытка запуска уже начата или требует проверки.');const now=new Date().toISOString();const attempt:AnalysisAttempt={id:randomUUID(),startedAt:now,finishedAt:null,state:'spawning',threadId:null,...execution,error:null,spawnFailure:null};const run=analysisRunSchema.parse({...current,...execution,attempts:[...current.attempts,attempt],updatedAt:now});this.writeAnalysis(run);return {run,attemptId:attempt.id};}));}
  analysisFinishAttempt(id:string,attemptId:string,result:{state:'running'|'failed'|'unknown';threadId:string|null;error:string|null;spawnFailure:AnalysisSpawnFailure|null}){return this.mutate(async()=>this.transaction(()=>{const current=this.analysisSync(id);if(current.state!=='pending')throw new Error('Попытка запуска уже завершена или требует проверки.');const now=new Date().toISOString();const attempts=current.attempts.map(attempt=>attempt.id===attemptId?{...attempt,finishedAt:now,state:result.state,threadId:result.threadId,error:result.error,spawnFailure:result.spawnFailure}:attempt);const run=analysisRunSchema.parse({...current,state:result.state,threadId:result.threadId,error:result.error,spawnFailure:result.spawnFailure,attempts,updatedAt:now});this.writeAnalysis(run);return run;}));}
  analysisResolveSpawn(id:string,result:{state:'running'|'failed';threadId:string|null;error:string|null;spawnFailure:AnalysisSpawnFailure|null;recovery:AnalysisRecovery}){return this.mutate(async()=>this.transaction(()=>{const current=this.analysisSync(id);if(current.state===result.state&&current.threadId===result.threadId)return current;if(!['pending','unknown'].includes(current.state))throw new Error('Запуск уже имеет подтверждённое состояние.');const now=new Date().toISOString();const attempts=current.attempts.map((attempt,index)=>index===current.attempts.length-1?{...attempt,finishedAt:attempt.finishedAt??now,state:result.state==='running'?'running':'failed',threadId:result.threadId??attempt.threadId,error:result.error??attempt.error,spawnFailure:result.spawnFailure??attempt.spawnFailure}:attempt);const run=analysisRunSchema.parse({...current,state:result.state,threadId:result.threadId,error:result.error,spawnFailure:result.spawnFailure,recovery:result.recovery,attempts,updatedAt:now});this.writeAnalysis(run);return run;}));}
  analysisRecover(){return this.mutate(async()=>this.transaction(()=>{const rows=this.db.prepare("SELECT payload FROM factory_analysis_runs WHERE state='pending'").all() as {payload:string}[];for(const row of rows){const run=analysisRunSchema.parse(JSON.parse(row.payload));this.writeAnalysis({...run,state:'unknown',error:'BB перезапущен до подтверждения запуска. Повтор автоматически заблокирован; проверьте треды.',updatedAt:new Date().toISOString()});}}));}
  analysisComplete(input:unknown,caller:{threadId?:string;projectId?:string}){return this.mutate(async()=>{
    const parsed=analysisCompleteInput.parse(input);await this.projects.get(parsed.projectId);
    return this.transaction(()=>{
      const run=this.analysisSync(parsed.runId);
      if(run.projectId!==parsed.projectId||run.revisionId!==parsed.revisionId)throw new Error('Проект или версия не совпадает с запуском.');
      if(!run.threadId||caller.threadId!==run.threadId||caller.projectId!==run.bbProjectId)throw new Error('Импорт разрешён только агентскому треду этого запуска в его BB-проекте.');
      if(!['running','ready','needs_attention'].includes(run.state))throw new Error('Запуск не подтверждён или уже завершён с ошибкой.');
      if(!parsed.items.length&&!parsed.reason.trim())throw new Error('Для пустого результата укажите причину.');
      if(new Set(parsed.items.map(item=>item.externalKey)).size!==parsed.items.length)throw new Error('externalKey должны быть уникальны в batch.');
      const canonical=(value:unknown):string=>{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);};
      const payloadHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
      const resolved=new Map<string,string>();let newCount=0;
      for(const item of parsed.items){const old=this.db.prepare('SELECT artifact_id,payload_hash FROM factory_draft_imports WHERE run_id=? AND external_key=?').get(run.id,item.externalKey) as {artifact_id:string;payload_hash:string}|undefined;if(old){if(old.payload_hash!==payloadHash(item))throw new Error('Повторный externalKey содержит другие данные: '+item.externalKey);resolved.set(item.externalKey,old.artifact_id);}else{if(run.state==='ready')throw new Error('Завершённый запуск не принимает новые записи.');resolved.set(item.externalKey,randomUUID());newCount++;}}
      if(this.countSync(parsed.projectId)+newCount>500)throw new Error('Превышен предел 500 артефактов.');
      const created:Artifact[]=[];const now=new Date().toISOString();
      for(const item of parsed.items){if(this.db.prepare('SELECT external_key FROM factory_draft_imports WHERE run_id=? AND external_key=?').get(run.id,item.externalKey))continue;const kind=artifactKindSchema.parse(item.kind);if((kind==='passport'||kind==='offer')&&this.db.prepare('SELECT id FROM factory_artifacts WHERE project_id=? AND kind=?').get(parsed.projectId,kind))throw new Error('В проекте уже есть '+kind+'. Сопоставьте существующую запись вместо перезаписи.');
        const artifact=artifactSchema.parse({id:resolved.get(item.externalKey),projectId:parsed.projectId,kind,title:item.title,fields:{...item.fields,analysisProvenance:JSON.stringify(item.provenance),analysisRunId:run.id,analysisRevisionId:run.revisionId},links:item.links.map(link=>({type:link.type,targetId:link.targetId??resolved.get(link.targetKey!)})),status:'draft',version:1,createdAt:now,updatedAt:now});
        this.db.prepare('INSERT INTO factory_artifacts(id,project_id,kind,title,fields_json,links_json,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(artifact.id,artifact.projectId,artifact.kind,artifact.title,JSON.stringify(artifact.fields),JSON.stringify(artifact.links),artifact.status,1,now,now);created.push(artifact);
        this.db.prepare('INSERT INTO factory_draft_imports(run_id,external_key,artifact_id,payload_hash) VALUES(?,?,?,?)').run(run.id,item.externalKey,artifact.id,payloadHash(item));
      }
      for(const artifact of created){this.validate(artifact);this.snapshot(artifact);}
      if(run.state==='ready'&&(resolved.size!==run.importedArtifactIds.length||run.resultReason!==(parsed.reason||null)))throw new Error('Повторный batch отличается от результата запуска.');
      const complete={...run,state:'ready' as const,error:null,updatedAt:now,importedArtifactIds:parsed.items.map(item=>resolved.get(item.externalKey)!),resultReason:parsed.reason||null};this.writeAnalysis(complete);return {run:complete,artifactIds:complete.importedArtifactIds};
    });
  });}
  private cleanupProjectAudit(projectId:string){this.transaction(()=>{this.db.prepare('DELETE FROM factory_artifact_versions WHERE project_id=?').run(projectId);this.db.prepare('DELETE FROM factory_pulses WHERE project_id=?').run(projectId);this.db.prepare('DELETE FROM factory_draft_imports WHERE run_id IN (SELECT id FROM factory_analysis_runs WHERE project_id=?)').run(projectId);this.db.prepare('DELETE FROM factory_analysis_request_aliases WHERE project_id=?').run(projectId);this.db.prepare('DELETE FROM factory_analysis_runs WHERE project_id=?').run(projectId);});}
  recoverProjectAudit(){return this.mutate(async()=>{const ids=this.db.prepare('SELECT project_id FROM factory_artifact_versions UNION SELECT project_id FROM factory_pulses UNION SELECT project_id FROM factory_analysis_runs').all() as {project_id:string}[];for(const {project_id} of ids){try{await this.projects.get(project_id);continue;}catch(error){if(!(error instanceof Error)||error.message!=='Проект не найден.')throw error;}if(this.countSync(project_id)||this.db.prepare("SELECT id FROM factory_analysis_runs WHERE project_id=? AND state IN ('pending','running','unknown','needs_attention')").get(project_id))continue;this.cleanupProjectAudit(project_id);}});}
  removeProject(projectId:string,discardHistory=false){return this.mutate(async()=>{
    uuid.parse(projectId);await this.projects.get(projectId);
    if(this.db.prepare("SELECT id FROM factory_analysis_runs WHERE project_id=? AND state IN ('pending','running','unknown','needs_attention')").get(projectId))throw new Error('Сначала завершите или разберите активный анализ проекта.');
    if(this.countSync(projectId))throw new Error('Проект содержит артефакты. Сначала удалите допустимые записи; журнал сохраняется и блокирует удаление проекта.');
    const historyCount=(this.db.prepare('SELECT COUNT(*) AS count FROM factory_artifact_versions WHERE project_id=?').get(projectId) as {count:number}).count;
    const runCount=(this.db.prepare('SELECT COUNT(*) AS count FROM factory_analysis_runs WHERE project_id=?').get(projectId) as {count:number}).count;
    if((historyCount||runCount)&&!discardHistory)throw new Error('У проекта сохранена история изменений или запусков. Для явного удаления карточки вместе с историей передайте discardHistory: true. Репозиторий не затрагивается.');
    const removed=await this.projects.remove(projectId);
    if(!removed.removed)throw new Error('Карточка проекта не удалена; история сохранена.');
    this.cleanupProjectAudit(projectId);
    return removed;
  });}
}
