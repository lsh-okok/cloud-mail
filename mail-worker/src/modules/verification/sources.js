import { createHash, randomUUID } from 'node:crypto';
import { FeatureError, positiveInt } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { publicUrl } from '../shared/urls.js';
import { resolvePublicLink, validatePublicLink } from '../public-mail/service.js';
import { validateCustomUrl } from './network.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const primary=env=>{if((env.node_role??env.nodeRole??'primary')!=='primary')throw new FeatureError(403,'PRIMARY_ONLY','Mailbox verification is available only on the primary node.');};
export {primary};
function policyFor(env,row,mode,customUrl,revision) {
  const resolved=resolvePublicLink(env,{publicId:row.public_id,recipient:row.recipient,platform:row.platform_id||'p0'});
  if(resolved.id!==row.link_id)throw new FeatureError(409,'SOURCE_CONFLICT','The public policy resolves to another source link.');
  const context=validatePublicLink(env,resolved);
  const policy={linkId:row.link_id,mailboxId:row.mailbox_id,recipient:row.recipient,publicId:row.public_id,
    platform:row.platform_id||'p0',publicFingerprint:context.fingerprint,mode,customUrl,revision};
  return {policy,fingerprint:hash(policy)};
}
function joinedSource(env,linkId) {
  return env.db.prepare(`SELECT l.id AS link_id,l.mailbox_id,l.recipient,l.platform_id,l.expires_at,l.revision,
    s.email AS mailbox_email,s.public_id,s.enabled,s.provider FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id WHERE l.id=?`).get(linkId);
}
export function syncVerificationSources(env) {
  primary(env);
  return env.db.transaction(()=>{
    const mains=env.db.prepare("SELECT id FROM source_mailbox WHERE enabled=1 AND provider='mx'").all();
    const links=env.db.prepare(`SELECT l.id AS link_id,l.mailbox_id,l.recipient,l.platform_id,l.expires_at,l.revision,
      s.email AS mailbox_email,s.public_id,s.enabled,s.provider FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id
      WHERE s.provider='mx' AND s.enabled=1 ORDER BY l.id`).all();
    const addresses=new Map();
    for(const row of links) {
      const list=addresses.get(row.recipient.toLowerCase())||[]; list.push(row); addresses.set(row.recipient.toLowerCase(),list);
    }
    env.db.prepare("UPDATE verification_source SET eligible=0,reason='Source mailbox disabled, deleted, or link removed.'").run();
    const conflicts=[];let syncedCount=0;
    for(const row of links) {
      const existing=env.db.prepare('SELECT * FROM verification_source WHERE link_id=?').get(row.link_id);
      const id=existing?.id||randomUUID(),mode=existing?.mode||'system',customUrl=existing?.custom_url||'',revision=existing?.revision||1;
      let eligible=1,reason='',fingerprint='',policy={};
      try {
        if(addresses.get(row.recipient.toLowerCase()).length>1) throw new FeatureError(409,'SOURCE_CONFLICT','The complete address belongs to multiple source links, mailboxes or platform policies.');
        ({policy,fingerprint}=policyFor(env,row,mode,customUrl,revision));
        if(mode==='custom')validateCustomUrl(customUrl);
      } catch(error) {eligible=0;reason=error.code==='SOURCE_CONFLICT'?error.message:error.status===410?'The source link expired.':'The source mailbox or public policy is unavailable.';
        conflicts.push({recipient:row.recipient,mailboxId:row.mailbox_id,linkId:row.link_id,reason});}
      if(eligible)syncedCount++;
      env.db.prepare(`INSERT INTO verification_source(id,mailbox_id,mailbox_email,recipient,link_id,mode,custom_url,revision,eligible,reason,fingerprint,policy_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(link_id) DO UPDATE SET mailbox_id=excluded.mailbox_id,mailbox_email=excluded.mailbox_email,
        recipient=excluded.recipient,eligible=excluded.eligible,reason=excluded.reason,fingerprint=excluded.fingerprint,policy_json=excluded.policy_json,updated_at=excluded.updated_at`)
        .run(id,row.mailbox_id,row.mailbox_email,row.recipient,row.link_id,mode,customUrl,revision,eligible,reason,fingerprint,JSON.stringify(policy),Date.now());
    }
    return {mainCount:mains.length,linkCount:links.length,syncedCount,conflictCount:conflicts.length,conflicts};
  }).immediate();
}
export function sourceSnapshot(env,row,requestUrl='https://localhost') {
  const policy=JSON.parse(row.policy_json);
  let linkUrl=row.custom_url;
  if(row.mode==='system') {
    const link=env.db.prepare('SELECT id,token_encrypted FROM mail_link WHERE id=?').get(row.link_id);
    // Exact token URLs avoid an O(n) short-path ambiguity scan for every source
    // in a large task. The trusted source mapping still resolves internally.
    if(link&&env.secretVault)linkUrl=publicUrl(env,requestUrl,`m/${env.secretVault.decrypt(link.token_encrypted,`mail-link:${link.id}`)}`);
  }
  return {id:row.id,mailboxId:row.mailbox_id,mailboxEmail:row.mailbox_email,recipient:row.recipient,linkId:row.link_id,
    mode:row.mode,customUrl:row.custom_url,revision:row.revision,eligible:!!row.eligible,reason:row.reason,
    fingerprint:row.fingerprint,linkUrl,policy};
}
export function assertSnapshotCurrent(env,snapshot) {
  const row=env.db.prepare('SELECT * FROM verification_source WHERE id=?').get(snapshot.id);
  if(!row || row.revision!==snapshot.revision || row.mode!==snapshot.mode || row.custom_url!==snapshot.customUrl || row.mailbox_id!==snapshot.mailboxId || row.recipient!==snapshot.recipient || row.link_id!==snapshot.linkId)
    throw new FeatureError(409,'VERIFICATION_POLICY_CHANGED','The verification source or link mode changed.');
  const link=joinedSource(env,row.link_id);
  if(!link)throw new FeatureError(409,'VERIFICATION_POLICY_CHANGED','The source link was removed.');
  // Conflicts can appear after task creation, without editing the original link.
  const count=env.db.prepare(`SELECT count(*) count FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id
    WHERE s.enabled=1 AND s.provider='mx' AND l.recipient=? COLLATE NOCASE`).get(snapshot.recipient).count;
  if(count!==1)throw new FeatureError(409,'VERIFICATION_POLICY_CHANGED','The recipient ownership is now ambiguous.');
  const current=policyFor(env,link,row.mode,row.custom_url,row.revision);
  if(current.fingerprint!==snapshot.fingerprint)throw new FeatureError(409,'VERIFICATION_POLICY_CHANGED','The mailbox, link or platform policy changed.');
  return validatePublicLink(env,resolvePublicLink(env,{publicId:current.policy.publicId,recipient:current.policy.recipient,platform:current.policy.platform}));
}
export function updateVerificationSource(env,id,data,actor={}) {
  primary(env);const current=env.db.prepare('SELECT * FROM verification_source WHERE id=?').get(id);
  if(!current)throw new FeatureError(404,'VERIFICATION_SOURCE_NOT_FOUND','The verification source does not exist.');
  if(positiveInt(data.revision,'revision')!==current.revision)throw new FeatureError(409,'REVISION_CONFLICT','Reload the source before saving.');
  if(!['system','custom'].includes(data.mode))throw new FeatureError(400,'INVALID_SOURCE_MODE','Choose system or custom source mode.');
  const url=data.mode==='custom'?validateCustomUrl(data.customUrl):'';
  env.db.transaction(()=>{
    env.db.prepare('UPDATE verification_source SET mode=?,custom_url=?,revision=revision+1 WHERE id=? AND revision=?').run(data.mode,url,id,current.revision);
    appendAudit(env.db,{...actor,action:'verification.source.update',objectType:'verification',objectId:id});
    syncVerificationSources(env);
  }).immediate();
  return sourceSnapshot(env,env.db.prepare('SELECT * FROM verification_source WHERE id=?').get(id));
}
