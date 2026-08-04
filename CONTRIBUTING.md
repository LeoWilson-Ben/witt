# 参与贡献

感谢你帮助改进 Witt。

## 开始之前

1. 搜索现有 Issue，避免重复工作。
2. Bug 请提供系统版本、Node.js 版本、复现步骤、预期行为和经过脱敏的日志。
3. 较大的功能、协议变更和数据迁移请先开 Issue 讨论。
4. 不要在 Issue、截图、测试夹具或提交中包含令牌、邀请码、邮箱、项目数据和服务器地址。

## 本地开发

后端要求 Node.js 22.5 以上。Web UI 无需打包，Android 端要求 JDK 17 和 Android SDK 35。

提交前至少运行：

```bash
node --check backend/server.js
node --check backend/chat-service.js
node tests/auth-service-check.cjs
node tests/chat-images-check.cjs
node tests/chat-approval-check.cjs
node tests/app-server-capabilities-check.cjs
node tests/ui-check.mjs
```

Android 相关改动还应运行 Release 变体的编译或构建检查。请勿提交签名 APK、keystore、`signing.properties`、本地媒体、数据库或运行时目录。

## Pull Request

- 一个 PR 只解决一个清晰的问题。
- 说明行为变化、风险、迁移步骤和验证结果。
- UI 修改请同时验证 360px 手机、620px 面板和横屏布局。
- 认证、审批、文件路径和命令执行修改必须包含负向测试。
- 保持向后兼容；无法兼容时需要明确的迁移说明。

提交信息建议使用简洁的 Conventional Commits，例如 `fix: keep account actions horizontal`。

## 许可证

提交代码即表示你有权贡献该内容，并同意贡献内容按项目的 MIT License 发布。
