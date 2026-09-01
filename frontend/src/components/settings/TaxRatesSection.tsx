/**
 * Tax Settings — the rates Ledger actually uses, shown.
 *
 * This panel used to say the brackets were "maintained by Ledger" and to
 * contact support. That is not a setting, it is a shrug: the numbers every tax
 * figure in the app is built from were the one thing this screen wouldn't show
 * you. So it shows them — every financial year Ledger holds, the full income
 * scale, the Medicare levy and the student-loan schedule, straight out of the
 * same table the calculator reads (utils/taxRates), which is why they cannot
 * drift from what your tax position was worked out with.
 *
 * Years that are an estimate rather than legislated say so, in their own words.
 */
import { useState } from 'react';
import {
  supportedTaxYears, taxSettingsFor, displayBracketsFor,
  type FinancialYearTaxSettings,
} from '../../utils/taxRates';
import { formatFY } from '../../utils/taxYear';
import { getCurrentFinancialYear } from '../../utils/format';
import Card from '../common/Card';

const money = (n: number) => `$${n.toLocaleString('en-AU')}`;
/** Pre-2024-25 scales carry a 32.5c rate — don't round it to 33c. */
const cents = (rate: number) => (rate === 0 ? 'Nil' : `${+(rate * 100).toFixed(1)}c per $1`);

function Row({ left, right, muted }: { left: string; right: string; muted?: boolean }) {
  return (
    <div className="flex justify-between gap-4 text-sm py-1">
      <span className="text-zinc-500 dark:text-zinc-400">{left}</span>
      <span className={muted ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-900 dark:text-zinc-100'}>
        {right}
      </span>
    </div>
  );
}

function StudentLoan({ settings }: { settings: FinancialYearTaxSettings }) {
  const sl = settings.studentLoan;
  if (sl.model === 'income-bands') {
    return (
      <>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          A flat percentage of your <em>whole</em> repayment income once you cross the
          threshold ({money(sl.minThreshold)}).
        </p>
        {sl.bands.map((b, i) => (
          <Row key={i}
            left={`${money(b.from)} – ${b.to ? money(b.to) : 'above'}`}
            right={`${+(b.rate * 100).toFixed(1)}% of income`} />
        ))}
      </>
    );
  }
  return (
    <>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
        Charged marginally — a percentage of the income <em>above</em> each tier, not of
        all of it. Nothing is owed below {money(sl.minThreshold)}.
      </p>
      {sl.tiers.map((t, i) => (
        <Row key={i}
          left={`over ${money(t.from)}${t.to ? ` to ${money(t.to)}` : ''}`}
          right={t.wholeIncome
            ? `${+(t.rate * 100).toFixed(1)}% of total repayment income`
            : `${money(t.base)} + ${+(t.rate * 100).toFixed(1)}% of the excess`} />
      ))}
    </>
  );
}

export default function TaxRatesSection() {
  const years = supportedTaxYears();
  const [fy, setFy] = useState(() => {
    const current = getCurrentFinancialYear();
    return years.includes(current) ? current : years[years.length - 1];
  });

  const settings = taxSettingsFor(fy);
  const brackets = displayBracketsFor(fy);

  return (
    <div className="space-y-6">
      <Card>
        <h2 className="font-semibold mb-1">Tax rates</h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          The scales every tax figure in Ledger is worked out from. Ledger keeps them
          current; they are not editable, because a hand-edited bracket would make your
          tax position wrong without saying so.
        </p>

        <div className="flex flex-wrap gap-2 mb-5">
          {years.map(y => (
            <button
              key={y}
              type="button"
              onClick={() => setFy(y)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                ${y === fy
                  ? 'bg-brand/10 text-brand'
                  : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-900'}`}
            >
              {formatFY(y)}
            </button>
          ))}
        </div>

        {!settings ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Ledger holds no rates for FY {formatFY(fy)}.
          </p>
        ) : (
          <div className="space-y-6">
            {settings.confidence !== 'legislated' && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                FY {formatFY(fy)} is an estimate — indexed from the last legislated year,
                not law yet. Anything worked out on it moves when the real figures land.
              </p>
            )}
            {settings.notes.length > 0 && (
              <ul className="text-xs text-zinc-500 dark:text-zinc-400 list-disc pl-4 space-y-1">
                {settings.notes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            )}

            <div>
              <h3 className="font-medium text-sm mb-2">Income tax — residents</h3>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {brackets.map((b, i) => (
                  <Row key={i}
                    left={`${money(b.min)} – ${b.max ? money(b.max) : 'above'}`}
                    right={cents(b.rate)} />
                ))}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-2">
                Each rate applies only to the part of your income inside its band — the
                whole lot is never taxed at your top rate.
              </p>
            </div>

            <div>
              <h3 className="font-medium text-sm mb-2">Medicare levy</h3>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <Row left="Rate above the upper threshold"
                     right={`${+(settings.medicare.rate * 100).toFixed(1)}%`} />
                <Row left="Nothing owed up to" right={money(settings.medicare.lowerThreshold)} />
                <Row left="Phased in between"
                     right={`${money(settings.medicare.lowerThreshold)} – ${money(settings.medicare.upperThreshold)}`} />
                <Row left="Phase-in rate on the excess"
                     right={`${+(settings.medicare.shadeInRate * 100).toFixed(0)}%`} />
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-2">
                The Medicare levy surcharge is separate and depends on your cover — Tax
                asks about that where it affects your position.
              </p>
            </div>

            <div>
              <h3 className="font-medium text-sm mb-2">Study and training loans (HELP/HECS)</h3>
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <StudentLoan settings={settings} />
              </div>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <h3 className="font-medium mb-1">Something look wrong?</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          These are the published ATO scales for each year. If a figure here doesn't match
          what you expect, your tax position is being worked out on the number you see —
          so it is worth saying, rather than working around.
        </p>
      </Card>
    </div>
  );
}
