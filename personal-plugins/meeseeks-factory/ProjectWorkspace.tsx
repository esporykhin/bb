import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, Project } from './server';
import type { Artifact, ArtifactKind } from './workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { groups, kindLabel, sectionFor, sections } from './workspace-profile';
import { AnalysisPanel } from './AnalysisPanel';

const field='w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
type Draft={id?:string;version?:number;kind:string;title:string;fields:Record<string,string>;links:{type:string;targetId:string}[];status:'draft'|'accepted'};
type Target={id:string;kind:string;title:string};
function TargetPicker({projectId,kind,onAdd,disabled}:{projectId:string;kind:string;onAdd:(type:string,target:Target)=>void;disabled:boolean}){
  const rpc=useRpc<typeof rpcContract>();
  const definition=sectionFor(kind);
  const [type,setType]=useState(definition?.links[0]?.[0]??'');
  const allowed=definition?.links.find(l=>l[0]===type)?.[2]??[];
  const [targetKind,setTargetKind]=useState(allowed[0]??'');
  const [query,setQuery]=useState('');
  const [offset,setOffset]=useState(0);
  const [targets,setTargets]=useState<Target[]>([]);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(true);
  const [loadedKey,setLoadedKey]=useState<string|null>(null);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const requestKey=JSON.stringify([projectId,type,targetKind,query,offset,retry]);
  const ready=loadedKey===requestKey&&!loading;
  const currentError=loadedKey===requestKey?error:'';
  useEffect(()=>{
    if(!type)return;
    let active=true;setLoading(true);setError('');
    const timer=setTimeout(()=>{rpc.call('workspace_targets',{projectId,query,limit:50,offset,...(targetKind?{kind:targetKind as ArtifactKind}:{})}).then(result=>{if(active){setTargets(result.entries);setTotal(result.total);setLoadedKey(requestKey);}},e=>{if(active){setError(message(e));setLoadedKey(requestKey);}}).finally(()=>{if(active)setLoading(false);});},150);
    return()=>{active=false;clearTimeout(timer);};
  },[rpc,projectId,type,targetKind,query,offset,retry,requestKey]);
  if(!definition?.links.length)return null;
  return <fieldset className="space-y-2 rounded-md border border-border p-3" disabled={disabled}><legend className="px-1 text-sm">Добавить связь</legend>
    <label className="block text-xs">Вид связи<select className={field} value={type} onChange={e=>{const next=definition.links.find(l=>l[0]===e.target.value);setType(e.target.value);setTargetKind(next?.[2][0]??'');setOffset(0);}}>{definition.links.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
    <label className="block text-xs">Раздел цели<select className={field} value={targetKind} onChange={e=>{setTargetKind(e.target.value);setOffset(0);}}>{!allowed.length&&<option value="">Все разделы</option>}{sections.filter(s=>!allowed.length||allowed.includes(s.kind)).map(s=><option value={s.kind} key={s.kind}>{s.label}</option>)}</select></label>
    <Input aria-label="Поиск цели связи" placeholder="Поиск записи для связи" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);}} maxLength={200}/>
    {currentError?<div role="alert" className="text-sm text-destructive">{currentError}<Button type="button" variant="outline" onClick={()=>setRetry(n=>n+1)}>Повторить</Button></div>:!ready?<p role="status" className="text-xs">Поиск записей…</p>:<select aria-label="Цель связи" className={field} value="" onChange={e=>{const target=targets.find(t=>t.id===e.target.value);if(target)onAdd(type,target);}}><option value="">{targets.length?'Выберите запись — связь добавится':'Нет записей. Сначала создайте цель в её разделе.'}</option>{targets.map(t=><option key={t.id} value={t.id}>{kindLabel(t.kind)} · {t.title}</option>)}</select>}
    {ready&&!currentError&&total>50&&<div className="flex items-center gap-2"><Button type="button" variant="outline" disabled={offset===0||loading} onClick={()=>setOffset(Math.max(0,offset-50))}>Назад</Button><span className="text-xs">{offset+1}–{Math.min(offset+50,total)} из {total}</span><Button type="button" variant="outline" disabled={offset+50>=total||loading} onClick={()=>setOffset(offset+50)}>Далее</Button></div>}
  </fieldset>;
}

