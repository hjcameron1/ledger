/**
 * Settings → Categories → "Category Rules".
 *
 * A management view over the SAME Phase 2B artifacts that get created when a user
 * picks "Apply to future matching transactions" while correcting a transaction:
 *   • transaction_rules  → "merchant/condition → category" automations
 *   • merchant_aliases   → learned merchant-name mappings (pattern → display name)
 *
 * This is intentionally a thin, read-mostly editor on top of the existing data
 * layer (transactionRulesDS / merchantAliasesDS / merchantsDS). It creates NO new
 * rules system — every change routes back through the same DS helpers (which sync
 * + persist), so edits, disables and deletes survive a refresh and change how
 * future transactions are categorised exactly as the rule engine already dictates.
 */
import { useMemo } from 'react';
import { useStore } from '../../store';
import { transactionRulesDS, merchantAliasesDS, merchantsDS } from '../../services/dataService';
import { useAllCategories } from '../../utils/categories';
import Card from '../common/Card';
import Button from '../common/Button';
import { Select, Toggle } from '../common/Input';
import { formatCurrency } from '../../utils/format';
import type { RuleCondition, TransactionRule } from '../../types';

/** Prettify an all-caps brand pattern ("WOOLWORTHS") into "Woolworths". */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/** The primary merchant name a rule keys on, preferring the human label. */
function ruleMerchantName(rule: TransactionRule): string {
  const label = (rule.label ?? '').split('→')[0]?.trim();
  if (label) return label;
  const raw = rule.conditions.merchant_contains ?? rule.conditions.merchant_normalized ?? '';
  return raw ? titleCase(raw) : 'Any transaction';
}

/**
 * Chips describing anything that makes a rule MORE specific than "match this
 * merchant" — extra conditions, or an exact-match (vs contains) merchant key.
 */
function conditionChips(
  c: RuleCondition,
  accountName: (id: string) => string,
  currency: string,
): string[] {
  const chips: string[] = [];
  // An exact normalized key only matches that precise description, not every
  // store/online variant a `contains` brand match would catch.
  if (c.merchant_normalized && !c.merchant_contains) chips.push('exact match only');
  if (c.description_contains) chips.push(`description contains "${c.description_contains}"`);
  if (c.account_id) chips.push(accountName(c.account_id));
  if (c.direction) chips.push(c.direction === 'credit' ? 'money in' : 'money out');
  if (c.amount_min != null && c.amount_max != null) {
    chips.push(`${formatCurrency(c.amount_min, currency)}–${formatCurrency(c.amount_max, currency)}`);
  } else if (c.amount_min != null) {
    chips.push(`≥ ${formatCurrency(c.amount_min, currency)}`);
  } else if (c.amount_max != null) {
    chips.push(`≤ ${formatCurrency(c.amount_max, currency)}`);
  }
  if (c.source) chips.push(`source: ${c.source}`);
  return chips;
}

/** Non-category effects of a rule, shown read-only so the full action is visible. */
function extraActionChips(rule: TransactionRule): string[] {
  const a = rule.actions;
  const chips: string[] = [];
  if (a.merchant) chips.push(`rename → ${a.merchant}`);
  if (a.entity) chips.push(a.entity);
  if (a.is_tax_deductible) chips.push('tax-deductible');
  if (a.transaction_type) chips.push(a.transaction_type);
  if (a.tags?.length) chips.push(`#${a.tags.join(' #')}`);
  return chips;
}

