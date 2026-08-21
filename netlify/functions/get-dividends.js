/* ── 共通ユーティリティ ── */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Netlify Functionsの実行時間上限に配慮し、締め切り時刻を過ぎたら早めに諦める
async function withRetry(fn, maxAttempts, deadline) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) {
      throw lastErr || new Error('deadline exceeded');
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts && Date.now() < deadline) {
        await sleep(Math.min(500 * attempt + Math.floor(Math.random() * 400), Math.max(0, deadline - Date.now())));
      }
    }
  }
  throw lastErr;
}

// 同時実行数を絞ってタスクを処理する（サーバー側のアクセス制限を避けるため）
async function runWithConcurrency(items, worker, concurrency) {
  let idx = 0;
  async function runNext() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  }
  const pool = [];
  const n = Math.min(concurrency, items.length);
  for (let i = 0; i < n; i++) pool.push(runNext());
  await Promise.all(pool);
}

/* ── 日本株：IRBANKの配当データファイルを利用 ── */
async function fetchFollow(url, options, maxRedirects) {
  let currentUrl = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(currentUrl, Object.assign({}, options, { redirect: 'manual' }));
    if ([301, 302, 303, 307, 308].indexOf(res.status) !== -1) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      currentUrl = new URL(loc, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error('too many redirects');
}

const JP_HISTORY_YEARS = 6;

// 戻り値: { val: 一株配当（円）, month: 決算月（1-12、取得できなければnull）, history: [{period,val,note}] 新しい順 }
// 配当データが無い場合は val:0 を返す（確定値）。通信エラー・想定外の応答の場合は例外を投げる（呼び出し側でリトライ対象）。
async function fetchDividendJp(code) {
  const url = `https://f.irbank.net/files/${code}/fy-stock-dividend.json`;
  const res = await fetchFollow(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'ja,en;q=0.8',
      'Referer': 'https://irbank.net/'
    }
  }, 5);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const item = data && data.item;
  if (!item) throw new Error('no item field in response');

  // キーは "YYYY/MM" 形式。MM部分がそのまま決算月。
  const years = Object.keys(item).sort(); // 昇順（古い→新しい）
  let month = null;
  if (years.length) {
    const m = parseInt((years[years.length - 1].split('/')[1] || ''), 10);
    if (!isNaN(m)) month = m;
  }

  // 新しい年度から順に、有効な一株配当（数値）と備考（予想など）を集める
  const history = [];
  let val = 0;
  let valSet = false;
  for (let i = years.length - 1; i >= 0 && history.length < JP_HISTORY_YEARS; i--) {
    const period = years[i];
    const row = item[period];
    const raw = Array.isArray(row) ? row[0] : row['0'];
    const v = parseFloat(raw);
    if (isNaN(v)) continue;
    const note = (!Array.isArray(row) && row['備考']) ? String(row['備考']) : '';
    history.push({ period, val: v, note });
    if (!valSet && v > 0) { val = v; valSet = true; }
  }
  return { val, month, history };
}

/* ── 米国株：Yahoo Financeの配当イベント（実績）を利用 ── */
// 戻り値: { val: 直近12ヶ月の一株配当合計（ドル）, count: 直近1年の配当回数, history: [{date,val}] 新しい順（最大16件） }
async function fetchDividendUs(code) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=6y&events=div`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Referer': 'https://finance.yahoo.com'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) throw new Error('no result field in response');

  const divEvents = result.events && result.events.dividends;
  if (!divEvents) return { val: 0, count: 0, history: [] }; // 配当イベントが無い＝無配と確定

  const all = [];
  Object.values(divEvents).forEach(ev => {
    const amount = parseFloat(ev && ev.amount);
    const ts = ev && (ev.date != null ? ev.date : null);
    if (isNaN(amount) || amount <= 0 || ts == null) return;
    const d = new Date(ts * 1000);
    all.push({ ts, date: d.toISOString().slice(0, 10), val: Math.round(amount * 100) / 100 });
  });
  all.sort((a, b) => b.ts - a.ts); // 新しい順
  const history = all.slice(0, 16).map(({ date, val }) => ({ date, val }));

  if (!all.length) return { val: 0, count: 0, history };

  // 年間配当額 = 直近の1回あたり配当額 × 年間支払回数。
  // 「直近12ヶ月の実績合計」だと集計ウィンドウの端で支払いが1回落ちるだけで見かけ上「減配」になってしまうため、
  // 直近数回の支払い間隔から支払い頻度（毎月/四半期/半期/年1回）を推定し、それに最新の1回分の金額を掛けて算出する。
  const sample = all.slice(0, 8); // 直近最大8回ぶんの間隔を見る
  const gaps = [];
  for (let i = 0; i < sample.length - 1; i++) {
    gaps.push((sample[i].ts - sample[i + 1].ts) / (24 * 3600));
  }
  let freq = 1;
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    const medianGap = gaps[Math.floor(gaps.length / 2)];
    if (medianGap <= 45) freq = 12;
    else if (medianGap <= 135) freq = 4;
    else if (medianGap <= 270) freq = 2;
    else freq = 1;
  }
  const latest = all[0].val;
  const val = Math.round(latest * freq * 100) / 100;
  return { val, count: freq, history };
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { codes } = JSON.parse(event.body || '{}');
    const dividends = {};
    const months = {};
    const counts = {};
    const history = {};
    const errors = {};
    const maxAttempts = 3;
    const concurrency = 8;
    const deadline = Date.now() + 15000; // 全体の締め切り（15秒、Netlify関数のタイムアウト対策）

    await runWithConcurrency(codes || [], async ({ code, market }) => {
      try {
        if (market === 'us') {
          const { val, count, history: h } = await withRetry(() => fetchDividendUs(code), maxAttempts, deadline);
          dividends[code] = val; // 0も含めて「取得成功」
          counts[code] = count;
          if (h && h.length) history[code] = h;
        } else {
          const { val, month, history: h } = await withRetry(() => fetchDividendJp(code), maxAttempts, deadline);
          dividends[code] = val; // 0も含めて「取得成功」
          if (month != null) months[code] = month;
          if (h && h.length) history[code] = h;
        }
      } catch (e) {
        errors[code] = e.message;
      }
    }, concurrency);

    return { statusCode: 200, headers, body: JSON.stringify({ dividends, months, counts, history, errors }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
