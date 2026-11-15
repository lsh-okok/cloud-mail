import { afterEach,describe,expect,it,vi } from 'vitest';
import { randomBytes,randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { createDatabase } from '../src/server/database.js';
import { BASELINE_SQL } from '../src/server/schema.js';
import { FOUNDATION_SCHEMA } from '../src/modules/shared/schema.js';
import { SOURCE_SCHEMA } from '../src/modules/mail-sources/schema.js';
import { LINK_SCHEMA } from '../src/modules/links/schema.js';
import { createSecretVault } from '../src/modules/shared/secrets.js';
import { saveSourceMailbox } from '../src/modules/mail-sources/service.js';
import { tokenDigest } from '../src/modules/links/service.js';
import { VERIFICATION_SCHEMA,createVerificationTask,getTask,syncVerificationSources,updateVerificationSource,saveSmtp,smtpConfiguration,
  runVerificationTask,stopVerificationTask,recheckVerificationTask,completeVerificationItem,recoverVerificationTasks,
  getVerificationPlan,saveVerificationPlan,checkVerificationSchedule,runSavedVerificationPlan,verificationCsv,mountVerificationRoutes,startVerificationRuntime } from '../src/modules/verification/service.js';

const resources=[];
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {resolve,promise};};
const turn=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function fixture(count=1) {
  const db=createDatabase(':memory:');resources.push(db);
  for(const sql of [BASELINE_SQL,FOUNDATION_SCHEMA,SOURCE_SCHEMA,LINK_SCHEMA,VERIFICATION_SCHEMA])db.exec(sql);
  const user=Number(db.prepare("INSERT INTO user(email,password,salt) VALUES('admin@example.com','fixture','fixture')").run().lastInsertRowid);
  const account=Number(db.prepare("INSERT INTO account(email,user_id) VALUES('a@example.com',?)").run(user).lastInsertRowid);
  const env={db,domain:['example.com'],node_role:'primary',verificationState:{},secretVault:createSecretVault({test:Buffer.alloc(32,4)}),verificationTransports:{
    resolve:vi.fn(async()=>[{address:'8.8.8.8',family:4}]),smtp:vi.fn(async({message})=>({accepted:[message.to]}))}};
  const source=saveSourceMailbox(env,{email:'a@example.com',localAccountId:account});
  function link(recipient,mailboxId=source.id,platformId=null) {
    const id=randomUUID(),token=randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO mail_link(id,mailbox_id,recipient,platform_id,token_digest,token_encrypted,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,mailboxId,recipient,platformId,tokenDigest(token),env.secretVault.encrypt(token,`mail-link:${id}`),Date.now());return id;
  }
  for(let index=1;index<=count;index++)link(`a${index}@example.com`);
  function message(recipient,subject,text=subject,from='sender@example.net') {
    return db.prepare('INSERT INTO email(account_id,user_id,to_email,subject,text,send_email,create_time) VALUES(?,?,?,?,?,?,?)')
      .run(account,user,recipient,subject,text,from,'2026-11-13 01:00:00');
  }
  function sender(data={},kind='default') {
    return saveSmtp(env,{host:'smtp.example.net',port:465,email:'sender@example.net',encryption:'tls',password:'private-authorization-code',...data},{kind});
  }
  const task=(data={})=>createVerificationTask(env,{type:'link',sample:'all',idempotencyKey:randomUUID(),...data});
  const items=id=>db.prepare('SELECT * FROM verification_item WHERE task_id=? ORDER BY ordinal').all(id);
  return {env,db,source,user,account,link,message,sender,task,items};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();for(const db of resources.splice(0))if(db.open)db.close();});

