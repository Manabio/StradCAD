// 配置図の通り芯（線・丸ラベル・寸法。site/sitePlacementGrid.js）の純モジュールのテスト。
// fixture は原点から離す（0 起点だと符号・基準の取り違えが偶然一致する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, Site, CenterLineType, Discipline, DimensionSide } from '@core';
import { SitePlacementCenterSource } from '../core/constants.js';
import {
  gridLineSnapshot, markExteriorGridLines, composeSitePlacementGrid, layoutSitePlacementGrid, computeSiteGapDimensions,
} from './sitePlacementGrid.js';
import { composeSitePlacementView, boundsOfPointLists } from './sitePlacementView.js';

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
  assert.deepEqual(g.lines[0], { key: g.lines[0].key, id: 'x0', centerLineType: V, value: 50000, label: 'X1', exterior: false });
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

test('layoutSitePlacementGrid: 寸法線は枠の外（X 行は枠の上端より上・Y 行は左端より左）。1 段目＝32px・2 段目＝32＋24px。数値は線の手前（−11−2px）', () => {
  const l = layoutSitePlacementGrid(layoutGrid(), 1);
  const x0 = l.rows.find(r => r.axis === V && r.key.endsWith('/0')), x1 = l.rows.find(r => r.axis === V && r.key.endsWith('/1'));
  const y0 = l.rows.find(r => r.axis === H);
  assert.equal(x0.side, DimensionSide.TOP);
  assert.equal(y0.side, DimensionSide.LEFT);
  near(x0.lineCoord, 28000 - 32);
  near(x1.lineCoord, 28000 - 56);
  near(y0.lineCoord, 48000 - 32);
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
  // X は行 2 段: 32＋24＋11＋2＋6＝75、＋半径 12 → 87。Y は行 1 段: 32＋11＋2＋6＝51、＋12 → 63
  const x1 = l.labels.filter(t => t.key.includes('/x1/'));
  assert.equal(x1.length, 2);
  near(28000 - x1[0].y, 87);
  near(x1[1].y - 36000, 87);
  assert.deepEqual([x1[0].x, x1[1].x], [53640, 53640]);
  assert.deepEqual(x1.map(t => t.label), ['X2', 'X2']);
  const y0 = l.labels.filter(t => t.key.includes('/y0/'));
  near(48000 - y0[0].x, 63);
  near(y0[1].x - 62000, 63);
  assert.deepEqual([y0[0].y, y0[1].y], [30000, 30000]);
  const lineX1 = l.lines.find(t => t.key.endsWith('/x1'));
  assert.deepEqual(lineX1.points, [x1[0].x, x1[0].y + 12, x1[1].x, x1[1].y - 12], '線の端は丸の縁（中心から半径 12px 手前）');
  const lineY0 = l.lines.find(t => t.key.endsWith('/y0'));
  assert.deepEqual(lineY0.points, [y0[0].x + 12, y0[0].y, y0[1].x - 12, y0[1].y]);
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
  near(29000 - one.labels[0].y, 63); // 32＋11＋2＋6＋12
});

// ---- 敷地の外周（siteBounds）で線と丸ラベルの枠を広げる ----
// scale 1: 丸の離れ X 軸（行 2 段）87・Y 軸（行 1 段）63

const withSite = siteBounds => composeSitePlacementGrid({
  gridLines: mkLines([50000, 53640, 57280], [30000, 34000]),
  roofBounds: { minX: 48000, minY: 28000, maxX: 62000, maxY: 36000 },
  siteBounds,
});
const labelsOf = (l, id) => l.labels.filter(t => t.id === id);

