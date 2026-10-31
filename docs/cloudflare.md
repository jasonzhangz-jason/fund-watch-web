# ☁️ Cloudflare 部署指南（Pages + Workers + D1）

本项目适配三种 Cloudflare 产品（**不使用对象存储 / 无 R2**）：

| 位置 | 产品 | 说明 |
|---|---|---|
| 前端 | **Cloudflare Pages** | 托管 `dist/`（Vite 构建的静态站，含 `admin.html` 后台页） |
| 后端 | **Cloudflare Workers** | `backend/workers/` 里的 Worker 提供全部 `/api/*`（替代 Vercel Functions） |
| 数据库 | **Cloudflare D1** | SQLite 兼容，替代 `node:sqlite` 本地库；7 张表结构一致 |
| 数据备份 | **无存储，改为即时下载** | 管理员请求 `GET /api/admin/backup` 即下载：Worker 现算全库 NDJSON → gzip，自行归档 |

> 代码已就绪：`backend/workers/`（Worker 实现）、`backend/workers/migrations/0001_init.sql`（D1 建表）、
> `backend/shared/metrics.cjs`（Node 与 Worker 共用的指标定义）。
> 本机验证：`pnpm test:workers`（用 node:sqlite 模拟 D1，**80 项断言**覆盖路由/会话/D1 读写/级联删除/PBKDF2/数据导出）。

---

## 一、前置

```bash
npm i -g wrangler        # 或每次用 npx wrangler
wrangler login           # 授权 Cloudflare 账号
```

---

## 二、创建资源

```bash
# 1) D1 数据库（创建后把 database_id 填进 backend/workers/wrangler.toml）
wrangler d1 create fund-watch

# 2) 建表（本地 + 线上）
wrangler d1 migrations apply fund-watch --local --config backend/workers/wrangler.toml
wrangler d1 migrations apply fund-watch --remote --config backend/workers/wrangler.toml
```

`backend/workers/wrangler.toml` 里需要确认/修改的项：

```toml
name = "fund-watch-api"                     # Worker 名称（决定 *.workers.dev 域名）
[[d1_databases]]
binding = "DB"
database_id = "<wrangler d1 create 返回的 id>"
```

> 只需 **一个 D1 绑定**。本项目不绑定 R2，也不写任何文件/KV。

**密钥（不要写进仓库）**：

```bash
wrangler secret put ADMIN_PASSWORD --config backend/workers/wrangler.toml   # 内置管理员密码（默认 root）
# 可选：跨域白名单（分域部署时把 Pages 域名加进去）
wrangler secret put CORS_ORIGINS --config backend/workers/wrangler.toml     # 如 https://fund.example.com
```

> 首次请求时 Worker 会懒创建内置管理员（`ADMIN_USERNAME` 默认 `root`）。
> 密码哈希用 **WebCrypto PBKDF2-SHA256**（`pbkdf2$sha256$<iter>$<hex>`），Node 端也能校验（两端互认）。

---

## 三、部署后端 Worker

```bash
wrangler deploy --config backend/workers/wrangler.toml
# → https://fund-watch-api.<你的子域>.workers.dev
```

自检：

```bash
curl https://fund-watch-api.xxx.workers.dev/api/health
# {"ok":true,"service":"fund-watch-web","runtime":"cloudflare-workers","database":"cloudflare-d1","db":{...}}
```

---

## 四、部署前端 Pages

**方式 A：Git 集成（推荐）**

Cloudflare Dashboard → Workers & Pages → Create → Pages → 连接仓库，构建配置：

| 项 | 值 |
|---|---|
| Framework preset | Vite |
| Build command | `pnpm build` |
| Build output directory | `dist` |
| 环境变量 | `NODE_VERSION=20`（或 22） |

若前后端**不同域**（Pages 在 `*.pages.dev`、Worker 在 `*.workers.dev`），再加一个环境变量：

| 变量 | 值 |
|---|---|
| `VITE_API_BASE` | `https://fund-watch-api.<你的子域>.workers.dev` |

