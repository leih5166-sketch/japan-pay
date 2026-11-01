// 版本：2026-11-01 v9（短網址優惠券、縮圖修正）
// 免費爬蟲：每天抓取固定的比較網頁，用規則擷取優惠券與刷卡回饋，更新 data/data.json
// 不需要任何 API 金鑰。只有在確定解析成功時才覆蓋數值；解析失敗就保留舊資料，並寫入紀錄。
// 執行：node scripts/scrape.mjs        測試：node scripts/scrape.mjs --fixture 資料夾
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const FIXTURE = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const today = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Tokyo'}).format(new Date());
const log = [];
const note = (level, msg) => { log.push({level, msg}); console.log(`[${level}] ${msg}`); };

// ---------- 工具 ----------
export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/(tr|p|div|li|h[1-6]|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/ *\n */g, '\n');
}
export function parseDate(s) {
  if (!s) return null;
  let m = s.match(/(20\d\d)\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(20\d\d)\s*\/\s*(\d{1,2})\s*月/);
  if (m) { const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate(); return `${m[1]}-${m[2].padStart(2, '0')}-${last}`; }
  return null;
}
const alive = until => !until || until >= today;
const firstPct = s => { const m = String(s || '').match(/(\d+(?:\.\d+)?)\s*%/); return m ? +m[1] : null; };
export function parseCap(s) {
  s = String(s || '');
  if (/無上限/.test(s)) return {cap: null, capText: '無上限'};
  const m = s.match(/(\d[\d,]*)\s*(?:元|點)?\s*\/\s*(帳月|月|季|週|周|活動)/);
  if (!m) return undefined;
  const unit = {'帳月': '每期帳單', '月': '每月', '季': '每季', '週': '每週', '周': '每週', '活動': '活動期間'}[m[2]];
  const n = +m[1].replace(/,/g, '');
  return {cap: n, capText: `${unit} NT$${n.toLocaleString('en-US')}`};
}

async function getPage(url, fixtureName) {
  if (FIXTURE) return fs.readFile(path.join(FIXTURE, fixtureName), 'utf8');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  };
  let last;
  for (let i = 0; i < 3; i++) {            // 503、429 等暫時性錯誤最多重試 3 次
    const r = await fetch(url, {headers});
    if (r.ok) return r.text();
    last = r.status;
    if (![429, 500, 502, 503, 504].includes(r.status)) break;
    await new Promise(res => setTimeout(res, 5000 * (i + 1)));
  }
  throw new Error(`HTTP ${last}`);
}

// ---------- 刷卡回饋表 ----------
export function parseCardTable(text) {
  // 每一列表格會變成一行「欄 | 欄 | 欄」
  const rows = [];
  for (const line of text.split('\n')) {
    const cells = line.split(' | ').map(c => c.trim());
    if (cells.length < 6) continue;
    const rate = firstPct(cells[1]);
    if (rate == null) continue;
    let until = null;
    for (let i = cells.length - 1; i >= 1 && !until; i--) until = parseDate(cells[i]);
    rows.push({name: cells[0], rate, cap: parseCap(cells[2]), until, raw: line});
  }
  return rows;
}
// PayPay 表：找到表頭列（第一欄是 PayPay）與「活動期限」列
export function parsePayTable(text) {
  const lines = text.split('\n').map(l => l.split(' | ').map(c => c.trim()));
  const head = lines.find(c => c.length >= 4 && /^PayPay$/i.test(c[0]));
  const due = lines.find(c => c.length >= 4 && /活動期限/.test(c[0]));
  if (!head || !due) return null;
  const out = [];
  for (let i = 1; i < head.length; i++) if (head[i]) out.push({name: head[i], until: parseDate(due[i] || '')});
  return out;
}

function applyCards(base, prevPayments, rows, pays, sourceUrl) {
  const result = [];
  for (const def of base.payments) {
    const prev = (prevPayments || []).find(p => p.id === def.id) || def;
    const card = JSON.parse(JSON.stringify(prev));
    card.match = def.match; card.auto = def.auto; card.cond = card.cond || def.cond;
    if (def.kind === 'pay') {
      const col = (pays || []).find(c => def.match.some(k => c.name.includes(k)));
      if (col && col.until) { card.until = col.until; card.source = sourceUrl; }
      else note('warn', `找不到 ${def.name} 的活動期限，沿用舊資料`);
      result.push(card); continue;
    }
    const mine = rows.filter(r => def.match.some(k => r.name.toLowerCase().includes(k.toLowerCase())));
    if (!mine.length) { note('warn', `表格中找不到 ${def.name}，沿用舊資料`); result.push(card); continue; }
    const live = mine.filter(r => alive(r.until) && r.rate >= 0.5 && r.rate <= 30);
    if (!live.length) { card.until = mine.map(r => r.until).filter(Boolean).sort().pop() || card.until; note('info', `${def.name} 的活動都已到期`); result.push(card); continue; }
    card.until = live.map(r => r.until).filter(Boolean).sort().pop() || card.until;
    card.source = sourceUrl;
    if (def.auto !== 'full') { result.push(card); continue; }
    const unlimited = live.filter(r => r.cap && r.cap.cap == null).sort((a, b) => b.rate - a.rate)[0];
    const capped = live.filter(r => r.cap && r.cap.cap != null).sort((a, b) => b.rate - a.rate)[0];
    const before = JSON.stringify([card.base, card.bonuses]);
    if (unlimited) card.base = unlimited.rate;
    const storeBonus = (def.bonuses || []).find(b => b.stores);
    if (capped && (!unlimited || capped.rate > unlimited.rate)) {
      const base = Math.min(card.base, capped.rate);
      card.base = base;
      card.bonuses = [{rate: +(capped.rate - base).toFixed(2), cap: capped.cap.cap, capText: capped.cap.capText,
        stores: storeBonus ? storeBonus.stores : null, min: null, until: capped.until}];
    } else if (unlimited) {
      card.bonuses = [];
    }
    if (JSON.stringify([card.base, card.bonuses]) !== before) note('change', `${def.name} 更新為最高 ${capped ? capped.rate : unlimited.rate}%`);
    result.push(card);
  }
  return result;
}

