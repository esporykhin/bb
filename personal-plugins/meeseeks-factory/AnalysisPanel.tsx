import { useCallback, useEffect, useRef, useState } from 'react';
import { useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract, Project } from './server';
import type { AnalysisRun } from './analysis-contract';
import { Button } from '@/components/ui/button';
import { analysisStateLabels, readPendingAnalysisRequest, writePendingAnalysisRequest } from './analysis-ui';

const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const time=(value:string)=>new Date(value).toLocaleString('ru-RU');
export function AnalysisPanel({project,disabled,onImported,onOpenArtifact,beforeThreadOpen}:{project:Project|null;disabled:boolean;onImported:()=>void;onOpenArtifact:(id:string)=>void;beforeThreadOpen:()=>boolean}){
  const rpc=useRpc<typeof rpcContract>();
  const navigate=useBbNavigate();
  const projectId=project?.id??null;
  const [entries,setEntries]=useState<AnalysisRun[]>([]);
  const [total,setTotal]=useState(0);
  const [loading,setLoading]=useState(true);
  const [loadedProject,setLoadedProject]=useState<string|null>(null);
  const [readError,setReadError]=useState('');
  const [startError,setStartError]=useState('');
  const [starting,setStarting]=useState(false);
  const [closing,setClosing]=useState<string|null>(null);
  const [notice,setNotice]=useState('');
  const [uncertainRequest,setUncertainRequest]=useState<string|null>(null);
  const [retryRequestId,setRetryRequestId]=useState<string|null>(null);
  const [storageError,setStorageError]=useState('');
  useEffect(()=>{
    if(!projectId){setUncertainRequest(null);setRetryRequestId(null);return;}
    try{const saved=readPendingAnalysisRequest(sessionStorage,projectId);setUncertainRequest(saved);setRetryRequestId(saved);setStorageError('');}
    catch{setStorageError('Не удалось прочитать сохранённый идентификатор разбора. Запуск заблокирован; повторно откройте проект после восстановления хранилища браузера.');}
  },[projectId]);
  const [tick,setTick]=useState(0);
  const ticket=useRef(0);
  const imported=useRef(new Set<string>());
  const refresh=useCallback(()=>setTick(value=>value+1),[]);
  useRealtime('factory-changed',refresh);
  useEffect(()=>{
    if(!projectId)return;
    const request=++ticket.current;setLoading(true);setReadError('');
    const load=async()=>{
      const result=await rpc.call('analysis_runs',{projectId,limit:20,offset:0});
      let resolution:{run:AnalysisRun|null;activeRun:AnalysisRun|null}|null=null;
      let lookupError='';
      if(uncertainRequest){try{resolution=await rpc.call('analysis_lookup',{projectId,requestId:uncertainRequest});}catch(error){lookupError=message(error);}}
      if(request!==ticket.current)return;
      const runs=[...result.entries];
      for(const run of [resolution?.run,resolution?.activeRun])if(run&&!runs.some(value=>value.id===run.id))runs.push(run);
      runs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      setEntries(runs.slice(0,20));setTotal(result.total);setLoadedProject(projectId);
      if(resolution){
        if(!resolution.run){
          setRetryRequestId(uncertainRequest);setStartError('');
          setNotice(resolution.activeRun?'В проекте есть другая задача. Исходный запрос пока не подтверждён; его идентификатор сохранён.':'Запуск пока не найден. Можно повторить тот же запрос; новый идентификатор не создаётся.');
        }else{
          writePendingAnalysisRequest(sessionStorage,projectId,null);setUncertainRequest(null);setRetryRequestId(null);setStartError('');
          if(resolution.run.requestId!==uncertainRequest)setNotice('Запрос связан с существующей задачей проекта; новая не создавалась.');
        }
      }else if(uncertainRequest&&runs.some(run=>run.requestId===uncertainRequest)){
        writePendingAnalysisRequest(sessionStorage,projectId,null);setUncertainRequest(null);setRetryRequestId(null);setStartError('');
      }else if(lookupError){setStartError('Пока не удалось проверить исход запроса: '+lookupError);}
      for(const run of runs){if(run.state==='ready'&&run.importedArtifactIds.length&&!imported.current.has(run.id)){imported.current.add(run.id);onImported();}}
    };
    void load().catch(error=>{if(request===ticket.current)setReadError(message(error));}).finally(()=>{if(request===ticket.current)setLoading(false);});
    return()=>{ticket.current++;};
  },[rpc,projectId,tick,uncertainRequest,onImported]);
  const ready=!!projectId&&loadedProject===projectId&&!loading&&!readError;
  const latest=loadedProject===projectId?entries[0]:undefined;
  const inProgress=entries.some(run=>run.state==='pending'||run.state==='running');
  const needsAttention=entries.some(run=>run.state==='needs_attention');
  useEffect(()=>{
    if(!projectId||(!inProgress&&!needsAttention&&!uncertainRequest))return;
    const timer=setInterval(refresh,3000);
    return()=>clearInterval(timer);
  },[projectId,inProgress,needsAttention,uncertainRequest,refresh]);
  const path=project?.repository.trim()??'';
  const invalidSource=!project?'Читаем карточку проекта.':!path?'Укажите локальный репозиторий в карточке проекта, чтобы агент мог прочитать код и документацию.':!path.startsWith('/')?'Для разбора нужен абсолютный путь к локальному каталогу. URL репозитория и относительный путь не подходят.':'';
  const blockedState=entries.some(run=>run.state==='unknown'||run.state==='needs_attention');
  const canStart=ready&&!invalidSource&&!starting&&!closing&&!disabled&&!storageError&&!inProgress&&!blockedState&&!uncertainRequest&&(!latest||latest.state==='failed'||latest.state==='closed');
  const canRetrySame=ready&&!!retryRequestId&&retryRequestId===uncertainRequest&&!invalidSource&&!starting&&!closing&&!disabled&&!storageError&&!inProgress&&!blockedState;
  const start=async()=>{
    if(!project||(!canStart&&!canRetrySame))return;
    const requestId=retryRequestId??crypto.randomUUID();
    try{writePendingAnalysisRequest(sessionStorage,project.id,requestId);}catch{setStorageError('Не удалось сохранить идентификатор запуска. Запрос не отправлен.');return;}
    setUncertainRequest(requestId);setStarting(true);setStartError('');setNotice('');
    try{
      const {run}=await rpc.call('analysis_start',{projectId:project.id,requestId});
      writePendingAnalysisRequest(sessionStorage,project.id,null);setUncertainRequest(null);setRetryRequestId(null);
      setEntries(previous=>[run,...previous.filter(value=>value.id!==run.id)].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,20));setLoadedProject(project.id);if(run.requestId!==requestId)setNotice('В проекте уже есть запуск. Показана существующая задача; новая не создавалась.');refresh();
    }catch(error){setStartError('Не удалось подтвердить запуск: '+message(error));setUncertainRequest(requestId);refresh();}finally{setStarting(false);}
  };
  const close=async(run:AnalysisRun)=>{
    if(!project||starting||closing||disabled)return;
    setClosing(run.id);setStartError('');setNotice('');
    try{
      const {run:updated}=await rpc.call('analysis_close',{projectId:project.id,runId:run.id});
      setEntries(previous=>previous.map(value=>value.id===updated.id?updated:value));
      setNotice('Запуск закрыт без импорта. Теперь можно явно запустить новый разбор.');refresh();
    }catch(error){setStartError('Не удалось закрыть запуск: '+message(error));refresh();}finally{setClosing(null);}
  };
  return <section className="space-y-3 rounded-lg border border-primary/40 bg-card p-4" aria-label="Начало работы с проектом">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-semibold">Работать с агентом</h3><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Начните разбор, затем продолжайте в треде BB: агент изучит проект, предложит записи с источниками и спросит, каких решений не хватает. Ответьте в том же треде. Формы ниже нужны для просмотра и правок, а не как обязательный первый шаг.</p></div>{retryRequestId?<Button disabled={!canRetrySame} onClick={()=>void start()}>Повторить тот же запрос</Button>:latest?.threadId?<Button onClick={()=>{if(beforeThreadOpen())navigate.toThread(latest.threadId!,{split:true});}}>Продолжить в треде</Button>:<Button disabled={!canStart} onClick={()=>void start()}>{starting?'Запускаем…':latest?.state==='failed'?'Повторить разбор проекта':latest?.state==='ready'?'Разбор проекта завершён':latest?.state==='closed'?'Начать новый разбор проекта':'Начать разбор проекта'}</Button>}</div>
    {latest?.threadId&&canStart&&<Button variant="outline" onClick={()=>void start()}>{latest.state==='failed'?'Повторить разбор':'Начать новый разбор'}</Button>}
    <dl className="space-y-1 text-xs text-muted-foreground"><div className="break-all"><dt className="inline">Исходный каталог: </dt><dd className="inline">{path||'не указан'}</dd></div><div><dt className="inline">Закреплённая версия методологии: </dt><dd className="inline">{project?.revision.slice(0,12)??'…'}</dd></div></dl>
    <p className="text-xs text-muted-foreground">«Начать разбор» открывает обычный рабочий тред BB, связанный с этим проектом. Агент добавляет черновики, а вы обсуждаете и уточняете их в треде. Существующие записи сохраняются. Это первичный разбор, а не автоматическое выполнение всей инициативы.</p>
    {invalidSource&&<p className="text-sm text-muted-foreground">{invalidSource}</p>}
    {storageError&&<p role="alert" className="text-sm text-destructive">{storageError}</p>}
    {readError&&<p role="alert" className="text-sm text-destructive">Не удалось проверить запуски: {readError}</p>}
    {startError&&<p role="alert" className="text-sm text-destructive">{startError}</p>}
    {notice&&<p className="text-sm text-muted-foreground">{notice}</p>}
    {uncertainRequest&&<p className="text-sm text-muted-foreground">Проверяем исход отправленного запроса. Его идентификатор сохранён; повтор возможен только с тем же идентификатором, без автоматической отправки.</p>}
    {(loading||!loadedProject)&&!readError&&<p role="status" className="text-xs text-muted-foreground">Проверяем состояние разбора…</p>}
    <div className="flex items-center gap-2"><Button variant="outline" type="button" disabled={starting||!!closing||loading} onClick={refresh}>Проверить состояние</Button>{ready&&total===0&&entries.length===0&&<p className="text-xs text-muted-foreground">Проект ещё не разбирался агентом.</p>}</div>
    {loadedProject===projectId&&entries.length>0&&<div className="space-y-3">{entries.map(run=><article className="space-y-2 rounded-md border border-border p-3" key={run.id}><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{analysisStateLabels[run.state]}</p><span className="text-xs text-muted-foreground">{time(run.createdAt)}</span></div><p className="break-all text-xs text-muted-foreground">{run.sourcePath} · версия {run.revisionId.slice(0,12)}</p>{run.providerId&&<p className="text-xs text-muted-foreground">Исполнитель: {run.providerName??run.providerId} · {run.modelName??run.model} · permissionMode={run.permissionMode}</p>}{run.threadId&&<Button type="button" variant="outline" onClick={()=>{if(beforeThreadOpen())navigate.toThread(run.threadId!,{split:true});}}>Открыть тред агента</Button>}{run.error&&<p role="alert" className="text-sm text-destructive">{run.error}</p>}{run.resultReason&&<p className="text-sm text-muted-foreground">{run.resultReason}</p>}{run.state==='unknown'&&<p className="text-xs text-muted-foreground">{run.spawnFailure?.confirmed?'Подтверждён отказ до создания треда; выполните проверку и recovery.':'Проверьте задачу агента по plugin metadata runId. Повторный запуск заблокирован до выяснения результата.'}</p>}{run.state==='needs_attention'&&<div className="space-y-2"><p className="text-sm text-muted-foreground">Задача агента не выполнила импорт черновиков. Можно продолжить её в чате либо закрыть этот запуск без результата. Завершение хода агента само по себе не означает готовность проекта.</p><Button type="button" variant="outline" disabled={starting||!!closing||disabled} onClick={()=>void close(run)}>{closing===run.id?'Проверяем и закрываем…':'Закрыть запуск без результата'}</Button><p className="text-xs text-muted-foreground">Сервер разрешит закрытие только после проверки, что задача агента сейчас не выполняется. Существующие записи проекта сохраняются.</p></div>}{run.state==='ready'&&<div className="space-y-2"><p className="text-sm">{run.importedArtifactIds.length?'Добавлено черновиков: '+run.importedArtifactIds.length:'Разбор завершён; новых черновиков в реестре нет.'}</p><div className="flex flex-wrap gap-2">{run.importedArtifactIds.slice(0,10).map((id,index)=><Button key={id} type="button" variant="outline" onClick={()=>onOpenArtifact(id)}>Открыть черновик {index+1}</Button>)}</div>{run.importedArtifactIds.length>10&&<p className="text-xs text-muted-foreground">Остальные черновики доступны в разделах рабочего пространства.</p>}<p className="text-xs text-muted-foreground">Откройте записи и проверьте их источники. Импорт не означает принятия продуктовых решений или автоматической приёмки.</p></div>}</article>)}</div>}
    {total>20&&<p className="text-xs text-muted-foreground">Показаны последние 20 запусков из {total}.</p>}
  </section>;
}
