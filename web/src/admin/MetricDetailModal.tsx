import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Table2, X } from 'lucide-react';
import { api, ApiError, type AdminMetricDetail } from '../lib/api';

/** 数值展示：金额千分位、涨幅带符号、时间截断到分钟 */
function formatCell(value: string | number | null, label: string) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 16).replace('T', ' ');
    if (label.includes('%')) return value;
    return value;
  }
  const isPercent = label.includes('%');
  const isMoney = /金额|收益|资产/.test(label);
  const isCount = /条数|只数|数$|用户数|天数|行数|ID|剩余/.test(label);
  if (isPercent) return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  if (isMoney) return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (isCount) return String(value);
  return String(value);
}

/**
 * 运营指标明细弹层：点击后台「系统运营数据」的指标卡后下钻查看构成数据。
 * 列定义由后端返回（/api/admin/metrics/:key），前端通用渲染；手机端表格可横向滚动。
 */
export function MetricDetailModal({ metricKey, onClose }: { metricKey: string; onClose: () => void }) {
  const [data, setData] = useState<AdminMetricDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.adminMetric(metricKey);
      setData(r);
      setError('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [metricKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-mask px-3 py-6 sm:px-6"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        data-testid="metric-detail"
        className="anim-sheet flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-card bg-white shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary">
            <Table2 size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold text-ink">{data?.title || '指标明细'}</h3>
            <p className="truncate text-[12px] text-ink-2">
              {data?.note}
              {data ? ` · 共 ${data.total} 条${data.truncated ? `（显示前 ${data.items.length} 条）` : ''}` : ''}
            </p>
          </div>
          <button
            type="button"
            aria-label="刷新明细"
            onClick={() => void load()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-field"
          >
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            aria-label="关闭明细"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-field"
          >
            <X size={16} />
          </button>
        </div>

        {/* 明细表：手机可横向滚动 */}
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="px-4 py-6 text-center text-[13px] text-up">{error}</p>
          ) : !data ? (
            <p className="px-4 py-6 text-center text-[13px] text-ink-3">{loading ? '加载中…' : '暂无数据'}</p>
          ) : data.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-[13px] text-ink-3">暂无数据</p>
          ) : (
            <table className="w-full min-w-[520px] text-left text-[13px]">
              <thead className="sticky top-0 bg-field text-[12px] text-ink-2">
                <tr>
                  {data.columns.map((c) => (
                    <th
                      key={c.key}
                      className={['whitespace-nowrap px-3 py-2.5 font-medium sm:px-4', c.align === 'right' ? 'text-right' : ''].join(' ')}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map((row, i) => (
                  <tr key={i} className={i % 2 ? 'bg-[#FCFCFD]' : ''}>
                    {data.columns.map((c) => (
                      <td
                        key={c.key}
                        className={[
                          'whitespace-nowrap px-3 py-2 sm:px-4',
                          c.align === 'right' ? 'tnum text-right text-ink' : 'text-ink-2',
                          c.key === 'name' || c.key === 'username' ? 'max-w-[180px] truncate font-medium text-ink' : '',
                        ].join(' ')}
                      >
                        {formatCell(row[c.key], c.label)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 sm:px-5">
          <span className="text-[11.5px] text-ink-3">数据来源：GET /api/admin/metrics/{metricKey}</span>
          <button
            type="button"
            onClick={onClose}
            className="h-9 shrink-0 rounded-full bg-field px-5 text-[13.5px] font-medium text-ink-2 hover:bg-line"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
