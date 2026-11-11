// columnPick.js columnAtPoint（長クリック位置の柱の当たり判定）のテスト。
// 柱は実 PlanGraph の graph.columns（座標は原点から離す）。.jsx/store.js/snap.js は import しない。
// 閾値 8px は呼び出し側が CL_THRESHOLD_PX を渡す想定の引数値。
// 柱・graph は循環参照を持つ巨大な MobX オブジェクトで、assert.equal が失敗するとその diff 生成で
// 実質止まる——同一性の判定は assert.ok(a === b) で書く（失敗しても差分を作らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import { Viewport } from '../viewport.js';
import { bareColumnRect } from '../finish/columnWrap.js';
import { columnAtPoint, isInsideColumnRect } from './columnPick.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const PX = 8;
const WOOD = 'WOOD-120x120';   // 120 角
const H_SMALL = 'STEEL-H200x100'; // 成 200 × 幅 100
const H_BIG = 'STEEL-H400x400';  // 400 角

function makeEnv(xs = [1300, 5300], ys = [2700, 6700]) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'S造';
  const sg = project.structGraph;
  const xCLs = xs.map(v => sg.addCenterLine(V, v, { labeled: true, discipline: Discipline.STRUCT }));
  const yCLs = ys.map(v => sg.addCenterLine(H, v, { labeled: true, discipline: Discipline.STRUCT }));
  const add = (section, xi, yi, rotation = 0) =>
    graph.addColumn(StructuralMaterialType.STEEL, section, xCLs[xi], yCLs[yi], { rotation });
  return { graph, add };
}
const opts = (scale, minHalfPx = PX) => ({ scaleX: scale, scaleY: scale, minHalfPx });
// 期待した柱（null＝当たりなし）と一致することを assert する。失敗時は柱 id と点を示す（柱そのものは diff しない）。
function isHit(cols, x, y, o, expected) {
  const got = columnAtPoint(cols, x, y, o);
  assert.ok(got === expected, `点 (${x}, ${y}): 期待 ${expected?.id ?? null}・実際 ${got?.id ?? null}`);
  return true;
}

test('【柱当たり】断面の内側なら当たり・外側は null（大きい柱は広がらない）', () => {
  const { graph, add } = makeEnv();
  const c = add(H_BIG, 0, 0);
  assert.equal(c.x, 1300); assert.equal(c.y, 2700); // 前提: 偏芯なし
  assert.ok(isHit(graph.columns, 1300 + 190, 2700 - 190, opts(1), c));
  assert.ok(isHit(graph.columns, 1300 + 201, 2700, opts(1), null));
  assert.ok(isHit(graph.columns, 1300, 2700 - 201, opts(1), null));
  // 画面で 400mm×0.05=20px の柱は半幅 10px。minHalfPx 8px 分（160mm）には広がらず、半幅 200mm のまま
  assert.ok(isHit(graph.columns, 1300 + 190, 2700, opts(0.05), c));
  assert.ok(isHit(graph.columns, 1300 + 210, 2700, opts(0.05), null));
});

test('【柱当たり】小さい柱（半幅 < minHalfPx/scale）は中心 ± minHalfPx まで当たる・その外は null', () => {
  const { graph, add } = makeEnv();
  const c = add(WOOD, 0, 0); // 半幅 60mm。scale 0.05 → 8px = 160mm
  assert.ok(isHit(graph.columns, 1300 + 150, 2700 - 150, opts(0.05), c));
  assert.ok(isHit(graph.columns, 1300 + 170, 2700, opts(0.05), null));
  assert.ok(isHit(graph.columns, 1300, 2700 + 170, opts(0.05), null));
  // scale 1（8px=8mm < 半幅 60mm）では広がらない
  assert.ok(isHit(graph.columns, 1300 + 61, 2700, opts(1), null));
});

