const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

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

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '200mb' }));

// ── 제품 목록 ──
app.get('/api/products', (req, res) => {
  const list = Object.entries(products).map(([id, p]) => {
    const meta = (round) => {
      if (!p.rounds || !p.rounds[round]) return null;
      const r = p.rounds[round];
      return {
        updatedAt: r.updatedAt,
        pageCount: (r.pages || []).length,
        annotCount: (r.pages || []).reduce((s, pg) => s + (pg.annotations || []).length, 0)
      };
    };
    return { id, name: p.name, createdAt: p.createdAt, rounds: { 1: meta(1), 2: meta(2) } };
  }).sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

// ── 제품 생성 ──
app.post('/api/products', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '제품명을 입력하세요.' });
  const id = uuidv4();
  products[id] = { name: name.trim(), createdAt: Date.now(), rounds: {} };
  saveProducts();
  res.json({ id, name: products[id].name, createdAt: products[id].createdAt });
});

// ── 제품 상세 (전체 데이터) ──
app.get('/api/products/:id', (req, res) => {
  const p = products[req.params.id];
  if (!p) return res.status(404).json({ error: '제품을 찾을 수 없습니다.' });
  res.json({ id: req.params.id, ...p });
});

// ── 차수 저장/업데이트 ──
app.put('/api/products/:id/rounds/:round', (req, res) => {
  const p = products[req.params.id];
  if (!p) return res.status(404).json({ error: '제품을 찾을 수 없습니다.' });
  const round = req.params.round;
  if (!['1', '2'].includes(round)) return res.status(400).json({ error: '차수는 1 또는 2이어야 합니다.' });
  p.rounds[round] = { pages: req.body.pages || [], updatedAt: Date.now() };
  saveProducts();
  res.json({ ok: true });
});

// ── 제품 이름 수정 ──
app.patch('/api/products/:id', (req, res) => {
  const p = products[req.params.id];
  if (!p) return res.status(404).json({ error: '제품을 찾을 수 없습니다.' });
  if (req.body.name && req.body.name.trim()) {
    p.name = req.body.name.trim();
    saveProducts();
  }
  res.json({ ok: true });
});

// ── 제품 삭제 ──
app.delete('/api/products/:id', (req, res) => {
  if (!products[req.params.id]) return res.status(404).json({ error: '제품을 찾을 수 없습니다.' });
  delete products[req.params.id];
  saveProducts();
  res.json({ ok: true });
});

// ── 제품 뷰어 ──
app.get('/view/product/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'viewer.html'));
});

// ── (레거시) 단순 공유 ──
const shareStore = new Map();
app.post('/api/share', (req, res) => {
  const { imageDataUrl, annotations } = req.body;
  if (!imageDataUrl) return res.status(400).json({ error: '잘못된 요청입니다.' });
  const id = uuidv4();
  shareStore.set(id, { imageDataUrl, annotations: annotations || [], createdAt: Date.now() });
  res.json({ id, url: `/view/${id}` });
});
app.get('/api/view/:id', (req, res) => {
  const e = shareStore.get(req.params.id);
  if (!e) return res.status(404).json({ error: '링크가 만료되었거나 존재하지 않습니다.' });
  res.json({ imageDataUrl: e.imageDataUrl, annotations: e.annotations });
});
app.get('/view/:id', (req, res) => res.sendFile(path.join(__dirname, 'viewer.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
