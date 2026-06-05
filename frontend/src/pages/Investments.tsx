import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { investmentsDS, superDS, parseDocument } from '../services/dataService';
import { formatCurrency, formatPercent, colorForChange, formatTimestamp } from '../utils/format';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import { Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, Legend } from 'chart.js';

ChartJS.register(ArcElement, Tooltip, Legend);

const MARKETS = [
  'ASX', 'NYSE', 'NASDAQ', 'LSE', 'TSX',
  'Crypto', 'Managed Fund', 'Physical Precious Metals',
  'Private Investment', 'Other',
];
const METALS = ['Gold', 'Silver', 'Copper', 'Platinum'];
const ASSET_COLORS: Record<string, string> = {
  stock: '#3b7dd8', etf: '#22c55e', crypto: '#f59e0b',
  precious_metal: '#ef4444', managed_fund: '#8b5cf6',
  private: '#6b7280', other: '#9ca3af',
};

type Tab = 'Investments' | 'Super';

// ── Shared types ────────────────────────────────────────────────────────────

interface TickerResult {
  symbol: string;
  name: string;
  market: string;
  assetType: string;
  typeDisplay: string;
}

interface ParsedHolding {
  ticker: string;
  name: string;
  market: string;
  asset_type: string;
  currency: string;
  shares_owned: number;
  cost_basis: number;
  current_value: number | null;
  current_price: number | null;
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function Investments() {
  const { user, investments, setInvestments, portfolioTotal, setPortfolioTotal, superFunds, setSuperFunds } = useStore();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Investments');
  const [addOpen, setAddOpen] = useState(false);
  const [addSuperOpen, setAddSuperOpen] = useState(false);
  const [editInv, setEditInv] = useState<typeof investments[0] | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const currency = user?.currency_preference ?? 'AUD';

  useEffect(() => {
    const { investments: invs, portfolio_total } = investmentsDS.getAll();
    setInvestments(invs);
    setPortfolioTotal(portfolio_total);
  }, []); // eslint-disable-line

  useEffect(() => {
    const add = searchParams.get('add');
    if (add === 'investment') setAddOpen(true);
    if (add === 'super') { setActiveTab('Super'); setAddSuperOpen(true); }
  }, [searchParams]);

  // Convert each holding's native cost basis into the preferred currency so it can
  // be compared against the (already converted) portfolio value. Mixing native USD
  // cost with converted AUD value otherwise produces a wildly wrong P&L.
  const totalCostBasis = investments.reduce((s, i) => s + i.cost_basis * (i.conversion_rate ?? 1), 0);
  const totalPL = portfolioTotal - totalCostBasis;
  const totalPLPct = totalCostBasis > 0 ? (totalPL / totalCostBasis) * 100 : 0;

  // Price-freshness disclaimer. Prices refresh on the backend on a fixed cadence:
  // crypto every 2h (00:00, 02:00, …), everything else every 4h (00:00, 04:00,
  // 08:00, …). Show how stale the data is and when the next refresh lands.
  const priceFreshness = (() => {
    if (investments.length === 0) return null;
    const stamps = investments
      .map(i => i.last_price_update)
      .filter((s): s is string => !!s)
      .map(s => new Date(s).getTime());
    if (stamps.length === 0) return null;
    const newest = Math.max(...stamps);

    const hasCrypto = investments.some(i => i.asset_type === 'crypto');
    const hasOther = investments.some(i => i.asset_type !== 'crypto');
    const now = new Date();
    const nextBoundary = (stepHours: number) => {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      const next = Math.ceil((now.getHours() + now.getMinutes() / 60 + 0.0001) / stepHours) * stepHours;
      d.setHours(next);
      return d.getTime();
    };
    const candidates: number[] = [];
    if (hasCrypto) candidates.push(nextBoundary(2));
    if (hasOther) candidates.push(nextBoundary(4));
    const nextUpdate = Math.min(...candidates);

    const fmtSince = (ms: number) => {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      if (h === 0 && m <= 1) return 'just now';
      if (h === 0) return `${m} min ago`;
      if (h === 1) return '1 hour ago';
      return `${h} hours ago`;
    };
    const fmtUntil = (ms: number) => {
      const mins = Math.max(1, Math.round(ms / 60_000));
      if (mins < 60) return `in ${mins} min`;
      const h = Math.round(mins / 60);
      return `in ${h} hour${h === 1 ? '' : 's'}`;
    };
    return {
      since: fmtSince(now.getTime() - newest),
      until: fmtUntil(nextUpdate - now.getTime()),
    };
  })();

  const byType = investments.reduce((acc, inv) => {
    acc[inv.asset_type] = (acc[inv.asset_type] ?? 0) + (inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1));
    return acc;
  }, {} as Record<string, number>);

