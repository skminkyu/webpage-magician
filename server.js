const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8080;
const KEY_FILE = path.join(__dirname, 'apikey.txt');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

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
        fs.writeFileSync(KEY_FILE, key.trim());
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
    const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const payload = Buffer.from(body, 'utf8');
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
        apiRes.on('end', () => {
          res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      apiReq.on('error', e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      apiReq.write(payload);
      apiReq.end();
    });
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
  console.log('');
  console.log('  ✅ 상세페이지 검수 도구 서버 실행 중');
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
