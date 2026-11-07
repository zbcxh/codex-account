import {isIP} from 'node:net';

/** 功能：读取真实请求来源，仅在显式开启时信任本机代理；参数：请求与代理开关；返回值：来源IP或null。 */
export function requestSource(req,trustLoopbackProxy=false){
 const peer=String(req.socket.remoteAddress??'').replace(/^::ffff:/,'');
 if(!trustLoopbackProxy)return peer;
 if(peer!=='127.0.0.1'&&peer!=='::1')return null;
 const value=req.headers['x-quota-client-ip'];
 // 只接受代理覆盖的单个有效地址，禁止回环值借用本机读取特权。
 if(typeof value!=='string'||!isIP(value))return null;
 const source=value.replace(/^::ffff:/,'');
 return source==='::1'||source.startsWith('127.')?null:source;
}