function ArtifactHistory({projectId,id,version}:{projectId:string;id:string;version:number}){
  const rpc=useRpc<typeof rpcContract>();
  const [open,setOpen]=useState(false);
  const [entries,setEntries]=useState<Artifact[]>([]);
  const [offset,setOffset]=useState(0);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!open)return;
    let active=true;setLoading(true);setError('');
    rpc.call('artifact_history',{projectId,id,limit:20,offset}).then(result=>{if(active){setEntries(result.entries);setTotal(result.total);}},e=>{if(active)setError(message(e));}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[rpc,projectId,id,version,open,offset,retry]);
  return <details className="rounded-md border border-border p-3" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">История изменений</summary><p className="mt-2 text-xs text-muted-foreground">Сохранённые версии доступны только для чтения. Просмотр истории не меняет текущую запись или текст редактора.</p>
    {error?<div className="mt-2 text-sm text-destructive" role="alert">{error}<Button type="button" variant="outline" onClick={()=>setRetry(value=>value+1)}>Повторить</Button></div>:loading?<p className="mt-2 text-xs" role="status">Загрузка истории…</p>:!entries.length?<p className="mt-2 text-xs text-muted-foreground">Сохранённых версий пока нет.</p>:<div className="mt-3 space-y-2">{entries.map(item=><details key={item.version} className="rounded border border-border p-3"><summary className="cursor-pointer text-sm">Версия {item.version} · {new Date(item.updatedAt).toLocaleString('ru-RU')}</summary><dl className="mt-3 space-y-3 text-sm"><div><dt className="text-xs text-muted-foreground">Название</dt><dd>{item.title}</dd></div><div><dt className="text-xs text-muted-foreground">Заполнение</dt><dd>{item.status==='draft'?'Черновик':'Подтверждено вручную'}</dd></div>{Object.entries(item.fields).map(([key,value])=><div key={key}><dt className="text-xs text-muted-foreground">{sectionFor(item.kind)?.fields.find(([name])=>name===key)?.[1]??key}</dt><dd className="whitespace-pre-wrap break-words">{value||'Не заполнено'}</dd></div>)}<div><dt className="text-xs text-muted-foreground">Связи</dt><dd>{!item.links.length?'Нет связей':<ul className="space-y-1">{item.links.map((link,index)=><li key={index} className="break-all">{sectionFor(item.kind)?.links.find(([name])=>name===link.type)?.[1]??link.type} → {link.targetId}</li>)}</ul>}</dd></div></dl></details>)}</div>}
    {total>20&&<div className="mt-3 flex items-center gap-2"><Button type="button" variant="outline" disabled={loading||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>Назад</Button><span className="text-xs">{offset+1}–{Math.min(offset+20,total)} из {total}</span><Button type="button" variant="outline" disabled={loading||offset+20>=total} onClick={()=>setOffset(offset+20)}>Далее</Button></div>}
  </details>;
}

