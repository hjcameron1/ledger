import { useState, useEffect, useMemo } from 'react';
import { PageHeader } from '../components/design-kit/UI';
import Layout from '../components/layout/Layout';
import { useStore } from '../store';
import { calculateTax, getTaxBrackets, deductionsDS, taxYearDS, studentLoanIncomeDS, taxCreditsDS, taxProfileDS, cgtDS, dividendsDS, salesDS, rentalTaxDS } from '../services/dataService';
import { payrollApi } from '../services/api';
import { formatCurrency, formatDate, getCurrentFinancialYear } from '../utils/format';
import { taxFreeThresholdClaims, type PayslipCore } from '../utils/payroll';
import {
  deductibleTransactionsForFY,
  DEDUCTION_CATEGORIES,
  type DeductionEntity,
  type ManualDeduction,
} from '../utils/taxDeductions';
import { formatFY, shiftFY } from '../utils/taxYear';
import { supportedTaxYearRange } from '../utils/taxRates';
import {
  repaymentIncomeFrom,
  type RepaymentIncomeAdjustments,
  type RepaymentIncomeField,
} from '../utils/repaymentIncome';
import {
  grossUpFor,
  type TaxCredits,
  type TaxCreditField,
} from '../utils/taxCredits';
import { buildTaxSettlement } from '../utils/taxSettlement';
import { buildOffsetPosition } from '../utils/taxOffsets';
import { buildTaxPack } from '../utils/taxPack';
import { type TaxProfile } from '../utils/taxProfile';
import type { Transaction } from '../types';
import Card from '../components/common/Card';
import Modal from '../components/common/Modal';
import Button from '../components/common/Button';
import Input, { Select, Toggle } from '../components/common/Input';
import TaxYearSummary from '../components/tax/TaxYearSummary';
import TaxSettlement from '../components/tax/TaxSettlement';
import TaxCircumstances, { IncomeTestFields } from '../components/tax/TaxCircumstances';
import RentalProperties from '../components/tax/RentalProperties';
import TaxPackCard from '../components/tax/TaxPack';
import type { RentalPropertySettings } from '../utils/rentalProperty';
import CapitalGains from '../components/tax/CapitalGains';
import LinkedDocuments from '../components/common/LinkedDocuments';
import DividendStatements from '../components/tax/DividendStatements';
import type { CgtParcel, OpeningCapitalLosses } from '../utils/capitalGains';
import type { DividendStatement } from '../utils/dividendIncome';

/**
 * Today as a local "YYYY-MM-DD". Built from the local date parts rather than
 * toISOString(), which reports UTC and would put a Sydney morning on 1 July into
 * the previous financial year.
 */
