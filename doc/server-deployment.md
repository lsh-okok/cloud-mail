# Linux 服务器部署

此版本默认在自己的 Linux 服务器运行，不需要 Cloudflare Workers、D1、KV、R2 或 Resend。Node.js 应用提供网页/API、SQLite、附件文件、LMTP 收件和收件人策略；Postfix 负责公网 SMTP 收件、MX 直投和重试，OpenDKIM 签名。Nginx Proxy Manager（NPM）继续管理网页 HTTPS 和证书。

```text
浏览器 ── HTTPS ── NPM ── HTTP:3000 ── app ── SQLite / 附件卷
外部邮箱 ── SMTP:25 ── mail/Postfix ── LMTP:2525 ── app
                         │ RCPT 策略 TCP:10040 ── app
app ── 内网 SMTP:587 ── Postfix + OpenDKIM ── MX:25 ── 外部邮箱
NPM 证书目录 ── 只读挂载 ── Postfix STARTTLS
```

邮件服务只有端口 25 发布到宿主机。587 不发布，只允许独立 Docker 邮件网络中的应用提交邮件；公网 25 无论来源地址都执行 `reject_unauth_destination`。本项目提供网页邮箱/API，不提供 IMAP 或 POP3 服务。

## 一键安装管理主节点

在新的 Linux 服务器可先使用公共安装脚本部署管理主节点，随后在「节点管理」中新增只读节点：

```sh
curl -fsSL https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-primary/install-primary.sh -o install-primary.sh && bash install-primary.sh
```

脚本自动安装 Docker 和必要工具，从同一仓库下载与脚本固定摘要匹配的服务器源码包，构建应用并生成独立管理员密码、JWT 与数据加密密钥，使用持久数据卷启动。默认目录 `/opt/cloud-mail-primary`、容器名 `cloud-mail-primary`、端口3000，完成后打印访问地址、管理员邮箱和初始密码。可用 `--host` 指定访问IP，`--port`、`--dir`、`--name` 指定独立实例，`--mail-domain` 和 `--admin-email` 修改邮箱域及管理员邮箱；通过 `--image` 使用已有应用镜像或 `--source-dir` 使用本地服务器版源码。

此安装提供管理页面、主邮箱来源、链接、验证任务和只读节点管理，不启动 Postfix/OpenDKIM，MX 收发尚未启用。完整公网收发需要按下文继续配置邮件服务、域名 DNS、TLS 证书与TCP25。首次源码构建需访问 GitHub、Docker 镜像源、系统软件源及 npm。

同一安装重复运行保留原配置与数据；不同参数、同名外部容器或已有其他数据卷会拒绝覆盖。请保管安装目录中的配置以及数据卷备份。本脚本位于本项目的 `docker/install-primary.sh`，公共发布路径为 `ok-email-scripts/cloud-mail-primary/install-primary.sh`。

## 1. 准备服务器与域名

需要 Docker Engine、Docker Compose v2、一个已运行的 NPM、固定公网 IPv4，以及域名 DNS 管理权限。服务器厂商必须允许**入站和出站 TCP 25**；Web 端口 80/443 继续由 NPM 使用。防火墙开放入站 25，不开放 3000、2525、10040 或 587。当前 MTA 默认仅使用 IPv4。

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

`/certs` 是邮件容器里的只读挂载路径；不要把宿主机路径填到两个 `SMTP_TLS_*_FILE` 变量里。容器每 30 秒检查证书内容，NPM 续期后自动执行 `postfix reload`。启动时会验证证书有效期及密钥匹配；首次启动前证书必须已经存在。

## 3. 配置与启动

```sh
git clone https://github.com/lsh-okok/cloud-mail.git
cd cloud-mail
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

编辑 `.env`：替换域名、管理员初始密码、随机 `JWT_SECRET`、NPM 网络和证书路径。`ADMIN_EMAIL` 必须属于 `MAIL_DOMAINS`；多个邮箱域用逗号分隔。`MAIL_NETWORK_SUBNET` 不得与服务器、VPN 或现有 Docker 网络重叠。管理员密码用于首次初始化，后续通过管理界面修改密码。

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app mail
```

首次构建会安装 Node.js 24、pnpm 11 和应用依赖，前端构建到 `mail-worker/dist`，Node 后端构建到 `mail-worker/server-dist`。运行容器使用非 root 的 `node` 用户，SQLite 与附件写入持久卷。MTA 使用独立容器并持久化邮件队列、DKIM 私钥和 Postfix 日志。容器默认使用 UTC，以统一每日配额和统计日期；网页会按浏览器本地时区显示时间。

在 NPM 新建 Proxy Host：

| NPM 字段 | 值 |
| --- | --- |
| Domain Names | `mail.example.com` |
| Scheme | `http` |
| Forward Hostname | `cloud-mail-app` |
| Forward Port | `3000` |
| SSL | 选择网页域名证书，启用 Force SSL |

