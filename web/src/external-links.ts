export interface ExternalTab {url:string;title:string}
export interface ExternalTarget {mode:'ignore'|'tab'|'window';url?:string}
// 沿用旧面板已知的嵌入限制；跨域 iframe 的错误和响应头无法由父页面可靠探测。
const deniedHosts=['codex-reset.com'];
/** 功能：按站点策略决定外链打开方式；参数：原始链接、当前页面地址；返回值：忽略、内容页签或浏览器新标签页及规范地址。 */
export function externalTarget(href:string,base:string):ExternalTarget {
 try{
  const url=new URL(href,base),current=new URL(base);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.origin===current.origin)return {mode:'ignore'};
  const denied=deniedHosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host));
  return {mode:denied||(current.protocol==='https:'&&url.protocol==='http:')?'window':'tab',url:url.href};
 }catch{return {mode:'ignore'};}
}
