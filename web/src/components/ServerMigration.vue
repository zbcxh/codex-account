<script setup lang="ts">
import {ref,watch} from 'vue';
import {api} from '../api';import {useUI} from '../store';
const ui=useUI(),busy=ref(false),error=ref(''),notice=ref(''),target=ref<number|null>(null),url=ref('');
interface MigrationDevice {machine_id:number;label:string;server_url:string|null;override_url:string|null;applied_url:string|null;applied_version:number;version:number;apply_error:string|null}
interface MigrationState {server_url:string|null;version:number;machines:MigrationDevice[]}
const state=ref<MigrationState|null>(null);
/** 功能：按目标显示已保存设置；参数：无；返回值：无。 */
function select(){url.value=target.value===null?state.value?.server_url||'':state.value?.machines.find(m=>m.machine_id===target.value)?.override_url||'';notice.value='';}
/** 功能：读取管理员迁移状态，失败保留草稿；参数：无；返回值：异步完成。 */
async function load(){if(!ui.authorized){ui.authOpen=true;return;}busy.value=true;error.value='';try{state.value=await api.mutate<MigrationState>('/api/server-migration/list',{});select();}catch(e){error.value=e instanceof Error?e.message:'读取失败';}finally{busy.value=false;}}
/** 功能：保存经校验的默认或单台目标；参数：无；返回值：异步完成，设备下次上报时验证应用。 */
async function save(){if(!ui.authorized){ui.authOpen=true;return;}error.value='';notice.value='';const value=url.value.trim();if(value){try{const u=new URL(value);if(!/^https?:\/\//i.test(value)||!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||/[\\\s]/.test(value))throw new Error();}catch{error.value='请输入 HTTP 或 HTTPS 基础地址，不含口令、查询参数或片段';return;}}busy.value=true;try{state.value=await api.mutate<MigrationState>('/api/server-migration',{machine_id:target.value,server_url:value||null});select();notice.value='已保存。设备下次上报时校验目标，成功才更新本机地址；旧服务器需保持可访问。';}catch(e){error.value=e instanceof Error?e.message:'保存结果未确认，请重新加载核实';}finally{busy.value=false;}}
watch(target,select);
// 管理授权清除时立即清空状态，不把设备设置缓存到浏览器存储。
watch(()=>ui.authorized,value=>{if(!value){state.value=null;url.value='';notice.value='';}});
</script>
<template><section class="panel" style="margin-top:20px"><div class="panel-head"><span class="panel-title">迁移上报服务器</span><el-button :loading="busy" @click="load">{{ui.authorized?'读取迁移配置':'管理授权'}}</el-button></div><div class="panel-body"><p>保留设备 ID 和令牌。目标服务必须已安全迁移设备授权，支持有效证书的 HTTPS；禁止 HTTPS 降级。校验失败保留原地址。</p><template v-if="state"><el-select v-model="target" placeholder="默认：所有未单独指定的设备" clearable @clear="target=null" :disabled="busy" style="width:100%;margin:12px 0"><el-option v-for="m in state.machines" :key="m.machine_id" :value="m.machine_id" :label="m.label"/></el-select><el-input v-model="url" :disabled="busy" maxlength="2048" placeholder="https://quota.example.com，可带基础路径"/><p>{{target===null?'留空取消默认迁移，不会撤回设备已经保存的地址。':'留空恢复跟随默认；已迁移设备需要在其当前服务上配置下一次迁移。'}}</p><el-button type="primary" :loading="busy" @click="save">保存迁移设置</el-button><el-table :data="state?.machines??[]" style="margin-top:16px"><el-table-column prop="label" label="设备"/><el-table-column prop="server_url" label="期望地址"/><el-table-column prop="applied_url" label="已确认地址"/><el-table-column label="状态"><template #default="{row}">{{row.apply_error?'校验失败，保留原地址':!row.server_url?'未设置':row.applied_version===row.version?'已确认':'等待下次上报确认'}}</template></el-table-column></el-table></template><el-alert v-if="error" :title="error" type="error" :closable="false"/><el-alert v-if="notice" :title="notice" type="success" :closable="false"/></div></section></template>
