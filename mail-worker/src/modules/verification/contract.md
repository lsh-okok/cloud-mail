# 邮箱验证 API 契约

所有接口位于现有 `/api` 管理路由下，复用管理员认证/CSRF；以下省略 `/api`。响应 `{data:...}`，错误复用 FeatureError。仅 primary 可使用本模块。内部 ID 使用 UUID，与来源主邮箱 ID 单独映射。时间为 ISO，空值为 null。

## 来源

- `POST /admin/verification/sync` 空 JSON，返回 `{mainCount,linkCount,syncedCount,conflictCount,conflicts:[{recipient,mailboxId,linkId,reason}]}`。页面进入时调用；创建任务仍在服务端再次同步。
- `GET /admin/verification/sources?page=1&pageSize=25&q=&mailboxId=` 返回 `{items,total,page,pageSize,summary}`。item 为 `{id,mailboxId,mailboxEmail,recipient,linkId,mode:'system'|'custom',customUrl,revision,eligible,reason,fingerprint,linkUrl}`。summary 同同步统计。
- `PUT /admin/verification/sources/:id` `{revision,mode,customUrl}`，system 清除自定义 URL；custom 需绝对安全 HTTP(S) URL。用户配置 custom 不被同步覆盖。

## 任务

- `POST /admin/verification/tasks` `{type:'link'|'receive',mailboxIds?:string[],sourceIds?:string[],sample:'all'|1|3|5,timeoutSeconds:10,concurrency:5,waitSeconds:60,sendIntervalMs:1000,confirmSend?:true,idempotencyKey:string}`，201 返回任务；省略两个 ID 集合为全部，集合原始长度 1~500；不可同时提供。receive 必须确认发信。幂等键 8~128 字符，同键异参409。任务目标上限20000、活动上限4。
- `GET /admin/verification/tasks?page=1&pageSize=25` 返回分页任务。任务 `{id,number,type,status,total,processed,passed,failed,pending,createdAt,startedAt,finishedAt,parentTaskId,options,skipped,originalUnpassed,error}`。
- `GET /admin/verification/tasks/:id?page=1&pageSize=25&result=` 返回 `{task,items,total,page,pageSize}`；item `{id,sourceId,mailboxId,mailboxEmail,recipient,linkUrl,mode,fingerprint,result,processed,phase,marker,senderEmail,httpStatus,note,startedAt,sentAt,checkedAt}`。
- `POST /admin/verification/tasks/:id/stop` `{confirm:true}`，保留已完成项，中断未处理项，返回任务。
- `POST /admin/verification/tasks/:id/recheck` `{idempotencyKey}`，原任务必须结束；返回新任务（带 skipped 和 originalUnpassed）。收信复检沿用标识/发件人/发送时间，SMTP零调用。全部跳过时返回400 `NO_RECHECK_TARGETS`，`error.details={createdAt,originalUnpassed,total:0,skipped}`；该记录同时持久保存在原任务的 `lastRecheck` 字段，避免生成0项成功任务。
- `GET /admin/verification/tasks/:id/export` 下载全部项 BOM CSV，响应含 Content-Length / X-Content-SHA256，禁止缓存，防公式注入。

## 发件配置

- `GET /admin/verification/smtp` 返回 `{default: sender|null,pool:sender[],presets:[{name,host,port,encryption,help}],encryptionAvailable:boolean}`。
- `PUT /admin/verification/smtp/default` `{host,port,email,encryption:'tls'|'starttls',password?,clearPassword?:boolean}`。
- `POST /admin/verification/smtp/pool` / `PUT /admin/verification/smtp/pool/:id` `{host,port,email,encryption,password?,enabled?:boolean}`。
- `DELETE /admin/verification/smtp/pool/:id` 删除需UI确认。
- sender 仅 `{id,host,port,email,encryption,enabled,hasPassword,lastUsedAt,revision}`，不返回明文/密文；编辑密码空字符串保留。默认显式清除密码仅 clearPassword:true。全局串行发送与间隔、池优先轮换。池存在但没有可用账号拒绝。

## 每日计划

- `GET /admin/verification/plan` 返回 `{enabled,time:'02:00',mailboxIds:[],sample:1,timeoutSeconds:10,concurrency:5,waitSeconds:60,sendIntervalMs:1000,revision,timeZone,lastClaimDate,lastTaskId,lastRunAt,lastStatus,lastError,nextRunAt}`。
- `PUT /admin/verification/plan` 可写上述配置字段及 `{revision,confirmSend:true}`；启用必须确认并有可用SMTP。mailboxIds为空为全部。
- `POST /admin/verification/plan/run` `{confirmSend:true,idempotencyKey}` 仅执行已保存配置，不占当天自动认领日期。

## 集成

`service.js` exports `VERIFICATION_SCHEMA`, `mountVerificationRoutes(router)`, `startVerificationRuntime(env)`（返回 stop 函数）。Schema 由 migration4 创建。无 worker 时也可直接调用公开 service 函数做测试。运行器启动将原 queued/running 标 failed 并保留标识；每15秒检查计划。`env.node_role` / `nodeRole` 非 primary 不执行。

新增环境项 `verificationSmtpAllowCidrs: string[]`（配置名 `VERIFICATION_SMTP_ALLOW_CIDRS`，逗号分隔），默认 []；只允许 SMTP 显式 CIDR 例外，HTTP 始终禁止内网。运行 TLS 验证、DNS所有结果检查、连接地址钉扎。单 primary 进程部署；SQLite事务保证创建/每日认领/统计原子，不能据此宣称多实例 worker 安全。
