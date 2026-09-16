# 📈 FundWatch · 天天基金数据 Web UI

基于天天基金（东方财富）公开数据接口的基金盯盘应用：**账号登录 + 自选基金（SQLite 持久化）+ 盘中实时估值 + 后台管理**，一套页面自适应 PC / Android / iOS。

| 维度 | 说明 |
|---|---|
| **数据存储** | Node 内置 `node:sqlite`（无需任何数据库服务），**自选只存账号，不用浏览器本地存储**；WAL + 三重 checkpoint 保障**重启不丢数据** |
| **运行时依赖** | **零 npm 运行时依赖**：SQLite 用 `node:sqlite`，密码/会话用 `node:crypto`，开发服务器自研轻量实现（仅 `vercel` CLI 为部署可选依赖） |
| **Node 版本** | ≥ 22.5（`node:sqlite` 要求），已在 `package.json` / `vercel.json` 声明 |
| **前端** | 单文件 `index.html`（原生 JS + Canvas，无构建步骤） |
| **部署** | Vercel（静态 + Serverless）或任意有持久磁盘的 Node 环境 |

---

## 快速开始

```bash
cd fund-watch-web
npm run dev          # 启动本地服务器 → http://localhost:8787（自动建库 + 内置管理员 + 打印扫码二维码）
```

- 管理员账号：**`root / root`**（首次启动自动写入 SQLite，见第五节·后台管理）
- 自选基金需要登录后使用；未登录会引导登录
- 手机调试：扫终端二维码，或访问 `http://<局域网IP>:8787`

---

## 一、功能一览

| 页面 | 功能 | 接口 |
|---|---|---|
| 📌 自选 | 自选列表 + 盘中估值 + 30s 自动刷新 + 删除/跳详情（**需登录**） | `/api/watchlist` + `/api/estimate` |
| 🔍 搜索 | 按名称 / 代码 / 拼音缩写搜基金，一键加入自选 | `/api/search` |
| ⚡ 实时估值 | 批量输入最多 10 个代码查盘中估值，可一键全部加入自选 | `/api/estimate` |
| 📊 详情 | 基本信息、费率、近1月/6月/1年/3年收益、净值走势 Canvas 图、历史净值表 | `/api/detail` + `/api/nav` |
| 👤 账号 | 注册 / 登录 / 登出、会话保持（30 天）、登录态跨设备同步自选 | `/api/auth/*` |
| 🛠 后台 | 总览统计、用户列表与自选明细、重置密码、删除用户（**仅管理员可见**） | `/api/admin/*` |

---

## 二、架构与接口

```
浏览器(index.html)
 ├─ 公开数据（无需登录）
 │    ├─ GET /api/search?key=xx              基金搜索（fundsuggest.eastmoney.com）
 │    ├─ GET /api/nav?code=xx&page=&size=    历史净值（api.fund.eastmoney.com/f10/lsjz）
 │    ├─ GET /api/estimate?codes=a,b         盘中估值（fundgz → 失败自动降级为最新净值）
 │    └─ GET /api/detail?code=xx             基金详情（服务端拉取 pingzhongdata 并解析）
 ├─ 账号与自选（SQLite，需登录）
 │    ├─ POST   /api/auth/register           注册（自动登录）
 │    ├─ POST   /api/auth/login              登录（下发 HttpOnly 会话 Cookie）
 │    ├─ POST   /api/auth/logout             登出（销毁会话）
 │    ├─ GET    /api/auth/me                 当前登录用户
 │    ├─ GET    /api/watchlist               自选列表
 │    ├─ POST   /api/watchlist               新增自选 / {mode:'sync',items:[…]} 批量导入
 │    └─ DELETE /api/watchlist/{code}        删除自选
 ├─ 后台管理（仅管理员）
 │    ├─ GET    /api/admin/stats             总览统计
 │    ├─ GET    /api/admin/users?q=&page=&size=  用户列表（含自选数）
 │    ├─ GET    /api/admin/users/{id}        用户详情 + 自选明细
 │    ├─ POST   /api/admin/users/{id}        {action:'resetPassword', password}
 │    └─ DELETE /api/admin/users/{id}        删除用户（级联）
 ├─ 兜底直连（仅当 /api/detail 不可用时）fund.eastmoney.com/pingzhongdata/{code}.js
 └─ 调试辅助  GET /api/health · GET /__qr（放大版扫码页）
```

