import { useState } from 'react';
import Card from '../common/Card';
import Input, { Select } from '../common/Input';
import Button from '../common/Button';
import { formatCurrency, formatDate } from '../../utils/format';
import { formatFY } from '../../utils/taxYear';
import type {
  CapitalGainsPosition,
  CgtEvent,
  CgtParcel,
  GainBucket,
  OpeningCapitalLosses,
} from '../../utils/capitalGains';

/**
 * Phase 5.4 — the capital-gains working.
 *
 * The ATO's eight steps, in the ATO's order, with the number that leaves at the
 * bottom being the one already sitting in the income card above as "Net capital
 * gain". The card computes NOTHING: every figure comes off the CapitalGainsPosition
 * the FY position was built from, so the two can never disagree.
 *
 * Drill-down goes all the way down. A disposal opens onto the allocations that
 * make it up — one per parcel the units came out of — and each allocation says
 * where its cost base and its acquisition date came from, which is the only way
 * to see WHY half a sale was discounted and half was not.
 */

const BUCKET_LABEL: Record<GainBucket, string> = {
  'other': 'Gains with no discount',
  'collectable-other': 'Collectable gains with no discount',
  'discount': 'Gains eligible for the 50% discount',
  'collectable-discount': 'Collectable gains eligible for the discount',
};

/** The holdings a parcel can be attached to — enough to identify one, no more. */
export interface ParcelHolding {
  id: string;
  name: string;
  ticker?: string | null;
  asset_type?: string | null;
}

