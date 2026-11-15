# 服务器版验证记录

验证日期：2026-11-13。此记录对应当前工作区的服务器版实现；尚未提交或发布 Git 版本。

## 本地检查

- Node.js 24：后端 `pnpm test`，7 个测试文件、59 项全部通过。
- 测试覆盖 SQLite 初始化和重复启动、KV 会话/过期时间、权限和邮箱隔离、注册与邀请码、批量创建失败回滚、附件存储、恢复中断保护、LMTP 幂等和逐收件人失败、外发状态、结构化退信、日志轮转及优雅停机。
- 新增邮件 API 验收使用独立临时 SQLite 和随机 loopback SMTP 端口，验证回复的 `In-Reply-To`/`References`、To/CC/BCC 去重与 BCC 隐私、分开发送的独立信封与 Message-ID、普通用户发件权限与按收件人数扣减额度，以及站内角色对站外 CC/BCC 的限制。
- 登录会话验证两个 token 在数据库重开后继续有效；单独登出一个 token 后，其撤销状态再次重启仍保持，其他会话正常，原管理员密码也未被重置。
- 修复回复原邮件未校验用户归属的问题：引用其他用户邮件 ID 的回复请求被拒绝，不写发件、不建队列、不扣额度；回复自己的邮件正常。该负例已先复现失败，再验证修复及自身回复正例通过。
- 生产 CJS 构建的 MIME/HTML 解析单独执行验证，避免仅在源码测试中通过。
- 后端 `pnpm build`、前端 `pnpm build`、Node probe 语法和 Shell 语法检查通过。
- 前端仍有原有的大文件分包和 Browserslist 数据过期提示，构建成功。

## 本机浏览器实测

使用生产构建在 Windows 本机启动 `http://127.0.0.1:3000`，仅绑定回环地址，使用隔离数据库 `data/local-preview/cloud-mail.sqlite`、本地附件目录和测试域 `local.test`。本次网页测试不向公网发信。

- 管理员登录、创建及切换 `secondary@local.test` 邮箱成功。
- 网页发送中文邮件至 `admin+ui@local.test`，加号别名正确进入管理员收件箱；回复成功，按 `Re:` 搜索得到对应邮件。
- 从第二邮箱向管理员发送带附件的中文邮件，网页上传、附件详情及下载正常。
- 终止测试应用进程后，用相同 SQLite、附件目录和 JWT 密钥启动最新构建。网页刷新后仍已登录，两个邮箱和三封测试邮件全部保留；重启后再次下载附件成功。
- 原始文件、重启前下载和重启后下载均为 74 字节，SHA-256 一致：`42114ce592f8e7e00378e22fcd4ddaf2c06f308c2c6ae82a2d9d2b487463492c`。
- 重启后 `/api/health` 返回 `status=ok`、`database=sqlite`、`mail=ready`。最终页面截图保存在本机 `data/local-preview/local-test-result.jpg`（测试数据目录不纳入 Git）。

Windows 终端的 Ctrl+C 未传递给预览进程，本次使用终止该测试进程的方式验证数据库恢复，确认退出后清理其残留进程锁；Linux 容器的优雅停机另有集成测试覆盖。本机未启动 Postfix，真实 MTA 链路验证见下节。

## Ubuntu Docker 集成

在用户授权的 `192.168.31.111`（Ubuntu 22.04、Docker Compose 2.35.1）运行 `sh docker/smoke-test.sh`，退出码为 0。使用独立项目、临时域、独立网络和自签测试证书，没有发布宿主机端口。其他现有服务未修改。

| 检查 | 结果 |
| --- | --- |
| 应用与 Postfix/OpenDKIM 镜像构建、健康检查 | 通过 |
| 前端 HTML/JS 资源、缺失资源 404 | 通过 |
| STARTTLS 的主机名与测试 CA 校验 | 通过 |
| 替换证书后自动 reload，客户端验证新证书 | 通过 |
| 公网 SMTP listener 拒绝外域中继、未知本地地址返回 550 | 通过 |
| SMTP → policy → LMTP → SQLite，附件下载 | 通过 |
| 登录 API → 持久发件任务 → Postfix → 私网模拟 SMTP 服务 | 通过 |
| 收件人返回 250/450/550，数据库和 API 状态相符 | 通过 |
| 临时拒绝解除后的 Postfix 重试，永久失败状态保留 | 通过 |
| 站外 MIME 含本站 DKIM 签名且不泄露 BCC | 通过 |
| app 停机后新 RCPT 临时失败 | 通过 |
| 已接受的队列跨 app 停机、MTA 重建恢复 | 通过 |
| app 重启后邮件持久化且没有重复入库 | 通过 |
| 停机备份、恢复到独立新卷，核对邮件与附件字节 | 通过 |

完整运行日志保存在该服务器的 `/home/enohaook/cloud-mail-codex-validation-20261113/smoke-final-full.log`。演练结束后，本次测试的容器、数据卷及网络已清理；保留源码和日志供复核。

## 正式上线待验证

集成测试仅向私网模拟 SMTP 服务投递。尚未配置真实域名、现有 NPM 网络及生产证书，因此以下项目需要正式部署时完成：

- NPM 网页 HTTPS、真实证书挂载与续期。
- 公网 A/MX/PTR/SPF/DKIM/DMARC，远端邮箱的认证结果和实际收发。
- 公网 MX 直投、目标邮箱服务商信誉/反垃圾规则。
- 配置真实 Telegram、Webhook、OAuth 和可选 S3/Turnstile 凭据后的联调。

生产部署与操作步骤见 [server-deployment.md](server-deployment.md)，配置模板见 [../.env.example](../.env.example)。
