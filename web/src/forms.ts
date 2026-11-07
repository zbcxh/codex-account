import {nextTick} from 'vue';
import type {FormInstance} from 'element-plus';
/** 功能：统一校验表单并将焦点移至首个错误字段；参数：Element Plus表单实例；返回值：是否通过。 */
export async function validateForm(form:FormInstance|undefined):Promise<boolean>{
 if(!form)return false;
 const root=form.$el as HTMLElement;
 root.querySelectorAll('[aria-invalid]').forEach(input=>input.removeAttribute('aria-invalid'));
 try{await form.validate();return true;}catch{
  await nextTick();
  const groups=[...root.querySelectorAll<HTMLElement>('.el-form-item.is-error')];
  for(const group of groups){const input=group.querySelector<HTMLInputElement>('input:not([type="hidden"]),textarea');const message=group.querySelector<HTMLElement>('.el-form-item__error');if(input){input.setAttribute('aria-invalid','true');if(message){if(!message.id)message.id='field-error-'+crypto.randomUUID();input.setAttribute('aria-describedby',message.id);}}}
  const first=groups[0]?.querySelector<HTMLInputElement>('input:not([type="hidden"]),textarea');first?.focus();first?.scrollIntoView({block:'nearest'});return false;
 }
}
