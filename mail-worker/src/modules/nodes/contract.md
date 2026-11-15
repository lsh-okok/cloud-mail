# MX 节点管理与同步接口（v1）

管理接口挂载 `/api`，现有管理员 Authorization、CSRF 和 `{data: ...}` / `{error:{code,message,requestId}}` 约定继续适用。仅 primary 提供。时间为 ISO 字符串或 null。

| 方法与路径 | 请求 | data |
| --- | --- | --- |
| GET `/api/admin/nodes` | page=1,pageSize=20（最多100） | `{items,total,page,pageSize,summary:{total,online,ready,primaryCursor}}`，summary.total 为未撤销数，total 为含撤销记录数 |
| GET `/api/admin/nodes/deployment-options` | 无 | `{primaryUrl,bundleAvailable,bundleFormat}`；bundleFormat为source或docker-image |
| POST `/api/admin/nodes` | `{name,deployment?:{primaryUrl?,port?,allowInsecureHttp?}}`，name trim后1～80字符 | HTTP201 `{node,credential,connection:{filename,env},deployment?:{command,localCommand,installerUrl,script,filename,expiresAt,format,primaryUrl,port,allowInsecureHttp}}`，credential仅此次显示 |
| PUT `/api/admin/nodes/:id/status` | `{disabled:boolean}` | Node DTO；启停幂等，已撤销409 |
| DELETE `/api/admin/nodes/:id` | 无body | Node DTO；永久撤销，重复撤销幂等 |
| DELETE `/api/admin/nodes/:id/record` | 无body | `{deleted:true,id}`；仅已撤销可删，否则409 |

Node DTO：`{id,name,disabled,revoked,status,online,ready,ip,lastHeartbeatAt,lastSyncAt,cursor,primaryCursor,pendingEvents,snapshot:{completed,total,percent},lastError,createdAt,updatedAt}`。

status枚举/优先级：`revoked`→`disabled`→`initializing`（首次未就绪）→`online`→`offline`。online要求最近成功心跳<=15秒且当前未停用/撤销；ready要求节点上报已追平，cursor>=primaryCursor且心跳未过期。启用会清除最近心跳与ready，等真实新心跳。节点可能online但尚未ready，UI需分别展示。

connection.filename=`cloud-mail-node-<id>.env`；env含NODE_ROLE=replica、NODE_PRIMARY_URL（保留主部署前缀）、NODE_ID、NODE_CREDENTIAL、NODE_ALLOW_INSECURE_HTTP（默认false）、NODE_UPSTREAM_TIMEOUT=15000、APP_URL、空APP_BASE_PATH、独立DATA_DIR/JWT_SECRET/DATA_ENCRYPTION_KEY，**不含主管理员密码/主JWT/主加密密钥**。保存一次性接入配置的动作仅在创建成功弹窗提供。

一键部署时传deployment（空对象使用主站地址及3001端口）。HTTP必须显式allowInsecureHttp=true；不接受回环、未指定地址、URL账号/查询参数/片段和无效端口。安装包缺失或输入无效时不会创建节点。未传deployment继续支持原手动接入接口。

installerUrl固定指向GitHub的通用`cloud-mail-node/install-node.sh`。command采用清晰的`curl ... -o install-node.sh && sh install-node.sh ...`形式，完整下载此脚本后传入`--primary-url`、`--install-token`、`--port`，HTTP时添加`--allow-insecure-http`，下载失败不执行；localCommand保留兼容，对已下载的`install-node.sh`传相同参数。旧script/install.sh仅保留调用通用脚本的短包装器，不再内嵌完整配置和安装逻辑。

GET `/api/node-install/:token/config.env`返回独立connection.env并追加`INSTALL_PORT`、`INSTALL_BUNDLE_SHA256`、`INSTALL_BUNDLE_IMAGE_ID`（源码模式为空）；GET `/api/node-install/:token/bundle`返回固定SHA-256对应的源码tar.gz或预构建镜像归档。token为独立随机短期下载权限，内存仅按摘要索引；不需要管理会话，响应全部no-store。有效期1小时，主服务重启、停用/撤销或部署包变化后失效；恢复接入不恢复旧下载权限。不存在或过期token返回410，副本拒绝。源码包由构建时白名单生成，不包含.env、节点配置、数据库、Git或node_modules。

