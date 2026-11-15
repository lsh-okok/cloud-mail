# MX 节点管理与同步接口（v1）

管理接口挂载 `/api`，现有管理员 Authorization、CSRF 和 `{data: ...}` / `{error:{code,message,requestId}}` 约定继续适用。仅 primary 提供。时间为 ISO 字符串或 null。

| 方法与路径 | 请求 | data |
| --- | --- | --- |
| GET `/api/admin/nodes` | page=1,pageSize=20（最多100） | `{items,total,page,pageSize,summary:{total,online,ready,primaryCursor}}`，summary.total 为未撤销数，total 为含撤销记录数 |
| GET `/api/admin/nodes/deployment-options` | 无 | `{primaryUrl,bundleAvailable:true,bundleFormat:'registry-image',imageRef}`；imageRef固定为ghcr.io/lsh-okok/cloud-mail:main |
| POST `/api/admin/nodes` | `{name,deployment?:{primaryUrl?,port?,allowInsecureHttp?}}`，name trim后1～80字符 | HTTP201 `{node,credential,connection:{filename,env},deployment?:{command,localCommand,installerUrl,script,filename,expiresAt,format,imageRef,primaryUrl,port,allowInsecureHttp}}`，credential仅此次显示 |
| PUT `/api/admin/nodes/:id/status` | `{disabled:boolean}` | Node DTO；启停幂等，已撤销409 |
| DELETE `/api/admin/nodes/:id` | 无body | Node DTO；永久撤销，重复撤销幂等 |
| DELETE `/api/admin/nodes/:id/record` | 无body | `{deleted:true,id}`；仅已撤销可删，否则409 |

Node DTO：`{id,name,disabled,revoked,status,online,ready,ip,publicIp,reportedIp,connectionIp,lastHeartbeatAt,lastSyncAt,cursor,primaryCursor,pendingEvents,snapshot:{completed,total,percent},lastError,createdAt,updatedAt}`。`publicIp` 优先使用节点上报的有效公网地址，其次使用本身为公网的连接来源；没有时为 null。`reportedIp` 与主节点观测的 `connectionIp` 独立保存，旧 `ip` 字段保留兼容。页面仅将 `publicIp` 显示为公网 IP，不将 Docker 网桥或私网地址冒充公网。

status枚举/优先级：`revoked`→`disabled`→`initializing`（首次未就绪）→`online`→`offline`。online要求最近成功心跳<=15秒且当前未停用/撤销；ready要求节点上报已追平，cursor>=primaryCursor且心跳未过期。启用会清除最近心跳与ready，等真实新心跳。节点可能online但尚未ready，UI需分别展示。

connection.filename=`cloud-mail-node-<id>.env`；env含NODE_ROLE=replica、NODE_PRIMARY_URL（保留主部署前缀）、NODE_ID、NODE_CREDENTIAL、NODE_ALLOW_INSECURE_HTTP（默认false）、NODE_UPSTREAM_TIMEOUT=15000、APP_URL、空APP_BASE_PATH、独立DATA_DIR/JWT_SECRET/DATA_ENCRYPTION_KEY，**不含主管理员密码/主JWT/主加密密钥**。保存一次性接入配置的动作仅在创建成功弹窗提供。

一键部署时传deployment（空对象使用主站地址及3001端口）。HTTP必须显式allowInsecureHttp=true；不接受回环、未指定地址、URL账号/查询参数/片段和无效端口。输入无效时不会创建节点。部署命令固定使用GitHub main最新成功构建的官方镜像，不读取主节点本地源码包或镜像归档。未传deployment继续支持原手动接入接口。

installerUrl固定指向GitHub的通用`cloud-mail-node/install-node.sh`。command采用清晰的`curl ... -o install-node.sh && sh install-node.sh ...`形式，完整下载此脚本后传入`--primary-url`、`--install-token`、`--port`，HTTP时添加`--allow-insecure-http`，下载失败不执行；localCommand保留兼容，对已下载的`install-node.sh`传相同参数。旧script/install.sh仅保留调用通用脚本的短包装器，不再内嵌完整配置和安装逻辑。

GET `/api/node-install/:token/config.env`返回独立connection.env并追加`INSTALL_PORT`、`INSTALL_IMAGE_REF=ghcr.io/lsh-okok/cloud-mail:main`。不再提供`/bundle`下载接口。token为独立随机短期下载权限，内存仅按摘要索引；不需要管理会话，响应全部no-store。有效期1小时，主服务重启、停用/撤销后失效；恢复接入不恢复旧下载权限。不存在或过期token返回410，副本拒绝。

