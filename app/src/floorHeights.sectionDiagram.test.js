// 階設定表ダイアログの図（sectionDiagramModel・layoutFloorSettingsFigure。階設定表 S7・2026-10-20 図のみへ変更）。純関数を固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { floorSettingsRows, sectionDiagramModel, layoutFloorSettingsFigure } from './floorHeights.js';

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
  assert.deepEqual(labels(m), ['GL', '1FL', '1ML', '2FL', '軒桁上端']);
  assert.deepEqual(zs(m), [0, 0, 1500, 3000, 5900]);
  assert.deepEqual(m.dims.filter(d => d.kind === 'story').map(d => d.text), ['1500', '1500', '2900']);
});

test('複層: 中間の FL（3FL）も 1 層ずつ線と階高寸法を持つ。階高は 1 層分', () => {
  const planes = [P('f1', 1, 0), P('f2', 2, 3000, 2), P('f4', 4, 9600)]; // 2-3階は 1 層 3300
  const m = model(planes, {}, 2900, 0);
  assert.deepEqual(labels(m), ['GL', '1FL', '2FL', '3FL', '4FL', '軒桁上端']);
  assert.deepEqual(zs(m), [0, 0, 3000, 6300, 9600, 12500]);
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

test('GL 0（GL と 1FL が同じ高さ）: 線は 2 本のまま（GL が下）。GL〜1FL の寸法は「0」で出す（GL 欄の入力位置が要る）', () => {
  const m = model(three(), {}, 2900, 0);
  assert.deepEqual(labels(m), ['GL', '1FL', '2FL', '3FL', '軒桁上端']);
  assert.equal(m.lines[0].kind, 'gl');
  assert.equal(m.lines[1].planeIds[0], 'f1');
  const d = dimOf(m, 'gl');
  assert.equal(d.text, '0');
  assert.equal(d.fromKey, m.lines[0].key);
  assert.equal(d.toKey, m.lines[1].key);
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
  assert.deepEqual(zs(m), [0, 0, 3000, 6500, 9600]);
});

test('不正な欄は編集前の値（階高・GL とも）', () => {
  const base = model(three(), {}, 2900, 500);
  const bad = model(three(), { f2: '12' }, 2900, 500, 'abc');
  // GL 'abc' は編集前の 500 のまま、階高 '12' は無視（3000 のまま）
  assert.deepEqual(zs(bad), zs(base));
  assert.deepEqual(bad.dims.map(d => d.text), base.dims.map(d => d.text));
});

// ---- 座標変換（layoutFloorSettingsFigure）----

const fig = (planes, opts, heights = {}, top = 2900, gl = 0, glNew) => layoutFloorSettingsFigure(model(planes, heights, top, gl, glNew), opts);
const lineBy = (F, label) => F.lines.find(l => l.label === label);
const MIN_GAP = 36;

test('座標変換: 3階建て+GL（GL 500）の px 座標。上階ほど y が小さく、線は GL→軒桁上端の順に積まれる', () => {
  const F = fig(three(), {}, {}, 2900, 500);
  assert.deepEqual(F.lines.map(l => l.label), ['GL', '1FL', '2FL', '3FL', '軒桁上端']);
  // 隙間 = max(36, mm×0.04): GL-1FL 500→36(最小)・1FL-2FL 3000→120・2FL-3FL 3500→140・3FL-軒 2900→116
  const ys = F.lines.map(l => l.y);
  assert.equal(ys[4], 26);                 // 最上（軒桁上端）は上の余白
  assert.equal(ys[3], 26 + 116);
  assert.equal(ys[2], 26 + 116 + 140);
  assert.equal(ys[1], 26 + 116 + 140 + 120);
  assert.equal(ys[0], 26 + 116 + 140 + 120 + 36);
  assert.equal(F.height, ys[0] + 14);
  assert.equal(F.width, 290);
});

test('座標変換: 長い線は GL・軒桁上端、FL は短い。全ての線が右の寸法線をまたぐ（FL は 76..224 のまま）', () => {
  const F = fig(three());
  assert.deepEqual(F.lines.map(l => [l.label, l.long]), [['GL', true], ['1FL', false], ['2FL', false], ['3FL', false], ['軒桁上端', true]]);
  for (const l of F.lines) assert.equal(l.x2, 224);
  for (const l of F.lines.filter(l => l.kind === 'fl')) assert.equal(l.x1, 76);
  assert.equal(lineBy(F, 'GL').x1, 10);
  assert.equal(lineBy(F, '軒桁上端').x1, 10);
  assert.ok(lineBy(F, 'GL').x1 < lineBy(F, '2FL').x1);
  for (const d of F.rightDims) assert.ok(d.x < F.lines[1].x2, `${d.key}: 寸法線は線の右端より内側（線が寸法線をまたぐ）`);
  assert.equal(F.rightDims[0].x, 200);
});

test('GL▽: 最高軒高の寸法線より左。先端が GL 線の y に乗り、ラベルは▽の左。軒桁上端▽は中央のまま', () => {
  const F = fig(three(), { maxEaveMm: 9900 }, {}, 2900, 500);
  const gl = lineBy(F, 'GL');
  const apex = gl.marker.points[2];
  assert.ok(apex[0] < F.leftDim.x, 'GL▽は左の寸法線より左');
  assert.equal(apex[1], gl.y);
  assert.ok(gl.labelX < apex[0]);
  assert.ok(gl.x1 < apex[0] - 4, '線は▽の左へ延びる');
  assert.equal(lineBy(F, '軒桁上端').marker.points[2][0], 150);
});

test('最高軒高の文字は GL▽ と重ならない: 小さい建物（GL と軒桁が最小隙間 36px）でも値の行は GL▽・ラベルの上', () => {
  for (const planes of [three(), [P('f1', 1, 0)]]) {
    const F = fig(planes, { maxEaveMm: 100 }, {}, 100, 0); // 階高 100mm → 線間は最小 36px
    const gl = lineBy(F, 'GL');
    const labelTop = gl.labelY - 11; // 11px の文字の上端（GL ラベル・▽の最上端 = y-7 より上）
    assert.ok(F.leftDim.valueY + 2 <= labelTop + 1, `値の行の下端 ${F.leftDim.valueY + 2} が GL ラベルの上端 ${labelTop} にかかる`);
    assert.ok(F.leftDim.valueY + 2 <= gl.marker.points[0][1], '▽の底辺より上');
    const top = Math.min(...F.lines.map(l => l.y));
    assert.ok(F.leftDim.labelY - 9 >= top, '「最高軒高」が最上の線より上へはみ出さない');
  }
});

test('描画部 FigureSvg: 全レベル線は同じ太さ・実線（GL の破線と太線を持たない）', () => {
  const src = readFileSync(new URL('./ui/FloorSettingsDialog.jsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function FigureSvg'), src.indexOf('export function FloorSettingsDialog'));
  const levelLine = body.split('\n').find(s => s.includes('<line x1={l.x1}'));
  assert.ok(levelLine, 'レベル線の描画行が見つからない');
  assert.ok(!body.includes('strokeDasharray'), '図に破線を使わない');
  assert.match(levelLine, /strokeWidth=\{1\} \/>/);
  assert.ok(!levelLine.includes('l.long') && !levelLine.includes('l.kind'), '線の太さ・種類を線種で分けない');
});

test('▽: 先端（下の頂点）がレベル線の y に乗り、底辺はその上。ラベルは線の上', () => {
  const F = fig(three());
  for (const l of F.lines) {
    const [p0, p1, apex] = l.marker.points;
    assert.equal(apex[1], l.y, `${l.label}: ▽の先端が線に乗らない`);
    assert.equal(apex[0], l.kind === 'gl' ? 34 : 150);
    assert.ok(p0[1] < l.y && p1[1] === p0[1], `${l.label}: ▽の底辺が線の上にない`);
    assert.ok(l.labelY < l.y && l.labelY > p0[1] - 1, `${l.label}: ラベルが線のすぐ上にない`);
    assert.ok(l.labelX < apex[0], `${l.label}: ラベルは▽の左`);
  }
});

test('最小隙間: 階高が小さくても隣り合う線は 36px 以上離れる（入力欄が入る）', () => {
  const F = fig([P('f1', 1, 0), P('f2', 2, 1450)], {}, {}, 1450, 0); // 1450mm×0.04=58 pxPerMm を絞った場合も検証
  const G = layoutFloorSettingsFigure(model([P('f1', 1, 0), P('f2', 2, 1450)], {}, 1450, 0), { pxPerMm: 0.001 });
  for (const L of [F, G]) {
    for (let i = 1; i < L.lines.length; i++) assert.ok(L.lines[i - 1].y - L.lines[i].y >= MIN_GAP, `線${i}の隙間 ${L.lines[i - 1].y - L.lines[i].y}`);
  }
  assert.equal(G.lines[0].y - G.lines[1].y, MIN_GAP); // 比例が最小より小さいときちょうど最小
  const GL0 = fig(three(), {}, {}, 2900, 0); // GL=1FL でも GL 線と 1FL 線は 36px 離れる
  assert.equal(GL0.lines[0].y - GL0.lines[1].y, MIN_GAP);
});

test('比例: 最小隙間より大きい区間は mm に比例（0.04px/mm）', () => {
  const F = fig(three(), {}, {}, 2900, 500);
  const d = F.rightDims.find(x => x.key === 'story:f2:0');
  assert.equal(d.y1 - d.y2, 3500 * 0.04);
});

test('右の寸法鎖: 階高（各階）と GL〜1FL が入力欄を持ち、位置は寸法線の中央。欄は最小隙間に収まる', () => {
  const F = fig(three(), {}, {}, 2900, 500);
  assert.deepEqual(F.rightDims.map(d => d.key).sort(), ['gl', 'story:f1:0', 'story:f2:0', 'story:f3:0']);
  assert.equal(F.rightDims.length, three().length + 1); // 欄の数 = 階数 + GL
  for (const d of F.rightDims) {
    assert.ok(d.input, d.key);
    assert.equal(d.input.y + d.input.h / 2, d.yMid);
    assert.equal(d.input.x, 210);
    assert.ok(d.input.x > d.x, '欄は寸法線の右');
    assert.ok(d.input.h <= MIN_GAP - 8, '欄が隣の線にかかる');
    // 欄は線の右端付近に重なるが、寸法する 2 本の線の間に厳密に収まる（線にかからない）
    assert.ok(d.input.y > Math.min(d.y1, d.y2) && d.input.y + d.input.h < Math.max(d.y1, d.y2), `${d.key}: 欄が線にかかる`);
    assert.ok(d.input.x + d.input.w <= F.width);
  }
  assert.deepEqual(F.rightDims.filter(d => d.input.kind === 'height').map(d => d.input.id).sort(), ['f1', 'f2', 'f3']);
  assert.equal(F.rightDims.find(d => d.key === 'gl').input.kind, 'gl');
  // 上階ほど上: f3 の欄 < f2 < f1 < GL
  const yy = (k) => F.rightDims.find(d => d.key === k).input.y;
  assert.ok(yy('story:f3:0') < yy('story:f2:0') && yy('story:f2:0') < yy('story:f1:0') && yy('story:f1:0') < yy('gl'));
});

test('右の寸法鎖は隣の線に結ばれる（端のティックが線の y と一致）。GL=1FL でも取り違えない', () => {
  const F = fig(three(), {}, {}, 2900, 0);
  const gl = F.rightDims.find(d => d.key === 'gl');
  assert.equal(gl.y1, lineBy(F, 'GL').y);
  assert.equal(gl.y2, lineBy(F, '1FL').y);
  const top = F.rightDims.find(d => d.key === 'story:f3:0');
  assert.equal(top.y2, lineBy(F, '軒桁上端').y);
  assert.equal(gl.text, '0');
});

test('複層: 2層目以降の階高は表示のみ（欄は階につき 1 つ）', () => {
  const F = fig([P('f1', 1, 0), P('f2', 2, 3000, 2)]);
  const f2 = F.rightDims.filter(d => d.planeId === 'f2');
  assert.equal(f2.length, 2);
  assert.equal(f2.filter(d => d.input).length, 1);
  assert.equal(F.rightDims.filter(d => d.input).length, 3); // f1・f2・GL
});

test('左の寸法: GL〜軒桁上端の区間に最高軒高（opts.maxEaveMm をそのまま。下屋込みの値を呼び出し側が渡す）', () => {
  const F = fig(three(), { maxEaveMm: 9900 }, {}, 2900, 500);
  assert.equal(F.leftDim.text, '9900');
  assert.equal(F.leftDim.y1, lineBy(F, 'GL').y);
  assert.equal(F.leftDim.y2, lineBy(F, '軒桁上端').y);
  assert.ok(F.leftDim.x < F.lines[1].x1, '左の寸法線は FL 線より左');
  assert.equal(fig(three(), { maxEaveMm: 10000.04 }).leftDim.text, '10000');
  assert.equal(fig(three(), { maxEaveMm: null }).leftDim.text, '-');
  assert.ok(!F.rightDims.some(d => d.kind === 'eave'), '最高軒高は右の鎖に入れない');
});

test('階が無い: GL だけ（NaN にならない・左の寸法と欄は無い）', () => {
  const F = fig([]);
  assert.ok(Number.isFinite(F.lines[0].y) && Number.isFinite(F.height));
  assert.equal(F.leftDim, null);
  assert.equal(F.rightDims.length, 0);
});

test('スクロール用の高さ: 階が増えると図の高さが増える（最小隙間ぶん以上）', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => P(`f${i + 1}`, i + 1, i * 3000));
  const h3 = fig(many(3)).height;
  const h10 = fig(many(10)).height;
  assert.ok(h10 - h3 >= 7 * MIN_GAP);
});

