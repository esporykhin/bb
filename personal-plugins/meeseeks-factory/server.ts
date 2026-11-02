import { AnalysisService } from './analysis';
import { analysisStartInput,analysisRunSchema,analysisRunsInput,analysisCloseInput,analysisLookupInput } from './analysis-contract';
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import bundle from './methodology/bundle.json';
import { catalogInput, catalogSchema, discoverProjects } from './discovery';
import { dashboardInput,dashboardSchema,pulseGetInput,pulseSchema,pulseUpdateInput,factoryThreadContextInput,factoryThreadContextSchema,WorkspaceStore, workspaceInput, workspaceSchema, targetsInput, targetsSchema, artifactSchema, artifactIdInput, artifactHistoryInput,artifactHistorySchema,artifactCreateInput, artifactUpdateInput, artifactRemoveInput } from './workspace';
import { FactoryStore, projectInput, projectSchema, revisionSchema } from './domain';

export type { AnalysisRun } from './analysis-contract';
export type { Project, Revision } from './domain';
export type { Artifact, ArtifactKind, Pulse, Metric, Dashboard, FactoryThreadContext } from './workspace';
export const rpcContract = defineRpcContract({
  factory_thread_context:{input:factoryThreadContextInput,output:factoryThreadContextSchema},
  analysis_close:{input:analysisCloseInput,output:z.object({run:analysisRunSchema})},
  analysis_lookup:{input:analysisLookupInput,output:z.object({run:analysisRunSchema.nullable(),activeRun:analysisRunSchema.nullable()})},
  analysis_start:{input:analysisStartInput,output:z.object({run:analysisRunSchema})},
  analysis_runs:{input:analysisRunsInput,output:z.object({entries:z.array(analysisRunSchema),total:z.number(),limit:z.number(),offset:z.number()})},
  dashboard_get:{input:dashboardInput,output:dashboardSchema},
  pulse_get:{input:pulseGetInput,output:z.object({pulse:pulseSchema})},
  pulse_update:{input:pulseUpdateInput,output:z.object({pulse:pulseSchema})},
  workspace_get:{input:workspaceInput,output:workspaceSchema},
  workspace_targets:{input:targetsInput,output:targetsSchema},
  artifact_history:{input:artifactHistoryInput,output:artifactHistorySchema},
  artifact_get:{input:artifactIdInput,output:z.object({artifact:artifactSchema})},
  artifact_create:{input:artifactCreateInput,output:z.object({artifact:artifactSchema})},
  artifact_update:{input:artifactUpdateInput,output:z.object({artifact:artifactSchema})},
  artifact_remove:{input:artifactRemoveInput,output:z.object({removed:z.boolean()})},
  projects_discover: {input:catalogInput,output:catalogSchema},
  projects_list: {input:z.object({limit:z.number().int().min(1).max(20).default(20),offset:z.number().int().min(0).max(500).default(0)}).strict(), output:z.object({projects:z.array(projectSchema),total:z.number()})},
  projects_create: {input:projectInput, output:projectSchema},
  projects_update: {input:z.object({id:z.string().uuid(),expectedUpdatedAt:z.string().datetime(),revision:z.string().regex(/^[a-f0-9]{64}$/),adoption:projectSchema.shape.adoption,name:z.string().trim().min(1).max(120).optional(),repository:z.string().trim().max(1500).optional(),baseline:z.string().trim().max(12000).optional()}).strict(),output:projectSchema},
  projects_remove: {input:z.object({id:z.string().uuid(),discardHistory:z.boolean().optional()}).strict(),output:z.object({removed:z.boolean()})},
  methodology_info: {input:z.null(),output:z.object({head:revisionSchema,revisions:z.array(revisionSchema)})},
  methodology_file: {input:z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().max(300)}).strict(),output:z.object({path:z.string(),hash:z.string(),content:z.string()})},
  methodology_edit: {input:z.object({expectedRevision:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().max(300),content:z.string().max(120_000)}).strict(),output:revisionSchema},
});
export default async function plugin(bb: BbPluginApi) {
  const store = new FactoryStore(bb.storage.kv, bundle);
  await store.init();
  const workspace=new WorkspaceStore(bb.storage.database(),store);
  await workspace.recoverProjectAudit();
  await workspace.analysisRecover();
  const analysis=new AnalysisService(store,workspace,bb.sdk);
  const changed = <T>(promise: Promise<T>) => promise.then(value => {bb.realtime.publish('factory-changed', {}); return value;});
  bb.rpc.register(rpcContract, {
    factory_thread_context:input=>analysis.context(input),
    analysis_start:input=>changed(analysis.start(input)),
    analysis_runs:input=>analysis.runs(input),
    analysis_lookup:input=>analysis.lookup(input),
    analysis_close:input=>changed(analysis.close(input)),
    dashboard_get:input=>workspace.dashboard(input),
    pulse_get:async input=>({pulse:await workspace.pulseGet(input)}),
    pulse_update:async input=>({pulse:await changed(workspace.pulseUpdate(input))}),
    workspace_get:async input=>{const result=await workspace.workspace(input);bb.log.debug(JSON.stringify({method:'workspace_get',projectId:input.projectId,kind:input.kind,total:result.total,jobCount:result.counts.job}));return result;},
    workspace_targets:async input=>{const result=await workspace.targets(input);bb.log.debug(JSON.stringify({method:'workspace_targets',projectId:input.projectId,kind:input.kind,total:result.total}));return result;},
    artifact_history:input=>workspace.history(input),
    artifact_get:async input=>({artifact:await workspace.get(input)}),
    artifact_create:async input=>({artifact:await changed(workspace.create(input))}),
    artifact_update:async input=>({artifact:await changed(workspace.update(input))}),
    artifact_remove:input=>changed(workspace.remove(input)),
    projects_discover: input => discoverProjects(input),
    projects_list: async input => ({projects:await store.list(input),total:await store.count()}),
    projects_create: input => changed(store.create(input)),
    projects_update: input => changed(store.update(input)),
    projects_remove: ({id,discardHistory}) => changed(workspace.removeProject(id,discardHistory)),
    methodology_info: async () => ({head:await store.head(),revisions:await store.revisions()}),
    methodology_file: ({revision,path}) => store.file(revision,path),
    methodology_edit: input => changed(store.edit(input)),
  });
  const observe=async(threadId:string)=>{if(await analysis.observeThread(threadId))bb.realtime.publish('factory-changed',{});};
  bb.events.on('thread.idle',({thread})=>observe(thread.id));
  bb.events.on('thread.failed',({thread})=>observe(thread.id));
  bb.events.on('thread.active',({thread})=>observe(thread.id));
  const usage = [
    'bb meeseeks-factory projects list [--limit 1..20] [--offset 0..500]',
    'bb meeseeks-factory projects discover [--query text] [--limit 1..20] [--offset 0..1000000]',
    'bb meeseeks-factory projects show <id>',
    'bb meeseeks-factory projects create <JSON>',
    'bb meeseeks-factory projects remove <JSON: id, discardHistory?>',
    '  JSON: {"name":"Продукт","mode":"existing","repository":"/path/to/repo","baseline":"Текущее состояние"}',
    'bb meeseeks-factory dashboard get <JSON: query?, scope?, health?, limit?, offset?>',
    'bb meeseeks-factory pulse get|update <JSON>',
    'bb meeseeks-factory workspace get <JSON: projectId, kind?, limit?, offset?>',
    'bb meeseeks-factory workspace targets <JSON: projectId, query?, kind?, limit?, offset?>',
    'bb meeseeks-factory artifact get|history|create|update|remove <JSON>',
    'bb meeseeks-factory analysis start|list|lookup|close <JSON>',
    'bb meeseeks-factory analysis context <threadId>',
    'bb meeseeks-factory analysis complete --file /absolute/path/result.json',
    'bb meeseeks-factory methodology file <JSON: revision, path>',
    'bb meeseeks-factory methodology info',
  ].join('\n');
  bb.cli.register({
    name:'meeseeks-factory',summary:'Фабрика софта: проекты и версии методологии',
    commands:[{name:'analysis',summary:'Запуск анализа и атомарный импорт черновиков',usage:'bb meeseeks-factory analysis start|list|lookup|close <JSON> | complete --file <JSON-file>'},{name:'dashboard',summary:'Портфель проектов',usage:'bb meeseeks-factory dashboard get <JSON>'},{name:'pulse',summary:'Ручные цели и показатели проекта',usage:'bb meeseeks-factory pulse get|update <JSON>'},{name:'workspace',summary:'Рабочее пространство и поиск связей',usage:'bb meeseeks-factory workspace get|targets <JSON>'},{name:'artifact',summary:'CRUD записей методологии с CAS',usage:'bb meeseeks-factory artifact get|history|create|update|remove <JSON>'},{name:'projects',summary:'Каталог на диске, карточки проектов и создание',usage:'bb meeseeks-factory projects discover|list|show <id>|create <JSON>'},{name:'methodology',summary:'Текущая ревизия пакета',usage:'bb meeseeks-factory methodology info'}],
    async run(argv,ctx) {
      try {
        const [area,action,...args] = argv;
        let value: unknown;
        if (area === 'projects' && action === 'discover') {
          const options:{limit?:number;offset?:number;query?:string}={};
          for(let i=0;i<args.length;i+=2){
            const flag=args[i];const value=args[i+1];
            if((flag!=='--limit'&&flag!=='--offset'&&flag!=='--query')||value===undefined) throw new Error(usage);
            if(flag==='--query') options.query=value;else options[flag==='--limit'?'limit':'offset']=Number(value);
          }
          const catalog=await discoverProjects(options);
          return {exitCode:catalog.error?1:0,stdout:JSON.stringify(catalog,null,2)};
        }
        else if (area === 'projects' && action === 'list') {
          const options:{limit?:number;offset?:number}={};
          for(let i=0;i<args.length;i+=2){const flag=args[i];if((flag!=='--limit'&&flag!=='--offset')||args[i+1]===undefined) throw new Error(usage);options[flag==='--limit'?'limit':'offset']=Number(args[i+1]);}
          value={projects:await store.list(options),total:await store.count()};
        }
        else if (area === 'projects' && action === 'show' && args.length===1) value=await store.get(z.string().uuid().parse(args[0]));
        else if(area==='projects'&&action==='remove'&&args.length===1){const parsed=z.object({id:z.string().uuid(),discardHistory:z.boolean().optional()}).strict().parse(JSON.parse(args[0]!));value=await changed(workspace.removeProject(parsed.id,parsed.discardHistory));}
        else if (area === 'projects' && action === 'create' && args.length===1) value=await changed(store.create(JSON.parse(args[0]!)));
        else if(area==='dashboard'&&action==='get'&&args.length===1)value=await workspace.dashboard(JSON.parse(args[0]!));
        else if(area==='pulse'&&args.length===1){const input=JSON.parse(args[0]!);if(action==='get')value={pulse:await workspace.pulseGet(input)};else if(action==='update')value={pulse:await changed(workspace.pulseUpdate(input))};else throw new Error(usage);}
        else if(area==='workspace'&&args.length===1){
          const input=JSON.parse(args[0]!);
          if(action==='get')value=await workspace.workspace(input);
          else if(action==='targets')value=await workspace.targets(input);
          else throw new Error(usage);
        }
        else if(area==='artifact'&&args.length===1){
          const input=JSON.parse(args[0]!);
          if(action==='get')value={artifact:await workspace.get(input)};
          else if(action==='history')value=await workspace.history(input);
          else if(action==='create')value={artifact:await changed(workspace.create(input))};
          else if(action==='update')value={artifact:await changed(workspace.update(input))};
          else if(action==='remove')value=await changed(workspace.remove(input));
          else throw new Error(usage);
        }
        else if(area==='analysis'&&action==='start'&&args.length===1)value=await changed(analysis.start(JSON.parse(args[0]!)));
        else if(area==='analysis'&&action==='list'&&args.length===1)value=await analysis.runs(JSON.parse(args[0]!));
        else if(area==='analysis'&&action==='context'&&args.length===1)value=await analysis.context({threadId:args[0]});
        else if(area==='analysis'&&action==='lookup'&&args.length===1)value=await analysis.lookup(JSON.parse(args[0]!));
        else if(area==='analysis'&&action==='close'&&args.length===1)value=await changed(analysis.close(JSON.parse(args[0]!)));
        else if(area==='analysis'&&action==='complete'&&args.length===2&&args[0]==='--file')value=await changed(analysis.completeFile(args[1]!,ctx));
        else if(area==='methodology'&&action==='file'&&args.length===1){const input=z.object({revision:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().max(300)}).strict().parse(JSON.parse(args[0]!));value=await store.file(input.revision,input.path);}
        else if (area === 'methodology' && action === 'info' && !args.length) {const rev=await store.head(); value={...rev, files:undefined,fileCount:rev.files.length};}
        else return {exitCode:area && area!=='help' && area!=='--help'?1:0,stdout:usage};
        return {exitCode:0,stdout:JSON.stringify(value,null,2)};
      } catch(error) {return {exitCode:1,stderr:error instanceof Error?error.message:String(error)};}
    },
  });
}