**方式 B：命令行直传**

```bash
VITE_API_BASE=https://fund-watch-api.xxx.workers.dev pnpm build   # Windows: $env:VITE_API_BASE="..."
wrangler pages deploy dist --project-name fund-watch
```

`public/_headers` 会随构建产物一起发布（长缓存静态资源、HTML 不缓存、安全响应头）。

---

## 五、两种域名拓扑（重要）

### 拓扑 1：同域（推荐，前端零改动）

页面与 API 在**同一个自定义域**下，`/api/*` 由 Worker 接管：

1. Pages 绑定自定义域 `fund.example.com`
2. 给 Worker 加 Route：`fund.example.com/api/*`（Dashboard → Worker → Settings → Triggers → Routes）

这样前端保持相对路径 `/api/...`（**不需要** `VITE_API_BASE`），也**没有跨域 Cookie 问题**。

### 拓扑 2：分域（Pages + Workers 各自默认域名）

需要两件事：
1. 前端构建时注入 `VITE_API_BASE`
2. Worker 允许跨域并带凭据 —— 已内置：账号接口**回显 Origin** + `Access-Control-Allow-Credentials: true`
   （公开接口返回 `*`，前端对这些接口用 `credentials: 'omit'`）。
   生产建议设置 `CORS_ORIGINS` 为 Pages 域名白名单（留空则回显任意来源）。

> 跨域 + HttpOnly Cookie 需要浏览器同站策略允许：本项目 Cookie 为 `SameSite=Lax`，
> 若前后端是**不同站**（例如 `*.pages.dev` 与 `*.workers.dev`），浏览器会拒绝发送 Cookie。
> **因此生产请用拓扑 1，或把两个自定义域放在同一主域下**（如 `fund.example.com` + `api.example.com`
> 并设置 `SameSite=None; Secure`）。要改成 `SameSite=None` 时可调整 `backend/workers/src/auth.js` 的 `sessionCookie()`。

---

## 六、把已有数据搬到 D1

```bash
# 1) 从本地 SQLite 导出 SQL
pnpm d1:export            # 生成 d1-data.sql（已在 .gitignore 中）

# 2) 导入 D1（建议空库执行；脚本内含 PRAGMA defer_foreign_keys = true）
wrangler d1 execute fund-watch --remote --file=./d1-data.sql --config backend/workers/wrangler.toml
```

**密码哈希注意**：导出脚本会统计旧版 **scrypt** 账号并警告 —— Workers 的 WebCrypto **无法验证 scrypt**，
这些账号迁移后不能登录。处理办法（二选一）：

- 用管理端「重置密码」（写入 PBKDF2 格式，迁移后即可用）；
- 或在 Node 端先批量改密（`backend/server/auth.cjs` 已提供 `hashPasswordPbkdf2`）。

---

## 七、数据导出与恢复（无对象存储）

| 操作 | 接口 | 说明 |
|---|---|---|
| 导出全库 | `GET /api/admin/backup` | 现算 7 张表 → NDJSON → gzip → `Content-Disposition` 附件下载 |

以管理员身份**在浏览器直接打开该地址**即可下载（同域时 Cookie 自动带上）；命令行等价写法：

```bash
# 先登录拿 Cookie，再带 Cookie 导出
curl -c jar.txt -X POST https://<worker>/api/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"root","password":"***"}'
curl -b jar.txt https://<worker>/api/admin/backup -o fund-watch-$(date +%F).ndjson.gz
```

- 响应头附带 `X-Dump-Tables`（表数）与 `X-Dump-Rows`（总行数），便于核对。
- **不落盘、不进 R2、不留历史**：每次导出都是一次性下载，由你保存到本地或自己的归档位置。
- 恢复方式：解压 NDJSON，按 `table` 字段分组，逐行 INSERT；
  或改写成 `INSERT OR REPLACE` 批量 SQL 后用 `wrangler d1 execute --file` 灌回。

