# Claude 登录实现

本文说明当前仓库的 Claude 账号连接流程，不包含任何部署实例的账号或登录数据。对话适配能力见[账号与代理接入](PROVIDERS.md)。

## 授权流程

1. 管理员从账号管理入口打开 Claude 登录页。
2. 后端启动已安装的 `claude auth login`，解析允许的授权地址。
3. 用户在服务商页面完成授权，返回的授权码写入正在等待的 CLI 输入。
4. CLI 将结果保存到该用户的私有 `CLAUDE_CONFIG_DIR`。
5. 后端用 `claude auth status --json` 查询状态，只返回界面需要的字段。

登录页使用 15 分钟能力令牌，放在 URL fragment 中，页面取出后清除该片段，并通过请求头发送。每次访问还检查发起设备是否仍为有效管理员。它只授权该用户的登录过程，不是通用管理凭据。

## 路径与执行

实现入口为 `backend/claude-account-service.js`，页面为 `backend/claude-login.html`。默认 CLI 路径和私有根目录是部署约定，迁移服务器或更换运行用户时需要同步调整；不能依赖仓库附带登录状态。

当前源码已通过 `provider-runtime.js` 接入 Claude 对话，并非仅提供登录页。模型名称、推理选项及权限参数由适配器传给 CLI，最终支持情况取决于安装版本和账号权限。

## 检查

```bash
node --test backend/test-claude-account-service.js
```

有 Playwright 和 Chromium 时，还可以运行 `node tests/claude-login-check.mjs`。这些检查使用测试替身或模拟页面，不能替代部署者对真实 CLI 的授权验收。

不要记录授权码、CLI 原始认证输出、完整授权 URL 或凭据文件。代理目录和能力令牌应按敏感数据处理。