**一套逻辑，两处运行**：账号/自选/后台的业务实现集中在 `server/*.cjs`（`db` / `auth` / `handlers`），**本地开发服务器与 Vercel 函数复用同一套代码**——`api/**/*.js` 只是薄适配层，不存在两份逻辑。

### 为什么要服务端代理？
东方财富系列接口**不返回 CORS 头**，浏览器 `fetch` 无法直连。因此搜索、历史净值、**基金详情**统一走 `/api/*` 代理；详情数据由服务端解析 `pingzhongdata` 后返回 JSON，**手机端无需直连东方财富域名**（规避手机网络/DNS 拦截导致的「脚本加载失败」）。仅当代理不可用时，前端才回退到 `<script>` 直连。

### 盘中估值的多级降级（重要）
`fundgz.1234567.com.cn` 对**部分网络 / 海外 IP**（如 Vercel 默认美国区）可能返回 404，程序已做兜底：

1. 先请求 `fundgz` → 成功返回 `available: true` 的真实盘中估值；
2. 失败自动降级为 `f10/lsjz` **最新历史净值**（`available: false`，前端标注「净值(非盘中)」）；
3. 详情页净值走势走 `pingzhongdata`（服务端代理优先，浏览器直连兜底）。

> Vercel 部署时可在 `vercel.json` 配 `"regions": ["hkg1"]`（香港区对东方财富连通性通常更好），或接受降级展示。

---

## 三、用户系统与数据存储

### 数据表（`server/db.cjs` 启动自动建表，WAL 模式）
| 表 | 字段 | 说明 |
|---|---|---|
| `users` | id, username(唯一), password_hash, salt, **role**(admin/user), created_at | 用户与角色 |
| `sessions` | token_hash(主键), user_id, created_at, expires_at | 登录会话（30 天） |
| `watchlist` | id, user_id, code, name, created_at，唯一约束 (user_id, code) | 账号自选 |

> **旧库兼容**：启动时自动检测并 `ALTER TABLE` 补 `role` 列，已有用户默认 `user`。

### ✅ 已剔除浏览器本地存储
- 自选**全部存放于服务端 SQLite**；前端不写 `localStorage` / `sessionStorage` / IndexedDB，**清缓存不丢数据**
- 未登录时：自选页显示「🔒 自选基金保存在账号中，登录后即可使用」+ 登录按钮；点「加入自选」自动弹登录框；直接调用 `/api/watchlist` 返回 **401**
- 旧版本遗留的本地键 `fundWatch:favs` 会在页面加载时**一次性删除**（只删不写，全站唯一一处 localStorage 调用就是这行删除）

### 数据库位置与持久化（重启不覆盖）
路径解析（`server/db.cjs`）：
1. **环境变量 `DB_PATH`**（显式指定，生产环境应指向持久化卷/磁盘）
2. **项目内 `<root>/data/fundwatch.db`**（本地默认）——**会真实探测目录可写性**（写入探针文件），可写就用它
3. 仅当项目目录**不可写**时才回退系统临时目录，并在启动横幅与日志中打印**醒目警告**

