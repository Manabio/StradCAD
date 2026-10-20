// 階設定表ダイアログの簡易断面図（sectionDiagramModel・layoutSectionDiagram。階設定表 S7）。表示専用の純関数を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorSettingsRows, sectionDiagramModel, layoutSectionDiagram } from './floorHeights.js';

const P = (id, startFloor, elevation, stories = 1, name = `${startFloor}階`) => ({ id, name, startFloor, elevation, stories });
const model = (planes, heights = {}, top = 2900, gl = 0, glNew) =>
  sectionDiagramModel(planes, floorSettingsRows(planes, { heights, glBelow1FlMm: glNew }, top, gl));
const zs = (m) => m.lines.map(l => l.zMm);
const labels = (m) => m.lines.map(l => l.label);
const dimOf = (m, key) => m.dims.find(d => d.key === key);

const three = () => [P('f1', 1, 0), P('f2', 2, 3000), P('f3', 3, 6500)];

test('線: GL・各FL・軒桁上端（GL 正。zMm は GL 基準で昇順）。不揃いの階高', () => {
  const m = model(three(), {}, 2900, 500);
  assert.deepEqual(labels(m), ['GL', '1FL', '2FL', '3FL', '軒桁上端']);
  assert.deepEqual(zs(m), [0, 500, 3500, 7000, 9900]);
  assert.deepEqual(m.lines.map(l => l.kind), ['gl', 'fl', 'fl', 'fl', 'eave']);
  assert.equal(m.minZ, 0);
  assert.equal(m.maxZ, 9900);
});

test('寸法: 各階の階高・GL〜1FL・軒高（整数 mm の文字列）', () => {
  const m = model(three(), {}, 2900, 500);
  assert.deepEqual(m.dims.filter(d => d.kind === 'story').map(d => d.text), ['3000', '3500', '2900']);
  assert.equal(dimOf(m, 'gl').text, '500');
  assert.equal(dimOf(m, 'eave').text, '9900');
  assert.equal(dimOf(m, 'eave').col, 1);
  assert.equal(m.dims.length, 5);
});

test('軒桁上端＝最上階 FL＋最上階の階高×層数（複層の最上階）', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 3000, 2)]; // 2-3階
  const m = model(planes, {}, 2900, 0);
  assert.equal(m.maxZ, 3000 + 2900 * 2);
  assert.equal(dimOf(m, 'eave').mm, 8800);
});

test('中間階（stories 0.5）: 1 区間・ラベルは makeFloorName と同じ表記（1ML）', () => {
  const planes = [P('f1', 1, 0), P('m1', 1, 1500, 0.5), P('f2', 2, 3000)];
  const m = model(planes, {}, 2900, 0);
  assert.deepEqual(labels(m), ['GL=1FL', '1ML', '2FL', '軒桁上端']);
  assert.deepEqual(zs(m), [0, 1500, 3000, 5900]);
  assert.deepEqual(m.dims.filter(d => d.kind === 'story').map(d => d.text), ['1500', '1500', '2900']);
});

test('複層: 中間の FL（3FL）も 1 層ずつ線と階高寸法を持つ。階高は 1 層分', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 3000, 2), P('f4', 4, 9600)]; // 2-3階は 1 層 3300
  const m = model(planes, {}, 2900, 0);
  assert.deepEqual(labels(m), ['GL=1FL', '2FL', '3FL', '4FL', '軒桁上端']);
  assert.deepEqual(zs(m), [0, 3000, 6300, 9600, 12500]);
  assert.deepEqual(m.dims.filter(d => d.kind === 'story').map(d => d.text), ['3000', '3300', '3300', '2900']);
  assert.equal(m.dims.filter(d => d.planeId === 'f2').length, 2);
});

test('地階: B1FL は GL・1FL より下。GL〜1FL の寸法は 1FL 基準', () => {
  const planes = [P('b1', -1, -3000), P('f1', 1, 0), P('f2', 2, 3000)];
  const m = model(planes, {}, 2900, 600);
  assert.deepEqual(labels(m), ['B1FL', 'GL', '1FL', '2FL', '軒桁上端']);
  assert.deepEqual(zs(m), [-2400, 0, 600, 3600, 6500]);
  assert.equal(m.minZ, -2400);
  assert.equal(dimOf(m, 'gl').text, '600');
  assert.equal(dimOf(m, 'story:b1:0').text, '3000');
});

test('GL が負（GL が 1FL より上）: GL 線が 1FL 線より上。寸法は絶対値', () => {
  const m = model(three(), {}, 2900, -300);
  assert.deepEqual(labels(m), ['1FL', 'GL', '2FL', '3FL', '軒桁上端']);
  assert.deepEqual(zs(m), [-300, 0, 2700, 6200, 9100]);
  assert.equal(dimOf(m, 'gl').text, '300');
  assert.equal(dimOf(m, 'eave').text, '9100');
});

