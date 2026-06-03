/**
 * ════════════════════════════════════════════════════════════
 *  CLOUDFLARE WORKER — Gold Price Proxy + Cron Upsert
 *
 *  HƯỚNG DẪN DEPLOY:
 *  1. Vào https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Xóa code mẫu, paste toàn bộ file này vào
 *  3. Nhấn "Deploy"
 *  4. Vào Settings → Triggers → Cron Triggers → Add:
 *       0 2,5,8,11,14 * * *   (chạy lúc 9h, 12h, 15h, 18h, 21h giờ VN)
 *  5. Copy URL worker → dán vào index.html tại PROXY_URL
 *
 *  LƯU Ý QUAN TRỌNG (BẢO MẬT):
 *  - KHÔNG hardcode SUPABASE_URL / SUPABASE_KEY trong file này.
 *    Cấu hình hai biến môi trường (env bindings) trên Cloudflare Worker:
 *      Workers & Pages → worker → Settings → Variables → Add variable
 *        • SUPABASE_URL  = https://<project>.supabase.co
 *        • SUPABASE_KEY  = <anon hoặc service_role key>
 *      (đánh dấu "Encrypt" cho SUPABASE_KEY để mã hóa khi lưu)
 *  - Mỗi ngày mỗi brand chỉ có đúng 1 dòng (upsert theo recorded_at + brand)
 *  - Cron chạy ngay cả khi không ai mở app
 *  - Cron chỉ upsert khi giá thực sự thay đổi so với lần ghi trước
 * ════════════════════════════════════════════════════════════
 */

// ── CONFIG — nạp từ Cloudflare Worker env bindings (KHÔNG hardcode) ──
let SUPABASE_URL = '';
let SUPABASE_KEY = '';
let SB_HEADERS = null;
function initSecrets(env) {
  if (SUPABASE_URL && SUPABASE_KEY && SB_HEADERS) return;
  SUPABASE_URL = (env && env.SUPABASE_URL) || '';
  SUPABASE_KEY = (env && env.SUPABASE_KEY) || '';
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_KEY env bindings — configure in Workers Settings → Variables');
  }
  SB_HEADERS = {
    'Content-Type':  'application/json',
    'apikey':        SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
  };
}
// ─────────────────────────────────────────────────────────────

const SOURCES = [
  { key: 'SJC',     url: 'https://giavang.org/trong-nuoc/sjc/' },
  { key: 'DOJI',    url: 'https://giavang.org/trong-nuoc/doji/' },
  { key: 'BTMH',    url: 'https://giavang.org/trong-nuoc/bao-tin-manh-hai/' },
  { key: 'Mi Hồng', url: 'https://giavang.org/trong-nuoc/mi-hong/' },
];

const BRAND_ROW_LIMIT = { 'SJC': 6, 'DOJI': 3, 'BTMH': 0, 'Mi Hồng': 2 };

