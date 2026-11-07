import {ref,watch} from 'vue';
export type Theme='light'|'scifi';
/** 功能：读取合法主题，只保留浅色与科幻；参数：无；返回值：主题，默认浅色。 */
function initial():Theme{try{return localStorage.getItem('cq.vue.theme')==='scifi'?'scifi':'light';}catch{return 'light';}}
export const theme=ref<Theme>(initial());
/** 功能：应用两种主题；参数：无；返回值：无，仅保存外观偏好。 */
export function initTheme(){watch(theme,value=>{document.documentElement.dataset.theme=value;document.documentElement.classList.toggle('dark',value==='scifi');try{localStorage.setItem('cq.vue.theme',value);}catch{}},{immediate:true});}