脚本需要Linux、curl或wget和root/sudo权限；目标服务器须访问GitHub、GHCR和主节点。自动安装Docker和必要工具，新安装拉取官方main镜像并解析、保存固定RepoDigest、image ID和revision，随后按digest启动独立节点容器/数据卷。配置权限600、自动重启。重复执行校验已有配置、容器身份、端口及已记录镜像，不随main移动自动升级，冲突时拒绝覆盖并保留密钥和数据；等待/health/ready最多180秒，未就绪返回非零并保留服务供排查。前端以5秒管理轮询显示真实连接/同步/就绪状态。

节点管理的「新增节点」始终提交deployment参数，创建成功后仅展示包含下载与执行的完整command及复制按钮，不再提供需要先下载脚本的分支页签。通用脚本只凭参数从主节点获取该节点配置，不需要用户另备node.env或安装包。首次安装受上述短时下载权限约束；页面显示参数有效期，已过期或当前停用/撤销时禁用新安装命令的复制。凭据与带参数命令只在创建结果窗口内存中保留，关闭后清除，不写本地持久存储。

内部协议挂 `/api/internal`（主URL已有部署前缀）；认证头 `Authorization: Bearer <credential>`、`X-Node-Id: <id>`，不接受管理JWT。仅primary提供，敏感响应no-store。

- POST `/api/internal/snapshot` `{}` → `{sessionId,cursor,total,pageSize:1000,pages,expiresAt}` 固定快照。
- GET `/api/internal/snapshot/:sessionId?page=0` → `{sessionId,cursor,total,page,pageSize,items,nextPage}` items=`{type,id,revision,data}`，type为mailbox/platform/link/settings；完整快照密文落SQLite，15分钟有效且绑定节点/主进程。
- GET `/api/internal/events?after=0` → `{after,events:[{cursor,type,id,revision,data}],cursor,primaryCursor,hasMore}`，最多500，连续游标；过旧/缺口409 `SNAPSHOT_REQUIRED`。
- POST `/api/internal/heartbeat` `{cursor,ready,snapshotCompleted,snapshotTotal,lastError,publicIp?}` → `{primaryCursor,ready,nodeId,publicIpReporting:true}`；状态在事务中再次鉴权/CAS。子节点首次使用旧请求格式，收到 `publicIpReporting:true` 后才附带公网地址，兼容不接受新字段的旧主节点。公网地址须为有效的公网 IPv4/IPv6；缺省保留此前上报值，null 显式清除。自报地址仅用于展示，不参与认证、审计、限流或反向代理信任判断。
- POST `/api/internal/mx/read` `{linkId,recipient,platformId,fingerprint,order,limit,validateOnly}` → `{messages}`，只读重新构建主节点真实链接策略，完整收件人和指纹必须一致；缓存/分页返回前也validateOnly。

子节点runtime每5秒同步，快照staging/分页进度持久化，完整后事务原子安装并补齐连续事件，通过主节点心跳确认才ready；重启一律先未ready。明确401/403立即未ready，网络失败最多沿用120秒；MX读取仍依赖主节点，失联无法凭旧缓存绕过最终复核。

子节点独立后台通过固定 HTTPS 公网地址服务探测公网出口 IP，成功缓存10分钟刷新，失败60秒重试并保留最近成功结果；每个请求最多3秒、响应最多128字节，不跟随重定向，不发送节点接入凭据。探测不阻塞同步、心跳、就绪或关闭，部署无需修改 NPM。`NODE_PUBLIC_IP` 可选地固定一个合法公网地址；默认自动获取。单独的 `node_public_ip_fetch` 仅供测试注入，与主同步的 `node_fetch` 分离。

集成：`NODE_SCHEMA`加入下一次迁移；`mountNodeRoutes(router)`在admin兜底前调用；`startNodeRuntime(env)`返回异步stop函数，额外挂`stop.tick()`供确定性运维/测试；env需`node_role,node_primary_url,node_id,node_credential,node_allow_insecure_http,node_upstream_timeout`以及独立`secretVault,db,publicMailState,mailSourceState`。replica不bootstrapAdmin/不启动SMTP/LMTP/维护任务。
