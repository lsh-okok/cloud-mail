# 192.168.31.112 / .113 常驻节点部署记录

日期：2026-11-13。主节点为 `192.168.31.111:3000`，邮箱域为 `cloudmail.test`。本次部署用于局域网收信和节点联调，没有对接 Outlook/iCloud。

## 访问与部署

| 角色 | 地址 | 状态 |
| --- | --- | --- |
| 主节点及管理后台 | <http://192.168.31.111:3000> | 保留原应用、收信服务和持久数据 |
| 只读节点 112 | <http://192.168.31.112:3001/health/ready> | 常驻部署，部署验收返回 200 |
| 只读节点 113 | <http://192.168.31.113:3001/health/ready> | 常驻部署，部署验收返回 200 |

主邮箱、子邮箱链接和节点状态统一在主节点管理。副本提供公开子邮箱页面及 JSON 读取：将主节点生成链接的地址来源替换为相应副本地址，保留完整路径和查询参数。不要在副本上登录或管理邮箱。

两台副本配置相同，身份及密钥分别独立：

| 项目 | 配置 |
| --- | --- |
| 部署目录 | `/home/enohaook/cloud-mail-replica` |
| 启动方式 | `docker run`；当前部署未使用 Compose |
| 容器 | `cloud-mail-replica` |
| 镜像 | `cloud-mail-app:lan-20261113-features` |
| 持久卷 | `cloud-mail-replica_data`，挂载到容器 `/data` |
| 重启策略 | `unless-stopped` |
| 监听 | 各自局域网 IP 的 `3001`，转发到容器 `3000` |
| 主节点地址 | `http://192.168.31.111:3000` |
| 私密配置 | 部署目录的 `node.env`，权限 600；每台独立的节点凭据、JWT 密钥和数据加密密钥 |

受控局域网 HTTP 使用 `NODE_ALLOW_INSECURE_HTTP=true`。副本使用独立数据卷，未复制主节点用户、邮件或来源凭据。配置及一次性凭据保存在受限文件内，本文不包含密钥。

应用镜像 config digest：`sha256:68bacaafd155affb216366c4b3ce69463b8219f644a9e729a7f37036771f821a`。Docker 29 OCI manifest digest：`sha256:44725e6a687e7988cfa2d2b98d278e1c80fac9321c28aff5e8292d7dbed697f9`；这两个摘要用于不同层级的核验。

## 联调结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 双节点就绪、在线状态及同步游标 | 通过 | `data/deployment-nodes-20261113/smoke.json`，`passed=true` |
| 链接创建与删除的增量同步 | 通过 | 创建后游标 15 → 17，删除后 17 → 19；删除链接在三台均返回 404 |
| 真实 SMTP/STARTTLS 收件隔离 | 通过 | 两封相同 To 头、不同信封地址邮件，在主节点及两台副本各自仅返回对应邮件 |
| 热缓存停用与恢复 | 通过 | 两台分别停用后公开读取 503，另一台继续读取；恢复后重新就绪 |
| 副本管理、旧登录及附件入口限制 | 通过 | 每台三项检查均返回 403 |
| 测试数据清理 | 通过 | 两条测试链接已删除，两封受控邮件已移除，两台常驻节点保留 |
| 两台容器重启与持久化 | 通过 | 重启前后游标均 19 → 19；数据库文件、投影摘要、同步状态和访问计数保留；无用户、邮件、来源凭据或原始链接 Token。本地报告已归档于 `evidence112/persistence.report.json`、`evidence113/persistence.report.json` |
| 112 到主节点的受控断网及恢复 | 通过 | `data/deployment-nodes-20261113/outage.json`，三个阶段均通过；缓存读取立即 503，约 17 秒后主节点显示 offline，约 125 秒后副本就绪返回 503；期间 113 与主节点持续 200。解除阻断后 112 公开读取恢复 200，临时链接已删除，两台最终 online/ready 且游标均为 21 |

副本保存读取所需的元数据，邮件由主节点中继。公开读取即使命中缓存也须向主节点复核权限，因此主节点连接中断时应立即停止公开读取；管理页在约 15 秒无心跳后显示离线，副本就绪检查在最后一次成功同步超过 120 秒后失效。就绪接口与公开读取的判定时点不同。

