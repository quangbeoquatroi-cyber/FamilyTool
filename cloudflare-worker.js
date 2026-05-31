/**
 * ════════════════════════════════════════════════════════════
 *  CLOUDFLARE WORKER — Gold Price Proxy
 *  Thay thế Netlify Function, dùng cho GitHub Pages
 *
 *  HƯỚNG DẪN DEPLOY (làm 1 lần duy nhất, miễn phí):
 *  1. Vào https://dash.cloudflare.com → đăng ký tài khoản miễn phí
 *  2. Vào "Workers & Pages" → "Create" → "Create Worker"
 *  3. Xóa code mẫu, paste toàn bộ nội dung file này vào
 *  4. Nhấn "Deploy"
 *  5. Copy URL worker (vd: https://gold-proxy.ten-ban.workers.dev)
 *  6. Mở index.html, tìm dòng:
 *       const WORKER_URL = 'https://YOUR-WORKER.workers.dev/prices';
 *     Thay YOUR-WORKER bằng URL thật của bạn
 * ════════════════════════════════════════════════════════════
 */

const SOURCES = [
  { key: 'SJC',     url: 'https://giavang.org/trong-nuoc/sjc/' },
  { key: 'DOJI',    url: 'https://giavang.org/trong-nuoc/doji/' },
  { key: 'BTMH',    url: 'https://giavang.org/trong-nuoc/bao-tin-manh-hai/' },
  { key: 'Mi Hồng', url: 'https://giavang.org/trong-nuoc/mi-hong/' },
];

const BRAND_ROW_LIMIT = { 'SJC': 6, 'DOJI': 3, 'BTMH': 0, 'Mi Hồng': 2 };

const BTMH_FIXED_TOP = [
  { name: 'Đồng vàng Kim Gia Bảo Hoa Sen', buy: 163000 * 100, sell: 165900 * 100 },
  { name: 'Tiểu Kim Cát - 0,3 chỉ',        buy: 16300  * 100, sell: 16590  * 100 },
];

// ── FETCH ─────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'vi-VN,vi;q=0.9',
    },
    cf: { cacheTtl: 60, cacheEverything: false },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ── PARSE ─────────────────────────────────────────────────────
function toNum(str) {
  return parseInt(String(str || '').replace(/\./g, '').replace(/,/g, '')) || 0;
}
function toVND(n) { return n * 100; }
function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseRows(html, brand) {
  const rows = [];
  const tbody = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const body = tbody ? tbody[1] : html;
  const parts = body.split(/<tr[\s>]/i);
  const isSJC = brand === 'SJC' || brand === 'DOJI'; // cả 2 dùng 4 cột

  for (let i = 1; i < parts.length; i++) {
    const tr = parts[i].split(/<\/tr>/i)[0];
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
  const items = parseRows(clean, brand);
  const limit = BRAND_ROW_LIMIT[brand];
  const liveItems = limit ? items.slice(0, limit) : items;
  let finalItems = liveItems;

// ── BTMH: chỉ lấy đúng 2 dòng ──
if (brand === 'BTMH') {
  const normalize = s =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let kimGiaBao = null;
  let kimCat = null;

  for (const it of liveItems) {
    const name = normalize(it.name);

    // Ưu tiên match chính xác hơn
    if (!kimGiaBao && name.includes('kim gia bao')) {
      kimGiaBao = {
        ...it,
        name: 'Đồng vàng Kim Gia Bảo Hoa Sen'
      };
    }

    if (!kimCat && name.includes('kim cat')) {
      kimCat = {
        ...it,
        name: 'Tiểu Kim Cát - 0,3 chỉ'
      };
    }

    // Nếu đã đủ 2 thì break sớm
    if (kimGiaBao && kimCat) break;
  }

  finalItems = [];
  if (kimGiaBao) finalItems.push(kimGiaBao);
  if (kimCat) finalItems.push(kimCat);
}

  // DOJI: chỉ lấy dòng "Nhẫn tròn 999 Hưng Thịnh Vượng" từ khu vực HN
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

  // Mi Hồng: chỉ lấy dòng "Vàng 99,9%"
  if (brand === 'Mi Hồng') {
    const vang999 = finalItems.find(it => it.name.includes('99,9%') || it.name.includes('99.9%'));
    const mhItems = vang999
      ? [{ ...vang999, name: 'Vàng 99,9%' }]
      : finalItems.slice(0, 1);
    return { buy: mhItems[0]?.buy || 0, sell: mhItems[0]?.sell || 0, items: mhItems };
  }

  return { buy: finalItems[0]?.buy || 0, sell: finalItems[0]?.sell || 0, items: finalItems };
}

// ── CACHE đơn giản trong Worker memory ───────────────────────
let cache = null;
let cacheTime = 0;
const TTL = 5 * 60 * 1000; // 5 phút

async function getPrices(force = false) {
  if (!force && cache && Date.now() - cacheTime < TTL) return cache;

  const results = {};
  for (const src of SOURCES) {
    try {
      const html = await fetchPage(src.url);
      results[src.key] = parsePrices(html, src.key);
    } catch (e) {
      results[src.key] = { buy: 0, sell: 0, items: [] };
    }
  }
  cache = results;
  cacheTime = Date.now();
  return results;
}

// ── WORKER HANDLER ────────────────────────────────────────────
export default {
  async fetch(request) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    try {
      const url = new URL(request.url);
      const force = url.searchParams.get('refresh') === '1';
      const data = await getPrices(force);
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