| 环境 | 路径 | 持久性 |
|---|---|---|
| 本地（`npm run dev`） | `<项目>/data/fundwatch.db` | ✅ 持久（已 `.gitignore`） |
| `vercel dev`（本地） | `<项目>/data/fundwatch.db` | ✅ 持久（项目目录可写，**不会再落到 /tmp**） |
| 生产（设了 `DB_PATH`） | 你指定的路径 | ✅ 持久 |
| Vercel 生产（未设 `DB_PATH`） | `/tmp/fundwatch.db` | ⚠️ 临时，启动时会大声警告 |

**三重落盘保障**（关键：Windows 下 `SIGTERM` 是强制终止，不能只依赖退出钩子）：
1. **每次写操作后主动 checkpoint**（注册/登录/登出/增删自选/后台删改）→ 数据立刻合并进主库文件
2. **服务启动时 checkpoint** → 兜住任何残留 WAL，重启后主库即完整
3. **优雅退出时 checkpoint 并 close**（Ctrl+C / SIGINT）→ 清理 `-wal`/`-shm` 边车文件
4. 另设 `PRAGMA wal_autocheckpoint=32`（WAL > ~128KB 自动合并）

因此**只保留单个 `fundwatch.db` 文件（丢掉 WAL/SHM）也不会丢数据**，可直接拷贝迁移。

### 数据库运维命令
```bash
npm run db:info         # 查看路径、是否持久化、用户/自选/会话数量、主库与 WAL 大小
npm run db:backup       # 生成一致性快照 → data/backups/fundwatch-<时间>.db（VACUUM INTO，服务运行中也安全）
npm run db:checkpoint   # 手动把 WAL 合并回主库（单文件即完整）
npm run test:persistence# 持久化专项测试（重启/崩溃/单文件迁移 共 11 项断言）
```
- **恢复**：停服后用备份文件覆盖 `DB_PATH` 指向的数据库文件即可（已验证备份可直接启动使用）
- **建议**：生产环境给 `db:backup` 挂个定时任务（如每天 2:00），并把备份同步到另一块盘/对象存储

**自检**：`GET /api/health` 会返回数据库信息（路径、是否持久化、数据量、文件大小），一眼确认数据落在哪里：
```json
{ "ok": true, "db": { "path": "…/data/fundwatch.db", "persistent": true,
  "fileSize": 40960, "walSize": 0, "users": 3, "admins": 1, "watchlistItems": 12, "activeSessions": 2 } }
```

### 安全设计
- **密码**：`node:crypto` scrypt + 每用户随机 16 字节盐，`timingSafeEqual` 比对防时序攻击，**不存明文**
- **会话**：32 字节随机 token 下发 Cookie，**数据库仅存 SHA-256 哈希**；Cookie 为 `HttpOnly; SameSite=Lax`，生产环境自动加 `Secure`；改密后该用户所有旧会话立即失效
- **越权防护**：自选接口全部校验会话，且以 `user_id` 为查询条件（无法读写他人数据）
- **后台鉴权**：`requireAdmin()` 统一守卫——未登录 401、非管理员 403
- **输入校验**：用户名 3–20 位（字母/数字/下划线/中文/连字符）、密码 6–72 位、基金代码 6 位数字
- **信息最小化**：登录失败统一提示「用户名或密码不正确」；接口返回**不含** `password_hash` / `salt`
- **SQL 安全**：全部使用参数化语句，无注入风险

---

## 四、后台管理（仅管理员）

### 入口与账号
- **默认管理员 `root / root`**：服务首次启动时自动写入 SQLite（日志会打印创建提示）
- **可覆盖**：环境变量 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（例：`ADMIN_PASSWORD='强密码' npm run dev`）
- ⚠️ **部署公网前务必改密**（用环境变量重设，或用后台「重置密码」功能）
- **入口**：管理员登录后顶部出现 **🛠 后台** 标签；也可直达 `http://localhost:8787/#admin`
- 普通用户/未登录用户看不到入口，强行调用接口被拒（403 / 401）