NPM 和 app 必须连接到 `.env` 配置的同一个 `NPM_NETWORK`。附件默认最大邮件总量为 25 MiB；如要发大附件，NPM 的 `client_max_body_size` 也要相应增加，并同步调整 `MAX_MESSAGE_BYTES`。MIME/Base64 编码会使附件占用大于原文件体积。

健康检查：

```sh
curl -fsS https://mail.example.com/api/health
docker compose exec -T mail postfix status
docker compose exec -T mail postqueue -p
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
docker compose exec -T mail cat /etc/opendkim/keys/example.com/mail.txt
```

将输出中的 TXT 内容按 DNS 服务商界面要求合并，添加到 `mail._domainkey.example.com`。多域名逐个添加；不要公开或复制 `.private` 文件。持久卷会保留私钥，重建容器不换 key。更换 selector 时先发布新公钥，再更新 `DKIM_SELECTOR` 并重建邮件容器。

验证 DNS 和 DKIM：

```sh
dig +short MX example.com
dig +short A mx.example.com
dig +short -x 203.0.113.10
dig +short TXT example.com
dig +short TXT mail._domainkey.example.com
dig +short TXT _dmarc.example.com
docker compose exec -T mail opendkim-testkey -d example.com -s mail -vvv
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

应收到 `Relay access denied`。再向本地域不存在的地址测试，关闭“无人收件/接收未注册地址”功能时应返回 550；有效地址应通过 RCPT。停止 app 后再连接公网 SMTP，收件人策略应临时返回 451，外部发送方可以稍后重试。

检查队列和日志：

```sh
docker compose exec -T mail postqueue -p
docker compose logs --tail=200 mail
docker compose logs --tail=100 app
```

Postfix 日志通过只读共享卷供 app 更新投递状态。默认单日志到 100 MiB 轮转，保留 7 份未压缩日志，以便 app 在轮转后继续读取尚未处理的投递结果；参数为 `MAIL_LOG_MAX_BYTES`、`MAIL_LOG_KEEP`。日志中包含邮件地址，应和邮件数据一起备份并限制访问。

## 6. 备份、恢复与升级

提交邮件后连接中断时，应用会保留“不确定”状态，先根据 Postfix 日志对账，避免自动重复发信。可以从邮件的 `deliveries[].deliveryId` 获取任务标识并查询：

```sh
docker compose exec -T app node mail-worker/server-dist/cli.cjs mail-status 任务ID
```

只有确认 Postfix 队列和日志里都没有该邮件，才考虑显式重试：先停止 app，再运行 `docker compose run --rm --no-deps app node mail-worker/server-dist/cli.cjs mail-retry 任务ID --ack-duplicate-risk`，随后启动 app。该命令只处理没有已知队列 ID 的不确定任务；没有证据时重试可能产生重复邮件。

在仓库根目录运行：

```sh
sh docker/backup.sh /srv/backups/cloud-mail-2026-11-12
```

脚本会停止 app 和 mail，在数据不再变化时调用 Node 备份 CLI，保存 SQLite/附件/清单、Postfix 队列、DKIM 密钥、邮件日志与 `.env`，结束后重启服务。备份目录必须是尚不存在的绝对路径。备份含邮件和私钥，请存储到受保护的磁盘并另存一份到服务器之外。

恢复演练应使用独立服务器或新的 `COMPOSE_PROJECT_NAME`，先构建对应版本镜像，把备份的 `config.env` 复制为 `.env` 并调整 NPM 网络、证书路径。恢复脚本仅接受**空的持久卷**，不会删除原数据；生产原卷需要保留，以便回退。

```sh
cp /srv/backups/cloud-mail-2026-11-12/config.env .env
chmod 600 .env
# 编辑 .env；同机演练请更换 COMPOSE_PROJECT_NAME 和 MAIL_NETWORK_SUBNET，避免端口冲突。
docker compose build
sh docker/restore.sh /srv/backups/cloud-mail-2026-11-12
docker compose ps
curl -fsS https://mail.example.com/api/health
```

恢复后核对用户、历史邮件、星标、附件和排队邮件；执行一次真实外部收发演练并确认 DKIM 公钥仍匹配，再切换生产流量。同机切换前必须停止旧项目的 app 和 mail，避免公网 25 冲突，以及两套应用在生产 NPM 网络上同时使用 `cloud-mail-app` 别名。单纯恢复演练应使用独立服务器/网络；本地无公网端口的演练可使用后面的 smoke 脚本。

若恢复进程被中断并留下 `cloud-mail.sqlite.restore-in-progress.json`，应用会拒绝启动。保持受影响卷停止并保留标记文件、`.pre-restore-*` 和 `.restore-*` 文件，不要混用不同版本的数据库和附件。可先查看标记中的路径，然后在另一组空卷重新从带 `COMPLETE` 标记的完整备份恢复并核对；原卷保留供人工检查，勿直接删除标记强行启动。

直接使用 Node 恢复 CLI 时，数据库旁会先写入 `<SQLITE_PATH>.restore-in-progress.json`。恢复成功或完整回滚后才删除此标记；中断或回滚失败时，应用启动、备份和再次恢复都会拒绝继续，避免自动创建空库或使用不匹配的附件。此时先停止 app 和 mail，保留标记及所有 `.pre-restore-*`、`.restore-*` 副本，根据标记记录的路径恢复一整套匹配的 SQLite 和 objects；核对完成后，才手动移除标记并重新启动。不要只删除标记后直接重试。`SQLITE_PATH` 必须位于 `OBJECTS_DIR` 外部。

升级前先备份，然后运行：

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
```

