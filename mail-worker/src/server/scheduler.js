import userService from '../service/user-service.js';
import verifyRecordService from '../service/verify-record-service.js';
import emailService from '../service/email-service.js';
import oauthService from '../service/oauth-service.js';
import analysisService from '../service/analysis-service.js';
import { serviceContext } from './environment.js';

export function startScheduler(env) {
  let running;
  async function tick() {
    if (running) return running;
    running = (async () => {
      const c = serviceContext(env);
      const now = new Date().toISOString();
      const day = now.slice(0, 10);
      const hour = now.slice(0, 13);
      if (await env.kv.get('server:maintenance:day') !== day) {
        await userService.resetDaySendCount(c, true);
        await verifyRecordService.clearRecord(c, true);
        await env.kv.put('server:maintenance:day', day);
      }
      if (await env.kv.get('server:maintenance:hour') !== hour) {
        await emailService.completeReceiveAll(c);
        await emailService.autoClean(c);
        await analysisService.refreshEchartsCache(c);
        await oauthService.clearNoBindOathUser(c);
        await env.kv.put('server:maintenance:hour', hour);
      }
      env.kv.purgeExpired?.();
    })().catch(error => console.error('Maintenance failed:', error.message)).finally(() => { running = undefined; });
    return running;
  }
  const timer = setInterval(tick, 60000);
  timer.unref();
  void tick();
  return { tick, async close() { clearInterval(timer); await running; } };
}
