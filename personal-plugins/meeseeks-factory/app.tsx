import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { PluginNavPanelProps } from '@get-bb/plugin-sdk/app';
import { definePluginApp, experimental_THREAD_INFO_SECTION_GROUPS, experimental_THREAD_CONTEXT_SEGMENT_GROUPS, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { Catalog, CatalogEntry } from './discovery';
import type { rpcContract, Project, Revision } from './server';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProjectWorkspace } from './ProjectWorkspace';
import { Portfolio } from './Portfolio';
import { FactoryThreadContextCard, FactoryThreadBanner, useFactoryThreadBannerVisible } from './FactoryThreadContext';
import { factoryProjectSubPath, parseFactoryProjectSubPath } from './analysis-ui';

const adoptionLabels: Record<Project['adoption'],string> = {planned:'Запланирован',baseline_recorded:'Исходное состояние записано',adopting:'Переход на фабрику',standard:'Работа по стандарту'};
const field = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const rememberedProject=()=>{try{return sessionStorage.getItem('meeseeks-factory:opened-project');}catch{return null;}};
const rememberProject=(id:string|null)=>{try{if(id)sessionStorage.setItem('meeseeks-factory:opened-project',id);else sessionStorage.removeItem('meeseeks-factory:opened-project');}catch{}};
function FactoryPage({subPath}:PluginNavPanelProps) {
  const navigate=useBbNavigate();
  const routeProjectId=parseFactoryProjectSubPath(subPath);
  const rpc=useRpc<typeof rpcContract>();
  const [projects,setProjects]=useState<Project[]>([]);
  const [info,setInfo]=useState<{head:Revision;revisions:Revision[]}|null>(null);
  const [error,setError]=useState('');
  const errorRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(error)errorRef.current?.scrollIntoView({block:'center'});},[error]);
  const [loaded,setLoaded]=useState(false);
  const [offset,setOffset]=useState(0);
  const [total,setTotal]=useState(0);
  const [editing,setEditing]=useState<Project|null>(null);
  const [fileReadSucceeded,setFileReadSucceeded]=useState(false);
  const [pending,setPending]=useState(false);
  const [tab,setTab]=useState<'portfolio'|'projects'|'methodology'|'workspace'>(()=>routeProjectId?'workspace':'portfolio');
  const [selectedProjectId,setSelectedProjectId]=useState<string|null>(()=>routeProjectId??rememberedProject());
  const [workspaceDirty,setWorkspaceDirty]=useState(false);
  const changeTab=(next:'portfolio'|'projects'|'methodology'|'workspace')=>{if(next!==tab&&workspaceDirty&&!window.confirm('Отбросить несохранённые изменения?'))return;rememberProject(next==='workspace'?selectedProjectId:null);setTab(next);navigate.toPluginPanel('factory',next==='workspace'&&selectedProjectId?{subPath:factoryProjectSubPath(selectedProjectId)}:{replace:true});};
  const openProject=(id:string)=>{rememberProject(id);setSelectedProjectId(id);setTab('workspace');navigate.toPluginPanel('factory',{subPath:factoryProjectSubPath(id)});};
  useEffect(()=>{
    if(!routeProjectId)return;
    if(routeProjectId!==selectedProjectId&&workspaceDirty&&!window.confirm('Отбросить несохранённые изменения и открыть другой проект?')){if(selectedProjectId)navigate.toPluginPanel('factory',{subPath:factoryProjectSubPath(selectedProjectId),replace:true});return;}
    rememberProject(routeProjectId);setSelectedProjectId(routeProjectId);setTab('workspace');
  },[routeProjectId]);
  const [name,setName]=useState('');
  const [mode,setMode]=useState<'new'|'existing'>('new');
  const [repository,setRepository]=useState('');
  const [baseline,setBaseline]=useState('');
  const [catalog,setCatalog]=useState<Catalog|null>(null);
  const [catalogQuery,setCatalogQuery]=useState('');
  const [catalogOffset,setCatalogOffset]=useState(0);
  const [catalogTick,setCatalogTick]=useState(0);
  const [catalogLoading,setCatalogLoading]=useState(false);
  const [catalogError,setCatalogError]=useState('');
  const [manualRepository,setManualRepository]=useState(false);
  const [selectedCatalog,setSelectedCatalog]=useState<CatalogEntry|null>(null);
  const catalogRequest=useRef(0);
  const [revision,setRevision]=useState('');
  const [path,setPath]=useState('');
  const [content,setContent]=useState('');
  const [original,setOriginal]=useState('');
  const [loadingFile,setLoadingFile]=useState(false);
  const request=useRef(0);
  const refreshRequest=useRef(0);
  const report=useCallback((cause:unknown)=>setError(cause instanceof Error?cause.message:String(cause)),[]);
  const refresh=useCallback(()=>{const ticket=++refreshRequest.current;Promise.all([rpc.call('projects_list',{limit:20,offset}),rpc.call('methodology_info')]).then(([p,m])=>{if(ticket!==refreshRequest.current)return;if(offset>0&&offset>=p.total){setOffset(Math.max(0,Math.floor((p.total-1)/20)*20));return;}setProjects(p.projects);setTotal(p.total);setInfo(m);setRevision(prev=>prev||m.head.id);setLoaded(true);},report);},[rpc,report,offset]);
  useEffect(refresh,[refresh]);
  useRealtime('factory-changed',refresh);
  useEffect(()=>{
    if(mode!=='existing'||manualRepository){setCatalogLoading(false);return;}
    const ticket=++catalogRequest.current;
    setCatalogLoading(true);setCatalogError('');
    const timer=setTimeout(()=>{
      rpc.call('projects_discover',{limit:20,offset:catalogOffset,query:catalogQuery}).then(result=>{
        if(ticket!==catalogRequest.current)return;
        if(!result.error&&catalogOffset>0&&catalogOffset>=result.total){setCatalogOffset(Math.max(0,Math.floor((result.total-1)/20)*20));return;}
        setCatalog(result);setCatalogError(result.error??'');
      },cause=>{if(ticket===catalogRequest.current)setCatalogError(cause instanceof Error?cause.message:String(cause));})
      .finally(()=>{if(ticket===catalogRequest.current)setCatalogLoading(false);});
    },150);
    return ()=>{clearTimeout(timer);catalogRequest.current++;};
  },[rpc,mode,manualRepository,catalogQuery,catalogOffset,catalogTick]);
  const run=async(fn:()=>Promise<unknown>)=>{if(pending)return;setPending(true);setError('');try{await fn();refresh();}catch(e){report(e);}finally{setPending(false);}};
  const create=(e:FormEvent)=>{e.preventDefault();void run(async()=>{const created=await rpc.call('projects_create',{name,mode,repository,baseline});openProject(created.id);setName('');setRepository('');setBaseline('');setSelectedCatalog(null);setManualRepository(false);});};
  const loadFile=async(rev:string,nextPath:string)=>{
    if(content!==original&&!window.confirm('Отбросить несохранённые изменения?'))return;
    const ticket=++request.current;
    setFileReadSucceeded(false);setRevision(rev);setPath(nextPath);setContent('');setOriginal('');
    if(!nextPath){setLoadingFile(false);return;}
    setLoadingFile(true);
    try{const f=await rpc.call('methodology_file',{revision:rev,path:nextPath});if(ticket===request.current){setContent(f.content);setOriginal(f.content);setFileReadSucceeded(true);}}
    catch(e){if(ticket===request.current)report(e);}finally{if(ticket===request.current)setLoadingFile(false);}
  };
  const active=info?.revisions.find(r=>r.id===revision);
  return <div className="h-full min-h-0 flex-1 overflow-y-auto"><main className="mx-auto w-full max-w-7xl space-y-5 px-5 py-5">
    <header><h1 className="text-xl font-semibold">Фабрика софта</h1><p className="mt-1 text-sm text-muted-foreground">Единый подход к новым продуктам и доработке существующих.</p></header>
    <div className="rounded-lg border border-border bg-card p-4 text-sm">Откройте проект, чтобы вести его паспорт, джобы, инициативы, задачи и приёмку. Внутри проекта можно запустить первичный разбор кода и документов агентом. Полный цикл разработки и синхронизация с командой Meeseeks ещё не подключены.</div>
    <nav className="flex flex-wrap gap-2"><Button variant={tab==='portfolio'?'default':'outline'} onClick={()=>changeTab('portfolio')}>Обзор портфеля</Button><Button variant={tab==='projects'?'default':'outline'} onClick={()=>changeTab('projects')}>Каталог и настройки ({total})</Button><Button variant={tab==='methodology'?'default':'outline'} onClick={()=>changeTab('methodology')}>Методология и скиллы</Button>{selectedProjectId&&<Button variant={tab==='workspace'?'default':'outline'} onClick={()=>changeTab('workspace')}>Рабочее пространство проекта</Button>}</nav>
    {error&&<p ref={errorRef} role="alert" className="text-sm text-destructive">{error}</p>}
    {tab==='portfolio'?<Portfolio onOpen={openProject} onConnect={()=>setTab('projects')} onDirtyChange={setWorkspaceDirty}/>:!loaded?<p role="status">Загрузка…</p>:tab==='workspace'&&selectedProjectId?<ProjectWorkspace key={selectedProjectId} projectId={selectedProjectId} onDirtyChange={setWorkspaceDirty} onBack={()=>{rememberProject(null);setTab('portfolio');navigate.toPluginPanel('factory',{replace:true});}} onRules={(rev,source)=>{rememberProject(null);setTab('methodology');navigate.toPluginPanel('factory',{replace:true});void loadFile(rev,source);}}/>:tab==='projects'?<>
      <details open={total===0} className="rounded-lg border border-border p-4"><summary className="cursor-pointer font-medium">Добавить проект</summary><form onSubmit={create} className="mt-3 space-y-3">
        <label className="block text-sm">Название<Input aria-label="Название проекта" value={name} onChange={e=>setName(e.target.value)} maxLength={120} required/></label>
        <label className="block text-sm">Вход в фабрику<select className={field} value={mode} onChange={e=>{setMode(e.target.value as 'new'|'existing');setSelectedCatalog(null);setRepository('');setManualRepository(false);}}><option value="new">Новый продукт</option><option value="existing">Существующий продукт</option></select></label>
        {mode==='existing'&&<Button type="button" variant="outline" aria-pressed={manualRepository} onClick={()=>{if(manualRepository)setRepository(selectedCatalog?.canonicalPath??'');setManualRepository(value=>!value);}}>{manualRepository?'Выбрать из каталога проектов':'Указать путь или URL вручную'}</Button>}
        {mode==='existing'&&!manualRepository&&<div className="space-y-2 rounded-md border border-border p-3">
          <p className="break-all text-xs text-muted-foreground">Источник: {catalog?.root??'~/Desktop/Проекты разработка'}{catalog?.canonicalRoot&&catalog.canonicalRoot!==catalog.root?' → '+catalog.canonicalRoot:''}</p>
          <div className="flex gap-2"><Input aria-label="Поиск проекта на диске" placeholder="Найти проект по имени или пути" value={catalogQuery} onChange={e=>{setCatalogQuery(e.target.value);setCatalogOffset(0);}} maxLength={200}/><Button type="button" variant="outline" onClick={()=>setCatalogTick(value=>value+1)} disabled={catalogLoading}>Обновить список</Button></div>
          {catalogError&&<p role="alert" className="text-sm text-destructive">{catalogError}</p>}
          {catalogLoading&&<p role="status" className="text-xs">Чтение каталогов…</p>}
          <label className="block text-sm">Проект на диске<select className={field} aria-label="Проект на диске" value={selectedCatalog?.canonicalPath??''} disabled={catalogLoading||!!catalogError} onChange={e=>{const entry=catalog?.entries.find(item=>item.canonicalPath===e.target.value)??null;setSelectedCatalog(entry);setRepository(entry?.canonicalPath??'');if(entry)setName(entry.name.slice(0,120));}}><option value="">Выберите каталог проекта</option>{selectedCatalog&&!catalog?.entries.some(item=>item.canonicalPath===selectedCatalog.canonicalPath)&&<option value={selectedCatalog.canonicalPath}>{selectedCatalog.name} (выбран)</option>}{catalog?.entries.map(entry=><option key={entry.canonicalPath} value={entry.canonicalPath}>{entry.name}{projects.some(project=>project.repository===entry.canonicalPath)?' · подключён':''}</option>)}</select></label>
          <div className="flex items-center gap-2"><Button type="button" variant="outline" disabled={catalogLoading||catalogOffset===0} onClick={()=>setCatalogOffset(Math.max(0,catalogOffset-20))}>Назад</Button><span className="text-xs">Найдено: {catalog?.total??0}. Страница {Math.floor(catalogOffset/20)+1}</span><Button type="button" variant="outline" disabled={catalogLoading||!catalog||catalogOffset+20>=catalog.total} onClick={()=>setCatalogOffset(catalogOffset+20)}>Далее</Button></div>
          {catalog?.warnings.map(warning=><p key={warning} className="break-all text-xs text-muted-foreground">{warning}</p>)}
          <p className="text-xs text-muted-foreground">Читаются только названия и пути каталогов. Карточка создаётся после выбора и заполнения исходного состояния.</p>
        </div>}
        <label className="block text-sm">Репозиторий: путь или URL<Input value={repository} onChange={e=>setRepository(e.target.value)} maxLength={1500} readOnly={mode==='existing'&&!manualRepository} required={mode==='existing'}/></label>
        <label className="block text-sm">{mode==='existing'?'Исходное состояние: что работает, где документация и тесты':'Замысел и контекст'}<textarea className={field} rows={3} value={baseline} onChange={e=>setBaseline(e.target.value)} maxLength={12000} required={mode==='existing'}/></label>
        <p className="text-xs text-muted-foreground">Описание заполняется вручную. Фабрика сохраняет контекст; код репозитория пока не анализируется.</p>
        <Button type="submit" disabled={pending||!name.trim()||(mode==='existing'&&!manualRepository&&(!selectedCatalog||!!catalogError))}>Добавить проект</Button>
      </form></details>
      <div className="flex items-center gap-3"><Button variant="outline" disabled={offset===0||pending} onClick={()=>setOffset(Math.max(0,offset-20))}>Назад</Button><span className="text-xs">{total?offset+1:0}–{Math.min(offset+20,total)} из {total}</span><Button variant="outline" disabled={offset+20>=total||pending} onClick={()=>setOffset(offset+20)}>Далее</Button></div>
      {!projects.length&&<p className="text-muted-foreground">Добавьте новый продукт или подключите текущий.</p>}
      {projects.map(p=><article key={p.id} className="space-y-3 rounded-lg border border-border p-4"><div className="flex justify-between gap-3"><button className="text-left text-lg font-medium hover:underline" onClick={()=>openProject(p.id)}>{p.name}</button><span className="text-xs text-muted-foreground">{p.mode==='new'?'Новый':'Существующий'}</span></div><p className="break-all text-sm">{p.repository||'Репозиторий ещё не указан'}</p><p className="whitespace-pre-wrap text-sm text-muted-foreground">{p.baseline}</p>
        <label className="block text-sm">Переход на фабрику<select className={field} value={p.adoption} disabled={pending} onChange={e=>void run(()=>rpc.call('projects_update',{id:p.id,expectedUpdatedAt:p.updatedAt,revision:p.revision,adoption:e.target.value as Project['adoption']}))}>{Object.entries(adoptionLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
        <label className="block text-sm">Закреплённая версия методологии<select className={field} value={p.revision} disabled={pending} onChange={e=>{const next=e.target.value;if(window.confirm('Перевести проект на выбранную версию методологии?'))void run(()=>rpc.call('projects_update',{id:p.id,expectedUpdatedAt:p.updatedAt,revision:next,adoption:p.adoption}));}}>{info?.revisions.map(r=><option key={r.id} value={r.id}>{r.id.slice(0,12)} · {r.source}</option>)}</select></label>
        {editing?.id===p.id&&<form className="space-y-2" onSubmit={e=>{e.preventDefault();void run(async()=>{await rpc.call('projects_update',{id:editing.id,expectedUpdatedAt:editing.updatedAt,revision:editing.revision,adoption:editing.adoption,name:editing.name,repository:editing.repository,baseline:editing.baseline});setEditing(null);});}}><label className="block text-sm">Название<Input value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})} maxLength={120} required/></label><label className="block text-sm">Репозиторий<Input value={editing.repository} onChange={e=>setEditing({...editing,repository:e.target.value})} maxLength={1500} required={editing.mode==='existing'}/></label><label className="block text-sm">Контекст и исходное состояние<textarea className={field} rows={4} value={editing.baseline} onChange={e=>setEditing({...editing,baseline:e.target.value})} maxLength={12000} required={editing.mode==='existing'}/></label><div className="flex gap-2"><Button type="submit" disabled={pending}>Сохранить карточку</Button><Button type="button" variant="outline" onClick={()=>setEditing(null)}>Отмена</Button></div></form>}
        <div className="flex flex-wrap gap-2"><Button disabled={pending} onClick={()=>openProject(p.id)}>Открыть проект</Button><Button variant="outline" disabled={pending} onClick={()=>setEditing(p)}>Редактировать карточку</Button><Button variant="outline" onClick={()=>{setTab('methodology');void loadFile(p.revision,'');}}>Открыть правила проекта</Button><Button variant="ghost" disabled={pending} onClick={()=>{if(window.confirm('Удалить карточку проекта и историю её записей? Репозиторий сохранится. Если в проекте есть активные записи, удаление будет отклонено.'))void run(async()=>{await rpc.call('projects_remove',{id:p.id,discardHistory:true});if(selectedProjectId===p.id){setSelectedProjectId(null);rememberProject(null);}});}}>Удалить карточку</Button></div>
      </article>)}
    </>:<section className="space-y-3"><p className="text-sm text-muted-foreground">Пакет содержит методологию, скиллы, скрипты и инструкции агентов. Сохранение создаёт новую версию; проекты сохраняют закреплённую версию до явного переключения.</p>
      <label className="block text-sm">Версия пакета<select className={field} value={revision} onChange={e=>void loadFile(e.target.value,'')} disabled={pending}>{info?.revisions.map(r=><option key={r.id} value={r.id}>{r.id.slice(0,12)} · {r.files.length} файлов · {r.source}{r.id===info.head.id?' · текущая':''}</option>)}</select></label>
      <div className="grid gap-4 md:grid-cols-[270px_1fr]"><div className="max-h-[560px] overflow-y-auto rounded-lg border border-border">{active?.files.map(f=><button key={f.path} className={'block w-full break-all border-b border-border px-3 py-2 text-left text-xs hover:bg-accent '+(path===f.path?'bg-accent':'')} onClick={()=>void loadFile(revision,f.path)} disabled={pending}>{f.path}</button>)}</div><div className="space-y-3">{path?<><p className="break-all font-mono text-xs">{path}</p><textarea aria-label="Содержимое файла" className={field+' min-h-[450px] font-mono text-xs'} value={content} disabled={!fileReadSucceeded||loadingFile||pending||revision!==info?.head.id} onChange={e=>setContent(e.target.value)}/><Button disabled={!fileReadSucceeded||pending||loadingFile||content===original||revision!==info?.head.id} onClick={()=>void run(async()=>{const r=await rpc.call('methodology_edit',{expectedRevision:revision,path,content});setRevision(r.id);setOriginal(content);})}>Сохранить новую версию</Button>{revision!==info?.head.id&&<p className="text-xs text-muted-foreground">Историческая версия доступна для чтения. Для правки выберите текущую.</p>}</>:<p className="text-sm text-muted-foreground">Выберите файл.</p>}</div></div>
    </section>}
  </main></div>;
}
export default definePluginApp(app=>{
  app.slots.navPanel({id:'factory',title:'Фабрика софта',icon:'Layers',path:'factory',component:FactoryPage});
  app.slots.experimental_threadContextCardSection({id:'factory-project',title:'Фабрика софта',group:experimental_THREAD_INFO_SECTION_GROUPS.related,order:30,component:FactoryThreadContextCard});
  app.slots.experimental_threadContextSegment({id:'factory-project',title:'Фабрика софта',group:experimental_THREAD_CONTEXT_SEGMENT_GROUPS.thread,order:30,summary:FactoryThreadBanner,useVisible:useFactoryThreadBannerVisible});
});
