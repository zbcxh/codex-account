<script setup lang="ts">
import {ref} from 'vue';import type {InputInstance} from 'element-plus';
defineOptions({inheritAttrs:false});defineProps<{modelValue:string;readonly?:boolean;autocomplete?:string}>();const emit=defineEmits<{(e:'update:modelValue',value:string):void}>();const visible=ref(false),input=ref<InputInstance>();
/** 功能：聚焦秘密字段；参数：无；返回值：无。 */
function focus(){input.value?.focus();}
/** 功能：选择字段以便剪贴板不可用时手动复制；参数：无；返回值：无。 */
function select(){input.value?.select();}
defineExpose({focus,select});
</script><template><div class="secret-field"><el-input ref="input" v-bind="$attrs" :model-value="modelValue" :type="visible?'text':'password'" :readonly="readonly" :autocomplete="autocomplete" @update:model-value="emit('update:modelValue',$event)"/><el-button :aria-label="visible?'隐藏内容':'显示内容'" :aria-pressed="visible" @click="visible=!visible">{{visible?'隐藏':'显示'}}</el-button></div></template>