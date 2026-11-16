# Linux 服务器部署

此版本在自己的 Linux 服务器使用同一个镜像、同一个容器运行 Node.js、Postfix 和 OpenDKIM，不需要 Cloudflare Workers、D1、KV、R2 或 Resend。Node.js 提供网页/API、SQLite、附件文件、LMTP 收件和收件人策略；Postfix 负责公网 SMTP 收件、MX 直投和重试，OpenDKIM 签名。Nginx Proxy Manager（NPM）继续管理网页 HTTPS 和证书。

```text
浏览器 ── HTTPS ── NPM ── HTTP:3000 ── app 容器 / Node.js ── SQLite / 附件卷
外部邮箱 ── SMTP:25 ── app 容器 / Postfix + OpenDKIM ── MX:25 ── 外部邮箱
                         │
                         └─ 同容器回环接口：SMTP 587、LMTP 2525、策略 10040、域名查询 10041
NPM 证书目录 ── 只读挂载 ── app 容器 / Postfix STARTTLS
```

邮件服务只有端口 25 发布到宿主机。587、2525、10040、10041 仅绑定同一容器内的回环地址，不发布到宿主机，也不供相邻容器访问；公网 25 无论来源地址都执行 `reject_unauth_destination`。本项目提供网页邮箱/API，不提供 IMAP 或 POP3 服务。

邮箱后缀支持在[后台「邮箱域名」](mail-domains.md)管理，保存后立即用于创建邮箱。完整 MX 部署通过容器内 `10041` socketmap 实时查询收件域名。DNS 与新域名的 DKIM 签名仍需单独配置。镜像默认 `MAIL_ENABLED=false`，用于管理主节点和只读副本；本仓库完整邮件 Compose 默认 `MAIL_ENABLED=true`，启动 Node.js 与邮件进程并检查它们的健康状态。

## 一键安装管理主节点

在新的 Linux amd64（x86_64）服务器可先使用公共安装脚本部署管理主节点，随后在「节点管理」中新增只读节点：

```sh
curl -fsSL https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-primary/install-primary.sh -o install-primary.sh && bash install-primary.sh
```

GitHub Actions 在 `main` 通过后端测试、前后端构建、部署检查和 Docker 收发演练后，发布 `ghcr.io/lsh-okok/cloud-mail:main`、`ghcr.io/lsh-okok/cloud-mail:latest` 以及 `ghcr.io/lsh-okok/cloud-mail:sha-<完整40位提交号>`。当前发布平台为 `linux/amd64`。`main` 和 `latest` 指向同一个最新成功发布的版本，尚在构建或检查失败的提交不会替换它们；镜像附带 GitHub 来源与提交记录。

脚本自动安装 Docker 和必要工具，默认从 GHCR 拉取 `main` 镜像，解析并记录不可变的仓库摘要后按摘要启动；不在服务器编译。脚本生成独立管理员密码、JWT 与数据加密密钥，使用持久数据卷启动。默认目录 `/opt/cloud-mail-primary`、容器名 `cloud-mail-primary`、端口3000，完成后打印访问地址、管理员邮箱、初始密码、镜像摘要与 GitHub 提交。可用 `--host` 指定访问IP，`--port`、`--dir`、`--name` 指定独立实例，`--mail-domain` 和 `--admin-email` 修改邮箱域及管理员邮箱。`--image` 只接受官方仓库的 `main`、`sha-<完整提交号>` 或 `@sha256:<摘要>`，始终从 GHCR 拉取。

此安装提供管理页面、主邮箱来源、链接、验证任务和只读节点管理，显式设置 `MAIL_ENABLED=false`，不运行镜像中的 Postfix/OpenDKIM，MX 收发尚未启用。完整公网收发需要按下文启用同容器邮件服务、配置域名 DNS、TLS 证书与 TCP25。服务器需访问 GitHub、GHCR；自动安装 Docker/工具时还需系统软件源。不再支持本地源码、固定源码包或离线镜像回退，拉取失败就停止，不使用缓存旧镜像。

同一安装重复运行只启动原容器，保留原镜像、配置与数据，不执行升级；已有源码版安装也不会被自动转换。不同参数、同名外部容器或已有其他数据卷会拒绝覆盖。请保管安装目录中的配置、`.install-state` 版本记录以及数据卷备份。本脚本位于本项目的 `docker/install-primary.sh`，公共发布路径为 `ok-email-scripts/cloud-mail-primary/install-primary.sh`。