本次断网仅对 112 副本容器源地址 `172.17.0.2` 到 `192.168.31.111:3000` 设置窄范围 REJECT，未阻断副本公开 HTTP 或 SSH。测试规则已移除，`DOCKER-USER` 恢复为空，与测试前一致。

## 查看状态与重启

在每台副本服务器执行：

```sh
cd /home/enohaook/cloud-mail-replica
sudo docker ps --filter name=cloud-mail-replica
sudo docker inspect cloud-mail-replica --format '{{.State.Status}} {{.State.StartedAt}} {{.HostConfig.RestartPolicy.Name}}'
sudo docker logs --tail=100 cloud-mail-replica
```

从可访问局域网的电脑检查就绪：

```sh
curl --fail http://192.168.31.112:3001/health/ready
curl --fail http://192.168.31.113:3001/health/ready
```

常规重启使用 `sudo docker restart cloud-mail-replica`，随后检查就绪和主节点管理页的 `online`、`ready`、`cursor=primaryCursor`。`/api/health` 是存活检查，副本应以 `/health/ready` 判断能否接收公开读取。

重新创建容器时保留原 `node.env` 和 `cloud-mail-replica_data`，使用原节点身份及独立密钥；不要撤销节点或删除数据卷。部署配置以当前 `docker run` 参数为准。

## 复验与证据

在工作区执行真实收信联调：

```powershell
node data/deployment-nodes-20261113/validate.mjs smoke
```

脚本读取忽略目录中的管理员配置、节点配置与局域网证书，只创建本轮临时链接和邮件；最终恢复本轮停用状态、删除测试数据并复查同步。结果写入 `smoke.json`，不会删除常驻节点、容器或数据卷。

重启前后只读检查使用 `restart-persistence.mjs`。将该脚本放在当前操作目录，在每台副本上采集：

```sh
umask 077
sudo docker exec -i cloud-mail-replica node --input-type=module - capture < restart-persistence.mjs > before.json
sudo docker restart cloud-mail-replica
# 等待该节点 /health/ready 返回 200 后采集
sudo docker exec -i cloud-mail-replica node --input-type=module - capture < restart-persistence.mjs > after.json
```

下载安全证据后，在本地执行 `node restart-persistence.mjs verify before.json after.json`。两次采集间应避免主节点配置变更，以便严格比较相同游标的投影摘要。此工具不读取或输出实际密钥。

断网脚本分为 `outage.mjs prepare`、`during`、`finish`。准备阶段创建并预热本轮链接；操作人员只阻断 112 容器源 IP 到 `.111:3000` 的上游连接，并设置 240 秒自动解除；保持 112 的公开 HTTP 与 SSH 可达。`during` 检查即时公开读取失败、心跳离线及超过 120 秒的就绪失效，同时持续确认 113 正常。移除规则或自动解除后执行 `finish`，等待恢复并在 `finally` 删除本轮链接、验证删除同步。任何阶段失败后仍须执行恢复和 `finish`。

`outage.json` 为安全报告；`outage-state.json` 包含临时公开链接路径，应按私密文件保存，不要粘贴或提交。脚本不修改防火墙，也不撤销常驻节点。

## 已授权的服务清理

用户已明确授权清理 `.111/.112/.113` 上的无关服务。已移除旧 `email-cluster`、网关、WordPress、MySQL 及独角商城 Redis 容器和非 Cloud Mail 镜像；停用旧 `mail-lite`、MySQL、Redis、PureFTPd，另外停用 `.112/.113` 的 Nginx 和 `.111` 的 PHP、RuoYi、PostgreSQL。旧项目数据和配置保留，SSH、Docker、系统及宝塔面板保留。对 SysV 服务除禁用开机启动外，显式停止进程并复核监听端口。

`.113` 另清理约 352 MB 旧 journal 和两个旧无标签镜像。最终可用空间约为 `.111` 3.7 GB、`.112` 1.7 GB、`.113` 1019 MB。Cloud Mail 主节点数据卷及两台副本持久卷保留。

## 最终状态与备份

最终检查 `data/deployment-nodes-20261113/final-state.json` 为 `passed=true`：主节点就绪、管理员可登录，两台副本均 online/ready，游标均为 21，待同步事件均为 0。四个 Cloud Mail 容器最终均 healthy；保留的容器 ID 前缀为：

