const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const KEY_FILE = path.join(__dirname, 'apikey.txt');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
};

// Share store: id -> { imageDataUrl, annotations, createdAt }
const shareStore = new Map();

setInterval(() => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, entry] of shareStore.entries()) {
    if (entry.createdAt < cutoff) shareStore.delete(id);
  }
}, 60 * 60 * 1000);

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').replace(/[^a-zA-Z0-9\-_]/g, '');
  return null;
}

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

function collectBody(req, cb) {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', e => cb(e));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

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

  if (parsed.pathname === '/check-key' && req.method === 'GET') {
    const key = getApiKey();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      exists: !!key,
      source: process.env.ANTHROPIC_API_KEY ? 'env' : 'file'
    }));
    return;
  }

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

  // 주석 공유 저장
  if (parsed.pathname === '/api/share' && req.method === 'POST') {
    collectBody(req, (err, body) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      try {
        const parsed2 = JSON.parse(body);
        let shareData;
        if (Array.isArray(parsed2.pages) && parsed2.pages.length > 0) {
          shareData = { pages: parsed2.pages };
        } else if (parsed2.imageDataUrl && Array.isArray(parsed2.annotations)) {
          shareData = { pages: [{ imageDataUrl: parsed2.imageDataUrl, annotations: parsed2.annotations }] };
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '잘못된 요청입니다.' }));
          return;
        }
        const id = crypto.randomUUID();
        shareStore.set(id, { ...shareData, createdAt: Date.now() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, url: '/view/' + id }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 주석 공유 조회
  if (parsed.pathname.startsWith('/api/view/') && req.method === 'GET') {
    const id = parsed.pathname.slice('/api/view/'.length);
    const entry = shareStore.get(id);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '링크가 만료되었거나 존재하지 않습니다.' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pages: entry.pages }));
    return;
  }

  // 주석 뷰어 페이지
  if (parsed.pathname.startsWith('/view/') && req.method === 'GET') {
    const viewerPath = path.join(__dirname, 'viewer.html');
    if (fs.existsSync(viewerPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(viewerPath).pipe(res);
    } else {
      res.writeHead(404); res.end('viewer.html not found');
    }
    return;
  }

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

  if (parsed.pathname === '/fetch-image' && req.method === 'GET') {
    const imgUrl = parsed.query.url;
    if (!imgUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url 파라미터가 필요합니다.' }));
      return;
    }
    function fetchImage(targetUrl, redirectsLeft) {
      let pu;
      try { pu = new URL(targetUrl); } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '유효하지 않은 URL: ' + targetUrl }));
        return;
      }
      const proto = pu.protocol === 'https:' ? https : http;
      const imgReq = proto.request({
        hostname: pu.hostname,
        path: pu.pathname + pu.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': pu.origin },
        rejectUnauthorized: false,
      }, imgRes => {
        if ([301, 302, 307, 308].includes(imgRes.statusCode) && imgRes.headers.location) {
          imgRes.resume();
          if (redirectsLeft <= 0) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '리다이렉트 횟수 초과' }));
            return;
          }
          const loc = imgRes.headers.location;
          const next = loc.startsWith('http') ? loc : new URL(loc, targetUrl).href;
          fetchImage(next, redirectsLeft - 1);
          return;
        }
        const ct = imgRes.headers['content-type'] || 'image/jpeg';
        res.writeHead(imgRes.statusCode, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=86400' });
        imgRes.pipe(res);
      });
      imgReq.on('error', e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      imgReq.end();
    }
    fetchImage(imgUrl, 5);
    return;
  }

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