### 能力
| 功能 | 说明 |
|---|---|
| 总览统计 | 注册用户数、管理员数、自选总条数、有自选的用户数、活跃会话数 |
| 用户列表 | ID / 用户名 / 角色 / 注册时间 / **自选数** / 活跃会话，支持按用户名搜索 |
| 查看自选明细 | 列出该用户添加的全部基金（代码 + 名称 + 添加时间） |
| 重置密码 | 设定新密码，**该用户所有旧会话立即失效** |
| 删除用户 | 级联删除其自选与会话；**禁止删除管理员**，也不能删除当前登录账号 |

---

## 五、本地运行与调试（零安装）

自带轻量开发服务器（纯 Node 内置模块，效果等同 `vercel dev`）：

```bash
npm run dev            # 启动 → http://localhost:8787（自动打印手机扫码二维码）
npm run dev:watch      # 启动 + 文件变更自动重启（api/*.js 热重载）
npm run dev:open       # 启动并自动打开浏览器
npm run dev:no-qr      # 启动但不打印终端二维码
# 等价直调：
node scripts/dev-server.mjs
node --watch scripts/dev-server.mjs
PORT=9000 node scripts/dev-server.mjs        # 自定义端口
```

启动横幅会显示本机地址、**局域网地址**、SQLite 路径与接口清单：

```
┌──────────────────────────────────────────────────────────┐
│  📈 FundWatch 本地调试服务器                              │
│  本机   http://localhost:8787                            │
│  局域网 http://192.168.0.101:8787                        │
│  数据   SQLite: …\fund-watch-web\data\fundwatch.db       │
│  账号   /api/auth/*  /api/watchlist                       │
└──────────────────────────────────────────────────────────┘
📱 手机扫码打开（确保手机与电脑在同一 Wi-Fi）：
   ██▀▀▀▀▀██ ▄▄ ██  ← 终端二维码，手机相机直接扫
```

### 📱 手机扫码调试
- 终端**直接打印可扫二维码**（零依赖自研编码器：字节模式、版本 1–10、纠错 L/M/Q/H、掩码罚分选优）
- 放大版扫码页：电脑打开 `http://localhost:8787/__qr`（支持 `/__qr?url=http://任意地址`）
- 关闭二维码：`npm run dev:no-qr`

### 调试要点
- **前端**：`F12` → Console/Network 看请求与报错；静态文件已禁缓存，改完刷新即可
- **接口自测**（可直接浏览器打开）：
  | 用途 | 地址 |
  |---|---|
  | 健康检查 | `/api/health` |
  | 搜索 | `/api/search?key=中证A500` |
  | 净值 | `/api/nav?code=161725&size=5` |
  | 估值 | `/api/estimate?codes=161725,000001` |
  | 详情 | `/api/detail?code=161725` |
  | 当前用户 | `/api/auth/me` |
  | 自选列表 | `/api/watchlist`（未登录 401） |
  | 后台统计 | `/api/admin/stats`（需管理员） |
- **服务器日志**：每条请求打印 ✅/❌ 状态与耗时；`/api/*` 抛错打印完整堆栈
- **端口被占用**：提示「端口已被占用」，换 `PORT=9000 …` 即可
- **手机打不开**：确认同一 Wi-Fi + Windows 防火墙放行 Node.js

---

## 六、多端自适应（PC / Android / iOS / 平板 / 横屏）

同一套页面按断点自适应，无需独立移动端页面：

| 断点 | 目标设备 | 关键适配 |
|---|---|---|
| `≥1024px` | PC / 大屏 | 容器放宽至 1180px、**自选与估值列表双列**、统计与指标 5 列、图表 300px |
| `641–1023px` | iPad / 平板 | 指标 4 列、统计 3 列、加大左右留白、控件 42px |
| `≤640px` | iPhone / Android | 单列堆叠、Tab 横向滑动（隐藏滚动条）、**触控热区 ≥44px**、输入框 **16px 防 iOS 聚焦放大** |
| `≤360px` | iPhone SE / 小屏安卓 | 指标 2 列、logo 精简、内边距压缩 |
| 横屏 `max-height:500px` | 手机横屏 | 压缩纵向留白、图表 160px、弹窗顶部对齐可滚动 |

