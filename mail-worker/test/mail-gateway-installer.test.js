import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [], instance = 'ab'.repeat(16), revision = 'ef'.repeat(20);
const digest = `sha256:${'cd'.repeat(32)}`, image = `ghcr.io/lsh-okok/cloud-mail@${digest}`, imageId = `sha256:${'ab'.repeat(32)}`;
const publicKey = `MIIB${'Ab0+/'.repeat(65)}AQAB`, txtContent = `v=DKIM1; h=sha256; k=rsa; p=${publicKey}`;
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/bash';
const source = fileURLToPath(new URL('../../docker/enable-mail.sh', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-combined-test-')); roots.push(root);
  const write = (name,value='') => writeFileSync(join(root,name),value);
  const read = name => readFileSync(join(root,name),'utf8');
  for (const dir of ['bin','installed','certs/live/npm-1']) mkdirSync(join(root,dir),{recursive:true});
  write('enable-mail.sh',readFileSync(source,'utf8'));
  write('certs/live/npm-1/fullchain.pem','public cert'); write('certs/live/npm-1/privkey.pem','PRIVATE KEY FIXTURE');
  write('dkim-record',`mail._domainkey IN TXT ( "v=DKIM1; h=sha256; k=rsa; "\n "p=${publicKey}" ) ; "comment"\n`);
  const env=['NODE_ROLE=primary','MAIL_ENABLED=false','MAIL_HOST=mx.example.com','MAIL_DOMAINS=example.com','JWT_SECRET=private-jwt-fixture','SMTP_USER=old-user','SMTP_PASSWORD=old-secret'];
  const app={Id:'old',Image:`sha256:${'11'.repeat(32)}`,Config:{Env:env,Cmd:['node','mail-worker/server-dist/index.cjs'],Entrypoint:['tini','--','/usr/local/bin/cloud-mail-entrypoint'],Labels:{'cloud-mail.installation-id':instance,'cloud-mail.role':'primary','custom':'preserved'}},HostConfig:{NetworkMode:'bridge',Binds:['test-primary-data:/data','extra-volume:/extra:ro'],Mounts:[],PortBindings:{'3000/tcp':[{HostIp:'127.0.0.1',HostPort:'13010'}]},SecurityOpt:['no-new-privileges:true'],RestartPolicy:{Name:'unless-stopped'},Memory:12345678,LogConfig:{Type:'json-file',Config:{'max-size':'10m'}}},Mounts:[{Type:'volume',Name:'test-primary-data',Destination:'/data'},{Type:'volume',Name:'extra-volume',Destination:'/extra'}],NetworkSettings:{Networks:{bridge:{Aliases:[],IPAMConfig:null},'npm-net':{Aliases:['primary-proxy'],IPAMConfig:{IPv4Address:'172.20.0.9'}}}}};
  app.Config.Labels['org.opencontainers.image.revision']='old-revision';
  app.NetworkSettings.Networks['npm-net'].IPAMConfig.IPv6Address='fd00:20::9';
  app.NetworkSettings.Networks['npm-net'].IPAMConfig.LinkLocalIPs=['169.254.1.9'];
  app.NetworkSettings.Networks['npm-net'].DriverOpts={'custom-option':'preserved'};
  write('app.json',JSON.stringify([app]));
  write('image.json',JSON.stringify([{Config:{Env:['PATH=/usr/bin'],Cmd:app.Config.Cmd,Entrypoint:app.Config.Entrypoint,Labels:{'org.opencontainers.image.revision':revision,'org.opencontainers.image.source':'https://github.com/lsh-okok/cloud-mail','io.cloud-mail.mail-capable':'true','io.cloud-mail.component':'combined'},Healthcheck:{Test:['CMD','/usr/local/bin/cloud-mail-healthcheck']}}}]));
  write('gateway.json',JSON.stringify([{Config:{Labels:{'cloud-mail.installation-id':instance,'cloud-mail.role':'mta'}},Mounts:[{Type:'volume',Name:'test-primary-mail-spool',Destination:'/var/spool/postfix'},{Type:'volume',Name:'test-primary-dkim',Destination:'/etc/opendkim/keys'},{Type:'volume',Name:'test-primary-mail-logs',Destination:'/var/log/postfix'}]}]));
  write('installed/primary.env',env.join('\n')+'\n');
  write('apply.mjs',`import fs from 'node:fs'; const root=process.argv[2], input=JSON.parse(fs.readFileSync(process.argv[3],'utf8')), url=process.argv[4]; if(url.includes('/networks/')) { const network=url.split('/networks/')[1].split('/')[0], app=JSON.parse(fs.readFileSync(root+'/app.json','utf8')); app[0].NetworkSettings.Networks[network]=input.EndpointConfig; fs.writeFileSync(root+'/app.json',JSON.stringify(app)); fs.appendFileSync(root+'/connect.jsonl',JSON.stringify({network,...input})+'\\n'); } else { fs.writeFileSync(root+'/payload.json',JSON.stringify(input)); const {HostConfig,NetworkingConfig,...Config}=input; fs.writeFileSync(root+'/app.json',JSON.stringify([{Config,HostConfig,Image:'${imageId}',Mounts:[{Type:'volume',Name:'test-primary-data',Destination:'/data'}],NetworkSettings:{Networks:NetworkingConfig.EndpointsConfig}}])); fs.writeFileSync(root+'/combined',''); }`);
  write('networks.mjs',`import fs from 'node:fs'; const root=process.argv[2], mode=process.argv[3], name=process.argv[4], network=process.argv[5], path=root+(name==='test-primary-before-unified'?'/app-backup.json':'/app.json'), app=JSON.parse(fs.readFileSync(path,'utf8')); if(mode==='list') console.log(Object.keys(app[0].NetworkSettings.Networks).join('\\n')); else { delete app[0].NetworkSettings.Networks[network]; fs.writeFileSync(path,JSON.stringify(app)); }`);
  const mock=(name,code)=>writeFileSync(join(root,'bin',name),`#!/bin/sh\nset -eu\n${code}`,{mode:0o755});
  mock('id',"printf '0\\n'"); mock('uname','case "${1:-}" in -m) printf x86_64 ;; *) printf Linux ;; esac');
  mock('ss','[ ! -f "$MAIL_ENABLE_TEST_ROOT/port-busy" ] || printf LISTEN'); mock('sleep','exit 0');
  mock('date','n=0; [ ! -f "$MAIL_ENABLE_TEST_ROOT/clock" ] || n=$(cat "$MAIL_ENABLE_TEST_ROOT/clock"); printf "%s\\n" "$n"; printf "%s\\n" "$((n+20))" > "$MAIL_ENABLE_TEST_ROOT/clock"');
  mock('openssl','case "$*" in *-checkend*) [ ! -f "$MAIL_ENABLE_TEST_ROOT/bad-cert" ] ;; *) printf fixture-key ;; esac');
  mock('mv',`/bin/mv "$@"
for target in "$@"; do last=$target; done
case "$last" in
  */installed/mail.env) marker=interrupt-env ;;
  */installed/.install-state) marker=interrupt-state ;;
  *) exit 0 ;;
esac
if [ -f "$MAIL_ENABLE_TEST_ROOT/$marker" ]; then rm -f "$MAIL_ENABLE_TEST_ROOT/$marker"; kill -TERM "$PPID"; fi`);
  mock('curl',`file=''; url=''; while [ "$#" -gt 0 ]; do case "$1" in --data-binary) shift; file=$1 ;; http:*) url=$1 ;; esac; shift; done
[ -n "$file" ] || exit 0
case "$url" in
  */containers/create*)
    [ ! -f "$MAIL_ENABLE_TEST_ROOT/create-failed" ] || exit 22
    if [ -f "$MAIL_ENABLE_TEST_ROOT/create-collision" ]; then cp "$MAIL_ENABLE_TEST_ROOT/app-backup.json" "$MAIL_ENABLE_TEST_ROOT/app.json"; touch "$MAIL_ENABLE_TEST_ROOT/collision-live"; exit 22; fi ;;
  */networks/*) if [ -f "$MAIL_ENABLE_TEST_ROOT/connect-failed" ]; then rm -f "$MAIL_ENABLE_TEST_ROOT/connect-failed"; exit 22; fi ;;
esac
node "$MAIL_ENABLE_TEST_ROOT/apply.mjs" "$MAIL_ENABLE_TEST_ROOT" "\${file#@}" "$url"
`);
  mock('docker',`printf '%s\\n' "$*" >> "$MAIL_ENABLE_TEST_ROOT/docker.log"
case "$1" in
info) exit 0 ;;
context) printf 'unix:///var/run/docker.sock' ;;
container)
  if [ "\${3:-}" = --format ]; then format=$4; name=$5; else format=''; name=$3; fi
  case "$name" in
    npm) printf '%s/certs' "$MAIL_ENABLE_TEST_ROOT"; exit ;;
    test-primary-mail) [ -f "$MAIL_ENABLE_TEST_ROOT/gateway-present" ] || exit 1 ;;
    test-primary-before-unified) [ -f "$MAIL_ENABLE_TEST_ROOT/app-backup.json" ] || exit 1 ;;
    test-primary-mail-before-unified) [ -f "$MAIL_ENABLE_TEST_ROOT/gateway-backup" ] || exit 1 ;;
    test-primary) [ -f "$MAIL_ENABLE_TEST_ROOT/app.json" ] || exit 1 ;;
    *) exit 1 ;;
  esac
  if [ -z "$format" ]; then
    case "$name" in
      test-primary-mail|test-primary-mail-before-unified) cat "$MAIL_ENABLE_TEST_ROOT/gateway.json" ;;
      test-primary-before-unified) cat "$MAIL_ENABLE_TEST_ROOT/app-backup.json" ;;
      *) cat "$MAIL_ENABLE_TEST_ROOT/app.json" ;;
    esac
    exit
  fi
  case "$format" in
    *installation-id*) if { [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-gateway" ] && [ "$name" = test-primary-mail ]; } || { [ -f "$MAIL_ENABLE_TEST_ROOT/collision-live" ] && [ "$name" = test-primary ]; }; then printf other; else printf '${instance}'; fi ;;
    *cloud-mail.role*) if [ "$name" = test-primary-mail ]; then printf mta; else printf primary; fi ;;
    *cloud-mail.mail-enabled*) [ ! -f "$MAIL_ENABLE_TEST_ROOT/combined" ] || printf true ;;
    *'.Type "volume"'*) printf 'test-primary-data\\nextra-volume\\n' ;;
    *Mounts*) if [ -f "$MAIL_ENABLE_TEST_ROOT/wrong-app-mount" ]; then printf bind:/other; else printf volume:test-primary-data; fi ;;
    *State.Running*) printf true ;;
    *PortBindings*) printf 25 ;;
    *'range $name'*) node "$MAIL_ENABLE_TEST_ROOT/networks.mjs" "$MAIL_ENABLE_TEST_ROOT" list "$name" ;;
    *Aliases*) if printf '%s' "$format" | grep -q npm-net; then printf 'primary-proxy\\n'; fi ;;
    *IPv4Address*) if printf '%s' "$format" | grep -q npm-net; then printf '172.20.0.9'; fi ;;
    '{{.Image}}') printf '${imageId}' ;;
    *) exit 98 ;;
  esac ;;
volume)
  case "$2" in
    inspect)
      if [ "$#" -eq 3 ]; then [ -f "$MAIL_ENABLE_TEST_ROOT/vol-$3" ]; exit; fi
      if [ -f "$MAIL_ENABLE_TEST_ROOT/wrong-owner" ] || [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-volume" ] || { [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-extra-volume" ] && [ "\${5:-}" = extra-volume ]; }; then printf other; else printf '${instance}'; fi ;;
    create) for v in "$@"; do last=$v; done; touch "$MAIL_ENABLE_TEST_ROOT/vol-$last" ;;
    *) exit 98 ;;
  esac ;;
network)
  case "$2" in
    inspect)
      [ -f "$MAIL_ENABLE_TEST_ROOT/network-present" ] || exit 1
      case "\${4:-}" in
        *installation-id*) if [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-network" ]; then printf other; else printf '${instance}'; fi ;;
        *Subnet*) printf 172.30.89.0/24 ;;
        *Containers*) if [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-peer" ]; then printf another-project; else printf test-primary; fi ;;
      esac ;;
    disconnect) node "$MAIL_ENABLE_TEST_ROOT/networks.mjs" "$MAIL_ENABLE_TEST_ROOT" disconnect "$4" "$3" ;;
    connect) exit 0 ;;
    *) exit 98 ;;
  esac ;;
pull) [ ! -f "$MAIL_ENABLE_TEST_ROOT/pull-failed" ] || exit 1; printf 'Digest: ${digest}\\n' ;;
image)
  if [ "\${3:-}" != --format ]; then cat "$MAIL_ENABLE_TEST_ROOT/image.json"; exit; fi
  case "$4" in
    *RepoDigests*) printf '${image}\\n' ;;
    *image.source*) printf https://github.com/lsh-okok/cloud-mail ;;
    *mail-capable*) if [ -f "$MAIL_ENABLE_TEST_ROOT/wrong-component" ]; then printf false; else printf true; fi ;;
    *image.revision*) printf '${revision}' ;;
    '{{.Id}}') printf '${imageId}' ;;
    *) exit 98 ;;
  esac ;;
exec)
  if [ "$3" = cat ]; then cat "$MAIL_ENABLE_TEST_ROOT/dkim-record"; exit; fi
  if [ "$3" = /usr/local/bin/cloud-mail-healthcheck ]; then [ ! -f "$MAIL_ENABLE_TEST_ROOT/not-ready" ]; exit; fi
  case "$6" in
    NODE_ROLE) printf primary ;; MAIL_ENABLED) [ ! -f "$MAIL_ENABLE_TEST_ROOT/combined" ] || printf true ;;
    MAIL_HOST) printf mx.example.com ;; MAIL_DOMAINS) printf example.com ;; MAIL_NETWORK_SUBNET) printf 172.30.89.0/24 ;; *) exit 98 ;;
  esac ;;
run)
  directory=''; while [ "$#" -gt 0 ]; do if [ "$1" = --mount ]; then shift; directory=\${1#type=bind,source=}; directory=\${directory%,target=/config}; fi; shift; done
  node "$directory/merge.mjs" "$directory" ;;
rename)
  case "$2" in
    test-primary) mv "$MAIL_ENABLE_TEST_ROOT/app.json" "$MAIL_ENABLE_TEST_ROOT/app-backup.json" ;;
    test-primary-before-unified) mv "$MAIL_ENABLE_TEST_ROOT/app-backup.json" "$MAIL_ENABLE_TEST_ROOT/app.json"; rm -f "$MAIL_ENABLE_TEST_ROOT/combined" ;;
    test-primary-mail) mv "$MAIL_ENABLE_TEST_ROOT/gateway-present" "$MAIL_ENABLE_TEST_ROOT/gateway-backup" ;;
    test-primary-mail-before-unified) mv "$MAIL_ENABLE_TEST_ROOT/gateway-backup" "$MAIL_ENABLE_TEST_ROOT/gateway-present" ;;
    *) exit 98 ;;
  esac ;;
rm)
  case "$2" in
    test-primary) rm -f "$MAIL_ENABLE_TEST_ROOT/app.json" "$MAIL_ENABLE_TEST_ROOT/combined" ;;
    test-primary-before-unified) rm -f "$MAIL_ENABLE_TEST_ROOT/app-backup.json" ;;
    test-primary-mail-before-unified) rm -f "$MAIL_ENABLE_TEST_ROOT/gateway-backup" ;;
    *) exit 98 ;;
  esac ;;
start|stop) exit 0 ;;
*) exit 98 ;;
esac`);
  const envChecksum=createHash('sha256').update(read('installed/primary.env')).digest('hex');
  const execute=(args=[])=>spawnSync(shell,['-c',`export PATH="$PWD/bin:$PATH" MAIL_ENABLE_TEST_ROOT="$PWD"; if [ ! -f installed/.install-state ]; then printf 'FORMAT=2\nINSTALL_DIR=%s/installed\nCONTAINER_NAME=test-primary\nHTTP_PORT=13010\nINSTANCE_ID=${instance}\nENV_SHA256=${envChecksum}\nIMAGE_ID=sha256:${'11'.repeat(32)}\n' "$PWD" > installed/.install-state; fi; bash ./enable-mail.sh --dir "$PWD/installed" "$@"`,'fixture',...args],{cwd:root,encoding:'utf8',timeout:20000});
  return {root,write,read,execute,mark:name=>{write(name); if(name==='gateway-present') for(const v of ['test-primary-mail-spool','test-primary-dkim','test-primary-mail-logs']) write('vol-'+v);},log:()=>existsSync(join(root,'docker.log'))?read('docker.log'):'',payload:()=>JSON.parse(read('payload.json'))};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe('single-container primary mail enablement',()=>{
  it('rebuilds the app with its complete configuration, original networks, preserved data and unified health',()=>{
    const f=fixture(), result=f.execute(); expect(result.error).toBeUndefined(); expect(result.status,result.stderr).toBe(0);
    const p=f.payload(); expect(p.Image).toBe(image); expect(p.Healthcheck.Test).toEqual(['CMD','/usr/local/bin/cloud-mail-healthcheck']);
    expect(p.Labels.custom).toBe('preserved'); expect(p.Labels['org.opencontainers.image.revision']).toBe(revision); expect(p.HostConfig.Memory).toBe(12345678); expect(p.HostConfig.LogConfig.Config['max-size']).toBe('10m');
    expect(p.HostConfig.PortBindings['3000/tcp']).toEqual([{HostIp:'127.0.0.1',HostPort:'13010'}]); expect(p.HostConfig.PortBindings['25/tcp']).toEqual([{HostIp:'0.0.0.0',HostPort:'25'}]);
    expect(p.HostConfig.Binds).toContain('extra-volume:/extra:ro'); expect(Object.keys(p.NetworkingConfig.EndpointsConfig)).toEqual(['bridge']);
    expect(JSON.parse(f.read('app.json'))[0].NetworkSettings.Networks['npm-net']).toMatchObject({Aliases:['primary-proxy'],IPAMConfig:{IPv4Address:'172.20.0.9',IPv6Address:'fd00:20::9',LinkLocalIPs:['169.254.1.9']},DriverOpts:{'custom-option':'preserved'}});
    expect(p.Env).toContain('MAIL_ENABLED=true'); expect(p.Env).toContain('SMTP_HOST=127.0.0.1'); expect(p.Env).toContain('MAIL_NETWORK_SUBNET=127.0.0.0/8');
    expect(p.Env.some(value=>value.startsWith('SMTP_USER=')||value.startsWith('SMTP_PASSWORD='))).toBe(false); expect(p.StopTimeout).toBe(120);
    expect(f.read('installed/.install-state')).toContain('FORMAT=3'); expect(f.read('installed/mail.env')).toContain('JWT_SECRET=private-jwt-fixture');
    expect(f.log()).toContain('pull ghcr.io/lsh-okok/cloud-mail:main'); expect(f.log()).not.toContain(':mta-main'); expect(f.log()).not.toContain('volume rm');
    expect(result.stdout).toContain(`内容：\n${txtContent}\n`); expect(result.stdout+result.stderr+f.log()).not.toContain('private-jwt-fixture');
    expect(result.stdout).toContain('统一容器：test-primary');
  });
  it('migrates an old app plus MTA while reusing its exact queue, DKIM and log volumes',()=>{
    const f=fixture(); f.mark('gateway-present'); const result=f.execute(); expect(result.status,result.stderr).toBe(0);
    const mounts=f.payload().HostConfig.Mounts; for(const target of ['/var/spool/postfix','/etc/opendkim/keys','/var/log/postfix'])expect(mounts.some(m=>m.Target===target&&m.Type==='volume')).toBe(true);
    expect(f.log().indexOf('stop -t 120 test-primary-mail')).toBeLessThan(f.log().indexOf('rename test-primary test-primary-before-unified'));
    expect(f.log()).toContain('rm test-primary-mail-before-unified'); expect(f.log()).not.toContain('volume rm');
  });
  it('repeats an enabled installation without pulling or rebuilding',()=>{
    const f=fixture(); expect(f.execute().status).toBe(0); const before=f.log(); f.mark('pull-failed'); const result=f.execute(); expect(result.status,result.stderr).toBe(0);
    expect(f.log().slice(before.length)).not.toMatch(/^(?:pull|run|stop|rm|rename|network) /m);
  });
  it.each(['create-failed','connect-failed','not-ready','interrupt-env','interrupt-state'])('rolls back %s before updating metadata or deleting volumes',marker=>{
    const f=fixture(); f.mark('gateway-present'); f.mark(marker); const original=f.read('app.json'); const result=f.execute(); expect(result.status,result.stderr).toBe(marker.startsWith('interrupt-')?143:1);
    expect(JSON.parse(f.read('app.json'))).toEqual(JSON.parse(original)); expect(f.read('installed/.install-state')).toContain('FORMAT=2'); expect(existsSync(join(f.root,'installed/mail.env'))).toBe(false);
    expect(f.log()).toContain('rename test-primary-before-unified test-primary'); expect(f.log()).toContain('start test-primary-mail'); expect(f.log()).not.toContain('volume rm');
  });
  it.each(['bad-cert','pull-failed','wrong-component','wrong-owner','foreign-extra-volume','wrong-app-mount','port-busy'])('keeps services untouched after preflight failure: %s',marker=>{
    const f=fixture();f.mark(marker);expect(f.execute().status).toBe(1);expect(f.log()).not.toMatch(/^(?:stop|rm|rename|volume create|network connect|network disconnect) /m);
  });
  it('keeps an unexpected same-name container intact if create collides',()=>{
    const f=fixture(); f.mark('create-collision'); const result=f.execute(); expect(result.status).toBe(1);
    expect(existsSync(join(f.root,'app-backup.json'))).toBe(true); expect(existsSync(join(f.root,'app.json'))).toBe(true);
    expect(f.log().match(/^stop -t 120 test-primary$/gm)).toHaveLength(1); expect(f.log()).not.toContain('rm test-primary\n');
    expect(f.read('installed/.install-state')).toContain('FORMAT=2'); expect(result.stderr).toContain('自动恢复未全部完成');
  });
  it('rejects a custom application command without stopping services',()=>{
    const f=fixture(), app=JSON.parse(f.read('app.json')); app[0].Config.Cmd=['node','custom.js']; f.write('app.json',JSON.stringify(app));
    expect(f.execute().status).toBe(1); expect(f.log()).not.toMatch(/^(?:stop|rename) /m);
  });
  it('refuses a gateway with a different mounted queue',()=>{
    const f=fixture();f.mark('gateway-present');const g=JSON.parse(f.read('gateway.json'));g[0].Mounts[0].Name='other-project';f.write('gateway.json',JSON.stringify(g));expect(f.execute().status).toBe(1);expect(f.log()).not.toMatch(/^(?:stop|rename) /m);
  });
  it('shows the existing DKIM public record without pulling or changing services',()=>{
    const f=fixture();f.mark('gateway-present');f.mark('bad-cert');f.mark('pull-failed');const result=f.execute(['--show-dkim']);expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain(`内容：\n${txtContent}\n`);expect(f.log()).not.toMatch(/^(?:pull|run|stop|rm|rename|network) /m);
  });
  it.each(['mail._domainkey IN TXT ( "v=DKIM1; k=rsa; " )','mail._domainkey IN TXT "v=DKIM1; p=broken key"'])('rejects malformed DKIM without printing partial content',record=>{
    const f=fixture();f.mark('gateway-present');f.write('dkim-record',record);const result=f.execute(['--show-dkim']);expect(result.status).toBe(1);expect(result.stderr).toContain('DKIM 公钥格式无效');expect(result.stdout).not.toContain('内容：');
  });
});
