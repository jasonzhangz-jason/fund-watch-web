import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './state/auth';
import { StoreProvider } from './state/store';
import LedgerHome from './pages/LedgerHome';
import Watchlist from './pages/Watchlist';
import Search from './pages/Search';
import FundDetail from './pages/FundDetail';
import AddPosition from './pages/AddPosition';
import EditPositions from './pages/EditPositions';
import LedgerSettings from './pages/LedgerSettings';
import Mine from './pages/Mine';
import LookThrough from './pages/LookThrough';
import CorrelationPage from './pages/Correlation';

/**
 * 基金助手 · 路由
 *   /               账本主页（含操作浮层菜单）
 *   /watchlist      自选（账号落库 + 真实行情）
 *   /mine           我的（会话数据 + 自选入口 + 持仓穿透入口）
 *   /lookthrough    持仓穿透（按各基金前十大重仓股穿透到个股）
 *   /search         搜索（接 /api/search 实时搜索）
 *   /fund/:code     基金详情（/api/detail + /api/estimate + /api/nav，含数据源弹窗）
 *   /add            添加持仓
 *   /edit           修改持仓（行内展开编辑）
 *   /settings       账本设置（排序 / 批量删除）
 */
export default function App() {
  return (
    <AuthProvider>
      <StoreProvider>
        <HashRouter>
          <Routes>
            <Route path="/" element={<LedgerHome />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/mine" element={<Mine />} />
            <Route path="/lookthrough" element={<LookThrough />} />
            <Route path="/correlation" element={<CorrelationPage />} />
            <Route path="/search" element={<Search />} />
            <Route path="/fund/:code" element={<FundDetail />} />
            <Route path="/add" element={<AddPosition />} />
            <Route path="/edit" element={<EditPositions />} />
            <Route path="/settings" element={<LedgerSettings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </HashRouter>
      </StoreProvider>
    </AuthProvider>
  );
}
