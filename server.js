const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const KEY_FILE = path.join(__dirname, 'apikey.txt');

// 사내 프록시 자동 감지 (환경변수 또는 proxy.txt 파일)
function getProxy() {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY  || process.env.http_proxy  || '';
  if (envProxy) return envProxy;
  const proxyFile = path.join(__dirname, 'proxy.txt');
  if (fs.existsSync(proxyFile)) return fs.readFileSync(proxyFile, 'utf8').trim();
  return '';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
};

// Anthropic API 호출 (프록시 CONNECT 터널 자동 지원)
function callAnthropic(apiKey, payload, callback) {
  const proxyStr = getProxy();

  const reqHeaders = {
    'Content-Type':       'application/json',
    'Content-Length':     payload.length,
    'x-api-key':          apiKey,
    'anthropic-version':  '2023-06-01',
  };

  function doRequest(socket) {
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  reqHeaders,
      rejectUnauthorized: false,
      insecureHTTPParser: true,
    };
    if (socket) options.socket = socket;

    const apiReq = https.request(options, apiRes => {
      let data = '';
      apiRes.on('data', d => data += d);
      apiRes.on('end', () => callback(null, apiRes.statusCode, data));
    });
    apiReq.on('error', e => callback(e));
    apiReq.write(payload);
    apiReq.end();
  }

  if (!proxyStr) {
    doRequest(null);
    return;
  }

  // 프록시 CONNECT 터널
  let proxyHost, proxyPort;
  try {
    const pu = new URL(proxyStr.includes('://') ? proxyStr : 'http://' + proxyStr);
    proxyHost = pu.hostname;
    proxyPort = parseInt(pu.port) || 8080;
  } catch(e) {
    console.error('proxy.txt 형식 오류:', e.message);
    doRequest(null);
    return;
  }

  const conn = net.connect(proxyPort, proxyHost, () => {
    conn.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
  });

  let headerBuf = '';
  const onData = chunk => {
    headerBuf += chunk.toString('binary');
    if (!headerBuf.includes('\r\n\r\n')) return;
    conn.removeListener('data', onData);

    if (!/^HTTP\/1\.[01] 200/i.test(headerBuf)) {
      conn.destroy();
      callback(new Error('프록시 CONNECT 실패: ' + headerBuf.slice(0, 120)));
      return;
    }

    const tlsSock = tls.connect({ socket: conn, servername: 'api.anthropic.com', rejectUnauthorized: false }, () => {
      doRequest(tlsSock);
    });
    tlsSock.on('error', e => callback(e));
  };

  conn.on('data', onData);
  conn.on('error', e => callback(e));
}

// ─── HTTP 서버 ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);

  // API 키 저장
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

  // API 키 유효성 확인
  if (parsed.pathname === '/check-key' && req.method === 'GET') {
    const exists = fs.existsSync(KEY_FILE);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ exists }));
    return;
  }

  // Anthropic API 프록시
  if (parsed.pathname === '/api' && req.method === 'POST') {
    if (!fs.existsSync(KEY_FILE)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API 키가 저장되지 않았습니다.' }));
      return;
    }
    const apiKey = fs.readFileSync(KEY_FILE, 'utf8').replace(/[^a-zA-Z0-9\-_]/g, '');
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

    // 나머지 쿼리 파라미터 조합
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

  // 정적 파일 서빙
  let filePath = parsed.pathname === '/' ? '/검수도구.html' : parsed.pathname;
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
  const proxy = getProxy();
  console.log('');
  console.log('  상세페이지 검수 도구 서버 실행 중');
  if (proxy) console.log(`  프록시 사용: ${proxy}`);
  else       console.log('  직접 연결 모드 (프록시 없음)');
  console.log('');
  console.log(`  브라우저 주소: http://localhost:${PORT}`);
  console.log('');
  console.log('  종료하려면 이 창에서 Ctrl+C 누르세요');
  console.log('');
});

const { exec } = require('child_process');
setTimeout(() => {
  const cmd = process.platform === 'win32'
    ? `start http://localhost:${PORT}`
    : process.platform === 'darwin'
    ? `open http://localhost:${PORT}`
    : `xdg-open http://localhost:${PORT}`;
  exec(cmd);
}, 800);