不要运行 `docker compose down -v`，该命令会删除应用、队列、日志和 DKIM 持久卷。正常停止使用 `docker compose stop`，正常重建使用 `docker compose up -d --build`。

## 7. 故障定位

| 现象 | 首先检查 |
| --- | --- |
| 网页 502 | app 健康状态、NPM 外部网络名称、上游 `cloud-mail-app:3000` |
| mail 无法启动 | NPM 完整证书目录挂载、证书有效期、路径与密钥匹配 |
| 外部收不到邮件 | MX/A/PTR、云厂商出站 25、Postfix 队列与远端返回码 |
| 外部发信连不上 | 公网入站 25、宿主机防火墙、MX 地址不能走 HTTP/CDN 代理 |
| 邮件暂缓/失败 | `postqueue -p`、Postfix 日志，及远端 SMTP 具体拒绝原因 |
| DKIM 失败 | 每域 TXT、公钥 selector、密钥持久卷与发件域一致 |
| SMTP 返回 451 | app 健康状态、策略服务 10040、SQLite/磁盘可写性 |
| 证书续期后仍旧 | 宿主机必须挂载整个 letsencrypt 目录，检查 mail maintenance 日志 |

此仓库的 CI 构建并测试代码、验证 Compose/脚本，并运行真实容器收发件演练，不会自动发布到 Cloudflare 或服务器。真实 DNS、端口连通性、NPM 证书和外部邮件信誉只能在部署服务器及外部邮箱上验证。

## 8. 隔离的 Docker 收发件演练

Linux 上安装 Docker Compose 2.24.4 或更新版本和 OpenSSL 后，可在仓库目录运行：

```sh
sh docker/smoke-test.sh
```

脚本构建镜像，生成仅用于测试的自签证书，并创建独立 Compose 项目和临时 Docker 网络。测试覆盖健康接口、前端 HTML 与构建后的 JS 静态资源、带主机名校验的 SMTP STARTTLS、证书续期后自动 reload、外域中继与未知本地地址拒绝、app 停机时本地 RCPT 返回临时失败、RCPT 策略与 LMTP 入站落库、附件元数据与下载，以及内网 587 提交和 DKIM 签名。

发信演练通过登录 API 实际发送邮件，检查 SQLite 中持久化的发件箱任务，再由 Postfix 投递到临时私有 SMTP 接收端。接收端分别返回 250、450、550，核对 API/SQLite 中每位收件人的成功、暂缓和退信状态，再解除 450 拒绝并刷新队列，验证重试成功、DKIM 和 Bcc 隐私。随后检查 app 停机期间及 MTA 重建后的队列恢复、app 重启后的 SQLite 持久化及重复投递，以及停止应用后备份、恢复到独立新卷并核对两封收件和附件原始字节。

测试覆盖取消所有宿主机端口发布，不占用生产 25；测试地址只使用 `.example` 保留域，外域投递被定向到自己的临时 SMTP 接收端，不向公网发信。它使用生成的测试配置，并覆盖同名环境变量，不读取生产 `.env`。退出时清理本次测试创建的容器、卷和网络，保留现有部署。正式配置的证书有效期、主机名和密钥校验没有关闭；测试客户端只额外信任本次生成的测试证书。

## 9. 只读节点一键部署

主节点更新到此版本后，在「节点管理」点击「新增节点」，填写名称并生成安装命令。所有节点使用 GitHub 上同一份通用脚本：`https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-node/install-node.sh`。节点管理只为执行命令自动填写 `--primary-url`、`--install-token`、`--port`，受信局域网 HTTP 时额外添加 `--allow-insecure-http`，不再为每个节点复制一整套安装逻辑。

复制页面的一键命令到目标 Linux 服务器执行即可。脚本凭短期安装令牌向主节点获取当前节点的独立配置、包摘要和镜像信息，再自动安装 Docker（支持的 apt/dnf 发行版）、下载并校验安装包、导入或构建镜像、建立独立数据卷并启动同步，无需修改脚本或另行准备 `node.env`、镜像文件。命令中使用短期安装令牌，不直接携带长期接入凭据。

