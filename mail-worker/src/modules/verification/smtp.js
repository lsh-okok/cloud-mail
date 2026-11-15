import nodemailer from 'nodemailer';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { FeatureError, positiveInt } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { normalizeEmail } from '../mail-sources/service.js';
import { normalizedHost, publicAddress, resolveDestination } from './network.js';
import { isIP } from 'node:net';

export const SMTP_PRESETS = [
  ['163','smtp.163.com'],['126','smtp.126.com'],['Yeah','smtp.yeah.net'],['QQ/Foxmail','smtp.qq.com'],
  ['Yahoo','smtp.mail.yahoo.com'],['Gmail','smtp.gmail.com'],['阿里个人邮箱','smtp.aliyun.com'],
].map(([name,host])=>({name,host,port:465,encryption:'tls',help:'使用服务商提供的 SMTP 授权码或应用专用密码；请在邮箱安全设置中启用 SMTP。'}));
const iso = value => value == null ? null : new Date(value).toISOString();
export function smtpDto(row) {
  return row ? {id:row.id,host:row.host,port:row.port,email:row.email,encryption:row.encryption,enabled:!!row.enabled,
    hasPassword:!!row.password_encrypted,lastUsedAt:iso(row.last_used_at),revision:row.revision} : null;
}
export function smtpConfiguration(env) {
  return {default:smtpDto(env.db.prepare("SELECT * FROM verification_smtp WHERE kind='default'").get()),
    pool:env.db.prepare("SELECT * FROM verification_smtp WHERE kind='pool' ORDER BY email,id").all().map(smtpDto),
    presets:SMTP_PRESETS,encryptionAvailable:!!env.secretVault};
}
export function availableSenders(env) {
  const pool=env.db.prepare("SELECT * FROM verification_smtp WHERE kind='pool' ORDER BY coalesce(last_used_at,0),id").all();
  const candidates=pool.length ? pool : env.db.prepare("SELECT * FROM verification_smtp WHERE kind='default'").all();
  const usable=candidates.filter(row=>{
    if(!row.enabled||!row.password_encrypted||!env.secretVault)return false;
    try {return !!env.secretVault.decrypt(row.password_encrypted,`verification-smtp:${row.id}`);}catch{return false;}
  });
  if(!env.secretVault || !usable.length) throw new FeatureError(400,'SMTP_UNAVAILABLE',pool.length?'The sender pool has no enabled configured account.':'Configure an encrypted SMTP sender before sending test emails.');
  return usable;
}
export function saveSmtp(env,data,{id,kind='pool',actorId=null,requestId=''}={}) {
  const current = kind==='default' ? env.db.prepare("SELECT * FROM verification_smtp WHERE kind='default'").get() : id ? env.db.prepare("SELECT * FROM verification_smtp WHERE id=? AND kind='pool'").get(id) : null;
  if(id && !current) throw new FeatureError(404,'SMTP_NOT_FOUND','The sender no longer exists.');
  id=current?.id || randomUUID();
  if(!env.secretVault) throw new FeatureError(503,'ENCRYPTION_NOT_CONFIGURED','Configure data encryption before saving SMTP credentials.');
  const host=normalizedHost(data.host??current?.host), port=positiveInt(data.port??current?.port,'port',{max:65535});
  if(isIP(host) && !publicAddress(host) && !(env.verificationSmtpAllowCidrs?.length)) throw new FeatureError(400,'UNSAFE_DESTINATION','Private SMTP requires an explicit CIDR allowlist.');
  const email=normalizeEmail(data.email??current?.email), encryption=data.encryption??current?.encryption;
  if(!email || !['tls','starttls'].includes(encryption) || (data.enabled!==undefined && typeof data.enabled!=='boolean') ||
    (data.clearPassword!==undefined && typeof data.clearPassword!=='boolean')) throw new FeatureError(400,'INVALID_SMTP','Provide a valid sender, encrypted transport and enabled state.');
  if(data.password!==undefined && (typeof data.password!=='string' || data.password.length>500 || /[\r\n\u0000]/.test(data.password))) throw new FeatureError(400,'INVALID_SMTP_PASSWORD','SMTP authorization codes must contain at most 500 characters without control characters.');
  if(data.clearPassword && kind!=='default') throw new FeatureError(400,'INVALID_SMTP_PASSWORD','Only the default sender supports explicitly clearing its password.');
  const password=data.clearPassword ? null : data.password ? env.secretVault.encrypt(data.password,`verification-smtp:${id}`) : current?.password_encrypted;
  if(!current && !password) throw new FeatureError(400,'SMTP_PASSWORD_REQUIRED','Enter the SMTP authorization code for a new sender.');
  try {
    return env.db.transaction(()=>{
      env.db.prepare(`INSERT INTO verification_smtp(id,kind,host,port,email,encryption,password_encrypted,enabled)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET host=excluded.host,port=excluded.port,email=excluded.email,
        encryption=excluded.encryption,password_encrypted=excluded.password_encrypted,enabled=excluded.enabled,revision=verification_smtp.revision+1`)
        .run(id,kind,host,port,email,encryption,password??null,Number(data.enabled??!!(current?.enabled??true)));
      appendAudit(env.db,{actorId,requestId,action:'verification.smtp.save',objectType:'smtp',objectId:id});
      return smtpDto(env.db.prepare('SELECT * FROM verification_smtp WHERE id=?').get(id));
    }).immediate();
  } catch(error) {if(error.code?.startsWith('SQLITE_CONSTRAINT')) throw new FeatureError(409,'SMTP_EMAIL_EXISTS','A sender with that email already exists.'); throw error;}
}
export async function validateSmtpDestination(env,row,signal) {
  return resolveDestination(env,row.host,{smtp:true,signal});
}
async function nativeSmtp({config,message,signal,address}) {
  let socket,closed=Promise.resolve();
  const transport=nodemailer.createTransport({host:address,port:config.port,secure:config.encryption==='tls',requireTLS:true,
    ignoreTLS:false,auth:{user:config.email,pass:config.password},tls:{servername:config.host,minVersion:'TLSv1.2',rejectUnauthorized:true},
    getSocket(_options,callback) {
      if(signal?.aborted){callback(signal.reason||new Error('Cancelled'));return;}
      socket=net.connect({host:address,port:config.port});
      // Keep ownership of the actual TCP socket. STARTTLS wraps this socket;
      // destroying its underlying handle also closes the encrypted session.
      closed=new Promise(resolve=>socket.once('close',resolve));
      socket.once('error',()=>{});
      callback(null,{connection:socket,secured:false});
    },
    connectionTimeout:10000,greetingTimeout:10000,socketTimeout:60000,logger:false,debug:false});
  const abort=()=>{socket?.destroy();transport.close();}; signal?.addEventListener('abort',abort,{once:true});
  try { signal?.throwIfAborted(); return await transport.sendMail(message); }
  finally {signal?.removeEventListener('abort',abort);socket?.destroy();transport.close();await closed;}
}
export async function smtpSend(env,row,{recipient,marker,signal,destination}) {
  const password=env.secretVault.decrypt(row.password_encrypted,`verification-smtp:${row.id}`);
  const config={host:row.host,port:row.port,email:row.email,encryption:row.encryption,password};
  const message={from:row.email,to:recipient,subject:`Cloud Mail verification ${marker}`,text:`Mailbox receipt verification.\nVerification marker: ${marker}\nRecipient: ${recipient}`,
    messageId:`<${marker}@${row.email.split('@')[1]}>`,disableFileAccess:true,disableUrlAccess:true};
  signal?.throwIfAborted();
  const result=await (env.verificationTransports?.smtp||nativeSmtp)({config,message,signal,...destination});
  signal?.throwIfAborted();
  if(!result?.accepted?.some(address=>String(address).toLowerCase()===recipient.toLowerCase())) throw new FeatureError(502,'SMTP_UNCERTAIN','SMTP did not confirm acceptance for this recipient.');
}
