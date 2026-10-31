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
    const id = Object.keys(keywords).find(k => keywords[k].some(w => title.toLowerCase().includes(w.toLowerCase())));
    if (!id) continue;
    // 只取到這家店段落的結尾（分隔線或下一個標題）為止
    const body = chunk.slice(end + 1).split(/<hr|<h[1-4][\s>]/i)[0];
    const text = htmlToText(body);
    const periodLine = (text.match(/活動期間[：:]?\s*([^\n■]*)/) || [])[1] || '';
    const until = /無期限/.test(periodLine) ? null : parseDate(periodLine);
    out[id] = out[id] || [];           // 來源有這家店：即使已到期也記錄，讓舊資料被清掉
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
    out[id].push({t, d, until, url, source: null, ...(embedded ? {embedded} : {})});
  }
  return out;
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

  // 2. 優惠券
  for (const src of sources.coupons) {
    try {
      const html = await getPage(src.url, 'coupons.html');
      const got = parseCouponSections(html, sources.coupon_store_keywords);
      const n = Object.values(got).filter(l => l.length).length;
      if (n < 5) throw new Error(`只解析到 ${n} 家店，可能網頁改版`);
      const fallback = sources.coupon_url_fallback || {};
      for (const [id, list] of Object.entries(got)) {
        if (id === 'donki') continue;   // 唐吉訶德改由下方官方合作頁或備用資料處理
        list.forEach((c, i) => {
          c.source = src.url;
          if (c.embedded) {                       // 還原嵌入的優惠券圖片並存檔
            c.url = saveEmbedded(id, i, c.embedded);
            delete c.embedded;
          }
          if (!c.url && fallback[id]) c.url = fallback[id];
          if (!c.url) note('warn', `${id} 找不到優惠券連結`);
        });
        if (JSON.stringify(out.coupons[id]?.map(c => [c.t, c.until])) !== JSON.stringify(list.map(c => [c.t, c.until]))) note('change', `${id} 優惠券已更新`);
        out.coupons[id] = list;
      }
      note('ok', `${src.name}：解析 ${n} 家店的優惠券`);
      ok++; break;
    } catch (e) { note('error', `${src.name} 失敗：${e.message}，優惠券沿用舊值`); }
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
    const prevFromOfficial = (prev.coupons?.donki || []).some(c => (c.source || '').includes('livejapan'));
    if (prevFromOfficial) note('info', '唐吉訶德沿用前次從官方頁取得的優惠券');
    else if (sources.donki_fallback) { out.coupons.donki = sources.donki_fallback; note('info', '唐吉訶德使用 sources.json 中的備用資料'); }
  }

  // 4. 清掉已到期的項目
  for (const k of Object.keys(out.coupons)) out.coupons[k] = (out.coupons[k] || []).filter(c => alive(c.until));
  out.promos = (out.promos || []).filter(p => alive(p.until));

  const changes = log.filter(l => l.level === 'change').length;
  const errors = log.filter(l => l.level === 'error').length;
  out.note = errors ? `部分來源暫時無法更新（${errors} 項），已沿用前次資料` : (changes ? `本次更新 ${changes} 項` : '資料與前次相同');

  if (savedImages.length) {
    await fs.mkdir('data/coupons', {recursive: true});
    for (const {file, buf} of savedImages) await fs.writeFile(file, buf);
  }
  await fs.writeFile('data/data.json', JSON.stringify(out, null, 1));
  await fs.writeFile('data/update-log.json', JSON.stringify({at: out.updated_at, log}, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['## 更新結果', '', ...log.map(l => `- **${l.level}** ${l.msg}`)].join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
  if (!ok) { console.error('所有來源都失敗'); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
