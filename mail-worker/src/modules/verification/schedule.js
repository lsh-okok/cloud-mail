import { FeatureError, positiveInt } from '../shared/errors.js';
import { appendAudit, readFeatureSettings } from '../shared/settings.js';
import { availableSenders } from './smtp.js';
import { primary, syncVerificationSources } from './sources.js';
import { createVerificationTask, getTask, taskOptions } from './tasks.js';

function localClock(timeZone,now) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return {date:`${values.year}-${values.month}-${values.day}`,time:`${values.hour}:${values.minute}`};
}
export function getVerificationPlan(env,{now=Date.now()}={}) {
  const row=env.db.prepare('SELECT * FROM verification_plan WHERE id=1').get(),timeZone=readFeatureSettings(env.db).timeZone;
  let nextRunAt=null;
  if(row.enabled) {
    for(let candidate=Math.floor(now/60000)*60000;candidate<now+49*60*60*1000;candidate+=60000) {
      const local=localClock(timeZone,candidate);
      if(local.date!==row.last_claim_date&&local.time>=row.time&&candidate>=now-60000){nextRunAt=new Date(Math.max(now,candidate)).toISOString();break;}
    }
  }
  let lastStatus=row.last_status;if(row.last_task_id){try{lastStatus=getTask(env,row.last_task_id).status;}catch{}}
  return {enabled:!!row.enabled,time:row.time,...JSON.parse(row.options_json),revision:row.revision,timeZone,lastClaimDate:row.last_claim_date,
    lastTaskId:row.last_task_id,lastRunAt:row.last_run_at==null?null:new Date(row.last_run_at).toISOString(),lastStatus,lastError:row.last_error,nextRunAt};
}
export function saveVerificationPlan(env,data,{actor={}}={}) {
  primary(env);
  if(typeof data.enabled!=='boolean'||typeof data.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time))throw new FeatureError(400,'INVALID_PLAN','Provide an enabled flag and valid HH:mm schedule.');
  const mailboxIds=data.mailboxIds??[];
  if(!Array.isArray(mailboxIds)||mailboxIds.length>500)throw new FeatureError(400,'INVALID_SELECTION','Choose at most 500 mailbox IDs.');
  const options=taskOptions({...data,type:'receive',mailboxIds:mailboxIds.length?mailboxIds:undefined});
  delete options.type;delete options.sourceIds;options.mailboxIds=options.mailboxIds||[];
  if(data.enabled) {
    if(data.confirmSend!==true)throw new FeatureError(400,'SEND_CONFIRMATION_REQUIRED','Explicitly confirm automatic test emails before enabling the daily plan.');
    availableSenders(env);
  }
  return env.db.transaction(()=>{
    const result=env.db.prepare('UPDATE verification_plan SET enabled=?,time=?,options_json=?,revision=revision+1 WHERE id=1 AND revision=?')
      .run(Number(data.enabled),data.time,JSON.stringify(options),positiveInt(data.revision,'revision'));
    if(!result.changes)throw new FeatureError(409,'REVISION_CONFLICT','Reload the saved plan before editing.');
    appendAudit(env.db,{...actor,action:'verification.plan.save',objectType:'verification',objectId:'daily'});
    return getVerificationPlan(env);
  }).immediate();
}
export function runSavedVerificationPlan(env,data,{actor={},requestUrl}={}) {
  primary(env);if(data.confirmSend!==true)throw new FeatureError(400,'SEND_CONFIRMATION_REQUIRED','Confirm sending test emails using the saved plan.');
  const row=env.db.prepare('SELECT * FROM verification_plan WHERE id=1').get(),options=JSON.parse(row.options_json);
  return createVerificationTask(env,{...options,mailboxIds:options.mailboxIds.length?options.mailboxIds:undefined,type:'receive',confirmSend:true,idempotencyKey:data.idempotencyKey},{actor,requestUrl});
}
export function checkVerificationSchedule(env,{now=Date.now()}={}) {
  if((env.node_role??env.nodeRole??'primary')!=='primary')return null;
  return env.db.transaction(()=>{
    const row=env.db.prepare('SELECT * FROM verification_plan WHERE id=1').get();if(!row.enabled)return null;
    const {date,time}=localClock(readFeatureSettings(env.db).timeZone,now);
    if(row.last_claim_date===date||time<row.time)return null;
    if(row.last_task_id) {
      const previous=env.db.prepare('SELECT status FROM verification_task WHERE id=?').get(row.last_task_id);
      if(previous&&['queued','running'].includes(previous.status))return null;
    }
    if(!env.db.prepare('UPDATE verification_plan SET last_claim_date=?,last_run_at=? WHERE id=1 AND (last_claim_date IS NULL OR last_claim_date!=?)').run(date,now,date).changes)return null;
    try {
      syncVerificationSources(env);
      const options=JSON.parse(row.options_json),task=createVerificationTask(env,{...options,mailboxIds:options.mailboxIds.length?options.mailboxIds:undefined,
        type:'receive',confirmSend:true,idempotencyKey:`daily:${date}`});
      env.db.prepare("UPDATE verification_plan SET last_task_id=?,last_status='queued',last_error='' WHERE id=1").run(task.id);
      return task;
    } catch {
      // Keep the daily claim even for no candidates/sender/capacity. No repeated
      // automatic retries on the same day can unexpectedly send another batch.
      env.db.prepare("UPDATE verification_plan SET last_task_id=NULL,last_status='failed',last_error='Daily verification could not be created; review sources, SMTP and active-task capacity.' WHERE id=1").run();
      return null;
    }
  }).immediate();
}
