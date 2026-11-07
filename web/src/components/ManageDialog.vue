<script setup lang="ts">
import {computed,reactive,ref,watch,onMounted,onUnmounted} from 'vue';import {ElMessage,ElMessageBox} from 'element-plus';import type {FormInstance,FormRules} from 'element-plus';import {useUI,useData} from '../store';import {api,ApiError,request} from '../api';import {validateForm} from '../forms';import SecretInput from './SecretInput.vue';import {router} from '../router';import type {Action} from '../types';
const ui=useUI(),data=useData(),form=ref<FormInstance>(),busy=ref(false),error=ref(''),uncertain=ref(false),secret=ref(''),secretInput=ref<{focus:()=>void;select:()=>void}>();let baseline='';
const model=reactive({status:'unknown',id:'',name:'',owner:'',note:'',label:'',minutes:5 as number|null,kind:'single',starts:new Date() as Date|null,ends:new Date() as Date|null,current:'',next:'',confirm:''});
const displayAction=ref<Action|null>(null);const kind=computed(()=>displayAction.value?.kind);const target=computed(()=>displayAction.value?.target||{});const titles:Record<string,string>={'account-status':'维护账号状态',alias:'保存账号映射',label:'修改设备名称',period:'设置单台上报周期','default-period':'设置默认上报周期',code:'生成配对码',revoke:'撤销配对码',bootstrap:'修改管理口令',hide:'更改账号显示状态','remove-alias':'删除名称映射'};
const dangerous=computed(()=>['revoke','hide','remove-alias'].includes(kind.value||''));
const rules=computed<FormRules>(()=>({id:[{required:true,message:'请输入账号ID',trigger:'blur'},{pattern:/^[A-Za-z0-9._:-]{6,128}$/,message:'账号ID需6～128位，只允许字母、数字、点、横线、下划线和冒号',trigger:'blur'}],name:[{required:true,message:'请输入名称',trigger:'blur'},{validator:(_r,v,cb)=>String(v).trim()?cb():cb(new Error('名称不能只有空格')),trigger:'blur'}],label:[{required:true,message:'请输入设备名称',trigger:'blur'}],current:[{required:true,message:'请输入当前管理口令',trigger:'blur'}],next:[{required:true,message:'请输入新管理口令',trigger:'blur'},{min:16,message:'至少16位字符',trigger:'blur'}],confirm:[{validator:(_r,v,cb)=>v===model.next?cb():cb(new Error('两次输入不一致')),trigger:'blur'}],starts:[{type:'date',required:true,message:'请选择开始时间',trigger:'change'}],ends:[{type:'date',required:true,message:'请选择结束时间',trigger:'change'}]}));
watch(()=>ui.action,value=>{error.value='';uncertain.value=false;form.value?.clearValidate();if(!value)return;displayAction.value=value;const t=value.target||{};Object.assign(model,{status:t.account_status||'unknown',id:t.account_id||'',name:t.display_name||'',owner:t.owner||'',note:t.note||'',label:t.label||'',minutes:value.kind==='default-period'?data.snapshot?.reporting_config.default_interval_minutes??5:(t.reporting as Record<string,unknown>)?.override_interval_minutes??null,kind:t.kind||'single',starts:new Date(),ends:new Date(Date.now()+((t.kind||'single')==='single'?600000:86400000)),current:'',next:'',confirm:''});baseline=JSON.stringify(model);});
/** 功能：提示未保存修改，不在后台丢弃草稿；参数：无；返回值：是否允许关闭。 */
async function canClose(){if(busy.value)return false;if(!ui.action||dangerous.value||baseline===JSON.stringify(model))return true;return ElMessageBox.confirm('尚未保存的修改将丢失。是否放弃修改？','放弃修改',{confirmButtonText:'放弃修改',cancelButtonText:'继续编辑',type:'warning'}).then(()=>true).catch(()=>false);}
/** 功能：受控关闭操作弹窗；参数：done为组件关闭回调；返回值：异步完成。 */
async function beforeClose(done?:()=>void){if(await canClose()){ui.action=null;done?.();}}
/** 功能：清除表单中的敏感值；参数：无；返回值：无。 */
function clearSecrets(){model.current='';model.next='';model.confirm='';}
/** 功能：关闭动画结束后清理展示动作，避免淡出时布局跳变；参数：无；返回值：无。 */
function closed(){clearSecrets();if(!ui.action)displayAction.value=null;}
/** 功能：将本机Date转换为Unix秒并等待服务端确认，不自动重试不确定写入；参数：无；返回值：异步完成。 */
async function submit(){
 if(busy.value||uncertain.value||!ui.action)return;if(!ui.authorized){ui.authOpen=true;return;}
 if(!await validateForm(form.value))return;
 const action=ui.action;const t=action.target||{};error.value='';
 if(['period','default-period'].includes(action.kind)&&(model.minutes===null?action.kind==='default-period':!Number.isInteger(model.minutes)||model.minutes<1||model.minutes>1440)){error.value='请输入1～1440的整数；单台周期留空表示跟随默认';return;}
 if(action.kind==='bootstrap'&&(model.next!==model.confirm||new TextEncoder().encode(model.next).length>256||model.next.trim()!==model.next)){error.value='新口令须16位以上、最多256字节、首尾无空格且两次一致';return;}
 if(action.kind==='code'&&model.kind!=='permanent'&&(Number(model.ends)<=Date.now()||(model.kind==='timed'&&Number(model.ends)<=Number(model.starts)))){error.value='结束时间必须晚于开始时间及当前时间';return;}
 busy.value=true;
 try{
  let generated='';
  if(action.kind==='alias')await api.mutate(`/api/account/${encodeURIComponent(model.id)}/alias`,{display_name:model.name.trim(),owner:model.owner.trim()||null,note:model.note.trim()||null});
  if(action.kind==='account-status')await api.mutate('/api/account-status/'+encodeURIComponent(model.id),{status:model.status});
  if(action.kind==='label')await api.mutate(`/api/machine/${t.machine_id}/label`,{label:model.label.trim()});
  if(action.kind==='default-period')await api.mutate('/api/reporting-config',{interval_minutes:model.minutes});
  if(action.kind==='period')await api.mutate(`/api/machine/${t.machine_id}/reporting-config`,{interval_minutes:model.minutes});
  if(action.kind==='code'){const body:Record<string,unknown>={name:model.name.trim(),kind:model.kind};if(model.kind==='timed')body.starts_at=Math.floor(Number(model.starts)/1000);if(model.kind!=='permanent')body.expires_at=Math.floor(Number(model.ends)/1000);const result=await api.mutate<{code:string}>('/api/pairing-codes',body);generated=result.code;}
  if(action.kind==='revoke')await api.mutate(`/api/pairing-codes/${t.id}/revoke`,{});
  if(action.kind==='bootstrap'){await request('/api/admin/bootstrap',{method:'POST',credential:model.current,body:{new_bootstrap:model.next,confirm_bootstrap:model.confirm}});ui.credential(model.next);}
  if(action.kind==='hide')await api.mutate(`/api/account/${encodeURIComponent(String(t.account_id))}/hidden`,{},t.hidden?'DELETE':'POST');
  if(action.kind==='remove-alias')await api.mutate(`/api/account/${encodeURIComponent(String(t.account_id))}/alias`,undefined,'DELETE');
  ui.action=null;clearSecrets();if(generated)secret.value=generated;
  ElMessage.success(action.kind==='code'?'配对码已生成':action.kind==='revoke'?'配对码已撤销':action.kind==='bootstrap'?'管理口令已修改':action.kind==='remove-alias'?'映射已删除':'设置已保存');
  await data.refresh();
  if(['code','revoke'].includes(action.kind)){try{ui.codes=(await api.codes()).codes;}catch{ui.codesLoaded=false;ElMessage.warning('操作已完成，但列表未刷新，请手动重新加载');}}
 }catch(e){error.value=e instanceof Error?e.message:'操作失败，未确认保存';if(e instanceof ApiError&&e.code==='timeout')uncertain.value=true;}
 finally{busy.value=false;}
}
// 同一关闭保护处理路由跳转和离开页面，避免草稿意外丢失。
const removeGuard=router.beforeEach(async()=>{if(!ui.action)return true;if(!await canClose())return false;ui.action=null;return true;});
/** 功能：在离开页面时保护未提交草稿；参数：卸载事件；返回值：无。 */
function protectUnload(event:BeforeUnloadEvent){if(ui.action&&baseline!==JSON.stringify(model)){event.preventDefault();event.returnValue='';}}
onMounted(()=>window.addEventListener('beforeunload',protectUnload));
onUnmounted(()=>{removeGuard();window.removeEventListener('beforeunload',protectUnload);clearSecrets();secret.value='';});
/** 功能：复制当次配对码，失败时只选中输入框；参数：无；返回值：异步完成，不在提示中回显秘密。 */
async function copy(){try{await navigator.clipboard.writeText(secret.value);ElMessage.success('配对码已复制');}catch{secretInput.value?.focus();secretInput.value?.select();ElMessage.info('剪贴板不可用，请按Ctrl+C复制已选中内容');}}
</script>
<template><el-dialog :model-value="Boolean(ui.action)" :title="titles[kind||'']" width="min(520px,94vw)" :before-close="beforeClose" :close-on-click-modal="false" :close-on-press-escape="!busy" @closed="closed"><el-alert v-if="!ui.authorized" title="管理授权已失效，非敏感草稿已保留" type="warning" :closable="false"><el-button @click="ui.authOpen=true">重新授权</el-button></el-alert><el-form ref="form" :model="model" :rules="rules" label-position="top" novalidate @submit.prevent="submit">
<el-form-item v-if="kind==='account-status'" label="管理员账号状态"><el-select v-model="model.status"><el-option label="正常" value="normal"/><el-option label="受限" value="restricted"/><el-option label="未知" value="unknown"/></el-select></el-form-item><template v-if="kind==='alias'"><el-form-item label="账号ID" prop="id"><el-input v-model="model.id" :readonly="Boolean(target.account_id)" maxlength="128"/></el-form-item><el-form-item label="映射名称" prop="name"><el-input v-model="model.name" maxlength="120"/></el-form-item><el-form-item label="负责人" prop="owner"><el-input v-model="model.owner" maxlength="60"/></el-form-item><el-form-item label="备注" prop="note"><el-input v-model="model.note" type="textarea" :autosize="{minRows:2,maxRows:5}" resize="none" maxlength="200"/></el-form-item></template>
<el-form-item v-if="kind==='label'" label="设备名称" prop="label"><el-input v-model="model.label" maxlength="120"/></el-form-item>
<template v-if="kind==='period'||kind==='default-period'"><p class="muted">下次成功上报时下发，实际周期读回确认后生效。</p><el-form-item label="上报周期（分钟）" prop="minutes"><el-input-number v-model="model.minutes" :min="1" :max="1440" :precision="0" :controls="false"/></el-form-item><el-button v-if="kind==='period'" link @click="model.minutes=null">跟随默认周期</el-button></template>
<template v-if="kind==='code'"><el-alert title="配对码明文仅在生成当次显示，请妥善保管。" type="info" :closable="false"/><el-form-item label="名称备注" prop="name"><el-input v-model="model.name" maxlength="120"/></el-form-item><el-form-item label="类型"><el-radio-group v-model="model.kind"><el-radio value="single">单次</el-radio><el-radio value="timed">限时</el-radio><el-radio value="permanent">永久</el-radio></el-radio-group></el-form-item><el-form-item v-if="model.kind==='timed'" label="开始时间（本机时区）" prop="starts"><el-date-picker v-model="model.starts" type="datetime" format="YYYY-MM-DD HH:mm" placeholder="选择开始时间"/></el-form-item><el-form-item v-if="model.kind!=='permanent'" label="结束时间（本机时区）" prop="ends"><el-date-picker v-model="model.ends" type="datetime" format="YYYY-MM-DD HH:mm" placeholder="选择结束时间"/></el-form-item></template>
<template v-if="kind==='bootstrap'"><el-alert title="修改后旧管理口令立即失效，设备令牌和正常上报不变。" type="warning" :closable="false"/><el-form-item label="当前管理口令" prop="current"><SecretInput v-model="model.current" autocomplete="current-password"/></el-form-item><el-form-item label="新管理口令" prop="next"><SecretInput v-model="model.next" autocomplete="new-password"/></el-form-item><el-form-item label="确认新管理口令" prop="confirm"><SecretInput v-model="model.confirm" autocomplete="new-password"/></el-form-item></template>
<el-alert v-if="dangerous" :title="kind==='revoke'?'撤销后此码不能再用于配对；已有设备不受影响':kind==='remove-alias'?'只删除名称映射，保留额度历史':target.hidden?'恢复账号在面板显示':'只隐藏账号，保留历史及映射；再次上报可能恢复显示'" :description="String(target.name||target.display_name||target.account_id||'')" type="warning" :closable="false" show-icon/>
<el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="global-alert"/>
</el-form><template #footer><el-button :disabled="busy" @click="beforeClose()">取消</el-button><el-button :type="dangerous?'danger':'primary'" :loading="busy" :disabled="uncertain||!ui.authorized" @click="submit">{{dangerous?'确认'+(kind==='revoke'?'撤销':kind==='remove-alias'?'删除映射':target.hidden?'恢复显示':'隐藏'):kind==='code'?'生成配对码':'保存修改'}}</el-button></template></el-dialog>
<el-dialog :model-value="Boolean(secret)" title="配对码已生成" width="min(520px,94vw)" :close-on-click-modal="false" @close="secret=''" @closed="secret=''"><p>明文仅显示本次。关闭后无法再次查询，请复制保存。勿将配对码当作管理授权。</p><SecretInput ref="secretInput" :model-value="secret" readonly aria-label="新配对码"/><el-button class="copy-button" @click="copy">复制配对码</el-button><template #footer><el-button type="primary" @click="secret=''">已保存，关闭</el-button></template></el-dialog></template>
