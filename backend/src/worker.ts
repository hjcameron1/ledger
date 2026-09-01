/**
 * Production entry point: the same API, hosted by a Cloudflare Worker.
 *
 * Two handlers:
 *
 *   fetch     — every request, through the very same Express app as local dev
 *               (`app.ts`). Express is a Node HTTP server, so it is started on a
 *               loopback port inside the isolate and `httpServerHandler` hands
 *               requests to it. No route had to change.
 *
 *   scheduled — the clock. This was node-cron inside a process that had to stay
 *               alive forever, kept awake by pinging itself every ten minutes so
 *               the host would not sleep through a price refresh. Cloudflare
 *               owns the schedule now; there is no process whose death takes it
 *               with it, and the keepalive is gone because there is nothing left
 *               to keep alive.
 *
 * The cron expressions live in wrangler.toml and are matched literally below,
 * so the two must be kept in step. Each expression gets its own invocation,
 * which is also why the hourly price refresh and the dealer scrape were split
 * onto separate ticks: an invocation has a ceiling on outbound requests, and
 * sharing one would have them spending that budget on each other.
 */
import { httpServerHandler } from 'cloudflare:node';
import { createServer } from 'node:http';
import { createApp } from './app';
import {
  hourlyPricesAndSnapshots, cryptoPrices, dividendSync, metalDealerScrape,
  telegramConnectionCheck, minuteDeliveries, reapUnverified,
} from './jobs';

const PORT = 8787;

/**
 * The Express app is built on the first request, not when this module loads.
 *
 * A Worker's global scope may not start timers, and building the app starts
 * one: express-rate-limit's store sweeps expired counters on an interval. So
 * the server is stood up inside the handler, once per isolate, and every later
 * request in that isolate reuses it.
 */
let listening = false;
function ensureServer(): void {
  if (listening) return;
  listening = true;
  createServer(createApp()).listen(PORT);
}

/** Which job each cron expression means. Keys must match wrangler.toml exactly. */
const SCHEDULE: Record<string, () => Promise<void>> = {
  '* * * * *': minuteDeliveries,
  '0 * * * *': hourlyPricesAndSnapshots,
  '5 * * * *': metalDealerScrape,
  '0 */2 * * *': cryptoPrices,
  '0 7,19 * * *': dividendSync,
  '*/15 * * * *': telegramConnectionCheck,
  '0 3 * * *': reapUnverified,
};

interface ScheduledEvent { cron: string }
interface Ctx { waitUntil(p: Promise<unknown>): void }

const http = httpServerHandler({ port: PORT });

export default {
  async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
    ensureServer();
    return http.fetch(request, env, ctx);
  },

  async scheduled(event: ScheduledEvent, _env: unknown, ctx: Ctx): Promise<void> {
    const job = SCHEDULE[event.cron];
    if (!job) {
      // A trigger with nothing behind it is a wrangler.toml that has moved on
      // without this file, and saying so is better than a silent no-op.
      console.error(`[CRON] no job registered for "${event.cron}"`);
      return;
    }
    ctx.waitUntil(job().catch((err) => console.error(`[CRON] ${event.cron} failed:`, err)));
  },
};
