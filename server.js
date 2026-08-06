const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const KEY_FILE = path.join(DATA_DIR, 'apikey.txt');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
};

// ── Products store (file-based, permanent) ──
function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE))
      return JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
  } catch (e) { console.error('products.json 로드 실패:', e.message); }
  return {};
}
function saveProducts() {
  try { fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products), 'utf8'); }
  catch (e) { console.error('products.json 저장 실패:', e.message); }
}
const products = loadProducts();

// ── Shares store (file-based, permanent) ──
function loadShares() {
  try {
    if (fs.existsSync(SHARES_FILE))
      return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
  } catch (e) { console.error('shares.json 로드 실패:', e.message); }
  return {};
}
function saveShares() {
  try { fs.writeFileSync(SHARES_FILE, JSON.stringify(shares), 'utf8'); }
  catch (e) { console.error('shares.json 저장 실패:', e.message); }
}
const shares = loadShares();

function collectBody(req, cb) {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', e => cb(e));
}

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

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  function json(status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  // ── API key ──
  if (pathname === '/save-key' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { key } = JSON.parse(body);
        fs.writeFileSync(KEY_FILE, key.replace(/[^a-zA-Z0-9\-_]/g, ''));
        json(200, { ok: true });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  if (pathname === '/check-key' && req.method === 'GET') {
    const key = getApiKey();
    json(200, { exists: !!key, source: process.env.ANTHROPIC_API_KEY ? 'env' : 'file' });
    return;
  }

  // ── Anthropic proxy ──
  if (pathname === '/api' && req.method === 'POST') {
    const apiKey = getApiKey();
    if (!apiKey) { json(400, { error: 'API 키가 설정되지 않았습니다.' }); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const payload = Buffer.from(body, 'utf8');
      callAnthropic(apiKey, payload, (err, statusCode, data) => {
        if (err) { json(500, { error: err.message }); return; }
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    return;
  }

  // ── 법령 API 프록시 ──
  if (pathname === '/law-api' && req.method === 'GET') {
    const queryParams = Object.assign({}, parsed.query);
    const service = queryParams.service;
    if (!service) { json(400, { error: 'service 파라미터가 필요합니다.' }); return; }
    delete queryParams.service;
    const restParams = Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const lawPath = `/DRF/${service}.do?OC=lawcheck&type=JSON${restParams ? '&' + restParams : ''}`;
    const lawReq = https.request({ hostname: 'www.law.go.kr', path: lawPath, method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, lawRes => {
      let data = '';
      lawRes.on('data', d => data += d);
      lawRes.on('end', () => { res.writeHead(lawRes.statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(data); });
    });
    lawReq.on('error', e => json(500, { error: e.message }));
    lawReq.end();
    return;
  }

  // ── 이미지 프록시 ──
  if (pathname === '/fetch-image' && req.method === 'GET') {
    const imgUrl = parsed.query.url;
    if (!imgUrl) { json(400, { error: 'url 파라미터가 필요합니다.' }); return; }
    function fetchImage(targetUrl, left) {
      let pu; try { pu = new URL(targetUrl); } catch(e) { json(400, { error: '유효하지 않은 URL' }); return; }
      const proto = pu.protocol === 'https:' ? https : http;
      const r = proto.request({ hostname: pu.hostname, path: pu.pathname + pu.search, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': pu.origin }, rejectUnauthorized: false }, imgRes => {
        if ([301,302,307,308].includes(imgRes.statusCode) && imgRes.headers.location) {
          imgRes.resume();
          if (left <= 0) { json(500, { error: '리다이렉트 횟수 초과' }); return; }
          const loc = imgRes.headers.location;
          fetchImage(loc.startsWith('http') ? loc : new URL(loc, targetUrl).href, left - 1);
          return;
        }
        res.writeHead(imgRes.statusCode, { 'Content-Type': imgRes.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        imgRes.pipe(res);
      });
      r.on('error', e => json(500, { error: e.message }));
      r.end();
    }
    fetchImage(imgUrl, 5);
    return;
  }

  // ════════════════════════════════
  //  SHARES API
  // ════════════════════════════════

  // 공유 링크 생성
  if (pathname === '/api/share' && req.method === 'POST') {
    collectBody(req, (err, body) => {
      if (err) { json(500, { error: err.message }); return; }
      try {
        const { pages } = JSON.parse(body);
        const id = crypto.randomUUID();
        const thumb = pages && pages[0] && pages[0].imageDataUrl ? pages[0].imageDataUrl.slice(0, 200) + '...' : null;
        const pageCount = pages ? pages.length : 0;
        const annotationCount = pages ? pages.reduce((s, p) => s + (p.annotations || []).length, 0) : 0;
        shares[id] = { id, pages: pages || [], createdAt: Date.now(), pageCount, annotationCount, thumb: pages && pages[0] ? pages[0].imageDataUrl : null };
        saveShares();
        json(200, { url: '/view/' + id });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  // 공유 이력 목록
  if (pathname === '/api/shares' && req.method === 'GET') {
    const list = Object.values(shares).map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      pageCount: s.pageCount || 0,
      annotationCount: s.annotationCount || 0,
      thumb: s.thumb
    })).sort((a, b) => b.createdAt - a.createdAt);
    json(200, list);
    return;
  }

  // 공유 이력 삭제
  const shareDelMatch = pathname.match(/^\/api\/shares\/([^/]+)$/);
  if (shareDelMatch && req.method === 'DELETE') {
    const id = shareDelMatch[1];
    if (shares[id]) { delete shares[id]; saveShares(); }
    json(200, { ok: true });
    return;
  }

  // 공유 뷰어 데이터
  const viewMatch = pathname.match(/^\/api\/view\/([^/]+)$/);
  if (viewMatch && req.method === 'GET') {
    const id = viewMatch[1];
    if (!shares[id]) { json(404, { error: '공유 링크를 찾을 수 없습니다.' }); return; }
    json(200, shares[id]);
    return;
  }

  // 공유 뷰어 페이지
  if (pathname.match(/^\/view\/[^/]+$/) && !pathname.startsWith('/view/product/') && req.method === 'GET') {
    const vp = path.join(__dirname, 'viewer.html');
    if (fs.existsSync(vp)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(vp).pipe(res); }
    else { res.writeHead(404); res.end('viewer.html not found'); }
    return;
  }

  // ════════════════════════════════
  //  PRODUCTS API
  // ════════════════════════════════

  // 제품 목록
  if (pathname === '/api/products' && req.method === 'GET') {
    const list = Object.entries(products).map(([id, p]) => {
      const meta = (r) => {
        if (!p.rounds || !p.rounds[r]) return null;
        const rd = p.rounds[r];
        return { updatedAt: rd.updatedAt, pageCount: (rd.pages||[]).length, annotCount: (rd.pages||[]).reduce((s,pg) => s + (pg.annotations||[]).length, 0), completed: !!rd.completed };
      };
      return { id, name: p.name, createdAt: p.createdAt, rounds: { 1: meta(1), 2: meta(2) } };
    }).sort((a, b) => b.createdAt - a.createdAt);
    json(200, list);
    return;
  }

  // 제품 생성
  if (pathname === '/api/products' && req.method === 'POST') {
    collectBody(req, (err, body) => {
      if (err) { json(500, { error: err.message }); return; }
      try {
        const { name } = JSON.parse(body);
        if (!name || !name.trim()) { json(400, { error: '제품명을 입력하세요.' }); return; }
        const id = crypto.randomUUID();
        products[id] = { name: name.trim(), createdAt: Date.now(), rounds: {} };
        saveProducts();
        json(200, { id, name: products[id].name, createdAt: products[id].createdAt });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  // 제품 상세
  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch) {
    const id = productMatch[1];
    if (req.method === 'GET') {
      if (!products[id]) { json(404, { error: '제품을 찾을 수 없습니다.' }); return; }
      json(200, { id, ...products[id] });
      return;
    }
    if (req.method === 'PATCH') {
      collectBody(req, (err, body) => {
        if (err) { json(500, { error: err.message }); return; }
        try {
          if (!products[id]) { json(404, { error: '제품을 찾을 수 없습니다.' }); return; }
          const { name } = JSON.parse(body);
          if (name && name.trim()) { products[id].name = name.trim(); saveProducts(); }
          json(200, { ok: true });
        } catch (e) { json(400, { error: e.message }); }
      });
      return;
    }
    if (req.method === 'DELETE') {
      if (!products[id]) { json(404, { error: '제품을 찾을 수 없습니다.' }); return; }
      delete products[id];
      saveProducts();
      json(200, { ok: true });
      return;
    }
  }

  // 차수 완료 상태 토글
  const roundCompleteMatch = pathname.match(/^\/api\/products\/([^/]+)\/rounds\/(\d+)\/complete$/);
  if (roundCompleteMatch && req.method === 'PATCH') {
    const [, id, round] = roundCompleteMatch;
    if (!products[id]) { json(404, { error: '제품을 찾을 수 없습니다.' }); return; }
    collectBody(req, (err, body) => {
      if (err) { json(500, { error: err.message }); return; }
      try {
        const { completed } = JSON.parse(body);
        if (!products[id].rounds) products[id].rounds = {};
        if (!products[id].rounds[round]) products[id].rounds[round] = { pages: [], updatedAt: Date.now() };
        products[id].rounds[round].completed = !!completed;
        saveProducts();
        json(200, { ok: true });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  // 차수 저장
  const roundMatch = pathname.match(/^\/api\/products\/([^/]+)\/rounds\/(\d+)$/);
  if (roundMatch && req.method === 'PUT') {
    const [, id, round] = roundMatch;
    if (!products[id]) { json(404, { error: '제품을 찾을 수 없습니다.' }); return; }
    collectBody(req, (err, body) => {
      if (err) { json(500, { error: err.message }); return; }
      try {
        const { pages } = JSON.parse(body);
        if (!products[id].rounds) products[id].rounds = {};
        products[id].rounds[round] = { pages: pages || [], updatedAt: Date.now() };
        saveProducts();
        json(200, { ok: true });
      } catch (e) { json(400, { error: e.message }); }
    });
    return;
  }

  // 제품 뷰어 페이지
  if (pathname.match(/^\/view\/product\/[^/]+$/) && req.method === 'GET') {
    const vp = path.join(__dirname, 'viewer.html');
    if (fs.existsSync(vp)) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(vp).pipe(res); }
    else { res.writeHead(404); res.end('viewer.html not found'); }
    return;
  }

  // ── 정적 파일 서빙 ──
  let filePath = pathname === '/' ? '/index.html' : pathname;
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
  console.log('  상세페이지 주석 검토 서버 실행 중');
  console.log(`  포트: ${PORT}`);
  console.log('');
});