describe('verification durable sources and task snapshots',()=>{
  it('syncs on every create, maps stable IDs, and preserves user custom links',()=>{
    const f=fixture(2);expect(f.db.prepare('SELECT count(*) n FROM verification_source').get().n).toBe(0);
    const first=f.task();expect(first.total).toBe(2);
    const rows=f.db.prepare('SELECT * FROM verification_source ORDER BY id').all();
    const changed=updateVerificationSource(f.env,rows[0].id,{revision:1,mode:'custom',customUrl:'https://custom.example.net/check'});
    expect(changed.mode).toBe('custom');syncVerificationSources(f.env);
    expect(f.db.prepare('SELECT id FROM verification_source ORDER BY id').all()).toEqual(rows.map(({id})=>({id})));
    expect(f.db.prepare('SELECT custom_url FROM verification_source WHERE id=?').get(rows[0].id).custom_url).toBe('https://custom.example.net/check');
    expect(JSON.parse(f.items(first.id)[0].snapshot_json).mode).toBe('system');
  });
  it('reports cross-mailbox and platform conflicts instead of silently merging mappings',()=>{
    const f=fixture();const second=saveSourceMailbox(f.env,{email:'b@example.com',mxDomain:'example.com'});f.link('a1@example.com',second.id);
    const sync=syncVerificationSources(f.env);expect(sync).toMatchObject({mainCount:2,linkCount:2,syncedCount:0,conflictCount:2});
    expect(sync.conflicts[0]).toHaveProperty('mailboxId');expect(()=>f.task()).toThrow(expect.objectContaining({code:'NO_VERIFICATION_TARGETS'}));
  });
  it('removes disabled/expired/deleted eligibility while preserving historical snapshots',()=>{
    const f=fixture(3),task=f.task();const links=f.db.prepare('SELECT id FROM mail_link ORDER BY recipient').all();
    f.db.prepare('DELETE FROM mail_link WHERE id=?').run(links[0].id);f.db.prepare('UPDATE mail_link SET expires_at=? WHERE id=?').run(Date.now()-1,links[1].id);
    expect(syncVerificationSources(f.env).syncedCount).toBe(1);
    expect(f.task().total).toBe(1);
    saveSourceMailbox(f.env,{revision:1,enabled:false},{id:f.source.id});expect(()=>f.task()).toThrow(expect.objectContaining({code:'NO_VERIFICATION_TARGETS'}));
    expect(f.items(task.id)).toHaveLength(3);expect(verificationCsv(f.env,task.id)).toContain('a1@example.com');
  });
  it('returns the same sampled task for duplicate idempotency keys and rejects different parameters',()=>{
    const f=fixture(5),data={type:'receive',confirmSend:true,sample:1,idempotencyKey:'idempotent-request-1'};f.sender();
    const first=createVerificationTask(f.env,data),second=createVerificationTask(f.env,{...data});
    expect(second.id).toBe(first.id);expect(f.items(second.id)).toEqual(f.items(first.id));
    expect(()=>createVerificationTask(f.env,{...data,sample:3})).toThrow(expect.objectContaining({code:'IDEMPOTENCY_CONFLICT'}));
    expect(f.db.prepare('SELECT count(*) n FROM verification_task').get().n).toBe(1);expect(f.env.verificationTransports.smtp).not.toHaveBeenCalled();
  });
  it('enforces ID raw size, option ranges, selected eligibility and the four-active limit',()=>{
    const f=fixture();for(const field of ['mailboxIds','sourceIds'])expect(()=>f.task({[field]:Array(501).fill(f.source.id)})).toThrow(expect.objectContaining({code:'INVALID_SELECTION'}));
    for(const options of [{timeoutSeconds:61},{concurrency:11},{waitSeconds:4},{sendIntervalMs:199}])expect(()=>f.task(options)).toThrow();
    expect(()=>f.task({mailboxIds:['missing']})).toThrow();
    expect(()=>f.task({type:'receive'})).toThrow(expect.objectContaining({code:'SEND_CONFIRMATION_REQUIRED'}));
    for(let i=0;i<4;i++)f.task();expect(()=>f.task()).toThrow(expect.objectContaining({status:429,code:'VERIFICATION_BUSY'}));
  });
  it('caps an all-recipient task at 20000 without leaving a partial task',()=>{
    const f=fixture(0);
    f.db.transaction(()=>{for(let i=0;i<20001;i++)f.link(`child${i}@example.com`);})();
    expect(()=>f.task()).toThrow(expect.objectContaining({code:'VERIFICATION_TOO_LARGE'}));
    expect(f.db.prepare('SELECT count(*) n FROM verification_task').get().n).toBe(0);
  },20000);
});

