// Cloudflare Worker：接收網站傳來的照片，交給 Claude 辨識店家，再把結果回傳。
// API 金鑰只存在這裡（環境變數 ANTHROPIC_API_KEY），不會出現在網站上。
//
// 需要設定的變數（Cloudflare 後台 → Worker → Settings → Variables and Secrets）：
//   ANTHROPIC_API_KEY  （Secret，必填）你的 Claude API 金鑰
//   ALLOWED_ORIGIN     （必填）你的網站網址，例如 https://你的帳號.github.io
//   MODEL              （選填）預設 claude-haiku-5-5

const CATS = ['electronics', 'drugstore', 'discount', 'convenience', 'department', 'apparel', 'restaurant', 'themepark', 'outlet', 'dutyfree', 'supermarket', 'transit', 'hotel', 'other'];
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {status, headers: {...cors, 'Content-Type': 'application/json; charset=utf-8'}});

    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    if (req.method !== 'POST') return json({error: 'method_not_allowed'}, 405);
    if (!okOrigin) return json({error: 'forbidden_origin'}, 403);
    if (!env.ANTHROPIC_API_KEY) return json({error: 'server_not_configured'}, 500);

    // 選用：若有綁定 Rate Limiting（名稱 RATE_LIMITER），限制每個 IP 的頻率
    if (env.RATE_LIMITER) {
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const {success} = await env.RATE_LIMITER.limit({key: ip});
      if (!success) return json({error: 'rate_limited'}, 429);
    }

    let body;
    try { body = await req.json(); } catch { return json({error: 'bad_request'}, 400); }
    const {image, mediaType, stores} = body || {};
    if (typeof image !== 'string' || !image.length || image.length > 6_000_000) return json({error: 'bad_image'}, 400);
    if (!TYPES.includes(mediaType)) return json({error: 'bad_image'}, 400);

    const list = (Array.isArray(stores) ? stores : []).slice(0, 150)
      .map(s => `${String(s.id || '').slice(0, 40)}：${String(s.name || '').slice(0, 60)} / ${String(s.jp || '').slice(0, 60)}`).join('\n');

    const prompt = `你會看到一張在日本拍的圖片：可能是店家招牌、店內、收據，或手機地圖 App 的截圖。
請判斷使用者現在所在的店家。若是地圖截圖，以畫面中央、紅色定位針或被選取的地點為準。
已知店家清單（id：名稱）：
${list}

分類代碼：${CATS.join(', ')}

只回覆一個 JSON 物件，不要其他文字：
{"id": "清單中的 id，若都不符合則為 null", "name": "辨識到的店名（優先用繁體中文，沒有就用日文原名）", "jp": "日文店名或空字串", "category": "分類代碼之一", "confidence": "high 或 medium 或 low", "note": "一句繁體中文說明判斷依據"}
如果圖中看不出任何店家，id 設為 null、name 設為空字串。`;

    let r;
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
        body: JSON.stringify({
          model: env.MODEL || 'claude-haiku-5-5',
          max_tokens: 400,
          messages: [{role: 'user', content: [
            {type: 'image', source: {type: 'base64', media_type: mediaType, data: image}},
            {type: 'text', text: prompt}
          ]}]
        })
      });
    } catch { return json({error: 'upstream_unreachable'}, 502); }

    if (r.status === 429 || r.status === 529) return json({error: 'busy'}, 503);
    if (!r.ok) return json({error: 'upstream_error', status: r.status}, 502);

    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    try {
      const clean = text.replace(/```json|```/g, '');
      const res = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}') + 1));
      return json({
        id: res.id ? String(res.id).slice(0, 40) : null,
        name: String(res.name || '').slice(0, 80),
        jp: String(res.jp || '').slice(0, 80),
        category: CATS.includes(res.category) ? res.category : 'other',
        confidence: ['high', 'medium', 'low'].includes(res.confidence) ? res.confidence : 'low',
        note: String(res.note || '').slice(0, 120)
      });
    } catch { return json({error: 'bad_model_output'}, 502); }
  }
};