// ── FETCH HTML ────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':          'text/html,application/xhtml+xml',
      'Accept-Language': 'vi-VN,vi;q=0.9',
    },
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── PARSE HELPERS ─────────────────────────────────────────────
function toNum(str) {
  return parseInt(String(str || '').replace(/\./g, '').replace(/,/g, '')) || 0;
}
function toVND(n) { return n * 100; }
function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseRows(html, brand) {
  const rows  = [];
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const body  = tbody ? tbody[1] : html;
  const parts = body.split(/<tr[\s>]/i);
  const isSJC = brand === 'SJC' || brand === 'DOJI';

  for (let i = 1; i < parts.length; i++) {
    const tr    = parts[i].split(/<\/tr>/i)[0];
    const cells = [...tr.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
    if (cells.length < 3) continue;
    const cols = cells.map(c => stripTags(c[1]));
    let name, buy, sell;
    if (isSJC) {
      if (cells.length >= 4) { name = cols[1]; buy = toNum(cols[2]); sell = toNum(cols[3]); }
      else                   { name = cols[0]; buy = toNum(cols[1]); sell = toNum(cols[2]); }
    } else {
      name = cols[0]; buy = toNum(cols[1]); sell = toNum(cols[2]);
    }
    if (!name || buy === 0) continue;
    rows.push({ name, buy: toVND(buy), sell: toVND(sell) });
  }
  return rows;
}

function parsePrices(html, brand) {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const items     = parseRows(clean, brand);
  const limit     = BRAND_ROW_LIMIT[brand];
  const liveItems = limit ? items.slice(0, limit) : items;
  let finalItems  = liveItems;

  // ── BTMH: chỉ lấy đúng 2 dòng ──────────────────────────────
  if (brand === 'BTMH') {
    const normalize = s =>
      s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    let kimGiaBao = null;
    let kimCat    = null;

    for (const it of liveItems) {
      const name = normalize(it.name);
      if (!kimGiaBao && name.includes('kim gia bao')) {
        kimGiaBao = { ...it, name: 'Đồng vàng Kim Gia Bảo Hoa Sen' };
      }
      if (!kimCat && name.includes('kim cat')) {
        kimCat = { ...it, name: 'Tiểu Kim Cát - 0,3 chỉ' };
      }
      if (kimGiaBao && kimCat) break;
    }

    finalItems = [];
    if (kimGiaBao) finalItems.push(kimGiaBao);
    if (kimCat)    finalItems.push(kimCat);
  }

  // ── DOJI: chỉ lấy dòng Nhẫn tròn 999 ───────────────────────
  if (brand === 'DOJI') {
    const nhans = finalItems.filter(it =>
      it.name.toLowerCase().includes('nhẫn tròn 999') ||
      it.name.toLowerCase().includes('nhan tron 999')
    );
    const dojiItems = nhans.length > 0
      ? [{ ...nhans[0], name: 'Nhẫn tròn 999 Hưng Thịnh Vượng' }]
      : finalItems.slice(0, 1);
    return { buy: dojiItems[0]?.buy || 0, sell: dojiItems[0]?.sell || 0, items: dojiItems };
  }

  // ── Mi Hồng: chỉ lấy dòng Vàng 99,9% ───────────────────────
  if (brand === 'Mi Hồng') {
    const vang999 = finalItems.find(it =>
      it.name.includes('99,9%') || it.name.includes('99.9%')
    );
    const mhItems = vang999
      ? [{ ...vang999, name: 'Vàng 99,9%' }]
      : finalItems.slice(0, 1);
    return { buy: mhItems[0]?.buy || 0, sell: mhItems[0]?.sell || 0, items: mhItems };
  }

  return { buy: finalItems[0]?.buy || 0, sell: finalItems[0]?.sell || 0, items: finalItems };
}

// ── IN-MEMORY CACHE (dùng cho HTTP requests) ──────────────────
let cache     = null;
let cacheTime = 0;
const TTL     = 5 * 60 * 1000; // 5 phút

async function getPrices(force = false) {
  if (!force && cache && Date.now() - cacheTime < TTL) return cache;

  const results = {};
  for (const src of SOURCES) {
    try {
      const html       = await fetchPage(src.url);
      results[src.key] = parsePrices(html, src.key);
    } catch (e) {
      results[src.key] = { buy: 0, sell: 0, items: [] };
    }
  }
  cache     = results;
  cacheTime = Date.now();
  return results;
}

// ── SUPABASE HELPERS ──────────────────────────────────────────
// (SB_HEADERS được khởi tạo runtime bởi initSecrets(env) ở trên)

/**
 * Lấy giá đang lưu trong DB cho ngày hôm nay.
 * Trả về map: { SJC: {buy, sell}, DOJI: {buy, sell}, ... }
 */
async function fetchTodayPrices(today) {
  const url = `${SUPABASE_URL}/rest/v1/gold_price_history`
    + `?recorded_at=eq.${today}&select=brand,buy,sell`;

  const res = await fetch(url, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`Supabase fetch thất bại: ${await res.text()}`);

  const rows = await res.json();
  const map  = {};
  rows.forEach(r => { map[r.brand] = { buy: r.buy, sell: r.sell }; });
  return map;
}

/**
 * Thực hiện upsert các dòng vào gold_price_history.
 * Prefer: resolution=merge-duplicates → UPDATE nếu (recorded_at, brand) đã tồn tại.
 *
 * Lưu ý: bảng cần có unique constraint (chạy 1 lần trong Supabase SQL Editor):
 *   ALTER TABLE gold_price_history
 *     ADD CONSTRAINT gold_price_history_recorded_at_brand_key
 *     UNIQUE (recorded_at, brand);
 */
async function doUpsert(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/gold_price_history`, {
    method:  'POST',
    headers: { ...SB_HEADERS, 'Prefer': 'resolution=merge-duplicates' },
    body:    JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase upsert thất bại: ${await res.text()}`);
}

