<script setup lang="ts">
import {ref} from 'vue';
import {ElMessage} from 'element-plus';
import {useData,useUI} from '../store';
import {bindBrowser,listBrowserBindings,revokeBrowserBinding} from '../browser-bindings';
import type {BrowserBindingList} from '../browser-bindings';
import SecretInput from './SecretInput.vue';

const opened=ref(false),busy=ref(false),key=ref(''),error=ref(''),selected=ref<number|null>(null),name=ref('当前浏览器');
const state=ref<BrowserBindingList|null>(null),data=useData(),ui=useUI();
/** 功能：清空关闭后的敏感输入和管理列表；参数：无；返回值：无。 */
function closed(){key.value='';error.value='';state.value=null;selected.value=null;}
/** 功能：显示安全错误，不把凭证带入提示；参数：异常；返回值：显示文本。 */
function message(cause:unknown){return cause instanceof Error?cause.message:'操作失败，请重新读取核实';}
/** 功能：用临时或当前页面管理授权读取绑定列表；参数：无；返回值：异步完成。 */
async function load(){
 if(busy.value)return;busy.value=true;error.value='';
 try{state.value=await listBrowserBindings(key.value||undefined);}catch(cause){error.value=message(cause);}finally{busy.value=false;}
}
/** 功能：绑定当前浏览器并刷新读取状态，不建立管理会话；参数：无；返回值：异步完成。 */
async function bind(){
 if(busy.value||selected.value===null||!name.value.trim())return;busy.value=true;error.value='';
 try{const result=await bindBrowser(selected.value,name.value.trim(),key.value||undefined);await data.refresh();opened.value=false;ElMessage.success(result.online?'浏览器已绑定，在线设备读取已放行；管理操作仍需授权':'绑定已保存，关联设备在线后自动放行');}
 catch(cause){error.value=message(cause);}finally{busy.value=false;}
}
/** 功能：撤销一个浏览器绑定并重读状态，写入不自动重试；参数：绑定ID；返回值：异步完成。 */
async function revoke(id:number){
 if(busy.value)return;busy.value=true;error.value='';
 try{await revokeBrowserBinding(id,key.value||undefined);state.value=await listBrowserBindings(key.value||undefined);await data.refresh();ElMessage.success('绑定已撤销');}
 catch(cause){error.value=message(cause);}finally{busy.value=false;}
}
/** 功能：显示绑定到期时间；参数：Unix秒；返回值：本机时区文本。 */
function date(seconds:number){return new Date(seconds*1000).toLocaleString();}
</script>
<template>
 <el-button @click="opened=true">浏览器设备绑定</el-button>
 <el-dialog v-model="opened" title="浏览器设备绑定" width="min(760px,96vw)" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @closed="closed">
  <p>通过 HTTPS 绑定当前浏览器，有效期30天。关联设备在线时可直接读取，代理出口变化不影响绑定；管理操作仍需独立授权。</p>
  <el-form label-position="top" @submit.prevent="load">
   <el-form-item v-if="!ui.authorized" label="当前管理口令（仅用于本次绑定管理）"><SecretInput v-model="key" autocomplete="current-password"/></el-form-item>
   <el-button :loading="busy" :disabled="!ui.authorized&&!key" @click="load">读取设备与绑定</el-button>
   <template v-if="state">
    <el-form-item label="关联设备"><el-select v-model="selected" placeholder="请选择当前浏览器所在设备" :disabled="busy" style="width:100%"><el-option v-for="device in state.devices" :key="device.machine_id" :value="device.machine_id" :label="device.label+(device.online?' · 在线':' · 离线')"/></el-select></el-form-item>
    <el-form-item label="浏览器名称"><el-input v-model="name" maxlength="80" :disabled="busy"/></el-form-item>
    <el-button type="primary" :loading="busy" :disabled="selected===null||!name.trim()" @click="bind">绑定当前浏览器</el-button>
    <p>离线只暂停自动放行，恢复在线后可继续使用。清除Cookie、更换浏览器或配置文件后需重新绑定。管理员应确认浏览器与所选设备的对应关系。</p>
    <el-table :data="state.bindings" style="margin-top:16px">
     <el-table-column prop="name" label="浏览器"/>
     <el-table-column label="关联设备"><template #default="{row}">{{state.devices.find(device=>device.machine_id===row.machine_id)?.label??'已删除或合并设备'}}</template></el-table-column>
     <el-table-column label="到期时间"><template #default="{row}">{{date(row.expires_at)}}</template></el-table-column>
     <el-table-column label="状态"><template #default="{row}">{{row.revoked_at?'已撤销':row.expires_at<=Date.now()/1000?'已过期':row.id===state.current.id?'当前浏览器':'已绑定'}}</template></el-table-column>
     <el-table-column label="操作" width="85"><template #default="{row}"><el-button link type="danger" :disabled="busy||!!row.revoked_at" @click="revoke(row.id)">撤销</el-button></template></el-table-column>
    </el-table>
   </template>
   <el-alert v-if="error" :title="error" type="error" :closable="false" style="margin-top:12px"/>
  </el-form>
 </el-dialog>
</template>
