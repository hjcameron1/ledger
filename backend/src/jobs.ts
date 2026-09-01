/**
 * The scheduled work, as functions — separate from whoever calls them.
 *
 * These bodies used to sit inline inside `cron.schedule(...)` in index.ts,
 * which tied "what the job does" to "what runs the clock". Production's clock
 * is now a Cloudflare Cron Trigger and local dev's is still node-cron, and
 * neither should be able to drift from the other about what a job actually is.
 *
 * Every job is fail-soft in the same way it was before: a step that throws is
 * logged and the rest of the run continues, because a broken dealer site has no
 * business stopping a price refresh.
 */
import { updateAllInvestmentPrices } from './services/priceService';
import { supabase } from './utils/supabase';
import { reapUnverifiedUsers, UNVERIFIED_GRACE_DAYS } from './services/unverifiedReaper';
import { syncDividends } from './services/dividendService';
import { fetchAndStoreDailyRates } from './services/currencyService';
import {
  sendScheduledBriefings, sendScheduledBillReminders, checkTelegramConnections,
} from './services/telegramService';
import { scrapeAllDealers } from './services/metalScraper';
import { snapshotAllUsers } from './services/portfolioSnapshot';
import { snapshotAllNetWorth } from './services/netWorthSnapshot';
import { compactAllNetWorthHistory } from './services/netWorthHistoryRetention';
import { refreshWatchlistPrices } from './routes/investments';

/**
 * Non-crypto holdings refresh hourly, but each holding only actually updates
 * while ITS market is open (see updateAllInvestmentPrices / marketCalendar) —
 * so prices and the FX snapshot freeze at each market's close and resume at its
 * next session. FX rates themselves are refreshed on the same hourly tick.
 */
const NON_CRYPTO_TYPES = ['stock', 'etf', 'precious_metal', 'managed_fund', 'private', 'other'];

/** Hourly: FX, market-aware prices, and the snapshots that depend on them. */
export async function hourlyPricesAndSnapshots(): Promise<void> {
  console.log('[CRON] Hourly FX + market-aware price refresh...');
  await fetchAndStoreDailyRates('AUD');
  await fetchAndStoreDailyRates('USD');
  await fetchAndStoreDailyRates('EUR');
  await fetchAndStoreDailyRates('GBP');
  await updateAllInvestmentPrices(NON_CRYPTO_TYPES);
  // Record a portfolio P&L % snapshot for every holder, now that prices/FX are fresh.
  try {
    const recorded = await snapshotAllUsers();
    console.log(`[CRON] Portfolio P&L snapshot recorded for ${recorded} user(s)`);
  } catch (err) {
    console.error('[CRON] Portfolio P&L snapshot failed:', err);
  }
  try {
    await refreshWatchlistPrices();
    console.log('[CRON] Watchlist prices refreshed + alerts checked');
  } catch (err) {
    console.error('[CRON] Watchlist refresh failed:', err);
  }
  try {
    const recorded = await snapshotAllNetWorth();
    console.log(`[CRON] Net-worth snapshot recorded for ${recorded} user(s)`);
  } catch (err) {
    console.error('[CRON] Net-worth snapshot failed:', err);
  }
  // …and hold the history to its retention policy. Bounded per run and idempotent:
  // once a user's history is compacted this reads two pages and deletes nothing.
  try {
    const dropped = await compactAllNetWorthHistory();
    if (dropped) console.log(`[CRON] Net-worth history compacted: ${dropped} row(s)`);
  } catch (err) {
    console.error('[CRON] Net-worth history compaction failed:', err);
  }
}

/** Crypto trades 24/7 — refresh every 2 hours (not market-gated). */
export async function cryptoPrices(): Promise<void> {
  console.log('[CRON] Updating crypto prices...');
  await updateAllInvestmentPrices(['crypto']);
}

/**
 * Dividend check — twice daily. For every dividend-paying holding, look up
 * dividends paid this financial year (Yahoo) and create PENDING income entries
 * for any newly-seen ones, so the user confirms before they count. Deduped by
 * reference_number, so running twice a day is safe/idempotent.
 */
export async function dividendSync(): Promise<void> {
  console.log('[CRON] Dividend sync (all users)...');
  try {
    const { created, checked } = await syncDividends();
    console.log(`[CRON] Dividend sync done — ${created} new pending entr${created === 1 ? 'y' : 'ies'} across ${checked} holding(s)`);
  } catch (err) {
    console.error('[CRON] Dividend sync failed:', err);
  }
}

/**
 * Precious-metal dealer price scrape, hourly, so dealer buy/buyback prices stay
 * as fresh as everything else. Crawls each supported Australian bullion dealer's
 * catalogue and upserts authentic per-product buy + buyback prices into
 * metal_products, powering the in-depth metal holding form. Scraping is
 * fail-soft per dealer, so a broken site never aborts the run.
 *
 * Deliberately on its own tick rather than sharing the hourly one above: a
 * Worker invocation has a ceiling on how many outbound requests it may make,
 * and a crawl plus a full price refresh in the same invocation would spend that
 * budget on each other.
 */
export async function metalDealerScrape(): Promise<void> {
  console.log('[CRON] Metal dealer price scrape...');
  try {
    const results = await scrapeAllDealers();
    for (const r of results) {
      console.log(`[CRON] ${r.dealer}: ${r.upserted} products${r.error ? ` (error: ${r.error})` : ''}`);
    }
  } catch (err) {
    console.error('[CRON] Metal dealer scrape failed:', err);
  }
}

/**
 * The Telegram connection, checked over and over rather than on the day someone
 * pressed a button. Is the token still good, is Telegram still delivering to
 * us, do we know a chat — and re-register a webhook that has gone astray. Reads
 * only; it never sends a message to prove a point. The result is recorded per
 * user and shown on the Telegram screen.
 */
export async function telegramConnectionCheck(): Promise<void> {
  try { await checkTelegramConnections(); }
  catch (err) { console.error('[CRON] checkTelegramConnections failed:', err); }
}

/** Morning briefings and bill reminders — every minute, for whoever's time has come. */
export async function minuteDeliveries(): Promise<void> {
  try { await sendScheduledBriefings(); }
  catch (err) { console.error('[CRON] sendScheduledBriefings failed:', err); }
  try { await sendScheduledBillReminders(); }
  catch (err) { console.error('[CRON] sendScheduledBillReminders failed:', err); }
}

/**
 * Reap abandoned unverified signups once a day. An account that was never
 * verified can never be logged into and owns no data (a JWT is only issued
 * after verification), so deleting rows older than the grace window just frees
 * the email address and stops orphan rows accumulating. Fail-soft + idempotent.
 */
export async function reapUnverified(): Promise<void> {
  try {
    const reaped = await reapUnverifiedUsers(supabase, UNVERIFIED_GRACE_DAYS);
    if (reaped) console.log(`[CRON] Reaped ${reaped} abandoned unverified signup(s)`);
  } catch (err) {
    console.error('[CRON] Unverified reaper failed:', err);
  }
}
