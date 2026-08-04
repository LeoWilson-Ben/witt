# Witt 架构与安全边界

## 组件

### Android 外壳

Android 应用加载受信任的 Witt Web 页面，通过 WebMessageListener 暴露最小原生桥。设备凭据保存在 Android Keystore 支持的私有存储中，网页只能发起经过约束的 API、下载和更新操作。

### Web UI

Web UI 使用原生 HTML、CSS 和 JavaScript，无需前端构建工具。它负责会话展示、设置、审批交互、附件选择、图片查看和本地 IndexedDB 缓存，不应持久化服务端凭据。

### Node.js 服务

服务只监听回环地址，负责：

- 邀请码激活与设备认证
- 用户、会话、附件和图片隔离
- Codex App Server 生命周期与事件转换
- 审批、分支、压缩、审查和交付文件
- SQLite 持久化、迁移与在线备份

### Codex App Server

每个 Witt 对话对应独立 Codex thread。服务将 App Server 事件转换为稳定的消息流结构，并在任务完成后复用连接。Codex 的权限仍由运行用户、沙箱、审批策略和 sudo 配置共同决定。

## 数据边界

| 数据 | 建议位置 | 公开范围 |
| --- | --- | --- |
| 源代码 | Git 仓库 | 可公开 |
| 设备与认证数据库 | `DROP_VAULT_AUTH_DIR` | 私有 |
| 会话数据库 | `DROP_VAULT_CHAT_DIR` | 私有 |
| 用户附件和图片 | 数据目录 | 私有 |
| Codex 登录目录 | 用户配置目录 | 私有 |
| 兼容令牌 | 权限为 `600` 的独立文件 | 私有 |
| Android keystore 和签名配置 | 构建机私有目录 | 私有 |

## 请求路径

1. 客户端通过 HTTPS 到达 Nginx。
2. Nginx 提供静态 UI，并把 `/vault-api/` 转发给回环地址上的 Node.js 服务。
3. Node.js 服务验证独立设备凭据，解析所属用户和能力。
4. 对话请求发送到对应 Codex App Server thread。
5. 事件经过过滤、归一化和持久化后返回客户端。
6. 高风险操作通过审批事件暂停，直到用户明确选择。

## 威胁模型提示

Witt 主要防止未授权设备访问、设备之间的数据混用、路径越界和凭据进入网页存储。它不能消除拥有服务器登录权限的管理员风险，也不能替代操作系统隔离、最小权限、网络策略、加密备份和安全更新。