export function ProjectWorkspace({projectId,onBack,onRules,onDirtyChange}:{projectId:string;onBack:()=>void;onRules:(revision:string,path:string)=>void;onDirtyChange:(dirty:boolean)=>void}){
  const rpc=useRpc<typeof rpcContract>();
  const [project,setProject]=useState<Project|null>(null);
  const [kind,setKind]=useState('passport');
  const [entries,setEntries]=useState<Artifact[]>([]);
  const [counts,setCounts]=useState<Record<string,number>>({});
  const [total,setTotal]=useState(0);
  const [offset,setOffset]=useState(0);
  const [warnings,setWarnings]=useState<string[]>([]);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [original,setOriginal]=useState('');
  const [targets,setTargets]=useState<Record<string,Target>>({});
  const [error,setError]=useState('');
  const errorRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(error)errorRef.current?.scrollIntoView({block:'center'});},[error]);
  const [loading,setLoading]=useState(true);
  const [loadedKey,setLoadedKey]=useState<string|null>(null);
  const [loadError,setLoadError]=useState('');
  const [errorKey,setErrorKey]=useState<string|null>(null);
  const [detailLoading,setDetailLoading]=useState(false);
  const [pending,setPending]=useState(false);
  const [tick,setTick]=useState(0);
  const requestKey=JSON.stringify([projectId,kind,offset,tick]);
  const ready=loadedKey===requestKey&&!loading;
  const currentLoadError=errorKey===requestKey?loadError:'';
  const request=useRef(0);
  const detailRequest=useRef(0);
  const editorRef=useRef<HTMLFormElement>(null);
  useEffect(()=>{if(draft)editorRef.current?.scrollIntoView({block:'start'});},[draft?.id,draft?.kind,!!draft]);
  const dirty=!!draft&&JSON.stringify(draft)!==original;
  const active=sectionFor(kind);
  const count=Object.values(counts).reduce((n,value)=>n+value,0);
  useEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty,onDirtyChange]);
  useEffect(()=>{
    const ticket=++request.current;setLoading(true);setLoadError('');setErrorKey(null);
    rpc.call('workspace_get',{projectId,kind:kind as ArtifactKind,limit:20,offset}).then(result=>{
      if(ticket!==request.current)return;
      if(offset>0&&offset>=result.total){setOffset(Math.max(0,Math.floor((result.total-1)/20)*20));return;}
      setProject(result.project);setEntries(result.entries);setCounts(result.counts);setTotal(result.total);setWarnings(result.warnings);setLoadedKey(requestKey);
    },cause=>{if(ticket===request.current){setLoadError(message(cause));setErrorKey(requestKey);}}).finally(()=>{if(ticket===request.current)setLoading(false);});
    return()=>{request.current++;};
  },[rpc,projectId,kind,offset,tick,requestKey]);
  const changed=useCallback(()=>setTick(n=>n+1),[]);
  useRealtime('factory-changed',changed);
  const discard=()=>!dirty||window.confirm('Отбросить несохранённые изменения записи?');
  const clear=()=>{detailRequest.current++;setDraft(null);setOriginal('');setTargets({});setDetailLoading(false);};
  const chooseKind=(next:string)=>{if(pending||!discard())return;clear();setKind(next);setOffset(0);setError('');};
  const openArtifact=async(id:string)=>{
    if(pending||!discard())return;
    const ticket=++detailRequest.current;setDetailLoading(true);setDraft(null);setOriginal('');setError('');
    try{
      const {artifact:a}=await rpc.call('artifact_get',{projectId,id});
      if(ticket!==detailRequest.current)return;
      const next:Draft={id:a.id,version:a.version,kind:a.kind,title:a.title,fields:a.fields,links:a.links,status:a.status};
      setKind(a.kind);setOffset(0);setDraft(next);setOriginal(JSON.stringify(next));setTargets({});
      const results=await Promise.all(a.links.map(async link=>{try{const result=await rpc.call('artifact_get',{projectId,id:link.targetId});return result.artifact;}catch{return null;}}));
      if(ticket===detailRequest.current)setTargets(Object.fromEntries(results.filter((a):a is Artifact=>a!==null).map(a=>[a.id,{id:a.id,kind:a.kind,title:a.title}])));
    }catch(e){if(ticket===detailRequest.current)setError(message(e));}finally{if(ticket===detailRequest.current)setDetailLoading(false);}
  };
  const start=()=>{if(pending||!discard())return;clear();const next:Draft={kind,title:kind==='passport'?(project?.name??'Паспорт проекта'):'',fields:{},links:[],status:'draft'};setDraft(next);setOriginal(JSON.stringify(next));};
  const save=async()=>{
    if(!draft||pending)return;setPending(true);setError('');
    try{
      const result=draft.id?await rpc.call('artifact_update',{projectId,id:draft.id,expectedVersion:draft.version!,title:draft.title,fields:draft.fields,links:draft.links,status:draft.status}):await rpc.call('artifact_create',{projectId,kind:draft.kind as ArtifactKind,title:draft.title,fields:draft.fields,links:draft.links});
      const a=result.artifact;const next:Draft={id:a.id,version:a.version,kind:a.kind,title:a.title,fields:a.fields,links:a.links,status:a.status};setDraft(next);setOriginal(JSON.stringify(next));setTick(n=>n+1);
    }catch(e){setError(message(e));}finally{setPending(false);}
  };
  const remove=async(a:Artifact)=>{
    if(pending||!discard()||!window.confirm('Удалить запись «'+a.title+'»? Связанную или журнальную запись удалить нельзя.'))return;
    setPending(true);setError('');
    try{await rpc.call('artifact_remove',{projectId,id:a.id,expectedVersion:a.version});if(draft?.id===a.id)clear();setTick(n=>n+1);}catch(e){setError(message(e));}finally{setPending(false);}
  };
  const fieldWarnings=()=>{
    if(!draft)return[];
    const result:string[]=[];
    if(draft.kind==='task'&&draft.links.filter(l=>l.type==='root').length!==1)result.push('У задачи должен быть ровно один корень — инициатива. Пока это незавершённый черновик.');
    if(draft.kind==='story'&&!draft.links.some(l=>l.type==='role'))result.push('Роль стори ещё не указана.');
    if(['subtask','slice'].includes(draft.kind)&&!draft.links.some(l=>l.type==='parent'))result.push('Связь с задачей ещё не указана.');
    if(draft.kind==='initiative'&&!draft.links.some(l=>l.type==='solves_job'))result.push('Джоба не указана. Для технической инициативы отсутствие джобы допустимо; основание нужно описать.');
    return result;
  };
  return <section className="space-y-4" aria-label="Рабочее пространство проекта">
    <header className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" disabled={pending} onClick={()=>{if(discard())onBack();}}>← Все проекты</Button><Button variant="outline" disabled={pending} onClick={()=>setTick(n=>n+1)}>Обновить данные проекта</Button></div><h2 className="text-2xl font-semibold">{project?.name??'Проект'}</h2><p className="break-all text-sm text-muted-foreground">{project?.repository}</p><p className="text-xs text-muted-foreground">Версия методологии: {project?.revision.slice(0,12)??'…'} · {ready?count:'…'} записей · данные этого проекта</p></header>
    <AnalysisPanel project={project} disabled={pending} onImported={changed} onOpenArtifact={id=>void openArtifact(id)} beforeThreadOpen={discard}/>
    <div className="rounded-lg border border-border bg-card p-4 text-sm"><strong>Рабочий контур проекта.</strong> Начните с паспорта, аудитории и джоб, затем опишите выбранные инициативы и работу. Уровни заполняются там, где есть выбор. Первичный разбор запускается кнопкой выше и добавляет черновики с источниками. Ручное подтверждение записей и запуск полного цикла разработки остаются отдельными шагами.</div>
    {(error||currentLoadError)&&<div ref={errorRef} role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error||currentLoadError}<p className="mt-1 text-xs">При конфликте сохранения ваш текст остаётся в редакторе. Скопируйте его перед повторным открытием актуальной записи.</p></div>}
    <div className="grid gap-5 lg:grid-cols-[235px_minmax(0,1fr)]">
      <nav aria-label="Разделы методологии" className="space-y-4 rounded-lg border border-border p-3">{groups.map(group=><div key={group}><p className="mb-1 text-xs font-semibold text-muted-foreground">{group}</p>{sections.filter(s=>s.group===group).map(s=><button key={s.kind} className={'flex w-full items-center justify-between gap-2 rounded px-2 py-2 text-left text-sm '+(kind===s.kind?'bg-accent font-medium':'hover:bg-accent')} onClick={()=>chooseKind(s.kind)} disabled={pending}><span>{s.label}{s.optional?' · необяз.':''}</span><span className="rounded bg-muted px-1.5 text-xs">{ready?(counts[s.kind]??0):'…'}</span></button>)}</div>)}{Object.keys(counts).filter(value=>!sectionFor(value)).length>0&&<div><p className="text-xs font-semibold text-muted-foreground">Другие разделы пакета</p>{Object.keys(counts).filter(value=>!sectionFor(value)).map(value=><button key={value} className="block w-full px-2 py-2 text-left text-sm" disabled={pending} onClick={()=>chooseKind(value)}>{value} · {ready?counts[value]:'…'}</button>)}</div>}</nav>
      <div className="min-w-0 space-y-4"><header className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xl font-medium">{active?.label??kind}</h3><Button disabled={!active||pending||!ready||(['passport','offer'].includes(kind)&&(counts[kind]??0)>0)} onClick={start}>{kind==='passport'?'Заполнить паспорт':'Добавить запись'}</Button></div><p className="text-sm text-muted-foreground">{active?.description}</p>{project&&active&&<button className="text-xs text-primary underline underline-offset-2" onClick={()=>{if(discard())onRules(project.revision,active.skill);}}>Правила раздела из закреплённой версии</button>}</header>
      {kind==='passport'&&project?.baseline&&<details className="rounded-md border border-border p-3" open><summary className="text-sm font-medium">Исходный контекст из карточки проекта</summary><p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{project.baseline}</p></details>}
      {ready&&warnings.length>0&&<details className="rounded-md border border-border p-3"><summary className="text-sm">Замечания к структуре ({warnings.length})</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{warnings.map((value,index)=><li key={index}>{value}</li>)}</ul></details>}
      {currentLoadError?<p className="text-sm text-muted-foreground">Не удалось прочитать раздел. Нажмите «Обновить данные проекта», чтобы повторить.</p>:!ready?<p role="status">Загрузка раздела…</p>:!entries.length?<div className="rounded-lg border border-dashed border-border p-5"><p className="font-medium">{active?.label??kind}: записей пока нет</p><p className="mt-2 text-sm text-muted-foreground">{active?.description} Добавьте первую запись, когда появятся исходные данные. Пустой раздел не заполняется догадками.</p><Button className="mt-3" disabled={pending} onClick={start}>{kind==='passport'?'Заполнить паспорт':'Добавить первую запись'}</Button></div>:<div className="space-y-2">{entries.map(a=><article key={a.id} className={'rounded-lg border p-3 '+(draft?.id===a.id?'border-primary':'border-border')}><div className="flex flex-wrap items-start justify-between gap-2"><button className="text-left font-medium underline-offset-2 hover:underline" onClick={()=>void openArtifact(a.id)} disabled={pending}>{a.title}</button><span className="text-xs text-muted-foreground">{a.status==='draft'?'Черновик':'Подтверждено вручную'} · v{a.version}</span></div><p className="mt-1 text-xs text-muted-foreground">{a.links.length} связей · {Object.values(a.fields).filter(Boolean).length} заполненных полей</p><div className="mt-2 flex gap-2"><Button variant="outline" disabled={pending} onClick={()=>void openArtifact(a.id)}>Открыть запись</Button>{!['decision','fork','adr'].includes(a.kind)&&<Button variant="ghost" disabled={pending} onClick={()=>void remove(a)}>Удалить</Button>}</div></article>)}</div>}
      {ready&&total>20&&<div className="flex items-center gap-2"><Button variant="outline" disabled={pending||loading||offset===0} onClick={()=>{if(discard()){clear();setOffset(Math.max(0,offset-20));}}}>Назад</Button><span className="text-xs">{offset+1}–{Math.min(offset+20,total)} из {total}</span><Button variant="outline" disabled={pending||loading||offset+20>=total} onClick={()=>{if(discard()){clear();setOffset(offset+20);}}}>Далее</Button></div>}
      {detailLoading&&<p role="status">Открытие записи…</p>}
      {draft&&<form ref={editorRef} className="space-y-4 rounded-lg border border-primary p-4" onSubmit={e=>{e.preventDefault();void save();}} aria-label="Редактор записи"><div className="flex justify-between gap-2"><h4 className="font-medium">{draft.id?'Редактирование':'Новая запись'} · {kindLabel(draft.kind)}</h4>{dirty&&<span className="text-xs text-muted-foreground">Есть несохранённые изменения</span>}</div><label className="block text-sm">Название<Input value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})} maxLength={200} required disabled={pending}/></label>
        {(sectionFor(draft.kind)?.fields??[]).map(([key,label])=><label className="block text-sm" key={key}>{label}<textarea className={field} rows={key==='body'?10:3} maxLength={12000} value={draft.fields[key]??''} disabled={pending} onChange={e=>setDraft({...draft,fields:{...draft.fields,[key]:e.target.value}})}/></label>)}
        {Object.entries(draft.fields).filter(([key])=>!sectionFor(draft.kind)?.fields.some(([known])=>known===key)).map(([key,value])=><label key={key} className="block text-sm">Дополнительное поле: {key}<textarea className={field} rows={3} value={value} disabled={pending} onChange={e=>setDraft({...draft,fields:{...draft.fields,[key]:e.target.value}})}/></label>)}
        <div className="space-y-2"><h5 className="text-sm font-medium">Связи и прослеживаемость</h5>{!draft.links.length&&<p className="text-xs text-muted-foreground">Связи ещё не добавлены.</p>}{draft.links.map((link,index)=><div key={link.type+link.targetId+index} className="flex items-center justify-between gap-2 rounded border border-border p-2 text-xs"><span>{sectionFor(draft.kind)?.links.find(l=>l[0]===link.type)?.[1]??link.type} → <button type="button" className="underline underline-offset-2" disabled={pending} onClick={()=>void openArtifact(link.targetId)}>{targets[link.targetId]?kindLabel(targets[link.targetId].kind)+' · '+targets[link.targetId].title:link.targetId}</button></span><Button type="button" variant="ghost" disabled={pending} onClick={()=>setDraft({...draft,links:draft.links.filter((_,i)=>i!==index)})}>Убрать</Button></div>)}<TargetPicker key={draft.kind+':'+(draft.id??'new')} projectId={projectId} kind={draft.kind} disabled={pending} onAdd={(type,target)=>{if(target.id===draft.id){setError('Нельзя связать запись с самой собой.');return;}if(draft.links.some(l=>l.type===type&&l.targetId===target.id))return;setTargets(prev=>({...prev,[target.id]:target}));setDraft({...draft,links:[...draft.links,{type,targetId:target.id}]});}}/></div>
        {draft.kind==='task'&&<p className="text-xs text-muted-foreground">Класс задачи: {draft.links.some(l=>l.type==='behavior_frame')?'продуктовая (есть рамка поведения)':'техническая (рамка поведения пуста)'}</p>}
        {fieldWarnings().map(w=><p className="rounded border border-border p-2 text-xs text-muted-foreground" key={w}>{w}</p>)}
        {draft.id&&<label className="block text-sm">Заполнение записи<select className={field} disabled={pending} value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value as Draft['status']})}><option value="draft">Черновик</option><option value="accepted">Подтверждено вручную</option></select></label>}
        {draft.id&&<ArtifactHistory key={draft.id} projectId={projectId} id={draft.id} version={draft.version!}/>}
        <p className="text-xs text-muted-foreground">Ручное подтверждение фиксирует запись в реестре. Оно не означает PASS тестов, мерж PR или достижение цели инициативы.</p>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={pending||!draft.title.trim()||(!!draft.id&&!dirty)}>{pending?'Сохранение…':'Сохранить запись'}</Button><Button type="button" variant="outline" disabled={pending} onClick={()=>{if(discard())clear();}}>Закрыть редактор</Button></div>
      </form>}
      <p className="text-xs text-muted-foreground">Формы — адаптер текущей методологии. Актуальные операционные правила находятся в скиллах закреплённого пакета; редактор не выполняет их автоматически.</p>
      </div>
    </div>
  </section>;
}
