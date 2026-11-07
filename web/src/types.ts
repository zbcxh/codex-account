export interface QuotaWindow {kind:string;label:string;minutes:number|null;used_percent:number|null;resets_at:number|null;reset_estimated?:boolean;reset_anchor_at?:number|null}
export interface Reporting {default_interval_minutes?:number;actual_known?:boolean;applied_interval_minutes:number;desired_interval_minutes:number;override_interval_minutes:number|null;pending:boolean;apply_error?:string|null;version?:number}
/** 功能：账号关联设备；参数：服务端账号快照；返回值：设备显示信息及该账号最后接收报告的秒时间，旧接口可缺省。 */
export interface Member {machine_id:number;label:string;stale:string;age_sec:number|null;last_reported_at?:number|null}
export interface QuotaEntity {account_id:string|null;display_name?:string|null;owner?:string|null;plan_type:string|null;windows:QuotaWindow[];collected_at:number|null;balance:string|null;has_credits:boolean|null;unlimited:boolean|null;hit_limit?:string|null;source?:string|null}
/** 功能：设备读模型；参数：服务端快照；返回值：设备状态与对应最新报告的采集器元数据，旧接口缺省或未知为空。 */
export interface Machine extends QuotaEntity {machine_id:number;client_id:string;label:string;hostname:string|null;last_ip?:string|null;last_ok_at:number|null;online_since?:number|null;age_sec:number|null;stale:string;online_window_sec:number;has_report:boolean;account_known:boolean;account_hidden?:boolean;cli_version:string|null;collector_version?:string|null;collector_build?:string|null;collector_sha256?:string|null;reporting:Reporting;skew_sec:number|null}
export interface Account extends QuotaEntity {key:string;machines:Member[];active_machine_count:number;in_use:boolean;divergence?:boolean;reset_mismatch?:boolean}
export interface Alias {account_status?:'normal'|'restricted'|'unknown';account_id:string;display_name:string|null;owner:string|null;note:string|null;hidden?:boolean;used_percent?:number|null;active_machine_count?:number;last_reported_at?:number|null;plan_type?:string|null}
export interface Snapshot {server_now:number;accounts:Account[];machines:Machine[];aliases:Alias[];reporting_config:{default_interval_minutes:number;version:number}}
export type CodeKind='single'|'timed'|'permanent';
export interface PairCode {id:number;name:string;kind:CodeKind;status:string;starts_at:number;expires_at:number|null;uses:number;last_used_at:number|null;revoked_at:number|null}
export type ActionKind='account-status'|'alias'|'label'|'period'|'default-period'|'code'|'revoke'|'bootstrap'|'hide'|'remove-alias';
export interface Action {kind:ActionKind;target?:Record<string,unknown>}
/** 功能：描述服务端验签通过的发布元数据；参数：列表响应；返回值：发布序号、固定平台、可信根及Unix秒有效期。 */
export interface OtaRelease {release_seq:number;version:string;platform:string;key_id:string;expires_at:number}
/** 功能：描述当前设备已上报的可信升级能力；参数：列表响应；返回值：绑定设备身份、最高接受序号与本机可信根。 */
export interface OtaCapability {machine_id:number;client_id:string;seq:number;key_id:string}
/** 功能：描述设备升级任务；参数：列表响应；返回值：任务阶段、安全错误码及Unix秒更新时间，不表示真实额度已送达。 */
export interface OtaJob {job_id:string;machine_id:number;client_id:string;seq:number;state:string;error:string|null;updated_at:number}
/** 功能：描述管理员升级列表；参数：管理员列表接口响应；返回值：已验签发布、任务及设备能力。 */
export interface OtaList {ok:boolean;releases:OtaRelease[];jobs:OtaJob[];capabilities:OtaCapability[]}
/** 功能：描述批量创建的逐设备结果；参数：管理员任务接口响应；返回值：成功任务或单设备安全错误码。 */
export interface OtaCreateResponse {ok:boolean;results:{machine_id:number;job?:OtaJob;error?:string}[]}
