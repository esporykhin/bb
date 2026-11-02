import { JSDOM } from 'jsdom';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','Node','MutationObserver','getComputedStyle','sessionStorage']){
  const value=key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key];
  Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
}
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
dom.window.HTMLElement.prototype.scrollIntoView=function(){};
