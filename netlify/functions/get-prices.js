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

    // 株価取得
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
        const meta = data?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice || meta?.previousClose;
        if (price) prices[code] = price;
      } catch(e) {
        console.warn(`Failed ${code}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ prices }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
