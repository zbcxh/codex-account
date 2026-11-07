<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue';
import type {TableInstance} from 'element-plus';
import {api} from '../api';
import {useData,useUI} from '../store';
import {date,online} from '../domain';
import {createOtaJobs,otaEligibility,otaError,otaStatus} from '../ota';
import type {Machine,OtaCreateResponse,OtaList,OtaRelease} from '../types';

const data=useData(),ui=useUI(),state=ref<OtaList|null>(null),busy=ref(false),error=ref(''),notice=ref(''),uncertain=ref(false);
const releaseSeq=ref<number>(),selectedIds=ref<number[]>([]),results=ref<OtaCreateResponse['results']>([]);
const deviceTable=ref<TableInstance>();
const confirmation=ref<{release:OtaRelease;machines:{machine_id:number;client_id:string;label:string}[]}|null>(null);
let generation=0;
const release=computed(()=>state.value?.releases.find(item=>item.release_seq===releaseSeq.value));
const machines=computed(()=>data.snapshot?.machines||[]);
const chosen=computed(()=>machines.value.filter(machine=>selectedIds.value.includes(machine.machine_id)));
const jobs=computed(()=>state.value?.jobs||[]);

/** 功能：检查当前设备选择约束；参数：设备最新快照；返回值：禁止选择原因或空字符串。 */
function reason(machine:Machine):string{
 return otaEligibility(machine,state.value?.capabilities.find(cap=>cap.machine_id===machine.machine_id),release.value,jobs.value,data.now);
}
/** 功能：限制表格勾选，服务端仍会复核；参数：设备行；返回值：能否选择。 */
function selectable(machine:Machine):boolean{return !busy.value&&!confirmation.value&&!uncertain.value&&!reason(machine);}
/** 功能：保留本次显式勾选的设备编号；参数：勾选设备行；返回值：无。 */
function selectionChanged(rows:Machine[]){selectedIds.value=rows.map(row=>row.machine_id);}
/** 功能：读取管理员升级快照，失败保留上次数据，忽略失效授权期间的迟到响应；参数：无；返回值：异步完成。 */
async function load(){
 if(busy.value)return;
 if(!ui.authorized){ui.authOpen=true;return;}
 const current=++generation;busy.value=true;error.value='';
 try{
  const response=await api.mutate<OtaList>('/api/ota/list',{});
  if(current!==generation||!ui.authorized)return;
  if(!response.ok||!Array.isArray(response.releases)||!Array.isArray(response.jobs)||!Array.isArray(response.capabilities))throw new Error('升级列表格式不兼容');
  state.value=response;uncertain.value=false;deviceTable.value?.clearSelection();selectedIds.value=[];
 }catch(e){if(current===generation)error.value=e instanceof Error?e.message:'读取升级列表失败';}
 finally{if(current===generation)busy.value=false;}
}
/** 功能：冻结用户人工选择供最终确认，不创建任务；参数：无；返回值：无。 */
function review(){
 if(!ui.authorized){ui.authOpen=true;return;}
 if(busy.value||uncertain.value||!release.value||!chosen.value.length)return;
 if(chosen.value.some(machine=>reason(machine))){error.value='设备或发布状态已变化，请重新选择';return;}
 confirmation.value={release:{...release.value},machines:chosen.value.map(machine=>({machine_id:machine.machine_id,client_id:machine.client_id,label:machine.label}))};
}
/** 功能：明确确认后只发送一次管理写入，失败要求先读取核实；参数：无；返回值：异步完成，创建任务不表示已安装。 */
async function submit(){
 const draft=confirmation.value;if(busy.value||uncertain.value||!draft)return;
 if(!ui.authorized){ui.authOpen=true;return;}
 // 确认弹层期间设备可能刷新或发布过期，按冻结身份复核，不能悄悄改成另一设备或版本。
 if(releaseSeq.value!==draft.release.release_seq||draft.machines.some(item=>{const machine=machines.value.find(row=>row.machine_id===item.machine_id);return !machine||machine.client_id!==item.client_id||Boolean(reason(machine));})){error.value='确认期间状态已变化，请取消并重新读取';return;}
 const current=++generation;busy.value=true;error.value='';notice.value='';results.value=[];
 try{
  const response=await createOtaJobs((path,body)=>api.mutate<OtaCreateResponse>(path,body),draft.machines.map(item=>item.machine_id),draft.release.release_seq);
  if(current!==generation||!ui.authorized)return;
  if(!response.ok||!Array.isArray(response.results))throw new Error('任务响应无法识别，请读取列表核实');
  results.value=response.results;confirmation.value=null;deviceTable.value?.clearSelection();selectedIds.value=[];
  // 仅合并服务端确认的任务，部分失败保留逐设备原因，避免把批量 HTTP 成功误报全部完成。
  if(state.value)for(const result of response.results){if(result.job)state.value.jobs=[result.job,...state.value.jobs.filter(job=>job.job_id!==result.job!.job_id)];}
  notice.value='任务创建请求已返回，请查看逐设备结果。离线设备等待连接；禁用或暂停状态不会被启用。';
 }catch(e){if(current===generation){error.value=e instanceof Error?e.message:'创建结果未确认';uncertain.value=true;}}
 finally{if(current===generation)busy.value=false;}
}
/** 功能：关闭确认弹层时保留未提交选择；参数：无；返回值：无。 */
function closeConfirmation(){if(!busy.value)confirmation.value=null;}
/** 功能：用最新快照显示设备名，缺失时保留编号；参数：设备编号；返回值：显示名称。 */
function machineName(id:number):string{return machines.value.find(machine=>machine.machine_id===id)?.label||`设备 #${id}`;}
/** 功能：按任务绑定身份计算在线展示，避免借其他身份上报推断领取；参数：设备编号和client_id；返回值：当前是否在线。 */
function jobOnline(id:number,client:string):boolean{const machine=machines.value.find(item=>item.machine_id===id&&item.client_id===client);return Boolean(machine&&online(machine,data.now));}
// 授权清除后丢弃管理元数据，迟到响应不能重新填充；不持久化口令或升级选择。
watch(()=>ui.authorized,value=>{if(!value){generation++;busy.value=false;state.value=null;confirmation.value=null;results.value=[];notice.value='';selectedIds.value=[];}});
// 更换目标版本需重新勾选；普通15秒快照刷新保留同一编号选择，提交时仍重新核对身份。
watch(releaseSeq,()=>{deviceTable.value?.clearSelection();selectedIds.value=[];});
onUnmounted(()=>{generation++;});
</script>