test('GL 0（GL と 1FL が重なる）: 線は 1 本「GL=1FL」・GL〜1FL の寸法は出さない', () => {
  const m = model(three(), {}, 2900, 0);
  assert.deepEqual(labels(m), ['GL=1FL', '2FL', '3FL', '軒桁上端']);
  assert.equal(m.lines[0].kind, 'gl');
  assert.equal(m.lines[0].planeIds[0], 'f1');
  assert.equal(dimOf(m, 'gl'), undefined);
});

test('1階建て: GL・1FL・軒桁上端', () => {
  const m = model([P('f1', 1, 0)], {}, 2900, 400);
  assert.deepEqual(labels(m), ['GL', '1FL', '軒桁上端']);
  assert.deepEqual(zs(m), [0, 400, 3300]);
  assert.deepEqual(m.dims.map(d => d.text).sort(), ['2900', '3300', '400']);
});

test('階が無い: GL だけ（落ちない）', () => {
  const m = model([], {}, 2900, 0);
  assert.deepEqual(labels(m), ['GL']);
  assert.equal(m.dims.length, 0);
});

test('draft の編集が即時に反映される（階高・GL）', () => {
  const m = model(three(), { f2: '3200' }, 2900, 0, '500');
  assert.deepEqual(zs(m), [0, 500, 3500, 6700, 9600]);
  assert.equal(dimOf(m, 'story:f2:0').text, '3200');
  assert.equal(dimOf(m, 'gl').text, '500');
});

test('最上階の階高を編集すると軒桁上端だけが動く', () => {
  const m = model(three(), { f3: '3100' }, 2900, 0);
  assert.deepEqual(zs(m), [0, 3000, 6500, 9600]);
});

test('不正な欄は編集前の値（階高・GL とも）', () => {
  const base = model(three(), {}, 2900, 500);
  const bad = model(three(), { f2: '12' }, 2900, 500, 'abc');
  // GL 'abc' は編集前の 500 のまま、階高 '12' は無視（3000 のまま）
  assert.deepEqual(zs(bad), zs(base));
  assert.deepEqual(bad.dims.map(d => d.text), base.dims.map(d => d.text));
});

// ---- 座標変換 ----

const layouts = () => [
  layoutSectionDiagram(model(three(), {}, 2900, 500)),
  layoutSectionDiagram(model([P('b1', -1, -3000), P('f1', 1, 0), P('f2', 2, 3000)], {}, 2900, -300)),
  layoutSectionDiagram(model([P('f1', 1, 0)], {}, 2900, 0)),
  layoutSectionDiagram(model([], {}, 2900, 0)),
  layoutSectionDiagram(model([P('f1', 1, 0), P('f2', 2, 3000, 8)], {}, 2900, 0), { width: 300, height: 200 }),
];

test('座標変換: 全部の線・寸法がビューポートに収まる（最小・最大が余白の端に付く）', () => {
  const ls = layouts();
  assert.ok(ls.length >= 5);
  for (const L of ls) {
    assert.ok(L.lines.length >= 1, '線が空');
    for (const l of L.lines) {
      assert.ok(l.y >= 0 && l.y <= L.height, `y=${l.y}`);
      assert.ok(l.x1 >= 0 && l.x2 <= L.width && l.x1 < l.x2);
    }
    for (const d of L.dims) {
      assert.ok(d.y1 >= 0 && d.y1 <= L.height && d.y2 >= 0 && d.y2 <= L.height);
      assert.ok(d.x >= 0 && d.x + 30 <= L.width, `x=${d.x}`);
    }
  }
  const L = ls[0];
  assert.ok(L.lines.length >= 5);
  assert.equal(L.lines[L.lines.length - 1].y, 16); // 最大（軒桁上端）が上の余白
  assert.equal(L.lines[0].y, L.height - 16);       // 最小（GL）が下の余白
});

test('座標変換: 上が上（y 下向き正で上階ほど y が小さい）。間隔は階高に比例', () => {
  const L = layoutSectionDiagram(model(three(), {}, 2900, 0));
  const ys = L.lines.map(l => l.y);
  assert.ok(ys.length >= 4);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] < ys[i - 1], '上階ほど y が小さい');
  const d = L.dims.find(x => x.key === 'story:f2:0');
  assert.ok(d.y1 > d.y2);
  assert.ok(Math.abs((d.y1 - d.y2) - 3500 * L.scale) < 1e-9);
  assert.ok(d.yMid > d.y2 && d.yMid < d.y1);
});

test('座標変換: GL だけ（幅 0 の範囲）でも NaN にならない', () => {
  const L = layoutSectionDiagram(model([], {}, 2900, 0));
  assert.ok(Number.isFinite(L.lines[0].y));
});
