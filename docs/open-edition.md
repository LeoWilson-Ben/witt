# Witt 开放版

开放版是可选部署方式：允许拿到 APK 的用户自动登记为普通用户，不提供激活码分发功能。部署者需自行决定开放的模型账号及额度策略。

开放版使用包名 `com.codevibe.dropvault.open`，应用名“Witt 开放版”。与大阪版独立安装；现有大阪版保持原来的更新通道。开放版通道为 `https://witt.example.com/vault/update-open.json`。

首次启动时，客户端通过 `POST /vault-api/auth/open-enroll` 自动登记设备。每台设备获得独立的普通用户身份，允许 `default`、`xuanyu`、`account4`、`account5` 和不受应用模型白名单限制的模型。各模型服务商的账号额度仍照常消耗。客户端凭据由 Android Keystore 加密保存，不内置模型 Key、共享登录密钥或管理员凭据。

开放版不具备后台管理和创建激活码权限。设备凭据失效后不会静默替换为另一个身份；重新安装会登记新的身份。聊天和文件的 API 存储按用户隔离。

`witt-open-enrollment.service` 仅监听 `127.0.0.1:3004`。Nginx 只转发 `/vault-api/auth/open-enroll`，它通过现有主服务的管理 API 登记设备、授予模型账号权限，然后返回普通设备凭据。内部管理凭据只保存在服务器 `/data/drop-vault/auth/open-enrollment-service.token`（0600），不返回客户端、不输出日志。内部一次性邀请仅用于调用既有认证 API，不交付或展示给用户。主服务无需为此重启。

新设备每个来源 IP 每小时最多登记 30 次，已有设备的使用不受这个登记保护影响。暂停新设备登记可将 `/data/drop-vault/auth/open-enrollment.json` 的 `enabled` 改成 `false`；已登记设备仍按既有权限工作。设备禁用沿用原有管理后台。

构建参数：

```text
-PwittApplicationId=com.codevibe.dropvault.open
-PwittVersionCode=45
-PwittVersionName=2.2.26
-PwittOpenAccess=true
-PwittAppLabel=Witt 开放版
-PwittUpdateUrl=https://witt.example.com/vault/update-open.json
```

实际编译在远程 x86_64 构建机完成，签名在主服务器执行，私钥留在服务器。

验证：`node --test tests/open-enrollment-check.cjs`、既有认证回归测试、真实公网登记与权限核验、桌面和手机的免激活界面检查。
