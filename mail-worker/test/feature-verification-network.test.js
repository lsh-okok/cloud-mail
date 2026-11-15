import { afterEach,describe,expect,it,vi } from 'vitest';
import net from 'node:net';
import { once } from 'node:events';
import { SMTPServer } from 'smtp-server';
import { createSecretVault } from '../src/modules/shared/secrets.js';
import { customGet,publicAddress,resolveDestination,validateCustomUrl } from '../src/modules/verification/network.js';
import { smtpSend } from '../src/modules/verification/smtp.js';

afterEach(()=>vi.restoreAllMocks());
describe('verification HTTP and SMTP destination boundaries',()=>{
  it('blocks private, mapped, link-local, metadata, reserved and non-global addresses for HTTP',()=>{
    for(const address of ['0.0.0.0','10.0.0.1','100.100.100.200','127.0.0.1','169.254.169.254','172.16.1.2','192.168.1.1','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:0808:0808::1'])expect(publicAddress(address),address).toBe(false);
    for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])expect(publicAddress(address),address).toBe(true);
    for(const url of ['http://localhost/a','http://127.1/','http://2130706433/','http://[::1]/','ftp://example.com','https://user:password@example.com','https://example.com/a\nBcc:x','https://example.com\t/a'])expect(()=>validateCustomUrl(url),url).toThrow();
  });
  it('rejects DNS with any private result and never opens a connection',async()=>{
    const request=vi.fn(),env={verificationTransports:{request,resolve:vi.fn(async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}])}};
    await expect(customGet(env,'https://custom.example.net')).rejects.toMatchObject({code:'UNSAFE_DESTINATION'});expect(request).not.toHaveBeenCalled();
  });
  it('pins every allowed connection to the validated answer and revalidates redirects',async()=>{
    let index=0;const env={verificationTransports:{resolve:vi.fn(async()=>[{address:++index===1?'8.8.8.8':'1.1.1.1',family:4}]),
      request:vi.fn(async options=>options.url.includes('first')?{status:302,headers:{location:'https://second.example.net/final'},body:''}:{status:200,body:'safe'})}};
    const result=await customGet(env,'https://first.example.net');expect(result).toEqual({status:200,body:'safe'});
    expect(env.verificationTransports.request.mock.calls.map(([options])=>options.address)).toEqual(['8.8.8.8','1.1.1.1']);
    env.verificationTransports.request=vi.fn(async()=>({status:302,headers:{location:'http://169.254.169.254/latest'},body:''}));
    await expect(customGet(env,'https://first.example.net')).rejects.toMatchObject({code:'UNSAFE_DESTINATION'});expect(env.verificationTransports.request).toHaveBeenCalledTimes(1);
  });
  it('limits redirects and response bytes and preserves HTTP result status for interpretation',async()=>{
    const env={verificationTransports:{resolve:async()=>[{address:'8.8.8.8'}],request:vi.fn(async()=>({status:302,headers:{location:'/loop'},body:''}))}};
    await expect(customGet(env,'https://custom.example.net')).rejects.toMatchObject({code:'REDIRECT_LIMIT'});expect(env.verificationTransports.request).toHaveBeenCalledTimes(6);
    env.verificationTransports.request=async()=>({status:200,body:Buffer.alloc(2*1024*1024+1)});await expect(customGet(env,'https://custom.example.net')).rejects.toMatchObject({code:'PAGE_TOO_LARGE'});
    env.verificationTransports.request=async()=>({status:429,body:'busy'});expect((await customGet(env,'https://custom.example.net')).status).toBe(429);
  });
  it('restricts SMTP private addresses to an explicit matching CIDR or single IP and never extends that exception to HTTP',async()=>{
    const env={verificationSmtpAllowCidrs:['10.1.0.0/16','127.0.0.1'],verificationTransports:{resolve:async host=>[{address:host==='mail.example.net'?'10.1.2.3':'10.2.3.4'}]}};
    expect((await resolveDestination(env,'mail.example.net',{smtp:true})).address).toBe('10.1.2.3');
    expect((await resolveDestination(env,'127.0.0.1',{smtp:true})).address).toBe('127.0.0.1');
    await expect(resolveDestination(env,'other.example.net',{smtp:true})).rejects.toMatchObject({code:'UNSAFE_DESTINATION'});
    await expect(resolveDestination(env,'mail.example.net')).rejects.toMatchObject({code:'UNSAFE_DESTINATION'});
    await expect(resolveDestination({...env,verificationSmtpAllowCidrs:[]},'127.0.0.1',{smtp:true})).rejects.toMatchObject({code:'UNSAFE_DESTINATION'});
  });
  it('closes the real pinned SMTP socket on cancellation and never authenticates over missing STARTTLS',async()=>{
    const connections=new Set(),commands=[];let socketClosed;
    const closed=new Promise(resolve=>{socketClosed=resolve;});
    const server=net.createServer(socket=>{connections.add(socket);socket.once('close',()=>{connections.delete(socket);socketClosed();});socket.write('220 local-test ESMTP\r\n');
      socket.on('data',data=>{const text=data.toString();commands.push(text);if(text.startsWith('EHLO'))socket.write('250-local-test\r\n250 AUTH PLAIN LOGIN\r\n');});});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const vault=createSecretVault({test:Buffer.alloc(32,5)}),row={id:'test-sender',host:'smtp.example.net',port:server.address().port,email:'sender@example.net',encryption:'starttls'};
    row.password_encrypted=vault.encrypt('private-auth',`verification-smtp:${row.id}`);
    try {
      const controller=new AbortController();
      const operation=smtpSend({secretVault:vault},row,{recipient:'child@example.com',marker:'cmv-test-only',signal:controller.signal,destination:{address:'127.0.0.1',family:4}}).catch(error=>error);
      await new Promise(resolve=>setTimeout(resolve,100));controller.abort();
      await operation;await closed;expect(connections.size).toBe(0);expect(commands.join('')).not.toContain('AUTH ');expect(commands.join('')).not.toContain('private-auth');
    } finally {for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));}
  });
  it('rejects an untrusted certificate before authentication for implicit TLS and STARTTLS',async()=>{
    for(const encryption of ['tls','starttls']) {
      let authCalls=0;
      const server=new SMTPServer({secure:encryption==='tls',logger:false,hideSTARTTLS:false,
        onAuth(_auth,_session,callback){authCalls++;callback(null,{user:'sender@example.net'});}});
      server.on('error',()=>{});
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      const vault=createSecretVault({test:Buffer.alloc(32,6)}),row={id:'tls-test',host:'smtp.example.net',port:server.server.address().port,email:'sender@example.net',encryption};
      row.password_encrypted=vault.encrypt('test-auth-only',`verification-smtp:${row.id}`);
      try {
        await expect(smtpSend({secretVault:vault},row,{recipient:'child@example.com',marker:'test-marker',signal:AbortSignal.timeout(2000),destination:{address:'127.0.0.1',family:4}})).rejects.toBeDefined();
        expect(authCalls).toBe(0);
      } finally {await new Promise(resolve=>server.close(resolve));}
    }
  });
});