test('composeSitePlacementGrid: frame＝屋根 ∪ 通り芯 ∪ siteBounds。siteBounds なし・敷地が内側なら従来の枠', () => {
  assert.deepEqual(withSite({ minX: 40000, minY: 20000, maxX: 70000, maxY: 45000 }).frame, { x: [40000, 70000], y: [20000, 45000] });
  assert.deepEqual(withSite(null).frame, { x: [48000, 62000], y: [28000, 36000] });
  assert.deepEqual(withSite({ minX: 49000, minY: 29000, maxX: 61000, maxY: 35000 }).frame, { x: [48000, 62000], y: [28000, 36000] });
  assert.deepEqual(withSite({ minX: 47000, minY: 29000, maxX: 61000, maxY: 37000 }).frame, { x: [47000, 62000], y: [28000, 37000] });
  assert.equal(withSite({ minX: 40000, minY: 20000, maxX: 70000, maxY: 45000 }).lineFrame, undefined, 'lineFrame は廃止（frame に一本化）');
});

test('【失敗系】composeSitePlacementGrid: 屋根も通り芯も無い軸は、敷地だけがあっても枠が null で線も寸法も描かない', () => {
  const site = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  assert.deepEqual(composeSitePlacementGrid({ gridLines: [], roofBounds: null, siteBounds: site }), { frame: { x: null, y: null }, lines: [], rows: [] });
  // 片軸だけ（X の通り芯だけ・屋根なし）は y の枠が無いので縦線も寸法も出ない（敷地があっても）
  const xOnly = composeSitePlacementGrid({ gridLines: mkLines([5, 8, 11], []), roofBounds: null, siteBounds: site });
  assert.equal(xOnly.frame.y, null);
  assert.deepEqual([xOnly.lines, xOnly.rows], [[], []]);
});

// 敷地 13000×15000 を配置（左縁 x=−2000・右縁 11000・下縁 y=1500・上縁 y=−13500）。通り芯 X 3 本・Y 2 本は敷地の中
const placedGrid = () => composeSitePlacementGrid({
  gridLines: mkLines([0, 3640, 7280], [-4000, 0]),
  roofBounds: { minX: -500, minY: -4500, maxX: 7800, maxY: 500 },
  siteBounds: { minX: -2000, minY: -13500, maxX: 11000, maxY: 1500 },
});

test('layoutSitePlacementGrid: 寸法行は敷地込みの枠の縁から 32px 外（X 行 y＝−13500−32・Y 行 x＝−2000−32）。2 段目はさらに 24px 外', () => {
  const l = layoutSitePlacementGrid(placedGrid(), 1);
  near(l.rows.find(r => r.axis === V && r.key.endsWith('/0')).lineCoord, -13500 - 32);
  near(l.rows.find(r => r.axis === V && r.key.endsWith('/1')).lineCoord, -13500 - 56);
  near(l.rows.find(r => r.axis === H).lineCoord, -2000 - 32);
});

test('layoutSitePlacementGrid: Y 軸の寸法（HORIZONTAL・左側）の行が出て、位置は敷地込みの枠の左縁基準。点は x＝線・y＝通り芯', () => {
  const g = placedGrid();
  const rowsY = g.rows.filter(r => r.axis === H);
  assert.equal(rowsY.length, 1, 'Y 2 本は間隔の段だけ');
  assert.equal(rowsY[0].side, DimensionSide.LEFT);
  assert.deepEqual(rowsY[0].segments, [{ v1: -4000, v2: 0, length: 4000 }]);
  const l = layoutSitePlacementGrid(g, 1);
  const y0 = l.rows.find(r => r.axis === H);
  near(y0.lineCoord, g.frame.x[0] - 32);
  assert.deepEqual(y0.dots.map(d => [d.x, d.y]), [[-2000 - 32, -4000], [-2000 - 32, 0]]);
});

test('layoutSitePlacementGrid: 丸ラベルは寸法行（数値帯まで）のさらに外。X 行 2 段なら y＝−13500−87、Y 行 1 段なら x＝−2000−63。線の端は丸の縁', () => {
  const l = layoutSitePlacementGrid(placedGrid(), 1);
  const x1 = labelsOf(l, 'x1');
  near(x1[0].y, -13500 - 87);
  near(x1[1].y, 1500 + 87);
  const y0 = labelsOf(l, 'y0');
  near(y0[0].x, -2000 - 63);
  near(y0[1].x, 11000 + 63);
  const row2 = l.rows.find(r => r.axis === V && r.key.endsWith('/1'));
  assert.ok(x1[0].y < row2.normalNumCoord - 11, '丸の中心は最も外の寸法行の数値より外');
});

