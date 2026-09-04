# 手机 APK 安装线

云端的 `Build Android APK` 流水线把本仓库（含你的全部定制功能）打成安卓安装包，
自动发到 GitHub Release，手机浏览器直接下载安装。

## 首次安装

1. 手机浏览器打开：<https://github.com/coldpaper0953/sullyOS-2v/releases>
2. 下载最新版 `SullyOS-2v-Android-v*.apk`
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
- 混合内容限制：APK 内访问局域网 PC 后端（`http://192.168.x.x:43210`）不受浏览器
  混合内容策略限制（Capacitor 的 `cleartext: true` 已开），比网页版少一层坑

## 与 PC 本地后端的配合

APK 打开的是线上内容 + 本地存储。要连 PC 的本地后端走 git 仓库备份线：
和手机浏览器版一样，在设置 → 自主后端里填 `http://<PC内网IP>:43210` 即可
（PC 侧的放行步骤见 `backend/docs/local-git-backup.md` 第三节）。

## 固定签名证书（保管）

签名 keystore 由仓库 Secrets（`ANDROID_KEYSTORE_B64` 等 4 个）持有，CI 每次构建
自动解密使用。本地备份在 `D:\2026_9.2_项目\sullyso\sullyos-release.p12`
（密码 `sullyos2026`，别名 `sullyos`）——**这三个值丢了以后就没法给已装的 APK 推更新了**，
建议把 p12 文件和密码抄到安全的地方一份。

上游原作者的 APK 签名与本项目无关；如果你从原版 APK 迁过来，旧版数据无法继承
（签名不同的两个安装包在安卓里是两个独立应用）。
