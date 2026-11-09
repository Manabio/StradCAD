// 配置図の通り芯（線・丸ラベル・寸法。site/sitePlacementGrid.js）の純モジュールのテスト。
// fixture は原点から離す（0 起点だと符号・基準の取り違えが偶然一致する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, Site, CenterLineType, Discipline, DimensionSide } from '@core';
import { SitePlacementCenterSource } from '../core/constants.js';
import { gridLineSnapshot, composeSitePlacementGrid, layoutSitePlacementGrid } from './sitePlacementGrid.js';
import { composeSitePlacementView } from './sitePlacementView.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;

/** 写し（gridLineSnapshot の戻り）の形で通り芯を作る。X は xs、Y は ys（どちらも昇順で渡す）。 */
function mkLines(xs, ys) {
  return [
    ...xs.map((value, i) => ({ id: `x${i}`, centerLineType: V, value, label: `X${i + 1}` })),
    ...ys.map((value, i) => ({ id: `y${i}`, centerLineType: H, value, label: `Y${i + 1}` })),
  ];
}
const rowOf = (grid, axis, tier) => grid.rows.find(r => r.axis === axis && r.tier === tier);

// ---- gridLineSnapshot ----

test('gridLineSnapshot: 通り芯だけを VERTICAL 昇順 → HORIZONTAL 昇順で { id, centerLineType, value, label } に写す（中心線・旧 labeled:true の中心線は含めない）', () => {
  const graph = new Project('proj', 'test').structGraph;
  const st = { labeled: true, discipline: Discipline.STRUCT };
  // 昇順でない順に挿入する
  const x3 = graph.addCenterLine(V, 15000, st);
  const x1 = graph.addCenterLine(V, 8000, st);
  const x2 = graph.addCenterLine(V, 12000, st);
  const y2 = graph.addCenterLine(H, 34000, st);
  const y1 = graph.addCenterLine(H, 30000, st);
  graph.addCenterLine(V, 9999, { labeled: false, discipline: Discipline.ARCH });  // 中心線
  graph.addCenterLine(H, 31000, { labeled: true, discipline: Discipline.ARCH });  // 旧データ（labeled だけが真の中心線）
  const snap = gridLineSnapshot(graph);
  assert.deepEqual(snap.map(s => s.id), [x1.id, x2.id, x3.id, y1.id, y2.id]);
  assert.deepEqual(snap.map(s => s.centerLineType), [V, V, V, H, H]);
  assert.deepEqual(snap.map(s => s.value), [8000, 12000, 15000, 30000, 34000]);
  assert.deepEqual(snap.map(s => s.label), ['X1', 'X2', 'X3', 'Y2', 'Y1'], 'ラベルは通り芯自身の label（Y は下から上へ Y1,Y2 なので、y 昇順では Y2 が先）');
  assert.deepEqual(Object.keys(snap[0]).sort(), ['centerLineType', 'id', 'label', 'value']);
});

test('【失敗系】gridLineSnapshot: graph が無ければ []（null・undefined）。通り芯が無い graph も []', () => {
  assert.deepEqual(gridLineSnapshot(null), []);
  assert.deepEqual(gridLineSnapshot(undefined), []);
  assert.deepEqual(gridLineSnapshot(new Project('proj', 'test').structGraph), []);
});

// ---- composeSitePlacementGrid ----

test('composeSitePlacementGrid: 間隔の段は隣接どうしの差、全長の段は最外どうし（X=4本 → 間隔3区間＋全長、Y=2本 → 間隔だけ）', () => {
  const g = composeSitePlacementGrid({ gridLines: mkLines([50000, 53640, 57280, 59100], [30000, 34000]), roofBounds: null });
  assert.equal(g.rows.length, 3);
  const x0 = rowOf(g, V, 0), x1 = rowOf(g, V, 1), y0 = rowOf(g, H, 0);
  assert.deepEqual(x0.segments, [
    { v1: 50000, v2: 53640, length: 3640 }, { v1: 53640, v2: 57280, length: 3640 }, { v1: 57280, v2: 59100, length: 1820 },
  ]);
  assert.deepEqual(x0.anchors, [50000, 53640, 57280, 59100]);
  assert.deepEqual(x1.segments, [{ v1: 50000, v2: 59100, length: 9100 }]);
  assert.deepEqual(x1.anchors, [50000, 59100]);
  assert.deepEqual(y0.segments, [{ v1: 30000, v2: 34000, length: 4000 }]);
  assert.equal(rowOf(g, H, 1), undefined, '2 本では間隔＝全長なので全長の段は無い');
  assert.deepEqual([x0.side, x1.side, y0.side], [DimensionSide.TOP, DimensionSide.TOP, DimensionSide.LEFT]);
  assert.equal(new Set(g.rows.map(r => r.key)).size, 3, '行の key は重ならない');
  // dimensionRow は axis === 'X' で分岐する。CenterLineType の値を変えたらここが赤くなる
  assert.equal(x0.axis, CenterLineType.VERTICAL);
  assert.equal(x0.axis, 'X');
});