| 服务器 | 容器 | ID 前缀 |
| --- | --- | --- |
| 111 | `cloud-mail-app-1` | `cb33d876ec76` |
| 111 | `cloud-mail-mail-1` | `439692edfb76` |
| 112 | `cloud-mail-replica` | `445eda62274d` |
| 113 | `cloud-mail-replica` | `0d708783ad20` |

主节点一致备份位于 `/home/enohaook/cloud-mail/backups/post-cross-node-integration/`，含配置、SQLite/对象、邮件队列、日志及 DKIM 密钥，`COMPLETE` 文件已生成。两台副本各自备份位于 `/home/enohaook/cloud-mail-replica/backups/post-integration-20261113/`，含各自 `config.env` 和 `app/` 数据库/对象。备份目录权限为 700，配置权限为 600。每次备份停止对应服务，完成后恢复并复核就绪。

安全证据下载至本地 `data/deployment-nodes-20261113/evidence112/`、`evidence113/`，含重启前后证据、比较报告、运行镜像校验、容器持久卷/端口/重启策略、空间及备份位置。管理员密码、节点凭据及配置备份没有写入这些证据或本文。恢复时使用相应服务器的成对配置与数据库，保留副本身份及密钥。

## 2026-11-14 一键部署真实验收

使用112、113完成一键部署实测。原3001副本继续运行，在112临时启动独立主服务（最终使用host网络9000端口），并在两台服务器的13001端口执行实际生成的完整命令；使用新节点身份、独立容器和数据卷，未复用正式111的账号、配置或数据库。

两台服务器均无法解析registry/npm公网域名，因此本轮验证了新增的预构建镜像包路径：从隔离主服务下载约120MB镜像包，SHA-256校验、docker load、核验镜像ID并启动，均成功同步并就绪。源码冷构建未在这两台离线服务器执行。测试镜像ID为 `sha256:bbd73e8f1d773a9993c8a200bbaa74edd5004b1f1e6625fa3287c7ef8c842c5f`，构建后端与网页复用经核验的既有Linux运行依赖。

| 检查 | 结果 |
| --- | --- |
| 112、113完整一键命令 | 均成功；独立配置、卷、容器，online/ready均为true |
| 重复执行同一命令 | 容器ID与配置摘要不变，不重复导入镜像或创建容器 |
| 正常重启 | 两台均自动恢复就绪，投影配置和游标保留 |
| 增量同步与公开取信 | 临时主邮箱和收件链接同步，游标均为2且待同步0，公开读取正确返回空邮件列表 |
| 副本权限 | 管理与登录API均返回403 |
| 停用及恢复 | 113停用后就绪503，恢复后自动重连并就绪200 |
| 数据隔离 | 两台用户、邮件、来源密钥、原始链接Token行数均为0；仅有必要的主邮箱及链接投影 |
| 本地回归 | 前后端构建通过，后端257项测试全部通过 |

同机Docker端口回流及host网络13000端口被既有UFW策略阻断，测试主服务改用既有策略允许的9000端口后完成验证；未调整系统防火墙规则。

经用户授权，删除两台已停用的MySQL、Redis、Java安装目录，各释放约1.2GB；Redis配置/数据及MySQL支持配置先备份至各自 `/home/enohaook/cloud-mail-oneclick-20261114/legacy-runtime-configs.tar.gz`。原MySQL数据目录、旧项目数据、管理面板、SSH、Docker及Cloud Mail保留。

验收后临时链接、节点身份、测试主服务/副本容器及其数据卷、临时凭据均已清理。正式副本容器ID仍为112的 `445eda62274d` 和113的 `0d708783ad20`，3001均就绪；111主服务就绪。最终可用空间约112为2.8GB、113为2.3GB。

安全证据位于本机忽略目录 `data/node-oneclick-20261114/` 的 `real-status.json`、`integration.json`、`evidence112.json`、`evidence113.json` 和 `cleanup112.log`、`cleanup113.log`。112保留已验证的Cloud Mail候选镜像及同目录镜像发布包，供正式主节点后续更新；本轮未将新入口发布到正式111。
