import {request} from './api';

/** 功能：描述浏览器绑定安全元数据；参数：无；返回值：类型定义，时间为Unix秒，不含凭证或摘要。 */
export interface BrowserBinding {id:number;machine_id:number;name:string;created_at:number;expires_at:number;revoked_at:number|null}
/** 功能：描述绑定管理响应；参数：无；返回值：设备选项、绑定列表和当前浏览器状态类型。 */
export interface BrowserBindingList {devices:{machine_id:number;label:string;online:boolean}[];bindings:BrowserBinding[];current:{bound:boolean;online:boolean;id?:number;machine_id?:number;label?:string;expires_at?:number}}
/** 功能：显式读取绑定管理信息；参数：可选临时管理口令；返回值：绑定管理响应。 */
export function listBrowserBindings(credential?:string){return request<BrowserBindingList>('/api/browser-bindings/list',{method:'POST',body:{},credential});}
/** 功能：为当前浏览器绑定设备，凭证仅由服务端写入安全Cookie；参数：设备ID、名称和可选临时管理口令；返回值：绑定确认。 */
export function bindBrowser(machineId:number,name:string,credential?:string){return request<{ok:boolean;online:boolean}>('/api/browser-bindings/bind',{method:'POST',body:{machine_id:machineId,name},credential});}
/** 功能：撤销指定浏览器读取授权；参数：绑定ID和可选临时管理口令；返回值：撤销确认。 */
export function revokeBrowserBinding(id:number,credential?:string){return request<{ok:boolean}>('/api/browser-bindings/revoke',{method:'POST',body:{binding_id:id},credential});}