尚未启用邮件的管理安装需要清空旧数据重新部署时，在同一脚本添加 `--reinstall`：

```sh
curl -fsSL https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-primary/install-primary.sh -o install-primary.sh && bash install-primary.sh --reinstall --host mail.example.com --app-url https://mail.example.com --mail-domain example.com --admin-email admin@example.com
```

`--reinstall` 会永久删除该实例的账号、邮箱、邮件和配置，不执行备份；生成新的管理员密码和密钥。脚本先验证安装记录、容器和数据卷的归属，拉取并校验新镜像后才停止旧容器、删除该实例的数据卷并安装。未指定的站点地址、邮箱域和端口沿用安装记录，可通过参数覆盖。手动更新时遗漏容器标签的官方镜像，只要仍挂载原有且身份匹配的数据卷，也可重装。其他容器、数据卷及安装目录中的其他文件保持原样。普通安装不带 `--reinstall`，继续保留已有数据。

已经启用同容器邮件或仍有关联旧邮件网关时，脚本拒绝这种只清理管理数据的重装。请先备份整套应用、队列、日志和 DKIM，再按完整恢复流程处理；邮件合并或升级不使用 `--reinstall`。

## 为管理主节点启用同容器邮件服务

先备份现有账号、邮件、附件、配置和密钥；已有独立邮件容器时还要备份队列、日志及 DKIM 卷。在 NPM 为邮件主机名（例如 `mx.example.com`）申请有效的 Let's Encrypt 证书，然后在安装主机执行：

计划公网收发时，首次管理安装请使用真实邮箱域，例如 `--mail-domain example.com --admin-email admin@example.com`；此时 `MAIL_HOST` 为 `mx.example.com`。默认 `cloudmail.test` 仅用于管理测试。启用脚本会按现有 `MAIL_HOST` 校验证书，不会通过 `--cert-name` 改变邮件主机名；不要直接将示例证书用于仍使用默认测试域的实例。

```sh
curl -fsSL https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-primary/enable-mail.sh -o /tmp/enable-mail.sh && bash /tmp/enable-mail.sh --npm-container npm
```

脚本读取现有安装记录和应用的 `MAIL_HOST`、`MAIL_DOMAINS`，从 NPM 容器的 `/etc/letsencrypt` 挂载自动选择覆盖邮件主机名的有效证书。首次启用或从旧版 app/邮件网关迁移时，从 GHCR 拉取统一 `ghcr.io/lsh-okok/cloud-mail:main` 镜像，核对来源、邮件能力、提交与摘要，再用同一个原容器名重建主节点并设置 `MAIL_ENABLED=true`；服务器无需编译。网页端口、原网络与别名、账号及应用数据保留，原邮件队列、DKIM 和日志卷接入同一容器，证书只读挂载。邮件只发布 IPv4 TCP 25，587、2525、10040、10041 仅在容器回环地址监听；无需另建邮件网关，也可直接读取日志更新发信投递状态。

默认应用目录为 `/opt/cloud-mail-primary`。自定义位置可加 `--dir`；NPM 容器不是 `npm` 时修改 `--npm-container`。也可用 `--cert-root /实际/letsencrypt目录 --cert-name npm-1` 指定证书，或用 `--image` 指定官方 `sha-<完整提交号>`、`@sha256:<摘要>`；不需要 `--upgrade` 参数。脚本仅支持本机 Unix socket Docker，需要 curl，但不要求宿主机安装 Node.js。它会拒绝接管不属于当前安装的网络、容器和卷。完成后按域名输出 Cloudflare TXT 的名称及完整单行内容，自动合并公钥片段并移除 DNS 文件中的引号、括号和注释，可直接粘贴。按下方 DNS 和收发步骤验证后，再投入使用。

迁移时原容器临时保留为 `<容器名>-before-unified`；旧独立邮件容器临时保留为 `<容器名>-mail-before-unified`。新容器创建、启动或就绪失败时，脚本先停止新容器，再恢复旧容器名和网络并启动原服务；自动恢复失败会保留迁移目录并打印人工恢复提示。健康检查成功后移除这些旧停止容器，保留全部数据卷。此机制恢复容器配置，不替代数据备份，也不保证未来版本的数据库可以由旧程序读取。