**iOS 专项**：`viewport-fit=cover` + `env(safe-area-inset-*)`（刘海/灵动岛/底部小白条全避让）、输入框 ≥16px 防缩放、`100dvh` 防地址栏溢出、`apple-mobile-web-app-*` + `theme-color` 支持加主屏。

**Android 专项**：`theme-color` 着色地址栏、`color-scheme: dark`、触控热区 ≥44px、隐藏横向滚动条、去除点击高亮。

**PC 专项**：宽屏双列、`@media (hover:hover)` 悬停反馈（触屏不会"粘住"）、`:focus-visible` 键盘可达性、禁用态视觉。

**视口变化**：窗口缩放 / **手机旋转** / 折叠屏展开 → 净值走势图按新宽度**自动重绘**（`resize` + `orientationchange` + `visualViewport` 三路监听 + 150ms 防抖）。

---

## 七、测试与质量保障

全部测试**本地可跑、零外部依赖**（除 Puppeteer 用于浏览器流程），并已验证通过：

| 命令 | 覆盖内容 | 规模 |
|---|---|---|
| `npm run test:responsive` | **多端自适应**：PC 1920/1366、iPad、iPhone 14/SE、Android、小屏安卓、横屏 iPhone + 旋转重绘 + 未登录无本地存储 | **76 项断言 / 8 种设备** ✅ |
| `npm run test:persistence` | **持久化**：写后 WAL 合并、强制终止后主库完整、重启数据仍在、**只留单个 .db 也能完整恢复**、崩溃重启可登录 | **11 项断言** ✅ |
| `npm run test:admin` | **后台**：root 登录、普通用户 403、未登录 401、统计、用户列表、自选明细、搜索、重置密码（旧会话失效）、拒删管理员、删除级联、敏感字段不泄露 | **27 项断言** ✅ |
| `npm run test:auth` | **账号/自选**：注册校验、重复名 409、增删/批量导入、未登录 401、错误密码、**重启后数据持久化** | **20 项断言** ✅ |
| `npm run test:auth:ui` | **账号 UI**：注册→加自选→刷新保持→退出（Puppeteer） | **14 项断言** ✅ |
| `npm run test:admin:ui` | **后台 UI**：入口可见性、统计卡片、用户表、查看自选、搜索过滤（Puppeteer） | **14 项断言** ✅ |
| `npm run test:e2e` | **数据端到端**：登录态注入、搜索→加自选（校验写入账号且 localStorage 无残留）→估值→详情/净值图/净值表 | 流程级 ✅ |
| `npm run test:mobile` | 手机视口 + **主动阻断东方财富直连**，验证详情走服务端代理（0 次直连请求） | 流程级 ✅ |
| `npm run test:api` | 4 个数据接口直连上游回归 | 4 组 ✅ |
| `npm run test:qr` | QR 编码器与权威库 `qrcode` **逐位比对**（版本 1–10 × L/M/Q/H × 8 掩码 × 4 文本） | **1280/1280 一致** ✅ |
| `npm run test:qr:decode` | 真实解码器 jsQR 解码自研二维码（5 种 URL × 4 纠错等级） | **20/20 解码成功** ✅ |
| `npm run test:qr:e2e` | 终端 ANSI 二维码 + `/__qr` 页面二维码重建解码 | 2/2 ✅ |

> 说明：`test:qr` / `test:qr:decode` 需要参考库（`npm i -D qrcode jsqr`），仅用于验证编码器正确性，**运行时不需要**。

---

## 八、部署到 Vercel