function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function Tax() {
  const { user, transactions } = useStore();
  const currency = user?.currency_preference ?? 'AUD';

  const [addDeductionOpen, setAddDeductionOpen] = useState(false);
  const [editingDeduction, setEditingDeduction] = useState<ManualDeduction | null>(null);
  const [deductions, setDeductions] = useState<ManualDeduction[]>([]);
  // "Do you have a loan" is a fact about the user; the repayment-income figures
  // are facts about a YEAR, so they reload whenever the FY switcher moves.
  const [hecsEnabled, setHecsEnabled] = useState(() => studentLoanIncomeDS.hasLoan());
  const [loanAdjustments, setLoanAdjustments] = useState<RepaymentIncomeAdjustments>(
    () => studentLoanIncomeDS.adjustmentsFor(getCurrentFinancialYear()),
  );
  const [loanIncomeOpen, setLoanIncomeOpen] = useState(false);
  // Phase 5.2 — tax already paid that Ledger can't derive. Per FY, same as the
  // repayment-income figures above.
  const [credits, setCredits] = useState<TaxCredits>(
    () => taxCreditsDS.forFY(getCurrentFinancialYear()),
  );
  // Phase 5.3 — who the taxpayer is: spouse, dependants, hospital cover, seniors
  // eligibility, health statement figures. Per FY, like everything beside it.
  const [profile, setProfile] = useState<TaxProfile>(
    () => taxProfileDS.forFY(getCurrentFinancialYear()),
  );
  const [payslips, setPayslips] = useState<PayslipCore[]>([]);
  const [selectedFY, setSelectedFY] = useState<string>(getCurrentFinancialYear());
  // Phase 5.4 — parcels, the opening loss and dividend statements all feed the FY
  // position through taxYearDS, so an edit has to re-run the whole build. One
  // counter does that: the position is a pure function of the stores, and this
  // says "a store moved".
  const [investmentTaxVersion, setInvestmentTaxVersion] = useState(0);
  const bumpInvestmentTax = () => setInvestmentTaxVersion(v => v + 1);
  const parcels = useMemo(() => cgtDS.parcels(), [investmentTaxVersion]);
  const openingLosses = useMemo(() => cgtDS.opening(), [investmentTaxVersion]);
  const dividendStatements = useMemo(() => dividendsDS.getAll(), [investmentTaxVersion]);

  const reloadDeductions = () => setDeductions(deductionsDS.getAll());
  useEffect(() => { reloadDeductions(); }, [addDeductionOpen]);

  useEffect(() => {
    setLoanAdjustments(studentLoanIncomeDS.adjustmentsFor(selectedFY));
    setCredits(taxCreditsDS.forFY(selectedFY));
    setProfile(taxProfileDS.forFY(selectedFY));
  }, [selectedFY]);

  useEffect(() => {
    payrollApi.getAll()
      .then(d => setPayslips((d.payslips ?? []) as PayslipCore[]))
      .catch(() => { /* leave empty */ });
  }, []);

  // FY switcher options — every year with income, a payslip or a deduction in it,
  // always including the current FY so the list is never empty.
  const fyOptions = useMemo(
    () => taxYearDS.financialYears({ payslips }),
    // `deductions`/`transactions` are the store slices taxYearDS reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, deductions, payslips, investmentTaxVersion],
  );

  // Phase 5.1 — the whole FY position: income, deductions and the estimated
  // taxable income that the tax calculation below is run on. One engine, so the
  // summary, the deduction list and the estimate can never disagree.
  const position = useMemo(
    () => taxYearDS.build({ fy: selectedFY, payslips }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [transactions, deductions, payslips, selectedFY, credits, investmentTaxVersion],
  );
  const view = position.deductions;

  // Deductible transactions in this FY the user can link a manual deduction to
  // (minus any already claimed by another manual line, to prevent a double link).
  const linkableTx = useMemo(() => {
    const claimed = new Set(
      deductions
        .filter(d => d.id !== editingDeduction?.id)
        .map(d => d.source_transaction_id?.trim())
        .filter(Boolean) as string[],
    );
    return deductibleTransactionsForFY(transactions, selectedFY).filter(t => !claimed.has(t.id));
  }, [transactions, deductions, selectedFY, editingDeduction]);

  const totalDeductions = view.total;

  // The deduction MANAGER lists only what can be managed here. A rental line is
  // derived from the property's rules and edited on the rental card, so listing
  // it with an edit button that does nothing would be a lie about the controls.
  const manageableGroups = view.groups
    .map(g => ({ ...g, lines: g.lines.filter(l => l.source !== 'rental') }))
    .filter(g => g.lines.length > 0);

  // Franking credits are company tax already paid on the user's behalf, so the
  // ATO adds them to assessable income AND credits them against the bill. The
  // credit half is on the settlement below; this is the gross-up half, and the
  // two are applied together or not at all.
  //
  // Phase 5.4 — WHERE the franking figure comes from is now decided in one place.
  // Statements are the more explicit record, so when there are any they replace
  // the single figure on the tax-paid card rather than being added to it, and
  // BOTH halves — the gross-up and the credit — read the same reconciled number.
  const dividends = position.income.dividends;
  const effectiveCredits: TaxCredits = dividends
    ? { ...credits, frankingCredits: dividends.effectiveFrankingCredit }
    : credits;
  const grossUp = grossUpFor(effectiveCredits);

  // Phase 5.5 — a NET RENTAL LOSS is the one figure on this page that leaves the
  // tax calculation and turns up in a different income base entirely. It reduces
  // taxable income (it is already inside the deductions above), and the ATO then
  // adds it BACK for study-loan repayments, the Medicare levy surcharge and the
  // seniors offset. Ledger can now derive it, so the field stops being a blank.
  //
  // The larger of the two wins rather than the derived one outright: the typed
  // figure may also carry an investment loss Ledger cannot see (margin interest
  // on shares is a total net investment loss too), and quietly replacing it with
  // a smaller number would understate every one of those three tests.
  const rental = position.income.rental;
  const derivedInvestmentLoss = rental?.netRentalLoss ?? 0;
  const effectiveAdjustments: RepaymentIncomeAdjustments = derivedInvestmentLoss > 0
    ? {
        ...loanAdjustments,
        totalNetInvestmentLoss: Math.max(
          loanAdjustments.totalNetInvestmentLoss,
          derivedInvestmentLoss,
        ),
      }
    : loanAdjustments;

  // The estimate runs on the position's own figures, for the SELECTED year —
  // income and withholding included — so switching FY moves the whole page, not
  // just the deduction list. calculateTax nets the deductions off itself, which
  // reproduces position.estimatedTaxableIncome (plus any gross-up) exactly, and
  // assesses it on that year's own brackets, levy thresholds and HELP schedule.
  const taxData = calculateTax(hecsEnabled, {
    fy: selectedFY,
    total_income: position.assessableIncome + grossUp,
    tax_withheld: position.taxWithheld,
    total_deductions: totalDeductions,
    repayment_income_adjustments: effectiveAdjustments,
  });
  // The loan's own income base, itemised for display. calculateTax has already
  // assessed the repayment on exactly this total — this only names the parts.
  const repayment = repaymentIncomeFrom(taxData.total_income, effectiveAdjustments);

  // Phase 5.3 — offsets, the Medicare levy surcharge and the private health
  // rebate reconciliation. It takes the income tax because non-refundable
  // offsets can be set against that and nothing else, and it refuses the year
  // outright when Ledger holds no offset rules for it.
  const offsets = useMemo(
    () => buildOffsetPosition({
      fy: selectedFY,
      taxableIncome: taxData.total_income,
      incomeTax: taxData.income_tax,
      adjustments: effectiveAdjustments,
      profile,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedFY, taxData.total_income, taxData.income_tax, effectiveAdjustments, profile],
  );

  // Phase 5.2 — liability against everything already paid. Pure engine: it adds
  // up what the two above produced and refuses an answer when the year has no
  // rates. The tax-free-threshold count is a localStorage fact (payroll.ts), so
  // the page reads it and hands it over rather than the engine reaching for it.
  const settlement = useMemo(
    () => buildTaxSettlement({
      position,
      tax: {
        ratesAvailable: taxData.rates_available,
        taxableIncome: taxData.total_income,
        incomeTax: taxData.income_tax,
        medicareLevy: taxData.medicare_levy,
        studentLoanRepayment: taxData.hecs_repayment,
        confidence: taxData.rates_confidence,
        notes: taxData.rates_notes,
      },
      credits: effectiveCredits,
      offsets,
      taxFreeThresholdClaims: taxFreeThresholdClaims(
        position.income.lines.filter(l => l.kind === 'payslip' && !l.excluded).map(l => l.label),
      ),
      asOf: todayISO(),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position, taxData.rates_available, taxData.total_income, taxData.income_tax,
     taxData.medicare_levy, taxData.hecs_repayment, taxData.rates_confidence, effectiveCredits, offsets],
  );

  // Phase 5.6 — the accountant pack. It takes the OBJECTS ABOVE, not the stores
  // they came from: a second path to the same numbers is a second path that can
  // drift, so there isn't one. All the pack does is re-present them in the order
  // a return runs — and then check its own sums against the engines' totals, so
  // a document that quietly stopped adding up says so instead.
  const pack = useMemo(
    () => buildTaxPack({
      position,
      settlement,
      offsets,
      repayment,
      hasStudentLoan: hecsEnabled,
      currency,
      grossUp,
      taxableIncome: taxData.total_income,
      preparedOn: todayISO(),
      taxpayer: user?.name ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [position, settlement, offsets, repayment, hecsEnabled, currency, grossUp,
     taxData.total_income, user?.name],
  );

  const setHasLoan = (has: boolean) => {
    setHecsEnabled(has);
    studentLoanIncomeDS.setHasLoan(has);
  };
  const setAdjustment = (key: RepaymentIncomeField, value: number) => {
    const next = { ...loanAdjustments, [key]: value };
    setLoanAdjustments(next);
    studentLoanIncomeDS.save(selectedFY, next);
  };
  const setCredit = (key: TaxCreditField, value: number) => {
    const next = { ...credits, [key]: value };
    setCredits(next);
    taxCreditsDS.save(selectedFY, next);
  };
  const setProfileField = (key: keyof TaxProfile, value: TaxProfile[keyof TaxProfile]) => {
    const next = { ...profile, [key]: value } as TaxProfile;
    setProfile(next);
    taxProfileDS.save(selectedFY, next);
  };
  // Phase 5.4 — every one of these writes to a store and then tells the position
  // to rebuild. Nothing is recomputed here; the engines do all of it.
  const addParcel = (p: Omit<CgtParcel, 'id'>) => { cgtDS.addParcel(p); bumpInvestmentTax(); };
  const updateParcel = (id: string, p: Partial<Omit<CgtParcel, 'id'>>) => {
    cgtDS.updateParcel(id, p); bumpInvestmentTax();
  };
  const removeParcel = (id: string) => { cgtDS.removeParcel(id); bumpInvestmentTax(); };
  const setOpeningLosses = (o: OpeningCapitalLosses | null) => { cgtDS.setOpening(o); bumpInvestmentTax(); };
  const removeDisposal = (id: string) => { salesDS.remove(id); bumpInvestmentTax(); };
  const addStatement = (d: Omit<DividendStatement, 'id'>) => { dividendsDS.add(d); bumpInvestmentTax(); };
  const removeStatement = (id: string) => { dividendsDS.remove(id); bumpInvestmentTax(); };
  const saveRentalSettings = (propertyId: string, next: RentalPropertySettings) => {
    rentalTaxDS.save(propertyId, next); bumpInvestmentTax();
  };
  // Read through the version counter for the same reason the parcels are: the
  // position is a pure function of a store React cannot see change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rentalSettingsFor = useMemo(() => (id: string) => rentalTaxDS.settingsFor(id), [investmentTaxVersion]);

  const investmentLossNote = derivedInvestmentLoss > 0
    ? `Ledger worked out a net rental loss of ${formatCurrency(derivedInvestmentLoss, currency)} from your `
      + `properties, and is using ${formatCurrency(effectiveAdjustments.totalNetInvestmentLoss, currency)} here`
      + (loanAdjustments.totalNetInvestmentLoss > derivedInvestmentLoss
        ? ' — your own figure, because it is the larger and may include losses Ledger cannot see.'
        : '. Enter more only if you have investment losses outside these properties.')
    : undefined;

  // Offered, never automatic: most of these facts persist year to year, and
  // assuming they did is exactly how a lapsed policy becomes a silent error.
  const previousFY = shiftFY(selectedFY, -1);
  const canCopyProfile = !taxProfileDS.has(selectedFY) && taxProfileDS.has(previousFY);
  const brackets = getTaxBrackets(selectedFY);
  const rateRange = supportedTaxYearRange();

  const fySelector = fyOptions.length > 1 ? (
    <div className="w-36 shrink-0">
      <Select
        value={selectedFY}
        onChange={e => setSelectedFY(e.target.value)}
        options={fyOptions.map(f => ({ value: f, label: `FY ${formatFY(f)}` }))}
      />
    </div>
  ) : null;

  return (
    <Layout>
      <PageHeader title="Tax" />

      {/* Phase 5.1 — the FY position, with drill-down to every source. */}
      <TaxYearSummary position={position} currency={currency} fySelector={fySelector} />

      {/* Phase 5.2 — liability vs everything already paid, and the gap. */}
      <TaxSettlement
        settlement={settlement}
        currency={currency}
        credits={credits}
        onChangeCredit={setCredit}
        supersededFields={
          dividends?.supersededManualFranking != null
            ? {
                frankingCredits:
                  `Your dividend statements below are being counted instead — ` +
                  `${formatCurrency(dividends.effectiveFrankingCredit, currency)}, not this figure.`,
              }
            : undefined
        }
        unsupportedDetail={
          rateRange ? (
            <>
              Rates are held for FY {formatFY(rateRange.earliest)} to FY {formatFY(rateRange.latest)}.
              The position above is still FY {formatFY(selectedFY)}'s own.
            </>
          ) : null
        }
      />

      {/* Phase 5.3 — the answers those offsets and the surcharge were built from. */}
      <TaxCircumstances
        fy={selectedFY}
        profile={profile}
        onChange={setProfileField}
        adjustments={loanAdjustments}
        onChangeAdjustment={setAdjustment}
        derivedNotes={investmentLossNote ? { totalNetInvestmentLoss: investmentLossNote } : undefined}
        offsets={offsets}
        currency={currency}
        previousFY={canCopyProfile ? previousFY : undefined}
        onCopyPreviousYear={
          canCopyProfile
            ? () => setProfile(taxProfileDS.copyFrom(previousFY, selectedFY))
            : undefined
        }
      />

      {/* Phase 5.4 — the capital gain that is already inside the income above,
          with the ATO's own steps and drill-down to every parcel behind it. */}
      <CapitalGains
        fy={selectedFY}
        position={position.capitalGains}
        parcels={parcels}
        currency={currency}
        opening={openingLosses}
        onAddParcel={addParcel}
        onUpdateParcel={updateParcel}
        onRemoveParcel={removeParcel}
        onSetOpening={setOpeningLosses}
        onRemoveDisposal={removeDisposal}
      />

      {/* Phase 5.4 — dividend statements: the franking credit's only source, and
          the check that its cash is not counted twice. */}
      <DividendStatements
        fy={selectedFY}
        position={dividends}
        statements={dividendStatements}
        currency={currency}
        onAdd={addStatement}
        onRemove={removeStatement}
      />

      {/* Phase 5.5 — the rental schedule: rent as it was received, every
          deduction under its ATO heading, and the interest/principal split. */}
      <RentalProperties
        fy={selectedFY}
        position={rental}
        currency={currency}
        settingsFor={rentalSettingsFor}
        onSaveSettings={saveRentalSettings}
      />

      {/* Study and training loan. The liability breakdown moved to the settlement
          card above; what's left here is the two things the user SETS — whether
          there is a loan, and the income it is assessed on. */}
      <Card className="mb-6">
        <h3 className="font-medium mb-3">Study and training loan</h3>
        <div>
          <Toggle label="I have a HECS/HELP debt" checked={hecsEnabled} onChange={setHasLoan} />

          {/* Repayment income — the loan's own base. Only shown when there is a
              loan to repay, because for everyone else it changes nothing. */}
          {hecsEnabled && (
            <div className="mt-3 rounded-[10px] border border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    Repayment income · <span className="amount">{formatCurrency(taxData.repayment_income, currency)}</span>
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {repayment.unadjusted ? (
                      <>A loan repayment is assessed on repayment income, not taxable income. Add anything below that your taxable income doesn't already include.</>
                    ) : (
                      <>
                        {formatCurrency(repayment.taxableIncome, currency)} taxable income
                        {repayment.adjustments >= 0 ? ' + ' : ' − '}
                        {formatCurrency(Math.abs(repayment.adjustments), currency)} not counted in it.
                      </>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setLoanIncomeOpen(v => !v)}
                  className="shrink-0 text-xs text-brand hover:underline"
                >
                  {loanIncomeOpen ? 'Done' : repayment.unadjusted ? 'Add figures' : 'Edit'}
                </button>
              </div>

              {loanIncomeOpen && (
                <div className="mt-3 space-y-3">
                  <IncomeTestFields
                    adjustments={loanAdjustments}
                    onChange={setAdjustment}
                    derivedNotes={investmentLossNote ? { totalNetInvestmentLoss: investmentLossNote } : undefined}
                  />
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">
                    Saved against FY {formatFY(selectedFY)} only — each of these is an annual figure.
                    The same five feed the seniors offset and the Medicare levy surcharge above.
                  </p>
                </div>
              )}

              {!repayment.unadjusted && !loanIncomeOpen && (
                <div className="mt-2 space-y-0.5">
                  {repayment.components.slice(1).map(c => (
                    <div key={c.key} className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400">
                      <span>{c.label}</span>
                      <span className="amount">{c.amount < 0 ? '−' : '+'}{formatCurrency(Math.abs(c.amount), currency)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* The year's own paperwork — group certificates, notices of assessment,
          receipts — filed against this FY in the vault and read from this end.
          A tax document is personal: it never follows a household. */}
      <Card className="mb-6">
        <h3 className="font-medium mb-3">Documents · FY {formatFY(selectedFY)}</h3>
        <LinkedDocuments
          linkedType="tax_year"
          linkedId={selectedFY}
          title="Filed against this year"
          emptyText="Nothing filed against this financial year yet — upload it in Documents and link it to this tax year." />
      </Card>

      {/* Tax brackets — the SELECTED year's scale, not a fixed one. */}
      <Card className="mb-6">
        <h3 className="font-medium mb-3">{formatFY(selectedFY)} Tax Brackets</h3>
        {brackets.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">
            Ledger has no bracket table for FY {formatFY(selectedFY)}.
          </p>
        ) : (
        <div className="space-y-1.5">
          {brackets.map((b, i) => {
            const isActive = taxData.total_income >= b.min && (b.max == null || taxData.total_income <= b.max);
            return (
              <div key={i} className={`flex justify-between text-sm py-1 px-2 rounded-[6px] ${isActive ? 'bg-brand/10 font-medium' : ''}`}>
                <span className={isActive ? 'text-brand' : 'text-zinc-500 dark:text-zinc-400'}>
                  ${b.min.toLocaleString()} – {b.max ? `$${b.max.toLocaleString()}` : 'above'}
                </span>
                <span className={isActive ? 'text-brand' : 'text-zinc-900 dark:text-zinc-100'}>
                  {/* Pre-2024-25 scales have a 32.5c rate — don't round it to 33c. */}
                  {b.rate === 0 ? 'Nil' : `${+(b.rate * 100).toFixed(1)}c per $1`}
                </span>
              </div>
            );
          })}
        </div>
        )}
      </Card>

      {/* Phase 5.6 — the whole year as one document, with every figure opening
          onto its source and three ways to take it away. */}
      <TaxPackCard pack={pack} currency={currency} />

      {/* Deductions — merged FY view: manual entries + deductible transactions.
          The FY is chosen once, in the summary above; this list follows it. */}
      <div className="flex justify-between items-start mb-3 gap-3">
        <div>
          <h3 className="font-medium">Manage deductions · FY {formatFY(selectedFY)}</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Total: <span className="font-medium">{formatCurrency(view.total, currency)}</span>
            {view.transactionTotal > 0 && (
              <> · {formatCurrency(view.manualTotal, currency)} manual + {formatCurrency(view.transactionTotal, currency)} from transactions</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => { setEditingDeduction(null); setAddDeductionOpen(true); }}>+ Add</Button>
        </div>
      </div>

      {/* Suspected-duplicate review banner — same expense entered twice, counted once. */}
      {view.suspectedDuplicates.length > 0 && (
        <div className="mb-3 rounded-[10px] border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-2.5">
          <p className="text-xs font-medium text-[#b45309] dark:text-[#fbbf24]">
            {view.suspectedDuplicates.length === 1 ? 'Possible duplicate found' : `${view.suspectedDuplicates.length} possible duplicates found`}
          </p>
          <p className="text-xs text-[#b45309]/80 dark:text-[#fbbf24]/80 mt-0.5">
            A manual deduction and a deductible transaction look like the same expense.
            The transaction is flagged below and left out of the total so it's counted once — review each to link or keep both.
          </p>
        </div>
      )}

      {/* Phase 5.5 — a rental line is not editable here: it is derived from the
          property's own rules and its settings live on the rental card. It is
          still in the total above; this list is only what can be changed. */}
      {view.externalTotal > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
          {formatCurrency(view.externalTotal, currency)} of rental deductions is in the total above and
          managed on the rental schedule, not here.
        </p>
      )}

      {manageableGroups.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 py-4 text-center">
          No deductions for FY {selectedFY} yet. Add one, or mark a transaction as tax-deductible.
        </p>
      ) : (
        <div className="space-y-5">
          {manageableGroups.map(group => (
            <div key={group.category}>
              <div className="flex justify-between items-center mb-1.5 px-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{group.category}</h4>
                <span className="text-xs font-semibold amount text-[#22c55e]">-{formatCurrency(group.total, currency)}</span>
              </div>
              <div className="space-y-2">
                {group.lines.map(line => (
                  <div key={line.key} className={`flex items-center justify-between px-3 py-2.5 card group ${line.excluded ? 'opacity-70 border-[#f59e0b]/40' : ''}`}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate">{line.name}</p>
                        {line.source === 'transaction' && !line.suspectedDuplicate && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#3b82f6]/10 text-[#3b82f6]" title="Pulled from a transaction you marked tax-deductible">from transaction</span>
                        )}
                        {line.source === 'manual' && line.linked && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#8b5cf6]/10 text-[#8b5cf6]" title="Linked to a transaction — that transaction is not counted again">↔ linked</span>
                        )}
                        {line.suspectedDuplicate && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#f59e0b]/15 text-[#b45309] dark:text-[#fbbf24]" title="Looks like the same expense as a manual deduction — counted once, review to link or keep both">
                            {line.source === 'transaction' ? '⚠ possible duplicate' : '⚠ has duplicate'}
                          </span>
                        )}
                        {line.entity === 'business' && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#0ea5e9]/10 text-[#0ea5e9]" title="Claimed against business income">business</span>
                        )}
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                        {formatDate(line.date)}
                        {line.merchant ? <> · {line.merchant}</> : null}
                        {line.refunded > 0 ? <> · {formatCurrency(line.refunded, currency)} refunded</> : null}
                        {line.excluded
                          ? <> · {line.excludedReason === 'counted-in-rental'
                              ? 'claimed on the rental schedule, at your share'
                              : line.excludedReason === 'future'
                                ? 'dated ahead — counts when the day arrives'
                                : 'not counted'}</>
                          : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {line.refunded > 0 && !line.excluded && (
                        <span className="text-xs text-zinc-400 dark:text-zinc-500 line-through amount" title="Claim before the refund">
                          {formatCurrency(line.amount, currency)}
                        </span>
                      )}
                      <span className={`text-sm font-semibold amount ${line.excluded ? 'text-zinc-400 line-through dark:text-zinc-500' : 'text-[#22c55e]'}`}>-{formatCurrency(line.excluded ? line.amount : line.netAmount, currency)}</span>
                      {line.source === 'manual' ? (
                        <>
                          {line.linked && (
                            <button
                              onClick={() => { deductionsDS.setLink(line.id, null); reloadDeductions(); }}
                              className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#8b5cf6] transition-all"
                              title="Remove transaction link"
                            >⛓︎✕</button>
                          )}
                          <button
                            onClick={() => { setEditingDeduction(deductions.find(d => d.id === line.id) ?? null); setAddDeductionOpen(true); }}
                            className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#3b82f6] transition-all"
                            title="Edit deduction"
                          >✎</button>
                          <button
                            onClick={() => { deductionsDS.remove(line.id); reloadDeductions(); }}
                            className="text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-[#ef4444] transition-all"
                            title="Delete deduction"
                          >✕</button>
                        </>
                      ) : line.suspectedDuplicate && line.duplicateOf ? (
                        <>
                          <button
                            onClick={() => { deductionsDS.setLink(line.duplicateOf!, line.id); reloadDeductions(); }}
                            className="text-[11px] px-1.5 py-0.5 rounded-[6px] text-[#8b5cf6] hover:bg-[#8b5cf6]/10 transition-colors"
                            title="Confirm these are the same expense — link them (counted once)"
                          >Link</button>
                          <button
                            onClick={() => { deductionsDS.dismissDuplicate(line.duplicateOf!, line.id); reloadDeductions(); }}
                            className="text-[11px] px-1.5 py-0.5 rounded-[6px] text-zinc-500 hover:bg-zinc-500/10 transition-colors"
                            title="These are different expenses — count both"
                          >Keep both</button>
                        </>
                      ) : (
                        <span className="text-[10px] text-zinc-400 dark:text-zinc-500" title="Managed from the transaction's tax details">on transaction</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Deduction Modal */}
      <AddDeductionModal
        isOpen={addDeductionOpen}
        editing={editingDeduction}
        currency={currency}
        defaultDate={defaultDateForFY(selectedFY)}
        linkableTx={linkableTx}
        onClose={() => { setAddDeductionOpen(false); setEditingDeduction(null); }}
        onSave={(data) => {
          if (editingDeduction) {
            deductionsDS.update(editingDeduction.id, data);
          } else {
            deductionsDS.add(data);
          }
          reloadDeductions();
          setAddDeductionOpen(false);
          setEditingDeduction(null);
        }}
      />
    </Layout>
  );
}

/** A sensible default date inside the selected FY (its 1 July start, or today if current). */
function defaultDateForFY(fy: string): string {
  const today = new Date().toISOString().split('T')[0];
  if (fy === getCurrentFinancialYear()) return today;
  const startYear = parseInt(fy.split('-')[0], 10);
  return Number.isFinite(startYear) ? `${startYear}-07-01` : today;
}

// ─── Add Deduction Modal ─────────────────────────────────────────────────────

interface DeductionFormData {
  name: string;
  amount: number;
  category: string;
  date: string;
  source_transaction_id: string | null;
  /** null = inherit from the linked transaction, else personal. */
  entity: DeductionEntity | null;
}

function AddDeductionModal({ isOpen, onClose, onSave, editing, currency, defaultDate, linkableTx }: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (d: DeductionFormData) => void;
  editing?: ManualDeduction | null;
  currency: string;
  defaultDate: string;
  linkableTx: Transaction[];
}) {
  const blank = { name: '', amount: '', category: DEDUCTION_CATEGORIES[4], date: defaultDate, link: '', entity: '' };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    if (editing) {
      setForm({
        name: editing.name,
        amount: String(editing.amount),
        category: editing.category,
        date: editing.date,
        link: editing.source_transaction_id ?? '',
        entity: editing.entity ?? '',
      });
    } else {
      setForm({ ...blank });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, isOpen]);

  // Preserve a pre-existing category that isn't one of our presets.
  const categoryOptions = [
    ...(form.category && !DEDUCTION_CATEGORIES.includes(form.category)
      ? [{ value: form.category, label: form.category }]
      : []),
    ...DEDUCTION_CATEGORIES.map(c => ({ value: c, label: c })),
  ];

  // The currently linked transaction may sit outside `linkableTx` (it's claimed by
  // this very deduction) — inject it so the Select can still show/keep it.
  const linkedNotInList = editing?.source_transaction_id
    && !linkableTx.some(t => t.id === editing.source_transaction_id);
  const linkOptions = [
    { value: '', label: 'None — standalone deduction' },
    ...(linkedNotInList ? [{ value: editing!.source_transaction_id!, label: '(linked transaction)' }] : []),
    ...linkableTx.map(t => ({
      value: t.id,
      label: `${t.merchant || 'Transaction'} · ${formatDate(t.date)} · ${formatCurrency(Math.abs(t.amount), currency)}`,
    })),
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      name: form.name,
      amount: parseFloat(form.amount) || 0,
      category: form.category,
      date: form.date,
      source_transaction_id: form.link || null,
      entity: (form.entity || null) as DeductionEntity | null,
    });
  };

  // When linking a transaction, offer to prefill name/amount from it.
  const applyLinkPrefill = (txId: string) => {
    const t = linkableTx.find(x => x.id === txId);
    setForm(f => ({
      ...f,
      link: txId,
      name: f.name || (t?.merchant ?? ''),
      amount: f.amount || (t ? String(Math.abs(t.amount)) : ''),
    }));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? 'Edit Tax Deduction' : 'Add Tax Deduction'} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Deduction name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Home office equipment" required />
        <Input label="Amount" type="number" step="0.01" prefix="$" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
        <Select label="Category" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} options={categoryOptions} />
        <Select
          label="Entity"
          value={form.entity}
          onChange={e => setForm(f => ({ ...f, entity: e.target.value }))}
          options={[
            { value: '', label: form.link ? 'Same as the linked transaction' : 'Personal (default)' },
            { value: 'personal', label: 'Personal' },
            { value: 'business', label: 'Business' },
          ]}
        />
        <Input label="Date" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />

        {/* Optional link to a deductible transaction — prevents double counting. */}
        {(linkableTx.length > 0 || linkedNotInList) && (
          <div>
            <Select
              label="Link to transaction (optional)"
              value={form.link}
              onChange={e => applyLinkPrefill(e.target.value)}
              options={linkOptions}
            />
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
              Linking a deductible transaction records this deduction once — the transaction won't be counted again.
            </p>
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" fullWidth>{editing ? 'Save Changes' : 'Add Deduction'}</Button>
        </div>
      </form>
    </Modal>
  );
}