> 需要「定时自动备份」时，可自行加 `[triggers] crons` 并调用导出逻辑，
> 但**必须有外部接收方**（curl 到自建存储 / 邮件），Workers 自身不提供持久存储。

---

## 八、本地开发

```bash
# Worker + 本地 D1 模拟
pnpm cf:dev
# → http://127.0.0.1:8787（默认），前端 Vite 代理已指向该端口

# 前端
pnpm dev
```

> `wrangler dev` 会把 D1 数据存放在 `.wrangler/state/`，与 `data/fundwatch.db` 互不影响。

---

## 九、与 Node/Vercel 版的差异清单

| 能力 | Node / Vercel | Cloudflare Worker |
|---|---|---|
| 数据库 | `node:sqlite`（同步） | **D1（异步）**，SQL 方言相同 |
| 密码 | scrypt（+ 可校验 PBKDF2） | **PBKDF2-SHA256（WebCrypto）**；scrypt 需重置密码 |
| 会话 Cookie | 同进程 SQLite | D1 `sessions` 表（逻辑一致） |
| 行情缓存 | `fund_quotes` 表 | `fund_quotes` 表（同结构，60s TTL） |
| 重仓股 / 净值历史 | 进程内 Map 缓存 30 分钟 | 实例内 Map 缓存 30 分钟（短生命周期，命中率较低） |
| 备份 | `VACUUM INTO` 本地文件 | **即时下载 NDJSON.gz**（无存储，自行归档） |
| 定时任务 | 无 | 可选 `[triggers] crons` |
| 函数数 | 22 个独立 Vercel 函数 | **1 个 Worker**（统一路由，冷启动更少） |

### 已知取舍

- **Workers CPU 时间**：PBKDF2 迭代次数默认 10 万（约 20–40ms CPU）。免费计划单请求 CPU 上限较低，若遇超时请把
  `PBKDF2_ITERATIONS` 调到 5 万，或升级付费计划。
- **D1 写入配额**：账本每次刷新会写快照（`position_daily` / `account_daily`）。多用户高频刷新时注意 D1 免费额度；
  需要时可把前端的 60s 自动刷新调大。
- **实例内缓存**（重仓股、净值历史）不跨实例，命中率低于 Node 常驻进程。
- **无对象存储**：导出会有一次全表扫描 + gzip（默认每表上限 2 万行），大库导出会消耗较多 CPU/响应时间。

---

## 十、验证清单（部署后）

```bash
curl https://<worker>/api/health                 # runtime=cloudflare-workers, database=cloudflare-d1（无 storage 字段）
curl -i -X OPTIONS https://<worker>/api/auth/login -H "Origin: https://<pages>"   # 204 + 回显 Origin + Allow-Credentials
```
浏览器打开 Pages 域名 → 注册/登录 → 账本添加持仓 → 应看到真实行情与当日收益 → 「我的」→ 持仓穿透 / 相关性分析。

本机回归：

```bash
pnpm test:workers     # Worker 端 80 项断言（D1 模拟，无 R2）
pnpm test:live        # 前端 E2E（跑在 Node 后端上，验证前端契约未变）
```
---

## 十、配置与自检脚本（backend/cloudflare.config.json）

所有部署脚本读同一份配置，避免「脚本还按占位符给建议、实际资源早已不同」：

```json
{
  "workerName": "fund-watch-api",
  "workerUrl": "https://fund-watch-api.jasonhub.workers.dev",
  "pagesProject": "fund-watch",
  "pagesUrl": "https://fund-watch-3o5.pages.dev",
  "productionBranch": "main",
  "d1Database": "fund-watch",
  "apiBaseMode": "cross-site",
  "previewBranches": ["fund-watch-v2"]
}
```

`apiBaseMode` 决定两件事，脚本会强制校验它们一致：

