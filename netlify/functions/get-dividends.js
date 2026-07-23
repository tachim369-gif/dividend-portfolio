/* ── 共通ユーティリティ ── */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function withRetry(fn, maxAttempts) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) {
        await sleep(400 * attempt + Math.floor(Math.random() * 300));
      }
    }
  }
  throw lastErr;
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
  throw new Error('no valid value in item');
}

/* ── 米国株：Yahoo Financeの配当イベント（実績）を直近12ヶ月分合計 ── */
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
  const divEvents = result && result.events && result.events.dividends;
  if (!divEvents) throw new Error('no dividend events in response');

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
  if (count === 0) throw new Error('no recent dividend events');
  return Math.round(total * 100) / 100;
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

    await Promise.all((codes || []).map(async ({ code, market }) => {
      try {
        const val = await withRetry(
          () => (market === 'us' ? fetchDividendUs(code) : fetchDividendJp(code)),
          maxAttempts
        );
        dividends[code] = val;
      } catch (e) {
        errors[code] = e.message;
      }
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ dividends, errors }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
