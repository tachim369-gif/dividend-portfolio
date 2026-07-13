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

    for (const { code } of (codes || [])) {
      try {
        const url = `https://f.irbank.net/files/${code}/fy-stock-dividend.json`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const item = data && data.item;
        if (item) {
          // キーは "YYYY/MM" 形式。新しい年度から順に、有効な一株配当（数値）を探す。
          // 最新行は {"0":100,...,"備考":"予想"} のようなオブジェクト形式のことがある。
          const years = Object.keys(item).sort(); // 昇順（古い→新しい）
          for (let i = years.length - 1; i >= 0; i--) {
            const row = item[years[i]];
            const raw = Array.isArray(row) ? row[0] : row['0'];
            const val = parseFloat(raw);
            if (!isNaN(val) && val > 0) {
              dividends[code] = val;
              break;
            }
          }
        }
      } catch (e) {
        console.warn(`Failed ${code}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 250));
    }

    return { statusCode: 200, headers, body: JSON.stringify({ dividends }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
