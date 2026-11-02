import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import type { ExperimentalThreadContextCardProps } from '@get-bb/plugin-sdk/app';
import { FactoryThreadContextCard, FactoryThreadBanner, useFactoryThreadBannerVisible } from '../FactoryThreadContext';
import { factoryProjectSubPath, parseFactoryProjectSubPath, readPendingAnalysisRequest, writePendingAnalysisRequest } from '../analysis-ui';
import type { FactoryThreadContext, Project } from '../server';
import { AnalysisPanel } from '../AnalysisPanel';
import type { AnalysisRun } from '../analysis-contract';

const factoryId='dd048b69-9c6e-4434-b688-8be5d57a10ea';
const threadId='thr_factory_fixture';
const props:ExperimentalThreadContextCardProps={threadId,projectId:'bb-project-not-the-factory-id',environment:null};
const context:NonNullable<FactoryThreadContext['context']>={
  project:{id:factoryId,name:'Fixture product',mode:'existing',repository:'/fixture/product',revision:'new-project-revision'},
  run:{id:'85390de7-052e-40ab-a5b9-253012052da9',projectId:factoryId,requestId:'b96ed9f7-de7e-48bf-ae05-57e9a4898200',revisionId:'abcdef123456-pinned-run',sourcePath:'/fixture/product',bbProjectId:props.projectId,hostId:'host-fixture',threadId,state:'needs_attention',error:null,createdAt:'2026-11-02T12:00:00Z',updatedAt:'2026-11-02T12:00:00Z',importedArtifactIds:[],resultReason:null,instructionsHash:'instructions',contextHash:'context',providerId:'acp-deepseek',providerName:'DeepSeek Harness',model:'["deepseek-account","deepseek-flash"]',modelName:'DeepSeek-V4.1-Flash',permissionMode:'accept-edits',attempts:[],spawnFailure:null,recovery:null},
  pulse:{projectId:factoryId,scope:'work',objective:'Вернуть подключённые инструменты проекта',health:'at_risk',nextStep:'Проверить доступные источники',blocker:'',version:1,updatedAt:'2026-11-02T12:00:00Z'},
};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function BannerHost(p:ExperimentalThreadContextCardProps){
  const visible=useFactoryThreadBannerVisible(p);
  return <><output data-testid="banner-visible">{visible?'visible':'hidden'}</output>{visible&&<FactoryThreadBanner {...p} segments={[]} isExpanded={false} onToggle={()=>{}}/>}</>;
}

test('mapped factory card resolves delayed context and opens exact factory project with SDK navigation',async()=>{
  const response=deferred<FactoryThreadContext>();
  const slot=renderSlot({component:FactoryThreadContextCard},props,{threadContextKind:'card',rpc:{factory_thread_context:()=>response.promise}});
  try{
    assert.equal(slot.container.textContent,'');
    assert.deepEqual(slot.inspection.rpcCalls,[{method:'factory_thread_context',input:{threadId}}]);
    await act(async()=>{response.resolve({context});await response.promise;});
    assert.ok(await slot.findByText(context.pulse.objective));
    assert.ok(slot.getByText('Разбор ожидает результата'));
    assert.equal(slot.getByTitle(context.run.revisionId).textContent,'Версия правил разбораabcdef123456');
    assert.equal(slot.queryByText('new-project-r'),null);
    fireEvent.click(slot.getByRole('button',{name:'Fixture product'}));
    assert.deepEqual(slot.inspection.navigateCalls,[{method:'toPluginPanel',path:'factory',options:{subPath:'projects/'+factoryId}}]);
  }finally{slot.lifecycle.unmount();}
});

test('unmapped native thread shows no factory card after delayed lookup',async()=>{
  const response=deferred<FactoryThreadContext>();
  const foreign={...props,threadId:'thr_unrelated_fixture'};
  const slot=renderSlot({component:FactoryThreadContextCard},foreign,{rpc:{factory_thread_context:()=>response.promise}});
  try{
    assert.equal(slot.container.textContent,'');
    await act(async()=>{response.resolve({context:null});await response.promise;});
    assert.equal(slot.container.textContent,'');
    assert.equal(slot.inspection.navigateCalls.length,0);
    assert.deepEqual(slot.inspection.rpcCalls,[{method:'factory_thread_context',input:{threadId:foreign.threadId}}]);
  }finally{slot.lifecycle.unmount();}
});

test('banner mode exposes mapped project and routes through SDK; card mode never duplicates banner',async()=>{
  const banner=renderSlot({component:BannerHost},props,{threadContextKind:'banner',rpc:{factory_thread_context:()=>({context})}});
  try{
    const button=await banner.findByRole('button',{name:/Фабрика · Fixture product/});
    assert.equal(banner.getByTestId('banner-visible').textContent,'visible');
    fireEvent.click(button);
    assert.deepEqual(banner.inspection.navigateCalls,[{method:'toPluginPanel',path:'factory',options:{subPath:factoryProjectSubPath(factoryId)}}]);
  }finally{banner.lifecycle.unmount();}
  const cardMode=renderSlot({component:BannerHost},props,{threadContextKind:'card',rpc:{factory_thread_context:()=>({context})}});
  try{
    await act(async()=>{});
    assert.equal(cardMode.getByTestId('banner-visible').textContent,'hidden');
    assert.equal(cardMode.queryByRole('button'),null);
    assert.equal(cardMode.inspection.rpcCalls.length,0);
  }finally{cardMode.lifecycle.unmount();}
});

