# 192.168.31.111 局域网部署记录

日期：2026-11-13。用户已选择使用 `cloudmail.test` 进行局域网验证。

## 访问与范围

- 网页：<http://192.168.31.111:3000>。
- 管理员：`admin@cloudmail.test`；随机初始密码保存在工作区忽略目录 `data/deployment-192.168.31.111/delivery/access.json`，本文不包含密码或密钥。
- 邮箱域：`cloudmail.test`；支持 MX/本地收件、子邮箱链接、邮箱验证及只读节点管理。
- SMTP：`192.168.31.111:2526`，支持 STARTTLS，使用本次生成的局域网自签证书。
- 初次部署时，25 端口由旧 `mail-lite` 占用；该旧服务现已按用户授权停用。Cloud Mail 仍使用 2526 验收，没有承接原项目数据或切换公网 MX；正式域名、HTTPS 和公网 25 切换不在本次局域网验收内。

## 服务器状态

- 部署目录：`/home/enohaook/cloud-mail`。
- Compose 项目：`cloud-mail`，配置为 `docker-compose.yml` 与 `compose.lan.yml`。
- 当前镜像：`cloud-mail-app:latest-20261114-121352`、`cloud-mail-mta:lan-20261113-mx`。
- 持久卷：`cloud-mail_app_data`、`cloud-mail_mail_spool`、`cloud-mail_mail_logs`、`cloud-mail_dkim_keys`。
- 独立网页网络：`cloud-mail-lan-web`；邮件内部网络：`cloud-mail_mail_internal`。
- 源码包 SHA-256：`a3a0d4a6341d46dd21d77b5f3e9e97084fcef915cb34a5fa762dd63e717cf482`。对应当时工作区源码，包含 HTTP 环境的子邮箱链接复制回退。

首次启动因系统盘已满而失败；清理了约 1.784 GB 可再生成的 Docker 构建缓存后成功启动。初次验收时系统盘剩余约 2.1 GB（使用率 93%）。同日后续已按用户授权清理无关服务及镜像，旧数据与配置保留；清理时 `.111` 可用空间约 3.7 GB，最终空间与清理范围见[双节点部署记录](deployment-nodes-192.168.31.112-113.md)。

## 验证结果

1. 从当前 Windows 电脑访问 `/api/health` 成功，返回 `status=ok`、`database=sqlite`、`mail=ready`；服务器 `/health/ready` 返回就绪。
2. 管理员登录、CSRF 会话、仅 MX 来源列表和链接 Token 加密能力均通过；迁移版本为 1、2、3。
3. 在同一管理员主邮箱下，为两个随机 `admin+deploy-…-a1/a2@cloudmail.test` 子地址生成临时链接；通过实际 SMTP/STARTTLS 投递两封受控测试邮件。
4. 两封邮件故意使用相同 To 邮件头，独立链接仍按 SMTP 信封地址各自只返回对应邮件，未发生串信。
5. 主邮箱停用后，两条公共链接均立即返回 404；恢复后配置正常。测试链接已删除，测试邮件已通过原邮件 API 从收件箱移除，未改写其他数据。
6. 备份后重启应用，管理员仍能登录，主邮箱配置与迁移保留。其他服务的后续清理不属于此次初始验收，见双节点部署记录。

已为 `admin@cloudmail.test` 建立本地主邮箱来源，可在“主邮箱管理 → 管理子邮箱链接”继续使用。链接生成仅建立读取关系；任意新别名仍须有实际收信路由，本次实际验证使用已有加号别名能力。

完整无密钥验收记录位于服务器 `verification.json`，本机副本为 `data/deployment-192.168.31.111/delivery/verification.json`。

## 备份与操作

- 原始配置及密钥恢复材料：`/home/enohaook/cloud-mail/backups/initial-config/`。
- 验收后 SQLite 与附件一致备份：`/home/enohaook/cloud-mail/backups/post-validation/app/`，含 `manifest.json`、`cloud-mail.sqlite` 和 `objects/`。
- 配置、登录信息和恢复目录按受限权限保存；实际密钥与管理员密码不写入源码或本文。
- 构建日志：`/home/enohaook/cloud-mail/deploy.log`。首次磁盘不足失败记录保留，后续启动和验收结果以 `verification.json` 为准。

在部署目录查看本项目状态：

```sh
sudo docker compose -p cloud-mail -f docker-compose.yml -f compose.lan.yml ps
sudo docker compose -p cloud-mail -f docker-compose.yml -f compose.lan.yml logs --tail=100 app mail
```

配置文件、项目名和卷名应保持配套。升级时备份 `.env`、数据库及附件，保留 `JWT_SECRET` 和 `DATA_ENCRYPTION_KEY`；不要用示例配置覆盖当前配置。