test('composeSitePlacementGrid: 同じ値の通り芯が 2 本あっても例外なし（間隔の段に長さ 0 の区間・全長の段は最外どうし）', () => {
  const g = composeSitePlacementGrid({ gridLines: mkLines([50000, 50000, 53000], [30000, 34000]), roofBounds: null });
  const x0 = rowOf(g, V, 0), x1 = rowOf(g, V, 1);
  assert.equal(x0.segments.filter(s => s.length === 0).length, 1);
  assert.equal(x0.segments.length, 2);
  assert.equal(x1.segments.reduce((a, s) => a + s.length, 0), 3000);
});

test('composeSitePlacementGrid: 全長の段は 3 本からちょうど出る（2 本→無し・3 本→有り）', () => {
  const two = composeSitePlacementGrid({ gridLines: mkLines([50000, 53000], [30000, 34000]), roofBounds: null });
  assert.equal(two.rows.length, 2);
  assert.ok(two.rows.every(r => r.tier === 0));
  const three = composeSitePlacementGrid({ gridLines: mkLines([50000, 53000, 56000], [30000, 34000]), roofBounds: null });
  assert.equal(three.rows.length, 3);
  assert.deepEqual(rowOf(three, V, 1).segments, [{ v1: 50000, v2: 56000, length: 6000 }]);
});

test('composeSitePlacementGrid: 区間の長さは四捨五入した整数 mm（3640.4 → 3640・3640.6 → 3641）', () => {
  const g = composeSitePlacementGrid({ gridLines: mkLines([50000, 53640.4, 57281], [30000, 33640.6]), roofBounds: null });
  assert.deepEqual(rowOf(g, V, 0).segments.map(s => s.length), [3640, 3641]);
  assert.deepEqual(rowOf(g, H, 0).segments.map(s => s.length), [3641]);
});

test('composeSitePlacementGrid: 枠は屋根の外接矩形と通り芯の範囲の和（屋根が通り芯より広ければ屋根の端）。線の value は通り芯のまま', () => {
  const lines = mkLines([50000, 53000], [30000, 34000]);
  const wide = composeSitePlacementGrid({ gridLines: lines, roofBounds: { minX: 48000, minY: 28000, maxX: 56000, maxY: 36000 } });
  assert.deepEqual(wide.frame, { x: [48000, 56000], y: [28000, 36000] });
  const narrow = composeSitePlacementGrid({ gridLines: lines, roofBounds: { minX: 51000, minY: 31000, maxX: 52000, maxY: 33000 } });
  assert.deepEqual(narrow.frame, { x: [50000, 53000], y: [30000, 34000] }, '屋根が通り芯の内側なら通り芯の範囲');
  assert.deepEqual(wide.lines.map(l => l.value), [50000, 53000, 30000, 34000]);
});

test('composeSitePlacementGrid: 線は { key, id, centerLineType, value, label } で、1 本の軸でも線と丸ラベルの元は出る（寸法の行だけ無い）', () => {
  const g = composeSitePlacementGrid({
    gridLines: mkLines([50000], [30000, 34000]), roofBounds: { minX: 49000, minY: 29000, maxX: 51000, maxY: 35000 },
  });
  assert.equal(g.lines.length, 3);
  assert.deepEqual(g.lines[0], { key: g.lines[0].key, id: 'x0', centerLineType: V, value: 50000, label: 'X1' });
  assert.equal(new Set(g.lines.map(l => l.key)).size, 3);
  assert.equal(rowOf(g, V, 0), undefined, 'X が 1 本では寸法の行は無い');
  assert.equal(g.rows.length, 1);
});