test('【柱当たり】細長い断面は半幅が広げ幅に満たない辺ごとに広がる・半幅が足りている柱は広がらない', () => {
  const { graph, add } = makeEnv();
  const c = add(H_SMALL, 0, 0); // 幅 100（半幅 50）× 成 200（半幅 100）。scale 0.05 → 広げ幅 160mm
  assert.ok(isHit(graph.columns, 1300 + 150, 2700, opts(0.05), c), '幅方向は 160mm まで広がる');
  assert.ok(isHit(graph.columns, 1300, 2700 + 150, opts(0.05), c), '成方向も 160mm に広がる（100<160）');
  // scale 0.1 → 広げ幅 80mm: 幅方向（半幅 50）は 80 に広がり、成方向（半幅 100）は広がらず 100 のまま
  assert.ok(isHit(graph.columns, 1300 + 75, 2700, opts(0.1), c));
  assert.ok(isHit(graph.columns, 1300 + 85, 2700, opts(0.1), null));
  assert.ok(isHit(graph.columns, 1300, 2700 + 95, opts(0.1), c));
  assert.ok(isHit(graph.columns, 1300, 2700 + 105, opts(0.1), null));
  const big = add(H_BIG, 1, 1);
  assert.ok(isHit([big], big.x + 190, big.y, opts(0.05), big));
  assert.ok(isHit([big], big.x + 210, big.y, opts(0.05), null), '半幅 200mm の辺は広がらない');
});

test('【柱当たり】重なる 2 本は中心が近い方（配列順に依らない）', () => {
  const { graph, add } = makeEnv([1300, 1400]);
  const a = add(WOOD, 0, 0), b = add(WOOD, 1, 0); // 範囲 1240〜1360 と 1340〜1460
  assert.ok(isHit([a, b], 1355, 2700, opts(1), b));
  assert.ok(isHit([b, a], 1355, 2700, opts(1), b));
  assert.ok(isHit([a, b], 1345, 2700, opts(1), a));
  assert.ok(isHit(graph.columns, 1345, 2700, opts(1), a));
});

test('【柱当たり】境界上は当たり（<= の向き）・わずかに外は null（広げ幅 0）', () => {
  const { add } = makeEnv();
  const c = add(WOOD, 0, 0); // 半幅 60mm
  const o = { scaleX: 1, scaleY: 1, minHalfPx: 0 };
  assert.ok(isHit([c], c.x + 60, c.y, o, c));
  assert.ok(isHit([c], c.x - 60, c.y, o, c));
  assert.ok(isHit([c], c.x, c.y + 60, o, c));
  assert.ok(isHit([c], c.x + 60.01, c.y, o, null));
  assert.ok(isHit([c], c.x, c.y - 60.01, o, null));
});

test('【柱当たり】重なる 2 本の近さは画面距離（scaleX≠scaleY。mm 距離でも scale 取り違えでも逆になる配置）', () => {
  const { add } = makeEnv([1300, 1340], [2700, 2760]);
  const a = add(WOOD, 0, 0), b = add(WOOD, 1, 1); // a=(1300,2700)・b=(1340,2760)、ともに半幅 60
  const o = { scaleX: 1, scaleY: 0.1, minHalfPx: 0 };
  // 点 (1310, 2745): a までの差 (10,45)・b まで (30,15)。mm 距離では b が近い（46.1 vs 33.5）が、
  // 画面距離（scaleY=0.1）では a（約 11px）が b（約 30px）より近い。scale を取り違えると (1,45) と (3,15) で b になる。
  assert.ok(isHit([a, b], 1310, 2745, o, a));
  assert.ok(isHit([b, a], 1310, 2745, o, a));
});

test('【柱当たり】回転 90° の H 形は幅と成が入れ替わる', () => {
  const { add } = makeEnv();
  const c0 = add(H_SMALL, 0, 0, 0);     // 半幅 X50×Y100
  const c90 = add(H_SMALL, 1, 1, 90);   // 半幅 X100×Y50
  assert.ok(isHit([c0], c0.x + 80, c0.y, opts(1), null));
  assert.ok(isHit([c0], c0.x, c0.y + 80, opts(1), c0));
  assert.ok(isHit([c90], c90.x + 80, c90.y, opts(1), c90));
  assert.ok(isHit([c90], c90.x, c90.y + 80, opts(1), null));
});

test('【柱当たり】scaleX≠scaleY: 広げ幅は軸ごとの scale で決まる', () => {
  const { add } = makeEnv();
  const c = add(WOOD, 0, 0); // 半幅 60mm
  const o = { scaleX: 0.05, scaleY: 1, minHalfPx: PX }; // X は 160mm まで広がる・Y は 8mm（広がらず 60mm）
  assert.ok(isHit([c], c.x + 150, c.y, o, c));
  assert.ok(isHit([c], c.x, c.y + 150, o, null));
});

