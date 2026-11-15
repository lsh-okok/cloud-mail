import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { FeatureError, positiveInt } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { availableSenders } from './smtp.js';
import { assertSnapshotCurrent, primary, sourceSnapshot, syncVerificationSources } from './sources.js';

export const stateFor=env=>env.verificationState||=( {} );
const iso=value=>value==null?null:new Date(value).toISOString();
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function taskDto(row) {
  return {id:row.id,number:row.number,type:row.type,status:row.status,total:row.total,processed:row.processed,passed:row.passed,failed:row.failed,pending:row.pending,
    createdAt:iso(row.created_at),startedAt:iso(row.started_at),finishedAt:iso(row.finished_at),parentTaskId:row.parent_task_id,
    options:JSON.parse(row.options_json),skipped:JSON.parse(row.skipped_json),originalUnpassed:row.original_unpassed,
    lastRecheck:row.last_recheck_json?JSON.parse(row.last_recheck_json):null,error:row.error};
}
export function getTask(env,id) {
  const row=env.db.prepare('SELECT * FROM verification_task WHERE id=?').get(id);
  if(!row)throw new FeatureError(404,'VERIFICATION_TASK_NOT_FOUND','The verification task does not exist.');
  return taskDto(row);
}
export function itemDto(row) {
  const snapshot=JSON.parse(row.snapshot_json);
  return {id:row.id,sourceId:row.source_id,mailboxId:snapshot.mailboxId,mailboxEmail:snapshot.mailboxEmail,recipient:snapshot.recipient,
    linkUrl:snapshot.linkUrl,mode:snapshot.mode,fingerprint:snapshot.fingerprint,result:row.result,processed:!!row.processed,phase:row.phase,
    marker:row.marker,senderEmail:row.sender_email,httpStatus:row.http_status,note:row.note,startedAt:iso(row.started_at),sentAt:iso(row.sent_at),checkedAt:iso(row.checked_at)};
}
function ids(value,name) {
  if(value===undefined)return null;
  if(!Array.isArray(value)||value.length<1||value.length>500||value.some(id=>typeof id!=='string'||!id||id.length>128))throw new FeatureError(400,'INVALID_SELECTION',`${name} must contain between 1 and 500 IDs before deduplication.`);
  return [...new Set(value)];
}
export function taskOptions(data) {
  if(!['link','receive'].includes(data.type))throw new FeatureError(400,'INVALID_VERIFICATION_TYPE','Choose link or receive verification.');
  const sample=data.sample??1;
  if(!['all',1,3,5].includes(sample))throw new FeatureError(400,'INVALID_SAMPLE','Choose all, 1, 3 or 5 recipients per mailbox.');
  const range=(value,name,min,max,fallback)=>{const n=positiveInt(value,name,{max,fallback});if(n<min)throw new FeatureError(400,'INVALID_PARAMETER',`${name} must be at least ${min}.`);return n;};
  const mailboxIds=ids(data.mailboxIds,'mailboxIds'), sourceIds=ids(data.sourceIds,'sourceIds');
  if(mailboxIds&&sourceIds)throw new FeatureError(400,'INVALID_SELECTION','Choose mailboxIds or sourceIds, not both.');
  return {type:data.type,mailboxIds,sourceIds,sample,timeoutSeconds:range(data.timeoutSeconds,'timeoutSeconds',1,60,10),
    concurrency:range(data.concurrency,'concurrency',1,10,5),waitSeconds:range(data.waitSeconds,'waitSeconds',5,300,60),
    sendIntervalMs:range(data.sendIntervalMs,'sendIntervalMs',200,10000,1000)};
}
function requestKey(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{8,128}$/.test(value))throw new FeatureError(400,'IDEMPOTENCY_KEY_REQUIRED','Provide an idempotencyKey of 8 to 128 safe characters.');
  return value;
}
function existingTask(env,key,hash) {
  const row=env.db.prepare('SELECT * FROM verification_task WHERE idempotency_key=?').get(key);
  if(!row)return null;
  if(row.request_hash!==hash)throw new FeatureError(409,'IDEMPOTENCY_CONFLICT','This idempotency key was already used with different parameters.');
  return taskDto(row);
}
function ensureCapacity(env) {
  if(env.db.prepare("SELECT count(*) count FROM verification_task WHERE status IN ('queued','running')").get().count>=4)throw new FeatureError(429,'VERIFICATION_BUSY','At most four verification tasks may be active.');
}
function insertTask(env,{key,hash,options,snapshots,parentTaskId=null,skipped=[],originalUnpassed=0,actor={},recheck=false}) {
  if(!snapshots.length)throw new FeatureError(400,'NO_VERIFICATION_TARGETS','No eligible verification recipients are available.');
  if(snapshots.length>20000)throw new FeatureError(400,'VERIFICATION_TOO_LARGE','Narrow the task to at most 20000 recipients.');
  ensureCapacity(env);
  const id=randomUUID(),now=Date.now();
  env.db.prepare(`INSERT INTO verification_task(id,type,options_json,parent_task_id,total,pending,skipped_json,original_unpassed,created_at,idempotency_key,request_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,options.type,JSON.stringify(options),parentTaskId,snapshots.length,snapshots.length,JSON.stringify(skipped),originalUnpassed,now,key,hash);
  const insert=env.db.prepare(`INSERT INTO verification_item(id,task_id,ordinal,source_id,snapshot_json,marker,sender_email,sent_at) VALUES(?,?,?,?,?,?,?,?)`);
  for(let index=0;index<snapshots.length;index++) {
    const entry=snapshots[index],snapshot=entry.snapshot||entry;
    insert.run(randomUUID(),id,index,snapshot.id,JSON.stringify(snapshot),recheck?entry.marker:options.type==='receive'?`cmv-${randomBytes(24).toString('hex')}`:null,
      recheck?entry.sender_email:null,recheck?entry.sent_at:null);
  }
  appendAudit(env.db,{...actor,action:recheck?'verification.task.recheck':'verification.task.create',objectType:'verification',objectId:id,count:snapshots.length});
  return getTask(env,id);
}
export function createVerificationTask(env,data,{actor={},requestUrl='https://localhost'}={}) {
  primary(env); const options=taskOptions(data),key=requestKey(data.idempotencyKey),hash=digest({options,confirmSend:data.confirmSend===true});
  if(options.type==='receive'&&data.confirmSend!==true)throw new FeatureError(400,'SEND_CONFIRMATION_REQUIRED','Explicitly confirm sending test emails.');
  return env.db.transaction(()=>{
    const existing=existingTask(env,key,hash);if(existing)return existing;
    syncVerificationSources(env);
    if(options.type==='receive')availableSenders(env);
    let rows=env.db.prepare('SELECT * FROM verification_source WHERE eligible=1 ORDER BY mailbox_id,recipient,id').all();
    if(options.mailboxIds) {
      for(const id of options.mailboxIds)if(!rows.some(row=>row.mailbox_id===id))throw new FeatureError(400,'INVALID_SELECTION','A selected mailbox is disabled, removed, conflicted or has no eligible recipients.');
      rows=rows.filter(row=>options.mailboxIds.includes(row.mailbox_id));
    }
    if(options.sourceIds) {
      for(const id of options.sourceIds)if(!rows.some(row=>row.id===id))throw new FeatureError(400,'INVALID_SELECTION','A selected verification source is unavailable.');
      rows=rows.filter(row=>options.sourceIds.includes(row.id));
    }
    if(options.sample!=='all') {
      const grouped=new Map();for(const row of rows){const list=grouped.get(row.mailbox_id)||[];list.push(row);grouped.set(row.mailbox_id,list);}
      rows=[];for(const group of grouped.values()) {
        for(let index=group.length-1;index>0;index--){const other=randomInt(index+1);[group[index],group[other]]=[group[other],group[index]];}
        rows.push(...group.slice(0,options.sample));
      }
    }
    if(rows.length>20000)throw new FeatureError(400,'VERIFICATION_TOO_LARGE','Narrow the task to at most 20000 recipients.');
    const snapshots=rows.map(row=>sourceSnapshot(env,row,requestUrl));
    return insertTask(env,{key,hash,options,snapshots,actor});
  }).immediate();
}
export function recheckVerificationTask(env,id,data,{actor={}}={}) {
  primary(env);const key=requestKey(data.idempotencyKey),hash=digest({recheck:id});
  const outcome=env.db.transaction(()=>{
    const existing=existingTask(env,key,hash);if(existing)return existing;
    const parent=getTask(env,id);
    if(['queued','running'].includes(parent.status))throw new FeatureError(409,'TASK_STILL_ACTIVE','Stop or finish the original task before rechecking.');
    syncVerificationSources(env);
    const rows=env.db.prepare("SELECT * FROM verification_item WHERE task_id=? AND result!='passed' ORDER BY ordinal").all(id),snapshots=[],skipped=[];
    for(const row of rows) {
      const snapshot=JSON.parse(row.snapshot_json);
      try {assertSnapshotCurrent(env,snapshot);if(parent.type==='receive'&&(!row.marker||!row.sent_at))throw new Error('No persisted send intent exists; create and confirm a new receive task.');
        snapshots.push({snapshot,marker:row.marker,sender_email:row.sender_email,sent_at:row.sent_at});}
      catch(error){skipped.push({sourceId:row.source_id,recipient:snapshot.recipient,reason:error.code==='VERIFICATION_POLICY_CHANGED'?error.message:error.message?.startsWith('No persisted')?error.message:'The source or policy is no longer eligible.'});}
    }
    const summary={createdAt:new Date().toISOString(),originalUnpassed:rows.length,total:snapshots.length,skipped};
    env.db.prepare('UPDATE verification_task SET last_recheck_json=? WHERE id=?').run(JSON.stringify(summary),id);
    if(!snapshots.length){appendAudit(env.db,{...actor,action:'verification.task.recheck',objectType:'verification',objectId:id,count:0,result:'denied'});return {noTargets:true,summary};}
    return insertTask(env,{key,hash,options:{...parent.options,recheck:true},snapshots,parentTaskId:id,skipped,originalUnpassed:rows.length,actor,recheck:true});
  }).immediate();
  if(outcome.noTargets) {
    const error=new FeatureError(400,'NO_RECHECK_TARGETS',`No unchanged eligible items can be rechecked. ${outcome.summary.skipped.length} items skipped; create a new confirmed task if no send intent exists.`);
    error.details=outcome.summary;throw error;
  }
  return outcome;
}
export function stopVerificationTask(env,id,{confirm,actor={}}={}) {
  primary(env);if(confirm!==true)throw new FeatureError(400,'STOP_CONFIRMATION_REQUIRED','Confirm stopping the unfinished verification items.');
  const result=env.db.transaction(()=>{
    const task=getTask(env,id);
    if(!['queued','running'].includes(task.status))return task;
    const now=Date.now();
    env.db.prepare("UPDATE verification_item SET processed=1,phase='interrupted',note='Stopped by administrator; no further mail will be sent.',checked_at=? WHERE task_id=? AND processed=0").run(now,id);
    env.db.prepare("UPDATE verification_task SET status='stopped',processed=total,finished_at=? WHERE id=? AND status IN ('queued','running')").run(now,id);
    appendAudit(env.db,{...actor,action:'verification.task.stop',objectType:'verification',objectId:id,count:task.total-task.processed});
    return getTask(env,id);
  }).immediate();
  stateFor(env).controllers?.get(id)?.abort();
  return result;
}
export function completeVerificationItem(env,id,{result='pending',note='',httpStatus=null}={}) {
  if(!['passed','failed','pending'].includes(result))throw new TypeError('Invalid verification result.');
  return env.db.transaction(()=>{
    const item=env.db.prepare('SELECT * FROM verification_item WHERE id=?').get(id);if(!item)return false;
    const task=getTask(env,item.task_id);if(task.status!=='running')return false;
    if(!env.db.prepare("UPDATE verification_item SET processed=1,result=?,phase='finished',note=?,http_status=?,checked_at=? WHERE id=? AND processed=0").run(result,note,httpStatus,Date.now(),id).changes)return false;
    env.db.prepare(`UPDATE verification_task SET processed=processed+1,passed=passed+?,failed=failed+?,pending=pending-? WHERE id=? AND status='running'`)
      .run(Number(result==='passed'),Number(result==='failed'),Number(result!=='pending'),item.task_id);
    env.db.prepare("UPDATE verification_task SET status='completed',finished_at=? WHERE id=? AND processed=total AND status='running'").run(Date.now(),item.task_id);
    return true;
  }).immediate();
}
export function verificationCsv(env,id) {
  getTask(env,id);
  const csv=value=>{let text=value==null?'':String(value);if(/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
  const header=['子邮箱','主邮箱','链接','结果','HTTP状态码','说明','检测时间','发件邮箱','阶段','开始时间','发信时间'];
  const lines=[header.map(csv).join(',')];let bytes=Buffer.byteLength('\uFEFF'+lines[0]+'\r\n');
  for(const row of env.db.prepare('SELECT * FROM verification_item WHERE task_id=? ORDER BY ordinal').iterate(id)) {
    const item=itemDto(row),line=[item.recipient,item.mailboxEmail,item.linkUrl,item.result,item.httpStatus,item.note,item.checkedAt,item.senderEmail,item.phase,item.startedAt,item.sentAt].map(csv).join(',');
    bytes+=Buffer.byteLength(line+'\r\n');if(bytes>64*1024*1024)throw new FeatureError(413,'REPORT_TOO_LARGE','The complete report exceeds 64 MiB.');lines.push(line);
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}