  const donutData = {
    labels: Object.keys(byType).map(k => k.replace('_', ' ')),
    datasets: [{
      data: Object.values(byType),
      backgroundColor: Object.keys(byType).map(k => ASSET_COLORS[k] ?? '#9ca3af'),
      borderWidth: 0,
    }],
  };

  const grouped = investments.reduce((acc, inv) => {
    if (!acc[inv.asset_type]) acc[inv.asset_type] = [];
    acc[inv.asset_type].push(inv);
    return acc;
  }, {} as Record<string, typeof investments>);

  const refreshInvestments = () => {
    const { investments: invs, portfolio_total } = investmentsDS.getAll();
    setInvestments(invs);
    setPortfolioTotal(portfolio_total);
  };

  const handleBulkImport = (holdings: ParsedHolding[]) => {
    holdings.forEach(h => {
      investmentsDS.add({
        ticker:            h.ticker || undefined,
        name:              h.name || h.ticker || 'Unknown',
        market:            h.market,
        asset_type:        h.asset_type,
        shares_owned:      h.shares_owned,
        cost_basis:        h.cost_basis,
        current_price:     h.current_price ?? 0,
        current_value:     h.current_value ?? (h.shares_owned * (h.current_price ?? 0)),
        currency:          h.currency || 'AUD',
        native_currency:   h.currency || 'AUD',
        is_dividend_paying: false,
      } as Parameters<typeof investmentsDS.add>[0]);
    });
    refreshInvestments();
  };

