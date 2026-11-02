# 维特 · Witt

**在自己的服务器上运行 AI 助手，在浏览器和 Android 手机上接着工作。**

[![MIT License](https://img.shields.io/badge/license-MIT-18181b)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22.16%2B-43853d)](https://nodejs.org/)
[![Android](https://img.shields.io/badge/Android-8.0%2B-3ddc84)](android/)

Witt 是一个自托管的 AI 工作台。它把服务器上的 CLI 代理连接到聊天界面，让你通过手机或电脑继续会话、查看命令与文件修改、管理项目，并预览和下载助手生成的作品。

## 一分钟认识维特

https://github.com/user-attachments/assets/eb5d7584-f53d-49c2-81bb-b66343b81266

60 秒 · 1080p · 含音乐。展示任务执行、作品预览、多任务并行、文件交付与跨设备接续。

[下载 MP4](https://github.com/LeoWilson-Ben/witt/raw/refs/heads/main/docs/media/witt-intro-60s.mp4)

当前源码接入 **Codex、Claude Code 和 Antigravity CLI**。模型能力由各自的 CLI、登录账号和上游服务决定；Witt 不提供模型账号、订阅、共享密钥或免费额度。

Witt is a self-hosted AI workspace for the browser and Android, connecting server-side CLI agents to persistent conversations, project files, and interactive artifacts.

这是独立社区项目，与 OpenAI、Anthropic、Google 没有隶属关系。

## 可以用它做什么

| 场景 | 已有实现 |
| --- | --- |
| 随时接着工作 | 连续会话、历史分页、多个对话并发、任务取消与重试 |
| 看清执行过程 | 流式回复、命令与工具事件、文件修改、审批交互 |
| 组织工作 | 项目归类、常用指令、计划任务及项目文件预览 |
| 处理文件 | 图片和文档上传、文件交付、下载、文本预览 |
| 预览作品 | 独立 Artifact 工作区，HTML 增量预览、版本切换与源码查看 |
| 管理接入 | 账号选择、动态能力目录、邀请码、设备停用、浏览器会话 |
| 在手机上使用 | Android WebView、Keystore 凭据保护、后台通知及应用更新 |
| 连接服务器 | Android 原生 SSH 连接，终端界面使用 xterm.js |

Codex 通过 App Server 接入；Claude 和 Antigravity 通过 CLI 适配器接入。分支、压缩、审查、技能和 MCP 等功能不能假定在不同适配器间完全一致，详见[账号与代理接入](docs/PROVIDERS.md)。

## 项目结构

```text
浏览器 / Android
       │ HTTPS
       ▼
Nginx ─┬─ /vault/      → 静态 Web 界面
       └─ /vault-api/  → Node.js 服务（回环地址）
                             ├─ 认证、设备与用户策略
                             ├─ 会话、SQLite、附件与 Artifact
                             └─ Codex App Server / CLI 代理
                                            └─ 项目工作目录

Android 本地终端 ── SSH ── 用户指定的服务器
```

| 目录 | 内容 |
| --- | --- |
| [`backend/`](backend/) | HTTP 服务、认证、代理适配、存储与备份 |
| [`web/`](web/) | 原生 HTML、CSS、JavaScript，无前端打包步骤 |
| [`android/`](android/) | Java WebView 客户端及原生桥接 |
| [`deploy/`](deploy/) | Nginx、systemd、环境变量示例 |
| [`tests/`](tests/) | 服务回归检查和浏览器检查 |
| [`tools/`](tools/) | Web 样式合并工具 |

## 部署之前

- Linux 服务器及 Node.js **22.16 或更新版本**；持久化使用内置 `node:sqlite`，备份使用其在线备份 API。
- 安装并登录准备使用的 CLI；Codex 是默认接入路径，其他适配器按需配置。
- 公网访问需要域名、HTTPS 和反向代理。
- 构建 Android 时需要 JDK 17、Android SDK 35 和与 Android Gradle Plugin 8.9.1 兼容的 Gradle。

**本仓库仍包含原部署环境的路径约定，不是开箱即用的多租户托管产品。** 除环境变量外，`backend/server.js` 的账号目录和可选项目集成、Claude/Antigravity 服务的 CLI 路径也需要按部署环境调整。首次启动、管理员初始化和路径核对见[部署指南](docs/DEPLOYMENT.md)。

后端没有第三方 npm 运行时依赖；浏览器测试使用的 Playwright 属于开发工具。

## 从哪里开始

```bash
git clone https://github.com/LeoWilson-Ben/witt.git
cd witt
```

1. 按[部署指南](docs/DEPLOYMENT.md)配置运行目录、令牌文件和 CLI 路径。
2. 初始化管理员，在本机安全取得首次激活信息。
3. 启动后端，确认 `GET /health` 返回的 `ok` 字段为 `true`。
4. 配置 HTTPS 和 `/vault/`、`/vault-api/` 路由，再激活浏览器或 Android 设备。

仅启动后端、仅通过健康检查，并不代表模型登录和执行任务已经可用。

## Android 客户端

客户端支持 Android 8.0（API 26）及以上。默认服务地址使用 `witt.example.com` 占位，必须换成自己的地址。

```bash
cd android
gradle :app:assembleRelease -PwittWebUrl=https://witt.example.com/vault/index.html -PwittApiUrl=https://witt.example.com/vault-api/ -PwittUpdateUrl=https://witt.example.com/vault/update.json
```

可通过 `wittApplicationId`、`wittAppLabel`、`wittVersionCode`、`wittVersionName` 自定义应用身份和版本，通过 `wittSigningProperties` 指定私有签名配置。配置文件路径相对于 `android/app/` 解析，也可以使用绝对路径。以上参数也有对应的 `WITT_*` 环境变量，完整名称见 [`android/app/build.gradle`](android/app/build.gradle)。

备用地址需同时设置 `wittFallbackWebUrl` 和 `wittFallbackApiUrl`。版本升级必须保持包名、签名身份一致，并提高 versionCode。更新清单模板为 [`web/update.example.json`](web/update.example.json)。

不使用 Android 也可以通过浏览器使用 Witt。开放登记属于额外部署模式，默认不应仅为尝试项目而启用，见[开放版说明](docs/open-edition.md)。

## 开发与检查

基础语法及不需要真实模型账号的检查：

```bash
node --check backend/server.js
node --check backend/chat-service.js
node tests/auth-service-check.cjs
node tests/browser-session-check.cjs
node tests/execution-isolation-check.cjs
node --test backend/test-chat-access-policy.js backend/test-claude-account-service.js
node --test backend/test-multitask.js backend/test-chat-history-regressions.js
node --test tests/open-enrollment-check.cjs
```

浏览器检查需要自行安装 Playwright 及 Chromium。`tests/app-server-capabilities-check.cjs` 会调用真实 Codex，运行前需核对其中的本机路径与账号。不要把它当成离线测试。

Web 样式按 [`web/web-style-manifest.json`](web/web-style-manifest.json) 排序。修改源样式后运行：

```bash
python3 tools/rebuild-web-styles.py
```

更多开发约定见[贡献指南](CONTRIBUTING.md)。

## 数据与执行权限

代码仓库和运行数据分开保存。数据库、附件、CLI 登录目录、设备凭据、Android 签名和 SSH 密钥不属于开源内容，不要上传到 Git、Issue 或 Release。

Witt 可以调用代理执行命令、编辑文件。设备认证、会话分目录与应用权限检查不等于操作系统级隔离，也不保证所有操作都会弹出审批。部署者需要核对不同适配器的执行参数、运行用户、目录权限和 sudo 策略。不要将主机 root 权限无差别授予开放登记用户。

备份工具 `backend/backup.js` 支持 SQLite 在线备份和 SHA-256 校验。配置自定义数据目录时，应同时配置备份范围，详见[部署指南](docs/DEPLOYMENT.md)。

## 文档

- [部署与管理员初始化](docs/DEPLOYMENT.md)
- [架构与数据边界](docs/ARCHITECTURE.md)
- [账号与代理接入](docs/PROVIDERS.md)
- [Claude 登录实现](docs/claude-login.md)
- [开放版登记](docs/open-edition.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 许可与致谢

Witt 源代码采用 [MIT License](LICENSE)。第三方依赖分别遵循其许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。模型服务、账号订阅、商标、运行数据和部署者提供的素材不包含在代码授权中。

感谢 Codex、Claude Code、Antigravity CLI，以及 KaTeX、xterm.js、mwiede/JSch 和参与反馈与贡献的开发者。
