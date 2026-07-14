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

    await Promise.all((codes || []).map(async ({ code }) => {
      try {
        const url = `https://f.irbank.net/files/${code}/fy-stock-dividend.json`;
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json,text/plain,*/*',
            'Accept-Language': 'ja,en;q=0.8',
            'Referer': 'https://irbank.net/'
          }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const item = data && data.item;
        if (item) {
          // キーは "YYYY/MM" 形式。新しい年度から順に、有効な一株配当（数値）を探す。
          // 最新行は {"0":100,...,"備考":"予想"} のようなオブジェクト形式のことがある。
          const years = Object.keys(item).sort(); // 昇順（古い→新しい）
          let found = false;
          for (let i = years.length - 1; i >= 0; i--) {
            const row = item[years[i]];
            const raw = Array.isArray(row) ? row[0] : row['0'];
            const val = parseFloat(raw);
            if (!isNaN(val) && val > 0) {
              dividends[code] = val;
              found = true;
              break;
            }
          }
          if (!found) errors[code] = 'no valid value in item';
        } else {
          errors[code] = 'no item field in response';
        }
      } catch (e) {
        errors[code] = e.message;
      }
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ dividends, errors }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
