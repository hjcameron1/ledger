import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { investmentsDS, superDS, parseDocument } from '../services/dataService';
import { payrollApi, API_BASE } from '../services/api';
import SMSFSection from './SMSFSection';
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
  'XETRA', 'Euronext Paris', 'Euronext Amsterdam', 'SIX', 'JPX', 'HKEX', 'NSE',
  'Crypto', 'Managed Fund', 'Physical Precious Metals',
  'Private Investment', 'Other',
];
const METALS = ['Gold', 'Silver', 'Copper', 'Platinum'];
const UNIT_ABBR: Record<string, string> = { grams: 'g', ounces: 'oz', kg: 'kg' };
const METAL_FORMS = [
  { value: 'minted_bar', label: 'Minted bar' },
  { value: 'cast_bar', label: 'Cast bar' },
  { value: 'coin', label: 'Coin' },
  { value: 'round', label: 'Round' },
  { value: 'bullion', label: 'Bullion / other' },
];
const METAL_FORM_LABEL: Record<string, string> = Object.fromEntries(METAL_FORMS.map(f => [f.value, f.label]));
// Common AU mints / brands as a fixed dropdown so casing/spelling stays consistent.
const METAL_MINTS = [
  'Perth Mint',
  'ABC Bullion',
  'Ainslie Bullion',
  'Royal Australian Mint',
  'PAMP',
  'Scottsdale Mint',
  'Royal Canadian Mint',
  'Other',
];

interface MetalProduct {
  id: string;
  dealer: string;
  metal: string;
  form: string | null;
  weight_grams: number | null;
  unit_label: string | null;
  product_name: string;
  url: string;
  buy_price: number | null;
  sell_price: number | null;
  spot_value: number | null;
  currency: string;
  in_stock: boolean;
}
const ASSET_COLORS: Record<string, string> = {
  stock: '#3b7dd8', etf: '#22c55e', crypto: '#f59e0b',
  precious_metal: '#ef4444', managed_fund: '#8b5cf6',
  private: '#6b7280', other: '#9ca3af',
};

