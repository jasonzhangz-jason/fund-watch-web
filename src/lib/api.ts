/**
 * 后端接口客户端
 * 所有请求都走相对路径 /api/*：开发期由 Vite 代理到 8787，生产由 Vercel 同源提供。
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'same-origin', ...init });
  } catch (e) {
    // 网络层失败（后端未启动 / 断网）
    throw new ApiError((e as Error).message || '网络请求失败', 0);
  }
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('返回内容不是合法 JSON', res.status);
  }
  const body = data as { ok?: boolean; error?: string };
  if (!res.ok || body.ok === false) throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  return data as T;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/* ---------------- 类型 ---------------- */
export type User = { id: number; username: string; role: 'user' | 'admin'; created_at?: string };
export type WatchItem = { code: string; name: string; createdAt?: string };
export type SearchItem = { code: string; name: string; shortName?: string; fundType?: string };

/** 盘中估值（available=false 表示估值不可用，字段回落为最新净值数据） */
export type Estimate = {
  available: boolean;
  code: string;
  name: string;
  gsz: string;
  gszzl: string;
  gztime: string;
  dwjz: string;
  jzrq: string;
};

export type NavItem = {
  date: string;
  dwjz: string;
  ljjz: string;
  jzzzl: string;
  sgzt?: string;
  shzt?: string;
};

export type FundDetail = {
  ok: true;
  code: string;
  name: string;
  found: boolean;
  rate?: string;
  sourceRate?: string;
  minsg?: string;
  metrics: { m1: number | null; m6: number | null; y1: number | null; y3: number | null };
  latestNav: number;
  latestDate: string;
  trend: { date: string; nav: number; equityReturn: number }[];
};

/** 重仓股（真实数据，来自东财基金持仓明细 + 批量行情） */
export type Holding = {
  code: string;
  name: string;
  /** 占净值比例 % */
  weight: number | null;
  /** 持股数（万股） */
  shares: number | null;
  /** 持仓市值（万元） */
  marketValue: number | null;
  /** 当日涨跌幅 %（行情缺失时为 null） */
  change: number | null;
};

/** 账号持仓条目 */
export type PositionItem = { code: string; name: string; amount: number; profit: number };

/** 账本明细（服务端计算：含当日收益、净值、涨幅） */
export type PortfolioItem = {
  code: string;
  name: string;
  amount: number;
  profit: number;
  /** 持仓收益率 %（服务端计算：持有收益 / 本金）；本金 ≤ 0 时为 null */
  rate: number | null;
  nav: number | null;
  navDate: string | null;
  dayChange: number | null;
  estChange: number | null;
  estAvailable: boolean;
  dayProfit: number;
  updatedAt: string | null;
};

/** 账户账本汇总（账户资产 / 持有收益 / 当日收益） */
export type Portfolio = {
  date: string;
  totalAmount: number;
  totalProfit: number;
  dayProfit: number;
  positionCount: number;
  watchCount: number;
  updatedAt: string;
  items: PortfolioItem[];
};

/** 相关性组合（两只基金） */
export type CorrelationPair = {
  aCode: string;
  aName: string;
  bCode: string;
  bName: string;
  corr: number;
  level: string;
};

/** 基金相关性分析结果（/api/portfolio/correlation） */
export type Correlation = {
  /** 实际使用的窗口（交易日数） */
  window: number;
  requestedWindow: number;
  /** 共同交易日数 */
  pointCount: number;
  /** 收益率样本数 = pointCount - 1 */
  returnCount?: number;
  startDate: string | null;
  endDate: string | null;
  fundCount: number;
  funds: Array<{ code: string; name: string; amount: number }>;
  /** 共同交易日（升序），与 series[].points 一一对应 */
  dates?: string[];
  /** 归一化走势序列（起点 = 100），用于绘制走势对比图 */
  series?: Array<{ code: string; name: string; points: number[]; totalChange: number }>;
  /** N×N 相关系数矩阵（null = 无法计算，如无波动） */
  matrix: Array<Array<number | null>>;
  pairs: CorrelationPair[];
  mostSimilar: CorrelationPair | null;
  mostDiverse: CorrelationPair | null;
  avgCorr: number | null;
  insufficient: Array<{ code: string; name: string; points: number }>;
  reason?: string;
  updatedAt: string;
};

