# 开放版与自动登记

开放版是可选部署模式：Android 客户端首次使用时向专门的登记接口申请普通设备身份，免去人工分发邀请码。**仓库公开不等于必须开放服务器登记**；默认自托管使用邀请码即可。

## 当前实现

`backend/open-enrollment-server.js` 只监听 `127.0.0.1:3004`，通过主服务的管理 API 创建一次性邀请、登记普通设备并设置账号策略。

- 客户端获得独立设备凭据，不得到管理员凭据或服务端的一次性邀请。
- 默认授予 `default`、`xuanyu`、`account4`、`account5` 账号标识和不受应用模型白名单限制的策略；部署者启用前必须审查并调整 `PROFILES` 和策略设置。
- 应用内模型白名单放宽不会增加服务商额度，也不保证所有模型可用。
- 每个来源 IP 每小时默认最多登记 30 次；这是登记限流，不是任务或模型消耗配额。
- 设备重复登记会被拒绝，重装应用可能生成新设备身份。

普通设备不能创建邀请码或执行管理员操作。数据按用户归属管理；系统级隔离仍由部署者负责。

## 服务配置

| 配置 | 默认值 |
| --- | --- |
| `WITT_OPEN_CONFIG` | `/data/drop-vault/auth/open-enrollment.json` |
| `WITT_OPEN_ADMIN_TOKEN` | `/data/drop-vault/auth/open-enrollment-service.token` |
| 主 API 地址 | 代码内的 `http://127.0.0.1:3003/` |
| 登记服务地址 | `127.0.0.1:3004` |

配置文件只有在 `enabled` 为 `true` 时才允许登记；缺失、解析失败或关闭时拒绝新登记。内部管理令牌必须由部署者安全配置并限制为服务用户可读，不能写入 APK、网页或日志。

Nginx 需要为 `/vault-api/auth/open-enroll` 单独路由到登记服务的 `/auth/open-enroll`，其余 API 仍交给主服务。示例主 Nginx 配置不包含这条额外路由。确保可信代理覆盖 `X-Real-IP`，不要允许客户端伪造来源地址。

[`deploy/witt-open-enrollment.service`](../deploy/witt-open-enrollment.service) 仍含原部署用户和目录，使用前需要调整。

## Android 构建

设置 `wittOpenAccess=true` 并使用独立包名、标签和更新清单，例如：

```text
-PwittApplicationId=com.example.witt.open
-PwittOpenAccess=true
-PwittAppLabel=Witt 开放版
-PwittWebUrl=https://witt.example.com/vault/index.html
-PwittApiUrl=https://witt.example.com/vault-api/
-PwittUpdateUrl=https://witt.example.com/vault/update-open.json
```

签名、版本号、备用地址仍按主 README 配置。不要把示例域名当作可用公共服务。

## 启用前验证

运行 `node --test tests/open-enrollment-check.cjs`，并在隔离测试实例核对新设备不是管理员、账号策略正确、停用后拒绝访问、不同用户无法通过 API 读取彼此数据。

暂停新登记只需关闭配置中的 `enabled`；这不会自动停用已登记设备。已有设备需要通过管理功能单独停用。开放给不受信任用户前，还需额外配置执行隔离、模型配额和滥用控制。
