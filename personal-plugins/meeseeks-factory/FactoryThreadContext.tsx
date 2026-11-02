import { useCallback, useEffect, useState } from 'react';
import { experimental_ThreadContextCardRow as ContextRow, experimental_useThreadContextKind, useBbNavigate, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { ExperimentalThreadContextCardProps, ExperimentalThreadContextSegmentInput, ExperimentalThreadContextSegmentProps } from '@get-bb/plugin-sdk/app';
import type { rpcContract, FactoryThreadContext } from './server';
import { analysisStateLabels, factoryProjectSubPath } from './analysis-ui';

function useFactoryContext(threadId:string,enabled=true){
  const rpc=useRpc<typeof rpcContract>();
  const [snapshot,setSnapshot]=useState<{threadId:string;context:FactoryThreadContext['context']}|null>(null);
  const [error,setError]=useState(false);
  const [tick,setTick]=useState(0);
  const refresh=useCallback(()=>setTick(value=>value+1),[]);
  useRealtime('factory-changed',refresh);
  useEffect(()=>{
    if(!enabled)return;
    let active=true;setError(false);
    rpc.call('factory_thread_context',{threadId}).then(result=>{if(active)setSnapshot({threadId,context:result.context});},()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[rpc,threadId,enabled,tick]);
  const context=enabled&&snapshot?.threadId===threadId&&snapshot.context?.run.threadId===threadId?snapshot.context:null;
  useEffect(()=>{
    if(!context||!['pending','running','needs_attention'].includes(context.run.state))return;
    const timer=setInterval(refresh,3000);
    return()=>clearInterval(timer);
  },[context?.run.state,!!context,refresh]);
  return {context,error,refresh};
}
export function FactoryThreadContextCard({threadId}:ExperimentalThreadContextCardProps){
  const {context,error,refresh}=useFactoryContext(threadId);
  const navigate=useBbNavigate();
  if(!context)return null;
  const open=()=>navigate.toPluginPanel('factory',{subPath:factoryProjectSubPath(context.project.id)});
  return <>
    <ContextRow icon="Layers" label={context.project.name} title={'Открыть проект фабрики '+context.project.name} onClick={open}/>
    <ContextRow label={context.pulse.objective||'Цель проекта ещё не задана'} title={context.pulse.objective||'Цель проекта ещё не задана'}/>
    <ContextRow label={analysisStateLabels[context.run.state]} title="Состояние первичного разбора проекта"/>
    <ContextRow label="Версия правил разбора" trailing={context.run.revisionId.slice(0,12)} title={context.run.revisionId}/>
    {context.pulse.nextStep&&<ContextRow label={context.pulse.nextStep} title={'Следующий шаг: '+context.pulse.nextStep}/>}
    {error&&<ContextRow label="Не удалось обновить связь · повторить" onClick={refresh}/>}
    <p className="px-2 py-1 text-xs text-muted-foreground">Ответьте агенту в этом треде, чтобы уточнить контекст и продолжить разбор.</p>
  </>;
}
export function useFactoryThreadBannerVisible({threadId}:ExperimentalThreadContextSegmentInput){
  const banner=experimental_useThreadContextKind()==='banner';
  const {context}=useFactoryContext(threadId,banner);
  return banner&&!!context;
}
export function FactoryThreadBanner({threadId}:ExperimentalThreadContextSegmentProps){
  const {context}=useFactoryContext(threadId);
  const navigate=useBbNavigate();
  if(!context)return null;
  return <button type="button" className="max-w-full truncate text-xs text-muted-foreground hover:text-foreground" title={[context.pulse.objective||'Цель проекта ещё не задана',analysisStateLabels[context.run.state],'Версия: '+context.run.revisionId].join(' · ')} onClick={()=>navigate.toPluginPanel('factory',{subPath:factoryProjectSubPath(context.project.id)})}>Фабрика · {context.project.name} · {analysisStateLabels[context.run.state]}</button>;
}