describe('verification actual receipt, terminal state and zero-resend recheck',()=>{
  it('uses bounded internal public policy directly and treats an empty source as link success only',async()=>{
    const f=fixture(),task=f.task();const request=vi.fn();f.env.verificationTransports.request=request;
    await runVerificationTask(f.env,task.id);expect(getTask(f.env,task.id)).toMatchObject({status:'completed',passed:1,processed:1});
    expect(f.items(task.id)[0].note).toContain('does not establish');expect(request).not.toHaveBeenCalled();
    expect(completeVerificationItem(f.env,f.items(task.id)[0].id,{result:'failed'})).toBe(false);
    expect(getTask(f.env,task.id).passed).toBe(1);
  });
  it('commits the sending intent before SMTP and passes only when the exact recipient receives the random marker',async()=>{
    const f=fixture(2);f.sender();f.env.verificationTransports.smtp=vi.fn(async({message,config,address})=>{
      const intent=f.db.prepare('SELECT * FROM verification_item WHERE marker=?').get(message.subject.split(' ').at(-1));
      expect(intent).toMatchObject({phase:'sending',sender_email:config.email});expect(intent.sent_at).toBeGreaterThan(0);expect(address).toBe('8.8.8.8');
      f.message(message.to,message.subject,message.text);return {accepted:[message.to]};
    });
    const task=f.task({type:'receive',confirmSend:true,sendIntervalMs:200});await runVerificationTask(f.env,task.id);
    expect(getTask(f.env,task.id)).toMatchObject({passed:2,processed:2,status:'completed'});expect(f.env.verificationTransports.smtp).toHaveBeenCalledTimes(2);
    expect(new Set(f.items(task.id).map(row=>row.marker)).size).toBe(2);
  });
  it('keeps an uncertain SMTP marker and confirms it in a recheck with zero additional sends',async()=>{
    const f=fixture();f.sender();let captured;
    f.env.verificationTransports.smtp=vi.fn(async({message})=>{captured=message;throw new Error('private-password should never appear');});
    const task=f.task({type:'receive',confirmSend:true});await runVerificationTask(f.env,task.id);
    expect(getTask(f.env,task.id)).toMatchObject({pending:1,processed:1,status:'completed'});
    expect(f.items(task.id)[0].note).not.toContain('private-password');f.message('a1@example.com',captured.subject);
    const recheck=recheckVerificationTask(f.env,task.id,{idempotencyKey:randomUUID()});await runVerificationTask(f.env,recheck.id);
    expect(getTask(f.env,recheck.id)).toMatchObject({passed:1,parentTaskId:task.id,originalUnpassed:1});
    expect(f.items(recheck.id)[0]).toMatchObject({marker:f.items(task.id)[0].marker,sender_email:f.items(task.id)[0].sender_email,sent_at:f.items(task.id)[0].sent_at});
    expect(f.env.verificationTransports.smtp).toHaveBeenCalledTimes(1);
  });
  it('does not confuse SMTP acceptance or another recipient marker with actual receipt and respects platform filters',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-13T01:00:00Z'));
    const f=fixture();f.sender();
    f.env.verificationTransports.sleep=async ms=>{vi.setSystemTime(Date.now()+ms);};
    f.env.verificationTransports.smtp=vi.fn(async({message})=>{f.message('a2@example.com',message.subject);f.message(message.to,'cmv-old-other-task-marker');return {accepted:[message.to]};});
    const task=f.task({type:'receive',confirmSend:true,waitSeconds:5});await runVerificationTask(f.env,task.id);
    expect(getTask(f.env,task.id)).toMatchObject({passed:0,pending:1,processed:1});expect(f.items(task.id)[0].note).toContain('Platform filters');
  });
  it('keeps the bound platform filter while looking for a receipt marker and rechecks without another SMTP call',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-13T01:00:00Z'));
    const f=fixture();f.sender();const platformId=randomUUID();
    f.db.prepare('INSERT INTO platform_rule(id,name,emails_json,domains_json,keywords_json,created_at) VALUES(?,?,?,?,?,?)')
      .run(platformId,'Allowed sender','[]','["allowed.example.net"]','[]',Date.now());
    f.db.prepare('UPDATE mail_link SET platform_id=?').run(platformId);
    f.env.verificationTransports.sleep=async ms=>{vi.setSystemTime(Date.now()+ms);};
    let subject;
    f.env.verificationTransports.smtp=vi.fn(async({message})=>{subject=message.subject;f.message(message.to,message.subject,message.text,'sender@blocked.example.net');return {accepted:[message.to]};});
    const task=f.task({type:'receive',confirmSend:true,waitSeconds:5});await runVerificationTask(f.env,task.id);
    expect(getTask(f.env,task.id)).toMatchObject({passed:0,pending:1});
    f.message('a1@example.com',subject,subject,'sender@allowed.example.net');
    const next=recheckVerificationTask(f.env,task.id,{idempotencyKey:randomUUID()});await runVerificationTask(f.env,next.id);
    expect(getTask(f.env,next.id).passed).toBe(1);expect(f.env.verificationTransports.smtp).toHaveBeenCalledTimes(1);
  });
  it('cancels a blocked read and prevents late completion from changing a stopped task or counters',async()=>{
    const f=fixture(),gate=deferred();let signal;
    f.env.verificationTransports.readSource=vi.fn(async(_env,_id,options)=>{signal=options.signal;return gate.promise;});
    const task=f.task(),operation=runVerificationTask(f.env,task.id);await turn();
    stopVerificationTask(f.env,task.id,{confirm:true});expect(signal.aborted).toBe(true);
    gate.resolve({messages:[]});await operation;
    expect(getTask(f.env,task.id)).toMatchObject({status:'stopped',processed:1,passed:0,pending:1});expect(f.items(task.id)[0].phase).toBe('interrupted');
  });
  it('cancels sibling workers and retains terminal ownership when an unexpected snapshot failure occurs',async()=>{
    const f=fixture(2),gate=deferred();let activeSignal;
    f.env.verificationTransports.readSource=async(_env,_id,{signal})=>{activeSignal=signal;return gate.promise;};
    const task=f.task({concurrency:2}),items=f.items(task.id);
    f.db.prepare("UPDATE verification_item SET snapshot_json='invalid-json' WHERE id=?").run(items[1].id);
    await expect(runVerificationTask(f.env,task.id)).rejects.toBeDefined();
    expect(activeSignal.aborted).toBe(true);expect(getTask(f.env,task.id)).toMatchObject({status:'failed',processed:2,passed:0});
    expect(f.items(task.id).every(row=>row.phase==='interrupted')).toBe(true);gate.resolve({messages:[]});await turn();
    expect(getTask(f.env,task.id).status).toBe('failed');expect(f.env.verificationState.controllers.size).toBe(0);
  });
  it('revalidates source changes after a blocked read and refuses sending for policies changed while queued',async()=>{
    const f=fixture(),gate=deferred();f.env.verificationTransports.readSource=()=>gate.promise;
    const task=f.task(),operation=runVerificationTask(f.env,task.id);await turn();saveSourceMailbox(f.env,{enabled:false,revision:1},{id:f.source.id});
    gate.resolve({messages:[]});await operation;expect(getTask(f.env,task.id)).toMatchObject({failed:1,passed:0});
    saveSourceMailbox(f.env,{enabled:true,revision:2},{id:f.source.id});f.sender();const receive=f.task({type:'receive',confirmSend:true});
    f.db.prepare('UPDATE mail_link SET revision=revision+1').run();await runVerificationTask(f.env,receive.id);
    expect(getTask(f.env,receive.id).failed).toBe(1);expect(f.env.verificationTransports.smtp).not.toHaveBeenCalled();
  });
  it('rechecks source ownership after SMTP DNS waits before recording intent or sending',async()=>{
    const f=fixture(),gate=deferred();f.sender();f.env.verificationTransports.resolve=()=>gate.promise;
    const task=f.task({type:'receive',confirmSend:true}),operation=runVerificationTask(f.env,task.id);await turn();
    saveSourceMailbox(f.env,{enabled:false,revision:1},{id:f.source.id});gate.resolve([{address:'8.8.8.8',family:4}]);await operation;
    expect(getTask(f.env,task.id).failed).toBe(1);expect(f.items(task.id)[0].sent_at).toBeNull();expect(f.env.verificationTransports.smtp).not.toHaveBeenCalled();
  });
  it('stops sending immediately after cancellation while preserving the committed intent and waiting for the active transport to exit',async()=>{
    const f=fixture(2),gate=deferred();f.sender();let upstreamSignal;
    f.env.verificationTransports.smtp=vi.fn(async({signal,message})=>{upstreamSignal=signal;await gate.promise;return {accepted:[message.to]};});
    const task=f.task({type:'receive',confirmSend:true,concurrency:2}),operation=runVerificationTask(f.env,task.id);await turn();
    expect(f.env.verificationTransports.smtp).toHaveBeenCalledTimes(1);
    stopVerificationTask(f.env,task.id,{confirm:true});expect(upstreamSignal.aborted).toBe(true);
    let exited=false;operation.then(()=>{exited=true;});await turn();expect(exited).toBe(false);
    gate.resolve();await operation;expect(f.env.verificationTransports.smtp).toHaveBeenCalledTimes(1);
    expect(getTask(f.env,task.id)).toMatchObject({status:'stopped',processed:2,passed:0});
    expect(f.items(task.id).filter(row=>row.sent_at!=null)).toHaveLength(1);
  });
  it.each([200,302,404,408,429,500])('classifies custom HTTP %i independently from actual receipt',async status=>{
    const f=fixture();syncVerificationSources(f.env);const source=f.db.prepare('SELECT * FROM verification_source').get();
    updateVerificationSource(f.env,source.id,{revision:1,mode:'custom',customUrl:'https://custom.example.net/result'});
    f.env.verificationTransports.request=vi.fn(async()=>({status,body:'No receipt marker'}));
    const task=f.task();await runVerificationTask(f.env,task.id);
    expect(f.items(task.id)[0].result).toBe(status<400?'passed':![408,429].includes(status)&&status<500?'failed':'pending');
    expect(f.items(task.id)[0].http_status).toBe(status);
  });
  it('marks queued/running work failed on restart and preserves send identifiers without resending',async()=>{
    const f=fixture();f.sender();const task=f.task({type:'receive',confirmSend:true});
    f.db.prepare("UPDATE verification_task SET status='running' WHERE id=?").run(task.id);
    f.db.prepare("UPDATE verification_item SET sent_at=123,sender_email='sender@example.net',phase='sending' WHERE task_id=?").run(task.id);
    const marker=f.items(task.id)[0].marker;expect(recoverVerificationTasks(f.env)).toBe(1);
    expect(getTask(f.env,task.id)).toMatchObject({status:'failed',processed:1});expect(f.items(task.id)[0]).toMatchObject({marker,sent_at:123,phase:'interrupted'});
    expect(await runVerificationTask(f.env,task.id)).toBe(false);expect(f.env.verificationTransports.smtp).not.toHaveBeenCalled();
  });
  it('skips changed policies during recheck and requires new confirmation for items never sent',async()=>{
    const f=fixture(2);f.sender();const task=f.task({type:'receive',confirmSend:true});stopVerificationTask(f.env,task.id,{confirm:true});
    expect(()=>recheckVerificationTask(f.env,task.id,{idempotencyKey:randomUUID()})).toThrow(expect.objectContaining({code:'NO_RECHECK_TARGETS'}));
    const original=f.task();f.db.prepare("UPDATE verification_task SET status='completed',processed=2 WHERE id=?").run(original.id);
    const first=JSON.parse(f.items(original.id)[0].snapshot_json);f.db.prepare('UPDATE mail_link SET revision=revision+1 WHERE id=?').run(first.linkId);
    const recheck=recheckVerificationTask(f.env,original.id,{idempotencyKey:randomUUID()});expect(recheck).toMatchObject({total:1,originalUnpassed:2});expect(recheck.skipped).toHaveLength(1);
  });
});

