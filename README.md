# 📈 FundWatch · 天天基金数据 Web UI

基于天天基金（东方财富）公开数据接口的基金盯盘 Web 应用：

- ✅ **自选基金**：添加 / 删除自选（浏览器 localStorage 持久化），列表自动刷新
- ✅ **盘中实时估值**：估算净值 + 估算涨跌幅 + 估值时间，30s 自动刷新
- ✅ **多种数据查询**：基金搜索、基金详情、阶段收益、净值走势图、历史净值表
- ✅ **零后端依赖**：Vercel 静态托管 + Serverless 代理，无需数据库

---

## 一、功能与页面

| 页面 | 功能 | 数据来源 |
|---|---|---|
| 📌 自选 | 自选列表 + 盘中估值 + 自动刷新(30s) + 删除/详情 | `/api/estimate` |
| 🔍 搜索 | 名称/代码/拼音缩写搜基金，一键加入自选 | `/api/search` |
| ⚡ 实时估值 | 批量输入代码查盘中估值，可全部加入自选 | `/api/estimate` |
| 📊 详情 | 基本信息、阶段收益、净值走势 Canvas 图、历史净值表 | `pingzhongdata` JSONP + `/api/nav` |

---

## 二、架构与接口说明

```
浏览器(index.html)
 ├─ /api/*      Vercel Serverless（Node18+ 全球 fetch）       → 全部数据接口统一走代理
 │    ├─ GET /api/search?key=xx             基金搜索（fundsuggest.eastmoney.com）
 │    ├─ GET /api/nav?code=xx&page=&size=   历史净值（api.fund.eastmoney.com/f10/lsjz）
 │    ├─ GET /api/estimate?codes=a,b        盘中估值（fundgz → 失败自动降级为最新净值）
 │    └─ GET /api/detail?code=xx            基金详情（服务端拉取 pingzhongdata 并解析）
 └─ 兜底直连（仅当 /api/detail 不可用时）fund.eastmoney.com/pingzhongdata/{code}.js
```

### 为什么需要 Serverless 代理？
东方财富系列接口**不返回 CORS 头**，浏览器 `fetch` 无法直连。因此搜索、历史净值、**基金详情**统一走 `/api/*` 服务端代理；详情接口在服务端拉取 `pingzhongdata` 并解析为 JSON，**手机端无需直连东方财富域名**（规避手机网络/DNS 拦截导致的「脚本加载失败」）。仅当代理不可用时，前端才回退到浏览器 `<script>` 直连。

### 盘中估值的降级策略（重要）
`fundgz.1234567.com.cn` 对**部分网络 / 海外 IP（如 Vercel 默认美国区）可能返回 404**。程序已做多级兜底：

1. Serverless 先请求 `fundgz` → 成功则返回 `available: true` 的盘中估值；
2. 失败则自动降级为 `f10/lsjz` 最新**历史净值**，返回 `available: false`（前端会显示「净值(非盘中)」标签）；
3. 前端详情页的净值走势走 `pingzhongdata` JSONP（浏览器直连，国内网络可用）。

> 若你的 Vercel 区域访问 fundgz 不通，可考虑在 Vercel 项目设置中把函数区域（`vercel.json` 的 `regions`）配置为与你用户群体一致的区域，或接受降级为最新净值展示。

---

## 三、本地运行与调试（无需安装任何依赖）

本项目自带轻量开发服务器（纯 Node 内置模块，**零 npm 依赖**），效果等同 `vercel dev`：

```bash
cd fund-watch-web

npm run dev            # 启动调试服务器 → http://localhost:8787（自动打印手机扫码二维码）
npm run dev:watch      # 启动 + 文件变更自动重启（改 api/*.js 热重载）
npm run dev:open       # 启动并自动打开浏览器
# 或直接：
node scripts/dev-server.mjs              # 等价 npm run dev
node --watch scripts/dev-server.mjs      # 等价 npm run dev:watch
node scripts/dev-server.mjs --no-qr      # 不打印终端二维码
PORT=9000 node scripts/dev-server.mjs    # 自定义端口
```

### 📱 手机扫码调试（启动即生成二维码）
启动后终端会**直接打印一个二维码**（零依赖自研编码器，版本 1-10 / 纠错 L-M-Q-H），用手机相机扫一下即可打开局域网地址：

- **扫码页面**：电脑上打开 `http://localhost:8787/__qr` 显示放大版二维码（适合只有相机、没装扫码 App 的场景），支持 `/__qr?url=http://任意地址`
- **关闭二维码**：`node scripts/dev-server.mjs --no-qr`
- **二维码质量自检**：`npm run test:qr`（与权威库 `qrcode` 逐位比对，需 `npm i -D qrcode`）；`node scripts/qr-decode-test.cjs`（用 jsQR 真实解码验证可扫，需 `npm i -D jsqr`）

### 调试要点
- **前端调试**：浏览器打开 `http://localhost:8787`，按 `F12` → Console/Network 面板看请求与报错；静态文件已禁用缓存，改 `index.html` 直接刷新即可。
- **接口调试**：
  - 健康检查：`http://localhost:8787/api/health`
  - 搜索：`http://localhost:8787/api/search?key=中证A500`
  - 净值：`http://localhost:8787/api/nav?code=161725&size=5`
  - 估值：`http://localhost:8787/api/estimate?codes=161725,000001`
  - 详情：`http://localhost:8787/api/detail?code=161725`
