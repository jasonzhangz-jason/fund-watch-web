# 微信小程序版（miniprogram/）

与 Web 端、APK 共用**同一套后端**（`/api/*`，零依赖 Node + SQLite）。
小程序端是**原生 WXML/WXSS/JS**，无构建步骤、无 npm 依赖，直接用微信开发者工具打开 `miniprogram/` 即可运行。

---

## 一、快速开始

1. 打开 **微信开发者工具** → 导入项目 → 目录选择本仓库的 `miniprogram/`
   - AppID：可用「测试号」，或填自己的小程序 AppID（改 `project.config.json` 的 `appid`）
2. 启动后端：在仓库根目录执行 `pnpm start`（默认 `http://<电脑IP>:8787`）
3. 开发者工具右上角 **详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」**
   （本地联调 `http://192.168.x.x:8787` 必须勾选；线上必须用 HTTPS 并在小程序后台配置合法域名）
4. 小程序底部进「**我的**」→ 填 **服务器地址**（如 `http://192.168.1.5:8787` 或 `https://your-app.vercel.app`）→ 点「测试连接」→「保存」
5. 回到「我的」登录/注册（账号与网页端、APK 完全共用）

> 小程序没有「同源」概念，`wx.request` 必须使用完整地址，因此**服务器地址是必填项**，且未登录时也能配置。

---

## 二、目录结构

```
miniprogram/
├── app.js / app.json / app.wxss   # 全局：登录态、状态栏高度、设计令牌与通用样式
├── project.config.json            # 开发者工具工程配置（appid / 不校验域名等）
├── sitemap.json                   # 全部页面 disallow（页面均为登录后账号数据）
├── utils/
│   ├── api.js                     # wx.request 封装（对齐 Web 端 src/lib/api.ts）
│   ├── config.js                  # 服务器地址读写（wx.setStorageSync）
│   └── format.js                  # 金额/百分比/时间格式化（与 Web 端口径一致）
├── components/
│   ├── change-chip/               # 涨跌色块（对应 Web 端 ChangeChip）
│   ├── status-line/               # 列表上方数据来源状态行
│   ├── empty-state/               # 空态 + 登录引导按钮
│   └── trend-chart/               # 归一化走势对比图（canvas 2d，Web 端是 SVG）
└── pages/
    ├── ledger/       账本（Tab，首页）：账户资产、当日收益、持仓收益率、排序、60s 刷新
    ├── watchlist/    自选（Tab）：账号自选 + 真实行情（净值涨幅/盘中估值）
    ├── mine/         我的（Tab）：账号、持仓合计、四个入口、服务器地址、退出
    ├── lookthrough/  持仓穿透：穿透资产/覆盖率、个股、涉及哪几只基金
    ├── correlation/  基金相关性分析：走势对比图、相关性矩阵、最相似/最分散
    ├── search/       搜索基金（真实 /api/search）+ 加自选
    ├── fund/         基金详情：三指标、净值走势、阶段收益、重仓股票
    └── position/     持仓维护：`?mode=add` 添加、`?mode=list` 修改/删除/置顶
```

---

## 三、与 Web 端的对应关系

| Web 端 | 小程序端 | 说明 |
|---|---|---|
| `src/pages/LedgerHome.tsx` `/` | `pages/ledger` | 一致：资产卡 + 三列排序 + 收益率在第二行 + 60s 自动刷新；下拉用小程序原生 `onPullDownRefresh` |
| `src/pages/Watchlist.tsx` `/watchlist` | `pages/watchlist` | 一致：账号自选 + 真实行情 + 排序 |
| `src/pages/Mine.tsx` `/mine` | `pages/mine` | 登录/注册表单内联在本页（Web 端是弹层）；含服务器地址设置 |
| `src/pages/LookThrough.tsx` `/lookthrough` | `pages/lookthrough` | 一致：覆盖率 + 个股 + 展开看涉及基金 |
| `src/pages/Correlation.tsx` `/correlation` | `pages/correlation` | 一致：走势对比 + 矩阵 + 两两组合；走势图用 canvas 2d 重写 |
| `src/pages/Search.tsx` `/search` | `pages/search` | 一致：真实搜索 + 加自选（未登录会引导登录） |
| `src/pages/FundDetail.tsx` `/fund/:code` | `pages/fund` | 一致：三指标 / 走势 / 阶段收益 / 重仓股 |
| `AddPosition` + `EditPositions` | `pages/position` | **合并为一个页面**（`mode=add` / `mode=list`），减少重复代码 |
| `LedgerSettings.tsx` `/settings` | 并入 `pages/position`（mode=list） | 置顶/删除/改金额收益 |
| 后台管理 `admin.html` | — | **小程序不做**：桌面端后台，用浏览器访问 `/admin.html` |

### 平台差异（有意为之）

| 项目 | Web 端 | 小程序端 |
|---|---|---|
| 会话 | 浏览器自动带 HttpOnly Cookie | `wx.request` **不会**自动带 Cookie → `utils/api.js` 手动保存 `Set-Cookie` 并在后续请求回传 `Cookie` 头 |
| 请求 | `fetch('/api/...')` 相对路径 | `wx.request(base + '/api/...')` **必须完整地址** |
| 存储 | `localStorage`（服务器地址） | `wx.setStorageSync` |
| 图表 | SVG（走势折线、相关性矩阵用 DOM） | **canvas 2d**（走势图）；矩阵用 view 网格 + 内联背景色 |
| 下拉刷新 | 自研 PullToRefresh 组件 | 原生 `enablePullDownRefresh` + `onPullDownRefresh` |
| 导航 | 三个 Tab 页无顶部标题、子页有返回栏 | 同样：Tab 页 `navigationStyle: custom`，子页用原生导航栏 |
| 样式 | Tailwind CSS | WXSS + CSS 变量（`app.wxss` 中与 Web 端**同一套设计令牌**） |

---

## 四、需要你配置的东西

| 项 | 位置 | 说明 |
|---|---|---|
| AppID | `project.config.json` → `appid` | 现在填的是 `touristappid`（测试号） |
| 后端地址（默认值） | `utils/config.js` → `DEFAULT_BASE` | 可写死为线上地址，省去每台设备手填 |
| 合法域名 | 微信公众平台 → 开发管理 → 服务器域名 | 线上必须是 **HTTPS**，并把后端域名加入 `request` 合法域名 |

---

## 五、校验（本机可跑）

微信开发者工具无法在命令行运行，因此用静态校验覆盖「最容易出错且能查出来」的点：

```bash
pnpm test:miniprogram
```

覆盖内容：

1. `app.json` 合法、**8 个页面的 js/json/wxml/wxss 四件套齐全**
2. tabBar 页面都已在 `pages` 注册（小程序的经典坑）
3. **9 处组件引用可解析**，且组件 json 声明 `component: true`
4. **16 个 JS 文件语法通过**（`node --check`）
5. **接口契约对齐**：`utils/api.js` 与页面里用到的每个 `/api/*` 都能在真实后端 `api/` 路由表中找到（19 个接口）
6. **12 个 WXML 标签闭合平衡**
7. **11 个设计令牌与 Web 端 `src/index.css` 完全一致**，涨跌语义色未写反
8. 未使用小程序不存在的 Web API（`fetch` / `localStorage` / `document.` / `window.` / `XMLHttpRequest`）
9. 关键实现存在：`wx.request` 封装、Cookie 手动维护、未配置地址引导、登录态读取

> 运行时验证仍需在微信开发者工具中完成（本机无该工具，无法自动化）。