type Tab = 'Investments' | 'Super' | 'SMSF';

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
  const { user, investments, setInvestments, portfolioTotal, setPortfolioTotal, superFunds, setSuperFunds, investmentsNextUpdate } = useStore();
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>('Investments');
  const [addOpen, setAddOpen] = useState(false);
  const [addSuperOpen, setAddSuperOpen] = useState(false);
  const [editInv, setEditInv] = useState<typeof investments[0] | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedSector, setSelectedSector] = useState<string | null>(null);

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

  // P&L is summed from each holding's preferred-currency profit_loss (computed in
  // dataService.getAll as value-in-preferred minus cost-in-preferred, honouring the
  // currency each cost was entered in). Total cost = total value − total P&L.
  const totalPL = investments.reduce((s, i) => s + (i.verification?.profit_loss ?? 0), 0);
  const totalCostBasis = portfolioTotal - totalPL;
  const totalPLPct = totalCostBasis > 0 ? (totalPL / totalCostBasis) * 100 : 0;

  // Price-freshness disclaimer. Prices (and the FX snapshot) only refresh while
  // each holding's market is open, then freeze until its next session. The
  // backend computes the soonest next refresh (next market open, or the next
  // hourly tick for anything currently trading) and returns it as next_update.
  const priceFreshness = (() => {
    if (investments.length === 0) return null;
    const stamps = investments
      .map(i => i.last_price_update)
      .filter((s): s is string => !!s)
      .map(s => new Date(s).getTime());
    const newest = stamps.length ? Math.max(...stamps) : null;
    const now = new Date();

    const fmtSince = (ms: number) => {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.round((ms % 3_600_000) / 60_000);
      if (h === 0 && m <= 1) return 'just now';
      if (h === 0) return `${m} min ago`;
      if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
      const d = Math.round(h / 24);
      return `${d} day${d === 1 ? '' : 's'} ago`;
    };
    const fmtUntil = (ms: number) => {
      const mins = Math.round(ms / 60_000);
      if (mins <= 1) return 'any moment';
      if (mins < 60) return `in ${mins} min`;
      const h = Math.round(mins / 60);
      if (h < 24) return `in ${h} hour${h === 1 ? '' : 's'}`;
      // Far out (market closed for the weekend / holiday) — show the day/time.
      return new Date(now.getTime() + ms).toLocaleString('en-AU', {
        weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
      });
    };

    const nextMs = investmentsNextUpdate ? new Date(investmentsNextUpdate).getTime() - now.getTime() : null;
    return {
      since: newest != null ? fmtSince(now.getTime() - newest) : null,
      until: nextMs != null && nextMs > 0 ? fmtUntil(nextMs) : null,
    };
  })();

  const byType = investments.reduce((acc, inv) => {
    acc[inv.asset_type] = (acc[inv.asset_type] ?? 0) + (inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1));
    return acc;
  }, {} as Record<string, number>);

  const sectorKeys = Object.keys(byType);
  const donutData = {
    labels: sectorKeys.map(k => k.replace('_', ' ')),
    datasets: [{
      data: Object.values(byType),
      backgroundColor: sectorKeys.map(k =>
        selectedSector && k !== selectedSector ? '#d4d4d4' : (ASSET_COLORS[k] ?? '#9ca3af')),
      borderWidth: 0,
    }],
  };

  // Aggregated stats for a single asset-type sector (value, cost, P&L, %).
  const sectorStats = (type: string) => {
    const holdings = (grouped[type] ?? []);
    const value = holdings.reduce((s, inv) => s + (inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1)), 0);
    const pl = holdings.reduce((s, inv) => s + (inv.verification?.profit_loss ?? 0), 0);
    const cost = holdings.reduce((s, inv) => s + (inv.display_cost ?? ((inv.display_value ?? inv.current_value * (inv.conversion_rate ?? 1)) - (inv.verification?.profit_loss ?? 0))), 0);
    const plPct = cost > 0 ? (pl / cost) * 100 : 0;
    const pctOfPortfolio = portfolioTotal > 0 ? (value / portfolioTotal) * 100 : 0;
    return { holdings, value, cost, pl, plPct, pctOfPortfolio };
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
        cost_basis_currency: h.currency || 'AUD',
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
        {(['Investments', 'Super', 'SMSF'] as Tab[]).map(tab => (
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
          {priceFreshness && (priceFreshness.since || priceFreshness.until) && (
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-3 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-[#22c55e] flex-shrink-0" />
              {priceFreshness.since && `Prices as of ${priceFreshness.since}`}
              {priceFreshness.since && priceFreshness.until && ' · '}
              {priceFreshness.until && `updating ${priceFreshness.until}`}
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
              <div className="flex items-start gap-6 flex-wrap">
                <div className="w-32 h-32 flex-shrink-0">
                  <Doughnut
                    data={donutData}
                    options={{
                      responsive: true, maintainAspectRatio: true, cutout: '65%',
                      plugins: { legend: { display: false } },
                      onClick: (_evt, els) => {
                        if (!els.length) return;
                        const key = sectorKeys[els[0].index];
                        setSelectedSector(prev => (prev === key ? null : key));
                      },
                      onHover: (evt, els) => {
                        const t = evt.native?.target as HTMLElement | undefined;
                        if (t) t.style.cursor = els.length ? 'pointer' : 'default';
                      },
                    }}
                  />
                </div>

                {selectedSector ? (
                  (() => {
                    const s = sectorStats(selectedSector);
                    return (
                      <div className="flex-1 min-w-[220px]">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ASSET_COLORS[selectedSector] ?? '#9ca3af' }} />
                            <h4 className="text-sm font-semibold capitalize">{selectedSector.replace('_', ' ')}</h4>
                            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">({s.pctOfPortfolio.toFixed(1)}% of portfolio)</span>
                          </div>
                          <button onClick={() => setSelectedSector(null)} className="text-xs text-[#3b7dd8] hover:underline">✕ Close</button>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">Value</p>
                            <p className="text-sm font-semibold amount">{formatCurrency(s.value, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">Cost</p>
                            <p className="text-sm font-semibold amount">{formatCurrency(s.cost, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">P&amp;L</p>
                            <p className={`text-sm font-semibold amount ${colorForChange(s.pl)}`}>{s.pl >= 0 ? '+' : ''}{formatCurrency(s.pl, currency)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] uppercase tracking-wide text-[#6b6b6b] dark:text-[#a0a0a0]">Return</p>
                            <p className={`text-sm font-semibold ${colorForChange(s.plPct)}`}>{formatPercent(s.plPct)}</p>
                          </div>
                        </div>
                        <div className="space-y-1 border-t border-[#e5e5e5] dark:border-[#2a2a2a] pt-2">
                          {s.holdings.map(inv => {
                            const rate = inv.conversion_rate ?? 1;
                            const val = inv.display_value ?? (inv.current_value * rate);
                            const plPct = inv.verification?.profit_loss_percent ?? 0;
                            return (
                              <div key={inv.id} className="flex items-center justify-between text-xs">
                                <span className="font-medium truncate mr-2">{inv.ticker ?? inv.name}</span>
                                <span className="flex items-center gap-2 flex-shrink-0">
                                  <span className="amount">{formatCurrency(val, currency)}</span>
                                  <span className={`amount ${colorForChange(plPct)}`}>{formatPercent(plPct)}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {Object.entries(byType).map(([type, value]) => (
                      <button key={type} onClick={() => setSelectedSector(type)} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity">
                        <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: ASSET_COLORS[type] ?? '#9ca3af' }} />
                        <span className="text-xs capitalize text-[#6b6b6b] dark:text-[#a0a0a0]">
                          {type.replace('_', ' ')} ({portfolioTotal > 0 ? Math.round((value / portfolioTotal) * 100) : 0}%)
                        </span>
                      </button>
                    ))}
                  </div>
                )}
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
                      // All display figures are already in the preferred currency
                      // (computed in dataService.getAll / the backend). P&L and cost
                      // are NOT re-multiplied by the FX rate here — doing so was the
                      // old bug. Only the per-unit price is shown in native too.
                      const rate = inv.conversion_rate ?? 1;
                      const val = inv.display_value ?? (inv.current_value * rate);
                      const pl = inv.verification?.profit_loss ?? 0;
                      const plPct = inv.verification?.profit_loss_percent ?? 0;
                      const cost = inv.display_cost ?? (val - pl);
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
                                {inv.market} · {inv.shares_owned} {inv.asset_type === 'crypto' ? 'units' : inv.asset_type === 'precious_metal' ? (UNIT_ABBR[inv.metal_unit ?? 'grams'] ?? 'g') : 'shares'} · Cost: {formatCurrency(cost, currency)}
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
                              {inv.current_price > 0 && rate !== 1 &&
                                ` (${formatCurrency(inv.current_price, inv.native_currency)} @ ${rate.toFixed(4)})`}
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
                      {fund.member_number && <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Member #{fund.member_number}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Balance</p>
                      <p className="text-lg font-semibold amount">{formatCurrency(fund.balance, currency)}</p>
                      <button onClick={() => { superDS.remove(fund.id); setSuperFunds(superDS.getAll()); }} className="text-xs text-[#6b6b6b] hover:text-[#ef4444] mt-1">Remove</button>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                    <p className="text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Contributions this financial year</p>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Employer</p>
                        <p className="text-sm font-medium amount">{formatCurrency(fund.employer_contributions, currency)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Personal</p>
                        <p className="text-sm font-medium amount">{formatCurrency(fund.personal_contributions, currency)}</p>
                      </div>
                      {fund.fees != null && fund.fees > 0 && (
                        <div>
                          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Fees (this year)</p>
                          <p className="text-sm font-medium amount">{formatCurrency(fund.fees, currency)}</p>
                        </div>
                      )}
                      {fund.insurance_details && (
                        <div className="col-span-2">
                          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Insurance</p>
                          <p className="text-sm font-medium">{fund.insurance_details}</p>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[#e5e5e5] dark:border-[#2a2a2a]">
                    <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">Count toward net worth</span>
                    <Toggle
                      size="sm"
                      checked={fund.include_in_net_worth}
                      onChange={(v) => { superDS.update(fund.id, { include_in_net_worth: v }); setSuperFunds(superDS.getAll()); }}
                    />
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Expected employer super (pending contributions ledger) */}
          <PendingSuperLedger currency={currency} />
        </div>
      )}

      {/* ── SMSF TAB ── */}
      {activeTab === 'SMSF' && <SMSFSection currency={currency} />}

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
  market,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (result: TickerResult, price: number, currency: string) => void;
  market?: string;
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
        const res = await fetch(`${API_BASE}/api/investments/search?q=${encodeURIComponent(value)}${market ? `&market=${encodeURIComponent(market)}` : ''}`);
        if (res.ok) {
          const data = await res.json() as TickerResult[];
          setResults(data);
          setOpen(data.length > 0);
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [value, market]);

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
      const res = await fetch(`${API_BASE}/api/investments/price/${encodeURIComponent(r.symbol)}?market=${encodeURIComponent(r.market)}`);
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
  const pref = useStore(s => s.user?.currency_preference) ?? 'AUD';
  const [market, setMarket] = useState('');
  const [form, setForm] = useState({
    ticker: '', name: '', shares_owned: '', cost_basis: '', profit_loss: '', current_price: '',
    asset_type: 'stock', is_dividend_paying: false,
    metal_weight: '', metal_unit: 'grams', native_currency: 'AUD',
    metal_detailed: false, metal_form: 'minted_bar', metal_mint: '',
    metal_buy_price: '', metal_sell_price: '',
  });
  // Scraped dealer products for the in-depth metal picker, + the chosen one.
  const [metalProducts, setMetalProducts] = useState<MetalProduct[]>([]);
  const [metalProductId, setMetalProductId] = useState('');
  // Which currency the cost / P&L inputs are denominated in.
  const [entryCcy, setEntryCcy] = useState<'native' | 'pref'>('native');
  // Live native → preferred FX rate (1 when same currency); powers the toggle and
  // the cost↔P&L auto-calc, and is passed to the backend as the snapshot rate.
  const [fxRate, setFxRate] = useState(1);

  const isMetal   = market === 'Physical Precious Metals';
  const isPrivate = market === 'Private Investment' || market === 'Managed Fund';
  const isForeign = !isMetal && !isPrivate && form.native_currency !== pref;
  // Currency the entered amounts are in.
  const inputCcy = isForeign && entryCcy === 'pref' ? pref : form.native_currency;

  // Fetch the FX rate whenever the holding's native currency changes.
  useEffect(() => {
    const nc = form.native_currency;
    if (isMetal || isPrivate || !nc || nc === pref) { setFxRate(1); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/fxrate?from=${encodeURIComponent(nc)}&to=${encodeURIComponent(pref)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { rate?: number } | null) => { if (!cancelled && d?.rate) setFxRate(d.rate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [form.native_currency, pref, isMetal, isPrivate]);

  // Seed the metal selection when switching into metal mode. The <select> shows
  // "Gold" by default but its bound value starts empty, so without this the spot
  // fetch (which needs a ticker) never fires until the user re-picks the metal.
  useEffect(() => {
    if (isMetal && !form.ticker) setForm(f => ({ ...f, ticker: METALS[0] }));
  }, [isMetal, form.ticker]);

  // Metals: pull the live spot price for the chosen metal + weight unit, converted
  // into the user's preferred currency, and use it as the per-unit value. This drives
  // the holding's worth in BOTH generic and in-depth modes — a holding's value is the
  // metal's live spot value, never a static figure. (The buy price/cost basis the
  // user enters is separate; the sell side is always auto = live spot.)
  useEffect(() => {
    if (!isMetal || !form.ticker) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/price/${encodeURIComponent(form.ticker)}?unit=${encodeURIComponent(form.metal_unit)}&currency=${encodeURIComponent(pref)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { price?: number; currency?: string } | null) => {
        if (cancelled || !d?.price) return;
        setForm(f => ({
          ...f,
          current_price: d.price!.toFixed(4),
          metal_sell_price: d.price!.toFixed(4),  // value/buyback auto-tracks spot
          native_currency: d.currency ?? pref,
        }));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isMetal, form.ticker, form.metal_unit, pref]);

  // Load scraped dealer products for the chosen metal when in-depth mode is on,
  // so the user can pick a real product instead of typing prices by hand.
  useEffect(() => {
    if (!isMetal || !form.metal_detailed || !form.ticker) { setMetalProducts([]); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/metal-products?metal=${encodeURIComponent(form.ticker)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { products?: MetalProduct[] } | null) => {
        if (cancelled) return;
        // Group by dealer (alphabetical) so all ABC products sit together, all
        // Perth Mint together, etc.; within a dealer order by weight ascending.
        const sorted = [...(d?.products ?? [])].sort((a, b) =>
          a.dealer.localeCompare(b.dealer) || (a.weight_grams ?? 0) - (b.weight_grams ?? 0));
        setMetalProducts(sorted);
      })
      .catch(() => { if (!cancelled) setMetalProducts([]); });
    return () => { cancelled = true; };
  }, [isMetal, form.metal_detailed, form.ticker]);

  // Picking a dealer product fills weight, form, mint and the per-unit BUY price
  // (the scraped buy figure is a whole-product total → divide by the product weight).
  // The sell/value side is handled automatically by the live-spot effect, so we
  // don't touch it here. Cost basis is derived from the buy price × weight.
  const onPickProduct = (id: string) => {
    setMetalProductId(id);
    const p = metalProducts.find(x => x.id === id);
    if (!p) return;
    const grams = p.weight_grams || 0;
    const perUnitBuy = grams > 0 && p.buy_price != null ? p.buy_price / grams : null;
    // Mint dropdown only holds known brands; fall back to "Other" for anything else.
    const mint = METAL_MINTS.includes(p.dealer) ? p.dealer : 'Other';
    setForm(f => ({
      ...f,
      metal_unit: 'grams',
      metal_weight: grams ? String(grams) : f.metal_weight,
      metal_form: p.form ?? f.metal_form,
      metal_mint: mint,
      name: p.product_name,
      metal_buy_price: perUnitBuy != null ? perUnitBuy.toFixed(4) : f.metal_buy_price,
      cost_basis: perUnitBuy != null && grams > 0 ? (perUnitBuy * grams).toFixed(2) : f.cost_basis,
    }));
  };

  // Current market value expressed in the chosen input currency — the basis for
  // deriving cost from P&L (and vice-versa).
  const shares = parseFloat(isMetal ? form.metal_weight : form.shares_owned) || 0;
  const valueNative = shares * (parseFloat(form.current_price) || 0);
  const valueInInput = inputCcy === form.native_currency ? valueNative : parseFloat((valueNative * fxRate).toFixed(2));

  // Cost ↔ P&L are linked: editing one fills the other when a market value exists.
  // For metals, cost ↔ buy-price-per-unit are also linked (the user enters EITHER):
  // editing total cost back-fills the per-unit buy price (cost ÷ weight).
  const onCostChange = (v: string) => setForm(f => ({
    ...f, cost_basis: v,
    profit_loss: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.profit_loss,
    ...(isMetal && shares > 0 ? { metal_buy_price: v !== '' ? (parseFloat(v) / shares).toFixed(4) : '' } : {}),
  }));
  // Entering a per-unit buy price fills the total cost basis (price × weight).
  const onMetalBuyPriceChange = (v: string) => setForm(f => ({
    ...f, metal_buy_price: v,
    cost_basis: v !== '' && shares > 0 ? (parseFloat(v) * shares).toFixed(2) : f.cost_basis,
  }));
  const onPlChange = (v: string) => setForm(f => ({
    ...f, profit_loss: v,
    cost_basis: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.cost_basis,
  }));

  // Switching the input currency re-expresses already-entered amounts.
  const switchCcy = (next: 'native' | 'pref') => {
    if (next === entryCcy || fxRate === 0) return;
    const factor = next === 'pref' ? fxRate : 1 / fxRate;
    setForm(f => ({
      ...f,
      cost_basis:  f.cost_basis  !== '' ? (parseFloat(f.cost_basis)  * factor).toFixed(2) : '',
      profit_loss: f.profit_loss !== '' ? (parseFloat(f.profit_loss) * factor).toFixed(2) : '',
    }));
    setEntryCcy(next);
  };

  const handleTickerSelect = (result: TickerResult, price: number, currency: string) => {
    setMarket(result.market in { ASX:1, NYSE:1, NASDAQ:1, LSE:1, TSX:1, Crypto:1 } ? result.market : market);
    setEntryCcy('native');
    setForm(f => ({
      ...f,
      ticker:          result.symbol,
      name:            result.name,
      asset_type:      result.assetType,
      current_price:   price > 0 ? String(price) : f.current_price,
      native_currency: currency || 'AUD',
    }));
  };

  const resetForm = () => {
    setForm({ ticker: '', name: '', shares_owned: '', cost_basis: '', profit_loss: '', current_price: '', asset_type: 'stock', is_dividend_paying: false, metal_weight: '', metal_unit: 'grams', native_currency: 'AUD', metal_detailed: false, metal_form: 'minted_bar', metal_mint: '', metal_buy_price: '', metal_sell_price: '' });
    setEntryCcy('native');
    setFxRate(1);
    setMetalProductId('');
    setMetalProducts([]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!market) { alert('Please choose a market.'); return; }
    const metalName = form.metal_detailed && form.name
      ? form.name
      : `${form.ticker}${form.metal_weight ? ` ${form.metal_weight}${UNIT_ABBR[form.metal_unit] ?? 'g'}` : ''}${form.metal_detailed && form.metal_form ? ` ${METAL_FORM_LABEL[form.metal_form] ?? ''}` : ''}`.trim();
    onSave({
      // Metals keep the metal name as their "ticker" (e.g. Gold) so the price
      // cron can look it up; do NOT uppercase — METAL_TICKERS keys are TitleCase.
      ticker:            isMetal ? form.ticker : (!isPrivate ? form.ticker.toUpperCase() || undefined : undefined),
      name:              isMetal ? metalName : (form.name || form.ticker || 'Unknown'),
      market,
      asset_type:        isMetal ? 'precious_metal' : isPrivate ? (market === 'Managed Fund' ? 'managed_fund' : 'private') : form.asset_type,
      shares_owned:      parseFloat(isMetal ? form.metal_weight : form.shares_owned) || 0,
      cost_basis:        parseFloat(form.cost_basis) || 0,
      // Metals are bought locally → cost is in the owner's preferred currency,
      // even when the spot price (native_currency) is quoted in USD.
      cost_basis_currency: isMetal ? pref : inputCcy,
      conversion_rate:   fxRate,
      current_price:     parseFloat(form.current_price) || 0,
      native_currency:   form.native_currency,
      is_dividend_paying: form.is_dividend_paying,
      ...(isMetal ? {
        metal_unit:       form.metal_unit,
        metal_detailed:   form.metal_detailed,
        metal_form:       form.metal_detailed ? form.metal_form : 'generic',
        metal_mint:       form.metal_detailed ? (form.metal_mint || null) : null,
        // Link to the chosen scraped dealer product so the holding is valued from
        // that dealer's own buyback price (matches the dealer's site). Null for
        // generic holdings, which value at live spot.
        metal_product_id: form.metal_detailed && metalProductId ? metalProductId : null,
        // The per-unit buy price the user paid (premium over spot) — recorded for
        // both modes as the cost side; valuation always tracks live spot.
        metal_buy_price:  form.metal_buy_price ? parseFloat(form.metal_buy_price) : null,
        metal_sell_price: form.metal_sell_price ? parseFloat(form.metal_sell_price) : null,
      } : {}),
    });
    resetForm();
    setMarket('ASX');
  };

  const ccyToggle = isForeign && (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Amounts entered in</span>
      <div className="inline-flex rounded-[6px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
        {(['native', 'pref'] as const).map(c => {
          const ccy = c === 'native' ? form.native_currency : pref;
          return (
            <button key={c} type="button" onClick={() => switchCcy(c)}
              className={`px-2.5 py-1 transition-colors ${entryCcy === c ? 'bg-[#3b7dd8] text-white' : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:bg-[#f5f5f5] dark:hover:bg-[#252525]'}`}>
              {ccy}
            </button>
          );
        })}
      </div>
    </div>
  );

  const costPlRow = !isMetal && (
    <>
      {ccyToggle}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
        <Input label={`Cost basis (${inputCcy})`} type="number" step="0.01" prefix="$"
          value={form.cost_basis} onChange={e => onCostChange(e.target.value)} />
        <span className="pb-2.5 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">or</span>
        <Input label={`Profit / loss (${inputCcy})`} type="number" step="0.01" prefix="$"
          value={form.profit_loss} onChange={e => onPlChange(e.target.value)} />
      </div>
      <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] -mt-2">
        Fill either one — the other is worked out from the current market value.
        {isForeign && entryCcy === 'pref' && ' Your AUD cost stays fixed regardless of future FX moves.'}
      </p>
    </>
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Investment" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select label="Market" value={market} onChange={e => setMarket(e.target.value)} options={[{ value: '', label: 'Select…' }, ...MARKETS.map(m => ({ value: m, label: m }))]} />

        {isMetal ? (
          <>
            <Select label="Metal" value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))} options={METALS.map(m => ({ value: m, label: m }))} />
            <div className="grid grid-cols-2 gap-3">
              <Input label="Weight" type="number" step="0.001" value={form.metal_weight} onChange={e => setForm(f => ({ ...f, metal_weight: e.target.value }))} placeholder="e.g. 100" required />
              <Select label="Unit" value={form.metal_unit} onChange={e => setForm(f => ({ ...f, metal_unit: e.target.value }))} options={[{ value: 'grams', label: 'Grams' }, { value: 'ounces', label: 'Troy oz' }, { value: 'kg', label: 'Kilograms' }]} />
            </div>

            <Toggle
              label="In-depth (specific product)"
              checked={form.metal_detailed}
              onChange={v => setForm(f => ({ ...f, metal_detailed: v }))}
            />
            <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] -mt-2">
              {form.metal_detailed
                ? 'Record a specific bar/coin with its own buy & sell price (premium over spot). Value tracks your sell price and is not auto-updated.'
                : 'Uses the live spot price, converted to your weight unit & currency, and refreshed hourly.'}
            </p>

            {form.metal_detailed && (
              <>
                {metalProducts.length > 0 && (
                  <>
                    <Select
                      label="Live dealer price (optional)"
                      value={metalProductId}
                      onChange={e => onPickProduct(e.target.value)}
                      options={[
                        { value: '', label: '— Enter manually —' },
                        ...metalProducts.map(p => ({
                          value: p.id,
                          label: `${p.dealer} · ${p.unit_label ?? ''} ${METAL_FORM_LABEL[p.form ?? ''] ?? p.form ?? ''}${p.buy_price != null ? ` — $${p.buy_price.toLocaleString()}` : ''}${p.in_stock ? '' : ' (out of stock)'}`.replace(/\s+/g, ' ').trim(),
                        })),
                      ]}
                    />
                    <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] -mt-2">
                      Picks a real product and fills its weight, form & prices from the dealer. You can still tweak anything below.
                    </p>
                  </>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <Select label="Form" value={form.metal_form} onChange={e => setForm(f => ({ ...f, metal_form: e.target.value }))} options={METAL_FORMS} />
                  <Select label="Mint / brand" value={form.metal_mint} onChange={e => setForm(f => ({ ...f, metal_mint: e.target.value }))} options={METAL_MINTS.map(m => ({ value: m, label: m }))} />
                </div>
                <Input label="Product name (optional)" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Perth Mint 5g Minted Bar" />
              </>
            )}
          </>
        ) : isPrivate ? (
          <Input label="Investment name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Startup investment" required />
        ) : (
          <TickerAutocomplete
            value={form.ticker}
            onChange={v => setForm(f => ({ ...f, ticker: v }))}
            onSelect={handleTickerSelect}
            market={market}
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

        {!isMetal && (
          <Input label={market === 'Crypto' ? 'Units owned' : 'Shares / units'} type="number" step="0.00000001" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
        )}

        {!(isMetal && form.metal_detailed) && (
          <Input
            label={isMetal ? `Spot price per ${UNIT_ABBR[form.metal_unit] ?? 'unit'} (${form.native_currency})` : `Current price per unit (${form.native_currency})`}
            type="number" step="0.00000001" prefix="$"
            value={form.current_price}
            onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))}
            hint={
              isMetal
                ? (form.current_price ? `Live spot for ${form.ticker} — in ${form.native_currency}, per ${UNIT_ABBR[form.metal_unit] ?? 'unit'}` : 'Auto-filled from the live spot price')
                : (form.current_price ? `Auto-filled from Yahoo Finance — in ${form.native_currency}` : 'Leave blank — search for a ticker to auto-fill')
            }
          />
        )}

        {isMetal && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input label={`Buy price per ${UNIT_ABBR[form.metal_unit] ?? 'unit'} (${pref})`} type="number" step="0.01" prefix="$"
                value={form.metal_buy_price} onChange={e => onMetalBuyPriceChange(e.target.value)} hint="Per-unit price you paid" />
              <Input label={`Total cost basis (${pref})`} type="number" step="0.01" prefix="$"
                value={form.cost_basis} onChange={e => onCostChange(e.target.value)} hint="Total amount you paid" />
            </div>
            <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] -mt-2">
              Enter either one — the other fills automatically from your weight. Value tracks the live spot price.
            </p>
          </>
        )}

        {costPlRow}

        {!isMetal && !isPrivate && (
          <Select label="Asset type" value={form.asset_type} onChange={e => setForm(f => ({ ...f, asset_type: e.target.value }))}
            options={[{ value: 'stock', label: 'Stock' }, { value: 'etf', label: 'ETF' }, { value: 'managed_fund', label: 'Managed Fund' }, { value: 'other', label: 'Other' }]}
          />
        )}

        {!isMetal && (
          <Toggle label="Dividend / distribution paying" checked={form.is_dividend_paying} onChange={v => setForm(f => ({ ...f, is_dividend_paying: v }))} />
        )}

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
  const pref = useStore(s => s.user?.currency_preference) ?? 'AUD';
  const nativeCcy = inv.native_currency || 'AUD';
  const isForeign = nativeCcy !== pref;
  const storedCostCcy = inv.cost_basis_currency || nativeCcy;

  const [form, setForm] = useState({
    shares_owned:  String(inv.shares_owned),
    cost_basis:    String(inv.cost_basis),
    profit_loss:   '',
    current_price: String(inv.current_price),
    name:          inv.name,
  });
  const [entryCcy, setEntryCcy] = useState<'native' | 'pref'>(storedCostCcy === pref ? 'pref' : 'native');
  const [fxRate, setFxRate] = useState(inv.conversion_rate ?? 1);

  useEffect(() => {
    if (!isForeign) { setFxRate(1); return; }
    let cancelled = false;
    fetch(`${API_BASE}/api/investments/fxrate?from=${encodeURIComponent(nativeCcy)}&to=${encodeURIComponent(pref)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((d: { rate?: number } | null) => { if (!cancelled && d?.rate) setFxRate(d.rate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isForeign, nativeCcy, pref]);

  const inputCcy = isForeign && entryCcy === 'pref' ? pref : nativeCcy;
  const valueNative = (parseFloat(form.shares_owned) || 0) * (parseFloat(form.current_price) || 0);
  const valueInInput = inputCcy === nativeCcy ? valueNative : parseFloat((valueNative * fxRate).toFixed(2));

  const onCostChange = (v: string) => setForm(f => ({
    ...f, cost_basis: v,
    profit_loss: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.profit_loss,
  }));
  const onPlChange = (v: string) => setForm(f => ({
    ...f, profit_loss: v,
    cost_basis: v !== '' && valueInInput > 0 ? (valueInInput - (parseFloat(v) || 0)).toFixed(2) : f.cost_basis,
  }));
  const switchCcy = (next: 'native' | 'pref') => {
    if (next === entryCcy || fxRate === 0) return;
    const factor = next === 'pref' ? fxRate : 1 / fxRate;
    setForm(f => ({
      ...f,
      cost_basis:  f.cost_basis  !== '' ? (parseFloat(f.cost_basis)  * factor).toFixed(2) : '',
      profit_loss: f.profit_loss !== '' ? (parseFloat(f.profit_loss) * factor).toFixed(2) : '',
    }));
    setEntryCcy(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(inv.id, {
      shares_owned:  parseFloat(form.shares_owned),
      cost_basis:    parseFloat(form.cost_basis) || 0,
      cost_basis_currency: inputCcy,
      conversion_rate: fxRate,
      current_price: parseFloat(form.current_price),
      name:          form.name,
    });
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={`Edit — ${inv.ticker ?? inv.name}`} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <Input label="Shares / units owned" type="number" step="0.00000001" value={form.shares_owned} onChange={e => setForm(f => ({ ...f, shares_owned: e.target.value }))} required />
        <Input label={`Current price per unit (${nativeCcy})`} type="number" step="0.00000001" prefix="$" value={form.current_price} onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))} />
        {isForeign && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[#6b6b6b] dark:text-[#a0a0a0]">Amounts entered in</span>
            <div className="inline-flex rounded-[6px] border border-[#e5e5e5] dark:border-[#2a2a2a] overflow-hidden">
              {(['native', 'pref'] as const).map(c => {
                const ccy = c === 'native' ? nativeCcy : pref;
                return (
                  <button key={c} type="button" onClick={() => switchCcy(c)}
                    className={`px-2.5 py-1 transition-colors ${entryCcy === c ? 'bg-[#3b7dd8] text-white' : 'text-[#6b6b6b] dark:text-[#a0a0a0] hover:bg-[#f5f5f5] dark:hover:bg-[#252525]'}`}>
                    {ccy}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
          <Input label={`Cost basis (${inputCcy})`} type="number" step="0.01" prefix="$" value={form.cost_basis} onChange={e => onCostChange(e.target.value)} />
          <span className="pb-2.5 text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">or</span>
          <Input label={`Profit / loss (${inputCcy})`} type="number" step="0.01" prefix="$" value={form.profit_loss} onChange={e => onPlChange(e.target.value)} />
        </div>
        <p className="text-[11px] text-[#6b6b6b] dark:text-[#a0a0a0] -mt-2">Fill either one — the other is worked out from the current market value.</p>
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
  const EMPTY = { fund_name: '', member_number: '', balance: '', employer_contributions: '0', personal_contributions: '0', investment_option: '', insurance_details: '', fees: '0', include_in_net_worth: true };
  const [form, setForm] = useState(EMPTY);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState('');

  // Map a parsed value to a string, preserving the existing form value when the
  // field is absent/null. Numeric helper coerces null → '' so we don't render "null".
  const str = (v: unknown, fallback: string) =>
    v === undefined || v === null ? fallback : String(v);

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
        fund_name:              str(p.fund_name, f.fund_name),
        member_number:          str(p.member_number, f.member_number),
        balance:                str(p.balance, f.balance),
        employer_contributions: str(p.employer_contributions, f.employer_contributions),
        personal_contributions: str(p.personal_contributions, f.personal_contributions),
        investment_option:      str(p.investment_option, f.investment_option),
        insurance_details:      str(p.insurance_details, f.insurance_details),
        fees:                   str(p.fees, f.fees),
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
      fees:                   parseFloat(form.fees) || 0,
      include_in_investments: false,
      include_in_net_worth:   form.include_in_net_worth,
    });
    setForm(EMPTY);
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
        <div className="grid grid-cols-2 gap-3">
          <Input label="Fund name" value={form.fund_name} onChange={e => setForm(f => ({ ...f, fund_name: e.target.value }))} placeholder="e.g. AustralianSuper" required />
          <Input label="Member number" value={form.member_number} onChange={e => setForm(f => ({ ...f, member_number: e.target.value }))} placeholder="e.g. 1234567" />
        </div>
        <Input label="Current balance" type="number" step="0.01" prefix="$" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} required />
        <div>
          <p className="text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0] mb-2">Contributions this financial year</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Employer" type="number" step="0.01" prefix="$" value={form.employer_contributions} onChange={e => setForm(f => ({ ...f, employer_contributions: e.target.value }))} />
            <Input label="Personal" type="number" step="0.01" prefix="$" value={form.personal_contributions} onChange={e => setForm(f => ({ ...f, personal_contributions: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input label="Investment option (optional)" value={form.investment_option} onChange={e => setForm(f => ({ ...f, investment_option: e.target.value }))} placeholder="e.g. High Growth" />
          <Input label="Fees this year (optional)" type="number" step="0.01" prefix="$" value={form.fees} onChange={e => setForm(f => ({ ...f, fees: e.target.value }))} />
        </div>
        <Input label="Insurance details (optional)" value={form.insurance_details} onChange={e => setForm(f => ({ ...f, insurance_details: e.target.value }))} placeholder="e.g. Death $250k; TPD $250k" />
        <div className="flex items-center justify-between pt-1">
          <span className="text-sm text-[#0f0f0f] dark:text-[#f5f5f5]">Count toward net worth</span>
          <Toggle checked={form.include_in_net_worth} onChange={v => setForm(f => ({ ...f, include_in_net_worth: v }))} />
        </div>
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Super Fund</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Pending Employer Super Ledger + Reconciliation ──────────────────────────
interface ExpectedSuper {
  id: string;
  employer: string;
  amount: number;
  pay_period_start: string | null;
  pay_period_end: string | null;
  expected_payment_date: string | null;
  quarter: string | null;
  financial_year: string | null;
  status: string;
}
interface ReconResult {
  financial_year: string;
  expected: number;
  received: number;
  difference: number;
  within_tolerance: boolean;
  tolerance: number;
  matched_count: number;
  flag: 'ok' | 'minor' | 'shortfall';
}

function PendingSuperLedger({ currency }: { currency: string }) {
  const [pending, setPending] = useState<ExpectedSuper[]>([]);
  const [fy, setFy] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [reconOpen, setReconOpen] = useState(false);
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReconResult | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await payrollApi.getAll();
      setFy(data.financial_year);
      setPending((data.expected_super ?? []).filter((e: ExpectedSuper) => e.status === 'pending'));
    } catch { /* ignore */ }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  if (loading) return null;
  if (pending.length === 0 && !result) return null;

  // Group by quarter
  const groups: Record<string, ExpectedSuper[]> = {};
  for (const e of pending) {
    const k = e.quarter ?? 'Unscheduled';
    (groups[k] ??= []).push(e);
  }
  const totalExpected = pending.reduce((s, e) => s + Number(e.amount), 0);

  const runReconcile = async () => {
    setBusy(true);
    try {
      const r = await payrollApi.reconcileSuper({
        employer_contributions: parseFloat(received) || 0,
        financial_year: fy,
      });
      setResult(r);
      setReconOpen(false);
      setReceived('');
      await load();
    } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <div className="mt-6">
      <div className="flex justify-between items-center mb-3">
        <div>
          <h3 className="font-semibold">Expected employer super</h3>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
            Tally of super your employer should have paid (from payslips) · FY {fy}
          </p>
        </div>
        {pending.length > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setReconOpen(true)}>Reconcile statement</Button>
        )}
      </div>

      {result && (
        <Card className={`mb-3 border ${
          result.flag === 'shortfall' ? 'border-[#ef4444]/40 bg-[#ef4444]/5'
          : result.flag === 'minor' ? 'border-[#f59e0b]/40 bg-[#f59e0b]/5'
          : 'border-[#22c55e]/40 bg-[#22c55e]/5'}`}>
          <p className="text-sm font-medium mb-1">
            {result.flag === 'shortfall' ? '⚠️ Possible employer underpayment'
              : result.flag === 'minor' ? 'Small difference detected'
              : '✓ Contributions reconciled'}
          </p>
          <p className="text-sm">
            Expected {formatCurrency(result.expected, currency)} · received {formatCurrency(result.received, currency)} · difference{' '}
            <span className={result.difference < 0 ? 'text-[#ef4444]' : ''}>{formatCurrency(result.difference, currency)}</span>
          </p>
          <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">
            {result.within_tolerance
              ? `Within $${result.tolerance} tolerance — likely fees, review if concerned.`
              : result.flag === 'shortfall'
                ? `Received materially less than expected — investigate whether your employer is paying your super correctly.`
                : `Received more than expected.`}
            {' '}{result.matched_count} pending entr{result.matched_count === 1 ? 'y' : 'ies'} cleared.
          </p>
        </Card>
      )}

      {pending.length > 0 && (
        <Card>
          <div className="flex justify-between items-center mb-3">
            <p className="text-xs font-medium text-[#6b6b6b] dark:text-[#a0a0a0]">Pending (not yet confirmed in fund)</p>
            <p className="text-sm font-semibold amount">{formatCurrency(totalExpected, currency)}</p>
          </div>
          <div className="space-y-4">
            {Object.entries(groups).map(([quarter, rows]) => {
              const qTotal = rows.reduce((s, e) => s + Number(e.amount), 0);
              return (
                <div key={quarter}>
                  <div className="flex justify-between items-center mb-1">
                    <p className="text-xs font-medium">{quarter}</p>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      Due {rows[0].expected_payment_date ?? '—'} · {formatCurrency(qTotal, currency)}
                    </p>
                  </div>
                  <div className="space-y-1">
                    {rows.map(e => (
                      <div key={e.id} className="flex items-center justify-between text-sm py-1 border-b border-[#e5e5e5] dark:border-[#2a2a2a] last:border-0">
                        <div>
                          <span className="font-medium">{e.employer}</span>
                          {(e.pay_period_start || e.pay_period_end) && (
                            <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] ml-2">
                              {e.pay_period_start ?? '?'} → {e.pay_period_end ?? '?'}
                            </span>
                          )}
                        </div>
                        <span className="amount">{formatCurrency(Number(e.amount), currency)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Modal isOpen={reconOpen} onClose={() => setReconOpen(false)} title="Reconcile super statement">
        <div className="space-y-4">
          <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">
            Enter the total employer contributions your super fund received this financial year. We'll compare it
            against the {formatCurrency(totalExpected, currency)} expected from your payslips.
          </p>
          <Input
            label="Employer contributions received"
            type="number" step="0.01" prefix="$"
            value={received}
            onChange={e => setReceived(e.target.value)}
            placeholder="0.00"
          />
          <Button variant="primary" fullWidth disabled={busy} onClick={runReconcile}>
            {busy ? 'Reconciling…' : 'Reconcile'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