test('入力欄の DOM 順（Tab 順）: 上階→下階→GL（見た目の上から下・GL が最後）', () => {
  const F = fig(three(), {}, {}, 2900, 500);
  const withInput = F.rightDims.filter(d => d.input);
  assert.deepEqual(withInput.map(d => d.input.kind === 'gl' ? 'gl' : d.input.id), ['f3', 'f2', 'f1', 'gl']);
  const ys = withInput.map(d => d.input.y);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1]);
});

test('地階だけ（1FL 無し）でも GL の入力欄がある: 階高欄の列の右に単独で置く。GL が最後', () => {
  const planes = [P('b2', -2, -6000), P('b1', -1, -3000)];
  const F = fig(planes, {}, {}, 2900, 0);
  const gl = F.rightDims.filter(d => d.input && d.input.kind === 'gl');
  assert.equal(gl.length, 1);
  assert.equal(gl[0].solo, true);
  assert.equal(gl[0].input.y + gl[0].input.h / 2, lineBy(F, 'GL').y);
  const others = F.rightDims.filter(d => d.input && d.input.kind === 'height');
  assert.equal(others.length, 2);
  for (const d of others) assert.ok(gl[0].input.x >= d.input.x + d.input.w, '階高欄と重ならない');
  assert.ok(gl[0].input.x + gl[0].input.w <= F.width);
  assert.equal(F.rightDims[F.rightDims.length - 1].input.kind, 'gl');
  assert.equal(F.rightDims.filter(d => d.input).length, planes.length + 1);
});