  return (
    <Layout>
      <h1 className="text-2xl font-semibold mb-6">Investments</h1>

      {/* Tabs */}
      <div className="flex border-b border-[#e5e5e5] dark:border-[#2a2a2a] mb-6">
        {(['Investments', 'Super'] as Tab[]).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-6 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 ${activeTab === tab ? 'text-[#3b7dd8] border-[#3b7dd8]' : 'text-[#6b6b6b] dark:text-[#a0a0a0] border-transparent'}`}>
            {tab}
          </button>
        ))}
      </div>

      {/* ── INVESTMENTS TAB ── */}
      {activeTab === 'Investments' && (
        <div>
          {/* Price freshness disclaimer */}
          {priceFreshness && (
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-3 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] flex-shrink-0" />
              Prices as of {priceFreshness.since} · updating {priceFreshness.until}
            </p>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <Card>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Portfolio Value</p>
              <p className="text-2xl font-semibold amount mt-1">{formatCurrency(portfolioTotal, currency)}</p>
            </Card>
            <Card>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Total P&amp;L</p>
              <p className={`text-2xl font-semibold amount mt-1 ${colorForChange(totalPL)}`}>
                {totalPL >= 0 ? '+' : ''}{formatCurrency(totalPL, currency)}
              </p>
            </Card>
            <Card>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Total Return</p>
              <p className={`text-2xl font-semibold mt-1 ${colorForChange(totalPLPct)}`}>{formatPercent(totalPLPct)}</p>
            </Card>
          </div>

          {/* Donut chart */}
          {investments.length > 0 && (
            <Card className="mb-6">
              <h3 className="font-medium mb-4">Portfolio Allocation</h3>
              <div className="flex items-center gap-6 flex-wrap">
                <div className="w-32 h-32 flex-shrink-0">
                  <Doughnut data={donutData} options={{ responsive: true, maintainAspectRatio: true, plugins: { legend: { display: false } }, cutout: '65%' }} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {Object.entries(byType).map(([type, value]) => (
                    <div key={type} className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ASSET_COLORS[type] ?? '#9ca3af' }} />
                      <span className="text-xs capitalize text-[#6b6b6b] dark:text-[#a0a0a0]">
                        {type.replace('_', ' ')} ({portfolioTotal > 0 ? Math.round((value / portfolioTotal) * 100) : 0}%)
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          )}

          {/* Holdings list header */}
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-semibold">Holdings ({investments.length})</h2>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                📂 Import Portfolio
              </Button>
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Investment</Button>
            </div>
          </div>

          {investments.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">📈</div>
              <h3 className="font-medium mb-1">No investments yet</h3>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
                Add individual holdings or import a portfolio from your broker.
              </p>
              <div className="flex justify-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>📂 Import Portfolio</Button>
                <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>+ Add Investment</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(grouped).map(([type, holdings]) => (
                <div key={type}>
                  <h3 className="text-xs font-semibold text-[#6b6b6b] dark:text-[#a0a0a0] uppercase tracking-wide mb-2 capitalize">
                    {type.replace('_', ' ')}
                  </h3>
                  <div className="space-y-2">
                    {holdings.map(inv => {
                      // conversion_rate converts the holding's native currency into the
                      // user's preferred currency. Apply it to every displayed figure so
                      // USD holdings show in the preferred currency, not raw USD.
                      const rate = inv.conversion_rate ?? 1;
                      const nativePl = inv.verification?.profit_loss ?? (inv.current_value - inv.cost_basis);
                      const pl = nativePl * rate;
                      const plPct = inv.verification?.profit_loss_percent ?? (inv.cost_basis > 0 ? (nativePl / inv.cost_basis) * 100 : 0);
                      const val = inv.display_value ?? (inv.current_value * rate);
                      const cost = inv.cost_basis * rate;
                      const priceDisplay = inv.current_price * rate;
                      return (
                        <Card key={inv.id}>
                          <div className="flex items-start justify-between">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h4 className="font-medium">{inv.ticker ?? inv.name}</h4>
                                {inv.ticker && inv.name !== inv.ticker && <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate">{inv.name}</span>}
                                {inv.is_dividend_paying && <span className="badge bg-[#3b7dd8]/10 text-[#3b7dd8] text-[10px]">DIV</span>}
                                {inv.verification && !inv.verification.is_verified && <span className="badge bg-[#f59e0b]/10 text-[#f59e0b] text-[10px]">⚠ Verify</span>}
                              </div>
                              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">
                                {inv.market} · {inv.shares_owned} {inv.asset_type === 'crypto' ? 'units' : inv.asset_type === 'precious_metal' ? 'g' : 'shares'} · Cost: {formatCurrency(cost, currency)}
                              </p>
                            </div>
                            <div className="text-right ml-4 flex-shrink-0">
                              <p className="font-semibold amount">{formatCurrency(val, currency)}</p>
                              <p className={`text-sm amount ${colorForChange(pl)}`}>
                                {pl >= 0 ? '+' : ''}{formatCurrency(pl, currency)} ({formatPercent(plPct)})
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                              {inv.current_price > 0 && `Price: ${formatCurrency(priceDisplay, currency)}`}
                              {inv.last_price_update && ` · As of ${formatTimestamp(inv.last_price_update)}`}
                              {inv.current_price === 0 && 'No live price — manual'}
                            </p>
                            <div className="flex gap-3 text-xs">
                              <button onClick={() => setEditInv(inv)} className="text-[#3b7dd8] hover:underline">Edit</button>
                              <button onClick={() => setDeleteId(inv.id)} className="text-[#6b6b6b] hover:text-[#ef4444]">Remove</button>
                            </div>
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SUPER TAB ── */}
      {activeTab === 'Super' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <div>
              <h2 className="font-semibold">Superannuation</h2>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Total: {formatCurrency(superFunds.reduce((s, f) => s + f.balance, 0), currency)}</p>
            </div>
            <Button variant="primary" size="sm" onClick={() => setAddSuperOpen(true)}>+ Add Fund</Button>
          </div>
          {superFunds.length === 0 ? (
            <div className="text-center py-12">
              <div className="text-4xl mb-3">🏦</div>
              <h3 className="font-medium mb-1">No super funds added</h3>
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Upload your annual super statement or add manually.</p>
              <Button variant="secondary" size="sm" onClick={() => setAddSuperOpen(true)}>+ Add Super Fund</Button>
            </div>
          ) : (
            <div className="space-y-3">
              {superFunds.map(fund => (
                <Card key={fund.id}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-medium">{fund.fund_name}</h3>
                      {fund.investment_option && <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{fund.investment_option}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold amount">{formatCurrency(fund.balance, currency)}</p>
                      <button onClick={() => { superDS.remove(fund.id); setSuperFunds(superDS.getAll()); }} className="text-xs text-[#6b6b6b] hover:text-[#ef4444] mt-1">Remove</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                    <div>
                      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Employer contributions</p>
                      <p className="text-sm font-medium amount">{formatCurrency(fund.employer_contributions, currency)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Personal contributions</p>
                      <p className="text-sm font-medium amount">{formatCurrency(fund.personal_contributions, currency)}</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── MODALS ── */}
      <AddInvestmentModal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onSave={(data) => {
          investmentsDS.add(data as Parameters<typeof investmentsDS.add>[0]);
          refreshInvestments();
          setAddOpen(false);
        }}
      />

      {editInv && (
        <EditInvestmentModal
          inv={editInv}
          onClose={() => setEditInv(null)}
          onSave={(id, data) => {
            investmentsDS.update(id, data);
            refreshInvestments();
            setEditInv(null);
          }}
        />
      )}

      <ImportPortfolioModal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={(holdings) => {
          handleBulkImport(holdings);
          setImportOpen(false);
        }}
      />

      <AddSuperModal
        isOpen={addSuperOpen}
        onClose={() => setAddSuperOpen(false)}
        onSave={(data) => {
          superDS.add(data as Parameters<typeof superDS.add>[0]);
          setSuperFunds(superDS.getAll());
          setAddSuperOpen(false);
        }}
      />

      <Modal isOpen={!!deleteId} onClose={() => setDeleteId(null)} title="Remove Investment" size="sm">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">Remove this investment from your portfolio?</p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={() => setDeleteId(null)} fullWidth>Cancel</Button>
          <Button variant="danger" onClick={() => { if (deleteId) { investmentsDS.remove(deleteId); refreshInvestments(); setDeleteId(null); } }} fullWidth>Remove</Button>
        </div>
      </Modal>
    </Layout>
  );
}

// ─── Ticker Autocomplete ─────────────────────────────────────────────────────

function TickerAutocomplete({
  value,
  onChange,
  onSelect,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (result: TickerResult, price: number, currency: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const [results, setResults] = useState<TickerResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Debounced search
  useEffect(() => {
    if (value.length < 1) { setResults([]); setOpen(false); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/investments/search?q=${encodeURIComponent(value)}`);
        if (res.ok) {
          const data = await res.json() as TickerResult[];
          setResults(data);
          setOpen(data.length > 0);
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [value]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = async (r: TickerResult) => {
    setOpen(false);
    onChange(r.symbol);
    setFetchingPrice(true);
    try {
      const res = await fetch(`/api/investments/price/${encodeURIComponent(r.symbol)}?market=${encodeURIComponent(r.market)}`);
      if (res.ok) {
        const { price, currency } = await res.json() as { price: number; currency: string };
        onSelect(r, price || 0, currency || 'AUD');
      } else {
        onSelect(r, 0, 'AUD');
      }
    } catch {
      onSelect(r, 0, 'AUD');
    }
    setFetchingPrice(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Input
          label={label ?? 'Ticker symbol'}
          value={value}
          onChange={e => onChange(e.target.value.toUpperCase())}
          placeholder={placeholder ?? 'e.g. CBA, SPY, BTC'}
        />
        {(searching || fetchingPrice) && (
          <div className="absolute right-3 bottom-3">
            <div className="w-3.5 h-3.5 border-2 border-[#3b7dd8] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
      {fetchingPrice && (
        <p className="text-[11px] text-[#3b7dd8] mt-0.5">Fetching live price…</p>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-50 w-full mt-1 bg-white dark:bg-[#1a1a1a] border border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[8px] shadow-lg max-h-52 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.symbol}
              type="button"
              className="w-full px-3 py-2.5 text-left hover:bg-[#f5f5f5] dark:hover:bg-[#252525] flex items-center justify-between gap-2 transition-colors border-b border-[#f0f0f0] dark:border-[#222] last:border-0"
              onMouseDown={e => { e.preventDefault(); handleSelect(r); }}
            >
              <div className="flex-1 min-w-0">
                <span className="font-medium text-sm">{r.symbol}</span>
                <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] ml-2 truncate">{r.name}</span>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[10px] bg-[#3b7dd8]/10 text-[#3b7dd8] px-1.5 py-0.5 rounded font-medium">{r.typeDisplay}</span>
                <span className="text-[10px] text-[#6b6b6b] dark:text-[#a0a0a0]">{r.market}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Add Investment Modal ────────────────────────────────────────────────────

function AddInvestmentModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void }) {
  const [market, setMarket] = useState('ASX');
  const [form, setForm] = useState({
    ticker: '', name: '', shares_owned: '', cost_basis: '', current_price: '',
    asset_type: 'stock', is_dividend_paying: false,
    metal_weight: '', metal_unit: 'grams', native_currency: 'AUD',
  });

  const isMetal   = market === 'Physical Precious Metals';
  const isPrivate = market === 'Private Investment' || market === 'Managed Fund';

  const handleTickerSelect = (result: TickerResult, price: number, currency: string) => {
    setMarket(result.market in { ASX:1, NYSE:1, NASDAQ:1, LSE:1, TSX:1, Crypto:1 } ? result.market : market);
    setForm(f => ({
      ...f,
      ticker:          result.symbol,
      name:            result.name,
      asset_type:      result.assetType,
      current_price:   price > 0 ? String(price) : f.current_price,
      native_currency: currency || 'AUD',
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ticker:            (!isMetal && !isPrivate) ? form.ticker.toUpperCase() || undefined : undefined,
      name:              form.name || form.ticker || (isMetal ? form.ticker : 'Unknown'),
      market,
      asset_type:        isMetal ? 'precious_metal' : isPrivate ? (market === 'Managed Fund' ? 'managed_fund' : 'private') : form.asset_type,
      shares_owned:      parseFloat(isMetal ? form.metal_weight : form.shares_owned) || 0,
      cost_basis:        parseFloat(form.cost_basis) || 0,
      current_price:     parseFloat(form.current_price) || 0,
      native_currency:   form.native_currency,
      is_dividend_paying: form.is_dividend_paying,
    });
    setForm({ ticker: '', name: '', shares_owned: '', cost_basis: '', current_price: '', asset_type: 'stock', is_dividend_paying: false, metal_weight: '', metal_unit: 'grams', native_currency: 'AUD' });
    setMarket('ASX');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Investment" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select label="Market" value={market} onChange={e => setMarket(e.target.value)} options={MARKETS.map(m => ({ value: m, label: m }))} />

        {isMetal ? (
          <>
            <Select label="Metal" value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value, name: e.target.value }))} options={METALS.map(m => ({ value: m, label: m }))} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Weight" type="number" step="0.001" value={form.metal_weight} onChange={e => setForm(f => ({ ...f, metal_weight: e.target.value }))} placeholder="e.g. 100" required />
              <Select label="Unit" value={form.metal_unit} onChange={e => setForm(f => ({ ...f, metal_unit: e.target.value }))} options={[{ value: 'grams', label: 'Grams' }, { value: 'ounces', label: 'Troy oz' }, { value: 'kg', label: 'Kilograms' }]} />
            </div>
          </>
        ) : isPrivate ? (
          <Input label="Investment name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Startup investment" required />
        ) : (
          <TickerAutocomplete
            value={form.ticker}
            onChange={v => setForm(f => ({ ...f, ticker: v }))}
            onSelect={handleTickerSelect}
            label={market === 'Crypto' ? 'Ticker (e.g. BTC-AUD)' : market === 'ASX' ? 'Ticker (e.g. CBA.AX or CBA)' : 'Ticker symbol'}
            placeholder={market === 'ASX' ? 'e.g. VAS' : market === 'Crypto' ? 'e.g. BTC-AUD' : 'e.g. AAPL'}
          />
        )}

        {!isMetal && (
          <Input
            label="Company / fund name (optional)"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder={form.ticker ? 'Auto-filled from ticker search' : 'e.g. Vanguard Australian Shares ETF'}
          />
        )}

        <div className="grid grid-cols-2 gap-3">
          {!isMetal && (
            <Input label={market === 'Crypto' ? 'Units owned' : 'Shares / units'} type="number" step="0.00000001" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
          )}
          <Input label="Total cost basis" type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} hint="Total amount you paid" required className={isMetal ? 'col-span-1' : ''} />
        </div>

        <Input
          label="Current price per unit (optional)"
          type="number" step="0.00000001" prefix="$"
          value={form.current_price}
          onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))}
          hint={form.current_price ? 'Auto-filled from Yahoo Finance' : 'Leave blank — search for a ticker to auto-fill'}
        />

        {!isMetal && !isPrivate && (
          <Select label="Asset type" value={form.asset_type} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))}
            options={[{ value: 'stock', label: 'Stock' }, { value: 'etf', label: 'ETF' }, { value: 'managed_fund', label: 'Managed Fund' }, { value: 'other', label: 'Other' }]}
          />
        )}

        <Toggle label="Dividend / distribution paying" checked={form.is_dividend_paying} onChange={v => setForm(f => ({ ...f, is_dividend_paying: v }))} />

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Investment</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Import Portfolio Modal ──────────────────────────────────────────────────

