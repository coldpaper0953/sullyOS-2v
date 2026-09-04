# 手机 APK 安装线

云端的 `Build Android APK` 流水线把本仓库（含你的全部定制功能）打成安卓安装包，
自动发到 GitHub Release，手机浏览器直接下载安装。

## 首次安装

1. 手机浏览器打开：<https://github.com/coldpaper0953/sullyOS-2v/releases>
2. 下载最新版 `SullyOS-2v-Android-v1.0.6.apk`（34 MB）
3. 点开下载的文件 → 系统会提示「允许安装未知应用」→ 允许 → 安装
4. 装完打开即用。数据存在本机（IndexedDB），卸载会丢，记得备份

## 升级新版


重新触发流水线（GitHub 仓库 → Actions → Build Android APK → Run workflow，
填个更大的版本号）或推 `android-v*` 标签。新 APK 出来后直接覆盖安装——
历代 APK 用同一个固定签名，覆盖安装不丢数据。

> 注意：本 APK 与上游原作者（qegj567-cloud）发布的 APK **签名不同**，
> 如果你装过原版，需要先卸载原版再装本 APK（原版数据不会跟过来，先在原版里备份导出）。

## APK 里有什么 / 没有什么

- 有：本仓库全部 web 功能（角色、聊天、云同步、GitHub 备份、本地后端备份……）
- 应用内「检查更新」按钮：**隐藏**（指向上游签名会装失败），升级一律走 Release 覆盖安装
- UnifiedPush 主动消息推送：原生插件已内置；要用的话在手机上装无 Firebase 版 ntfy
  并允许后台运行，应用内的推送注册会自动发现它
- 混合内容：APK 页面本身是 `https://localhost`，调 HTTP 地址（局域网 PC 后端、自建
  网关）属于混合内容。`server.cleartext` 只管 Android 网络层，WebView 还得靠
  `android.allowMixedContent: true`——v1.0.6 起已开，两者缺一 APK 就连不上 HTTP 服务

## 聊天 API 配置（重要）

**tokenrouter 直连在任何浏览器/APK 里都不可能成功**：它的 WAF（openresty）对任何
带 `Origin` 请求头的请求一律返回 403 且不给 CORS 头，浏览器只能报
「TypeError: Failed to fetch」。实测（2026-09-05）：

| 客户端 | Origin | 结果 |
|---|---|---|
| curl 不带 Origin | — | 401（要鉴权，说明服务本身通） |
| curl 带 `Origin: https://localhost` | APK | **403** |
| curl 带 `Origin: http://127.0.0.1:4173` | 本地页 | **403** |
| curl 带 `Origin: https://coldpaper0953.github.io` | 线上站 | **403** |
| 真浏览器 fetch（本地页） | 本地页 | **Failed to fetch** |

注意这比 `worker/api-proxy/README.md` 里写的更严——连 localhost 也不放行了。
所以必须走服务端转发，二选一：

1. **自建网关**（已在跑）：地址填 `http://43.138.251.91:4000/v1`，密钥用网关自己签发的
   Key。网关预检返回 `access-control-allow-origin: *`，浏览器可直连。
   限制：网关是 HTTP，只有 APK（v1.0.6 起）与本地页能用，**HTTPS 线上站会被混合内容挡掉**。
2. **api-proxy Worker**（仓库自带、全平台通）：`cd worker/api-proxy && wrangler login && wrangler deploy`，
   然后地址填 `https://sullyos-api-proxy.<你的子域>.workers.dev/v1`，密钥和模型名不用改。
   HTTPS，线上站/APK/本地页都能用。

地址栏必须带 `/v1` 结尾（应用代码是 `baseUrl + /chat/completions`）。

## 与 PC 本地后端的配合

APK 打开的是线上内容 + 本地存储。要连 PC 的本地后端走 git 仓库备份线：
在设置 → 自主后端里填 `http://<PC内网IP>:43210`（**不能留默认的 127.0.0.1**——
手机上那是手机自己，会一直刷 `/v1/events/cursor` 连接失败），
PC 侧的放行步骤见 `backend/docs/local-git-backup.md` 第三节。

## 固定签名证书（保管）

签名 keystore 由仓库 Secrets（`ANDROID_KEYSTORE_B64` 等 4 个）持有，CI 每次构建
自动解密使用。本地备份在 `D:\2026_9.2_项目\sullyso\sullyos-release.p12`
（密码 `sullyos2026`，别名 `sullyos`）——**这三个值丢了以后就没法给已装的 APK 推更新了**，
建议把 p12 文件和密码抄到安全的地方一份。

上游原作者的 APK 签名与本项目无关；如果你从原版 APK 迁过来，旧版数据无法继承
（签名不同的两个安装包在安卓里是两个独立应用）。
