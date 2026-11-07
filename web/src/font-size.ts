import {ref,watch} from 'vue';
export const fontSizes=[100,110,120,130,140,150] as const;
/** 功能：规范化字号偏好，拒绝范围外及任意CSS；参数：本地偏好原值；返回值：合法百分比，默认120。 */
export function fontPercent(raw:unknown):number{const value=typeof raw==='string'&&raw.trim()?Number(raw):typeof raw==='number'?raw:NaN;return fontSizes.some(size=>size===value)?value:120;}
/** 功能：读取浏览器字号偏好，存储不可用时安全回退；参数：无；返回值：合法百分比。 */
function initial():number{try{return fontPercent(localStorage.getItem('cq.vue.fontPercent'));}catch{return 120;}}
export const fontSize=ref(initial());
/** 功能：应用全局字体比例，仅保存非敏感外观偏好；参数：无；返回值：无，不访问服务端。 */
export function initFontSize(){watch(fontSize,value=>{const safe=fontPercent(value);document.documentElement.style.setProperty('--app-font-scale',String(safe/100));try{localStorage.setItem('cq.vue.fontPercent',String(safe));}catch{}},{immediate:true});}
