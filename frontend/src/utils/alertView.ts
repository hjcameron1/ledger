/**
 * How a Phase 4.4 alert READS — the sentence under its heading.
 *
 * The engine (utils/alerts.ts) decided WHICH figures may be quoted; this decides
 * how they read in the user's currency and date format. Same split as
 * `describeInsight` in insightView.ts and `GoalMessage` in goalView.ts —
 * currency formatting never crosses into a pure engine, and wording never
 * crosses into a component.
 *
 * It lives in utils rather than beside a card because there are three surfaces
 * onto the same sentence now (the Overview list, the notification bell, and any
 * test that pins the wording), and they must all say the same thing.
 */

import { formatCurrency, formatDate } from './format';
import type { AlertFacts } from './alerts';

export function describeAlert(facts: AlertFacts, currency: string): string {
  const money = (n: number) => formatCurrency(n, currency);

  switch (facts.kind) {
    case 'budget-limit':
      return facts.over > 0
        ? `${money(facts.spent)} spent against a ${money(facts.limit)} cap — ${money(facts.over)} over.`
        : `${money(facts.spent)} of ${money(facts.limit)} used, ${money(facts.remaining)} left.`;

    case 'budget-projected-over':
      return `${money(facts.spent)} of ${money(facts.limit)} so far, heading for ${money(facts.projected)} `
        + `by month end — ${money(facts.by)} over.`;

    case 'goal-behind':
      if (facts.daysPast > 0) {
        return `${money(facts.remaining)} short, ${facts.daysPast} day${facts.daysPast === 1 ? '' : 's'} past the target date.`;
      }
      return facts.allocatedPerMonth > 0
        ? `Needs ${money(facts.requiredPerMonth)}/mo but only ${money(facts.allocatedPerMonth)}/mo is spare `
          + `— ${money(facts.shortfallPerMonth)}/mo short.`
        : `Needs ${money(facts.requiredPerMonth)}/mo and your forecast frees up nothing for it.`;

    case 'cash-low':
      return facts.lowest < 0
        ? `Projected to reach ${money(facts.lowest)} on ${formatDate(facts.lowestDate)}.`
        : `Projected to dip to ${money(facts.lowest)} on ${formatDate(facts.lowestDate)}, `
          + `under the ${money(facts.buffer)} buffer for your usual outgoings.`;

    case 'unusual-spend':
      return `Heading for ${money(facts.projected)} this month against a usual ${money(facts.baseline)} `
        + `— about ${facts.multiple.toFixed(1)}× normal.`;

    case 'insurance-renewal': {
      const who = facts.insurer ? ` with ${facts.insurer}` : '';
      const cost = `${money(facts.annualPremium)} a year`;
      if (facts.expired) {
        const late = Math.abs(facts.daysToRenewal);
        return `Cover${who} ran out on ${formatDate(facts.renewalDate)}, ${late} day${late === 1 ? '' : 's'} ago `
          + `— renew it, or mark it as no longer held.`;
      }
      const days = facts.daysToRenewal;
      const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
      return `Renews ${when} (${formatDate(facts.renewalDate)})${who} at ${cost}.`;
    }
  }
}