### 方式 A：GitHub 导入（推荐，自动 CI/CD）
1. 推送 `fund-watch-web/` 到 GitHub（含 `vercel.json`）
2. <https://vercel.com/new> → Import Git Repository → 选仓库
3. Framework Preset 选 **Other**（纯静态 + api 函数，无构建命令）→ Deploy
4. 之后每次 push 自动部署

### 方式 B：Vercel CLI
```bash
npm i -g vercel
cd fund-watch-web
vercel login
vercel --prod
```

### 方式 C：直接部署目录
```bash
vercel --prod fund-watch-web
```

### 关键配置
- **Node 版本**：`engines.node >= 22.5.0` + `vercel.json` 中函数 `runtime: nodejs22.x`（`node:sqlite` 要求）
- **函数区域**（可选）：`vercel.json` 加 `"regions": ["hkg1"]` 提升东方财富接口连通性
- **环境变量**（可选）：`ADMIN_USERNAME` / `ADMIN_PASSWORD` / `DB_PATH`
- 公开数据接口无需任何环境变量

### ⚠️ SQLite 与 Vercel 的持久化限制（务必阅读）
Vercel 函数运行在**无状态、只读文件系统**环境（仅 `/tmp` 可写且实例重启即清空）：

| 部署方式 | 账号与自选数据 | 建议 |
|---|---|---|
| Vercel 默认（SQLite → `/tmp`） | ⚠️ 会丢失，**仅供功能演示** | 别存真实用户数据 |
| **Vercel 前端 + 独立 Node 后端**（推荐） | ✅ 持久 | 后端放到有持久磁盘处（VPS / Railway / Fly.io / Render / Docker + 卷），设 `DB_PATH=/data/fundwatch.db`；前端指向后端域名 |
| 单机部署（本仓库直接跑） | ✅ 持久 | `node scripts/dev-server.mjs` + Nginx/PM2 反代 |
| 托管 SQLite（Turso / libSQL） | ✅ 持久 | 把 `server/db.cjs` 换成 libSQL 客户端（需引入依赖） |

**前后端分离**：在 `index.html` 顶部注入后端地址，并让请求带上它 + 携带 Cookie：
```html
<script>window.__API_BASE__ = 'https://api.your-domain.com';</script>
```
```js
const API = (p) => (window.__API_BASE__ || '') + p;   // fetch(API('/api/...'), { credentials: 'include' })
```
后端需回 `Access-Control-Allow-Origin: <前端域名>` 与 `Access-Control-Allow-Credentials: true`（会话 Cookie 跨站携带的硬性要求）。

---

## 九、技术选型与开源参考