| 模式 | 含义 | 构建 | Cookie |
|---|---|---|---|
| `cross-site` | Pages 与 Worker 不同站点（`*.pages.dev` + `*.workers.dev`） | 必须 `VITE_API_BASE=<workerUrl>` | `COOKIE_SAMESITE = "None"` |
| `same-zone` | 自定义域 + Worker Route `/api/*` | 用相对路径，**不要**设 `VITE_API_BASE` | `COOKIE_SAMESITE = "Lax"` |

```bash
pnpm cf:check            # 本地一致性（快、离线）：配置↔toml↔迁移↔产物↔模式
pnpm cf:check --online   # 再加：登录态与令牌权限、secret 列表、远端 D1、Worker/Pages 是否还存在
pnpm cf:doctor           # 部署后四层探活（读同一份配置，无需参数）
```

`cf:check` 专门拦这些真实踩过的坑：

- `database_id` 仍是占位符
- 跨站模式却用 `Lax` cookie（登录后刷新掉登录态）
- 构建时漏 `VITE_API_BASE`（前端 `/api` 打到 Pages → 405 / HTML）
- 把「分支预览别名」写成生产域名（`xxx.fund-watch-3o5.pages.dev` 是四段域名）
- 缺少 `ADMIN_PASSWORD` secret（内置管理员 `root/root`）
- **Worker 或 Pages 项目被删**（`--online` 会报 `code: 10007` / 项目不存在）

---

## 十一、部署后 404 排查

一条命令定位（换成你的真实地址；只给一个也行）：

```bash
node scripts/deploy/cf-doctor.mjs --site=https://你的站点域名 --worker=https://fund-watch-api.<子域>.workers.dev
```

脚本按「Worker → Pages → 站点到 Worker 的路由 → 登录 Cookie」四层分别断言，并给出下一步。
路由这一层会**下载站点的 JS bundle 并搜索后端域名** —— 这是判断「前端到底指向哪里」的唯一可靠证据（Pages 永远不服务 `/api`，所以站点 `/api` 返回 HTML 不代表没配好）。

> 若本机开了代理（如 `127.0.0.1:10808`）而 Node 直连会超时，脚本会自动识别 `HTTPS_PROXY` 或 Windows 系统代理并改用 curl 探测；也可显式指定 `--proxy=127.0.0.1:10808` 或 `--no-proxy`。

常见结论对照：

| 现象 | 原因 | 修法 |
|---|---|---|
| 站点首页就是 Cloudflare 的 404 页 | Pages 只有**预览部署**，生产环境为空（部署时未指定生产分支） | `wrangler pages deploy dist --project-name fund-watch --branch main`；或在 Dashboard → Deployments 把该次部署设为 Production |
| 站点能打开，但接口 404（页面提示「未连接后端」） | `/api/*` 没有路由到 Worker，也没配 `VITE_API_BASE` | ① Worker → Settings → Triggers → Add route：`<你的域名>/api/*`（推荐，需自定义域）；② 或给 Pages 构建加 `VITE_API_BASE=<worker 地址>` 后重新部署 |
| 打开 `*.workers.dev/` 得到 JSON 404 | **正常**：Worker 只服务 `/api/*`，根路径没有页面 | 访问 `/api/health` 验证；页面由 Pages 提供 |
| `/api/health` 也是 404 | Worker 没部署成功，或地址指向了别的 Worker | 重跑 `wrangler deploy` 看输出；`wrangler tail` 看实时日志 |
| 登录成功但刷新就掉登录态 | 前端与后端是**不同站点**（如 `*.pages.dev` + `*.workers.dev`），`SameSite=Lax` 的 Cookie 不被跨站发送 | 见下节 |

### 分域部署的 SameSite 开关

`backend/workers/wrangler.toml` 的 `[vars]`：

```toml
COOKIE_SAMESITE = "None"   # 仅当前后端不同站点时；同域保持 Lax
```

- `None` 必须配合 `Secure`（本项目在 https 下自动加）；http 下会自动回落 `Lax`，避免 Cookie 被浏览器直接丢弃。
- 更稳妥的做法仍是**同域**：`fund.example.com`（Pages）+ 该域的 `/api/*`（Worker Route）。
