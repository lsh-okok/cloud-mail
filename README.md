<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center"><strong>基于 Linux、Docker 与 Postfix 的自托管邮箱服务平台</strong></p>
    <p align="center">
        <a href="doc/server-deployment.md">
            <img src="https://img.shields.io/badge/Node.js-24-339933?logo=node.js&amp;logoColor=white" alt="Node.js 24" />
        </a>
        <a href="https://github.com/maillab/cloud-mail/releases" target="_blank" >
            <img src="https://img.shields.io/github/v/release/maillab/cloud-mail?logo=github&amp;logoColor=white" alt="releases" />
        </a>
        <a href="https://github.com/maillab/cloud-mail/tree/main?tab=MIT-1-ov-file" target="_blank" >
            <img src="https://img.shields.io/badge/license-MIT-green" />
        </a>  
    </p>
    <p align="center" >
        <a href="doc/server-deployment.md">服务器部署文档</a> ·
        <a align="center"><a href="README-en.md">English</a> | 简体中文</a>
    </p>
    <p align="center">
        <a href="https://trendshift.io/repositories/20459" target="_blank" >
            <img src="https://trendshift.io/api/badge/repositories/20459" alt="trendshift" >
        </a>
        <a href="https://hellogithub.com/repository/1b1da1f9ae4c4175baa3d762b4e0ba41" target="_blank">
            <img src="https://api.hellogithub.com/v1/widgets/recommend.svg?rid=1b1da1f9ae4c4175baa3d762b4e0ba41" alt="HelloGitHub" />
        </a>
    </p>
</p>


## 项目简介

使用自己的域名创建多个邮箱。此分支默认在 Linux 服务器通过 Docker Compose 运行：Node.js 提供网页和 API，SQLite 保存数据，本地持久卷保存附件，Postfix/OpenDKIM 接收和直接投递邮件。网页 HTTPS 接入已有 Nginx Proxy Manager，并只读使用其证书；不需要 Cloudflare Workers、D1、KV、R2 或 Resend。

**部署入口：[Linux 服务器部署](doc/server-deployment.md)**。从 `.env.example` 创建 `.env`，配置域名、管理员、NPM 网络和证书后运行 `docker compose up -d --build`。部署前需要服务器入站/出站 25 可用并完成 MX、PTR、SPF、DKIM、DMARC 配置。

GitHub Actions 在 `main` 检查通过后发布 `ghcr.io/lsh-okok/cloud-mail:main` 和 `:sha-<完整40位提交号>` 镜像（`linux/amd64`），不自动更新运行中的服务器。一键管理主节点与只读节点默认拉取最新已发布的 `main` 并按摘要固定版本，无需服务器编译；重复执行保留原版本和数据，不执行升级。服务器须访问 GitHub、GHCR，不提供源码或离线镜像回退。管理一键安装不含 MX 收发；完整邮件服务仍按文档配置 Compose。

邮箱后缀可在管理员后台的「邮箱域名」中新增、设为默认或停止创建，保存立即生效，无需修改代码或重建应用。现有账号与邮箱地址保持不变；公网收发仍需配置 DNS 和邮件服务，详见[邮箱域名管理](doc/mail-domains.md)。

## 项目展示

| ![](/doc/demo/demo.jpg)  | ![](/doc/demo/demo1.jpg) |
|--------------------------|--------------------------|
| ![](/doc/demo/demo2.jpg) | ![](/doc/demo/demo3.jpg) |


## 推荐项目

<table>
  <tr>
    <td valign="middle">
      <a href="https://github.com/pixtalelab/pixtale">
        <img width="30" src="https://img.022335.xyz/logo.png" alt="Pixtale" align="middle">
      </a>
    </td>
    <td valign="middle">
      <a href="https://github.com/pixtalelab/pixtale">Pixtale</a>
    </td>
    <td valign="middle">
      一个自托管云存储相册应用
    </td>
  </tr>
</table>

## 功能介绍

- **🐳 自托管部署**：Docker Compose 运行应用与邮件服务，数据、附件、队列和 DKIM 密钥保存在持久卷

