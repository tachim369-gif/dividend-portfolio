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
          const closes = idxResult?.indicators?.quote?.[0]?.close;
          if (Array.isArray(closes)) {
            const valid = closes.filter(v => v != null);
            if (valid.length >= 2) idxPc = valid[valid.length - 2];
          }
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
        // previousClose: まずmetaのフィールドを試し、無ければ日足終値配列の「最新の1つ前」を使う
        let pc = meta?.previousClose || meta?.chartPreviousClose || meta?.regularMarketPreviousClose;
        if (!pc) {
          const closes = result?.indicators?.quote?.[0]?.close;
          if (Array.isArray(closes)) {
            const valid = closes.filter(v => v != null);
            if (valid.length >= 2) pc = valid[valid.length - 2];
          }
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