describe('SMTP configuration, rotation and daily claims',()=>{
  it('stores only encrypted secrets and safe DTOs, preserves blank passwords and explicitly clears default',()=>{
    const f=fixture(),sender=f.sender();expect(sender.hasPassword).toBe(true);expect(JSON.stringify(smtpConfiguration(f.env))).not.toContain('private-authorization-code');
    const persisted=f.db.prepare('SELECT password_encrypted FROM verification_smtp').get().password_encrypted;expect(persisted).not.toContain('private-authorization-code');
    f.sender({password:''});expect(f.db.prepare('SELECT password_encrypted FROM verification_smtp').get().password_encrypted).toBe(persisted);
    saveSmtp(f.env,{clearPassword:true},{kind:'default'});expect(smtpConfiguration(f.env).default.hasPassword).toBe(false);
    expect(()=>f.task({type:'receive',confirmSend:true})).toThrow(expect.objectContaining({code:'SMTP_UNAVAILABLE'}));
    expect(()=>f.sender({host:'smtp.example.net\r\nBcc: x',password:'x'})).toThrow();
    expect(()=>f.sender({encryption:'none'})).toThrow();
  });
  it('does not fall back to default when a pool exists but is disabled',()=>{
    const f=fixture();f.sender();f.sender({email:'pool@example.net',enabled:false},'pool');
    expect(()=>f.task({type:'receive',confirmSend:true})).toThrow(expect.objectContaining({code:'SMTP_UNAVAILABLE'}));
  });
  it('serializes SMTP across tasks, applies intervals and rotates enabled pool senders',async()=>{
    const f=fixture();f.sender({email:'pool1@example.net'},'pool');f.sender({email:'pool2@example.net'},'pool');
    const first=f.task({type:'receive',confirmSend:true,sendIntervalMs:200}),second=f.task({type:'receive',confirmSend:true,sendIntervalMs:200});
    let active=0,maxActive=0;const starts=[];
    f.env.verificationTransports.smtp=vi.fn(async({message,config})=>{active++;maxActive=Math.max(maxActive,active);starts.push({time:Date.now(),sender:config.email});
      await new Promise(resolve=>setTimeout(resolve,20));f.message(message.to,message.subject);active--;return {accepted:[message.to]};});
    await Promise.all([runVerificationTask(f.env,first.id),runVerificationTask(f.env,second.id)]);
    expect(maxActive).toBe(1);expect(starts[1].time-starts[0].time).toBeGreaterThanOrEqual(200);expect(starts[0].sender).not.toBe(starts[1].sender);
  });
  it('disables the default plan, confirms enabling and claims one local date even when creation fails',()=>{
    const f=fixture(),plan=getVerificationPlan(f.env);expect(plan).toMatchObject({enabled:false,time:'02:00',sample:1,timeZone:'Asia/Shanghai'});
    expect(()=>saveVerificationPlan(f.env,{...plan,enabled:true})).toThrow(expect.objectContaining({code:'SEND_CONFIRMATION_REQUIRED'}));f.sender();
    saveVerificationPlan(f.env,{...plan,enabled:true,confirmSend:true});
    const now=Date.parse('2026-11-13T02:01:00+08:00'),first=checkVerificationSchedule(f.env,{now});expect(first.type).toBe('receive');expect(checkVerificationSchedule(f.env,{now})).toBeNull();
    expect(getVerificationPlan(f.env).lastClaimDate).toBe('2026-11-13');
    stopVerificationTask(f.env,first.id,{confirm:true});f.db.prepare('DELETE FROM verification_smtp').run();
    const tomorrow=now+86400000;expect(checkVerificationSchedule(f.env,{now:tomorrow})).toBeNull();f.sender();expect(checkVerificationSchedule(f.env,{now:tomorrow})).toBeNull();
    expect(getVerificationPlan(f.env)).toMatchObject({lastClaimDate:'2026-11-14',lastStatus:'failed'});
  });
  it('runs only saved plan values, confirms immediate sending and leaves automatic claim date untouched',()=>{
    const f=fixture(3);f.sender();const plan=getVerificationPlan(f.env);saveVerificationPlan(f.env,{...plan,enabled:false,sample:3});
    expect(()=>runSavedVerificationPlan(f.env,{idempotencyKey:randomUUID()})).toThrow();
    const task=runSavedVerificationPlan(f.env,{confirmSend:true,idempotencyKey:randomUUID(),sample:1});expect(task.total).toBe(3);expect(getVerificationPlan(f.env).lastClaimDate).toBeNull();
    f.env.node_role='secondary';expect(checkVerificationSchedule(f.env)).toBeNull();expect(()=>f.task()).toThrow(expect.objectContaining({code:'PRIMARY_ONLY'}));
  });
  it('starts and stops runtime cleanly, excludes secondary workers and aborts network waits before returning',async()=>{
    const f=fixture();f.env.node_role='secondary';const secondaryStop=startVerificationRuntime(f.env);await secondaryStop();expect(f.env.verificationState.runtimeStop).toBeUndefined();
    f.env.node_role='primary';const stop=startVerificationRuntime(f.env),gate=deferred();f.env.verificationTransports.readSource=()=>gate.promise;
    const task=f.task();await new Promise(resolve=>setTimeout(resolve,550));await stop();gate.resolve({messages:[]});
    expect(f.env.verificationState.runningTasks.size).toBe(0);expect(getTask(f.env,task.id).passed).toBe(0);
  });
});