test('【失敗系】composeSitePlacementGrid: 通り芯 0 本・屋根なしは空（例外なし）。屋根だけのときも線・行は無い', () => {
  assert.deepEqual(composeSitePlacementGrid({ gridLines: [], roofBounds: null }), { frame: { x: null, y: null }, lines: [], rows: [] });
  const roofOnly = composeSitePlacementGrid({ gridLines: [], roofBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } });
  assert.deepEqual(roofOnly.frame, { x: [0, 10], y: [0, 10] });
  assert.deepEqual([roofOnly.lines, roofOnly.rows], [[], []]);
});

test('【失敗系】composeSitePlacementGrid: 片方の軸だけ・屋根なしだと、相手の枠が無いので縦線も寸法も描かない', () => {
  const xOnly = composeSitePlacementGrid({ gridLines: mkLines([50000, 53000, 56000], []), roofBounds: null });
  assert.equal(xOnly.frame.y, null);
  assert.deepEqual([xOnly.lines, xOnly.rows], [[], []]);
  const yOnly = composeSitePlacementGrid({ gridLines: mkLines([], [30000, 34000]), roofBounds: null });
  assert.deepEqual([yOnly.lines, yOnly.rows], [[], []]);
  // 屋根があれば相手の枠は屋根から取れて描ける
  const withRoof = composeSitePlacementGrid({ gridLines: mkLines([50000, 53000, 56000], []), roofBounds: { minX: 49000, minY: 29000, maxX: 57000, maxY: 35000 } });
  assert.equal(withRoof.lines.length, 3);
  assert.equal(withRoof.rows.length, 2);
});

// ---- layoutSitePlacementGrid ----