原 `primary.env` 保持不变，完整生效环境另存为安装目录的 `mail.env`，`.install-state` 更新为格式 3 并记录镜像与配置摘要。请将这些文件连同数据备份妥善保管，避免手工改写安装记录。已合并实例重复执行时只校验原配置、镜像记录和健康状态，不拉取、不重建，也不随 `main` 更新而升级。

已启用收信时，用以下命令重新查看可直接粘贴的 DKIM 记录。此模式只读取公钥，无需查找 NPM 证书，不拉取镜像或重启服务，也不会更换密钥：

```sh
curl -fsSL https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-primary/enable-mail.sh -o /tmp/enable-mail.sh && bash /tmp/enable-mail.sh --show-dkim
```

例如邮箱域为 `example.com`，在 Cloudflare 的 `example.com` DNS 中添加类型 `TXT`、名称 `mail._domainkey`，将脚本“内容”下方整行粘贴到内容框。多域名逐个添加；自定义安装目录继续带上 `--dir`。

## 1. 准备服务器与域名

需要 Docker Engine、Docker Compose v2、一个已运行的 NPM、固定公网 IPv4，以及域名 DNS 管理权限。服务器厂商必须允许**入站和出站 TCP 25**；Web 端口 80/443 继续由 NPM 使用。防火墙开放入站 25，不开放 3000、2525、10040、10041 或 587。当前 MTA 默认仅使用 IPv4。

以下示例使用：

| 用途 | 示例 |
| --- | --- |
| 网页邮箱 | `mail.example.com` |
| SMTP 主机名 / PTR | `mx.example.com` |
| 用户邮箱域 | `example.com` |
| 服务器公网 IPv4 | `203.0.113.10`（请替换） |

SMTP 主机名要直接解析到服务器，不能经过 HTTP/CDN 代理。NPM 的 HTTP 反向代理不代理 SMTP。

## 2. 确定 NPM 网络和证书

查看已有 NPM 的容器、网络和挂载路径：

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker inspect NPM容器名 --format '{{json .NetworkSettings.Networks}}'
docker inspect NPM容器名 --format '{{json .Mounts}}'
```

在 NPM 申请包含 `mx.example.com` 的有效证书；网页域名也需要有效证书，可用同一张多域名证书。将 NPM 容器内的**整个 `/etc/letsencrypt`** 目录所对应的宿主机路径填入 `NPM_CERT_ROOT`。必须包含 `live/` 和 `archive/`，因为 `live/` 下通常是指向 `archive/` 的符号链接。

找到证书编号，例如 NPM 的 `live/npm-1/`，对应填写：

```dotenv
NPM_NETWORK=nginx-proxy-manager_default
NPM_CERT_ROOT=/opt/nginx-proxy-manager/letsencrypt
SMTP_TLS_CERT_FILE=/certs/live/npm-1/fullchain.pem
SMTP_TLS_KEY_FILE=/certs/live/npm-1/privkey.pem
```

`/certs` 是 app 容器里的只读挂载路径；不要把宿主机路径填到两个 `SMTP_TLS_*_FILE` 变量里。启用邮件时，容器每 30 秒检查证书内容，NPM 续期后自动执行 `postfix reload`。启动时会验证证书有效期及密钥匹配；首次启动前证书必须已经存在。`MAIL_ENABLED=false` 时不启动邮件进程，也不要求证书。

## 3. 配置与启动

```sh
git clone https://github.com/lsh-okok/cloud-mail.git
cd cloud-mail
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

编辑 `.env`：替换域名、管理员初始密码、随机 `JWT_SECRET` 和 `DATA_ENCRYPTION_KEY`、NPM 网络和证书路径。完整邮件 Compose 会为 app 设置 `MAIL_ENABLED=true`。`ADMIN_EMAIL` 必须属于 `MAIL_DOMAINS`；多个邮箱域用逗号分隔。`MAIL_NETWORK_SUBNET` 仅保留旧 Compose 网络兼容，仍不得与服务器、VPN 或现有 Docker 网络重叠；它不赋予 SMTP 中继权限。管理员密码用于首次初始化，后续通过管理界面修改密码。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app
```

首次构建会安装 Node.js 24、pnpm 11 和应用依赖，前端构建到 `mail-worker/dist`，Node 后端构建到 `mail-worker/server-dist`。统一入口初始化权限和邮件配置，再由进程管理器运行 Node.js、Postfix、OpenDKIM 与维护进程；Node.js 使用非 root 的 `node` 用户。Compose 只有 `app` 一个服务，挂载 `app_data`、`mail_spool`、`mail_logs`、`dkim_keys` 四个原有持久卷。容器默认使用 UTC，以统一每日配额和统计日期；网页会按浏览器本地时区显示时间。

以上完整 MX Compose 流程可手工从源码构建统一镜像，默认本地标签为 `cloud-mail-app:local`。若改用 GitHub 发布的统一镜像，先拉取并查看仓库摘要：

```sh
docker pull ghcr.io/lsh-okok/cloud-mail:main
docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ghcr.io/lsh-okok/cloud-mail:main
```

把输出的官方 `ghcr.io/lsh-okok/cloud-mail@sha256:…` 完整摘要写入 `compose.registry.yml`，例如：

```yaml
services:
  app:
    image: ghcr.io/lsh-okok/cloud-mail@sha256:替换为刚拉取版本的64位摘要
