import { stateFor } from './tasks.js';
import { runVerificationTask } from './execution.js';
import { checkVerificationSchedule } from './schedule.js';

export function recoverVerificationTasks(env) {
  return env.db.transaction(()=>{
    const now=Date.now();
    env.db.prepare(`UPDATE verification_item SET processed=1,phase='interrupted',checked_at=?,note='Service restarted; this item will never be resent automatically.'
      WHERE processed=0 AND task_id IN (SELECT id FROM verification_task WHERE status IN ('queued','running'))`).run(now);
    return env.db.prepare("UPDATE verification_task SET status='failed',processed=total,finished_at=?,error='Interrupted by service restart; original markers and send intents are preserved.' WHERE status IN ('queued','running')").run(now).changes;
  }).immediate();
}
export function startVerificationRuntime(env) {
  if((env.node_role??env.nodeRole??'primary')!=='primary')return async()=>{};
  const state=stateFor(env);if(state.runtimeStop)return state.runtimeStop;
  recoverVerificationTasks(env);
  state.controllers=new Map();state.runningTasks=new Map();let stopped=false,busy=false,nextSchedule=0;
  const tick=()=>{
    if(stopped||busy)return;busy=true;
    try {
      if(Date.now()>=nextSchedule){nextSchedule=Date.now()+15000;checkVerificationSchedule(env);}
      for(const row of env.db.prepare("SELECT id FROM verification_task WHERE status='queued' ORDER BY number LIMIT 4").all()) {
        if(state.runningTasks.size>=4)break;
        const controller=new AbortController();state.controllers.set(row.id,controller);
        const operation=runVerificationTask(env,row.id,{signal:controller.signal}).catch(()=>{
          if(!stopped)env.db.prepare("UPDATE verification_task SET status='failed',finished_at=?,error='Verification worker failed; no automatic resend is permitted.' WHERE id=? AND status='running'").run(Date.now(),row.id);
        }).finally(()=>{state.controllers.delete(row.id);state.runningTasks.delete(row.id);});
        state.runningTasks.set(row.id,operation);
      }
    } catch {
      // A transient schedule/DB error must not escape a timer and terminate the
      // server. The next bounded tick retries queued work; no send is replayed.
    } finally {busy=false;}
  };
  const timer=setInterval(tick,500);timer.unref?.();queueMicrotask(tick);
  state.runtimeStop=async()=>{
    if(stopped)return;stopped=true;clearInterval(timer);
    for(const controller of state.controllers.values())controller.abort();
    await Promise.allSettled([...state.runningTasks.values()]);
    recoverVerificationTasks(env);
    delete state.runtimeStop;
  };
  return state.runtimeStop;
}
