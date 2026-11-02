import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { Dashboard, Pulse } from './workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const field='w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const healthLabels={unknown:'Не оценено',on_track:'По плану',at_risk:'Есть риск',blocked:'Заблокирован'};
const scopeLabels={personal:'Личный',work:'Рабочий',unassigned:'Не распределён'};
const healthStyle={unknown:'bg-muted text-muted-foreground',on_track:'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',at_risk:'bg-amber-500/10 text-amber-700 dark:text-amber-300',blocked:'bg-red-500/10 text-red-700 dark:text-red-300'};
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
const date=(value:string|null)=>value?new Date(value).toLocaleString('ru-RU'):'Ещё не обновлялось';
export function Portfolio({onOpen,onConnect,onDirtyChange}:{onOpen:(id:string)=>void;onConnect:()=>void;onDirtyChange:(dirty:boolean)=>void}){
  const rpc=useRpc<typeof rpcContract>();
  const [data,setData]=useState<Dashboard|null>(null);
  const [query,setQuery]=useState('');
  const [scope,setScope]=useState<'all'|Pulse['scope']>('all');
  const [health,setHealth]=useState<'all'|Pulse['health']>('all');
  const [offset,setOffset]=useState(0);
  const [tick,setTick]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const errorRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(error)errorRef.current?.scrollIntoView({block:'center'});},[error]);
  const [editing,setEditing]=useState<Pulse|null>(null);
  const [editingName,setEditingName]=useState('');
  const [original,setOriginal]=useState('');
  const [pending,setPending]=useState(false);
  const request=useRef(0);
  const editorRef=useRef<HTMLFormElement>(null);
  useEffect(()=>{if(editing)editorRef.current?.scrollIntoView({block:'start'});},[editing?.projectId]);
  const dirty=!!editing&&JSON.stringify(editing)!==original;
  useEffect(()=>{onDirtyChange(dirty);return()=>onDirtyChange(false);},[dirty,onDirtyChange]);
  const discard=()=>!dirty||window.confirm('Отбросить несохранённые изменения РНП?');
  const refresh=useCallback(()=>setTick(n=>n+1),[]);
  useRealtime('factory-changed',refresh);
  useEffect(()=>{
    const ticket=++request.current;setLoading(true);setError('');
    const timer=setTimeout(()=>{rpc.call('dashboard_get',{query,scope,health,limit:20,offset}).then(result=>{
      if(ticket!==request.current)return;
      if(offset>0&&offset>=result.total){setOffset(Math.max(0,Math.floor((result.total-1)/20)*20));return;}
      setData(result);
    },e=>{if(ticket===request.current)setError(message(e));}).finally(()=>{if(ticket===request.current)setLoading(false);});},150);
    return()=>{request.current++;clearTimeout(timer);};
  },[rpc,query,scope,health,offset,tick]);
  const begin=(pulse:Pulse,name:string)=>{if(pending||!discard())return;setEditing(JSON.parse(JSON.stringify(pulse)) as Pulse);setOriginal(JSON.stringify(pulse));setEditingName(name);setError('');};
  const save=async()=>{
    if(!editing||pending)return;setPending(true);setError('');
    try{
      const {projectId,version,scope,objective,health,nextStep,blocker}=editing;
      const result=await rpc.call('pulse_update',{projectId,expectedVersion:version,scope,objective,health,nextStep,blocker});
      setEditing(result.pulse);setOriginal(JSON.stringify(result.pulse));refresh();
    }catch(e){setError(message(e));}finally{setPending(false);}
  };
  return <section className="space-y-5" aria-label="Обзор портфеля проектов">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold">Обзор портфеля</h2><p className="mt-1 text-sm text-muted-foreground">Личные и рабочие проекты: цель, состояние, следующий шаг и блокер.</p></div><div className="flex gap-2"><Button variant="outline" onClick={refresh} disabled={loading}>Обновить</Button><Button onClick={()=>{if(discard())onConnect();}}>Подключить проект</Button></div></header>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6">{[['Проектов',data?.summary.projects],['По плану',data?.summary.onTrack],['Есть риск',data?.summary.atRisk],['Заблокировано',data?.summary.blocked],['Не оценено',data?.summary.unknown],['Записей реестра',data?.summary.artifacts]].map(([label,value])=><div className="rounded-lg border border-border p-3" key={label}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value??'—'}</p></div>)}</div>
    <p className="text-xs text-muted-foreground">Цели, состояния, блокеры и следующие шаги задаются вручную. Число записей реестра показывает объём описания, а не успех продукта. Неизвестные значения не заменяются нулями.</p>
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_200px_200px]"><Input aria-label="Поиск в портфеле" placeholder="Найти проект по названию или пути" value={query} onChange={e=>{setQuery(e.target.value);setOffset(0);}} maxLength={200}/><label className="text-xs">Принадлежность<select aria-label="Принадлежность проекта" className={field} value={scope} onChange={e=>{setScope(e.target.value as typeof scope);setOffset(0);}}><option value="all">Все проекты</option>{Object.entries(scopeLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className="text-xs">Состояние<select aria-label="Состояние проектов" className={field} value={health} onChange={e=>{setHealth(e.target.value as typeof health);setOffset(0);}}><option value="all">Все состояния</option>{Object.entries(healthLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div>
    {error&&<div ref={errorRef} role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error}{editing&&<p className="mt-1 text-xs">При конфликте ваши значения сохранены в форме. Скопируйте их перед повторным открытием актуального РНП.</p>}</div>}
    {loading?<p role="status">Загрузка портфеля…</p>:!data?.entries.length?<div className="rounded-lg border border-dashed border-border p-6"><h3 className="font-medium">{query||scope!=='all'||health!=='all'?'По фильтру проектов нет':'Подключите первый проект'}</h3><p className="mt-2 text-sm text-muted-foreground">{query||scope!=='all'||health!=='all'?'Измените поиск или фильтры.':'Выберите текущий продукт из каталога на рабочем столе или создайте новый. Затем откройте его рабочий контур по методологии.'}</p></div>:<div className="grid gap-4 xl:grid-cols-2">{data.entries.map(({project,pulse,artifactCounts})=><article key={project.id} className="space-y-3 rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><button className="text-left text-lg font-semibold hover:underline" onClick={()=>{if(discard())onOpen(project.id);}}>{project.name}</button><p className="mt-1 text-xs text-muted-foreground">{scopeLabels[pulse.scope]} · {project.mode==='existing'?'Существующий продукт':'Новый продукт'}</p></div><span className={'shrink-0 rounded-full px-2 py-1 text-xs '+healthStyle[pulse.health]}>{healthLabels[pulse.health]}</span></div><p className="break-all text-xs text-muted-foreground">{project.repository||'Репозиторий не указан'}</p><dl className="space-y-2 text-sm"><div><dt className="text-xs text-muted-foreground">Цель проекта</dt><dd>{pulse.objective||'Не задана'}</dd></div><div><dt className="text-xs text-muted-foreground">Следующий шаг</dt><dd>{pulse.nextStep||'Не задан'}</dd></div>{(pulse.blocker||pulse.health==='blocked')&&<div><dt className="text-xs text-muted-foreground">Блокер</dt><dd>{pulse.blocker||'Причина блокировки не описана'}</dd></div>}</dl>
      <p className="text-xs text-muted-foreground">Джобы: {artifactCounts.job??0} · Инициативы: {artifactCounts.initiative??0} · Задачи: {artifactCounts.task??0} · Срезы: {artifactCounts.slice??0}</p><p className="text-xs text-muted-foreground">РНП обновлён: {date(pulse.updatedAt)}</p><div className="flex flex-wrap gap-2"><Button onClick={()=>{if(discard())onOpen(project.id);}}>Открыть проект</Button><Button variant="outline" disabled={pending} onClick={()=>begin(pulse,project.name)}>Обновить РНП</Button></div>
    </article>)}</div>}
    {(data?.total??0)>20&&<div className="flex items-center gap-2"><Button variant="outline" disabled={loading||offset===0} onClick={()=>setOffset(Math.max(0,offset-20))}>Назад</Button><span className="text-xs">{offset+1}–{Math.min(offset+20,data?.total??0)} из {data?.total}</span><Button variant="outline" disabled={loading||offset+20>=(data?.total??0)} onClick={()=>setOffset(offset+20)}>Далее</Button></div>}
    {editing&&<form ref={editorRef} aria-label="Редактор РНП" className="space-y-4 rounded-lg border border-primary p-4" onSubmit={e=>{e.preventDefault();void save();}}><h3 className="text-lg font-medium">РНП: {editingName}</h3><p className="text-xs text-muted-foreground">Рука на пульсе проекта: цель, состояние, блокер и следующий шаг. Оценка состояния задаётся вручную.</p><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">Принадлежность<select className={field} value={editing.scope} disabled={pending} onChange={e=>setEditing({...editing,scope:e.target.value as Pulse['scope']})}>{Object.entries(scopeLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label className="text-sm">Состояние<select className={field} value={editing.health} disabled={pending} onChange={e=>setEditing({...editing,health:e.target.value as Pulse['health']})}>{Object.entries(healthLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></div>{([['objective','Цель'],['nextStep','Следующий шаг'],['blocker','Блокер']] as const).map(([key,label])=><label className="block text-sm" key={key}>{label}<textarea className={field} rows={2} maxLength={5000} value={editing[key]} disabled={pending} onChange={e=>setEditing({...editing,[key]:e.target.value})}/></label>)}
      <div className="flex gap-2"><Button type="submit" disabled={pending||!dirty}>{pending?'Сохранение…':'Сохранить РНП'}</Button><Button type="button" variant="outline" disabled={pending} onClick={()=>{if(discard())setEditing(null);}}>Закрыть</Button></div>
    </form>}
  </section>;
}