/** 持仓穿透中的单只个股（跨基金聚合） */
export type LookThroughStock = {
  rank: number;
  code: string;
  name: string;
  /** 穿透金额（元）= Σ 各基金持有金额 × 该股占净值比 */
  amount: number;
  /** 占账户资产比例 % */
  ratio: number;
  fundCount: number;
  /** 持有该股的基金（按贡献金额降序） */
  funds: Array<{
    code: string;
    name: string;
    /** 该股在这只基金里的占净值比例 % */
    weight: number;
    /** 该基金为这只股票贡献的穿透金额（元） */
    amount: number;
    change: number | null;
  }>;
};

/** 持仓穿透结果（/api/portfolio/lookthrough） */export type LookThrough = {
  totalAmount: number;
  /** 重仓股穿透覆盖的资产（元） */
  coveredAmount: number;
  /** 覆盖比例 %（非 100%，只覆盖各基金前十大重仓股） */
  coverage: number;
  positionCount: number;
  stockCount: number;
  date: string | null;
  quarter: string | null;
  stale: boolean;
  /** 无重仓股数据的基金（债基/QDII 等） */
  noData: Array<{ code: string; name: string; amount: number }>;
  items: LookThroughStock[];
  updatedAt: string;
};

/** 账户每日快照 */
export type AccountDaily = {
  date: string;
  totalAmount: number;
  totalProfit: number;
  dayProfit: number;
  positionCount: number;
  watchCount: number;
};

/** 后台运营统计（/api/admin/stats） */
export type AdminStats = {
  users: number;
  admins: number;
  activeSessions: number;
  watchlistItems: number;
  usersWithWatchlist: number;
  positionsItems: number;
  usersWithPositions: number;
  quotesCached: number;
  snapshotDays: number;
  latestSnapshot: string | null;
  positionDailyRows: number;
};

/** 后台用户行（/api/admin/users） */
export type AdminUser = {
  id: number;
  username: string;
  role: 'user' | 'admin';
  createdAt: string;
  fundCount: number;
  activeSessions: number;
};

/** 运营指标明细的列定义（/api/admin/metrics/:key） */
export type AdminMetricColumn = { key: string; label: string; align?: 'right' };

/** 运营指标明细（点击指标卡下钻） */
export type AdminMetricDetail = {
  key: string;
  title: string;
  note: string;
  columns: AdminMetricColumn[];
  items: Array<Record<string, string | number | null>>;
  total: number;
  truncated: boolean;
};

