import { createHash } from 'node:crypto';
import { FeatureError,positiveInt,strictJson } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { primary,syncVerificationSources,sourceSnapshot,updateVerificationSource } from './sources.js';
import { createVerificationTask,getTask,itemDto,recheckVerificationTask,stopVerificationTask,taskDto,verificationCsv } from './tasks.js';
import { saveSmtp,smtpConfiguration } from './smtp.js';
import { getVerificationPlan,saveVerificationPlan,runSavedVerificationPlan } from './schedule.js';

export { VERIFICATION_SCHEMA } from './schema.js';
export { startVerificationRuntime,recoverVerificationTasks } from './runtime.js';
export { runVerificationTask } from './execution.js';
export { createVerificationTask,getTask,itemDto,recheckVerificationTask,stopVerificationTask,completeVerificationItem,verificationCsv } from './tasks.js';
export { syncVerificationSources,assertSnapshotCurrent,updateVerificationSource } from './sources.js';
export { saveSmtp,smtpConfiguration } from './smtp.js';
export { checkVerificationSchedule,getVerificationPlan,saveVerificationPlan,runSavedVerificationPlan } from './schedule.js';

const actor=c=>({actorId:c.get('featureAdmin')?.userId??null,requestId:c.get('requestId')||''});
const page=c=>({page:positiveInt(c.req.query('page'),'page',{fallback:1,max:1000000}),pageSize:positiveInt(c.req.query('pageSize'),'pageSize',{fallback:25,max:750})});
const taskKeys=['type','mailboxIds','sourceIds','sample','timeoutSeconds','concurrency','waitSeconds','sendIntervalMs','confirmSend','idempotencyKey'];
const smtpKeys=['host','port','email','encryption','password','clearPassword','enabled'];
export function mountVerificationRoutes(router) {
  router.use('/admin/verification/*',async(c,next)=>{primary(c.env);c.header('Cache-Control','no-store');await next();});
  router.post('/admin/verification/sync',async c=>{await strictJson(c,[]);return c.json({data:syncVerificationSources(c.env)});});
  router.get('/admin/verification/sources',c=>{
    const {page:current,pageSize}=page(c),q=c.req.query('q')||'',mailboxId=c.req.query('mailboxId');
    if(q.length>320)throw new FeatureError(400,'INVALID_SEARCH','The source search is too long.');
    const clauses=['instr(lower(recipient||mailbox_email),lower(?))>0'],params=[q];
    if(mailboxId){clauses.push('mailbox_id=?');params.push(mailboxId);}
    const where=clauses.join(' AND '),total=c.env.db.prepare(`SELECT count(*) count FROM verification_source WHERE ${where}`).get(...params).count;
    const items=c.env.db.prepare(`SELECT * FROM verification_source WHERE ${where} ORDER BY mailbox_email,recipient,id LIMIT ? OFFSET ?`).all(...params,pageSize,(current-1)*pageSize).map(row=>sourceSnapshot(c.env,row,c.req.url));
    const mainCount=c.env.db.prepare("SELECT count(*) count FROM source_mailbox WHERE provider='mx' AND enabled=1").get().count;
    const summary=c.env.db.prepare('SELECT count(*) linkCount,coalesce(sum(eligible),0) syncedCount,coalesce(sum(1-eligible),0) conflictCount FROM verification_source').get();
    return c.json({data:{items,total,page:current,pageSize,summary:{mainCount,...summary}}});
  });
  router.put('/admin/verification/sources/:id',async c=>c.json({data:updateVerificationSource(c.env,c.req.param('id'),await strictJson(c,['revision','mode','customUrl']),actor(c))}));
  router.get('/admin/verification/tasks',c=>{
    const {page:current,pageSize}=page(c),total=c.env.db.prepare('SELECT count(*) count FROM verification_task').get().count;
    return c.json({data:{items:c.env.db.prepare('SELECT * FROM verification_task ORDER BY number DESC LIMIT ? OFFSET ?').all(pageSize,(current-1)*pageSize).map(taskDto),total,page:current,pageSize}});
  });
  router.post('/admin/verification/tasks',async c=>c.json({data:createVerificationTask(c.env,await strictJson(c,taskKeys),{actor:actor(c),requestUrl:c.req.url})},201));
  router.get('/admin/verification/tasks/:id',c=>{
    const task=getTask(c.env,c.req.param('id')),{page:current,pageSize}=page(c),result=c.req.query('result');
    if(result&&!['passed','failed','pending'].includes(result))throw new FeatureError(400,'INVALID_RESULT','Choose passed, failed or pending.');
    const where='task_id=?'+(result?' AND result=?':''),params=result?[task.id,result]:[task.id];
    return c.json({data:{task,items:c.env.db.prepare(`SELECT * FROM verification_item WHERE ${where} ORDER BY ordinal LIMIT ? OFFSET ?`).all(...params,pageSize,(current-1)*pageSize).map(itemDto),
      total:c.env.db.prepare(`SELECT count(*) count FROM verification_item WHERE ${where}`).get(...params).count,page:current,pageSize}});
  });
  router.post('/admin/verification/tasks/:id/stop',async c=>{const data=await strictJson(c,['confirm']);return c.json({data:stopVerificationTask(c.env,c.req.param('id'),{confirm:data.confirm,actor:actor(c)})});});
  router.post('/admin/verification/tasks/:id/recheck',async c=>{
    const data=await strictJson(c,['idempotencyKey']);
    try {return c.json({data:recheckVerificationTask(c.env,c.req.param('id'),data,{actor:actor(c)})},201);}
    catch(error){if(error.code==='NO_RECHECK_TARGETS')return c.json({error:{code:error.code,message:error.message,details:error.details,requestId:c.get('requestId')}},400);throw error;}
  });
  router.get('/admin/verification/tasks/:id/export',c=>{
    const report=verificationCsv(c.env,c.req.param('id'));
    appendAudit(c.env.db,{...actor(c),action:'verification.task.export',objectType:'verification',objectId:c.req.param('id'),count:getTask(c.env,c.req.param('id')).total});
    c.header('Content-Type','text/csv; charset=utf-8');c.header('Content-Disposition',`attachment; filename="verification-${getTask(c.env,c.req.param('id')).number}.csv"`);
    c.header('Content-Length',String(Buffer.byteLength(report)));c.header('X-Content-SHA256',createHash('sha256').update(report).digest('hex'));return c.body(report);
  });
  router.get('/admin/verification/smtp',c=>c.json({data:smtpConfiguration(c.env)}));
  router.put('/admin/verification/smtp/default',async c=>c.json({data:saveSmtp(c.env,await strictJson(c,smtpKeys),{kind:'default',...actor(c)})}));
  router.post('/admin/verification/smtp/pool',async c=>c.json({data:saveSmtp(c.env,await strictJson(c,smtpKeys),{kind:'pool',...actor(c)})},201));
  router.put('/admin/verification/smtp/pool/:id',async c=>c.json({data:saveSmtp(c.env,await strictJson(c,smtpKeys),{id:c.req.param('id'),kind:'pool',...actor(c)})}));
  router.delete('/admin/verification/smtp/pool/:id',c=>{
    c.env.db.transaction(()=>{c.env.db.prepare("DELETE FROM verification_smtp WHERE id=? AND kind='pool'").run(c.req.param('id'));
      appendAudit(c.env.db,{...actor(c),action:'verification.smtp.delete',objectType:'smtp',objectId:c.req.param('id')});}).immediate();return c.json({data:{deleted:true}});
  });
  router.get('/admin/verification/plan',c=>c.json({data:getVerificationPlan(c.env)}));
  router.put('/admin/verification/plan',async c=>c.json({data:saveVerificationPlan(c.env,await strictJson(c,['enabled','time','mailboxIds','sample','timeoutSeconds','concurrency','waitSeconds','sendIntervalMs','revision','confirmSend']),{actor:actor(c)})}));
  router.post('/admin/verification/plan/run',async c=>c.json({data:runSavedVerificationPlan(c.env,await strictJson(c,['confirmSend','idempotencyKey']),{actor:actor(c),requestUrl:c.req.url})},201));
  return router;
}