| 项目 | 地址 | 借鉴点 |
|---|---|---|
| **TiantianFundApi** | <https://github.com/hqdmyjsw/TiantianFundApi>（[文档](https://kouchao.github.io/TiantianFundApi/)） | 天天基金 Node.js API 服务；**自带 Vercel/Docker 示例**；字段映射与路由组织 |
| **real-time-fund** | [npm](https://www.npmjs.com/package/real-time-fund) / [介绍](https://wefound.cc/p/1559.html) | 纯前端估值盯盘：fundgz JSONP 端点与自动刷新思路 |
| **cn-funds-mcp** | <https://github.com/smallke/cn-funds-mcp> | 基金数据 MCP 封装，接口选型参考 |
| **akshare** | <https://akfamily.akshare.xyz> | 基金字段口径参考（净值/收益/费率） |

> 本项目**未复制**上述仓库代码，仅参考接口选型与部署模式；东方财富公开接口无鉴权，仅供个人学习，请遵守数据来源使用条款。

**本项目自研部分**：`scripts/qr.mjs`（零依赖 QR 编码器，与 `qrcode` 逐位一致）、`scripts/dev-server.mjs`（静态 + API + SQLite + 扫码）、`server/*.cjs`（认证/自选/后台 + `node:sqlite` 数据层）。

---

## 十、（可选）接入本地 ttskill 天天基金登录态

本机天天基金官方 `ttskill`（`C:\Users\86188\AppData\Local\TTFund`）提供**账户级**能力：自选管理（`TTFUND_FAVOR_ZX`）、持仓/收益、净值历史（`TTFUND_NAV_INFO`）等，但依赖 `ttskill login` 的本地登录态（DPAPI 加密 token），**无法部署到 Vercel**。

```bash
ttskill login                                                              # 首次扫码登录
ttskill invoke TTFUND_FAVOR_ZX --action query --body '{"zx_query":{"requestType":7}}'
ttskill invoke TTFUND_SEARCH --action query --body '{"query":"有色","search_type":"fund"}'
```

本项目已内置**自建账号体系**（第四节，SQLite）；ttskill 桥接是「直连天天基金账户」的另一条路径，两者可并存——前者数据在你自己的库里，后者与天天基金 App 自选同步。

---

## 十一、项目结构

```
fund-watch-web/
├── index.html               # 单页前端（账号/自选/搜索/估值/详情/后台，多端自适应）
├── vercel.json              # 静态 + /api/** Serverless（nodejs22.x）
├── package.json             # 命令与 engines（node >= 22.5）
├── .gitignore               # 忽略 node_modules / data(*.db) / .vercel
├── api/                     # Vercel Serverless 薄适配层
│   ├── search.js  nav.js  estimate.js  detail.js
│   ├── auth/[action].js               # 注册/登录/登出/me
│   ├── watchlist/index.js  [code].js  # 自选列表/新增/批量导入 · 删除
│   └── admin/stats.js  users.js  users/[id].js
├── server/                  # 共享业务实现（本地与 Vercel 复用）
│   ├── db.cjs               #   SQLite 建表/迁移/连接（node:sqlite）
│   ├── auth.cjs             #   scrypt 哈希/会话/Cookie/内置管理员种子
│   └── handlers.cjs         #   认证、自选、后台处理器
├── scripts/
│   ├── dev-server.mjs       # 本地调试服务器（静态+API+SQLite+扫码）
│   ├── qr.mjs               # 零依赖 QR 编码器（矩阵/终端/SVG）
│   ├── db-tool.mjs          # 数据库运维（info / backup / checkpoint）
│   ├── test-api.mjs  test-auth.mjs  test-admin.mjs
│   ├── test-persistence.mjs # 持久化专项（重启/崩溃/单文件迁移）
│   ├── smoke-auth-ui.cjs  smoke-admin-ui.cjs
│   ├── smoke-test.cjs  smoke-mobile.cjs  smoke-responsive.cjs
│   └── qr-verify.mjs  qr-decode-test.cjs  qr-e2e-test.cjs
├── data/fundwatch.db        # 本地 SQLite（自动创建，已忽略）
└── README.md
```

### 常用命令一览
```bash
# 启动
npm run dev / dev:watch / dev:open / dev:no-qr      # 本地调试服务器（--watch 热重载 / --open 开浏览器 / --no-qr 不打码）

# 数据库运维
npm run db:info        # 库路径 · 是否持久化 · 数据量 · 文件大小
npm run db:backup      # 一致性备份到 data/backups/
npm run db:checkpoint  # 手动合并 WAL 到主库

# 测试（全部本地可跑）
npm run test:persistence  # 持久化：重启/崩溃/单文件迁移（11 项）
npm run test:admin        # 后台 API（27 项）      npm run test:admin:ui   # 后台 UI（14 项）
npm run test:auth         # 账号/自选（20 项）      npm run test:auth:ui    # 账号 UI（14 项）
npm run test:responsive   # 多端自适应（76 项 / 8 设备）
npm run test:api          # 数据接口回归
npm run test:e2e          # 数据端到端            npm run test:mobile     # 手机 + 详情代理
npm run test:qr           # QR 与权威库逐位比对    npm run test:qr:decode  # jsQR 真实解码

# 部署
npm run deploy         # vercel deploy --prod
```

---

## 十二、常见问题（FAQ）

**Q：忘记 root 密码 / 想改管理员密码？**
用环境变量 `ADMIN_PASSWORD='新密码' npm run dev` 重启即可（会更新已存在的 root 密码哈希）；或用其他管理员账号在后台「重置密码」。

**Q：手机扫码/局域网地址打不开？**
确认手机与电脑同一 Wi-Fi；Windows 首次需在防火墙弹窗中允许 Node.js；公司网络可能禁止设备互访。

**Q：自选数据在哪？清浏览器缓存会丢吗？**
不会。自选存在**服务端 SQLite**（`data/fundwatch.db`），前端不使用 localStorage。

**Q：估值显示「净值(非盘中)」？**
说明 `fundgz` 估值接口在当前网络不可达，已自动降级为最新历史净值；换网络或部署到香港区可拿到真实盘中估值。

**Q：重启服务后数据会丢/被覆盖吗？**
不会（已加固）。三重落盘保障：**每次写操作后 checkpoint** + **启动时 checkpoint** + 优雅退出时 checkpoint，另加 `wal_autocheckpoint`；实测强制终止（含 Windows 下 SIGTERM/崩溃）后重启，账号与自选均完整，**只保留单个 `fundwatch.db` 文件也能恢复**。用 `npm run db:info` 或 `GET /api/health` 可确认库路径与是否处于持久化位置。

**Q：怎么备份/迁移数据？**
`npm run db:backup` 生成一致性快照（服务运行中也安全），停服后用该文件覆盖 `DB_PATH` 指向的库即可恢复；因为是单文件库，直接拷贝 `data/fundwatch.db` 到新机器也能用。

**Q：数据库在哪？能改位置吗？**
默认 `<项目>/data/fundwatch.db`；用 `DB_PATH=/your/path/fundwatch.db` 指定其他位置（生产环境推荐指向持久化卷）。启动横幅会打印**完整路径**与「✅ 持久化 / ⚠️ 临时」状态。

**Q：部署到 Vercel 后数据丢了？**
Vercel 生产环境文件系统只读，未设 `DB_PATH` 时只能落 `/tmp`，实例重启即清空（启动时会大声警告）。请按第八节选择「独立后端 + `DB_PATH`」或托管 SQLite（Turso/libSQL）。

**Q：端口被占用？**
`PORT=9000 node scripts/dev-server.mjs` 换端口，或先结束占用 8787 的进程。

**Q：Node 版本报错 `node:sqlite` 找不到？**
需要 Node ≥ 22.5（推荐 22 LTS / 24）。

---

## 版本演进

| 版本 | 主要能力 |
|---|---|
| v1.0 | 数据查询（搜索/盘中估值/净值/详情）+ Vercel 部署方案 |
| v1.1 | 零依赖本地调试服务器 + **终端扫码二维码**（自研 QR 编码器）+ 移动端基础适配 |
| v1.2 | **账号系统**（scrypt 密码哈希 + HttpOnly 会话 Cookie）+ **自选 SQLite 持久化** + **后台管理**（`root/root`、用户与自选查看、重置密码、删除用户） |
| v1.3 | **PC/Android/iOS/平板/横屏全端自适应** + **剔除浏览器本地存储**（自选只存账号）+ 旋转/缩放图表重绘 + 未登录引导登录 |
| v1.4 | **持久化加固**：写后/启动/退出三重 WAL checkpoint、路径可写性探测（本地与 `vercel dev` 不再落 `/tmp`）、启动横幅显示完整库路径与持久化状态、`/api/health` 附带库信息、`db:info / db:backup / db:checkpoint` 运维命令 + 持久化专项测试 |

---

## 免责声明

本项目仅供学习与个人使用；数据来源于公开接口，**不构成任何投资建议**。投资有风险，入市需谨慎。