/** 枠 x 48000..62000・y 28000..36000（屋根が通り芯より広い）。X 3 本（行 2 段）・Y 2 本（行 1 段）。 */
const layoutGrid = () => composeSitePlacementGrid({
  gridLines: mkLines([50000, 53640, 57280], [30000, 34000]),
  roofBounds: { minX: 48000, minY: 28000, maxX: 62000, maxY: 36000 },
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test('layoutSitePlacementGrid: 寸法線は枠の外（X 行は枠の上端より上・Y 行は左端より左）。1 段目＝16px・2 段目＝16＋24px。数値は線の手前（−11−2px）', () => {
  const l = layoutSitePlacementGrid(layoutGrid(), 1);
  const x0 = l.rows.find(r => r.axis === V && r.key.endsWith('/0')), x1 = l.rows.find(r => r.axis === V && r.key.endsWith('/1'));
  const y0 = l.rows.find(r => r.axis === H);
  assert.equal(x0.side, DimensionSide.TOP);
  assert.equal(y0.side, DimensionSide.LEFT);
  near(x0.lineCoord, 28000 - 16);
  near(x1.lineCoord, 28000 - 40);
  near(y0.lineCoord, 48000 - 16);
  near(x0.normalNumCoord, x0.lineCoord - 13);
  near(y0.normalNumCoord, y0.lineCoord - 13);
  assert.ok(x1.lineCoord < x0.lineCoord, '全長の段は間隔の段より外');
});

test('layoutSitePlacementGrid: 寸法線上の点は通り芯との交点（X 行は x=通り芯・y=線、Y 行は x=線・y=通り芯）', () => {
  const l = layoutSitePlacementGrid(layoutGrid(), 1);
  const x0 = l.rows.find(r => r.axis === V && r.key.endsWith('/0'));
  assert.deepEqual(x0.dots.map(d => [d.x, d.y]), [[50000, x0.lineCoord], [53640, x0.lineCoord], [57280, x0.lineCoord]]);
  const y0 = l.rows.find(r => r.axis === H);
  assert.deepEqual(y0.dots.map(d => [d.x, d.y]), [[y0.lineCoord, 30000], [y0.lineCoord, 34000]]);
  assert.equal(new Set(l.rows.flatMap(r => r.dots.map(d => d.key))).size, 3 + 2 + 2, '点の key は重ならない');
});

test('layoutSitePlacementGrid: 離れは画面 px 固定（scale 2 では世界 mm が半分）', () => {
  const g = layoutGrid();
  const a = layoutSitePlacementGrid(g, 1), b = layoutSitePlacementGrid(g, 2);
  a.rows.forEach((ra, i) => {
    const edge = ra.axis === V ? 28000 : 48000;
    near((edge - b.rows[i].lineCoord) * 2, edge - ra.lineCoord);
  });
  const la = a.labels[0], lb = b.labels[0];
  near((28000 - lb.y) * 2, 28000 - la.y);
});

test('layoutSitePlacementGrid: 丸の中心は枠から（最も外の行の数値帯の外＋6px＋半径12px）。両端で同じ距離。線は丸の中心から丸の中心まで', () => {
  const l = layoutSitePlacementGrid(layoutGrid(), 1);
  // X は行 2 段: 16＋24＋11＋2＋6＝59、＋半径 12 → 71。Y は行 1 段: 16＋11＋2＋6＝35、＋12 → 47
  const x1 = l.labels.filter(t => t.key.includes('/x1/'));
  assert.equal(x1.length, 2);
  near(28000 - x1[0].y, 71);
  near(x1[1].y - 36000, 71);
  assert.deepEqual([x1[0].x, x1[1].x], [53640, 53640]);
  assert.deepEqual(x1.map(t => t.label), ['X2', 'X2']);
  const y0 = l.labels.filter(t => t.key.includes('/y0/'));
  near(48000 - y0[0].x, 47);
  near(y0[1].x - 62000, 47);
  assert.deepEqual([y0[0].y, y0[1].y], [30000, 30000]);
  const lineX1 = l.lines.find(t => t.key.endsWith('/x1'));
  assert.deepEqual(lineX1.points, [x1[0].x, x1[0].y, x1[1].x, x1[1].y]);
  const lineY0 = l.lines.find(t => t.key.endsWith('/y0'));
  assert.deepEqual(lineY0.points, [y0[0].x, y0[0].y, y0[1].x, y0[1].y]);
  assert.equal(l.lines.length, 5);
  assert.equal(l.labels.length, 10);
});

test('layoutSitePlacementGrid: 通り芯 0 本は空（例外なし）。行が 0 段の軸でも丸は数値帯 1 段分の外に置く', () => {
  const empty = layoutSitePlacementGrid(composeSitePlacementGrid({ gridLines: [], roofBounds: null }), 1);
  assert.deepEqual(empty, { lines: [], labels: [], rows: [] });
  const one = layoutSitePlacementGrid(composeSitePlacementGrid({
    gridLines: mkLines([50000], [30000]), roofBounds: { minX: 49000, minY: 29000, maxX: 51000, maxY: 31000 },
  }), 1);
  assert.equal(one.rows.length, 0);
  near(29000 - one.labels[0].y, 47); // 16＋11＋2＋6＋12
});

// ---- composeSitePlacementView への配線 ----

const rectRegion = (key, x0, y0, x1, y1) => ({
  key, outlineOnly: true,
  exposedPaths: [{ points: [x0, y0, x1, y0, x1, y1, x0, y1], closed: true }],
});

test('composeSitePlacementView: grid は roof.gridLines と屋根の外接矩形から組む（屋根が広ければ枠は屋根）', () => {
  const roof = {
    floors: [{ planeId: 'p1', regions: [rectRegion('r', 48000, 28000, 62000, 36000)] }],
    gridBounds: null, gridLines: mkLines([50000, 53640, 57280], [30000, 34000]), readFailed: false,
  };
  const v = composeSitePlacementView({ site: new Site(), roof });
  assert.deepEqual(v.grid.frame, { x: [48000, 62000], y: [28000, 36000] });
  assert.equal(v.grid.lines.length, 5);
  assert.equal(v.grid.rows.length, 3);
});

test('composeSitePlacementView: 通り芯の写し（gridLines）は図芯の基準にしない（屋根なし・gridBounds なしなら gridLines があっても NONE・移動なし）', () => {
  const site = new Site();
  site.addRect(0, 0, 4000, 2000);
  const v = composeSitePlacementView({
    site, roof: { floors: [], gridBounds: null, gridLines: mkLines([50000, 53000], [30000, 34000]), readFailed: false },
  });
  assert.equal(v.centerSource, SitePlacementCenterSource.NONE);
  assert.equal(v.buildingCenter, null);
  assert.deepEqual([v.siteTransform.tx, v.siteTransform.ty], [0, 0]);
  assert.equal(v.grid.lines.length, 4, '通り芯の線自体は描く');
});

test('【失敗系】composeSitePlacementView: gridLines が無い（旧形の roof・null）でも grid は空で例外なし', () => {
  for (const roof of [{ floors: [], gridBounds: null, readFailed: false }, null]) {
    const v = composeSitePlacementView({ site: new Site(), roof });
    assert.deepEqual(v.grid, { frame: { x: null, y: null }, lines: [], rows: [] });
  }
});