export default function CapitalGains({
  fy, position, parcels, currency, opening, holdings, onSuggestParcel,
  onAddParcel, onUpdateParcel, onRemoveParcel, onSetOpening, onRemoveDisposal,
}: {
  fy: string;
  position: CapitalGainsPosition | null;
  parcels: CgtParcel[];
  currency: string;
  opening: OpeningCapitalLosses | null;
  /** Holdings the parcel can belong to. Attaching one is what lets a sale find it. */
  holdings: ParcelHolding[];
  /** The holding's own units and cost, offered as a starting parcel. */
  onSuggestParcel: (investmentId: string) => Omit<CgtParcel, 'id'> | null;
  onAddParcel: (p: Omit<CgtParcel, 'id'>) => void;
  onUpdateParcel: (id: string, p: Partial<Omit<CgtParcel, 'id'>>) => void;
  onRemoveParcel: (id: string) => void;
  onSetOpening: (o: OpeningCapitalLosses | null) => void;
  onRemoveDisposal: (id: string) => void;
}) {
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [editing, setEditing] = useState<'none' | 'parcels' | 'opening'>('none');
  const money = (n: number) => formatCurrency(n, currency);

  const hasActivity = !!position && (position.events.length > 0 || position.broughtForward.ordinary > 0
    || position.broughtForward.collectable > 0);

  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium">Capital gains</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {!position || !hasActivity
              ? `No disposals recorded for FY ${formatFY(fy)}. Sell a holding on the Investments page and the gain lands here.`
              : position.netCapitalGain > 0
                ? `${position.events.length} disposal${position.events.length === 1 ? '' : 's'} · a net capital gain is part of this year's income`
                : `${position.events.length} disposal${position.events.length === 1 ? '' : 's'} · no net capital gain this year`}
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          <button
            onClick={() => setEditing(e => (e === 'parcels' ? 'none' : 'parcels'))}
            className="text-xs text-brand hover:underline"
          >
            {editing === 'parcels' ? 'Done' : `Parcels${parcels.length ? ` (${parcels.length})` : ''}`}
          </button>
          <button
            onClick={() => setEditing(e => (e === 'opening' ? 'none' : 'opening'))}
            className="text-xs text-brand hover:underline"
          >
            {editing === 'opening' ? 'Done' : 'Earlier losses'}
          </button>
        </div>
      </div>

      {position && hasActivity && (
        <>
          {/* Steps 1–4 — what each disposal produced, before anything is applied. */}
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <Figure label="Capital proceeds" value={money(position.proceeds)} />
            <Figure label="Cost base" value={`−${money(position.costBase)}`} />
            <Figure label="Gross capital gains" value={money(position.grossGainsTotal)} tone="good" />
            <Figure
              label="Capital losses"
              value={money(position.currentYearLosses.ordinary + position.currentYearLosses.collectable)}
              tone="bad"
            />
          </div>

          {/* Step 5 — losses, in the order that costs the least tax. */}
          <div className="mt-5 pt-4 border-t border-zinc-100 dark:border-zinc-800 space-y-1.5">
            {(Object.keys(BUCKET_LABEL) as GainBucket[])
              .filter(b => position.grossGains[b] > 0)
              .map(b => (
                <Row key={b} label={BUCKET_LABEL[b]} value={money(position.grossGains[b])} />
              ))}

            {position.lossApplications.map(l => (
              <Row
                key={l.key}
                label={
                  (l.source === 'brought-forward' ? 'Loss carried in from earlier years' : "This year's capital losses") +
                  (l.pool === 'collectable' ? ' (collectables)' : '') +
                  ` against ${BUCKET_LABEL[l.against].toLowerCase()}`
                }
                value={`−${money(l.amount)}`}
                tone="good"
                indent
              />
            ))}

            {position.discount > 0 && (
              <Row
                label="Less the 50% CGT discount"
                detail="Only on gains from assets owned for twelve months and a day, after losses"
                value={`−${money(position.discount)}`}
                tone="good"
              />
            )}

            <div className="flex items-start justify-between gap-3 pt-2 mt-1 border-t border-zinc-200 dark:border-zinc-800">
              <div className="min-w-0">
                <p className="text-sm font-medium">Net capital gain</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Assessable income for FY {formatFY(fy)} — already counted in the income above.
                </p>
              </div>
              <span className="text-sm font-semibold amount shrink-0">{money(position.netCapitalGain)}</span>
            </div>

            {position.carriedForwardTotal > 0 && (
              <div className="flex items-start justify-between gap-3 pt-1">
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Net capital loss carried forward
                  {position.carriedForward.collectable > 0 && (
                    <> · {money(position.carriedForward.collectable)} of it quarantined to collectables</>
                  )}
                </p>
                <span className="text-xs amount shrink-0 text-[#ef4444]">{money(position.carriedForwardTotal)}</span>
              </div>
            )}
          </div>

          {/* Every disposal, opening onto the parcels behind it. */}
          {position.events.length > 0 && (
            <div className="mt-5 pt-4 border-t border-zinc-100 dark:border-zinc-800 space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">
                Disposals
              </p>
              {position.events.map(e => (
                <EventRow
                  key={e.disposalId}
                  event={e}
                  open={openEvent === e.disposalId}
                  onToggle={() => setOpenEvent(openEvent === e.disposalId ? null : e.disposalId)}
                  onRemove={() => onRemoveDisposal(e.disposalId)}
                  currency={currency}
                />
              ))}
            </div>
          )}

          {/* Anything that would change the number if the user filled it in. */}
          {position.warnings.length > 0 && (
            <div className="mt-4 space-y-2">
              {position.warnings.map((w, i) => (
                <div
                  key={i}
                  className={`rounded-[10px] px-3 py-2 border ${
                    w.severity === 'warn'
                      ? 'border-[#f59e0b]/30 bg-[#f59e0b]/10'
                      : 'border-zinc-200 dark:border-zinc-800'
                  }`}
                >
                  <p className={`text-xs ${w.severity === 'warn' ? 'text-[#b45309] dark:text-[#fbbf24]' : 'text-zinc-500 dark:text-zinc-400'}`}>
                    {w.message}
                    {w.amount != null && <span className="font-medium"> {money(w.amount)}</span>}
                  </p>
                </div>
              ))}
            </div>
          )}

          {position.notes.length > 0 && (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-3">{position.notes.join(' ')}</p>
          )}
        </>
      )}

      {editing === 'parcels' && (
        <ParcelEditor
          parcels={parcels}
          currency={currency}
          holdings={holdings}
          onSuggest={onSuggestParcel}
          onAdd={onAddParcel}
          onUpdate={onUpdateParcel}
          onRemove={onRemoveParcel}
        />
      )}

      {editing === 'opening' && (
        <OpeningEditor fy={fy} opening={opening} currency={currency} onSave={onSetOpening} />
      )}
    </Card>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const colour = tone === 'good' ? 'text-[#22c55e]' : tone === 'bad' ? 'text-[#ef4444]' : '';
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`font-semibold amount mt-1 text-lg ${colour}`}>{value}</p>
    </div>
  );
}

function Row({ label, detail, value, tone, indent }: {
  label: string; detail?: string; value: string; tone?: 'good' | 'bad'; indent?: boolean;
}) {
  const colour = tone === 'good' ? 'text-[#22c55e]' : tone === 'bad' ? 'text-[#ef4444]' : '';
  return (
    <div className={`flex items-start justify-between gap-3 ${indent ? 'pl-3' : ''}`}>
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {detail && <p className="text-xs text-zinc-500 dark:text-zinc-400">{detail}</p>}
      </div>
      <span className={`text-sm amount shrink-0 ${colour}`}>{value}</span>
    </div>
  );
}

