/** 功能：补充账号关联设备的最后接收报告时间，禁止混用其他账号的设备心跳；参数：只读数据库和账号卡片；返回值：包含 machines[].last_reported_at（Unix秒或null）的新卡片数组。 */
export function withAccountDeviceReportTimes(db, accounts) {
 const rows=db.prepare("SELECT account_id,machine_id,MAX(reported_at) AS last_reported_at FROM quota_snapshot WHERE account_id IS NOT NULL AND account_id<>'' GROUP BY account_id,machine_id").all();
 const times=new Map();
 // 联合键独立区分账号与设备，窗口多行和迟到补报按服务端接收时间聚合。
 for(const row of rows)times.set(JSON.stringify([row.account_id,row.machine_id]),row.last_reported_at);
 return accounts.map(account=>({...account,machines:account.machines.map(machine=>({...machine,
  last_reported_at:times.get(JSON.stringify([account.account_id,machine.machine_id]))??null}))}));
}
