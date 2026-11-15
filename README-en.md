<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">Cloud Mail</h1>
    <p align="center">A self-hosted email platform using Linux, Docker and Postfix</p>
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
    <p align="center">
        <a href="doc/server-deployment.md">Server Deployment Guide</a> ·
        <a href="/README.md">简体中文</a> | English
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

## Description
Create multiple mailboxes on your own domains. This branch runs on a Linux server with Docker Compose: Node.js serves the web client and API, SQLite stores application data, local volumes store attachments, and Postfix/OpenDKIM receive and directly deliver mail. It connects to an existing Nginx Proxy Manager for web HTTPS and mounts its certificates read-only for SMTP. Cloudflare Workers, D1, KV, R2 and Resend are not required.

**Start with the [server deployment guide](doc/server-deployment.md)** (Chinese). Copy `.env.example` to `.env`, configure the domains, administrator, existing NPM network and certificate paths, then run `docker compose up -d --build`. Inbound/outbound port 25 and MX/PTR/SPF/DKIM/DMARC records are required. GitHub Actions builds and tests the project; it does not deploy it.
## Project Showcase

| ![](/doc/demo/en/demo.jpg)  | ![](/doc/demo/en/demo1.jpg) |
|-----------------------------|-----------------------------|
| ![](/doc/demo/en/demo2.jpg) | ![](/doc/demo/en/demo3.jpg) |

## Recommended Project

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
      A self-hosted cloud storage photo album app
    </td>
  </tr>
</table>

## Features

- **🐳 Self-hosted Deployment**: Docker Compose with persistent data, attachments, mail queue and DKIM keys.

- **💻 Responsive Design**: Automatically adapts to both desktop and most mobile browsers.

- **📧 Email Delivery**: Postfix receives mail and delivers directly to destination MX servers, with replies, forwards, CC/BCC, bulk sending and delivery status.

- **🛡️ Admin Features**: Admin controls for user and email management with RBAC-based access control.

- **📦 Attachment Support**: Send and receive attachments using persistent local file storage by default.

- **🔔 Email Push**: Forward received emails to Telegram bots or other email providers.

- **📡 Open API**: Supports batch user creation via API and multi-condition email queries

- **🔎 Mail Search**: Search subject, body, sender/recipient and dates; star messages and track read status.

- **📈 Data Visualization**: Use ECharts to visualize system data, including user email growth.

- **🎨 Personalization**: Customize website title, login background, and transparency.

- **💾 Backup and Restore**: Consistent SQLite, attachment, mail queue and DKIM key backup scripts.

- **📜 More Features**: Under development...

## Tech Stack

- **Runtime**: Linux, Docker Compose, Node.js 24, pnpm 11

- **Web Framework**: [Hono](https://hono.dev/)

- **ORM**: [Drizzle](https://orm.drizzle.team/)

- **Frontend Framework**: [Vue3](https://vuejs.org/)

- **UI Framework**: [Element Plus](https://element-plus.org/)

- **Mail Transport**: Postfix / OpenDKIM, SMTP + LMTP

- **Cache**: Persistent SQLite KV

- **Database**: SQLite / better-sqlite3

- **File Storage**: Local Docker volumes

- **HTTPS**: Existing Nginx Proxy Manager; read-only NPM certificate mount for SMTP

## Project Structure

```
cloud-mail
├── Dockerfile                     # Node application image
├── docker-compose.yml             # app + Postfix/OpenDKIM and NPM network
├── docker                         # MTA configuration and backup/restore scripts
├── doc/server-deployment.md        # DNS, certificates, deployment and mail checks
├── mail-worker                    # Node backend with the existing business layer
│   ├── src
│   │   ├── api                    # API layer
│   │   ├── const                  # Project constants
│   │   ├── dao                    # Data access layer
│   │   ├── email                  # Email processing and handling
│   │   ├── entity                 # Database entities
│   │   ├── error                  # Custom exceptions
│   │   ├── hono                   # Web framework, middleware, error handling
│   │   ├── i18n                   # Internationalization
│   │   ├── init                   # Database and cache initialization
│   │   ├── model                  # Response data models
│   │   ├── security               # Authentication and authorization
│   │   ├── service                # Business logic layer
│   │   ├── template               # Message templates
│   │   ├── utils                  # Utility functions
│   │   └── server                 # Node entry, SQLite, LMTP and recipient policy
│   ├── package.json               # Project dependencies
│   └── server-dist                # Node build output
│
├── mail-vue                       # Frontend Vue project
│   ├── src
│   │   ├── axios                  # Axios configuration
│   │   ├── components             # Custom components
│   │   ├── echarts                # ECharts integration
│   │   ├── i18n                   # Internationalization
│   │   ├── init                   # Startup initialization
│   │   ├── layout                 # Main layout components
│   │   ├── perm                   # Permissions and access control
│   │   ├── request                # API request layer
│   │   ├── router                 # Router configuration
│   │   ├── store                  # Global state management
│   │   ├── utils                  # Utility functions
│   │   ├── views                  # Page components
│   │   ├── app.vue                # Root component
│   │   ├── main.js                # Entry JS file
│   │   └── style.css              # Global styles
│   ├── package.json               # Project dependencies
└── └── env.release                # Environment configuration

```

## License

This project is licensed under the [MIT](LICENSE) license.

## Communication

[Telegram](https://t.me/cloud_mail_tg)