```

以下命令在保留原卷、网络与配置的基础上使用指定统一镜像：

```sh
docker compose -f docker-compose.yml -f compose.registry.yml config --quiet
docker compose -f docker-compose.yml -f compose.registry.yml up -d --no-build
docker compose -f docker-compose.yml -f compose.registry.yml ps
```

后续操作始终带上相同的覆盖文件。`--no-build` 必须保留：基础 Compose 仍含 `build` 配置，不能对这个镜像覆盖组合运行 `up --build` 或 `build app`，否则会尝试用本地源码构建指定的官方镜像引用。官方镜像与源码本地标签应分别保管；不要仅修改标签就认定已更新。发布镜像的前端使用根路径；需要编译期站点子路径时继续使用上面的手工源码构建流程。此版本只发布 `main`、`latest`、`sha-…` 统一镜像，不再依赖 `mta-main` 等独立邮件镜像。


在 NPM 新建 Proxy Host：

| NPM 字段 | 值 |
| --- | --- |
| Domain Names | `mail.example.com` |
| Scheme | `http` |
| Forward Hostname | `cloud-mail-app` |
| Forward Port | `3000` |
| SSL | 选择网页域名证书，启用 Force SSL |

NPM 和 app 必须连接到 `.env` 配置的同一个 `NPM_NETWORK`。附件默认最大邮件总量为 25 MiB；如要发大附件，NPM 的 `client_max_body_size` 也要相应增加，并同步调整 `MAX_MESSAGE_BYTES`。MIME/Base64 编码会使附件占用大于原文件体积。

### 节点公网 IP

新版子节点自动获取公网出口 IP，随已认证的心跳上报，节点管理直接显示「公网 IP」。查看该地址无需修改 NPM、Docker 网络或安装参数。探测在后台执行，失败不影响同步与取信，并会自动重试；尚无有效公网地址时显示「暂未获取」，不会把 `172.17.0.1` 等网桥地址显示为公网 IP。

主节点另行保留实际连接来源地址。节点自报地址仅用于展示，不用于认证、访问控制、审计或限流；转发头仍按现有 `TRUSTED_PROXIES` 边界处理。新旧主节点会协商是否支持公网 IP 上报，旧版不会因收到未知心跳字段而中断同步。已有部署须更新主、子节点应用版本才能启用自动上报，重复执行安装脚本不会自动升级已有容器。

健康检查：

```sh
curl -fsS https://mail.example.com/api/health
docker compose exec -T app cloud-mail-healthcheck
docker compose exec -T app supervisorctl status
docker compose exec -T app postfix status
docker compose exec -T app postqueue -p
```

## 4. DNS、PTR、SPF、DKIM、DMARC

为每个邮箱域配置以下记录，替换示例 IP：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| A | `mx.example.com` | `203.0.113.10` |
| A | `mail.example.com` | `203.0.113.10` |
| MX | `example.com` | 优先级 `10`，目标 `mx.example.com` |
| TXT | `example.com` | `v=spf1 mx ip4:203.0.113.10 -all` |
| TXT | `_dmarc.example.com` | `v=DMARC1; p=none; rua=mailto:postmaster@example.com` |

在服务器提供商控制台设置公网 IP 的 **PTR 为 `mx.example.com`**。确认 `mx.example.com` 的 A 记录又指回同一个 IP，使 SMTP EHLO、PTR 和正向解析一致。已有 SPF 记录时合并为单条记录；不要创建多个 `v=spf1`。DMARC 报告地址需要真实可收信，确认投递和对齐后再按自己的策略改成 `quarantine` 或 `reject`。

首次启动会为 `MAIL_DOMAINS` 中的每个域生成独立 2048 位 DKIM 密钥，默认 selector 为 `mail`。读取**公钥** DNS 记录：

```sh
docker compose exec -T app cat /etc/opendkim/keys/example.com/mail.txt
```

将输出中的 TXT 内容按 DNS 服务商界面要求合并，添加到 `mail._domainkey.example.com`。多域名逐个添加；不要公开或复制 `.private` 文件。持久卷会保留私钥，重建容器不换 key。更换 selector 时先发布新公钥，再更新 `DKIM_SELECTOR` 并重建 app 容器。

验证 DNS 和 DKIM：

```sh
dig +short MX example.com
dig +short A mx.example.com
dig +short -x 203.0.113.10
dig +short TXT example.com
dig +short TXT mail._domainkey.example.com
dig +short TXT _dmarc.example.com
docker compose exec -T app opendkim-testkey -d example.com -s mail -vvv
```

不要在邮件主机发布未经配置的 AAAA 记录。本配置不绑定 IPv6 SMTP；需要 IPv6 时还必须配置对应 PTR、SPF、网络和 Postfix `inet_protocols`。

## 5. 验证收发和拒绝中继

从**另一台外部机器**验证 STARTTLS 和证书名称：

```sh
openssl s_client -starttls smtp -connect mx.example.com:25 \
  -servername mx.example.com -verify_hostname mx.example.com -verify_return_error </dev/null
