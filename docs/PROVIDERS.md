# 账号与代理接入

Witt 使用部署者自行安装和授权的 CLI。它不分发账号凭据，不提供订阅或额度，也不保证一个账号能够使用界面中所有模型。

## 适配方式

| 接入 | 实现入口 | 能力来源与限制 |
| --- | --- | --- |
| Codex | `app-server-client.js`、`codex-account-service.js` | 从当前账号的 App Server 查询模型及能力 |
| Claude Code | `claude-account-service.js`、`provider-runtime.js` | CLI 登录、流式会话；模型选择由适配器映射，账号仍需有访问权限 |
| Antigravity | `antigravity-account-service.js`、`provider-runtime.js` | CLI 登录与模型目录；可用性受账号、地区资格和额度影响 |

当前 Claude/Antigravity 适配器不提供与 Codex 等价的分支、压缩、审查、技能与 MCP 目录。已有 Codex 对话不会仅因登录另一服务就自动转换成该服务的原生会话。

## 部署配置

- `backend/server.js` 的 `codexProfiles` 定义账号标识、Codex 登录目录和项目工作目录。
- Claude 服务默认 CLI 为 `/home/ubuntu/.claude-cli/node_modules/.bin/claude`，私有目录根为 `/home/ubuntu/.claude-witt`。
- Antigravity 服务默认 CLI 为 `/home/ubuntu/.local/bin/agy`，私有目录根为 `/home/ubuntu/.antigravity-witt`，登录辅助程序需要 Python 3。
- 这两个服务的 CLI、目录、HOME 和工作路径尚未统一环境变量化。使用其他系统用户时需要调整服务实现及初始化参数，不能只改 systemd 的 `User=`。

只配置和启用自己需要的账号。保留的 `xuanyu`、`account4`、`account5` 是账号标识示例，不会附带任何可用登录数据。

## 登录与凭据

账号连接入口要求管理员身份。Claude 和 Antigravity 使用对应服务的授权流程，登录结果保存在私有 CLI 目录。前端接收授权状态和必要的脱敏账号信息，不应接收原始凭据文件。

短期登录入口绑定发起设备和用户。设备停用后不应继续使用旧入口。不要共享授权链接、授权码、登录目录或 CLI 输出；详细的 Claude 流程见 [Claude 登录实现](claude-login.md)。

## 执行权限

沙箱和审批参数由各适配器分别映射。在启用管理员完全访问前，先审查 `execution-policy.js` 和 `provider-runtime.js`：不同 CLI 的权限机制和能力不完全相同。

登录成功只证明认证流程完成，不保证模型访问、地区资格或剩余额度。部署验收应包括一次低成本、无破坏性的真实任务，并确认事件、取消及错误提示正常。