- **💻 响应式设计**：响应式布局自动适配PC和大部分手机端浏览器

- **📧 邮件收发**：Postfix 接收公网邮件，通过 MX 直接投递，支持回复、转发、CC/BCC、群发与投递状态

- **🛡️ 管理员功能**：可以对用户，邮件进行管理，RABC权限控制对功能及使用资源限制

- **📦 附件收发**：支持收发附件，默认使用本地文件持久化保存和下载

- **🔔 邮件推送**：接收邮件后可以转发到TG机器人或其他服务商邮箱

- **📡 开放API**：支持使用API批量生成用户，多条件查询邮件 

- **🔎 邮件检索**：按主题、正文、发件人/收件人及时间检索，支持星标和已读状态

- **📈 数据可视化**：使用ECharts对系统数据详情，用户邮件增长可视化显示

- **🎨 个性化设置**：可以自定义网站标题，登录背景，透明度

- **💾 备份恢复**：提供 SQLite、附件、邮件队列与 DKIM 密钥的一致性备份和恢复脚本

- **📜 更多功能**：正在开发中...



## 技术栈

- **运行环境**：Linux、Docker Compose、Node.js 24、pnpm 11

- **Web框架**：[Hono](https://hono.dev/)

- **ORM：**[Drizzle](https://orm.drizzle.team/)

- **前端框架**：[Vue3](https://vuejs.org/) 

- **UI框架**：[Element Plus](https://element-plus.org/) 

- **邮件服务：** Postfix / OpenDKIM，SMTP + LMTP

- **缓存**：SQLite 持久化 KV

- **数据库**：SQLite / better-sqlite3

- **文件存储**：本地 Docker 持久卷

- **HTTPS**：已有 Nginx Proxy Manager；SMTP 只读挂载 NPM 的证书目录

## 目录结构

```
cloud-mail
├── Dockerfile                     # Node 应用镜像
├── docker-compose.yml             # app + Postfix/OpenDKIM 与 NPM 网络
├── docker                         # MTA 配置、备份恢复脚本
├── doc/server-deployment.md        # DNS、证书、部署及收发演练
├── mail-worker                    # Node 后端（保留原业务层）
│   ├── src
│   │   ├── api                    # api接口层
│   │   ├── const                  # 项目常量
│   │   ├── dao                    # 数据访问层
│   │   ├── email                  # 邮件处理接收
│   │   ├── entity                 # 数据库实体
│   │   ├── error                  # 自定义异常
│   │   ├── hono                   # web框架配置、拦截器、全局异常等
│   │   ├── i18n                   # 语言国际化
│   │   ├── init                   # 数据库缓存初始化
│   │   ├── model                  # 响应体数据封装
│   │   ├── security               # 身份权限认证
│   │   ├── service                # 业务服务层
│   │   ├── template               # 消息模板
│   │   ├── utils                  # 工具类
│   │   └── server                 # Node 入口、SQLite、LMTP、策略服务
│   ├── pageckge.json              # 项目依赖
│   └── server-dist                # Node 构建产物
│
├── mail-vue                       # vue前端项目
│   ├── src
│   │   ├── axios                  # axios配置
│   │   ├── components             # 自定义组件
│   │   ├── echarts                # echarts组件导入
│   │   ├── i18n                   # 语言国际化
│   │   ├── init                   # 入站初始化
│   │   ├── layout                 # 主体布局组件
│   │   ├── perm                   # 权限认证
│   │   ├── request                # api接口
│   │   ├── router                 # 路由配置
│   │   ├── store                  # 全局状态管理
│   │   ├── utils                  # 工具类
│   │   ├── views                  # 页面组件
│   │   ├── app.vue                # 入口组件
│   │   ├── main.js                # 入口js
│   │   └── style.css              # 全局css
│   ├── package.json               # 项目依赖
└── └── env.release                # 项目配置
```

## 许可证

本项目采用 [MIT](LICENSE) 许可证	


## 交流

[Telegram](https://t.me/cloud_mail_tg)