## 邮箱验证、节点及主邮箱添加升级

同日升级已完成，Cloud Mail 应用与邮件服务保留原数据。后续已部署 `.112/.113` 常驻副本，并按用户授权清理无关服务；详见[双节点部署记录](deployment-nodes-192.168.31.112-113.md)。页面入口：

- <http://192.168.31.111:3000/admin/mailboxes>：输入前缀、选择 `@cloudmail.test` 后添加，自动创建管理员本地邮箱并关联主邮箱来源；原收件箱侧栏自动刷新。
- <http://192.168.31.111:3000/admin/verification>：链接/收信任务、来源、独立 SMTP 发件配置、每日计划、停止/零重发复检与完整 CSV。
- <http://192.168.31.111:3000/admin/nodes>：创建接入、一次性凭据下载、同步状态、启停/撤销/删除记录。`.112/.113` 已分别在 3001 端口部署常驻只读节点，双节点同步及收件隔离联调通过。

自动化通过182项唯一测试：完整回归180项通过，收尾并发退出和全跳过复检两项新增回归随后与验证模块40项一起通过。前后端生产构建通过，根路径产物与独立 `/mail` 前缀构建通过。浏览器检查了新建主邮箱表单、验证任务/SMTP/每日计划及节点页面；390宽度验证/节点页无横向溢出。

实际服务器联调通过：

1. 经真实 SMTP/STARTTLS 投递两个随机子地址，故意复用同一 To 头，独立公共链接只返回自己的信封收件邮件。
2. 验证后台运行两项链接检测并完成；相同幂等键返回同一任务。CSV 包含全部项、UTF-8 BOM，长度和 SHA-256 校验一致。
3. 在 `.111` 同机创建隔离临时只读容器，仅绑定 `127.0.0.1:13001`。使用独立 JWT/加密密钥完成真实 HTTP 快照与增量同步，精确中继主节点邮件。其数据库无用户、邮件、来源秘密和原始链接 Token；旧管理、登录、附件 API 均拒绝。
4. 停用立即拦截已缓存链接读取，恢复后重新同步就绪；链接删除增量生效；撤销后就绪失败。临时容器、凭据、节点记录、测试链接均已清理，邮件从收件箱移除；保留两条完成的验收任务历史。
5. 制作升级后一致备份并重启，数据库迁移1～4、两个已完成任务及明细保留，管理员仍能登录。应用与邮件容器均 healthy；这是后续服务清理前的升级验收记录。

SMTP 发件账号尚未配置，每日计划保持停用。实际收信验证的自动发信须由用户填写其 SMTP 授权码后确认执行；本次服务器测试的两封邮件由受控局域网验收工具投递。没有向外部邮箱发送测试邮件，也没有对接 Outlook/iCloud。

本次应用镜像 config digest 为 `sha256:68bacaafd155affb216366c4b3ce69463b8219f644a9e729a7f37036771f821a`；Docker 29 使用的 OCI manifest digest 为 `sha256:44725e6a687e7988cfa2d2b98d278e1c80fac9321c28aff5e8292d7dbed697f9`。两者属于不同层级，核验时应区分。预编译升级包 `features.tgz` SHA-256 为 `6a3d352c5913fe74a3a3adf82ccd02a723da8d7d30f8017c8be0f1b7f53b0992`。后端依赖清单与既有镜像完全一致，因此复用运行依赖、只添加已构建应用及网页文件，避免在余量有限的服务器重复编译依赖。

- 升级前回退镜像：`cloud-mail-app:rollback-pre-verification-nodes`。
- 升级前配置及成对数据备份：`/home/enohaook/cloud-mail/backups/pre-verification-nodes/`，数据库与附件在 `app/`。
- 升级后成对数据备份：`/home/enohaook/cloud-mail/backups/post-verification-nodes/app/`。
- 验收目录：`/home/enohaook/cloud-mail-upgrade-20261113/`；本地无密钥报告位于 `data/deployment-192.168.31.111/delivery/verification-features.json`，重启状态在同目录 `database-state.after-restart.json`。

回退必须先停止应用写入并保存升级后新增数据，再恢复相配的升级前数据库/附件、配置和旧镜像。旧程序不接受 migration4，不能只切换镜像而保留新数据库。邮件容器继续排队等候应用恢复，操作前检查当前投递情况。

## 批量邮箱与 TXT 首行主邮箱升级

2026-11-14 已按用户授权更新 `.111`，网页仍为 <http://192.168.31.111:3000>。本次包含主邮箱及验证任务列表布局、批量创建邮箱和子邮箱 TXT 首行主邮箱匹配/新增。前后端构建成功，相关回归 74 项通过，最后后端构建及批量/TXT 测试 36 项通过。