/**
 * So sánh giá mới với giá đang có trong DB hôm nay.
 * Chỉ upsert những brand nào:
 *   - Chưa có dữ liệu hôm nay (dòng mới), hoặc
 *   - Có buy hoặc sell thay đổi so với lần ghi trước
 * → Đảm bảo mỗi ngày mỗi brand vẫn chỉ có đúng 1 dòng.
 */
async function upsertIfChanged(prices) {
  // Lấy ngày theo giờ Việt Nam (UTC+7)
  const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const today = nowVN.toISOString().split('T')[0]; // "2026-05-31"

  // Lấy giá đang có trong DB hôm nay để so sánh
  const existing = await fetchTodayPrices(today);

  const toUpsert = [];
  const skipped  = [];

  for (const [brand, p] of Object.entries(prices)) {
    if (!p.buy) continue; // bỏ qua nếu scrape lỗi trả về 0

    const prev = existing[brand];

    if (!prev) {
      // Chưa có dữ liệu hôm nay → ghi mới
      toUpsert.push({ recorded_at: today, brand, buy: p.buy, sell: p.sell });
    } else if (prev.buy !== p.buy || prev.sell !== p.sell) {
      // Giá thay đổi → ghi đè
      toUpsert.push({ recorded_at: today, brand, buy: p.buy, sell: p.sell });
    } else {
      // Giá không đổi → bỏ qua
      skipped.push(brand);
    }
  }

  if (skipped.length) {
    console.log(`[cron] Giá không đổi, bỏ qua: ${skipped.join(', ')}`);
  }

  if (!toUpsert.length) {
    console.log('[cron] Tất cả brand đều không có thay đổi giá, không upsert.');
    return { upserted: 0, date: today, brands: [] };
  }

  await doUpsert(toUpsert);
  return { upserted: toUpsert.length, date: today, brands: toUpsert.map(r => r.brand) };
}

// ── CORS HEADERS ──────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age':       '86400',
};

// ── WORKER HANDLER ────────────────────────────────────────────
export default {

  // ── HTTP: phục vụ frontend lấy giá realtime ────────────────
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      initSecrets(env);
      const url    = new URL(request.url);
      const force  = url.searchParams.get('refresh') === '1';
      const prices = await getPrices(force);
      return new Response(JSON.stringify(prices), {
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': 'no-store',
          ...CORS,
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status:  500,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },

  // ── CRON: tự động chạy theo lịch, không cần mở app ────────
  //
  //  Cấu hình tại: Workers & Pages → worker → Settings → Triggers → Cron Triggers
  //
  //  Thêm cron expression (UTC, giờ VN = UTC+7):
  //    0 2,5,8,11,14 * * *
  //    → Chạy vào lúc 9h, 12h, 15h, 18h, 21h giờ Việt Nam mỗi ngày
  //
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        initSecrets(env);
        console.log('[cron] Bắt đầu fetch giá...', new Date().toISOString());

        // Force refresh — bỏ qua in-memory cache để lấy giá mới nhất từ nguồn
        const prices      = await getPrices(true);
        const validBrands = Object.entries(prices)
          .filter(([_, p]) => p.buy > 0)
          .map(([k]) => k);

        console.log(`[cron] Scraped OK: ${validBrands.join(', ')}`);

        // Chỉ upsert khi giá thay đổi so với dữ liệu đang có hôm nay
        const result = await upsertIfChanged(prices);

        if (result.upserted > 0) {
          console.log(
            `[cron] Upsert ${result.upserted} brand có giá thay đổi: ${result.brands.join(', ')}`,
            `(ngày ${result.date})`
          );
        }
      } catch (e) {
        // Không throw — chỉ log, tránh Cloudflare retry liên tục
        console.error('[cron] Lỗi:', e.message);
      }
    })());
  },
};
