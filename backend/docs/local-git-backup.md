# 本地 git 仓库备份 · 其他设备部署指南

> 适用版本：main @ 6737c05（2026-09-04）及之后。

这套备份通道的形态（用户定调，2026-09-04）：

- **密钥**（API Key、推送凭据等）→ 只走云端账号同步（sully_settings 表，逐键加密），
  **永远不进任何备份包**——导出时前端剥一遍，backend 收包时服务端再扫一遍，命中直接 400 拒收。
- **其他所有数据**（角色 / 聊天 / 帖子 / 记忆宫殿 / 预设 / 外观）→ 前端导出脱敏 zip →
  POST 到本地 backend → 解成 **JSON 文件树** 落盘 → 自动 `git commit`。历史即备份，
  `git diff` 能看每次变化，目录在宿主机上直接可见。
- **恢复 / 换设备** → 空机打开页面时自动从 backend 全量拉回（三道闸门防死循环）；
  密钥登录账号后由 s 表自动补上。
- 手机线（线上站 + GitHub Releases）、Supabase 云同步：**零改动**，照常可用。

---

## 一、第一台 PC：完整部署（docker 全套）

### 前置条件

- Docker Desktop（Windows / macOS / Linux 均可）已装并运行
- Node.js 18+（只用来起 4173 静态页）
- git（Docker 镜像里已自带，宿主机不需要）

### 步骤

```bash
# 1. 克隆公开仓库（无任何密钥，放心克隆）
git clone https://github.com/coldpaper0953/sullyOS-2v.git
cd sullyOS-2v

# 2. 装（backend/ 里的 .env.example 复制成 .env；注意 .env 已从仓库移除，不会再被推上去）
copy backend\.env.example backend\.env        # Windows
# cp backend/.env.example backend/.env         # macOS / Linux
# 把 .env 里的 APP_TOKEN 改成一个自己的随机长串（≥12 字符），其余默认即可

# 3. 起后端（PG17 + migrate + api 三容器，compose 只监听 127.0.0.1）
cd backend && docker compose up -d --build
# 等 /health 通（约 30~60 秒）
curl http://127.0.0.1:43210/health

# 4. 前端：装依赖 → 构建 → 起本地静态服务（4173 端口）
cd ..
npm install -g pnpm   # 没有 pnpm 的话
pnpm install && pnpm build
node scripts/local-static-server.cjs dist
```

Windows 用户直接双击仓库根目录的 **`启动本地全套.bat`**，上面 3~4 步自动完成。

### 浏览器配对（一次性）

1. 打开 `http://127.0.0.1:4173`
2. 设置 → **SullyOS 自主后端** → 「后端地址」填 `http://127.0.0.1:43210`
   （首次不用手填 token：在 backend 目录跑 `docker compose exec api node dist/pairing.js`
   或者直接把 `.env` 里的 APP_TOKEN 粘进高级设置——本机自用两种都行）
3. 设置 → **云端备份** → 点第三格 **「本地后端」** → 显示「已连接 · 本地后端 git 仓库」
4. 开 **「自动备份（每 4 小时一次，纯文本，不含密钥）」**

备份文件树落在 **`backend/data/backup-repo/`**（docker bind mount，宿主机直接可看）：

```
backend/data/backup-repo/
├── manifest.json               # 导入契约（formatVersion / stores 分片清单）
├── metadata.json                # 所有非数组设置（密钥字段一律空串）
└── stores/
    ├── characters.000.json      # 角色（含人设、房间、立绘配置）
    ├── messages.000.json …      # 聊天分片
    └── memory_vectors.bin       # 记忆向量（二进制，git 里 STORE 不压缩）
```

看历史：`git -C backend/data/backup-repo log`；看某次改了什么：`git -C backend/data/backup-repo show`。

---

## 二、第二台 PC：三种接法任选

### 接法 A：拷贝备份仓库目录（最简单）

把第一台的 `backend/data/backup-repo/` 整个目录（含 `.git/`）拷到第二台同样位置，
第二台按「第一台 PC」步骤起栈。空机打开页面 → 自动恢复接管，全部数据回来。
密钥登录云端账号（Supabase 同步）自动补。

### 接法 B：git remote 推拉（两台机器异地 / 想要异地备份）

在第一台上给备份仓库加一个**私有**远端（公开仓库不能拿来做备份！）：

```bash
cd backend/data/backup-repo
git remote add origin <你的私有仓库地址>     # 例：git@github.com:yourname/sully-backup-private.git
git push -u origin main
```

以后每次自动备份的 commit 想同步远端就手动 `git push`（系统**不会**自动推任何远端，
这是有意的：备份默认只留在你电脑上）。第二台 PC 起好栈后：

```bash
cd backend/data/backup-repo
git pull origin main     # 或首次：git clone <私有仓库> data/backup-repo
```

### 接法 C：继续走 GitHub Releases（不装任何东西）

