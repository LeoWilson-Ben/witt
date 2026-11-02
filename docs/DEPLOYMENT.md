# 部署指南

本指南用于新的自托管部署。升级已有实例前先备份数据库、用户文件和私有配置，不要在生产数据目录重复初始化管理员。

## 1. 准备环境

使用 Linux、Node.js 22.16 或更高版本，安装并登录所需 CLI。建议用专用系统用户运行服务，明确它可访问的项目目录。

仓库的 `backend/server.js` 仍保留原部署路径：`codexProfiles`、可选项目集成和部分 CLI 服务目录不是通用配置。部署前搜索并核对 `/home/ubuntu`、`/data/` 等路径，调整为本机目录；无需使用的项目集成不应在反向代理中额外开放。

## 2. 创建私有运行目录

以下命令从仓库根目录执行，只适用于新的本地实例。令牌只写入文件，不打印。

```bash
umask 077
mkdir -p runtime/{files,tasks,chat,chat-images,users,auth,secrets}
test -s runtime/secrets/api-token || openssl rand -hex 32 > runtime/secrets/api-token
chmod 700 runtime runtime/auth runtime/users runtime/secrets
chmod 600 runtime/secrets/api-token

export DROP_VAULT_PORT=3003
export DROP_VAULT_DATA_DIR="$PWD/runtime/files"
export DROP_VAULT_TASK_DIR="$PWD/runtime/tasks"
export DROP_VAULT_CHAT_DIR="$PWD/runtime/chat"
export DROP_VAULT_IMAGE_DIR="$PWD/runtime/chat-images"
export DROP_VAULT_USERS_DIR="$PWD/runtime/users"
export DROP_VAULT_AUTH_DIR="$PWD/runtime/auth"
export DROP_VAULT_TOKEN_FILE="$PWD/runtime/secrets/api-token"
export DROP_VAULT_CODEX_BIN="$(command -v codex)"
export DROP_VAULT_CODEX_WORKDIR="$PWD"
```

兼容令牌仍被服务启动流程读取，但不是普通用户的设备凭据。把它视为高权限服务器凭据，不放入 APK、网页源码或请求日志。

生产环境可参考 [`deploy/witt.env.example`](../deploy/witt.env.example)；EnvironmentFile 中使用绝对路径，不依赖 shell 变量展开。

## 3. 初始化管理员

`admin-cli.js` 使用 `WITT_*` 变量，名称与主服务的 `DROP_VAULT_*` 不同，必须指向同一批目录。

```bash
WITT_AUTH_DIR="$DROP_VAULT_AUTH_DIR" \
WITT_USERS_DIR="$DROP_VAULT_USERS_DIR" \
WITT_LEGACY_CHAT_DIR="$DROP_VAULT_CHAT_DIR" \
WITT_LEGACY_FILES_DIR="$DROP_VAULT_DATA_DIR" \
WITT_LEGACY_IMAGE_DIR="$DROP_VAULT_IMAGE_DIR" \
node backend/admin-cli.js init --server-init
```

该命令生成管理员恢复凭据和首次邀请码，写入认证目录下权限为 `600` 的 `recovery-password.txt`、`bootstrap-admin-invite.txt`，终端只显示文件路径。请由管理员在本机安全读取，并妥善保管；不要上传、粘贴到公共日志或提交 Git。

初始化程序会将指定的旧会话、文件和图片目录迁入新管理员用户目录。对已有数据部署，这是数据迁移操作，必须先备份并确认路径。

## 4. 启动和检查

```bash
node backend/server.js
```

另开终端：

```bash
curl --fail http://127.0.0.1:3003/health
```

预期 HTTP 200，响应中的 `ok` 为 `true`，并附带执行隔离策略字段。随后还需通过激活设备、查询可用账号和一次真实任务验证完整链路。健康检查不会验证 CLI 授权或模型额度。

## 5. 配置 HTTPS 和静态资源

将 `web/` 部署到静态目录，参考 [`deploy/upload-entry-https.conf`](../deploy/upload-entry-https.conf)：

- `/vault/` 提供 Web 资源。
- `/vault-api/` 转发到 `127.0.0.1:3003/`，保留路径前缀移除规则。
- SSE 需要关闭代理缓冲，并允许较长连接。
- 使用真实域名及有效证书，API 不直接监听公网。

浏览器会话 Cookie 标记为 Secure，正式登录需要 HTTPS。不要为方便本地测试而删除 Cookie 安全属性。初始化后，使用首次邀请码激活设备，再由管理员创建后续邀请。

systemd 示例为 [`deploy/drop-vault.service`](../deploy/drop-vault.service)。启用前修改用户、工作目录、Node 路径、环境文件及保护策略。`ProtectHome=read-only` 可能阻止 CLI 写入位于 home 下的登录或会话数据，需要按实际目录配置写入权限。

## 6. 备份与恢复

备份脚本扫描 `DROP_VAULT_ROOT` 下的文件；自定义各数据目录不会自动改变它的扫描范围。应将运行数据归于同一根目录，并确保备份目录不位于将被递归扫描的数据子目录中。

```bash
export DROP_VAULT_ROOT="$PWD/runtime"
export DROP_VAULT_BACKUP_ROOT="$HOME/.local/state/witt/backups"
node backend/backup.js
```

脚本使用 SQLite 在线备份 API，并生成含大小及 SHA-256 的清单。完成后指定实际快照目录验证：

```bash
node backend/backup.js verify /absolute/path/to/snapshot
```

默认保留 7 份已完成快照，可用 `WITT_BACKUP_RETENTION` 调整。备份包含凭据和用户数据，必须保持私有。CLI 登录目录、签名密钥和系统配置若在扫描范围外，应另行备份。

恢复时先停服务、保留当前数据副本，再按快照清单恢复到对应路径并校正属主和权限。不要把旧 WAL/SHM 文件混入已恢复的数据库。先在隔离环境演练，再恢复生产实例。

## 可选组件

- [账号与代理接入](PROVIDERS.md)：Claude、Antigravity 以及多 Codex 账号。
- [开放版登记](open-edition.md)：额外的公开设备登记服务，需要单独评估额度和权限。
- Android：见 [README](../README.md#android-客户端)，自行配置域名、签名和更新清单。

本指南不提供生产账号、密钥、证书、附件或用户数据库。