// 把優惠內容拆成「簡短標題」和「其餘說明」，避免兩者重複
export function splitTitle(detail) {
  // 有編號的分級優惠（1.… 2.… 3.…）
  const tiers = detail.split(/\s(?=\d\s*[.、．]\s*\D)/).map(x => x.replace(/^\d\s*[.、．]\s*/, '').trim()).filter(Boolean);
  if (tiers.length > 1) return {t: tiers[0] + ' 起', d: tiers.map((x, i) => `${i + 1}. ${x}`).join('；')};
  const one = tiers[0] || detail;
  // 在全形逗號、分號、句號處斷開（不切數字中的千分位逗號）
  // 「…10% + 折扣 7% 日本清酒…」這類：在百分比後面的空白斷開（但不切「% + 」）
  const pct = one.match(/^(.{6,36}?%)\s+(?![+＋\d])(.+)$/);
  if (pct) return {t: pct[1].trim(), d: pct[2].trim()};
  const m = one.match(/^(.{6,36}?)(?:[，；。！]|(?<!\d),(?!\d))(.+)$/);
  if (m) return {t: m[1].trim(), d: m[2].trim()};
  return one.length > 36 ? {t: one.slice(0, 36) + '…', d: one} : {t: one, d: ''};
}

// ---------- 優惠券（卡優新聞網整理頁） ----------
export function parseCouponSections(html, keywords) {
  const out = {};
  // 網頁屬性（例如 <h2 id="【-鶴羽藥妝-】">）裡也可能有「【」，先移除這些屬性，避免切錯段落
  html = html.replace(/\s[\w-]+="[^"]*[【】][^"]*"/g, '');
  const chunks = html.split('【').slice(1);
  for (const chunk of chunks) {
    const end = chunk.indexOf('】');
    if (end < 0 || end > 80) continue;
    const title = htmlToText(chunk.slice(0, end)).trim();
    const ids = matchIds(title, keywords);
    if (!ids.length) continue;
    // 只取到這家店段落的結尾（分隔線或下一個標題）為止
    const body = chunk.slice(end + 1).split(/<hr|<h[1-4][\s>]/i)[0];
    const text = htmlToText(body);
    const periodLine = (text.match(/活動期間[：:]?\s*([^\n■]*)/) || [])[1] || '';
    const until = /無期限/.test(periodLine) ? null : parseDate(periodLine);
    ids.forEach(id => { out[id] = out[id] || []; });   // 來源有這家店：即使已到期也記錄，讓舊資料被清掉
    if (until && !alive(until)) continue;
    let detail = (text.match(/優惠內容[^：:]*[：:]\s*([\s\S]*?)(?:■|>>|\* \* \*|$)/) || [])[1] || '';
    detail = detail.replace(/<[^>]*$/, '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').replace(/\\/g, '').trim();
    if (!detail) continue;
    // 優惠券連結：優先用「下載優惠券」文字連結，沒有的話用段落中的優惠券圖片
    const a = body.match(/<a[^>]+href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?(?:下載|領取|取得)優惠券/);
    // 圖片可能是延遲載入（data-src、data-lazy-src），也要找
    const img = body.match(/<img[^>]+?(?:data-lazy-src|data-src|data-original|src)="(https?:\/\/[^"]+\.(?:jpe?g|png|webp|gif)[^"]*)"/i);
    let url = a && /^https?:\/\//.test(a[1]) && !/data:image/i.test(a[1]) ? a[1] : null;
    if (!url && img && !/logo|icon|banner|avatar/i.test(img[1])) url = img[1];
    // 圖片直接嵌在網頁程式碼裡（data:image/...;base64,...）：先記下來，稍後存成圖片檔
    let embedded = null;
    if (!url) {
      const e = body.match(/(?:href|src)="(?:https?:\/\/)?(data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+\/=\s]{2000,}))"/i);
      if (e) embedded = {ext: e[2].toLowerCase().replace('jpeg', 'jpg'), b64: e[3].replace(/\s/g, '')};
    }
    const {t, d: rest} = splitTitle(detail);
    // 「使用方式」也一起顯示，讓使用者知道條件（例如要刷特定信用卡、要出示護照）
    let how = (text.match(/使用方式[^：:]*[：:]\s*([\s\S]*?)(?:■|>>|\* \* \*|$)/) || [])[1] || '';
    how = how.replace(/<[^>]*$/, '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').replace(/[①②③④⑤]/g, ' ').trim();
    if (how.length > 120) how = how.slice(0, 120) + '…';
    // 用句號串接，網站不用修改就能正常顯示
    const d = (rest && how && !/[。！!]$/.test(rest) ? rest + '。' : rest) + (how ? `使用方式：${how}` : '');
    ids.forEach(id => out[id].push({t, d, until, url, source: null, ...(embedded ? {embedded} : {})}));
  }
  return out;
}