- 运行镜像：`cloud-mail-app:mailbox-update-20261113-235843`，镜像 ID `sha256:278ebbecf4f75eff385e3f52c8e2726363c59456cf26b07f2f52b0e61b2789f7`。
- 更新包 SHA-256：`7086b79ab9ff2295b24652c727255a60acd4a11b9606b6526a90eaad21a53dc3`。仅更新构建后的后端和网页，复用已核验相同的运行依赖。
- 回退镜像：`cloud-mail-app:rollback-mailbox-update-20261113-235843`，对应此前运行的 features 镜像；本次迁移仍为 1～4。上节关于恢复 migration3 数据库的要求针对更早的 mx 镜像，不适用于回退到本次保存的 features 镜像。
- 升级前配置、SQLite/附件成对备份：`/home/enohaook/cloud-mail/backups/pre-mailbox-update-20261113-235843/`，数据在 `app/`。升级前无活动验证任务，邮件队列为空。
- 部署证据：服务器 `/home/enohaook/cloud-mail-mailbox-update-20261113-235843/`；本机忽略目录 `data/deployment-mailbox-update/` 保存日志及线上截图。

应用与邮件容器均 healthy，`/api/health` 返回 SQLite 正常、mail ready。邮件容器 ID 未变，原环境配置保留。升级前后均为用户1、邮箱1、主邮箱1、邮件0、子邮箱链接0、验证任务2、节点2；来源和链接内容摘要相同。使用已登录的管理员会话实测：批量请求已有邮箱返回新增0/已存在1/失败0，TXT 导入能匹配原 `admin@cloudmail.test` 并移除首行，未提交测试子链接或新增测试邮箱。

收尾检查发现 `.112/.113` 副本当前不可达，管理页最后心跳为 2026-11-13 23:51，早于本次 23:58 的升级；保留节点配置，本次未改动副本。`.111` 主节点就绪与收件服务正常。原保存的管理员密码未通过单独登录校验，功能验收使用浏览器现有有效管理员会话及 CSRF，不在升级中修改密码。

## 最新项目升级（2026-11-14）

已按用户授权将工作区最新项目部署到 `.111`，包含节点一键安装及转发收件改进。生产构建通过；后端全部 24 个测试文件、291 项测试通过。运行依赖哈希与此前一致，迁移及 schema 内容均未改变，仍为 1～4。

- 运行镜像：`cloud-mail-app:latest-20261114-121352`；实际 ID：`sha256:bfda83ad15521df609c5da016c2b82eee03b8308ab49c792090d8fcf6feded52`。
- 应用部署包 SHA-256：`f30824f2607d746548591055e8d7149bc818a9f9ea0aa6d714046265f0dfff18`，包含完整前后端产物、节点源码包及入口脚本。
- 升级前配置与 SQLite/附件成对备份：`/home/enohaook/cloud-mail/backups/pre-latest-20261114-121352/`；回退镜像 `cloud-mail-app:rollback-latest-20261114-121352` 对应此前 `278ebbec…2789f7` 镜像。
- 部署目录：`/home/enohaook/cloud-mail-latest-20261114-121352/`；本机证据在忽略目录 `data/deployment-latest-20261114/`。
- 同版本节点预构建镜像包位于部署目录的 `node-publication/`，通过只读挂载 `/app/node-deployment` 及 `NODE_DEPLOYMENT_IMAGE_DIR` 交付。镜像包 SHA-256：`795324c93b64a941f61e4795ffac9c46d04c210bae53a7f53c45cf5f76b2c331`。已在构建验证及运行容器内用 UID 1000 读取并复算校验；发布目录所有者保持 `1000:1000`。后续维护须继续保留 LAN Compose 中此只读挂载与环境变量。

最终应用及邮件容器均 healthy，API 返回数据库正常、mail ready，主节点 ready。邮件容器 ID 未变，`.env` 未变，原有数据卷保留；用户1、邮箱2、主邮箱2、邮件0、子邮箱链接0、验证任务2、节点2，来源及链接内容摘要与升级前相同。线上 HTML 和主 JS 已与此次构建逐字节核对，邮件队列为空，磁盘剩余约3.5GB。

浏览器确认新版本登录页可加载，原会话已失效，管理页面需要使用当前密码重新登录。运行环境保存的初始密码仍被现有用户记录拒绝（升级前记录也已存在此情况），未重置密码；因此没有声称本次已完成新的管理员登录或创建节点实测。节点安装包的实际可读性、版本与摘要已独立验证，安装接口行为由291项自动化回归覆盖。本次仅升级111，未调整112/113。