什么都不用做。线上站 / 手机照旧用 GitHub 备份通道，和本地通道互不干扰
（provider 可随时来回切，旧备份不会丢）。

---

## 三、手机连 PC 的本地后端（手机也走 git 仓库备份线）

> ⚠️ **先读这条**：手机不能从线上站（https://coldpaper0953.github.io）直接调 PC 的
> HTTP 后端——HTTPS 页面发起 HTTP 请求会被浏览器的**混合内容（mixed content）策略**
> 无声拦截，请求根本出不了手机（实测抓到）。所以手机连 PC 后端时，手机访问的是
> **PC 上起的本地前端页**，不是线上站。

### PC 侧一次性配置（三步）

```bash
# 1. 后端监听局域网（默认只听 127.0.0.1）
#    docker：compose.yaml 把 api 的端口映射 "127.0.0.1:43210:4310" 改成 "43210:4310"
#    tsx 直跑：环境变量 HOST=0.0.0.0

# 2. 前端静态页也监听局域网
set HOST=0.0.0.0 && node scripts/local-static-server.cjs dist

# 3. 防火墙放行两个端口（Windows，管理员）
netsh advfirewall firewall add rule name="SullyOS Backend 43210" dir=in action=allow protocol=TCP localport=43210
netsh advfirewall firewall add rule name="SullyOS Local Web 4173" dir=in action=allow protocol=TCP localport=4173
```

**CORS 必须加手机页面的源**：后端 `ALLOWED_ORIGINS` 里加上
`http://<PC内网IP>:4173`（例：`http://192.168.2.60:4173`）。漏了这一步手机页会被
后端 CORS 拦掉所有请求。docker 在 compose 的 api 服务 environment 里改；tsx 直跑用
环境变量。

### 手机侧（两步）

1. 手机和 PC 连**同一个 Wi-Fi**，手机浏览器打开 `http://<PC内网IP>:4173`
   （PC 内网 IP 用 `ipconfig` 查，IPv4 地址那行；本机示例 192.168.2.60）。
   想当 App 用就在手机浏览器菜单里「添加到主屏幕」。
2. 设置 → **SullyOS 自主后端**：地址填 `http://<PC内网IP>:43210`，配对或直接填
   APP Token；然后设置 → **云端备份** → 点「本地后端」连接，开启自动备份。

之后手机每 4 小时自动把数据备份进 PC 的 `backend/data/backup-repo` git 仓库，
换手机 / 清后台后打开页面自动全量恢复；密钥仍走云端账号加密同步线。

### 与线上站的取舍

- 手机连 PC 后端 = **只有 PC 开机时才能备份/恢复**（PC 关机则备份静默失败，
  下个周期自动补跑；恢复要等 PC 开机）。
- 想要手机 24 小时都有云端兜底：手机保持 GitHub Releases 线（线上站），
  PC 用本地线——两个设备各走各的 provider，互不干扰。**一台设备的备份目的地只有一个**，
  按设备选择，不是全局的。

### 安全提醒

局域网内所有设备都能访问放行的端口。家用 Wi-Fi 下风险可控，但：
- APP_TOKEN 一定改成自己的随机长串（别用示例 dev token）；
- 在公共网络（公司 / 咖啡店 Wi-Fi）时建议关掉这两条防火墙规则或让 Windows
  把当前网络标记为「公用网络」后只在「专用」配置文件放行。

---

## 四、手机不改任何东西（默认姿势）

手机继续用线上站（https://coldpaper0953.github.io/sullyOS-2v/）+ GitHub Releases 备份 +
Supabase 云同步，行为与本通道上线前完全一致。上面第三节是可选项，只在你想让手机
也进 git 仓库线时才做。

---

## 四、常见问题

**Q：43210 起不来 / CORS 401？**
`backend/.env` 的 `ALLOWED_ORIGINS` 必须包含 `http://127.0.0.1:4173,http://localhost:4173`
（.env.example 已带）。改完 `docker compose up -d` 重生效。

**Q：本机没有 docker？**
可以 `cd backend && pnpm install && pnpm exec tsx src/api.ts` 直接跑
（PG 没起也只影响聊天/心跳，备份通道不碰数据库）。
Windows 注意两点：① `.env` 不会被 tsx 自动读，把 APP_TOKEN/BACKUP_DIR 放环境变量；
② git 不在 PATH 时设 `SULLY_GIT_BIN` 指向 git.exe。

**Q：备份仓库越来越大？**
向量 .bin 文件会随记忆增长。git 历史保留是特性（历史即备份）；真要瘦身可以
`git -C backend/data/backup-repo gc --aggressive`，或把旧 commit 推到私有远端归档后重建仓库
（数据随时可从 IndexedDB 重新全量导出，不用担心）。

**Q：怎么确认备份里没有密钥？**
```bash
grep -rE "sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_" backend/data/backup-repo --include="*.json"
```
无输出 = 干净。服务端在每次上传时也会扫同样的模式，命中直接拒收（400），包根本不会落盘。