// 依關鍵字找出標題對應的所有店家（例如「SEIBU SOGO」同時對應西武與 SOGO）
const normKw = x => String(x || '').toLowerCase().replace(/[\s\-・･'’.＆&_]/g, '');
export function matchIds(text, keywords) {
  const t = normKw(text);
  return Object.keys(keywords).filter(k => (keywords[k] || []).some(w => { const n = normKw(w); return n.length >= 2 && t.includes(n); }));
}

// ---------- TAXFREESHOPS.JP（官方合作優惠券，每家店一頁） ----------
export function discoverTieups(html) {
  return [...new Set([...html.matchAll(/\/tieup\/(\d{1,3})(?![\w])/g)].map(m => +m[1]))].sort((a, b) => a - b);
}
export function parseTieup(html, keywords) {
  const title = htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const name = title.split('|')[0].replace(/優惠券|減稅免費店|TAXFREESHOPS\.JP/gi, '').trim();
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const h1text = htmlToText(h1).replace(/\s+/g, ' ').trim();
  const alt = ((h1.match(/alt="([^"]+)"/) || [])[1] || '').trim();
  // 優惠文字：優先用 h1 後面第一行含 % 的短句，其次 h1 文字或圖片說明
  const afterLines = htmlToText(html.split(/<\/h1>/i)[1] || '').split('\n').map(x => x.replace(/\s+/g, ' ').trim());
  const after = afterLines.find(x => /[%％]/.test(x) && x.length <= 40);
  // 從一段文字中挑出含有百分比的那一句，例如「…優惠券。免稅10% + 高達 5% 折扣。」→「免稅10% + 高達 5% 折扣」
  const pickPct = x => (x.split(/[。！!]|\s\/\s/).map(y => y.trim()).find(y => /[%％]/.test(y) && y.length <= 40) || '');
  let offer = after || pickPct(h1text) || pickPct(alt);
  offer = offer.replace(/^[#\s]+/, '').trim();
  const ids = matchIds(name, keywords);
  return {name, ids: ids.length ? ids : matchIds(h1text + ' ' + alt, keywords),
    coupon: {t: offer || '免稅＋折扣優惠券（詳見頁面）', d: '官方合作優惠券（TAXFREESHOPS.JP），結帳前出示此頁面與護照。', until: null}};
}

// ---------- FlyAsia（一張表格列出所有優惠券） ----------
export function parseFlyasia(html, keywords) {
  const out = {};
  for (const row of html.split(/<tr[\s>]/i).slice(1)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1]);
    if (cells.length < 4) continue;
    const name = htmlToText(cells[0]).replace(/\s+/g, ' ').trim();
    const disc = htmlToText(cells[1]).replace(/\s+/g, ' ').trim();
    if (!/[%％]|折|JPY|¥|円/i.test(disc)) continue;
    const until = parseDate(htmlToText(cells[2]));
    const href = (cells.slice(3).join(' ').match(/href="([^"]+)"/) || [])[1];
    const ids = matchIds(name, keywords);
    for (const id of ids) {
      out[id] = out[id] || [];
      if (until && !alive(until)) continue;
      out[id].push({t: disc, d: `適用：${name}`, until, url: href && /^https?:/.test(href) ? href.replace(/&amp;/g, '&') : null, source: null});
    }
  }
  return out;
}


// ---------- 自動新增店家 ----------
// 依店名猜類別（猜錯不影響優惠券顯示）
export function guessCat(name) {
  const n = String(name || '');
  const rules = [
    [/藥|薬|ドラッグ|drug|pharmacy/i, 'drugstore'], [/電機|電器|電氣|デンキ|カメラ|denki|camera/i, 'electronics'],
    [/免稅店|免税店|duty ?free/i, 'dutyfree'], [/百貨|デパート|department/i, 'department'],
    [/outlet|アウトレット|mall|モール|購物中心|商場/i, 'mall'], [/眼鏡|メガネ|optical/i, 'eyewear'],
    [/golf|ゴルフ|sports|スポーツ|自行車|bike|outdoor|滑雪|ski/i, 'sports'], [/租車|レンタカー|rent-?a-?car|wifi|esim|sim/i, 'service'],
    [/餐|レストラン|食堂|寿司|壽司|ラーメン|拉麵|燒肉|焼肉|cafe|咖啡/i, 'restaurant'], [/玩具|ホビー|アニメ|動漫|hobby|toy/i, 'hobby'],
    [/服|洋服|fashion|apparel|包|bag|バッグ|thavasa|鞋|shoes/i, 'apparel'], [/超市|スーパー|super/i, 'supermarket'], [/水族館|瞭望|樂園|劇場|theater|ticket/i, 'themepark']
  ];
  for (const [re, c] of rules) if (re.test(n)) return c;
  return 'other';
}
function slugId(name) {
  let h = 0; for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return 'auto-' + h.toString(36);
}
// 店名清理：去掉「優惠券」「免稅」「（福岡店鋪限定）」等字樣
export function cleanStoreName(name) {
  return String(name || '').replace(/【[^】]*】|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/(免稅)?(折扣|折價|退稅)?(優惠券|折價券|折扣券|兌換券|coupon)/gi, ' ')
    .replace(/(最高|MAX)?\s*\d+\s*[%％]\s*(OFF|折扣)?/gi, ' ').replace(/20\d\d年?(最新)?/g, ' ')
    .replace(/[｜|:：!！,，、。]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// 名字看起來不像店名（太短、只剩「店」字、殘缺）就不要自動新增
export function badStoreName(n) {
  // 「全日空 店」「日本 店 和遊客專屬」這類：「店」字被單獨留下，代表前面的字被切掉了
  // 「日本免稅店 和遊客專屬折扣」這類是優惠券標題，不是店名
  return !n || n.length < 3 || n.length > 40 || /(^|\s)店(\s|$)/.test(n) || /遊客|旅客|專屬|專享|限定|^日本免稅/.test(n);
}

// ---------- MATCHA 優惠券（列表頁＋每張券一頁） ----------
// 列表頁每張卡片的文字片段（卡片上通常會寫店名），依優惠券編號整理
export function parseMatchaListNames(html) {
  const out = {};
  for (const m of html.matchAll(/<a[^>]+href="[^"]*\/tw\/coupon\/(\d{1,4})"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const segs = m[2].split(/<[^>]+>/).map(x => x.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
      .filter(x => x.length >= 2 && x.length <= 30 && !/優惠|折扣|折價|OFF|[%％]|免稅|coupon/i.test(x));
    (out[m[1]] = out[m[1]] || []).push(...segs);
  }
  return out;
}
export function discoverMatcha(html) {
  return [...new Set([...html.matchAll(/\/tw\/coupon\/(\d{1,4})(?![\w])/g)].map(m => +m[1]))].sort((a, b) => a - b);
}
export function parseMatchaCoupon(html) {
  // 頁面上可能有好幾個大標題（網站標誌區的「日本免稅店優惠券和遊客專屬折扣」也是），全部讀出來，挑出真正的店名
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m => m[1]);
  const heads = h1s.map(h => ({name: htmlToText(h.split(/<br\s*\/?>/i)[0]).replace(/\s+/g, ' ').trim(), sub: htmlToText(h.split(/<br\s*\/?>/i).slice(1).join(' ')).replace(/\s+/g, ' ').trim()}));
  const good = heads.filter(h => h.name && !badStoreName(cleanStoreName(h.name)));
  const best = good[good.length - 1] || heads[heads.length - 1] || {name: '', sub: ''};
  const name = best.name, sub = best.sub;
  // 網頁標題，例如「國民藥妝店 KoKuMiN 8% - MATCHA優惠券」→「國民藥妝店 KoKuMiN」
  const title = htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
    .split(/\s+-\s+MATCHA|｜|\|/)[0].replace(/(MAX\s*)?\d+\s*[%％]\s*(OFF)?\s*$/i, '').replace(/\s+/g, ' ').trim();
  const text = htmlToText(html);
  const offer = (text.match(/(最高\s*\d+\s*[%％]\s*折扣|\d+\s*[%％]\s*折扣|¥\s*[\d,]+\s*(?:OFF|折扣))/i) || [])[1] || '';
  const until = parseDate((text.match(/有效期限\s*([^\n]+)/) || [])[1] || '');
  let cond = (text.match(/使用條件\s*([\s\S]*?)(?:【|##|其他推薦|$)/) || [])[1] || '';
  cond = cond.replace(/[・·]/g, ' ').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (cond.length > 120) cond = cond.slice(0, 120) + '…';
  // 其他可能寫有店名的地方：分享用的標題（og:title、twitter:title）、結構化資料（JSON-LD 的 name）
  const meta = re => ((html.match(re) || [])[1] || '').replace(/&amp;/g, '&').trim();
  const og = meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || meta(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title/i);
  const tw = meta(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i);
  const ld = meta(/"(?:brand|seller|organizer|name)"\s*:\s*(?:\{[^}]*?"name"\s*:\s*)?"([^"]{2,40})"/);
  const clip = x => String(x || '').split(/\s+-\s+MATCHA|｜|\|/)[0].replace(/(MAX\s*)?\d+\s*[%％]\s*(OFF)?\s*$/i, '').replace(/\s+/g, ' ').trim();
  const debug = `title=${title}｜og=${og}｜h1=${heads.map(h => h.name).join('/')}`.slice(0, 160);
  return {name, sub, title, og: clip(og), tw: clip(tw), ld, debug, offer: offer.replace(/\s+/g, ' '), until, cond};
}

// ---------- JCB 精選優惠（信用卡活動列表） ----------
export function parseJcbList(html) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]*\/campaign\/detail\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!text || /活動已結束/.test(text)) continue;
    const url = m[1].startsWith('http') ? m[1] : 'https://www.specialoffers.jcb' + m[1];
    const cat = (text.match(/(商店|餐廳|休閒活動|SPA按摩|娛樂票券|飯店|大眾運輸工具|網上商城|其他)\s*$/) || [])[1] || '';
    const title = text.replace(/(商店|餐廳|休閒活動|SPA按摩|娛樂票券|飯店|大眾運輸工具|網上商城|其他)\s*$/, '').trim();
    if (!out.some(x => x.url === url)) out.push({title, url, cat});
  }
  return out;
}


// ---------- 從部落格文章中找出優惠券圖片與有效期限 ----------
export const BLOG_HOSTS = /bubu-jp\.com|ksk\.tw|linshibi\.com|reurl\.cc|letsgojp\.com|flyasia\.co/i;
export function extractCouponFromArticle(html) {
  // 文章結尾的「延伸閱讀、最新文章」之後的圖片不算
  const cut = html.search(/延伸閱讀|最新文章|推薦文章|相關文章|精選推薦|其他推薦/);
  const body = cut > 0 ? html.slice(0, cut) : html;
  const cands = [];
  const tagRe = /<(img|a|source)\b[^>]*>/gi; let m;
  let inCouponSection = false;
  const headRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi;
  const heads = [...body.matchAll(headRe)].map(h => ({i: h.index, coupon: /優惠券|折價券|折扣券|coupon|クーポン|使用方法|使用方式/i.test(h[1].replace(/<[^>]+>/g, ''))}));
  while ((m = tagRe.exec(body))) {
    const tag = m[0];
    const attr = n => ((tag.match(new RegExp(n + '="([^"]+)"', 'i')) || [])[1] || '');
    const first = x => (x || '').split(',').pop().trim().split(/\s+/)[0];   // srcset 取最大的那張
    const t = m[1].toLowerCase();
    let src = t === 'a' ? attr('href')
      : (attr('data-lazy-src') || attr('data-src') || attr('data-original') || attr('data-orig-file') || attr('data-large-file')
         || first(attr('data-lazy-srcset')) || first(attr('data-srcset')) || first(attr('srcset')) || attr('src'));
    if (src.startsWith('//')) src = 'https:' + src;
    if (!/^https?:\/\/[^"\s]+\.(jpe?g|png|webp|gif)(\?[^"\s]*)?$/i.test(src)) continue;
    const alt = attr('alt') + ' ' + attr('title');
    const head = heads.filter(h => h.i < m.index).pop();
    let score = 0;
    if (/coupon|クーポン|優惠券|折價券|折扣券|barcode|_cp|cp_|tax.?free/i.test(src + ' ' + alt)) score += 5;
    if (head && head.coupon) score += 3;
    if (/logo|icon|avatar|gravatar|emoji|share|facebook|threads|line\.me|[\/_\-.]ads?[_\-\/.]|banner_ad|profile/i.test(src.replace(/\/wp-content\/uploads\//i, '/'))) score -= 10;
    src = src.replace(/-\d{2,4}x\d{2,4}(?=\.(jpe?g|png|webp|gif)(\?|$))/i, '');   // WordPress 縮圖 → 原尺寸圖片
    cands.push({src: src.replace(/&amp;/g, '&'), score, i: m.index});
  }
  cands.sort((a, b) => b.score - a.score || a.i - b.i);
  let best = cands.find(c => c.score >= 3);
  // 短網址的轉址頁：網頁標題、分享圖片或自動轉址的目標，本身就是優惠券圖片
  if (!best) {
    const imgRe = /https?:\/\/[^\s"'<>]+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>]*)?/i;
    const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
    const og = (html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || [])[1] || '';
    const refresh = (html.match(/http-equiv=["']refresh["'][^>]+url=([^"'>\s]+)/i) || [])[1] || '';
    const hit = [title, refresh, og].map(x => (x.match(imgRe) || [])[0]).find(Boolean);
    if (hit && html.length < 20000) best = {src: hit.replace(/&amp;/g, '&')};
  }
  const text = htmlToText(body);
  const exp = text.match(/(有效期限|有效期至|有效期間|使用期限|活動期間|期限)[^0-9\n]{0,20}(?:即日起\s*[~～\-至]\s*)?(20\d\d\s*[年\/.\-]\s*\d{1,2}\s*[月\/.\-]\s*\d{1,2})/);
  return {image: best ? best.src : null, until: exp ? parseDate(exp[2]) : null};
}

// ---------- 唐吉訶德（LIVE JAPAN 官方合作頁） ----------
export function parseDonki(html) {
  const text = htmlToText(html);
  const tiers = [...text.matchAll(/含稅\s*([\d,]+)\s*日圓以上[^\n%]*?(\d+)\s*%/g)].map(m => [m[1], m[2]]);
  if (!tiers.length) return null;
  const a = html.match(/href="(https:\/\/japanportal\.donki-global\.com\/coupon\/[^"]+)"/);
  return [{
    t: tiers.map(([amt, pct]) => `含稅滿 ¥${amt} 折 ${pct}%`).join('、'),
    d: '需連網開啟官方優惠頁出示，截圖無效；菸酒、遊戲主機等不適用。',
    until: null, url: a ? a[1].replace(/&amp;/g, '&') : null, source: null
  }];
}

// ---------- 存下嵌入在網頁中的優惠券圖片 ----------
const savedImages = [];
function siteBase() {
  // 在 GitHub Actions 中自動得知網站網址，例如 https://帳號.github.io/japan-pay/
  const repo = process.env.GITHUB_REPOSITORY || '';
  const [owner, name] = repo.split('/');
  return owner && name ? `https://${owner.toLowerCase()}.github.io/${name}/` : '';
}
function saveEmbedded(id, i, {ext, b64}) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 1000 || buf.length > 3_000_000) return null;   // 太小（不是優惠券）或太大就略過
  const file = `data/coupons/${id}${i ? '-' + i : ''}.${ext}`;
  savedImages.push({file, buf});
  const base = siteBase();
  note('ok', `${id} 的優惠券圖片已從網頁中還原（${Math.round(buf.length / 1024)} KB）`);
  return base ? base + file : null;
}

// ---------- 主程式 ----------
async function main() {
  const base = JSON.parse(await fs.readFile('data/base.json', 'utf8'));
  const sources = JSON.parse(await fs.readFile('data/sources.json', 'utf8'));
  const prev = JSON.parse(await fs.readFile('data/data.json', 'utf8').catch(() => 'null')) || {payments: base.payments, promos: base.promos, coupons: {}};
  const out = {updated_at: new Date().toISOString(), note: '', payments: prev.payments, promos: prev.promos || base.promos, coupons: {...(prev.coupons || {})}};

  // 自動新增的店家存在 data/stores-auto.json；比對時同時使用手動清單與自動清單
  const manualStores = JSON.parse(await fs.readFile('data/stores.json', 'utf8').catch(() => '[]'));
  const autoStores = JSON.parse(await fs.readFile('data/stores-auto.json', 'utf8').catch(() => '[]'));
  // 清理自動清單：已經有手動資料的店（避免重複）、非店家的服務、店名殘缺的，全部移除
  const kwManual = {...sources.coupon_store_keywords};
  for (const st of manualStores) if (st.id !== 'generic') kwManual[st.id] = [...new Set([...(kwManual[st.id] || []), st.name.replace(/（.*）/, ''), ...(st.alias || []).filter(a => a.length >= 3)])];
  const skipRe = new RegExp((sources.matcha?.skip_keywords || []).join('|'), 'i');
  for (let i = autoStores.length - 1; i >= 0; i--) {
    const a = autoStores[i];
    const why = matchIds(a.name, kwManual).length ? '已有手動資料' : skipRe.test(a.name) ? '不是實體店家' : badStoreName(a.name) ? '店名殘缺' : '';
    if (why) { note('info', `移除自動店家「${a.name}」（${why}）`); delete out.coupons[a.id]; autoStores.splice(i, 1); }
  }
  const kwAll = {...sources.coupon_store_keywords};
  for (const st of [...manualStores, ...autoStores]) {
    if (st.id === 'generic') continue;
    kwAll[st.id] = [...new Set([...(kwAll[st.id] || []), st.name.replace(/（.*）/, ''), ...(st.alias || []).filter(a => a.length >= 3)])];
  }
  let newStores = 0;
  const ensureStore = (rawName, hint) => {
    const ids = matchIds(rawName, kwAll);
    if (ids.length) return ids;
    const name = cleanStoreName(rawName);
    if (badStoreName(name)) { note('info', `店名無法辨識，略過：${rawName}`); return []; }
    const id = slugId(name);
    if (!autoStores.some(x => x.id === id)) {
      autoStores.push({id, name, jp: '', cat: guessCat(name + ' ' + (hint || '')), alias: [name], auto: true, added: today});
      kwAll[id] = [name];
      newStores++;
      note('new', `自動新增店家：${name}`);
    }
    return [id];
  };
  let ok = 0;

  // 1. 刷卡回饋
  for (const src of sources.cards) {
    try {
      const html = await getPage(src.url, 'cards.html');
      const text = htmlToText(html);
      const rows = parseCardTable(text);
      if (rows.length < 8) throw new Error(`只解析到 ${rows.length} 列，可能網頁改版`);
      out.payments = applyCards(base, prev.payments, rows, parsePayTable(text), src.url);
      note('ok', `${src.name}：解析 ${rows.length} 列刷卡回饋`);
      ok++; break;
    } catch (e) { note('error', `${src.name} 失敗：${e.message}，刷卡資料沿用舊值`); }
  }

  // 2. 優惠券：三個來源，依優先順序合併（官方 > 卡優 > FlyAsia）
  const kw = sources.coupon_store_keywords;
  const fallback = sources.coupon_url_fallback || {};
  const results = {};   // 來源名稱 → {店家id: [優惠券]}
  const finish = (srcKey, srcUrl, got) => {
    for (const [id, list] of Object.entries(got)) list.forEach((c, i) => {
      c.source = c.source || srcUrl;
      if (c.embedded) { c.url = saveEmbedded(id, i, c.embedded); delete c.embedded; }
      if (!c.url && fallback[id]) c.url = fallback[id];
      if (!c.url) note('warn', `${id} 找不到優惠券連結`);
    });
    results[srcKey] = got;
  };

  // 2a. TAXFREESHOPS.JP
  if (sources.taxfreeshops) {
    const T = sources.taxfreeshops;
    try {
      const first = await getPage(T.start, 'tfs-2.html');
      const ids = discoverTieups(first);
      if (ids.length < 5) throw new Error(`只找到 ${ids.length} 個合作店家，可能網頁改版`);
      const got = {}; let pages = 0;
      for (const n of ids) {
        const url = T.page.replace('{id}', n);
        try {
          const html = n === 2 ? first : await getPage(url, `tfs-${n}.html`);
          const r = parseTieup(html, kwAll);
          if (!r.ids.length) r.ids = /esim|wifi|sim\b/i.test(r.name) ? [] : ensureStore(r.name, r.coupon.t);
          if (!r.ids.length) { note('info', `TAXFREESHOPS 第 ${n} 頁（${r.name || '未知'}）不是實體店家，略過`); continue; }
          r.ids.forEach(id => { (got[id] = got[id] || []).push({...r.coupon, url, source: url}); });
          pages++;
          if (!FIXTURE) await new Promise(res => setTimeout(res, 800));   // 放慢速度，避免造成對方負擔
        } catch (e) { note('warn', `TAXFREESHOPS 第 ${n} 頁讀取失敗：${e.message}`); }
      }
      if (pages < 5) throw new Error(`只解析到 ${pages} 頁`);
      finish('taxfreeshops', T.start, got);
      note('ok', `${T.name}：解析 ${pages} 家合作店的優惠券`); ok++;
    } catch (e) { note('error', `${T.name} 失敗：${e.message}`); }
  }

  // 2b. 卡優新聞網
  for (const src of sources.coupons) {
    try {
      const html = await getPage(src.url, 'coupons.html');
      const got = parseCouponSections(html, kwAll);
      delete got.donki;   // 唐吉訶德的整理文章資料較舊，改用官方來源
      const n = Object.values(got).filter(l => l.length).length;
      if (n < 5) throw new Error(`只解析到 ${n} 家店，可能網頁改版`);
      finish('cardu', src.url, got);
      note('ok', `${src.name}：解析 ${n} 家店的優惠券`); ok++; break;
    } catch (e) { note('error', `${src.name} 失敗：${e.message}`); }
  }

  // 2c. FlyAsia
  for (const src of (sources.flyasia || [])) {
    try {
      const got = parseFlyasia(await getPage(src.url, 'flyasia.html'), kw);
      const n = Object.values(got).filter(l => l.length).length;
      if (n < 5) throw new Error(`只解析到 ${n} 家店，可能網頁改版`);
      finish('flyasia', src.url, got);
      note('ok', `${src.name}：解析 ${n} 家店的優惠券`); ok++; break;
    } catch (e) { note('error', `${src.name} 失敗：${e.message}`); }
  }

  // 2c-2. MATCHA 優惠券
  if (sources.matcha) {
    const M = sources.matcha;
    try {
      const listHtml = await getPage(M.list, 'matcha-list.html');
      const ids = discoverMatcha(listHtml);
      const listNames = parseMatchaListNames(listHtml);
      if (ids.length < 10) throw new Error(`只找到 ${ids.length} 張優惠券，可能網頁改版`);
      const skip = new RegExp(M.skip_keywords.join('|'), 'i');
      const got = {}; let n = 0, expired = 0;
      for (const id of ids) {
        const url = M.page.replace('{id}', id);
        try {
          const r = parseMatchaCoupon(await getPage(url, `matcha-${id}.html`));
          if (!r.name && !r.title) continue;
          if (skip.test(r.name + ' ' + r.sub + ' ' + r.title)) continue;
          if (r.until && !alive(r.until)) continue;
          // 大標題是通用文字（例如「日本免稅店優惠券和遊客專屬折扣」）時，改用網頁標題或副標題當店名
          const isSite = x => /^matcha|matcha優惠券|日本觀光媒體/i.test(String(x || '').trim());
          const cands = [r.name, r.title, r.og, r.tw, ...(listNames[id] || []), r.ld, r.sub].filter(x => x && !isSite(x));
          const pick = cands.find(x => matchIds(x, kwAll).length || !badStoreName(cleanStoreName(x)));
          if (!pick) {
            // MATCHA 對已到期或下架的優惠券會改顯示通用首頁，標題只剩網站名稱，這種就直接略過
            if (/日本免稅店優惠券和遊客專屬折扣|免稅・折扣資訊/.test(r.title + r.og + r.name)) { expired++; continue; }
            note('info', `MATCHA 第 ${id} 張找不到店名（爬蟲讀到：${r.debug}）`.slice(0, 200)); continue;
          }
          const sids = ensureStore(pick, r.offer);
          sids.forEach(sid => { (got[sid] = got[sid] || []).push({t: r.offer ? `免稅＋${r.offer}` : '免稅＋折扣優惠券（詳見頁面）', d: r.cond ? `使用條件：${r.cond}` : 'MATCHA 優惠券，結帳時出示頁面。', until: r.until, url, source: url}); });
          if (sids.length) n++;
          if (!FIXTURE) await new Promise(res => setTimeout(res, 600));
        } catch (e) { note('warn', `MATCHA 第 ${id} 張讀取失敗：${e.message}`); }
      }
      if (n < 5) throw new Error(`只解析到 ${n} 張`);
      finish('matcha', M.list, got);
      note('ok', `${M.name}：解析 ${n} 張優惠券` + (expired ? `（另有 ${expired} 張已到期或下架，略過）` : '')); ok++;
    } catch (e) { note('error', `${M.name} 失敗：${e.message}`); }
  }

  // 2d. 合併：每家店採用優先順序最高、且有有效優惠券的來源
  const PRIORITY = ['taxfreeshops', 'cardu', 'matcha', 'flyasia'];
  const seen = new Set(PRIORITY.flatMap(k => Object.keys(results[k] || {})));
  for (const id of seen) {
    let chosen = null;
    for (const k of PRIORITY) { const l = results[k]?.[id]; if (l && l.length) { chosen = l; break; } }
    if (!chosen) chosen = [];   // 來源有列出這家店，但優惠券都已到期
    const before = JSON.stringify((out.coupons[id] || []).filter(c => !c.static).map(c => [c.t, c.until]));
    if (before !== JSON.stringify(chosen.map(c => [c.t, c.until]))) note('change', `${id} 優惠券已更新`);
    out.coupons[id] = chosen;
  }

  // 3. 唐吉訶德官方頁（比整理文章更準）
  let donkiOk = false;
  for (const src of sources.donki) {
    try {
      const got = parseDonki(await getPage(src.url, 'donki.html'));
      if (!got) throw new Error('找不到折扣門檻');
      got[0].source = src.url;
      out.coupons.donki = got;
      note('ok', `${src.name}：${got[0].t}`);
      ok++; donkiOk = true; break;
    } catch (e) { note('warn', `${src.name} 暫時無法連線（${e.message}）`); }
  }
  if (!donkiOk) {
    const prevFromOfficial = (out.coupons?.donki || []).some(c => /livejapan|taxfreeshops/.test(c.source || ''));
    if (prevFromOfficial) note('info', '唐吉訶德沿用前次從官方頁取得的優惠券');
    else if (sources.donki_fallback) { out.coupons.donki = sources.donki_fallback; note('info', '唐吉訶德使用 sources.json 中的備用資料'); }
  }

  // 4. 常設優惠與信用卡專屬優惠（sources.json 的 static_coupons），每次重新套用
  for (const k of Object.keys(out.coupons)) out.coupons[k] = (out.coupons[k] || []).filter(c => !c.static);
  for (const [id, list] of Object.entries(sources.static_coupons || {})) {
    const cur = out.coupons[id] || [];
    for (const c of list) if (!cur.some(x => x.t === c.t)) cur.push({until: null, source: null, ...c, static: true});
    out.coupons[id] = cur;
  }

  // 4a. JCB 信用卡活動：自動比對店家，加到「信用卡專屬活動」
  if (sources.jcb) {
    try {
      const list = [];
      for (const u of [].concat(sources.jcb.list)) {
        try { for (const a of parseJcbList(await getPage(u, 'jcb.html'))) if (!list.some(x => x.url === a.url)) list.push(a); } catch (e) {}
      }
      if (list.length < 3) throw new Error(`只找到 ${list.length} 個活動`);
      // 成功時：移除上次的 JCB 資料與備用資料，改用這次讀到的
      for (const k of Object.keys(out.coupons)) out.coupons[k] = (out.coupons[k] || []).filter(c => c.dyn !== 'jcb' && !c.jcb_fallback);
      let n = 0;
      for (const a of list) {
        const sids = matchIds(a.title, kwAll);
        if (!sids.length) { note('info', `JCB 活動找不到對應店家：${a.title.slice(0, 30)}`); continue; }
        for (const sid of sids) {
          const t = '【刷 JCB 卡】' + a.title.replace(/^【[^】]*】\s*/, '').replace(/^\[[^\]]*\]\s*/, '');
          (out.coupons[sid] = out.coupons[sid] || []).push({t, d: '需刷 JCB 卡，並依活動頁的規定登錄或出示。', until: null, url: a.url, source: sources.jcb.list, dyn: 'jcb', kind: 'card'});
        }
        n++;
      }
      note('ok', `${sources.jcb.name}：比對到 ${n} 個店家活動`); ok++;
    } catch (e) { note('warn', `${sources.jcb.name} 暫時讀不到（${e.message}），改用備用的 JCB 活動資料`); }
  }

  // 4c. 來自部落格文章的優惠券：每天進入文章找出最新的優惠券圖片與有效期限
  const articleCache = {};
  let directOk = 0, directFail = 0; const failList = [];
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  for (const [sid, list] of Object.entries(out.coupons)) {
    for (const c of [...(list || [])]) {
      const art = c.source && BLOG_HOSTS.test(c.source) ? c.source : (BLOG_HOSTS.test(c.url || '') ? c.url : null);
      if (!art || c.kind === 'card' || c.link_is_coupon) continue;   // 連結本身就是優惠券（例如雲端硬碟圖片、出示文章）
      c.source = art;
      try {
        if (!articleCache[art]) {
          articleCache[art] = extractCouponFromArticle(await getPage(art, 'article-' + art.replace(/[^a-z0-9]/gi, '_').slice(-40) + '.html'));
          if (!FIXTURE) await new Promise(res => setTimeout(res, 800));
        }
        const r = articleCache[art];
        if (r.until && !alive(r.until)) {
          out.coupons[sid] = out.coupons[sid].filter(x => x !== c);
          note('info', `${sid} 的優惠券已於 ${r.until} 到期（依來源文章），自動移除`);
          continue;
        }
        if (r.until && !c.until) c.until = r.until;
        if (r.image) { c.url = r.image; c.direct = true; directOk++; }
        else { c.url = art; c.direct = false; directFail++; failList.push(`${sid}（${hostOf(art)}：文章中找不到優惠券圖片）`); }
      } catch (e) { c.url = art; c.direct = false; directFail++; failList.push(`${sid}（${hostOf(art)}：${e.message}）`); }
    }
  }
  if (directOk + directFail) note(directFail ? 'warn' : 'ok', `部落格優惠券：${directOk} 張找到優惠券圖片` + (directFail ? `，${directFail} 張找不到（改連到來源文章）` : ''));
  for (const f of failList) note('info', `找不到優惠券圖片：${f}`);

  // 4b. 檢查 LIVE JAPAN 是否在維修：維修中就在相關優惠券加上提示，恢復後提示自動消失
  const LJ_NOTE = '（LIVE JAPAN 網站目前維修中，連結暫時打不開，請稍後再試）';
  let ljDown = false;
  try {
    const html = await getPage('https://livejapan.com/public/operation/coupon/top/zh-tw.html', 'livejapan-top.html');
    ljDown = /down for maintenance|メンテナンス/i.test(html);
  } catch (e) { ljDown = true; }
  for (const list of Object.values(out.coupons)) for (const c of list || []) {
    c.d = (c.d || '').replace(LJ_NOTE, '');
    if (ljDown && /livejapan\.com/.test(c.url || '')) c.d += LJ_NOTE;
  }
  note(ljDown ? 'warn' : 'ok', ljDown ? 'LIVE JAPAN 維修中或無法連線，相關優惠券已加上提示' : 'LIVE JAPAN 正常');

  // 5. 清掉已到期的項目
  for (const k of Object.keys(out.coupons)) out.coupons[k] = (out.coupons[k] || []).filter(c => alive(c.until));
  out.promos = (out.promos || []).filter(p => alive(p.until));

  const changes = log.filter(l => l.level === 'change').length;
  const errors = log.filter(l => l.level === 'error').length;
  out.note = errors ? `部分來源暫時無法更新（${errors} 項），已沿用前次資料` : (changes ? `本次更新 ${changes} 項` : '資料與前次相同');

  if (savedImages.length) {
    await fs.mkdir('data/coupons', {recursive: true});
    for (const {file, buf} of savedImages) await fs.writeFile(file, buf);
  }
  await fs.writeFile('data/stores-auto.json', JSON.stringify(autoStores, null, 1));
  if (newStores) note('info', `本次自動新增 ${newStores} 家店`);
  await fs.writeFile('data/data.json', JSON.stringify(out, null, 1));
  await fs.writeFile('data/update-log.json', JSON.stringify({at: out.updated_at, log}, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['## 更新結果', '', ...log.map(l => `- **${l.level}** ${l.msg}`)].join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
  if (!ok) { console.error('所有來源都失敗'); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
