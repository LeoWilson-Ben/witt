# 参与贡献

欢迎报告问题、完善文档和提交代码。先搜索现有 Issue；协议变更、数据迁移和较大功能请先说明使用场景与兼容性影响。

## 本地开发

使用 Node.js 22.16 或更高版本。后端无第三方 npm 运行时依赖，Web 无打包步骤。准备测试实例时参考[部署指南](docs/DEPLOYMENT.md)，不要复用生产数据库或登录目录。

基础检查：

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

截至 2026-11-02，`backend/test-multitask.js` 的 4 个用例在未修改的 `ce690a3` 基线上也失败，涉及并发任务与工作目录冲突策略；本次文档更新未修改或跳过这些断言。其他检查结果应分别记录，不应将整套检查标记为通过。

上述列表不是完整测试套件；按修改涉及的存储、图片、账号、SSE、UI 等模块补充运行相应检查。

## 浏览器与 Android

浏览器检查需要自行安装 Playwright 和 Chromium，再运行对应 `tests/*.mjs`。部分测试有本机路径约定，先阅读脚本再执行。`tests/app-server-capabilities-check.cjs` 使用真实 Codex 账号，需单独配置及授权，不能作为默认离线检查。

界面修改至少检查窄屏手机、桌面面板、横屏、长文本及滚动场景。协议修改需兼顾两个 Web 入口与 Android 原生桥。

修改源样式后运行 `python3 tools/rebuild-web-styles.py`，提交源文件及生成结果。Android 修改需要与 JDK 17、SDK 35、AGP 8.9.1 兼容的环境，并验证 Release 变体；签名文件保留在仓库之外。

## 提交要求

- 一个 PR 聚焦一个问题，说明触发条件、行为变化、验证结果及迁移影响。
- 认证、权限、路径和执行策略变更需要覆盖拒绝访问的场景。
- 测试使用虚构账号、路径和凭据，不访问生产服务。
- 不提交数据库、用户附件、CLI 登录目录、私钥、签名包、日志或私有环境配置。
- 不覆盖工作副本已有的未提交改动，不把环境专用部署补丁混入公共示例。

文档改动需检查相对链接、文件名、配置变量及命令是否与当前源码一致。请勿把未经验证的能力写成保证。

## 问题与安全报告

普通 Bug 请包含系统和运行时版本、复现步骤、预期与实际结果，以及脱敏日志。安全问题按 [SECURITY.md](SECURITY.md) 私密报告，不在公开 Issue 中展示真实访问数据。

贡献内容按项目 [MIT License](LICENSE) 发布。提交者应有权贡献这些内容，并保留第三方许可证及声明。
