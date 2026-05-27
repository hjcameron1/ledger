import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import {
  calculateNetWorth, billsDS, goalsDS,
} from '../services/dataService';
import { formatCurrency, formatRelativeDate, daysUntil } from '../utils/format';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Tooltip, Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

export default function Overview() {
  const {
    user, setNetWorth, netWorth, netWorthHistory,
    bills, setBills, goals, setGoals,
    widgetVisibility, setWidgetVisibility,
    accounts, creditCards, investments, superFunds,
  } = useStore();

  const [searchParams] = useSearchParams();
  const [customiseOpen, setCustomiseOpen] = useState(false);
  const [billsExpanded, setBillsExpanded] = useState(false);
  const [addBillOpen, setAddBillOpen] = useState(false);
  const [addGoalOpen, setAddGoalOpen] = useState(false);

  const currency = user?.currency_preference ?? 'AUD';

  // Recalculate net worth from local data every time relevant data changes
  useEffect(() => {
    const nw = calculateNetWorth();
    setNetWorth(nw);
  }, [accounts, creditCards, investments, superFunds, setNetWorth]);

  useEffect(() => {
    if (searchParams.get('add') === 'bill') setAddBillOpen(true);
    if (searchParams.get('add') === 'goal') setAddGoalOpen(true);
  }, [searchParams]);

  const upcomingBills = [...bills]
    .filter(b => !b.is_paid)
    .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  const urgentBills = upcomingBills.filter(b => daysUntil(b.due_date) <= 7);

  const billColour: Record<string, string> = {
    grey:   'bg-[#f5f5f5] dark:bg-[#2a2a2a]',
    yellow: 'bg-[#f59e0b]/10 border border-[#f59e0b]/30',
    red:    'bg-[#ef4444]/10 border border-[#ef4444]/20',
  };

  const handlePayBill = (id: string) => {
    billsDS.pay(id);
    setBills(billsDS.getAll());
  };

  return (
    <Layout onCustomise={() => setCustomiseOpen(true)}>
      {/* Net Worth Hero */}
      <div className="mb-6">
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0]">Total net worth</p>
        <h1 className="text-4xl sm:text-5xl font-semibold amount tracking-tight mt-1">
          {formatCurrency(netWorth?.net_worth ?? 0, currency)}
        </h1>
        <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{currency} · Updated just now</p>

        {netWorthHistory.length > 1 && (
          <div className="mt-4 h-24">
            <Line
              data={{
                labels: netWorthHistory.map(h => h.recorded_date),
                datasets: [{
                  data: netWorthHistory.map(h => h.total_value),
                  borderColor: '#3b7dd8',
                  backgroundColor: 'rgba(59,125,216,0.08)',
                  borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0,
                }],
              }}
              options={{
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false } },
              }}
            />
          </div>
        )}
      </div>

      {/* Summary Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Bank accounts',  value: netWorth?.bank_balance ?? 0,    isDebt: false },
          { label: 'Investments',    value: netWorth?.investments ?? 0,      isDebt: false },
          { label: 'Credit cards',   value: netWorth?.credit_card_debt ?? 0, isDebt: true  },
          { label: 'Superannuation', value: netWorth?.super ?? 0,            isDebt: false },
        ].map(item => (
          <Card key={item.label} padding="sm">
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{item.label}</p>
            <p className={`text-base font-semibold amount mt-1 ${item.isDebt && item.value > 0 ? 'text-[#ef4444]' : ''}`}>
              {formatCurrency(item.value, currency, true)}
            </p>
          </Card>
        ))}
      </div>

      {/* Bills Widget */}
      {widgetVisibility.bills && (
        <Card className="mb-4" padding="none">
          <div className="px-5 py-4 flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
            <div>
              <h2 className="font-semibold">Bills &amp; Reminders</h2>
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{urgentBills.length} due this week</p>
            </div>
            <button onClick={() => setBillsExpanded(true)} className="text-xs text-[#3b7dd8] hover:underline flex items-center gap-1">
              View all <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
          <div className="p-4 space-y-2">
            {upcomingBills.length === 0 ? (
              <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] py-2 text-center">No upcoming bills</p>
            ) : (
              upcomingBills.slice(0, 4).map(bill => {
                const days = daysUntil(bill.due_date);
                return (
                  <div key={bill.id} className={`flex items-center justify-between px-3 py-2.5 rounded-[8px] ${billColour[bill.colour]}`}>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handlePayBill(bill.id)}
                        className="w-5 h-5 rounded-full border-2 border-[#6b6b6b] dark:border-[#a0a0a0] flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/10 transition-colors"
                        title="Mark as paid"
                      />
                      <div>
                        <p className="text-sm font-medium">{bill.name}</p>
                        <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                          {days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days} days`}
                          {bill.is_recurring && ' · Recurring'}
                        </p>
                      </div>
                    </div>
                    <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
                  </div>
                );
              })
            )}
            {upcomingBills.length > 4 && (
              <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] text-center">+{upcomingBills.length - 4} more</p>
            )}
          </div>
          <div className="px-5 pb-4">
            <button onClick={() => setAddBillOpen(true)} className="text-sm text-[#3b7dd8] hover:underline">+ Add bill</button>
          </div>
        </Card>
      )}

      {/* Goals Widget */}
      {widgetVisibility.goals && goals.length > 0 && (
        <Card className="mb-4" padding="none">
          <div className="px-5 py-4 flex items-center justify-between border-b border-[#e5e5e5] dark:border-[#2a2a2a]">
            <h2 className="font-semibold">Goals</h2>
            <button onClick={() => setAddGoalOpen(true)} className="text-xs text-[#3b7dd8] hover:underline">+ Add goal</button>
          </div>
          <div className="p-4 space-y-4">
            {goals.slice(0, 3).map(goal => {
              const pct = goal.target_amount > 0
                ? Math.min(100, Math.round((goal.current_amount / goal.target_amount) * 100))
                : 0;
              return (
                <div key={goal.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-medium">{goal.name}</span>
                    <span className="text-sm amount">{formatCurrency(goal.current_amount, currency)} / {formatCurrency(goal.target_amount, currency)}</span>
                  </div>
                  <div className="h-2 bg-[#e5e5e5] dark:bg-[#2a2a2a] rounded-full overflow-hidden">
                    <div className="h-full bg-[#3b7dd8] rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{pct}% complete</span>
                    {goal.target_date && <span className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">{formatRelativeDate(goal.target_date)}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Widget Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {widgetVisibility.bankAccounts && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Bank Accounts</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.bank_balance ?? 0, currency, true)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.investments && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Investments</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.investments ?? 0, currency, true)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{investments.length} holding{investments.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.creditCards && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Credit Card Debt</p>
            <p className={`text-xl font-semibold amount ${(netWorth?.credit_card_debt ?? 0) > 0 ? 'text-[#ef4444]' : ''}`}>
              {formatCurrency(netWorth?.credit_card_debt ?? 0, currency, true)}
            </p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{creditCards.length} card{creditCards.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
        {widgetVisibility.super && (
          <Card>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mb-1">Superannuation</p>
            <p className="text-xl font-semibold amount">{formatCurrency(netWorth?.super ?? 0, currency, true)}</p>
            <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0] mt-1">{superFunds.length} fund{superFunds.length !== 1 ? 's' : ''}</p>
          </Card>
        )}
      </div>

      {/* Add Goal prompt when none yet */}
      {widgetVisibility.goals && goals.length === 0 && (
        <div className="mt-4">
          <button
            onClick={() => setAddGoalOpen(true)}
            className="w-full py-3 border border-dashed border-[#e5e5e5] dark:border-[#2a2a2a] rounded-[12px] text-sm text-[#6b6b6b] dark:text-[#a0a0a0] hover:border-[#3b7dd8]/40 hover:text-[#3b7dd8] transition-all"
          >
            + Add your first goal
          </button>
        </div>
      )}

      {/* Customise Modal */}
      <Modal isOpen={customiseOpen} onClose={() => setCustomiseOpen(false)} title="Customise Dashboard" size="sm">
        <div className="space-y-3">
          {Object.entries(widgetVisibility).map(([key, visible]) => {
            const labels: Record<string, string> = {
              bankAccounts: 'Bank Accounts', investments: 'Investments',
              creditCards: 'Credit Cards', super: 'Superannuation',
              income: 'Income Summary', netWorthTrend: 'Net Worth Trend',
              goals: 'Goals', budgeting: 'Budgeting', bills: 'Bills',
            };
            return (
              <div key={key} className="flex items-center justify-between py-1">
                <span className="text-sm">{labels[key] ?? key}</span>
                <Toggle checked={visible} onChange={v => setWidgetVisibility(key, v)} />
              </div>
            );
          })}
        </div>
      </Modal>

      {/* Bills Expanded */}
      <Modal isOpen={billsExpanded} onClose={() => setBillsExpanded(false)} title="All Bills & Reminders" size="lg">
        <div className="space-y-2">
          {upcomingBills.map(bill => {
            const days = daysUntil(bill.due_date);
            return (
              <div key={bill.id} className={`flex items-center justify-between p-3 rounded-[8px] border ${bill.colour === 'red' ? 'border-[#ef4444]/30 bg-[#ef4444]/5' : bill.colour === 'yellow' ? 'border-[#f59e0b]/30 bg-[#f59e0b]/5' : 'border-[#e5e5e5] dark:border-[#2a2a2a]'}`}>
                <div className="flex items-center gap-3">
                  <button onClick={() => { handlePayBill(bill.id); if (upcomingBills.length <= 1) setBillsExpanded(false); }} className="w-5 h-5 rounded-full border-2 border-[#6b6b6b] flex-shrink-0 hover:border-[#22c55e] hover:bg-[#22c55e]/10 transition-colors" />
                  <div>
                    <p className="text-sm font-medium">{bill.name}</p>
                    <p className="text-xs text-[#6b6b6b] dark:text-[#a0a0a0]">
                      {days === 0 ? 'Due today' : days < 0 ? `Overdue by ${Math.abs(days)} days` : `Due in ${days} days`}
                      {bill.is_recurring && ` · ${bill.frequency}`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold amount">{formatCurrency(bill.amount, currency)}</span>
                  <button onClick={() => { billsDS.remove(bill.id); setBills(billsDS.getAll()); }} className="text-xs text-[#6b6b6b] hover:text-[#ef4444]">✕</button>
                </div>
              </div>
            );
          })}
          {upcomingBills.length === 0 && <p className="text-sm text-[#6b6b6b] dark:text-[#a0a0a0] text-center py-8">No upcoming bills</p>}
        </div>
        <div className="mt-4">
          <Button variant="secondary" onClick={() => { setBillsExpanded(false); setAddBillOpen(true); }} fullWidth>+ Add Bill</Button>
        </div>
      </Modal>

      {/* Add Bill */}
      <AddBillModal
        isOpen={addBillOpen}
        onClose={() => setAddBillOpen(false)}
        onSave={(data) => {
          billsDS.add(data as Parameters<typeof billsDS.add>[0]);
          setBills(billsDS.getAll());
          setAddBillOpen(false);
        }}
      />

      {/* Add Goal */}
      <AddGoalModal
        isOpen={addGoalOpen}
        onClose={() => setAddGoalOpen(false)}
        onSave={(data) => {
          goalsDS.add(data as Parameters<typeof goalsDS.add>[0]);
          setGoals(goalsDS.getAll());
          setAddGoalOpen(false);
        }}
      />
    </Layout>
  );
}

// ─── Add Bill Modal ──────────────────────────────────────────────────────────

function AddBillModal({ isOpen, onClose, onSave }: {
  isOpen: boolean; onClose: () => void; onSave: (d: object) => void;
}) {
  const [form, setForm] = useState({
    name: '', amount: '', due_date: '', is_recurring: false,
    frequency: 'monthly', colour: 'grey' as 'grey' | 'yellow' | 'red',
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.amount || !form.due_date) return;
    onSave({ ...form, amount: parseFloat(form.amount), is_paid: false, calendar_synced: false });
    setForm({ name: '', amount: '', due_date: '', is_recurring: false, frequency: 'monthly', colour: 'grey' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Bill" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Bill name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Electricity" required />
        <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <Input label="Due date" type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} required />
        <Toggle label="Recurring bill" checked={form.is_recurring} onChange={v => setForm(f => ({ ...f, is_recurring: v }))} />
        {form.is_recurring && (
          <Select label="Frequency" value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value }))}
            options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'monthly', label: 'Monthly' }, { value: 'quarterly', label: 'Quarterly' }, { value: 'annually', label: 'Annually' }]}
          />
        )}
        <Select label="Colour" value={form.colour} onChange={e => setForm(f => ({ ...f, colour: e.target.value as 'grey' | 'yellow' | 'red' }))}
          options={[{ value: 'grey', label: 'Grey (default)' }, { value: 'yellow', label: 'Yellow (moderate)' }, { value: 'red', label: 'Red (urgent)' }]}
        />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Bill</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Add Goal Modal ──────────────────────────────────────────────────────────

function AddGoalModal({ isOpen, onClose, onSave }: {
  isOpen: boolean; onClose: () => void; onSave: (d: object) => void;
}) {
  const [form, setForm] = useState({ name: '', target_amount: '', current_amount: '0', target_date: '' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.target_amount) return;
    onSave({ ...form, target_amount: parseFloat(form.target_amount), current_amount: parseFloat(form.current_amount || '0') });
    setForm({ name: '', target_amount: '', current_amount: '0', target_date: '' });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Goal" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Goal name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. House Deposit" required />
        <Input label="Target amount" type="number" step="0.01" prefix="$" value={form.target_amount} onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} required />
        <Input label="Current amount" type="number" step="0.01" prefix="$" value={form.current_amount} onChange={e => setForm(f => ({ ...f, current_amount: e.target.value }))} />
        <Input label="Target date (optional)" type="date" value={form.target_date} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} />
        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>Add Goal</Button>
        </div>
      </form>
    </Modal>
  );
}
