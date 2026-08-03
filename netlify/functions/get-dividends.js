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

// 戻り値: 一株配当（円）。取得は成功したが配当データが無い場合は0を返す（確定値）。
// 通信エラー・想定外の応答の場合は例外を投げる（呼び出し側でリトライ対象）。
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

  // キーは "YYYY/MM" 形式。新しい年度から順に、有効な一株配当（数値）を探す。
  // 最新行は {"0":100,...,"備考":"予想"} のようなオブジェクト形式のことがある。
  const years = Object.keys(item).sort(); // 昇順（古い→新しい）
  for (let i = years.length - 1; i >= 0; i--) {
    const row = item[years[i]];
    const raw = Array.isArray(row) ? row[0] : row['0'];
    const val = parseFloat(raw);
    if (!isNaN(val) && val > 0) return val;
  }
  // データ取得は成功したが、どの年度にも有効な配当額が無い → 配当なしと確定
  return 0;
}

/* ── 米国株：Yahoo Financeの配当イベント（実績）を直近12ヶ月分合計 ── */
// 戻り値: 一株配当（ドル）。配当イベントが無い銘柄（無配企業など）は0を返す（確定値）。
async function fetchDividendUs(code) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}?interval=1d&range=1y&events=div`;
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
  if (!divEvents) return 0; // 配当イベントが無い＝無配と確定

  const nowSec = Date.now() / 1000;
  const oneYearAgoSec = nowSec - 365 * 24 * 3600;
  let total = 0;
  let count = 0;
  Object.values(divEvents).forEach(ev => {
    const amount = parseFloat(ev && ev.amount);
    const ts = ev && (ev.date != null ? ev.date : null);
    if (!isNaN(amount) && amount > 0 && (ts == null || ts >= oneYearAgoSec)) {
      total += amount;
      count++;
    }
  });
  return count > 0 ? Math.round(total * 100) / 100 : 0; // 直近1年に配当が無ければ0と確定
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
    const errors = {};
    const maxAttempts = 3;
    const concurrency = 8;
    const deadline = Date.now() + 15000; // 全体の締め切り（15秒、Netlify関数のタイムアウト対策）

    await runWithConcurrency(codes || [], async ({ code, market }) => {
      try {
        const val = await withRetry(
          () => (market === 'us' ? fetchDividendUs(code) : fetchDividendJp(code)),
          maxAttempts,
          deadline
        );
        dividends[code] = val; // 0も含めて「取得成功」
      } catch (e) {
        errors[code] = e.message;
      }
    }, concurrency);

    return { statusCode: 200, headers, body: JSON.stringify({ dividends, errors }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
