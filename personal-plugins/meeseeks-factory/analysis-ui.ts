import type { AnalysisRun } from './analysis-contract';
export const analysisStateLabels:Record<AnalysisRun['state'],string>={pending:'Подготовка разбора',running:'Агент разбирает проект',ready:'Разбор завершён',failed:'Разбор завершился ошибкой',unknown:'Нужно проверить запуск',needs_attention:'Разбор ожидает результата',closed:'Запуск закрыт без результата'};
export const factoryProjectSubPath=(projectId:string)=>'projects/'+projectId;
export function parseFactoryProjectSubPath(subPath:string):string|null{
  const parts=subPath.split('/');
  if(parts.length!==2||parts[0]!=='projects')return null;
  try{const id=decodeURIComponent(parts[1]);return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?id:null;}catch{return null;}
}

const requestKey=(projectId:string)=>'meeseeks-factory:analysis-request:'+projectId;
type RequestStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export function readPendingAnalysisRequest(storage:RequestStorage,projectId:string):string|null{
  const value=storage.getItem(requestKey(projectId));
  return value&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;
}
export function writePendingAnalysisRequest(storage:RequestStorage,projectId:string,requestId:string|null):void{
  if(requestId)storage.setItem(requestKey(projectId),requestId);else storage.removeItem(requestKey(projectId));
}