```

用已有外部邮箱给新建用户发纯文本、HTML 和带附件邮件，确认收件箱、原正文与附件下载。再从网页邮箱向外部邮箱发送、回复、转发、CC/BCC 和分开发送；在外部服务商的“显示原始邮件”中确认 SPF、DKIM、DMARC 均通过。应用显示的“已发送”状态应在 Postfix 完成下游 SMTP 接受后更新；临时故障保留在队列中重试，永久拒绝显示失败/退信。SMTP 的 `250` 表示对方服务器接受，不代表对方用户已经阅读。

安装 `swaks` 后，从外部机器验证公网不能转发到其他域：

```sh
swaks --server mx.example.com --port 25 --from probe@external.example \
  --to nobody@another-external.example --quit-after RCPT
```

应收到 `Relay access denied`。再向本地域不存在的地址测试，关闭“无人收件/接收未注册地址”功能时应返回 550；有效地址应通过 RCPT。维护时可用 `docker compose exec -T app supervisorctl stop app` 仅停止 Node.js，SMTP 仍可连接且本地 RCPT 临时返回 451；完成后用 `docker compose exec -T app supervisorctl start app` 恢复并确认健康。`docker compose stop app` 会停止整个容器并关闭 SMTP 25，已接受的邮件保存在持久队列，启动后继续投递。

检查队列和日志：

```sh
docker compose exec -T app postqueue -p
docker compose logs --tail=200 app
```

Postfix 与 Node.js 在同一容器内使用持久卷中的日志更新投递状态。默认单日志到 100 MiB 轮转，保留 7 份未压缩日志，以便 app 在轮转后继续读取尚未处理的投递结果；参数为 `MAIL_LOG_MAX_BYTES`、`MAIL_LOG_KEEP`。日志中包含邮件地址，应和邮件数据一起备份并限制访问。

## 6. 备份、恢复与升级

提交邮件后连接中断时，应用会保留“不确定”状态，先根据 Postfix 日志对账，避免自动重复发信。可以从邮件的 `deliveries[].deliveryId` 获取任务标识并查询：

```sh
docker compose exec -T app node mail-worker/server-dist/cli.cjs mail-status 任务ID
```

只有确认 Postfix 队列和日志里都没有该邮件，才考虑显式重试：先停止 app，再运行 `docker compose run --rm --no-deps --entrypoint node app mail-worker/server-dist/cli.cjs mail-retry 任务ID --ack-duplicate-risk`，随后启动 app。覆盖入口使此次操作只执行 CLI。该命令只处理没有已知队列 ID 的不确定任务；没有证据时重试可能产生重复邮件。

在仓库根目录运行：

```sh
sh docker/backup.sh /srv/backups/cloud-mail-2026-11-12
```

脚本会停止 app 容器，在数据不再变化时通过覆盖入口的临时容器调用 Node 备份 CLI，保存 SQLite/附件/清单、Postfix 队列、DKIM 密钥、邮件日志与 `.env`，结束后重启服务。备份目录必须是尚不存在的绝对路径。备份含邮件和私钥，请存储到受保护的磁盘并另存一份到服务器之外。

以下恢复演练使用独立服务器；同机隔离演练可使用后面的 smoke 脚本。先构建对应版本镜像，把备份的 `config.env` 复制为 `.env` 并调整 NPM 网络、证书路径。恢复脚本仅接受**空的持久卷**，不会删除原数据；生产原卷需要保留，以便回退。

```sh
cp /srv/backups/cloud-mail-2026-11-12/config.env .env
chmod 600 .env
# 编辑 .env，核对域名、NPM 网络和证书路径；不要直接在生产原卷恢复。
docker compose build
sh docker/restore.sh /srv/backups/cloud-mail-2026-11-12
docker compose ps
curl -fsS https://mail.example.com/api/health
```

恢复后核对用户、历史邮件、星标、附件和排队邮件；执行一次真实外部收发演练并确认 DKIM 公钥仍匹配，再切换生产流量。同机切换前必须停止旧项目；若旧项目仍是双容器，需同时停止 app 和 mail，避免公网 25 冲突，以及两套应用在生产 NPM 网络上同时使用 `cloud-mail-app` 别名。单纯恢复演练应使用独立服务器/网络；本地无公网端口的演练可使用后面的 smoke 脚本。

若恢复进程被中断并留下 `cloud-mail.sqlite.restore-in-progress.json`，应用会拒绝启动。保持受影响卷停止并保留标记文件、`.pre-restore-*` 和 `.restore-*` 文件，不要混用不同版本的数据库和附件。可先查看标记中的路径，然后在另一组空卷重新从带 `COMPLETE` 标记的完整备份恢复并核对；原卷保留供人工检查，勿直接删除标记强行启动。

直接使用 Node 恢复 CLI 时，数据库旁会先写入 `<SQLITE_PATH>.restore-in-progress.json`。恢复成功或完整回滚后才删除此标记；中断或回滚失败时，应用启动、备份和再次恢复都会拒绝继续，避免自动创建空库或使用不匹配的附件。此时先停止 app 容器，保留标记及所有 `.pre-restore-*`、`.restore-*` 副本，根据标记记录的路径恢复一整套匹配的 SQLite 和 objects；核对完成后，才手动移除标记并重新启动。不要只删除标记后直接重试。`SQLITE_PATH` 必须位于 `OBJECTS_DIR` 外部。

已经使用单容器的手工源码部署，升级前先备份，然后运行：

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

已经使用单容器及 GHCR 覆盖文件的部署，升级前先保存旧镜像摘要及配置并完成一致性备份，再拉取新的 `main`、核对 GitHub 提交并更新 `compose.registry.yml` 中的摘要，运行 `docker compose -f docker-compose.yml -f compose.registry.yml up -d --no-build --no-deps app`。通过 `/health/ready` 与实际业务检查后才认为升级完成。回滚时使用保存的旧摘要重建应用；若版本改变了数据格式，需同时恢复该版本对应的数据库和附件备份，不能随意混用。单容器管理安装的升级需要按原环境配置、端口、标签与卷重建容器，安装脚本重复执行不负责升级。旧版双容器部署先按下一节迁移。

### 从旧版 app/mail 双容器迁移

先在旧 Compose 和脚本仍可用时，按原部署方式运行一致性备份，保存旧镜像摘要、`.env`、Compose 主文件和所有覆盖文件。确认备份包含应用数据、附件、队列、日志和 DKIM 密钥；备份完成后停止旧 `mail` 和 `app`，再更新部署文件。不能让旧邮件容器与新统一容器同时挂载并使用同一队列。

保持原 `COMPOSE_PROJECT_NAME` 和四个卷名 `app_data`、`mail_spool`、`mail_logs`、`dkim_keys`。默认项目的实际卷名是 `cloud-mail_app_data`、`cloud-mail_mail_spool`、`cloud-mail_mail_logs`、`cloud-mail_dkim_keys`；改项目名会创建另一组空卷。旧覆盖文件中的 `mail` 服务定义需要移除，`app` 镜像改为本地统一镜像或官方统一镜像摘要，证书继续完整只读挂载。原 `mail_internal` 网络可以保留，但不再用于 SMTP 中继授权。

源码部署在旧版本完成备份后执行：

```sh
# 此时仍使用旧 Compose；有覆盖文件时给本段所有命令带上原来的 -f 参数。
docker compose stop mail app
git pull --ff-only
# 核对 .env 和覆盖文件，并确认 config 的 services 中只有 app。
docker compose config --quiet
docker compose up -d --build --remove-orphans
docker compose ps
docker compose exec -T app cloud-mail-healthcheck
docker compose exec -T app postqueue -p
```

GHCR 部署也先用旧 Compose 停止 `mail`、`app`，再用更新后的单容器 Compose 与指定摘要执行 `docker compose -f docker-compose.yml -f compose.registry.yml up -d --no-build --remove-orphans`。`--remove-orphans` 移除已停止的旧邮件容器，不删除持久卷。此迁移不要使用 `--reinstall` 或任何 `-v` 删除卷选项。

启动后检查容器健康、用户与历史邮件、附件、投递状态、队列和 DKIM 公钥，再完成外部收发、STARTTLS 与拒绝中继验证。新容器启用邮件时会检查 HTTP 就绪以及 Postfix/OpenDKIM；只确认网页可打开不足以确认迁移成功。需要回退时先停止新容器，保留迁移后的新增数据，并使用旧配置、旧镜像与相配的一致性备份恢复；不能让新旧实例同时写原卷，也不能只换回不兼容旧数据库格式的镜像。

不要运行 `docker compose down -v`，该命令会删除应用、队列、日志和 DKIM 持久卷。正常停止使用 `docker compose stop`；手工源码部署重建使用 `docker compose up -d --build`，GHCR 部署使用上述带覆盖文件的 `--no-build` 命令。

## 7. 故障定位

| 现象 | 首先检查 |
| --- | --- |
| 网页 502 | app 健康状态、NPM 外部网络名称、上游 `cloud-mail-app:3000` |
| app 启用邮件后无法启动 | `MAIL_ENABLED`、NPM 完整证书目录挂载、证书有效期、路径与密钥匹配 |
| 外部收不到邮件 | MX/A/PTR、云厂商出站 25、Postfix 队列与远端返回码 |
| 外部发信连不上 | 公网入站 25、宿主机防火墙、MX 地址不能走 HTTP/CDN 代理 |
| 邮件暂缓/失败 | `postqueue -p`、Postfix 日志，及远端 SMTP 具体拒绝原因 |
| DKIM 失败 | 每域 TXT、公钥 selector、密钥持久卷与发件域一致 |
| SMTP 返回 451 | app 健康状态、策略服务 10040、SQLite/磁盘可写性 |
| 证书续期后仍旧 | 宿主机必须挂载整个 letsencrypt 目录，检查 app 中的邮件维护日志 |

此仓库的 CI 构建并测试代码、验证 Compose/脚本，并运行真实容器收发件演练；`main` 检查通过后发布 GHCR 统一镜像，不会自动修改运行中的服务器。真实 DNS、端口连通性、NPM 证书和外部邮件信誉只能在部署服务器及外部邮箱上验证。

## 8. 隔离的 Docker 收发件演练

Linux 上安装 Docker Compose 2.24.4 或更新版本和 OpenSSL 后，可在仓库目录运行：

```sh
sh docker/smoke-test.sh
```

脚本构建统一镜像，生成仅用于测试的自签证书，并创建独立 Compose 项目和临时 Docker 网络。测试覆盖健康接口、前端 HTML 与构建后的 JS 静态资源、带主机名校验的 SMTP STARTTLS、证书续期后自动 reload、外域中继与未知本地地址拒绝、仅停止 Node.js 时本地 RCPT 返回临时失败、RCPT 策略与 LMTP 入站落库、附件元数据与下载，以及回环 587 提交和 DKIM 签名。

发信演练通过登录 API 实际发送邮件，检查 SQLite 中持久化的发件箱任务，再由 Postfix 投递到临时私有 SMTP 接收端。接收端分别返回 250、450、550，核对 API/SQLite 中每位收件人的成功、暂缓和退信状态，再解除 450 拒绝并刷新队列，验证重试成功、DKIM 和 Bcc 隐私。随后检查 Node.js 暂停与单容器重建后的队列恢复、容器重启后的 SQLite 持久化及重复投递，以及停机备份、恢复到独立新卷并核对两封收件和附件原始字节。

测试覆盖取消所有宿主机端口发布，不占用生产 25；测试地址只使用 `.example` 保留域，外域投递被定向到自己的临时 SMTP 接收端，不向公网发信。它使用生成的测试配置，并覆盖同名环境变量，不读取生产 `.env`。退出时清理本次测试创建的容器、卷和网络，保留现有部署。正式配置的证书有效期、主机名和密钥校验没有关闭；测试客户端只额外信任本次生成的测试证书。

## 9. 只读节点一键部署

主节点更新到此版本后，在「节点管理」点击「新增节点」，填写名称并生成安装命令。所有节点使用 GitHub 上同一份通用脚本：`https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-node/install-node.sh`。节点管理为执行命令自动填写 `--primary-url`、`--install-token`、`--port`，受信局域网 HTTP 时额外添加 `--allow-insecure-http`。

复制页面的一键命令到目标 Linux amd64（x86_64）服务器执行即可。脚本凭短期安装令牌向主节点获取独立接入配置，自动安装 Docker（支持的 apt/dnf 发行版），再从 GHCR 拉取 `ghcr.io/lsh-okok/cloud-mail:main`。脚本记录并验证仓库摘要、镜像 ID 与 GitHub 提交，按固定摘要建立独立数据卷并启动同步。主节点和副本使用同一个统一镜像；副本保持只读角色并显式设置 `MAIL_ENABLED=false`，镜像中虽包含邮件程序，但不运行 Postfix/OpenDKIM、不要求证书、不监听邮件端口。无需另行准备 `node.env`、源码或镜像文件，命令不直接携带长期接入凭据。

新增结果显示一条完整的 `curl ... -o install-node.sh && sh install-node.sh ...` 命令和复制按钮，已包含下载、节点参数和执行步骤。脚本下载失败时不会执行；镜像拉取失败时不会改用缓存、主节点离线镜像包或服务器源码构建。旧版 `NODE_DEPLOYMENT_IMAGE_DIR`、`node-deploy.tar.gz` 与 `/api/node-install/:token/bundle` 不再用于一键安装，升级主节点后需重新生成命令并使用最新通用脚本。

目标服务器需有 curl、root/sudo 权限，并能访问 GitHub、GHCR 和主节点；自动安装 Docker/工具时还需可用的软件源，无需 npm。当前发布镜像仅支持 `linux/amd64`。默认访问端口为3001，可在「部署设置」修改。主节点地址必须是目标容器可访问的域名或局域网 IP，可包含站点子路径；不能填写 localhost、127.* 或0.0.0.0。受信局域网使用HTTP时，在页面明确勾选允许HTTP，公网使用HTTPS。

安装参数有效1小时，主服务重启、节点停用或撤销后失效；须在有效期内获取接入配置。GitHub 通用脚本本身不绑定节点或过期时间。已安装节点保留长期接入凭据，安装参数过期不影响运行。页面实时显示连接、同步和就绪；脚本等待就绪最多180秒，超时会提示排查并保留服务。有效期内再次执行同一命令只启动原节点，保留原镜像、密钥、配置和数据，不会随 `main` 更新而升级。端口、配置、镜像或数据卷冲突时停止并提示；尚未安装且参数失效时，撤销旧记录后重新创建。

配置默认保存在执行用户的 `~/.cloud-mail/nodes/<节点ID>/node.env`（权限600），部署版本记录在同目录 `.install-state`，容器名为 `cloud-mail-node-<节点ID>`，卷名为同名加 `-data`。命令与配置包含部署权限，请妥善保管。原手动配置仍可从创建结果的折叠项下载。

### 已下载通用安装脚本时

`docker/install-node.sh` 与 GitHub 发布的脚本相同，可长期保存并供所有节点复用。目标服务器无法访问 GitHub 时，可先在其他电脑下载并复制过去，再使用新增命令中 `&&` 之后的执行部分。形式如下，实际参数须使用节点管理自动生成的值：

```sh
sudo sh install-node.sh --primary-url 'https://mail.example.com' --install-token 'INSTALL_TOKEN_FROM_NODE_MANAGEMENT' --port 3001
```

此方式只省去从 GitHub 下载脚本，仍须访问 GHCR 拉取镜像，并在安装参数有效期内访问主节点获取配置。脚本不会 source/eval 下载的配置。通过 `sudo sh` 执行时，配置默认保存在 `/root/.cloud-mail/nodes/<节点ID>/node.env`。
