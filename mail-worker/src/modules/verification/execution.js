import { FeatureError } from '../shared/errors.js';
import { readSourceMessages } from '../mail-sources/service.js';
import { assertSnapshotCurrent } from './sources.js';
import { availableSenders, smtpSend, validateSmtpDestination } from './smtp.js';
import { customGet } from './network.js';
import { completeVerificationItem, getTask, stateFor } from './tasks.js';

export function abortable(operation,signal) {
  if(!signal)return Promise.resolve(operation);
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason||new DOMException('Cancelled','AbortError'));};
    const cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(operation).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
export async function waitFor(env,milliseconds,signal) {
  signal?.throwIfAborted();
  if(env.verificationTransports?.sleep)return abortable(env.verificationTransports.sleep(milliseconds,signal),signal);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();resolve();},milliseconds);
    const abort=()=>{clearTimeout(timer);cleanup();reject(signal.reason||new DOMException('Cancelled','AbortError'));};
    const cleanup=()=>signal?.removeEventListener('abort',abort);signal?.addEventListener('abort',abort,{once:true});
  });
}
function stillActive(env,taskId,signal) {
  signal?.throwIfAborted();
  if(getTask(env,taskId).status!=='running')throw new DOMException('Task stopped','AbortError');
}
async function readItem(env,snapshot,options,signal) {
  const context=assertSnapshotCurrent(env,snapshot);
  const timeout=AbortSignal.timeout(options.timeoutSeconds*1000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  let result;
  if(snapshot.mode==='custom')result=await abortable(customGet(env,snapshot.customUrl,{signal:combined,timeoutSeconds:options.timeoutSeconds}),combined);
  else {
    const read=env.verificationTransports?.readSource || readSourceMessages;
    const value=await abortable(read(env,context.source.id,{recipient:snapshot.recipient,platform:context.platform,order:'latest',limit:20,signal:combined}),combined);
    if(!Array.isArray(value?.messages)||value.messages.length>20)throw new FeatureError(502,'INVALID_READ_RESPONSE','The internal source returned an invalid bounded result.');
    result={status:null,messages:value.messages};
  }
  combined.throwIfAborted();assertSnapshotCurrent(env,snapshot);
  return result;
}
function httpConclusion(status) {
  if(status==null || status>=200&&status<400)return 'passed';
  return status>=400&&status<500&&![408,429].includes(status)?'failed':'pending';
}
async function serializeSend(env,task,item,snapshot,signal) {
  const state=stateFor(env),previous=state.sendTail||Promise.resolve();let release;
  state.sendTail=new Promise(resolve=>{release=resolve;});
  try {
    // A cancelled queued sender must not release the following sender before
    // the preceding network operation has actually closed.
    await previous;stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
    const last=state.lastSendFinished??env.db.prepare('SELECT max(last_used_at) last FROM verification_smtp').get().last??0;
    const delay=Math.max(0,last+task.options.sendIntervalMs-Date.now());
    if(delay)await waitFor(env,delay,signal);
    stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
    const networkSignal=AbortSignal.any([signal,AbortSignal.timeout(task.options.timeoutSeconds*1000)]);
    let sender=availableSenders(env)[0];
    const destination=await abortable(validateSmtpDestination(env,sender,networkSignal),networkSignal);
    stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
    // Recheck the chosen pool account after DNS waits and before recording intent.
    const current=availableSenders(env).find(row=>row.id===sender.id&&row.revision===sender.revision);
    if(!current)throw new FeatureError(409,'SMTP_POLICY_CHANGED','The selected sender was disabled, removed or changed.');
    sender=current;
    const sentAt=Date.now();
    const intended=env.db.transaction(()=>{
      stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
      const result=env.db.prepare(`UPDATE verification_item SET phase='sending',sender_email=?,sent_at=?
        WHERE id=? AND processed=0 AND sent_at IS NULL`).run(sender.email,sentAt,item.id);
      if(result.changes)env.db.prepare('UPDATE verification_smtp SET last_used_at=? WHERE id=?').run(sentAt,sender.id);
      return result.changes;
    }).immediate();
    if(!intended)return;
    // Intent is committed before SMTP. All failures after here are uncertain;
    // no retry path is permitted to call SMTP for this item again.
    await smtpSend(env,sender,{recipient:snapshot.recipient,marker:item.marker,signal:networkSignal,destination});
    stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
  } finally {state.lastSendFinished=Date.now();release();}
}
async function executeItem(env,task,item,signal) {
  const snapshot=JSON.parse(item.snapshot_json);
  try {
    stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
    env.db.prepare("UPDATE verification_item SET phase='checking',started_at=? WHERE id=? AND processed=0").run(Date.now(),item.id);
    if(task.type==='link') {
      const result=await readItem(env,snapshot,task.options,signal);stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
      const conclusion=httpConclusion(result.status);
      completeVerificationItem(env,item.id,{result:conclusion,httpStatus:result.status,note:snapshot.mode==='system'?
        'Internal public reading policy completed successfully; this does not establish public network reachability or receipt.':`Custom HTTP response ${result.status}.`});
      return;
    }
    if(!task.options.recheck && !item.sent_at)await serializeSend(env,task,item,snapshot,signal);
    stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
    env.db.prepare("UPDATE verification_item SET phase='waiting' WHERE id=? AND processed=0").run(item.id);
    const deadline=Date.now()+task.options.waitSeconds*1000;
    let lastStatus=null;
    do {
      let result;
      try {
        const remaining=Math.max(1,deadline-Date.now());
        const waitSignal=AbortSignal.any([signal,AbortSignal.timeout(remaining)]);
        result=await readItem(env,snapshot,task.options,waitSignal);lastStatus=result.status;
      } catch(error) {
        stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
        if(Date.now()>=deadline)break;
        await waitFor(env,Math.min(3000,deadline-Date.now()),signal);continue;
      }
      stillActive(env,task.id,signal);assertSnapshotCurrent(env,snapshot);
      const contents=snapshot.mode==='custom'?[result.body]:result.messages.flatMap(message=>[message.subject,message.text,message.html]);
      if(httpConclusion(result.status)==='passed'&&contents.some(content=>String(content||'').includes(item.marker))) {
        completeVerificationItem(env,item.id,{result:'passed',httpStatus:lastStatus,note:'The matching recipient result contains this test marker; receipt verified.'});return;
      }
      if(Date.now()>=deadline)break;
      await waitFor(env,Math.min(3000,deadline-Date.now()),signal);
    } while(Date.now()<=deadline);
    completeVerificationItem(env,item.id,{result:'pending',httpStatus:lastStatus,note:'No matching marker arrived before the deadline. Platform filters may exclude the test sender; receipt is unconfirmed.'});
  } catch(error) {
    if(signal?.aborted || getTask(env,task.id).status!=='running')return;
    let changed=false;try{assertSnapshotCurrent(env,snapshot);}catch{changed=true;}
    const persisted=env.db.prepare('SELECT sent_at FROM verification_item WHERE id=?').get(item.id);
    const invalid=changed||['INVALID_CUSTOM_URL','VERIFICATION_POLICY_CHANGED','SOURCE_CONFLICT'].includes(error.code);
    completeVerificationItem(env,item.id,{result:invalid?'failed':'pending',note:changed?'The source or effective policy changed; the item was stopped.':
      persisted?.sent_at?'SMTP or receipt is uncertain. The original marker and send intent are preserved; recheck never resends.':
      error.code==='UNSAFE_DESTINATION'?'The destination was blocked by network safety policy.':error.code==='PAGE_TOO_LARGE'?'The custom response exceeds 2 MiB.':
      error.code==='REDIRECT_LIMIT'?'The custom response exceeds five redirects.':'Reading or encrypted SMTP failed or timed out; the result is unconfirmed.'});
  }
}
export async function runVerificationTask(env,id,{signal}={}) {
  if((env.node_role??env.nodeRole??'primary')!=='primary')return false;
  const claimed=env.db.prepare("UPDATE verification_task SET status='running',started_at=? WHERE id=? AND status='queued'").run(Date.now(),id).changes;
  if(!claimed)return false;
  const state=stateFor(env),controller=new AbortController();state.controllers||=new Map();state.controllers.set(id,controller);
  signal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const task=getTask(env,id),items=env.db.prepare('SELECT * FROM verification_item WHERE task_id=? AND processed=0 ORDER BY ordinal').all(id);
  let next=0;
  try {
    const workers=Array.from({length:Math.min(task.options.concurrency,items.length)},async()=>{
      try {while(next<items.length&&!signal?.aborted&&getTask(env,id).status==='running')await executeItem(env,task,items[next++],signal);}
      catch(error){controller.abort(error);throw error;}
    });
    // Even an unexpected storage/snapshot failure retains ownership until
    // every other worker has cancelled and the real SMTP socket has closed.
    const outcomes=await Promise.allSettled(workers),failure=outcomes.find(result=>result.status==='rejected');
    if(failure) {
      env.db.transaction(()=>{
        const now=Date.now();
        env.db.prepare("UPDATE verification_item SET processed=1,phase='interrupted',checked_at=?,note='Verification worker failed; original send identifiers are preserved.' WHERE task_id=? AND processed=0").run(now,id);
        env.db.prepare("UPDATE verification_task SET status='failed',processed=total,finished_at=?,error='Verification worker failed; no automatic resend is permitted.' WHERE id=? AND status='running'").run(now,id);
      }).immediate();
      throw failure.reason;
    }
  } finally {if(state.controllers.get(id)===controller)state.controllers.delete(id);}
  return true;
}
