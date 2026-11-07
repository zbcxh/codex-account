<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import {useRoute,RouterLink,RouterView} from 'vue-router';
import {DataBoard,User,Monitor,Connection,Key,Setting,Refresh,FullScreen,Lock,Unlock,TopRight} from '@element-plus/icons-vue';
import ReadUnlock from './components/ReadUnlock.vue';
import ExternalWorkspace from './components/ExternalWorkspace.vue';
import {externalTarget} from './external-links';import type {ExternalTab} from './external-links';
import {useData,useUI} from './store';import {fontSize,fontSizes} from './font-size';import {theme} from './theme';import AdminGate from './components/AdminGate.vue';import ManageDialog from './components/ManageDialog.vue';
const data=useData(),ui=useUI(),route=useRoute();
const demo=import.meta.env.VITE_DEMO==='true';
const externalTabs=ref<ExternalTab[]>([]),activeExternal=ref('');
/** 功能：拦截普通外链点击，复用嵌入页签或保留浏览器新窗口行为；参数：点击事件；返回值：无，不拦截修饰键或显式新窗口按钮。 */
function handleExternalClick(event:MouseEvent){
 if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
 const anchor=event.target instanceof Element?event.target.closest<HTMLAnchorElement>('a[href]'):null;
 if(!anchor||anchor.hasAttribute('download')||anchor.hasAttribute('data-external-window'))return;
 const target=externalTarget(anchor.href,window.location.href);if(target.mode==='ignore'||!target.url)return;
 if(target.mode==='window'){anchor.target='_blank';anchor.rel='noopener noreferrer';return;}
 event.preventDefault();const url=target.url;
 if(!externalTabs.value.some(tab=>tab.url===url))externalTabs.value.push({url,title:anchor.textContent?.trim()||new URL(url).hostname});
 activeExternal.value=url;
}
/** 功能：关闭指定外链并选择邻近页签，全部关闭后返回面板；参数：规范外链地址；返回值：无。 */
function closeExternal(url:string){const index=externalTabs.value.findIndex(tab=>tab.url===url);if(index<0)return;externalTabs.value.splice(index,1);if(activeExternal.value===url)activeExternal.value=externalTabs.value[Math.min(index,externalTabs.value.length-1)]?.url||'';}
// 返回内部路由时仅隐藏外链；保持各 iframe 和当前面板实例，避免重复加载及丢失草稿。
watch(()=>route.fullPath,()=>{activeExternal.value='';});
const navigation=[{path:'/',label:'可视化大屏',icon:DataBoard},{path:'/accounts',label:'账号额度',icon:User},{path:'/devices',label:'设备监控',icon:Monitor},{path:'/mapping',label:'账号映射',icon:Connection},{path:'/access',label:'接入管理',icon:Key},{path:'/settings',label:'系统设置',icon:Setting}];
const clock=computed(()=>new Date(data.now*1000).toLocaleString('zh-CN',{hour12:false}));let timer:ReturnType<typeof setInterval>,refreshTimer:ReturnType<typeof setInterval>;
/** 功能：切换全屏；参数：无；返回值：异步完成，失败时保留当前布局。 */
async function fullscreen(){try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{/* 浏览器不支持时不改变页面。 */}}
/** 功能：清除过期管理授权，不删除编辑草稿；参数：无；返回值：无。 */
function expired(){ui.credential('');}
onMounted(()=>{void data.refresh();timer=setInterval(()=>data.tick=performance.now(),1000);refreshTimer=setInterval(()=>{if(!document.hidden)void data.refresh();},15000);window.addEventListener('quota-authorization-expired',expired);});
onUnmounted(()=>{clearInterval(timer);clearInterval(refreshTimer);data.dispose();window.removeEventListener('quota-authorization-expired',expired);});
</script>
<template>
<el-config-provider :locale="zhCn" :z-index="2000"><div class="ambient" aria-hidden="true"/><aside class="rail"><RouterLink to="/" class="brand" aria-label="Codex总览">N<span>✦</span></RouterLink><nav aria-label="主导航" @click="handleExternalClick"><RouterLink v-for="item in navigation" :key="item.path" :to="item.path" class="nav-item" active-class="" :class="{active:!activeExternal&&route.path===item.path}" :aria-current="!activeExternal&&route.path===item.path?'page':undefined" @click="activeExternal=''"><el-icon><component :is="item.icon"/></el-icon><span>{{item.label}}</span></RouterLink><a href="https://codex-reset.com/zh" target="_blank" rel="noopener noreferrer" class="nav-item" title="Codex 重置时间（新标签页或窗口打开）" aria-label="Codex 重置时间，新标签页或窗口打开"><el-icon><TopRight/></el-icon><span>Codex 重置时间</span></a></nav><div class="rail-bottom"><span class="signal"/>CODEX<br>CONTROL</div></aside>
<div class="workspace"><header class="topbar"><div class="breadcrumbs"><span class="product">INNA<span class="product-divider">/</span></span><span>{{route.meta.title}}</span><span class="version">VUE 3</span></div><div class="top-actions"><span class="environment"><i/>{{demo?'独立演示':data.error?'数据未同步':data.snapshot?'服务已连接':'正在连接'}}</span><span class="mono clock">{{clock}}</span><el-select v-model="fontSize" aria-label="字体大小" style="width:120px" title="调整面板字体大小，仅当前浏览器保存"><el-option v-for="size in fontSizes" :key="size" :value="size" :label="`字号 ${size}%`"/></el-select><el-select v-model="theme" aria-label="界面主题" style="width:118px"><el-option label="浅色" value="light"/><el-option label="科幻舰桥" value="scifi"/></el-select><el-tooltip content="全屏显示"><el-button :icon="FullScreen" circle aria-label="全屏显示" @click="fullscreen"/></el-tooltip><el-button :icon="ui.authorized?Unlock:Lock" @click="ui.authorized?ui.credential(''):ui.authOpen=true">{{ui.authorized?'退出管理':'管理授权'}}</el-button></div></header>
<main @click="handleExternalClick"><el-alert v-if="demo" title="独立演示模式：全部为合成数据，不连接真实服务" type="warning" :closable="false" show-icon class="global-alert"/><ReadUnlock/><el-alert v-if="data.error&&!data.readLocked" :title="data.snapshot?'连接异常，当前保留上次读数':'无法读取服务数据'" :description="data.error" type="error" :closable="false" show-icon class="global-alert"><template #default><p>{{data.error}}</p><el-button size="small" :loading="data.loading" @click="data.refresh">重试读取</el-button></template></el-alert><ExternalWorkspace :tabs="externalTabs" :active="activeExternal" @select="activeExternal=$event" @close="closeExternal"/><div v-show="!activeExternal"><div v-if="data.loading&&!data.snapshot" class="initial-loading" role="status" aria-live="polite">正在读取服务端状态…</div><RouterView v-else/></div></main>
<footer><span><i class="tiny-dot"/>{{demo?'合成演示':data.snapshot?'数据来自服务端，在线状态按实际周期判断':'尚无服务端数据'}}</span><span>INNA CONTROL SYSTEM · {{theme==='light'?'LIGHT':'SCI-FI'}}</span></footer></div><AdminGate/><ManageDialog/></el-config-provider>
</template>