describe('verification reports and HTTP boundaries',()=>{
  it('exports every historical item with BOM, stable order and formula escaping',()=>{
    const f=fixture(3),task=f.task();f.db.prepare("UPDATE verification_item SET note='=HYPERLINK(\"https://evil\")' WHERE task_id=?").run(task.id);
    f.db.prepare('DELETE FROM mail_link').run();const report=verificationCsv(f.env,task.id);
    expect(report.startsWith('\uFEFF')).toBe(true);expect(report.split('\r\n')).toHaveLength(5);expect(report).toContain("'=HYPERLINK");
    expect(report).not.toContain('private-authorization-code');expect(report).toContain('a@example.com');
  });
  it('exposes contract pagination and complete-download headers without hiding errors',async()=>{
    const f=fixture(3),app=new Hono();mountVerificationRoutes(app);app.onError((error,c)=>c.json({code:error.code,message:error.message},error.status||500));
    const task=f.task(),detail=await app.request(`http://test/admin/verification/tasks/${task.id}?pageSize=1`,{},f.env),body=await detail.json();
    expect(body.data).toMatchObject({total:3,page:1,pageSize:1});expect(body.data.items).toHaveLength(1);
    const report=await app.request(`http://test/admin/verification/tasks/${task.id}/export`,{},f.env),bytes=Buffer.from(await report.arrayBuffer());
    expect(report.headers.get('content-length')).toBe(String(bytes.length));expect(report.headers.get('x-content-sha256')).toMatch(/^[a-f0-9]{64}$/);expect(report.headers.get('cache-control')).toBe('no-store');
    expect((await app.request('/admin/verification/tasks?pageSize=751',{},f.env)).status).toBe(400);
  });
  it('returns and persists every all-skipped recheck reason while refusing a zero-target task',async()=>{
    const f=fixture(2);f.sender();const task=f.task({type:'receive',confirmSend:true});stopVerificationTask(f.env,task.id,{confirm:true});
    const app=new Hono();mountVerificationRoutes(app);
    const response=await app.request(`http://test/admin/verification/tasks/${task.id}/recheck`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:randomUUID()})},f.env);
    expect(response.status).toBe(400);const body=await response.json();expect(body.error).toMatchObject({code:'NO_RECHECK_TARGETS',details:{originalUnpassed:2,total:0}});
    expect(body.error.details.skipped).toHaveLength(2);expect(body.error.details.skipped.every(row=>row.reason.includes('No persisted'))).toBe(true);
    expect(getTask(f.env,task.id).lastRecheck).toEqual(body.error.details);expect(f.db.prepare('SELECT count(*) n FROM verification_task').get().n).toBe(1);
  });
});