脚本需要Linux、curl或wget和root/sudo权限；自动安装Docker和必要工具，校验下载包后本机构建镜像，使用独立节点容器/数据卷、600权限配置与自动重启。重复执行校验已有配置、容器身份和端口，预构建模式还核对容器及本地tag的镜像ID，冲突时拒绝覆盖，保留密钥和数据；等待/health/ready最多180秒，未就绪返回非零并保留服务供排查。前端以5秒管理轮询显示真实连接/同步/就绪状态。

节点管理的「新增节点」始终提交deployment参数，创建成功后仅展示包含下载与执行的完整command及复制按钮，不再提供需要先下载脚本的分支页签。通用脚本只凭参数从主节点获取该节点配置，不需要用户另备node.env或安装包。首次安装受上述短时下载权限约束；页面显示参数有效期，已过期或当前停用/撤销时禁用新安装命令的复制。凭据与带参数命令只在创建结果窗口内存中保留，关闭后清除，不写本地持久存储。

可选NODE_DEPLOYMENT_IMAGE_DIR只读挂载目录提供node-image.tar.gz及node-image.json（format=docker-image、imageId为完整sha256镜像ID、sha256为压缩包摘要）。配置后优先使用该包，元数据或摘要不符时拒绝创建，不退回源码。安装器校验后docker load，再检查预期镜像ID并打节点专用tag，不访问镜像源或npm；Docker与工具已安装时可在离线局域网部署。镜像须与主版本及目标CPU架构匹配，由docker/export-node-image.sh从构建镜像导出，不从运行容器或数据卷制作。

内部协议挂 `/api/internal`（主URL已有部署前缀）；认证头 `Authorization: Bearer <credential>`、`X-Node-Id: <id>`，不接受管理JWT。仅primary提供，敏感响应no-store。

- POST `/api/internal/snapshot` `{}` → `{sessionId,cursor,total,pageSize:1000,pages,expiresAt}` 固定快照。
- GET `/api/internal/snapshot/:sessionId?page=0` → `{sessionId,cursor,total,page,pageSize,items,nextPage}` items=`{type,id,revision,data}`，type为mailbox/platform/link/settings；完整快照密文落SQLite，15分钟有效且绑定节点/主进程。
- GET `/api/internal/events?after=0` → `{after,events:[{cursor,type,id,revision,data}],cursor,primaryCursor,hasMore}`，最多500，连续游标；过旧/缺口409 `SNAPSHOT_REQUIRED`。
- POST `/api/internal/heartbeat` `{cursor,ready,snapshotCompleted,snapshotTotal,lastError}` → `{primaryCursor,ready,nodeId}`，primary观测IP；状态在事务中再次鉴权/CAS。
- POST `/api/internal/mx/read` `{linkId,recipient,platformId,fingerprint,order,limit,validateOnly}` → `{messages}`，只读重新构建主节点真实链接策略，完整收件人和指纹必须一致；缓存/分页返回前也validateOnly。

子节点runtime每5秒同步，快照staging/分页进度持久化，完整后事务原子安装并补齐连续事件，通过主节点心跳确认才ready；重启一律先未ready。明确401/403立即未ready，网络失败最多沿用120秒；MX读取仍依赖主节点，失联无法凭旧缓存绕过最终复核。

集成：`NODE_SCHEMA`加入下一次迁移；`mountNodeRoutes(router)`在admin兜底前调用；`startNodeRuntime(env)`返回异步stop函数，额外挂`stop.tick()`供确定性运维/测试；env需`node_role,node_primary_url,node_id,node_credential,node_allow_insecure_http,node_upstream_timeout`以及独立`secretVault,db,publicMailState,mailSourceState`。replica不bootstrapAdmin/不启动SMTP/LMTP/维护任务。
