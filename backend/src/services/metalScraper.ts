import axios from 'axios';
import { supabase } from '../utils/supabase';

// ─── Authentic dealer-product price scraping ────────────────────────────────────
//
// Each adapter crawls one Australian bullion dealer and returns a flat list of
// products with their live BUY price (incl. the dealer's premium over spot) and,
// where available, the metal's pure spot value. The runner upserts them into
// metal_products so the in-depth metal holding form can pick a real product.
//
// Scraping is inherently fragile: when a dealer changes its markup the adapter
// may return nothing. Adapters therefore fail soft (log + return []), never throw,
// so one broken dealer can't abort the whole run.

const TROY_OZ_IN_GRAM = 31.1034768;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export interface ScrapedProduct {
  dealer: string;
  metal: string;            // Gold | Silver | Platinum | Palladium
  form: string | null;      // minted_bar | cast_bar | coin | round | bullion
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

export interface DealerAdapter {
  dealer: string;
  scrape: () => Promise<ScrapedProduct[]>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getHtml(url: string): Promise<string | null> {
  try {
    const { data } = await axios.get<string>(url, {
      timeout: 25000,
      responseType: 'text',
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    });
    return data;
  } catch (err) {
    console.error(`[METAL-SCRAPE] fetch failed ${url}:`, (err as Error).message);
    return null;
  }
}

// ── Shared parsing helpers ──────────────────────────────────────────────────────

/** Parse "50gram", "1/2oz", "1 kg" → grams. Returns { grams, label } or null. */
function parseWeight(text: string): { grams: number; label: string } | null {
  const m = text.match(/(\d+(?:\.\d+)?(?:\/\d+)?)\s*(grams?|g|troy\s*oz|oz|ounces?|kg|kilo(?:gram)?s?)\b/i);
  if (!m) return null;
  let qty: number;
  if (m[1].includes('/')) {
    const [a, b] = m[1].split('/').map(Number);
    qty = b ? a / b : NaN;
  } else {
    qty = parseFloat(m[1]);
  }
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const unit = m[2].toLowerCase();
  const grams =
    /kg|kilo/.test(unit) ? qty * 1000 :
    /oz|ounce/.test(unit) ? qty * TROY_OZ_IN_GRAM :
    qty; // grams
  return { grams: parseFloat(grams.toFixed(4)), label: m[0].replace(/\s+/g, '') };
}

function parseForm(text: string): string | null {
  const t = text.toLowerCase();
  if (/cast\s*bar/.test(t)) return 'cast_bar';
  if (/minted|tablet/.test(t)) return 'minted_bar';
  if (/\bbar\b|ingot/.test(t)) return 'minted_bar';
  if (/\bcoin\b/.test(t)) return 'coin';
  if (/\bround\b/.test(t)) return 'round';
  return 'bullion';
}

function parseMetal(text: string): string | null {
  const t = text.toLowerCase();
  if (/palladium/.test(t)) return 'Palladium';
  if (/platinum/.test(t)) return 'Platinum';
  if (/silver/.test(t)) return 'Silver';
  if (/gold/.test(t)) return 'Gold';
  return null;
}

const toNum = (s: string | undefined | null): number | null => {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[,$\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── ABC Bullion ─────────────────────────────────────────────────────────────────
//
// Catalogue lives under /store/<category>; each product page embeds a
// JSON.parse('{"1":{...,"price":"10,349.30","spot_price_weight":9941.84,...}}')
// quantity-tier block. Tier "1".price is the single-unit buy price.

const ABC_BASE = 'https://www.abcbullion.com.au';
const ABC_CATEGORIES = [`${ABC_BASE}/store/gold`, `${ABC_BASE}/store/silver`, `${ABC_BASE}/store/platinum`];

function abcProductLinks(html: string): string[] {
  // The same product is linked under several paths (/store/X and /store/gold/X);
  // canonicalise to /store/<final-slug> and dedupe so we store one row per product.
  const canonical = new Set<string>();
  const re = /href="((?:https:\/\/www\.abcbullion\.com\.au)?\/store\/[A-Za-z0-9/_-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let href = m[1];
    if (!href.startsWith('http')) href = ABC_BASE + href;
    const path = href.split('?')[0].split('/store/')[1] ?? '';
    const finalSlug = path.split('/').filter(Boolean).pop() ?? '';
    // Product slugs carry both a weight token and a form/metal word; category
    // and subcategory links (e.g. /store/Bullion-Coins) do not.
    if (/\d+\s*(gram|g|oz|ounce|kg)/i.test(finalSlug) && /(bar|coin|tablet|cast|minted|ingot|round)/i.test(finalSlug)) {
      canonical.add(`${ABC_BASE}/store/${finalSlug}`);
    }
  }
  return [...canonical];
}

function abcParseProduct(url: string, html: string): ScrapedProduct | null {
  const titleM = html.match(/<title>([^<]+)<\/title>/i);
  const title = (titleM?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const slug = url.split('/store/')[1] ?? '';
  const haystack = `${title} ${slug}`;

  const metal = parseMetal(haystack);
  if (!metal) return null;
  const weight = parseWeight(title) ?? parseWeight(slug);
  const form = parseForm(haystack);

  // First quantity-tier pricing block.
  const jsonM = html.match(/JSON\.parse\('(\{"1":\{.*?\})'\)/s);
  let buy_price: number | null = null;
  let spot_value: number | null = null;
  if (jsonM) {
    const priceM = jsonM[1].match(/"1":\{[^}]*?"price":"([\d.,]+)"/);
    const spotM = jsonM[1].match(/"spot_price_weight":([\d.]+)/);
    buy_price = toNum(priceM?.[1]);
    spot_value = spotM ? parseFloat(parseFloat(spotM[1]).toFixed(2)) : null;
  }
  if (buy_price == null) return null;

  const in_stock = !/out of stock|sold out|currently unavailable/i.test(html);

  return {
    dealer: 'ABC Bullion',
    metal,
    form,
    weight_grams: weight?.grams ?? null,
    unit_label: weight?.label ?? null,
    product_name: title || slug,
    url,
    buy_price,
    sell_price: null,           // buyback prices live on a separate page — future
    spot_value,
    currency: 'AUD',
    in_stock,
  };
}

const abcBullionAdapter: DealerAdapter = {
  dealer: 'ABC Bullion',
  async scrape() {
    const productUrls = new Set<string>();
    for (const cat of ABC_CATEGORIES) {
      const html = await getHtml(cat);
      if (!html) continue;
      for (const link of abcProductLinks(html)) productUrls.add(link);
      await sleep(400);
    }

    const out: ScrapedProduct[] = [];
    // Cap to keep the cron bounded and the dealer un-hammered (override via env).
    const cap = Number(process.env.METAL_SCRAPE_CAP) || 120;
    const urls = [...productUrls].slice(0, cap);
    for (const url of urls) {
      const html = await getHtml(url);
      if (!html) continue;
      const product = abcParseProduct(url, html);
      if (product) out.push(product);
      await sleep(350);
    }
    console.log(`[METAL-SCRAPE] ABC Bullion: ${out.length} products from ${urls.length} pages`);
    return out;
  },
};

// ── Registry + runner ────────────────────────────────────────────────────────────

export const DEALER_ADAPTERS: DealerAdapter[] = [abcBullionAdapter];

export interface MetalScrapeResult {
  dealer: string;
  scraped: number;
  upserted: number;
  error?: string;
}

/**
 * Run every dealer adapter and upsert results into metal_products. Safe to run on
 * a schedule — upsert is keyed on (dealer, url) so existing rows refresh in place.
 */
export async function scrapeAllDealers(): Promise<MetalScrapeResult[]> {
  const results: MetalScrapeResult[] = [];
  for (const adapter of DEALER_ADAPTERS) {
    try {
      const products = await adapter.scrape();
      let upserted = 0;
      if (products.length > 0) {
        const rows = products.map(p => ({ ...p, scraped_at: new Date().toISOString() }));
        const { error } = await supabase
          .from('metal_products')
          .upsert(rows, { onConflict: 'dealer,url' });
        if (error) throw new Error(error.message);
        upserted = rows.length;
      }
      results.push({ dealer: adapter.dealer, scraped: products.length, upserted });
    } catch (err) {
      console.error(`[METAL-SCRAPE] ${adapter.dealer} failed:`, err);
      results.push({ dealer: adapter.dealer, scraped: 0, upserted: 0, error: (err as Error).message });
    }
  }
  return results;
}
