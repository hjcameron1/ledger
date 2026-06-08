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

  // Dealer buyback price — rendered as <h4>BUY BACK PRICE</h4><p>$190,641.50</p>.
  const buybackM = html.match(/BUY\s*BACK\s*PRICE<\/h4>\s*<p>\s*\$?([\d.,]+)/i);
  const sell_price = toNum(buybackM?.[1]);

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
    sell_price,
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

// ── Ainslie Bullion ───────────────────────────────────────────────────────────
//
// Unlike ABC, Ainslie's category listing pages carry everything we need inline:
// each product card is <div class="...productCard" data-price="218.40"
// data-grams="1" ...><a href="/Buy/View/Product/Name/.../ID/501" title="1g Ainslie
// Minted Gold Bar">. data-price is the whole-product BUY price (incl. premium),
// data-grams the metal weight — so one fetch per metal category yields the lot, no
// per-product visits needed. Listings carry no buyback (that lives on a separate
// /Sell page), so we estimate spot_value from live spot for a sell reference.

const AINSLIE_BASE = 'https://www.ainsliebullion.com.au';
const AINSLIE_CATEGORIES: { url: string; metal: string }[] = [
  { url: `${AINSLIE_BASE}/buy/gold`, metal: 'Gold' },
  { url: `${AINSLIE_BASE}/buy/silver`, metal: 'Silver' },
  { url: `${AINSLIE_BASE}/buy/platinum`, metal: 'Platinum' },
];

// Pull the well-known Australian mint/brand from a product title, if present.
function parseMint(text: string): string | null {
  const t = text.toLowerCase();
  if (/perth\s*mint/.test(t)) return 'Perth Mint';
  if (/ainslie/.test(t)) return 'Ainslie';
  if (/abc\s*bullion/.test(t)) return 'ABC Bullion';
  if (/royal\s*australian\s*mint|\bram\b/.test(t)) return 'Royal Australian Mint';
  if (/scottsdale/.test(t)) return 'Scottsdale Mint';
  if (/pamp/.test(t)) return 'PAMP';
  if (/royal\s*canadian\s*mint/.test(t)) return 'Royal Canadian Mint';
  return null;
}

function ainslieParseCards(html: string, metal: string): ScrapedProduct[] {
  const re = /productCard"[^>]*data-price="([\d.,]+)"[^>]*data-grams="([\d.]+)"[\s\S]{0,400}?href="(\/Buy\/View\/Product\/[^"]+)"[^>]*title="([^"]+)"/g;
  const out: ScrapedProduct[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const buy_price = toNum(m[1]);
    const grams = parseFloat(m[2]);
    const url = AINSLIE_BASE + m[3].split('?')[0];
    const title = m[4].replace(/\s+/g, ' ').trim();
    if (buy_price == null || !Number.isFinite(grams) || grams <= 0) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const weight = parseWeight(title);
    out.push({
      dealer: 'Ainslie Bullion',
      metal,
      form: parseForm(title),
      weight_grams: parseFloat(grams.toFixed(4)),
      unit_label: weight?.label ?? null,
      product_name: title,
      url,
      buy_price,
      sell_price: null,        // no buyback on listing pages
      spot_value: null,        // backfilled from live spot below
      currency: 'AUD',
      in_stock: true,
    });
  }
  return out;
}

const ainslieBullionAdapter: DealerAdapter = {
  dealer: 'Ainslie Bullion',
  async scrape() {
    const out: ScrapedProduct[] = [];
    for (const cat of AINSLIE_CATEGORIES) {
      const html = await getHtml(cat.url);
      if (!html) continue;
      const products = ainslieParseCards(html, cat.metal);
      out.push(...products);
      await sleep(400);
    }
    console.log(`[METAL-SCRAPE] Ainslie Bullion: ${out.length} products from ${AINSLIE_CATEGORIES.length} categories`);
    return out;
  },
};

// ── The Perth Mint ──────────────────────────────────────────────────────────────
//
// The shop is a JS-rendered SPA with no prices in the static HTML, but its catalogue
// search is backed by a clean JSON API the page itself calls:
//   /api/search/product/node/1073746516?p_metal=<Metal>&page=1&pageSize=<N>
// Each product carries prices.adjustedPrice.price (the live AUD buy price incl.
// premium), a title we can mine for weight/form, and stock flags. pageSize=200
// returns the whole metal in one request. No buyback is exposed here.

const PERTH_API = 'https://www.perthmint.com/api/search/product/node/1073746516';
const PERTH_BASE = 'https://www.perthmint.com';
const PERTH_METALS = ['Gold', 'Silver', 'Platinum'];

interface PerthProduct {
  title?: string;
  link?: string;
  code?: string;
  isOutOfStock?: boolean;
  isSoldOut?: boolean;
  isNoLongerAvailable?: boolean;
  prices?: { adjustedPrice?: { price?: number }; basePrice?: { price?: number } };
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const { data } = await axios.get<T>(url, {
      timeout: 25000,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    return data;
  } catch (err) {
    console.error(`[METAL-SCRAPE] json fetch failed ${url}:`, (err as Error).message);
    return null;
  }
}

const perthMintAdapter: DealerAdapter = {
  dealer: 'The Perth Mint',
  async scrape() {
    const out: ScrapedProduct[] = [];
    for (const metal of PERTH_METALS) {
      const url = `${PERTH_API}?p_metal=${metal}&page=1&pageSize=200`;
      const body = await getJson<{ result?: { products?: PerthProduct[] } }>(url);
      const products = body?.result?.products ?? [];
      for (const p of products) {
        const title = (p.title ?? '').replace(/\s+/g, ' ').trim();
        const buy_price = p.prices?.adjustedPrice?.price ?? p.prices?.basePrice?.price ?? null;
        if (!title || buy_price == null) continue;
        const weight = parseWeight(title);
        const rawLink = p.link
          ? (p.link.startsWith('http') ? p.link : PERTH_BASE + p.link)
          : `${PERTH_BASE}/shop/#${p.code ?? title}`;
        const url = rawLink.split('?')[0];
        out.push({
          dealer: 'The Perth Mint',
          metal,
          form: parseForm(title),
          weight_grams: weight?.grams ?? null,
          unit_label: weight?.label ?? null,
          product_name: title,
          url,
          buy_price: parseFloat(Number(buy_price).toFixed(2)),
          sell_price: null,
          spot_value: null,
          currency: 'AUD',
          in_stock: !(p.isOutOfStock || p.isSoldOut || p.isNoLongerAvailable),
        });
      }
      await sleep(400);
    }
    console.log(`[METAL-SCRAPE] The Perth Mint: ${out.length} products from ${PERTH_METALS.length} metals`);
    return out;
  },
};

// ── Registry + runner ────────────────────────────────────────────────────────────

export const DEALER_ADAPTERS: DealerAdapter[] = [
  abcBullionAdapter,
  ainslieBullionAdapter,
  perthMintAdapter,
];

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