function ImportPortfolioModal({
  isOpen,
  onClose,
  onImport,
}: {
  isOpen: boolean;
  onClose: () => void;
  onImport: (holdings: ParsedHolding[]) => void;
}) {
  const [step, setStep] = useState<'upload' | 'confirm'>('upload');
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [portfolioName, setPortfolioName] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<ParsedHolding[]>([]);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editBuf, setEditBuf] = useState<Partial<ParsedHolding>>({});

  const reset = () => {
    setStep('upload');
    setParsing(false);
    setParseError(null);
    setPortfolioName(null);
    setHoldings([]);
    setEditIdx(null);
    setEditBuf({});
  };

  const handleClose = () => { reset(); onClose(); };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError(null);

    const { parsed, error } = await parseDocument(file, 'investment_portfolio');
    setParsing(false);

    if (error || !parsed) {
      setParseError(error ?? 'Failed to parse document. Please check the file and try again.');
      e.target.value = '';
      return;
    }

    // Normalise raw Claude output
    type RawHolding = Record<string, unknown>;
    const rawHoldings = (parsed.holdings as RawHolding[] | undefined) ?? [];

    if (rawHoldings.length === 0) {
      setParseError('No holdings detected. Make sure the file is a portfolio export from your broker.');
      e.target.value = '';
      return;
    }

    const normalized: ParsedHolding[] = rawHoldings.map((r): ParsedHolding => {
      const market = String(r.market ?? 'ASX').trim();
      const usMarket = /nasdaq|nyse|us|amex/i.test(market);
      const currency = String(r.currency ?? (usMarket ? 'USD' : 'AUD')).trim().toUpperCase() || 'AUD';
      return {
      ticker:        String(r.ticker ?? '').trim().toUpperCase(),
      name:          String(r.name ?? r.ticker ?? 'Unknown').trim(),
      market,
      asset_type:    String(r.asset_type ?? 'stock').trim(),
      currency,
      shares_owned:  Number(r.shares_owned) || 0,
      cost_basis:    Number(r.cost_basis)   || 0,
      current_value: r.current_value != null && r.current_value !== '' ? Number(r.current_value) || null : null,
      current_price: r.current_price != null && r.current_price !== '' ? Number(r.current_price) || null : null,
      };
    });

    setPortfolioName((parsed.portfolio_name as string | null) ?? null);
    setHoldings(normalized);
    setStep('confirm');
    e.target.value = '';
  };

  const startEdit = (idx: number) => {
    setEditIdx(idx);
    setEditBuf({ ...holdings[idx] });
  };

  const saveEdit = () => {
    if (editIdx === null) return;
    setHoldings(prev => prev.map((h, i) => i === editIdx ? { ...h, ...editBuf } as ParsedHolding : h));
    setEditIdx(null);
    setEditBuf({});
  };

  const removeHolding = (idx: number) => {
    setHoldings(prev => prev.filter((_, i) => i !== idx));
    if (editIdx === idx) setEditIdx(null);
  };

  const handleConfirm = () => {
    onImport(holdings);
    reset();
  };

  const currency = useStore.getState().user?.currency_preference ?? 'AUD';

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import Portfolio" size="lg">
      {/* ── Upload step ── */}
      {step === 'upload' && (
        <div>
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mb-4">
            Upload a portfolio export from your broker. Claude will extract all holdings automatically.
          </p>

          {/* Supported brokers hint */}
          <div className="mb-4 px-3 py-2.5 rounded-[8px] bg-[#f5f5f5] dark:bg-[#1e1e1e] text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            <span className="font-medium text-[#333] dark:text-[#ccc]">Supported brokers: </span>
            CommSec · SelfWealth · Stake · Interactive Brokers · CMC Markets · Sharesight · and more
          </div>

          {/* Drop zone */}
          <label className={`w-full flex flex-col items-center justify-center gap-2 px-4 py-8 mb-4 rounded-[8px] border-2 border-dashed cursor-pointer transition-colors ${parsing ? 'border-[#3b7dd8]/40 bg-[#3b7dd8]/5' : 'border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 hover:bg-[#3b7dd8]/5'}`}>
            {parsing ? (
              <>
                <div className="w-8 h-8 border-2 border-[#3b7dd8] border-t-transparent rounded-full animate-spin" />
                <p className="text-sm font-medium text-[#3b7dd8]">Analysing your portfolio…</p>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">This may take 15–30 seconds</p>
              </>
            ) : (
              <>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#6b6b6b] dark:text-[#a0a0a0]">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <p className="text-sm font-medium">Click to upload portfolio file</p>
                <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">PDF or CSV · up to 20 MB</p>
              </>
            )}
            <input type="file" accept=".pdf,.csv,image/*" className="hidden" onChange={handleFile} disabled={parsing} />
          </label>

          {parseError && (
            <div className="px-3 py-2.5 rounded-[8px] bg-[#ef4444]/10 text-[#ef4444] text-sm mb-4">
              {parseError}
            </div>
          )}

          <Button variant="secondary" type="button" onClick={handleClose} fullWidth>Cancel</Button>
        </div>
      )}

      {/* ── Confirm step ── */}
      {step === 'confirm' && (
        <div>
          {/* Summary header */}
          <div className="mb-4 px-3 py-3 rounded-[8px] bg-[#22c55e]/10 text-[#22c55e] text-sm">
            <span className="font-semibold">Found {holdings.length} investment{holdings.length !== 1 ? 's' : ''}</span>
            {portfolioName && <span className="text-[#22c55e]/80"> in {portfolioName}</span>}
            <span className="text-[#22c55e]/80">. Review and edit below, then confirm to import.</span>
          </div>

          {/* Holdings list */}
          <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1 mb-4">
            {holdings.map((h, idx) => (
              <div key={idx} className="rounded-[8px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
                {/* Row */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm">{h.ticker || '—'}</span>
                      {h.ticker !== h.name && <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] truncate max-w-[160px]">{h.name}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#3b7dd8]/10 text-[#3b7dd8] font-medium">{h.market}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${h.currency === 'USD' ? 'bg-[#22c55e]/10 text-[#22c55e]' : 'bg-[#f59e0b]/10 text-[#f59e0b]'}`}>{h.currency}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#f5f5f5] dark:bg-[#252525] text-[#6b6b6b] dark:text-[#a0a0a0] capitalize">{h.asset_type.replace('_', ' ')}</span>
                    </div>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-0.5">
                      {h.shares_owned} {h.asset_type === 'crypto' ? 'units' : 'shares'} · Cost: {formatCurrency(h.cost_basis, h.currency || currency)}
                      {h.current_value != null && ` · Value: ${formatCurrency(h.current_value, h.currency || currency)}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => editIdx === idx ? setEditIdx(null) : startEdit(idx)}
                      className="text-xs text-[#3b7dd8] hover:underline"
                    >
                      {editIdx === idx ? 'Cancel' : 'Edit'}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeHolding(idx)}
                      className="text-xs text-[#6b6b6b] hover:text-[#ef4444]"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {/* Inline edit form */}
                {editIdx === idx && (
                  <div className="px-3 pb-3 pt-2 border-t border-[#e5e5e5] dark:border-[#2a2a2a] bg-[#fafafa] dark:bg-[#161616] space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Ticker"
                        value={String(editBuf.ticker ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, ticker: e.target.value.toUpperCase() }))}
                      />
                      <Input
                        label="Name"
                        value={String(editBuf.name ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, name: e.target.value }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Shares / units"
                        type="number"
                        step="0.00000001"
                        value={String(editBuf.shares_owned ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, shares_owned: parseFloat(e.target.value) || 0 }))}
                      />
                      <Input
                        label="Total cost basis"
                        type="number"
                        step="0.01"
                        prefix="$"
                        value={String(editBuf.cost_basis ?? '')}
                        onChange={e => setEditBuf(b => ({ ...b, cost_basis: parseFloat(e.target.value) || 0 }))}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Select
                        label="Market"
                        value={String(editBuf.market ?? 'ASX')}
                        onChange={e => setEditBuf(b => ({ ...b, market: e.target.value }))}
                        options={MARKETS.map(m => ({ value: m, label: m }))}
                      />
                      <Select
                        label="Asset type"
                        value={String(editBuf.asset_type ?? 'stock')}
                        onChange={e => setEditBuf(b => ({ ...b, asset_type: e.target.value }))}
                        options={[
                          { value: 'stock', label: 'Stock' },
                          { value: 'etf', label: 'ETF' },
                          { value: 'managed_fund', label: 'Managed Fund' },
                          { value: 'crypto', label: 'Crypto' },
                          { value: 'other', label: 'Other' },
                        ]}
                      />
                    </div>
                    <Select
                      label="Native currency"
                      value={String(editBuf.currency ?? 'AUD')}
                      onChange={e => setEditBuf(b => ({ ...b, currency: e.target.value }))}
                      options={[
                        { value: 'AUD', label: 'AUD — Australian (ASX)' },
                        { value: 'USD', label: 'USD — US-listed' },
                      ]}
                    />
                    <Button variant="primary" size="sm" onClick={saveEdit}>Save changes</Button>
                  </div>
                )}
              </div>
            ))}

            {holdings.length === 0 && (
              <div className="text-center py-6 text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
                All holdings removed. Go back to upload a different file.
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <Button
              variant="secondary"
              type="button"
              onClick={() => { setStep('upload'); setHoldings([]); setParseError(null); }}
            >
              ← Back
            </Button>
            <Button
              variant="primary"
              type="button"
              fullWidth
              onClick={handleConfirm}
              disabled={holdings.length === 0}
            >
              Import {holdings.length} holding{holdings.length !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Edit Investment Modal ───────────────────────────────────────────────────

function EditInvestmentModal({ inv, onClose, onSave }: {
  inv: ReturnType<typeof useStore.getState>['investments'][0];
  onClose: () => void;
  onSave: (id: string, data: object) => void;
}) {
  const [form, setForm] = useState({
    shares_owned:  String(inv.shares_owned),
    cost_basis:    String(inv.cost_basis),
    current_price: String(inv.current_price),
    name:          inv.name,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(inv.id, {
      shares_owned:  parseFloat(form.shares_owned),
      cost_basis:    parseFloat(form.cost_basis),
      current_price: parseFloat(form.current_price),
      name:          form.name,
    });
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={`Edit — ${inv.ticker ?? inv.name}`} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <Input label="Shares / units owned" type="number" step="0.00000001" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
        <Input label="Total cost basis" type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} required />
        <Input label="Current price per unit" type="number" step="0.00000001" prefix="$" value={form.current_price} onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))} />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Save Changes</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Super Fund Modal ────────────────────────────────────────────────────

function AddSuperModal({ isOpen, onClose, onSave }: { isOpen: boolean; onClose: () => void; onSave: (d: object) => void }) {
  const [form, setForm] = useState({ fund_name: '', balance: '', employer_contributions: '0', personal_contributions: '0', investment_option: '' });
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true); setUploadMsg('');
    const { parsed, error } = await parseDocument(file, 'super_statement');
    setUploading(false);
    if (error) { setUploadMsg(error); return; }
    if (parsed) {
      const p = parsed as Record<string, unknown>;
      setForm(f => ({
        ...f,
        fund_name:              String(p.fund_name ?? f.fund_name),
        balance:                String(p.balance ?? f.balance),
        employer_contributions: String(p.employer_contributions ?? f.employer_contributions),
        personal_contributions: String(p.personal_contributions ?? f.personal_contributions),
        investment_option:      String(p.investment_option ?? f.investment_option),
      }));
      setUploadMsg('Statement parsed — please review the details below.');
    }
    e.target.value = '';
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ...form,
      balance:                parseFloat(form.balance) || 0,
      employer_contributions: parseFloat(form.employer_contributions) || 0,
      personal_contributions: parseFloat(form.personal_contributions) || 0,
      include_in_investments: false,
      include_in_net_worth:   true,
    });
    setForm({ fund_name: '', balance: '', employer_contributions: '0', personal_contributions: '0', investment_option: '' });
    setUploadMsg('');
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Super Fund">
      <label className="w-full flex items-center justify-center gap-2 px-4 py-3 mb-4 rounded-[8px] border-2 border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] hover:border-[#3b7dd8]/40 cursor-pointer transition-colors">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">{uploading ? 'Reading statement…' : 'Upload super statement to auto-fill'}</span>
        <input type="file" accept=".pdf,image/*" className="hidden" onChange={handleUpload} />
      </label>
      {uploadMsg && (
        <div className={`mb-4 px-3 py-2 rounded-[8px] text-xs ${uploadMsg.includes('requires') ? 'bg-[#f59e0b]/10 text-[#f59e0b]' : 'bg-[#22c55e]/10 text-[#22c55e]'}`}>{uploadMsg}</div>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Fund name" value={form.fund_name} onChange={e => setForm(f => ({ ...f, fund_name: e.target.value }))} placeholder="e.g. AustralianSuper" required />
        <Input label="Current balance" type="number" step="0.01" prefix="$" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} required />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Employer contributions" type="number" step="0.01" prefix="$" value={form.employer_contributions} onChange={e => setForm(f => ({ ...f, employer_contributions: e.target.value }))} />
          <Input label="Personal contributions" type="number" step="0.01" prefix="$" value={form.personal_contributions} onChange={e => setForm(f => ({ ...f, personal_contributions: e.target.value }))} />
        </div>
        <Input label="Investment option (optional)" value={form.investment_option} onChange={e => setForm(f => ({ ...f, investment_option: e.target.value }))} placeholder="e.g. High Growth" />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Super Fund</Button>
        </div>
      </form>
    </Modal>
  );
}