test('banner remains hidden for unmapped thread; project route accepts only explicit valid factory ids',async()=>{
  const response=deferred<FactoryThreadContext>();
  const slot=renderSlot({component:BannerHost},props,{threadContextKind:'banner',rpc:{factory_thread_context:()=>response.promise}});
  try{
    await act(async()=>{response.resolve({context:null});await response.promise;});
    assert.equal(slot.getByTestId('banner-visible').textContent,'hidden');
    assert.equal(slot.queryByRole('button'),null);
    assert.equal(parseFactoryProjectSubPath(factoryProjectSubPath(factoryId)),factoryId);
    assert.equal(parseFactoryProjectSubPath('projects/not-a-project'),null);
    assert.equal(parseFactoryProjectSubPath('projects/'+factoryId+'/extra'),null);
    assert.equal(parseFactoryProjectSubPath('projects/%2F'+factoryId),null);
  }finally{slot.lifecycle.unmount();}
});


test('uncertain start persists its UUID before send and reuses it across absence and remount; only known failure permits a new UUID',async()=>{
  const project:Project={...context.project,baseline:'Fixture baseline',adoption:'baseline_recorded',createdAt:'2026-11-02T12:00:00Z',updatedAt:'2026-11-02T12:00:00Z'};
  const otherProject='51280e0c-a9dc-4d07-8fce-e84a22ab02ad';
  const calls:{projectId:string;requestId:string}[]=[];
  let stored:AnalysisRun|null=null;
  let foreignActive:AnalysisRun|null=null;
  const handlers={
    analysis_runs:()=>({entries:stored?[stored]:foreignActive?[foreignActive]:[],total:stored||foreignActive?1:0,limit:20,offset:0}),
    analysis_lookup:()=>({run:stored,activeRun:foreignActive}),
    analysis_start:async(raw:unknown)=>{
      const input=raw as {projectId:string;requestId:string};
      assert.equal(readPendingAnalysisRequest(sessionStorage,project.id),input.requestId,'UUID must be durable before the request reaches RPC');
      assert.equal(readPendingAnalysisRequest(sessionStorage,otherProject),null,'Pending identity must not leak into another project');
      calls.push(input);
      if(calls.length===1)throw new Error('Connection lost before receiving the result');
      stored={...context.run,requestId:input.requestId,threadId:null,state:'failed',error:'Confirmed fixture failure'};
      return {run:stored};
    },
  };
  const noop=()=>{};
  const panelProps={project,disabled:false,onImported:noop,onOpenArtifact:noop,beforeThreadOpen:()=>true};
  let slot=renderSlot({component:AnalysisPanel},panelProps,{rpc:handlers});
  try{
    const start=await slot.findByRole('button',{name:'Начать разбор проекта'});
    await waitFor(()=>assert.equal((start as HTMLButtonElement).disabled,false));
    assert.equal(calls.length,0);
    fireEvent.click(start);
    const repeat=await slot.findByRole('button',{name:'Повторить тот же запрос'});
    await waitFor(()=>assert.equal((repeat as HTMLButtonElement).disabled,false));
    assert.equal(calls.length,1,'Lookup absence must not auto-submit');
    const first=calls[0].requestId;
    assert.equal(readPendingAnalysisRequest(sessionStorage,project.id),first);
    foreignActive={...context.run,state:'running'};
    fireEvent.click(slot.getByRole('button',{name:'Проверить состояние'}));
    await slot.findByText('В проекте есть другая задача. Исходный запрос пока не подтверждён; его идентификатор сохранён.');
    assert.equal(readPendingAnalysisRequest(sessionStorage,project.id),first,'A foreign active run without durable binding must not clear the caller request');
    foreignActive=null;
    await waitFor(()=>assert.equal((slot.getByRole('button',{name:'Проверить состояние'}) as HTMLButtonElement).disabled,false));
    fireEvent.click(slot.getByRole('button',{name:'Проверить состояние'}));
    await waitFor(()=>assert.equal((slot.getByRole('button',{name:'Повторить тот же запрос'}) as HTMLButtonElement).disabled,false));
    slot.lifecycle.unmount();
    slot=renderSlot({component:AnalysisPanel},panelProps,{rpc:handlers});
    const restored=await slot.findByRole('button',{name:'Повторить тот же запрос'});
    await waitFor(()=>assert.equal((restored as HTMLButtonElement).disabled,false));
    assert.equal(calls.length,1,'Remount must not auto-submit or discard the pending request');
    fireEvent.click(restored);
    const retryKnown=await slot.findByRole('button',{name:'Повторить разбор проекта'});
    await waitFor(()=>assert.equal((retryKnown as HTMLButtonElement).disabled,false));
    assert.equal(calls.length,2);
    assert.equal(calls[1].requestId,first);
    assert.equal(readPendingAnalysisRequest(sessionStorage,project.id),null,'Known terminal run permits clearing pending identity');
    fireEvent.click(retryKnown);
    await waitFor(()=>assert.equal(calls.length,3));
    assert.notEqual(calls[2].requestId,first,'A known failed run permits a new explicit request');
    await waitFor(()=>assert.equal(readPendingAnalysisRequest(sessionStorage,project.id),null));
  }finally{slot.lifecycle.unmount();writePendingAnalysisRequest(sessionStorage,project.id,null);writePendingAnalysisRequest(sessionStorage,otherProject,null);}
});
