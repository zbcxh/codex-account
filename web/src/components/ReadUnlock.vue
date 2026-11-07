<script setup lang="ts">
import {ref} from 'vue';import {ElMessage} from 'element-plus';import type {FormInstance,FormRules} from 'element-plus';
import {api} from '../api';import {useData} from '../store';import {validateForm} from '../forms';import SecretInput from './SecretInput.vue';
import BrowserBindings from './BrowserBindings.vue';
const data=useData(),opened=ref(false),busy=ref(false),error=ref(''),form=ref<FormInstance>(),model=ref({key:''});
const rules:FormRules={key:[{required:true,message:'请输入当前bootstrap管理口令',trigger:'blur'}]};
/** 功能：显式解锁读取后重新加载快照，不保存口令或获得管理权限；参数：无；返回值：异步完成。 */
async function submit(){
 if(busy.value||!await validateForm(form.value))return;busy.value=true;error.value='';
 try{await api.unlock(model.value.key);model.value.key='';await data.refresh();if(data.readLocked){error.value='解锁已返回，但当前来源仍被拒绝，请检查代理来源配置';return;}if(data.error){error.value='读取解锁已成功，但数据加载失败：'+data.error;return;}opened.value=false;ElMessage.success('当前来源读取已解锁，管理操作仍需单独授权');}
 catch(e){error.value=e instanceof Error?e.message:'解锁失败';}finally{busy.value=false;}
}
/** 功能：关闭时清除敏感输入和错误；参数：无；返回值：无。 */
function closed(){model.value.key='';error.value='';form.value?.clearValidate();}
</script>
<template><el-alert v-if="data.readLocked" title="当前来源尚未获得面板读取权限" type="warning" :closable="false" show-icon class="global-alert"><p>可输入当前bootstrap管理口令解锁当前来源8小时；设备配对码不能解锁。读取解锁不等于管理授权。</p><el-button @click="opened=true">解锁读取</el-button><BrowserBindings/></el-alert><el-dialog v-model="opened" title="解锁面板读取" width="min(460px,94vw)" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @closed="closed"><el-form ref="form" :model="model" :rules="rules" label-position="top" novalidate @submit.prevent="submit"><el-form-item label="当前bootstrap管理口令" prop="key"><SecretInput v-model="model.key" autocomplete="current-password"/></el-form-item><el-alert v-if="error" :title="error" type="error" :closable="false" show-icon/></el-form><template #footer><el-button :disabled="busy" @click="opened=false">取消</el-button><el-button type="primary" :loading="busy" @click="submit">解锁读取</el-button></template></el-dialog></template>