export default function CategoryRules({ currency }: { currency: string }) {
  const rules = useStore(s => s.transactionRules);
  const aliases = useStore(s => s.merchantAliases);
  const merchants = useStore(s => s.merchants);
  const accounts = useStore(s => s.accounts);
  const creditCards = useStore(s => s.creditCards);
  const userId = useStore(s => s.user?.id);
  const categories = useAllCategories();

  const accountName = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.id, a.name);
    for (const c of creditCards) map.set(c.id, c.name);
    return (id: string) => map.get(id) ?? 'a specific account';
  }, [accounts, creditCards]);

  // Newest-first, and category rules (the ones this section is about) first.
  const sortedRules = useMemo(
    () => [...rules].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')),
    [rules],
  );

  // Only the user's OWN learned aliases (a set user_id) are theirs to manage —
  // global seed aliases have a null user_id and aren't shown.
  const learnedAliases = useMemo(() => {
    const merchantName = new Map(merchants.map(m => [m.id, m.display_name] as const));
    return aliases
      .filter(a => a.user_id && a.user_id === userId)
      .map(a => ({ alias: a, name: merchantName.get(a.merchant_id) ?? '(unknown merchant)' }))
      .sort((x, y) => x.name.localeCompare(y.name));
  }, [aliases, merchants, userId]);

  const categoryOptions = (current?: string) => {
    const set = new Set(categories);
    if (current) set.add(current); // never drop a rule's own (maybe deselected) category
    return [...set].sort((a, b) => a.localeCompare(b)).map(c => ({ value: c, label: c }));
  };

  const changeCategory = (rule: TransactionRule, category: string) => {
    const merchant = ruleMerchantName(rule);
    transactionRulesDS.update(rule.id, {
      actions: { ...rule.actions, category },
      // Keep the human label in sync so the list stays readable after an edit.
      label: `${merchant} → ${category}`,
    });
  };

  const deleteRule = (rule: TransactionRule) => {
    if (!window.confirm(`Delete the rule "${ruleMerchantName(rule)} → ${rule.actions.category ?? '…'}"? Future transactions won't be auto-categorised by it.`)) return;
    transactionRulesDS.remove(rule.id);
  };

  const deleteAlias = (id: string, name: string) => {
    if (!window.confirm(`Forget the learned name "${name}" for this merchant? Future imports will use the raw bank description until you correct one again.`)) return;
    merchantAliasesDS.remove(id);
  };

  const renameMerchant = (merchantId: string, currentName: string) => {
    const next = window.prompt('Display name for this merchant', currentName);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentName) return;
    merchantsDS.update(merchantId, { display_name: trimmed });
  };

  return (
    <Card>
      <h2 className="font-semibold mb-1">Category Rules</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
        Automations you created by choosing “Apply to future matching transactions”. Each rule files
        a matching merchant under a category automatically. Edit the category, switch one off, or
        delete it — changes take effect on the next transactions.
      </p>

      {sortedRules.length === 0 ? (
        <p className="text-sm text-zinc-400 dark:text-zinc-500 mb-2">
          No rules yet. When you re-categorise a transaction and choose “apply to future matching
          transactions”, the rule shows up here.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {sortedRules.map(rule => {
            const merchant = ruleMerchantName(rule);
            const chips = conditionChips(rule.conditions, accountName, currency);
            const actionChips = extraActionChips(rule);
            const hasCategory = rule.actions.category !== undefined;
            return (
              <li key={rule.id} className={`py-3 ${rule.enabled ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{merchant}</span>
                      <span className="text-zinc-400">→</span>
                      {hasCategory ? (
                        <div className="w-44">
                          <Select
                            aria-label={`Category for ${merchant}`}
                            value={rule.actions.category}
                            onChange={e => changeCategory(rule, e.target.value)}
                            options={categoryOptions(rule.actions.category)}
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-500">no category change</span>
                      )}
                    </div>
                    {(chips.length > 0 || actionChips.length > 0) && (
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                        {chips.map(c => (
                          <span key={`c-${c}`} className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                            {c}
                          </span>
                        ))}
                        {actionChips.map(c => (
                          <span key={`a-${c}`} className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-brand/10 text-brand">
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    <Toggle
                      size="sm"
                      checked={rule.enabled}
                      onChange={on => transactionRulesDS.setEnabled(rule.id, on)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => deleteRule(rule)}>Delete</Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Learned merchant names ------------------------------------------------ */}
      <div className="mt-8">
        <h3 className="font-semibold text-sm mb-1">Learned merchant names</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">
          When you rename a transaction’s merchant and apply it to the future, the bank’s raw
          description is mapped to a clean name here.
        </p>
        {learnedAliases.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            No learned names yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {learnedAliases.map(({ alias, name }) => (
              <li key={alias.id} className="py-2.5 flex items-center gap-3">
                <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 truncate">
                    {alias.pattern}
                  </span>
                  <span className="text-zinc-400">→</span>
                  <span className="font-medium text-sm truncate">{name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => renameMerchant(alias.merchant_id, name)}>Rename</Button>
                  <Button variant="ghost" size="sm" onClick={() => deleteAlias(alias.id, name)}>Delete</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