/* ---------------- 接口 ---------------- */
export const api = {
  me: () => request<{ ok: true; user: User | null }>('/api/auth/me'),

  login: (username: string, password: string) =>
    request<{ ok: true; user: User }>('/api/auth/login', jsonPost({ username, password })),

  register: (username: string, password: string) =>
    request<{ ok: true; user: User }>('/api/auth/register', jsonPost({ username, password })),

  logout: () => request<{ ok: true; user: null }>('/api/auth/logout', { method: 'POST' }),

  search: (key: string) =>
    request<{ ok: true; total: number; items: SearchItem[] }>(`/api/search?key=${encodeURIComponent(key)}`),

  /** 批量盘中估值（一次请求拿多只基金） */
  estimates: (codes: string[]) =>
    request<{ ok: true; items: Estimate[] }>(`/api/estimate?codes=${codes.join(',')}`),

  /** 历史净值（size=1 即最新一条，含当日涨幅 jzzzl） */
  nav: (code: string, size = 1) =>
    request<{ ok: true; code: string; total: number; items: NavItem[] }>(`/api/nav?code=${code}&size=${size}`),

  detail: (code: string) => request<FundDetail>(`/api/detail?code=${code}`),

  watchlist: {
    list: () => request<{ ok: true; items: WatchItem[] }>('/api/watchlist'),
    add: (code: string, name: string) => request<{ ok: true }>('/api/watchlist', jsonPost({ code, name })),
    remove: (code: string) => request<{ ok: true }>(`/api/watchlist/${encodeURIComponent(code)}`, { method: 'DELETE' }),
  },

  /** 基金重仓股（真实） */
  holdings: (code: string) =>
    request<{ ok: true; code: string; date: string | null; quarter: string | null; items: Holding[] }>(
      `/api/holdings?code=${encodeURIComponent(code)}`,
    ),

  /** 账号持仓（服务端持久化） */
  positions: {
    list: () => request<{ ok: true; items: PositionItem[] }>('/api/positions'),
    save: (p: PositionItem) => request<{ ok: true }>('/api/positions', jsonPost(p)),
    remove: (codes: string[]) =>
      request<{ ok: true; removed: number }>(`/api/positions?codes=${codes.join(',')}`, { method: 'DELETE' }),
    reorder: (code: string, dir: 'top' | 'up' | 'down') =>
      request<{ ok: true; order: string[] }>('/api/positions/reorder', jsonPost({ code, dir })),
  },

  /** 账本聚合：账户资产 / 持有收益 / 当日收益 / 持仓明细（服务端计算并落库每日快照） */
  portfolio: (refresh = false) =>
    request<{ ok: true; portfolio: Portfolio }>(`/api/portfolio${refresh ? '?refresh=1' : ''}`),

  /** 账户资产与收益历史（account_daily） */
  portfolioHistory: (days = 30) =>
    request<{ ok: true; items: AccountDaily[]; snapshot: AccountDaily | null }>(`/api/portfolio/history?days=${days}`),

  /** 持仓每日明细快照（position_daily） */
  portfolioDaily: (params: { date?: string; days?: number } = {}) => {
    const qs = params.date ? `date=${params.date}` : `days=${params.days ?? 1}`;
    return request<{ ok: true; items: Array<{ date: string; code: string; name: string; amount: number; profit: number; nav: number | null; dayChange: number | null; estChange: number | null; dayProfit: number }> }>(
      `/api/portfolio/daily?${qs}`,
    );
  },

  /** 持仓穿透：按各基金前十大重仓股穿透到个股（?refresh=1 强制刷新重仓股缓存） */
  lookthrough: (refresh = false) =>
    request<{ ok: true; lookthrough: LookThrough }>(`/api/portfolio/lookthrough${refresh ? '?refresh=1' : ''}`),

  /** 基金相关性分析：账本内基金走势相似程度（days = 参与计算的交易日数） */
  correlation: (days = 60, refresh = false) =>
    request<{ ok: true; correlation: Correlation }>(
      `/api/portfolio/correlation?days=${days}${refresh ? '&refresh=1' : ''}`,
    ),

  /** 批量行情（服务端 60s 缓存，refresh=1 强制刷新） */
  quotes: (codes: string[], refresh = false) =>
    request<{
      ok: true;
      items: Array<{
        code: string;
        name: string;
        nav: number | null;
        nav_date: string | null;
        day_change: number | null;
        acc_nav: number | null;
        est_change: number | null;
        est_time: string | null;
        estimate_available: boolean;
        updated_at: string;
      }>;
    }>(`/api/quotes?codes=${codes.join(',')}${refresh ? '&refresh=1' : ''}`),

  /** 自选排序 */
  reorderWatchlist: (code: string, dir: 'top' | 'up' | 'down') =>
    request<{ ok: true; order: string[] }>('/api/watchlist/reorder', jsonPost({ code, dir })),

  /** 后台统计（仅管理员；依赖会话中的 role） */
  adminStats: () => request<{ ok: true; stats: AdminStats }>('/api/admin/stats'),

  /** 后台用户列表（仅管理员，支持搜索与分页） */
  adminUsers: (params: { q?: string; page?: number; size?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.page) qs.set('page', String(params.page));
    if (params.size) qs.set('size', String(params.size));
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ ok: true; total: number; page: number; size: number; items: AdminUser[] }>(
      `/api/admin/users${suffix}`,
    );
  },

  /**
   * 运营指标明细（仅管理员）—— 点击运营数据卡片下钻查看构成明细。
   * key 与 stats 字段同名：users/admins/activeSessions/watchlistItems/usersWithWatchlist/
   * positionsItems/usersWithPositions/quotesCached/snapshotDays/positionDailyRows
   */
  adminMetric: (key: string) =>
    request<{ ok: true } & AdminMetricDetail>(`/api/admin/metrics/${encodeURIComponent(key)}`),

  /**
   * 重置用户登录密码（仅管理员）
   * 成功后该用户既有会话全部失效，需用新密码重新登录。
   */
  adminResetPassword: (id: number, password: string) =>
    request<{ ok: true; id: number; username: string; reset: true }>(`/api/admin/users/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resetPassword', password }),
    }),

  /**
   * 删除用户（仅管理员）—— 数据库 `ON DELETE CASCADE` 会级联清理该用户的
   * 登录会话、自选、持仓与每日快照（position_daily / account_daily）。
   */
  adminDeleteUser: (id: number) =>
    request<{ ok: true; deleted: number; username: string }>(`/api/admin/users/${id}`, { method: 'DELETE' }),
};

/** 便于在 UI 上区分“后端不可用”与业务错误 */
export const isOffline = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 404);