<template>
 <section class="panel ota-panel" aria-labelledby="manual-ota-title">
  <div class="panel-head"><h2 id="manual-ota-title" class="panel-title">手动升级采集器</h2><el-button :loading="busy" :disabled="Boolean(confirmation)" @click="load">{{ui.authorized?'读取升级列表':'管理授权'}}</el-button></div>
  <div class="panel-body">
   <p>选择已验签发布和设备，确认后创建任务；不会自动追随最新版。只替换采集器，不升级官方 Codex，不改变账号、周期、模式、禁用或暂停状态。</p>
   <p class="muted">旧设备需先手动安装支持版、独立升级器和可信根。离线设备等待正常连接；禁用设备需在本机显式恢复，本面板不提供启用操作。</p>
   <el-alert v-if="error" :title="error" :description="state?'保留上次快照。创建结果不确定时请先关闭确认窗口，再读取列表核实。':undefined" type="error" :closable="false" show-icon role="alert"/>
   <el-alert v-if="notice" :title="notice" type="info" :closable="false" show-icon class="global-alert"/>
   <template v-if="state&&ui.authorized">
    <el-form label-position="top" novalidate class="ota-form" @submit.prevent="review">
     <el-form-item label="可信发布版本（须手动选择）"><el-select v-model="releaseSeq" clearable placeholder="选择版本，不自动选择最新版本" :disabled="busy||Boolean(confirmation)" aria-label="可信发布版本"><el-option v-for="item in state.releases" :key="item.release_seq" :value="item.release_seq" :label="`${item.version} · #${item.release_seq} · ${item.platform}`" :disabled="item.expires_at<=data.now||item.platform!=='win-x64'"/></el-select></el-form-item>
     <p v-if="!state.releases.length" role="status">暂无已验签发布。正式信任根及发布尚未配置时不能升级。</p>
     <p v-if="release" class="small-label">可信根 {{release.key_id}} · 有效至 {{date(release.expires_at)}} · 序号 #{{release.release_seq}}</p>
     <el-table ref="deviceTable" :data="machines" row-key="machine_id" empty-text="暂无设备" @selection-change="selectionChanged">
      <el-table-column type="selection" width="48" :selectable="selectable" :reserve-selection="true"/>
      <el-table-column label="设备" min-width="150"><template #default="{row}"><strong>{{row.label}}</strong><small class="cell-sub">#{{row.machine_id}} · {{online(row,data.now)?'在线':'离线，等待连接'}}</small></template></el-table-column>
      <el-table-column label="升级能力 / 选择条件" min-width="260"><template #default="{row}">{{reason(row)||'可创建任务'}}<small v-if="state.capabilities.find(cap=>cap.machine_id===row.machine_id&&cap.client_id===row.client_id)" class="cell-sub">已上报能力 · 最高接受序号 #{{state.capabilities.find(cap=>cap.machine_id===row.machine_id)?.seq}}</small></template></el-table-column>
     </el-table>
     <el-button type="primary" :disabled="busy||uncertain||!release||!chosen.length" @click="review">确认所选设备与版本（{{chosen.length}} 台）</el-button>
     <p v-if="uncertain" role="status">创建结果尚未核实，已阻止再次提交。请读取升级列表。</p>
    </el-form>
    <div v-if="results.length" class="ota-results" aria-live="polite"><h3>本次逐设备结果</h3><p v-for="result in results" :key="result.machine_id">{{machineName(result.machine_id)}}：{{result.error?otaError(result.error):result.job?'任务已创建 · '+result.job.job_id:'服务端未返回任务，请读取核实'}}</p></div>
    <h3>升级任务快照</h3><p class="small-label">点击“读取升级列表”核实最新阶段。本地检查通过不代表真实额度已送达。</p>
    <el-table :data="jobs" row-key="job_id" empty-text="尚无升级任务">
     <el-table-column label="设备 / 任务" min-width="160"><template #default="{row}">{{machineName(row.machine_id)}}<small class="cell-sub">{{row.job_id}}</small></template></el-table-column>
     <el-table-column label="目标序号" width="110"><template #default="{row}">#{{row.seq}}</template></el-table-column>
     <el-table-column label="阶段 / 错误" min-width="260"><template #default="{row}">{{otaStatus(row,jobOnline(row.machine_id,row.client_id))}}<small v-if="row.error" class="cell-sub">{{otaError(row.error)}}</small></template></el-table-column>
     <el-table-column label="更新时间" min-width="170"><template #default="{row}">{{date(row.updated_at)}}</template></el-table-column>
    </el-table>
   </template>
   <p v-else class="muted" role="status">管理员显式读取后才展示可信版本、设备能力和升级任务。</p>
  </div>
 </section>
 <el-dialog :model-value="Boolean(confirmation)" title="确认创建升级任务" width="min(560px,94vw)" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @close="closeConfirmation">
  <template v-if="confirmation"><p>目标版本：<strong>{{confirmation.release.version}}</strong> · #{{confirmation.release.release_seq}} · {{confirmation.release.platform}}</p><p>可信根：{{confirmation.release.key_id}}</p><ul><li v-for="machine in confirmation.machines" :key="machine.machine_id">{{machine.label}}（#{{machine.machine_id}}）</li></ul><el-alert title="仅为以上设备创建升级任务。离线等待连接；保留原禁用和暂停状态。" type="warning" :closable="false"/><p>任务会在客户端正常联系服务器时领取。创建成功不表示安装或真实上报验收完成。</p></template>
  <el-alert v-if="error" :title="error" type="error" :closable="false" role="alert"/>
  <template #footer><el-button :disabled="busy" @click="closeConfirmation">取消</el-button><el-button type="primary" :loading="busy" :disabled="uncertain||!ui.authorized" @click="submit">明确确认，创建任务</el-button></template>
 </el-dialog>
</template>

<style scoped>
.ota-panel{margin-top:20px}.ota-form{margin-top:20px}.ota-form .el-button{margin-top:16px}.ota-results{margin-top:20px}.cell-sub{overflow-wrap:anywhere}h3{font-size:1rem;margin-top:20px}
</style>
