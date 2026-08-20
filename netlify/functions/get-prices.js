// 前日終値を推定する。meta系フィールドが無い場合は日足終値配列から求める。
// 「配列の最後」や「価格が一致するか」で判定するのは、データの反映タイミング次第でズレることがあるため、
// 取引所のローカル日付（gmtoffsetで補正）で「今日の足」を明確に除外し、直前の営業日の終値を使う。
function localDateKey(epochSec, gmtoffsetSec) {
  const d = new Date((epochSec + (gmtoffsetSec || 0)) * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}
function derivePrevCloseFromCandles(meta, result) {
  const closes = result?.indicators?.quote?.[0]?.close;
  const timestamps = result?.timestamp;
  if (!Array.isArray(closes) || !Array.isArray(timestamps)) return null;
  const pairs = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null && timestamps[i] != null) pairs.push({ ts: timestamps[i], close: closes[i] });
  }
  if (!pairs.length) return null;
  const gmtoffset = meta?.gmtoffset || 0;
  const nowTs = meta?.regularMarketTime;
  const todayKey = nowTs != null ? localDateKey(nowTs, gmtoffset) : null;
  // 今日の日付と同じ足（形成中 or 反映済みどちらでも）は除外し、直前の営業日を使う
  let pool = (todayKey ? pairs.filter(p => localDateKey(p.ts, gmtoffset) !== todayKey) : pairs.slice());
  if (!pool.length) pool = pairs.slice();
  // 安全策：日付判定がズレて結局「現在値と同じ足」を拾ってしまった場合は、もう1つ前を使う
  const price = meta?.regularMarketPrice;
  while (pool.length > 1 && price != null) {
    const candidate = pool[pool.length - 1].close;
    const tol = Math.max(1e-6, Math.abs(candidate) * 0.0005);
    if (Math.abs(candidate - price) <= tol) {
      pool = pool.slice(0, -1);
    } else {
      break;
    }
  }
  return pool[pool.length - 1].close;
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
    const prices = {};
    const prevClose = {};

    // 為替レート取得
    try {
      const fxRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDJPY=X?interval=1d&range=1d', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Referer': 'https://finance.yahoo.com'
        }
      });
      const fxData = await fxRes.json();
      const fxRate = fxData?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (fxRate) prices['USDJPY'] = fxRate;
    } catch(e) {
      console.warn('FX fetch failed:', e.message);
    }

    // 主要指数取得（日経平均・NYダウ・S&P500・NY金先物）
    const indices = [
      { key: 'N225', symbol: '^N225' },
      { key: 'DJI', symbol: '^DJI' },
      { key: 'SP500', symbol: '^GSPC' },
      { key: 'GOLD', symbol: 'GC=F' }
    ];
    for (const { key, symbol } of indices) {
      try {
        const idxRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Referer': 'https://finance.yahoo.com'
          }
        });
        const idxData = await idxRes.json();
        const idxResult = idxData?.chart?.result?.[0];
        const meta = idxResult?.meta;
        const val = meta?.regularMarketPrice || meta?.previousClose;
        if (val) prices[key] = val;
        let idxPc = meta?.previousClose || meta?.chartPreviousClose || meta?.regularMarketPreviousClose;
        if (!idxPc) {
          idxPc = derivePrevCloseFromCandles(meta, idxResult);
        }
        if (idxPc) prevClose[key] = idxPc;
      } catch(e) {
        console.warn(`Index fetch failed (${key}):`, e.message);
      }
    }

    // 株価取得（現在値 + 前日終値）
    for (const { code, market } of (codes || [])) {
      try {
        const symbol = market === 'jp' ? code + '.T' : code;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Referer': 'https://finance.yahoo.com'
          }
        });
        const data = await res.json();
        const result = data?.chart?.result?.[0];
        const meta = result?.meta;
        const price = meta?.regularMarketPrice || meta?.previousClose;
        if (price) prices[code] = price;
        // previousClose: まずmetaのフィールドを試し、無ければ日足終値配列から推定
        let pc = meta?.previousClose || meta?.chartPreviousClose || meta?.regularMarketPreviousClose;
        if (!pc) {
          pc = derivePrevCloseFromCandles(meta, result);
        }
        if (pc) prevClose[code] = pc;
      } catch(e) {
        console.warn(`Failed ${code}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ prices, prevClose }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