- **接口回归**：`npm run test:api`（直连上游验证 4 个代理函数）、`npm run test:e2e`（Puppeteer 端到端冒烟，需先启动 `npm run dev`）。
- **服务器日志**：控制台会实时打印每个请求的 ✅/❌ 状态与耗时；`/api/*` 抛错会打印完整堆栈。
- **端口被占用**：会提示「端口已被占用」，换 `PORT=9000 node scripts/dev-server.mjs` 即可。

### 📱 手机访问（自适应）
- 页面**完全响应式**：手机浏览器直接可用，标签页横滑、触控热区 ≥44px、无横向溢出、输入框 ≥16px 防 iOS 聚焦放大、表格横向滚动、隐藏页面时自动暂停刷新省电。
- **同一 Wi-Fi 下用手机调试**：启动后用手机**扫终端二维码**，或手动输入控制台打印的「局域网」地址（如 `http://192.168.x.x:8787`）。
- **详情页不依赖手机直连东方财富**：详情数据走 `/api/detail` 服务端代理，避免手机网络拦截导致的「脚本加载失败」。
- **注意**：Windows 防火墙首次可能拦截，允许 Node.js 网络访问即可；手机与电脑需在同一局域网。
- **生产环境**：部署到 Vercel 后自带 HTTPS 与全球 CDN，手机直接访问线上域名即可，无需局域网。

> 不装任何东西也能看 UI：直接用浏览器打开 `index.html`，详情页可用（JSONP 直连）；搜索/估值需要 `npm run dev` 提供 `/api` 代理。

---

## 四、部署到 Vercel（方案）

### 方式 A：GitHub 导入（推荐，自动 CI/CD）
1. 把 `fund-watch-web/` 推送到 GitHub 仓库（含 `vercel.json`）；
2. 打开 <https://vercel.com/new> → Import Git Repository → 选择该仓库；
3. Framework Preset 选 **Other**（纯静态 + api 函数，无需构建命令）；
4. 点 Deploy 即完成。之后每次 push 自动部署。

### 方式 B：Vercel CLI
```bash
npm i -g vercel
cd fund-watch-web
vercel login            # 浏览器授权
vercel                  # 预览部署
vercel --prod           # 生产部署
```

### 方式 C：直接部署目录
```bash
vercel --prod fund-watch-web
```

### 部署后配置（可选）
- **函数区域**：若希望 `/api/estimate` 更稳，在 `vercel.json` 加：
  ```json
  "regions": ["hkg1"]
  ```
  （香港区域对东方财富接口的连通性通常好于美国；也可不配，接受降级展示。）
- **自定义域名**：Vercel 控制台 → Domains 添加。
- 无需任何环境变量（全部为公开数据接口）。

---

## 五、已借鉴的开源存量项目（实施前调研结论）

| 项目 | 地址 | 借鉴点 |
|---|---|---|
| **TiantianFundApi** | https://github.com/hqdmyjsw/TiantianFundApi （文档 https://kouchao.github.io/TiantianFundApi/） | 天天基金 Node.js API 服务；**自带 Vercel 示例**与 Docker 部署；字段映射与接口路由组织方式 |
| **real-time-fund** | https://www.npmjs.com/package/real-time-fund （介绍 https://wefound.cc/p/1559.html） | 纯前端基金实时估值盯盘，盘中估值 JSONP 端点（fundgz）与自动刷新思路 |
| **cn-funds-mcp** | https://github.com/smallke/cn-funds-mcp | 基金数据 MCP 封装，接口选择参考 |
| **akshare** | https://akfamily.akshare.xyz （基金公开数据文档） | 基金数据字段口径参考（净值/收益/费率） |

> 说明：本项目**不直接依赖**上述仓库代码（未 copy），仅参考其接口选型与部署模式；东方财富公开接口无鉴权，仅供个人学习使用，请遵守数据来源的使用条款，数据不作投资建议。

---

## 六、（可选）接入本地 ttskill 天天基金登录态

本机装有天天基金官方 `ttskill`（`C:\Users\86188\AppData\Local\TTFund`），支持**账户级**能力：自选管理（`TTFUND_FAVOR_ZX` 增删查）、持仓/收益、净值历史（`TTFUND_NAV_INFO`）等，但依赖 `ttskill login` 的本地登录态（DPAPI 加密 token），**无法部署到 Vercel**。

如需账户级自选（与天天基金 App 同步），可在本地另起一个桥接服务（Node 子进程调用 `ttskill invoke ...`），前端通过环境变量 `VITE_TTFUND_BRIDGE` 指向它：

```bash
# 本地桥接示例（不随 Vercel 部署）
ttskill login                          # 首次扫码登录
ttskill invoke TTFUND_FAVOR_ZX --action query --body '{"zx_query":{"requestType":7}}'
ttskill invoke TTFUND_SEARCH --action query --body '{"query":"有色","search_type":"fund"}'
```

浏览器端自选（localStorage）与账户自选是两套体系：前者即点即用、跨设备需手动迁移；后者与天天基金账户同步但需本机登录态。本项目默认使用前者。

---

## 七、项目结构

```
fund-watch-web/
├── index.html        # 单页前端（自选/搜索/实时估值/详情）
├── vercel.json       # 静态 + /api/* Serverless 配置
├── package.json
├── api/
│   ├── search.js     # 基金搜索代理
│   ├── nav.js        # 历史净值代理
│   └── estimate.js   # 盘中估值（fundgz → lsjz 兜底）
└── README.md
```

## 免责声明

本项目仅供学习与个人使用，数据来源于公开接口，不构成任何投资建议。投资有风险，入市需谨慎。