function EventRow({ event, open, onToggle, onRemove, currency }: {
  event: CgtEvent;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  currency: string;
}) {
  const money = (n: number) => formatCurrency(n, currency);
  return (
    <div className="border-b border-zinc-100 dark:border-zinc-800 last:border-0 py-1.5">
      <button onClick={onToggle} className="w-full flex items-start justify-between gap-3 text-left" aria-expanded={open}>
        <div className="min-w-0">
          <p className="text-sm truncate">
            <span className="inline-block w-3 text-zinc-400">{open ? '▾' : '▸'}</span>{' '}
            {event.ticker ?? event.label}
            {event.assetClass === 'collectable' && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-[#f59e0b]/10 text-[#b45309] dark:text-[#fbbf24]">
                collectable
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 pl-4">
            {formatDate(event.saleDate)} · {event.quantity} units ·{' '}
            {event.allocations.length === 1 ? '1 parcel' : `${event.allocations.length} parcels`}
          </p>
        </div>
        <span className={`text-sm amount shrink-0 ${event.gain >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
          {event.gain >= 0 ? '+' : ''}{money(event.gain)}
        </span>
      </button>

      {open && (
        <div className="pl-4 mt-2 space-y-1.5">
          {event.allocations.map(a => (
            <div key={a.key} className="flex items-start justify-between gap-3 text-xs">
              <div className="min-w-0">
                <p>
                  {a.quantity} units ·{' '}
                  {a.acquiredDate ? `bought ${formatDate(a.acquiredDate)}` : 'acquisition date unknown'}
                  {a.heldDays != null && <> · held {a.heldDays} days</>}
                </p>
                <p className="text-zinc-500 dark:text-zinc-400">
                  {a.source === 'parcel'
                    ? 'from a recorded parcel'
                    : a.source === 'recorded'
                      ? 'cost base recorded on the sale itself'
                      : 'no cost base recorded — the whole proceeds are a gain'}
                  {' · '}proceeds {money(a.proceeds)} − cost {money(a.costBase)}
                  {a.discountEligible && <span className="text-[#22c55e]"> · 50% discount</span>}
                  {a.dateUnknown && (
                    <span className="text-[#b45309] dark:text-[#fbbf24]"> · no discount without a date</span>
                  )}
                  {a.exempt && <span> · collectable under $500, ignored</span>}
                </p>
              </div>
              <span className={`amount shrink-0 ${a.gain >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                {a.gain >= 0 ? '+' : ''}{money(a.gain)}
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 pt-1">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {money(event.proceeds)} proceeds
              {event.fees > 0 && <> less {money(event.fees)} of selling costs</>}
            </p>
            <button onClick={onRemove} className="text-xs text-[#ef4444] hover:underline shrink-0">
              Remove this disposal
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Parcels ─────────────────────────────────────────────────────────────────

const BLANK_PARCEL = {
  investmentId: '', label: '', ticker: '', quantity: '', costBase: '', acquiredDate: '',
};

/**
 * Parcels are what makes a partial sale honest. A holding carries one cost basis
 * and no acquisition date; a parcel carries both, per purchase, so the units a
 * sale actually consumed bring their own date with them.
 *
 * A PARCEL MUST NAME ITS HOLDING. This form used to write `investmentId: null`
 * and identify the asset by ticker, while every sale the app records carries a
 * holding id — so the two could never be matched, and every date typed in here
 * was silently thrown away. Picking the holding is now the first field, and the
 * holding's own units and cost are offered as the starting point.
 */
function ParcelEditor({ parcels, currency, holdings, onSuggest, onAdd, onUpdate, onRemove }: {
  parcels: CgtParcel[];
  currency: string;
  holdings: ParcelHolding[];
  onSuggest: (investmentId: string) => Omit<CgtParcel, 'id'> | null;
  onAdd: (p: Omit<CgtParcel, 'id'>) => void;
  onUpdate: (id: string, p: Partial<Omit<CgtParcel, 'id'>>) => void;
  onRemove: (id: string) => void;
}) {
  const [form, setForm] = useState(BLANK_PARCEL);
  const money = (n: number) => formatCurrency(n, currency);
  const valid = form.label.trim() !== '' && parseFloat(form.quantity) > 0;

  /** Picking a holding fills the form from what Ledger already knows about it. */
  const pickHolding = (id: string) => {
    if (!id) { setForm(BLANK_PARCEL); return; }
    const holding = holdings.find(h => h.id === id);
    const s = onSuggest(id);
    setForm({
      investmentId: id,
      label: s?.label ?? holding?.name ?? '',
      ticker: s?.ticker ?? holding?.ticker ?? '',
      quantity: s ? String(s.quantity) : '',
      costBase: s ? String(s.costBase) : '',
      acquiredDate: s?.acquiredDate ?? '',
    });
  };

  const submit = () => {
    if (!valid) return;
    onAdd({
      investmentId: form.investmentId || null,
      label: form.label.trim(),
      ticker: form.ticker.trim() ? form.ticker.trim().toUpperCase() : null,
      assetType: holdings.find(h => h.id === form.investmentId)?.asset_type ?? null,
      quantity: parseFloat(form.quantity),
      costBase: parseFloat(form.costBase) || 0,
      acquiredDate: form.acquiredDate || null,
    });
    setForm(BLANK_PARCEL);
  };

  return (
    <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Parcels you bought
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
        One line per purchase. A sale draws on the oldest parcel first, which is what the ATO
        assumes when the parcels can't be told apart — and it is the acquisition DATE that decides
        whether half the gain is taxed or all of it.
      </p>

      {parcels.length > 0 && (
        <div className="mt-3 space-y-1">
          {parcels.map(p => (
            <div key={p.id} className="flex items-center justify-between gap-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0">
              <div className="min-w-0">
                <p className="text-sm truncate">{p.ticker ?? p.label}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {p.quantity} units · {money(p.costBase)}
                  {' · '}
                  {p.acquiredDate ? formatDate(p.acquiredDate) : 'no date — no discount'}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {!p.acquiredDate && (
                  <input
                    type="date"
                    aria-label={`Acquisition date for ${p.label}`}
                    onChange={e => onUpdate(p.id, { acquiredDate: e.target.value || null })}
                    className="text-xs bg-transparent border border-zinc-200 dark:border-zinc-700 rounded-[6px] px-1.5 py-1"
                  />
                )}
                <button onClick={() => onRemove(p.id)} className="text-xs text-[#ef4444] hover:underline">
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {holdings.length > 0 && (
        <div className="mt-3">
          <Select label="Which holding?" value={form.investmentId}
            onChange={e => pickHolding(e.target.value)}
            options={[
              { value: '', label: 'Not one of my holdings' },
              ...holdings.map(h => ({ value: h.id, label: h.ticker ? `${h.ticker} — ${h.name}` : h.name })),
            ]} />
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Picking the holding is what lets a sale of it draw on this parcel. Its
            current units and cost are filled in for you — split them into the
            purchases you actually made, each with its own date.
          </p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2">
        <Input label="Holding" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
        <Input label="Ticker" value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))} />
        <Input label="Units" type="number" step="0.00000001" value={form.quantity}
          onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
        <Input label={`Cost (${currency})`} type="number" step="0.01" prefix="$" value={form.costBase}
          onChange={e => setForm(f => ({ ...f, costBase: e.target.value }))} />
        <Input label="Bought on" type="date" value={form.acquiredDate}
          onChange={e => setForm(f => ({ ...f, acquiredDate: e.target.value }))} />
      </div>
      <div className="mt-2">
        <Button size="sm" variant="secondary" onClick={submit} disabled={!valid}>Add parcel</Button>
      </div>
    </div>
  );
}

// ─── Losses brought in from a lodged return ──────────────────────────────────

/**
 * A capital loss lives forever, so one made before Ledger existed still reduces
 * this year's gain. It is asked for WITH THE YEAR IT WAS MEASURED AT, because a
 * figure off a lodged return is a statement about a point in time — and years
 * before that point are then computed with no opening balance at all, rather
 * than Ledger quietly re-deriving a year the ATO has already accepted.
 */
function OpeningEditor({ fy, opening, currency, onSave }: {
  fy: string;
  opening: OpeningCapitalLosses | null;
  currency: string;
  onSave: (o: OpeningCapitalLosses | null) => void;
}) {
  const [form, setForm] = useState({
    fy: opening?.fy ?? fy,
    ordinary: opening ? String(opening.ordinary) : '',
    collectable: opening ? String(opening.collectable) : '',
  });

  const save = () => {
    const ordinary = parseFloat(form.ordinary) || 0;
    const collectable = parseFloat(form.collectable) || 0;
    onSave(ordinary === 0 && collectable === 0 ? null : { fy: form.fy, ordinary, collectable });
  };

  return (
    <div className="mt-4 pt-4 border-t border-zinc-100 dark:border-zinc-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Capital losses from before Ledger
      </p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
        The unapplied net capital losses on your last lodged return, and the financial year they
        were measured at the start of. Ledger rolls them forward year by year from there, and never
        applies them to a year that came before.
      </p>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
        <Input label="As at the start of FY" value={form.fy} onChange={e => setForm(f => ({ ...f, fy: e.target.value }))}
          hint="Written as 2023-2024" />
        <Input label={`Net capital losses (${currency})`} type="number" step="0.01" prefix="$" value={form.ordinary}
          onChange={e => setForm(f => ({ ...f, ordinary: e.target.value }))} />
        <Input label={`Of which collectables (${currency})`} type="number" step="0.01" prefix="$" value={form.collectable}
          onChange={e => setForm(f => ({ ...f, collectable: e.target.value }))}
          hint="Only deductible from collectable gains" />
      </div>
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="secondary" onClick={save}>Save</Button>
        {opening && (
          <Button size="sm" variant="secondary" onClick={() => onSave(null)}>Clear</Button>
        )}
      </div>
    </div>
  );
}