新增结果只显示一条完整的 `curl ... -o install-node.sh && sh install-node.sh ...` 命令和复制按钮，已包含下载、节点参数和执行步骤。下载失败时不会运行脚本，无需先手动下载。

目标服务器需有 curl、root/sudo 权限，并能访问 GitHub、主节点。源码构建方式还需访问 Docker 镜像源和 npm 依赖源。默认访问端口为3001；可在「部署设置」修改。主节点地址必须是目标容器可访问的域名或局域网 IP，保留站点子路径；不能填写 localhost、127.* 或0.0.0.0。受信局域网使用HTTP时，在页面明确勾选允许HTTP，公网使用HTTPS。

安装参数有效1小时，主服务重启、节点停用/撤销或部署包更新后失效；在有效期内完成配置与安装包下载。GitHub 通用脚本本身不绑定节点或过期时间。已安装节点保留长期接入凭据，安装参数过期不影响运行。页面实时显示连接、同步和就绪；脚本等待就绪最多180秒，超时会提示排查并保留服务。有效期内再次执行同一命令会保留原密钥、配置和数据；尚未安装且参数失效时，撤销旧记录后重新创建。

配置默认保存在执行用户的 `~/.cloud-mail/nodes/<节点ID>/node.env`（权限600），容器名为 `cloud-mail-node-<节点ID>`，卷名为同名加 `-data`。命令与脚本包含部署权限，请妥善保管。原手动配置仍可从创建结果的折叠项下载。

后端 `pnpm --dir mail-worker run build` 会生成 `mail-worker/server-dist/node-deploy.tar.gz`，Docker构建也自动携带该包；安装包仅含构建所需源码白名单，不包含环境配置、数据库或部署密钥。未生成安装包时，页面会提示先构建并更新主节点。

### 通过预构建镜像部署到离线节点

目标服务器无法访问 Docker 镜像源或 npm 时，可以让主节点提供已构建的同版本应用镜像。先在有此镜像的 Docker 主机执行以下命令；输出目录的父目录须已存在，每个版本使用新的输出目录：

```sh
sudo sh docker/export-node-image.sh cloud-mail-app:release /srv/cloud-mail-node-release-20261114
# 标准应用容器内 node 用户为 UID/GID 1000，须能读取只读挂载的文件。
sudo chown -R 1000:1000 /srv/cloud-mail-node-release-20261114
```

将 `cloud-mail-app:release` 替换为本次构建的应用镜像。脚本生成 `node-image.tar.gz` 和 `node-image.json`，记录镜像 ID 与压缩包 SHA-256；输出目录权限为700、文件为600，已有目录不会被覆盖。它只导出镜像，不读取运行容器的环境配置或数据卷。镜像应通过本项目 Dockerfile 构建，并与主节点代码版本、目标服务器 CPU 架构匹配。

将整个输出目录放到主节点宿主机，通过只读绑定挂载接入应用容器，并设置环境变量。例如在部署用的 Compose 覆盖文件中添加：

```yaml
services:
  app:
    environment:
      NODE_DEPLOYMENT_IMAGE_DIR: /app/mail-worker/node-image-release
    volumes:
      - /srv/cloud-mail-node-release-20261114:/app/mail-worker/node-image-release:ro
```

重建主应用容器后，新生成的一键命令会优先从主节点下载此镜像包，校验完整性并导入指定镜像 ID，再启动节点。已有 Docker 及必要下载工具时，安装不再访问镜像源或 npm，也无需编译前后端。通用安装脚本仍需从 GitHub 下载一次，不能访问 GitHub 时可提前复制该公共脚本。配置此目录时应同时更新应用代码与镜像包，避免下发旧版本；不配置时继续使用源码构建方式。

### 已下载通用安装脚本时

`docker/install-node.sh` 与 GitHub 发布的脚本相同，可长期保存并供所有节点复用。目标服务器无法访问 GitHub 时，可以先在其他电脑下载并复制过去，再使用新增命令中 `&&` 之后的执行部分。形式如下，实际参数须使用节点管理自动生成的值：

```sh
sudo sh install-node.sh --primary-url 'https://mail.example.com' --install-token 'INSTALL_TOKEN_FROM_NODE_MANAGEMENT' --port 3001
```

此方式只省去从 GitHub 下载脚本，仍须在安装参数有效期内访问主节点获取配置和安装包。脚本不会 source/eval 下载的配置。相同配置、端口和镜像版本可重复执行；冲突会停止并提示，不会自动覆盖已有部署。通过 `sudo sh` 执行时，配置默认保存在 `/root/.cloud-mail/nodes/<节点ID>/node.env`。