test('【柱当たり・失敗側】scale・minHalfPx が非有限・欠落は throw', () => {
  const { graph, add } = makeEnv();
  add(WOOD, 0, 0);
  const call = o => columnAtPoint(graph.columns, 1300, 2700, o);
  assert.throws(() => call({ scaleX: NaN, scaleY: 1, minHalfPx: PX }), /scaleX/);
  assert.throws(() => call({ scaleX: 1, scaleY: Infinity, minHalfPx: PX }), /scaleY/);
  assert.throws(() => call({ scaleX: 1, scaleY: 1 }), /minHalfPx/);
  assert.throws(() => call({ scaleX: 1, scaleY: 1, minHalfPx: NaN }), /minHalfPx/);
  assert.throws(() => call(undefined), /scaleX/);
});

test('【実断面】isInsideColumnRect: 4 辺の上は内側（境界を含む）・各辺の 1mm 外は外側', () => {
  const { add } = makeEnv();
  const c = add(H_SMALL, 0, 0); // 半幅 X50×Y100
  const r = bareColumnRect(c);
  assert.ok(r.xHi - r.xLo === 100 && r.yHi - r.yLo === 200, '前提: 断面 100×200');
  assert.ok(isInsideColumnRect(c, r.xLo, c.y), '左辺の上');
  assert.ok(isInsideColumnRect(c, r.xHi, c.y), '右辺の上');
  assert.ok(isInsideColumnRect(c, c.x, r.yLo), '上辺の上');
  assert.ok(isInsideColumnRect(c, c.x, r.yHi), '下辺の上');
  assert.ok(!isInsideColumnRect(c, r.xLo - 1, c.y), '左 1mm 外');
  assert.ok(!isInsideColumnRect(c, r.xHi + 1, c.y), '右 1mm 外');
  assert.ok(!isInsideColumnRect(c, c.x, r.yLo - 1), '上 1mm 外');
  assert.ok(!isInsideColumnRect(c, c.x, r.yHi + 1), '下 1mm 外');
});

test('【実断面】isInsideColumnRect: 回転 90° の H 形は x/y の半幅が入れ替わる', () => {
  const { add } = makeEnv();
  const c0 = add(H_SMALL, 0, 0, 0);    // 半幅 X50×Y100
  const c90 = add(H_SMALL, 1, 1, 90);  // 半幅 X100×Y50
  assert.ok(!isInsideColumnRect(c0, c0.x + 80, c0.y));
  assert.ok(isInsideColumnRect(c0, c0.x, c0.y + 80));
  assert.ok(isInsideColumnRect(c90, c90.x + 80, c90.y));
  assert.ok(!isInsideColumnRect(c90, c90.x, c90.y + 80));
});

test('【実断面】広げた当たり幅の中（実断面の外）は columnAtPoint では柱・isInsideColumnRect では外側', () => {
  const { graph, add } = makeEnv();
  const c = add(WOOD, 0, 0); // 半幅 60mm
  // 1/200（0.025px/mm）・8px → 320mm まで広がる。中心から 150mm は広げた部分
  assert.ok(isHit(graph.columns, c.x + 150, c.y, opts(0.025), c));
  assert.ok(!isInsideColumnRect(c, c.x + 150, c.y));
  assert.ok(isInsideColumnRect(c, c.x + 50, c.y));
});

test('【柱当たり】柱が無ければ null', () => {
  assert.ok(columnAtPoint([], 1300, 2700, opts(1)) === null);
});

test('【柱当たり・本番の形】実 graph.columns と実 Viewport の scale（1/100）で、小さい柱を 8px 内で拾う', () => {
  const { graph, add } = makeEnv();
  const c = add(WOOD, 0, 0);
  const vp = new Viewport(1000, 800);
  const rect = bareColumnRect(c);
  const halfMm = (rect.xHi - rect.xLo) / 2;
  assert.ok(halfMm * vp.scaleX < PX, '前提: 実寸の半幅は 8px 未満（画面で小さい柱）');
  const reachMm = PX / vp.scaleX;
  const o = { scaleX: vp.scaleX, scaleY: vp.scaleY, minHalfPx: PX };
  assert.ok(isHit(graph.columns, c.x + reachMm * 0.9, c.y, o, c));
  assert.ok(isHit(graph.columns, c.x + reachMm * 1.1, c.y, o, null));
});