test('layoutSitePlacementGrid: 敷地が小さく枠が屋根・通り芯で決まるなら従来の位置（丸 X 87・Y 63）。敷地込みでも離れは画面 px 固定（scale 2 で半分）', () => {
  const l = layoutSitePlacementGrid(withSite({ minX: 49000, minY: 29000, maxX: 61000, maxY: 35000 }), 1);
  near(labelsOf(l, 'x1')[0].y, 28000 - 87);
  near(labelsOf(l, 'x1')[1].y, 36000 + 87);
  near(labelsOf(l, 'y0')[0].x, 48000 - 63);
  near(labelsOf(l, 'y0')[1].x, 62000 + 63);
  const l2 = layoutSitePlacementGrid(placedGrid(), 2);
  near(l2.rows.find(r => r.axis === V && r.key.endsWith('/0')).lineCoord, -13500 - 16);
  near(-13500 - labelsOf(l2, 'x1')[0].y, 43.5);
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

// ---- markExteriorGridLines・丸ラベルの id / exterior ----

test('markExteriorGridLines: 指定した id だけ exterior: true・他は false。元の配列も要素も変えない', () => {
  const lines = mkLines([50000, 53000, 57000], [30000, 34000]);
  const before = JSON.stringify(lines);
  const marked = markExteriorGridLines(lines, new Set(['x0', 'x2', 'y1']));
  assert.deepEqual(marked.map(g => [g.id, g.exterior]), [['x0', true], ['x1', false], ['x2', true], ['y0', false], ['y1', true]]);
  assert.equal(JSON.stringify(lines), before, '元の配列・要素は不変');
  assert.notEqual(marked, lines);
  assert.ok(lines.every(g => !('exterior' in g)));
  assert.deepEqual(marked.map(g => ({ ...g, exterior: undefined })), lines.map(g => ({ ...g, exterior: undefined })), 'exterior 以外の項目はそのまま');
});

test('markExteriorGridLines: 外周の id が空（外壁が 1 本も無い）なら全部 exterior: true。配列でも受ける。写しが空なら空', () => {
  const lines = mkLines([50000, 53000], [30000]);
  assert.ok(markExteriorGridLines(lines, new Set()).every(g => g.exterior === true));
  assert.ok(markExteriorGridLines(lines, []).every(g => g.exterior === true));
  assert.deepEqual(markExteriorGridLines(lines, ['x1']).map(g => g.exterior), [false, true, false]);
  assert.deepEqual(markExteriorGridLines([], new Set(['x0'])), []);
});

test('markExteriorGridLines: 写しに無い id だけが外周のとき（外壁の軸が全部 階固有の中心線）は全部 true（一致が 0 本＝外周が判定できないので候補を空にしない）', () => {
  const marked = markExteriorGridLines(mkLines([50000, 53000], [30000]), new Set(['local-cl']));
  assert.deepEqual(marked.map(g => g.exterior), [true, true, true]);
  assert.deepEqual(markExteriorGridLines(mkLines([50000, 53000], []), new Set(['local-cl', 'x1'])).map(g => g.exterior), [false, true], '1 本でも一致すれば通常どおり');
});

test('layoutSitePlacementGrid: labels の各要素に通り芯の id と exterior が載る（両端とも）', () => {
  const lines = markExteriorGridLines(mkLines([50000, 53000], [30000, 34000]), new Set(['x1', 'y0']));
  const grid = composeSitePlacementGrid({ gridLines: lines, roofBounds: null });
  assert.deepEqual(grid.lines.map(l => [l.id, l.exterior]), [['x0', false], ['x1', true], ['y0', true], ['y1', false]]);
  const l = layoutSitePlacementGrid(grid, 0.1);
  assert.equal(l.labels.length, 8);
  for (const [id, exterior] of [['x0', false], ['x1', true], ['y0', true], ['y1', false]]) {
    const ends = l.labels.filter(t => t.id === id);
    assert.equal(ends.length, 2, `${id} は両端に丸`);
    assert.ok(ends.every(t => t.exterior === exterior && t.key.includes(`/${id}/`)), `${id} の exterior は ${exterior}`);
  }
});

// ---- はなれ寸法（S14）。最外周の通り芯と敷地の境界線の距離 ----

/** 閉じた多角形の点列 [[x,y],…] → 外周の線分列（配置図座標）。 */
const polySegs = pts => pts.map((p, i) => ({ points: [p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]] }));
const closeTo = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

// 実機相当: 敷地 13000×15000 を左上 (−2000,−13500) に配置 → x −2000..11000・y −13500..1500。
// 通り芯 X 0/1820/3640/7280/9100、Y −12614/−7000/−3640/0（Y は昇順＝上が最小）
const RECT_SITE = polySegs([[-2000, -13500], [11000, -13500], [11000, 1500], [-2000, 1500]]);
const REAL_GRID = mkLines([0, 1820, 3640, 7280, 9100], [-12614, -7000, -3640, 0]);
const REAL_ROOF = { minX: -500, minY: -13000, maxX: 9600, maxY: 500 };
const realGrid = (siteSegmentsPlaced, gridLines = REAL_GRID) => composeSitePlacementGrid({
  gridLines, roofBounds: REAL_ROOF, siteBounds: boundsOfPointLists(siteSegmentsPlaced.map(s => s.points)), siteSegmentsPlaced,
});
const gapRowsOf = grid => grid.rows.filter(r => r.key.includes('/gap/'));
const gapRowOf = (grid, side) => gapRowsOf(grid).find(r => r.side === side);
const gapRowsOn = (grid, side) => gapRowsOf(grid).filter(r => r.side === side);
const gapLengths = (grid, side) => gapRowsOn(grid, side).flatMap(r => r.segments.map(s => s.length));

test('computeSiteGapDimensions: 長方形敷地 → 左 2000（上下どちらの位置でも）・右 1900・上 886・下 1500。側ごと pos 昇順・from＝通り芯の値・to＝境界線の座標', () => {
  const g = computeSiteGapDimensions({ gridLines: REAL_GRID, siteSegments: RECT_SITE });
  assert.deepEqual(g.map(x => [x.side, x.pos]), [
    [DimensionSide.LEFT, -12614], [DimensionSide.LEFT, 0], [DimensionSide.RIGHT, -12614], [DimensionSide.RIGHT, 0],
    [DimensionSide.TOP, 0], [DimensionSide.TOP, 9100], [DimensionSide.BOTTOM, 0], [DimensionSide.BOTTOM, 9100],
  ]);
  assert.deepEqual(g.filter(x => x.side === DimensionSide.LEFT).map(x => [x.from, x.to, x.length]), [[0, -2000, 2000], [0, -2000, 2000]]);
  assert.deepEqual(g.filter(x => x.side === DimensionSide.RIGHT).map(x => [x.from, x.to, x.length]), [[9100, 11000, 1900], [9100, 11000, 1900]]);
  assert.deepEqual(g.filter(x => x.side === DimensionSide.TOP).map(x => [x.from, x.to, x.length]), [[-12614, -13500, 886], [-12614, -13500, 886]]);
  assert.deepEqual(g.filter(x => x.side === DimensionSide.BOTTOM).map(x => [x.from, x.to, x.length]), [[0, 1500, 1500], [0, 1500, 1500]]);
});

test('computeSiteGapDimensions: 直交する軸の通り芯が 1 本なら位置は 1 つ（左右＝HORIZONTAL が 1 本）', () => {
  const g = computeSiteGapDimensions({ gridLines: mkLines([0, 9100], [-5000]), siteSegments: RECT_SITE });
  assert.deepEqual(g.filter(x => x.side === DimensionSide.LEFT || x.side === DimensionSide.RIGHT).map(x => [x.side, x.pos, x.length]),
    [[DimensionSide.LEFT, -5000, 2000], [DimensionSide.RIGHT, -5000, 1900]]);
  assert.equal(g.filter(x => x.side === DimensionSide.TOP).length, 2, '上下は VERTICAL が 2 本なので位置 2 つ');
});

test('computeSiteGapDimensions: 斜めの境界線（左辺が傾いた台形）は位置で値が違う。上 −12614 で 2882（−3000+2000×886/15000）・下 0 で 1200', () => {
  const trapezoid = polySegs([[-3000, -13500], [11000, -13500], [11000, 1500], [-1000, 1500]]);
  const left = computeSiteGapDimensions({ gridLines: REAL_GRID, siteSegments: trapezoid }).filter(x => x.side === DimensionSide.LEFT);
  assert.deepEqual(left.map(x => [x.pos, x.length]), [[-12614, 2882], [0, 1200]]);
  closeTo(left[0].to, -3000 + 2000 * 886 / 15000);
  closeTo(left[1].to, -1200);
});

test('computeSiteGapDimensions: 半直線が線分の端点（凹んだ頂点）にちょうど当たっても 1 つだけ（頂点を共有する 2 本で二重に数えない）', () => {
  // 頂点 B(−2000,0) を、AB と BC の 2 本が共有する。Y 通り芯 0 の半直線は B に当たる
  const kite = polySegs([[-1000, -5000], [-2000, 0], [-1000, 5000], [11000, 5000], [11000, -5000]]);
  const left = computeSiteGapDimensions({ gridLines: mkLines([0, 5000], [0, 4000]), siteSegments: kite }).filter(x => x.side === DimensionSide.LEFT);
  assert.deepEqual(left.map(x => [x.pos, x.length]), [[0, 2000], [4000, 1200]], '位置ごとに 1 件。y=4000 は BC 上（−2000+800）');
});

test('computeSiteGapDimensions: 半直線が複数の線分と交わるときは最初の交点（外周の内側にある線分 x=−500 が外の境界線 x=−2000 より先）', () => {
  const withInner = [...RECT_SITE, ...polySegs([[-1000, -1000], [-500, -1000], [-500, 1000], [-1000, 1000]])];
  const left = computeSiteGapDimensions({ gridLines: REAL_GRID, siteSegments: withInner }).filter(x => x.side === DimensionSide.LEFT);
  assert.deepEqual(left.map(x => [x.pos, x.length]), [[-12614, 2000], [0, 500]], 'y=0 は内側の小さな四角の右辺 x=−500 に先に当たる');
});

test('【失敗系】computeSiteGapDimensions: 敷地が通り芯の外へ出ない側は無し（左の境界線が x=0 より右）。敷地なし・直交軸の通り芯 0 本は []', () => {
  const inner = polySegs([[100, -13500], [11000, -13500], [11000, 1500], [100, 1500]]);
  const g = computeSiteGapDimensions({ gridLines: REAL_GRID, siteSegments: inner });
  assert.equal(g.filter(x => x.side === DimensionSide.LEFT).length, 0, '左は半直線が境界線に当たらない');
  assert.equal(g.filter(x => x.side === DimensionSide.RIGHT).length, 2);
  assert.deepEqual(computeSiteGapDimensions({ gridLines: REAL_GRID, siteSegments: [] }), []);
  assert.deepEqual(computeSiteGapDimensions({ gridLines: REAL_GRID, siteSegments: null }), []);
  assert.deepEqual(computeSiteGapDimensions({ gridLines: mkLines([0, 9100], []), siteSegments: RECT_SITE }), [], 'HORIZONTAL が 0 本');
  assert.deepEqual(computeSiteGapDimensions({ gridLines: mkLines([], [0, 5000]), siteSegments: RECT_SITE }), [], 'VERTICAL が 0 本');
  assert.deepEqual(computeSiteGapDimensions({ gridLines: [], siteSegments: RECT_SITE }), []);
});

test('composeSitePlacementGrid: 長方形敷地は上・左の最外に「はなれ」の段（tier＝既存の段数 2）。下・右は値が同じなので出さない', () => {
  const grid = realGrid(RECT_SITE);
  assert.equal(grid.rows.length, 8, 'X: 間隔・全長＋はなれ 2 行（左・右）／Y: 間隔・全長＋はなれ 2 行（上・下）。はなれは測った側ごとに 1 行');
  const top = gapRowsOn(grid, DimensionSide.TOP);
  assert.deepEqual(top.map(r => [r.axis, r.tier]), [[V, 2], [V, 2]], '同じ段');
  assert.deepEqual(top.map(r => r.segments), [[{ v1: -2000, v2: 0, length: 2000 }], [{ v1: 9100, v2: 11000, length: 1900 }]]);
  assert.deepEqual(top.map(r => r.anchors), [[-2000, 0], [9100, 11000]]);
  const left = gapRowsOn(grid, DimensionSide.LEFT);
  assert.deepEqual(left.map(r => [r.axis, r.tier]), [[H, 2], [H, 2]]);
  assert.deepEqual(left.map(r => r.segments), [[{ v1: -13500, v2: -12614, length: 886 }], [{ v1: 0, v2: 1500, length: 1500 }]]);
  assert.equal(gapRowOf(grid, DimensionSide.BOTTOM), undefined);
  assert.equal(gapRowOf(grid, DimensionSide.RIGHT), undefined);
  assert.equal(new Set(grid.rows.map(r => r.key)).size, 8, 'key は重ならない');
});

test('composeSitePlacementGrid: 通り芯が少なく既存の段が 1 段（Y 2 本＝間隔だけ）なら、はなれの tier は 1。既存の段が無ければ 0', () => {
  const grid = realGrid(RECT_SITE, mkLines([0, 9100], [-12614, 0]));
  assert.equal(gapRowOf(grid, DimensionSide.TOP).tier, 1);
  assert.equal(gapRowOf(grid, DimensionSide.LEFT).tier, 1);
  const none = realGrid(RECT_SITE, mkLines([0], [-5000]));
  assert.equal(gapRowOf(none, DimensionSide.TOP).tier, 0);
  assert.equal(gapRowOf(none, DimensionSide.LEFT).tier, 0);
});

test('【失敗系】composeSitePlacementGrid: X 最小の通り芯が境界線上（x＝−2000・はなれ 0）なら左向きの「はなれ」を出さない（t>0 の交点にならない）', () => {
  const grid = realGrid(RECT_SITE, mkLines([-2000, 1820, 9100], [-12614, -7000, -3640, 0]));
  const gaps = computeSiteGapDimensions({ gridLines: mkLines([-2000, 1820, 9100], [-12614, -7000, -3640, 0]), siteSegments: RECT_SITE });
  assert.equal(gaps.filter(g => g.side === DimensionSide.LEFT).length, 0, '左向きのはなれは出ない');
  assert.equal(gaps.filter(g => g.side === DimensionSide.RIGHT).length, 2, '右向きは出る');
  assert.deepEqual(gapLengths(grid, DimensionSide.TOP), [1900], '上の行は右のはなれだけ');
});

test('composeSitePlacementGrid: 左辺が傾いて下端の値が違うと、下（BOTTOM・tier 0）に「はなれ」だけの行が出る。右は上下とも同じなので出ない', () => {
  const trapezoid = polySegs([[-3000, -13500], [11000, -13500], [11000, 1500], [-1000, 1500]]);
  const grid = realGrid(trapezoid);
  assert.deepEqual(gapLengths(grid, DimensionSide.TOP), [2882, 1900], '上端（Y 最小）の左右');
  const bottom = gapRowsOn(grid, DimensionSide.BOTTOM);
  assert.deepEqual(bottom.map(r => [r.axis, r.tier]), [[V, 0], [V, 0]]);
  assert.deepEqual(bottom.map(r => r.segments), [[{ v1: -1200, v2: 0, length: 1200 }], [{ v1: 9100, v2: 11000, length: 1900 }]], '下端（Y 最大）の左右。1 行 1 区間');
  assert.equal(gapRowOf(grid, DimensionSide.RIGHT), undefined);
  assert.equal(gapRowsOf(grid).length, 6, '上 2・左 2・下 2');
});

test('composeSitePlacementGrid: 上辺が傾いて右端の値が違うと、右（RIGHT・tier 0）に行が出る。値が違うかは Math.round 後で比べる（左端 809 と右端 459）', () => {
  const slantTop = polySegs([[-2000, -13500], [11000, -13000], [11000, 1500], [-2000, 1500]]);
  const grid = realGrid(slantTop);
  const right = gapRowsOn(grid, DimensionSide.RIGHT);
  assert.deepEqual(right.map(r => [r.axis, r.tier]), [[H, 0], [H, 0]]);
  assert.deepEqual(gapLengths(grid, DimensionSide.RIGHT), [459, 1500], '右端（X 最大 9100）の上下');
  closeTo(right[0].segments[0].v1, -13500 + 500 * 11100 / 13000);
  assert.deepEqual(gapLengths(grid, DimensionSide.LEFT), [809, 1500], '左端（X 最小 0）の上下');
  assert.equal(gapRowOf(grid, DimensionSide.BOTTOM), undefined);
});

test('【失敗系】composeSitePlacementGrid: 敷地なし（siteSegmentsPlaced 無し・空）は従来どおり（はなれの行なし・他の行も変わらない）。通り芯が片軸だけでも例外なし', () => {
  const base = composeSitePlacementGrid({ gridLines: REAL_GRID, roofBounds: REAL_ROOF });
  const empty = composeSitePlacementGrid({ gridLines: REAL_GRID, roofBounds: REAL_ROOF, siteSegmentsPlaced: [] });
  assert.equal(gapRowsOf(base).length, 0);
  assert.deepEqual(empty, base);
  assert.equal(base.rows.length, 4);
  const xOnly = realGrid(RECT_SITE, mkLines([0, 3640, 9100], []));
  assert.equal(gapRowsOf(xOnly).length, 0);
});

test('layoutSitePlacementGrid: はなれの段は既存の段の外側（上・左の最外 tier 2）。線は枠の縁から 32＋2×24＝80px、数値は線の手前（−11−2px）', () => {
  const l = layoutSitePlacementGrid(realGrid(RECT_SITE), 1);
  const tops = l.rows.filter(r => r.key.includes('/gap/top/'));
  assert.equal(tops.length, 2, '左のはなれ・右のはなれの 2 行');
  for (const top of tops) {
    near(top.lineCoord, -13500 - 80);
    near(top.normalNumCoord, -13500 - 80 - 13);
    assert.ok(top.lineCoord < l.rows.find(r => r.axis === V && r.key.endsWith('/1')).lineCoord, '全長の段より外');
  }
  assert.deepEqual(tops.map(t => t.dots.map(d => [d.x, d.y])), [[[-2000, -13580], [0, -13580]], [[9100, -13580], [11000, -13580]]], '線は区間だけ（間の通り芯の範囲には引かない）');
  const lefts = l.rows.filter(r => r.key.includes('/gap/left/'));
  assert.deepEqual(lefts.map(t => t.dots.map(d => [d.x, d.y])), [[[-2080, -13500], [-2080, -12614]], [[-2080, 0], [-2080, 1500]]]);
  lefts.forEach(t => near(t.lineCoord, -2000 - 80));
});

test('layoutSitePlacementGrid: 丸ラベルは段が 1 つ増えた分（24px）だけ外へ。上下左右ともはなれなしの配置より外（下・右に行が無ければ上・左と同じ距離）', () => {
  const withGap = layoutSitePlacementGrid(realGrid(RECT_SITE), 1);
  // 同じ枠（敷地の外接矩形）で、はなれだけ測らない（siteSegmentsPlaced を渡さない）
  const without = layoutSitePlacementGrid(composeSitePlacementGrid({
    gridLines: REAL_GRID, roofBounds: REAL_ROOF, siteBounds: boundsOfPointLists(RECT_SITE.map(s => s.points)),
  }), 1);
  // はなれなし（X・Y とも 2 段）: 32＋24＋19＋12＝87。はなれあり（3 段）: 111
  const sx = (l, id) => l.labels.filter(t => t.id === id);
  const x = sx(withGap, 'x1'), x0 = sx(without, 'x1');
  near(x0[0].y, -13500 - 87);
  near(x[0].y, -13500 - 111);
  near(x[1].y, 1500 + 111);
  const y = sx(withGap, 'y1'), y0 = sx(without, 'y1');
  near(y0[0].x, -2000 - 87);
  near(y[0].x, -2000 - 111);
  near(y[1].x, 11000 + 111);
});

test('layoutSitePlacementGrid: 下（BOTTOM）の行は枠の下端から外（＋）へ 32px、数値は線の外側（＋2px）。下の丸ラベルはその側の行数（1 段）で離す', () => {
  const trapezoid = polySegs([[-3000, -13500], [11000, -13500], [11000, 1500], [-1000, 1500]]);
  const l = layoutSitePlacementGrid(realGrid(trapezoid), 1);
  const bottoms = l.rows.filter(r => r.key.includes('/gap/bottom/'));
  for (const b of bottoms) {
    near(b.lineCoord, 1500 + 32);
    near(b.normalNumCoord, 1500 + 32 + 2);
  }
  assert.deepEqual(bottoms.map(b => b.dots.map(d => [d.x, d.y])), [[[-1200, 1532], [0, 1532]], [[9100, 1532], [11000, 1532]]]);
  const x = l.labels.filter(t => t.id === 'x1');
  near(x[0].y, -13500 - 111, '上は 3 段');
  near(x[1].y, 1500 + 63, '下は行 1 段: 32＋19＋12');
  // 右には行が無い（上下とも同じ値）→ 左と同じ 3 段の距離。左の行は frame の左縁（−3000）基準
  const y = l.labels.filter(t => t.id === 'y1');
  near(y[0].x, -3000 - 111);
  near(y[1].x, 11000 + 111);
  l.rows.filter(r => r.key.includes('/gap/left/')).forEach(r => near(r.lineCoord, -3000 - 80));
});

test('layoutSitePlacementGrid: 右（RIGHT）の行は枠の右端から外へ 32px。右の丸ラベルは 1 段（32＋19＋12＝63）', () => {
  const slantTop = polySegs([[-2000, -13500], [11000, -13000], [11000, 1500], [-2000, 1500]]);
  const l = layoutSitePlacementGrid(realGrid(slantTop), 1);
  const rights = l.rows.filter(r => r.key.includes('/gap/right/'));
  assert.equal(rights.length, 2);
  for (const right of rights) {
    near(right.lineCoord, 11000 + 32);
    near(right.normalNumCoord, 11000 + 32 + 2);
    assert.equal(right.dots.length, 2);
    right.dots.forEach(d => near(d.x, 11032));
  }
  const y = l.labels.filter(t => t.id === 'y1');
  near(y[0].x, -2000 - 111);
  near(y[1].x, 11000 + 63);
  // 下の行は無い → 下の丸（X 通り芯）は上と同じ 3 段
  const x = l.labels.filter(t => t.id === 'x1');
  near(x[1].y, 1500 + 111);
});
