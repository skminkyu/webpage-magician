const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const KEY_FILE = path.join(__dirname, 'apikey.txt');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
};

// API 키 해석: 환경변수 우선, 없으면 apikey.txt 파일
function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').replace(/[^a-zA-Z0-9\-_]/g, '');
  return null;
}

// Anthropic API 호출 (직접 연결)
function callAnthropic(apiKey, payload, callback) {
  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  };
  const apiReq = https.request(options, apiRes => {
    let data = '';
    apiRes.on('data', d => data += d);
    apiRes.on('end', () => callback(null, apiRes.statusCode, data));
  });
  apiReq.on('error', e => callback(e));
  apiReq.write(payload);
  apiReq.end();
}

// ─── HTTP 서버 ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // API 키 저장 (로컬 개발용)
  if (parsed.pathname === '/save-key' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { key } = JSON.parse(body);
        fs.writeFileSync(KEY_FILE, key.replace(/[^a-zA-Z0-9\-_]/g, ''));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API 키 상태 확인
  if (parsed.pathname === '/check-key' && req.method === 'GET') {
    const key = getApiKey();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      exists: !!key,
      source: process.env.ANTHROPIC_API_KEY ? 'env' : 'file'
    }));
    return;
  }

  // Anthropic API 프록시
  if (parsed.pathname === '/api' && req.method === 'POST') {
    const apiKey = getApiKey();
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API 키가 설정되지 않았습니다. Railway 대시보드에서 ANTHROPIC_API_KEY 환경변수를 설정하세요.' }));
      return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const payload = Buffer.from(body, 'utf8');
      callAnthropic(apiKey, payload, (err, statusCode, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    return;
  }

  // 법령 API 프록시 (law.go.kr)
  if (parsed.pathname === '/law-api' && req.method === 'GET') {
    const queryParams = Object.assign({}, parsed.query);
    const service = queryParams.service;
    if (!service) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'service 파라미터가 필요합니다.' }));
      return;
    }
    delete queryParams.service;

    const restParams = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const lawPath = `/DRF/${service}.do?OC=lawcheck&type=JSON${restParams ? '&' + restParams : ''}`;

    const lawOptions = {
      hostname: 'www.law.go.kr',
      path: lawPath,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      rejectUnauthorized: false,
    };

    const lawReq = https.request(lawOptions, lawRes => {
      let data = '';
      lawRes.on('data', d => data += d);
      lawRes.on('end', () => {
        res.writeHead(lawRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(data);
      });
    });
    lawReq.on('error', e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    lawReq.end();
    return;
  }

  // 이미지 URL 프록시
  if (parsed.pathname === '/fetch-image' && req.method === 'GET') {
    const imgUrl = parsed.query.url;
    if (!imgUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url 파라미터가 필요합니다.' }));
      return;
    }
    let parsedUrl;
    try { parsedUrl = new URL(imgUrl); } catch(e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '유효하지 않은 URL입니다.' }));
      return;
    }
    const protocol = parsedUrl.protocol === 'https:' ? https : require('http');
    const imgReq = protocol.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': parsedUrl.origin },
    }, imgRes => {
      const ct = imgRes.headers['content-type'] || 'image/jpeg';
      res.writeHead(imgRes.statusCode, {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
      });
      imgRes.pipe(res);
    });
    imgReq.on('error', e => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    imgReq.end();
    return;
  }

  // 정적 파일 서빙
  let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  filePath = path.join(__dirname, decodeURIComponent(filePath));
  const ext = path.extname(filePath);

  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain; charset=utf-8' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  상세페이지 검수 도구 서버 실행 중');
  console.log(`  포트: ${PORT}`);
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('  API 키: 환경변수에서 로드됨');
  } else if (fs.existsSync(KEY_FILE)) {
    console.log('  API 키: apikey.txt 파일에서 로드됨');
  } else {
    console.log('  API 키: 미설정 (ANTHROPIC_API_KEY 환경변수를 설정하세요)');
  }
  console.log('');
});
