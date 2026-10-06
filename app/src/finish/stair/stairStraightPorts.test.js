// 直進系（STRAIGHT・STRAIGHT_LANDING）の側面の出入口（ステップ9b）の本番経路テスト。
// 側面から入る（出る）ときは区画（先頭・末尾の行）が取りつきの回転部になり、直進部は区画を除いた区間。
// フィクスチャは北向き（up）の直進: 下端が上り口（t=0）、上端が到達口。ys は行の境界（y 下向き正）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide, Stair } from '@core';
import { measureStairSpans, uTurnSpans } from './stairClassify.js';
import { straightPortInfoOf, resolveStraightPorts } from './stairPorts.js';
import {
  buildStairGeometry, insetStairBounds, stairPortEdges, stairSegmentDims, cellsBeyondBreak,
  straightBreakMm, resolveStraightPortsOf,
} from './stairGeometry.js';
import { makeFrame } from './stairFrame.js';
import { roomBounds, cellBoundsFromKey } from '../gridCells.js';
import { portSideChange, resetPortSides, sectionsForType } from './stairSectionEdit.js';

const { LEFT, RIGHT } = StairPortSide;

function straight(ys, cols = 2, extra = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const xs = Array.from({ length: cols + 1 }, (_, i) => i * 1000);
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const H = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const keys = [];
  for (let j = ys.length - 2; j >= 0; j--) for (let i = 0; i < cols; i++) keys.push(`${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`);
  const stair = graph.addStair({ type: StairType.STRAIGHT, cells: new Set(keys), upDirection: 'up', flip: false, sections: [15], ...extra });
  return { graph, stair };
}
const ROWS3 = [0, 1000, 2000, 3000];
const RISER = 200;
const geom = (stair, graph, view, detail = true) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view, detail, riser: RISER, spans: measureStairSpans(stair, graph), laneGapMm: 0, graph,
});
// build が使う（壁厚ぶん inset した）枠
const frameOf = (stair, graph, view) => makeFrame(stair, insetStairBounds(stair, roomBounds(stair.cells, graph), view, graph));
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
// 点 p を端点に持つ斜めの踏面線（扇形の放射線）の本数
const radialsAt = (g, p) => g.treads.filter(t => (near(t.x1, p.x) && near(t.y1, p.y)) || (near(t.x2, p.x) && near(t.y2, p.y)))
  .filter(t => !near(t.x1, t.x2) && !near(t.y1, t.y2)).length;
const nums = (g) => g.stepNumbers.map(n => Number(n.text)).sort((a, b) => a - b);

test('上り口が左（側面）: 先頭の行が取りつき回転部。扇形の放射線は蹴上数−1 本（pivot＝出口と側辺の角）、段数字は取りつき分ずれる', () => {
  const { graph, stair } = straight(ROWS3, 2, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 });
  assert.equal(stair.totalSteps, 15, '総蹴上数は取りつきを含む（11＋4）');
  const g = geom(stair, graph, 'upper');
  const f = frameOf(stair, graph, 'upper');
  const tExit = 1 / 3; // 区画 1000mm／全長 3000mm
  assert.equal(radialsAt(g, f.pt(tExit, 0)), 3, '放射線は 4−1 本');
  // 出口境界（直進部の初段線）は全幅
  assert.ok(g.treads.some(t => near(t.x1, f.pt(tExit, 0).x) && near(t.y1, f.pt(tExit, 0).y) && near(t.x2, f.pt(tExit, 1).x) && near(t.y2, f.pt(tExit, 1).y)));
  // 段数字: 1〜4 は取りつき回転部（t < tExit）、5〜14 は直進部、15 は到達番号
  assert.deepEqual(nums(g), Array.from({ length: 15 }, (_, i) => i + 1));
  for (const n of g.stepNumbers) {
    const t = f.tOf({ x: n.x, y: n.y }), k = Number(n.text);
    if (k <= 4) assert.ok(t < tExit, `${k} は取りつき回転部: t=${t}`);
    else if (k <= 14) assert.ok(t > tExit, `${k} は直進部: t=${t}`);
  }
  // 出入口の outline: 左の辺（s=0）の区画だけが thin+port、走行端の辺は通常の外周
  const ports = g.outline.filter(s => s.port === 'entry');
  assert.equal(ports.length, 1);
  assert.ok(ports[0].thin && near(ports[0].x1, f.pt(0, 0).x) && near(ports[0].x2, f.pt(0, 0).x), JSON.stringify(ports[0]));
  assert.ok(near(Math.min(ports[0].y1, ports[0].y2), f.pt(tExit, 0).y) && near(Math.max(ports[0].y1, ports[0].y2), f.pt(0, 0).y));
  const bottom = g.outline.find(s => near(s.y1, f.pt(0, 0).y) && near(s.y2, f.pt(0, 0).y) && Math.abs(s.x1 - s.x2) > 100);
  assert.ok(bottom?.side && !bottom.port && !bottom.thin, JSON.stringify(bottom));
});

test('上り口が右（側面）でも対称: 辺は s=1（東）、扇形の pivot もその側', () => {
  const { graph, stair } = straight(ROWS3, 2, { sections: [11], entrySide: RIGHT, entryTurnSteps: 4 });
  const g = geom(stair, graph, 'upper');
  const f = frameOf(stair, graph, 'upper');
  assert.equal(radialsAt(g, f.pt(1 / 3, 1)), 3);
  assert.equal(radialsAt(g, f.pt(1 / 3, 0)), 0);
  const p = g.outline.find(s => s.port === 'entry');
  assert.ok(near(p.x1, f.pt(0, 1).x), JSON.stringify(p));
});

test('到達口が側面（upper）: 末尾の行が取りつき回転部。到達番号は辺の外側、走行端の辺は通常の外周', () => {
  const { graph, stair } = straight(ROWS3, 2, { sections: [11], arrivalSide: LEFT, arrivalTurnSteps: 4 });
  const g = geom(stair, graph, 'upper');
  const f = frameOf(stair, graph, 'upper');
  const tExit = 2 / 3;
  // 到達口は逆向き（南向き）に歩くので左＝東＝s 1
  assert.equal(radialsAt(g, f.pt(tExit, 1)), 3);
  assert.deepEqual(nums(g), Array.from({ length: 15 }, (_, i) => i + 1));
  const ports = g.outline.filter(s => s.port === 'arrival');
  assert.equal(ports.length, 1);
  assert.ok(ports[0].thin && near(ports[0].x1, f.pt(1, 1).x) && near(ports[0].x2, f.pt(1, 1).x), JSON.stringify(ports[0]));
  const top = g.outline.find(s => near(s.y1, f.pt(1, 0).y) && near(s.y2, f.pt(1, 0).y) && Math.abs(s.x1 - s.x2) > 100);
  assert.ok(top?.side && !top.port, JSON.stringify(top));
  const arrival = g.stepNumbers.find(n => n.text === '15');
  assert.ok(near(arrival.clipX, f.pt(1, 1).x) && arrival.x > arrival.clipX, `到達番号は東の辺の外側: ${JSON.stringify(arrival)}`);
  // 取りつき回転部の番号は 11〜14（復路でなく直進部の続き）
  const zone = g.stepNumbers.filter(n => f.tOf({ x: n.x, y: n.y }) > tExit && n.text !== '15').map(n => Number(n.text)).sort((a, b) => a - b);
  assert.deepEqual(zone, [11, 12, 13, 14]);
});

test('矢印: 側面の口は側辺の中点から入る折れ線。走行端の口のままなら従来の直線矢印（points なし）', () => {
  const { graph, stair } = straight(ROWS3, 2, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 });
  const f = frameOf(stair, graph, 'install');
  const a = geom(stair, graph, 'install').arrows[0];
  assert.ok(a.points && near(a.x1, f.pt(1 / 6, 0).x) && near(a.y1, f.pt(1 / 6, 0).y), `始点は左の辺の中点: ${JSON.stringify(a)}`);
  assert.equal(a.label, 'U');
  const plain = straight(ROWS3, 2, { sections: [15] });
  assert.equal(geom(plain.stair, plain.graph, 'install').arrows[0].points, undefined);
  // upper の下り矢印（D）は到達口から出る
  const both = straight(ROWS3, 2, { sections: [7], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const fu = frameOf(both.stair, both.graph, 'upper');
  const d = geom(both.stair, both.graph, 'upper').arrows[0];
  assert.equal(d.label, 'D');
  assert.ok(near(d.x1, fu.pt(5 / 6, 0).x) && near(d.y1, fu.pt(5 / 6, 0).y), `到達口（右＝南向きに歩いて s 0）の辺の中点から出発: ${JSON.stringify(d)}`);
});

test('【破れ位置の単一ソース】straightBreakMm・cellsBeyondBreak・build（install の破れ線）が取りつき分を引いた同じ位置を指す', () => {
  // 先頭・末尾の行は 1000mm、間は 100mm の細い行 10 本（y 1000〜2000）。全長 3000mm
  const ys = [0, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 3000];
  const cases = [
    { name: '上り口だけ', extra: { sections: [11], entrySide: LEFT, entryTurnSteps: 4 }, expectMm: 1600 },
    { name: '到達口だけ', extra: { sections: [11], arrivalSide: RIGHT, arrivalTurnSteps: 4 }, expectMm: 1400 },
    { name: '両口', extra: { sections: [7], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 }, expectMm: 1500 },
  ];
  for (const { name, extra, expectMm } of cases) {
    const { graph, stair } = straight(ys, 1, extra);
    const ports = resolveStraightPortsOf(stair, graph);
    const mm = straightBreakMm(stair, 3000, RISER, ports);
    assert.ok(near(mm, expectMm), `${name}: straightBreakMm=${mm}`);
    // cellsBeyondBreak: 破れ位置以降（走行軸 t の始点が mm 以上）のセル
    const beyond = cellsBeyondBreak(stair, graph, RISER);
    const expected = new Set([...stair.cells].filter(k => 3000 - cellBoundsFromKey(k, graph).y2 >= mm - 1e-6));
    assert.deepEqual([...beyond].sort(), [...expected].sort(), `${name}: 破れ先セル`);
    assert.ok(beyond.size > 0 && beyond.size < stair.cells.size, `${name}: 破れ先は一部のセル`);
    // build（install）の破れ線の中心は f.pt(mm/全長, 0.5)
    const g = geom(stair, graph, 'install');
    const f = frameOf(stair, graph, 'install');
    const c = f.pt(mm / 3000, 0.5);
    const cy = (g.breakLine[1].y1 + g.breakLine[3].y2) / 2;
    assert.ok(near(cy, c.y, 1e-6), `${name}: 破れ線 y=${cy} 期待 ${c.y}`);
  }
});

// straightBreakMm・cellsBeyondBreak・build（install の破れ線）が同じ位置 expectMm を指すことを確かめる（全長 3000mm）
function assertBreakAt(stair, graph, riser, expectMm, name) {
  const mm = straightBreakMm(stair, 3000, riser, resolveStraightPortsOf(stair, graph));
  assert.ok(near(mm, expectMm), `${name}: straightBreakMm=${mm}`);
  const beyond = cellsBeyondBreak(stair, graph, riser);
  const expected = [...stair.cells].filter(k => 3000 - cellBoundsFromKey(k, graph).y2 >= mm - 1e-6).sort();
  assert.deepEqual([...beyond].sort(), expected, `${name}: 破れ先セル`);
  const g = buildStairGeometry(stair, roomBounds(stair.cells, graph), { view: 'install', detail: true, riser, spans: measureStairSpans(stair, graph), laneGapMm: 0, graph });
  const c = frameOf(stair, graph, 'install').pt(mm / 3000, 0.5);
  assert.ok(near((g.breakLine[1].y1 + g.breakLine[3].y2) / 2, c.y, 1e-6), `${name}: build の破れ線`);
  return { mm, beyond };
}

test('【破れ位置】区画を横切る区切り線があっても cellsBeyondBreak は build の破れ線と同じ位置で切る（区画は保存セルで測る）', () => {
  // 行境界 [0,1000,1500,2000,3000]。先頭の行（y 2000〜3000）を y=2500 の区切り線が横切る。上り口 left・取りつき 4
  const { graph, stair } = straight([0, 1000, 1500, 2000, 3000], 1, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2500, { labeled: false, discipline: Discipline.ARCH });
  const { mm, beyond } = assertBreakAt(stair, graph, RISER, 1600, '区切り線あり');
  assert.equal(mm, 1600);
  // 破れ先は y 0〜1000 の 1 セルだけ（y 1000〜1500 は t=1500 < 1600 で手前）
  assert.equal(beyond.size, 1);
  const only = cellBoundsFromKey([...beyond][0], graph);
  assert.deepEqual([only.y1, only.y2], [0, 1000]);
});

test('【破れ位置】取りつき蹴上 ≥ 破れ段数でも直進部の外へ出ない（上り口: 区画の出口以降／到達口: 最終マスの始点以下）。3 か所が一致', () => {
  // riser 400 → breakStep 4、上り口の取りつき 4 → 直進部のマス 0 → 1 に収め、区画の出口（1000mm）
  const entry = straight(ROWS3, 1, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 });
  const e = assertBreakAt(entry.stair, entry.graph, 400, 1000, '上り口');
  assert.ok(e.mm >= 1000);
  // riser 100 → breakStep 14（総蹴上数 15−1）、直進部は 10 マス → 最終マスの始点 (10−1)×200＝1800 ≤ 区画の手前 2000
  const arr = straight(ROWS3, 1, { sections: [11], arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const a = assertBreakAt(arr.stair, arr.graph, 100, 1800, '到達口');
  assert.ok(a.mm <= 2000);
});

test('【失敗系】踊場付直進: 区画（firstRow）が最初の直進部（runE）より長いと側面は走行端へ戻る（total ではなく runE で判定）', () => {
  const stair = { type: StairType.STRAIGHT_LANDING, upDirection: 'up', flip: false, sections: [6, 1, 8], tread: 250, nosing: 0, entrySide: LEFT, entryTurnSteps: 2 };
  const spans = { lengths: [600, 1000, 2000], firstRow: 700, lastRow: 500, rowCount: 5 };
  const r = resolveStraightPorts(stair, straightPortInfoOf(spans));
  assert.equal(r.entry, 'end');
  const b = { x1: 0, y1: 0, x2: 1000, y2: 3600 };
  const plain = { ...stair, entrySide: null, entryTurnSteps: 0 };
  const build = (s) => buildStairGeometry(s, b, { view: 'upper', detail: true, riser: RISER, spans, laneGapMm: 0 });
  assert.equal(build(stair).outline.filter(s => s.port === 'entry').length, 1);
  assert.ok(build(stair).outline.filter(s => s.port === 'entry').every(s => s.thin && Math.abs(s.y1 - s.y2) < 1e-6), '出入口は端の辺（水平）のまま');
  assert.deepEqual(build(stair).outline, build(plain).outline);
});

test('【U字の実測】区切り線が回り段の列を横切っても cellsBeyondBreak は保存セルの tRun で判定する（細分化後のセルで測ると回り段の一部が破れ先になる不良の修正）', () => {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const V = [0, 1000, 2000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const H = [0, 1000, 2000, 3000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const keys = [];
  for (let j = 2; j >= 0; j--) for (let i = 0; i < 2; i++) keys.push(`${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`);
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells: new Set(keys), upDirection: 'up', flip: false, sections: [8, 1, 8] });
  const before = [...cellsBeyondBreak(stair, graph, RISER)].map(k => cellBoundsFromKey(k, graph)).map(c => [c.x1, c.y1, c.x2, c.y2].join()).sort();
  const tRunBefore = uTurnSpans(stair, graph).tRun;
  for (const y of [500, 2500]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, { labeled: false, discipline: Discipline.ARCH });
  const after = [...cellsBeyondBreak(stair, graph, RISER)].map(k => cellBoundsFromKey(k, graph)).map(c => [c.x1, c.y1, c.x2, c.y2].join()).sort();
  assert.equal(before.length, 2, '復路（右の列）の 2 セル');
  // 細分化後は右の列の行が 2 セルずつに割れる（y 1000〜2000 と 2000〜3000 が 2500 で割れる）が、覆う範囲は同じ
  const area = (list) => list.reduce((s, c) => { const [x1, y1, x2, y2] = c.split(',').map(Number); return s + (x2 - x1) * (y2 - y1); }, 0);
  assert.equal(area(after), area(before));
  assert.ok(after.every(c => Number(c.split(',')[0]) === 1000 && Number(c.split(',')[1]) >= 1000), `回り段の列（y 0〜1000）は破れ手前: ${after}`);
  assert.equal(uTurnSpans(stair, graph).tRun, tRunBefore, 'build が測る tRun（保存セル）は区切り線で動かない');
});

test('直進⇄踊場付直進の型切替前に resetPortSides を適用すると、側面・取りつきが直進部へ戻り総蹴上数が保たれる', () => {
  const stair = new Stair('s', { type: StairType.STRAIGHT, sections: [7], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  assert.equal(stair.totalSteps, 15);
  for (const [k, v] of Object.entries(resetPortSides(stair))) stair.setField(k, v);
  assert.deepEqual([stair.entrySide, stair.arrivalSide, stair.entryTurnSteps, stair.arrivalTurnSteps, stair.sections, stair.totalSteps], [null, null, 0, 0, [15], 15]);
  stair.setField('type', StairType.STRAIGHT_LANDING);
  stair.setField('sections', sectionsForType(StairType.STRAIGHT_LANDING, stair));
  assert.equal(stair.sections.length, 3);
  assert.equal(stair.entryTurnSteps + stair.arrivalTurnSteps, 0, '取りつきは残らない');
});

test('【破れ位置】取りつきが無い（走行端のまま）なら従来式（全蹴上数のマス番号をそのまま直進部の mm へ）', () => {
  const { graph, stair } = straight(ROWS3, 1, { sections: [15] });
  assert.equal(resolveStraightPortsOf(stair, graph), null);
  assert.ok(near(straightBreakMm(stair, 3000, RISER, null), 7 * (3000 / 14)));
  assert.equal(straightBreakMm({ ...stair, sections: [8, 1, 8] }, 3000, RISER), null, '直進 1 区間でなければ null');
});

test('stairPortEdges: 側面の出入口は区画の側辺。到達口は末尾の行。走行端のままなら従来の端の辺', () => {
  const { graph, stair } = straight(ROWS3, 2, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 });
  assert.deepEqual(stairPortEdges(stair, graph, ['entry']), [{ isVertical: true, value: 0, lo: 2000, hi: 3000 }]);
  stair.setField('entrySide', RIGHT);
  assert.deepEqual(stairPortEdges(stair, graph, ['entry']), [{ isVertical: true, value: 2000, lo: 2000, hi: 3000 }]);
  stair.setField('entrySide', null);
  // 走行端は従来どおり（thin 線分は外形線分の最短の辺 1 本へスナップする。変更前と同じ結果）
  assert.deepEqual(stairPortEdges(stair, graph, ['entry']), [{ isVertical: false, value: 3000, lo: 0, hi: 1000 }]);
  // 到達口（逆向きに歩く）: 右＝西（x=0）。上端 y 0〜1000
  stair.setField('arrivalSide', RIGHT);
  stair.setField('arrivalTurnSteps', 4);
  assert.deepEqual(stairPortEdges(stair, graph, ['arrival']), [{ isVertical: true, value: 0, lo: 0, hi: 1000 }]);
});

test('寸法: 側面の口は「取付 段数N」（取りつき蹴上の編集口）が直進の前後に付く。走行端のままなら直進だけ', () => {
  const { graph, stair } = straight(ROWS3, 2, { sections: [7], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const b = roomBounds(stair.cells, graph);
  const dims = stairSegmentDims(stair, b, 300, measureStairSpans(stair, graph));
  assert.deepEqual(dims.map(d => [d.label, d.target, d.index ?? null]), [
    ['取付 段数4', 'entryTurnSteps', null], ['直進 踏面6', 'sections', 0], ['取付 段数4', 'arrivalTurnSteps', null],
  ]);
  assert.ok(dims.every(d => d.editable));
  const plain = straight(ROWS3, 2, { sections: [15] });
  const pd = stairSegmentDims(plain.stair, roomBounds(plain.stair.cells, plain.graph), 300, measureStairSpans(plain.stair, plain.graph));
  assert.deepEqual(pd.map(d => d.label), ['直進 踏面14']);
});

test('【失敗系】選べない保存値（1 行の直進・2 行で両口とも側面の到達口）は走行端と同じ出力・同じ破れ位置', () => {
  // 1 行: 区画が全体で直進部が残らない → 走行端
  const one = straight([0, 1000], 2, { sections: [11], entrySide: LEFT, entryTurnSteps: 4 });
  const oneEnd = straight([0, 1000], 2, { sections: [11] });
  for (const view of ['install', 'upper']) {
    // 取りつき蹴上は走行端なら無視される（描画は直進部だけ）。totalSteps は stair 側の値で別
    assert.deepEqual(geom(one.stair, one.graph, view), geom(oneEnd.stair, oneEnd.graph, view), view);
  }
  assert.equal(resolveStraightPortsOf(one.stair, one.graph), null);
  assert.deepEqual([...cellsBeyondBreak(one.stair, one.graph, RISER)], [...cellsBeyondBreak(oneEnd.stair, oneEnd.graph, RISER)]);
  // 2 行: 上り口を先に確保 → 到達口は走行端
  const two = straight([0, 1000, 2000], 2, { sections: [7], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const r = resolveStraightPortsOf(two.stair, two.graph);
  assert.deepEqual([r.entry, r.arrival], ['side', 'end']);
  assert.equal(geom(two.stair, two.graph, 'upper').outline.filter(s => s.port === 'arrival').length, 1);
});

test('portSideChange（直進）: 総蹴上数を保つ。上り口・到達口とも sections[0] から引き、走行端へ戻すと戻す。直進部 2 段未満は拒否', () => {
  const s = { type: StairType.STRAIGHT, structure: 'WOOD', tread: 250, sections: [15], entryTurnSteps: 0, arrivalTurnSteps: 0 };
  const e = portSideChange(s, 'entry', LEFT, 1000);
  assert.deepEqual(e, { entrySide: LEFT, entryTurnSteps: 4, sections: [11] });
  const s2 = { ...s, ...e };
  const a = portSideChange(s2, 'arrival', RIGHT, 1000);
  assert.deepEqual(a, { arrivalSide: RIGHT, arrivalTurnSteps: 4, sections: [7] });
  const s3 = { ...s2, ...a };
  assert.equal(s3.sections[0] + s3.entryTurnSteps + s3.arrivalTurnSteps, 15, '総蹴上数は 15 のまま');
  assert.deepEqual(portSideChange(s3, 'entry', StairPortSide.END, 1000), { entrySide: 'end', entryTurnSteps: 0, sections: [11] });
  assert.equal(portSideChange({ ...s, sections: [5] }, 'entry', LEFT, 1000), null, '5−4=1 段');
  assert.equal(portSideChange({ ...s, sections: [5, 1, 4] }, 'entry', LEFT, 1000), null, '区間数が合わない sections');
});

// ---- 踊場付直進（区画が各直進部の中に収まるとき。実測は合成: 3 行並びの実測では先頭の行が直進部全体になり選べない）----

test('踊場付直進: 上り口・到達口が側面なら区画を除いた区間が直進部。扇形・段数字・総蹴上数・破れ位置が取りつき分ずれる', () => {
  const stair = {
    type: StairType.STRAIGHT_LANDING, upDirection: 'up', flip: false, sections: [6, 1, 8], tread: 250, nosing: 0,
    entrySide: LEFT, entryTurnSteps: 2, arrivalSide: RIGHT, arrivalTurnSteps: 2,
  };
  const b = { x1: 0, y1: 0, x2: 1000, y2: 5000 };
  const spans = { lengths: [2000, 1000, 2000], firstRow: 500, lastRow: 500, rowCount: 5 };
  const view = (v) => buildStairGeometry(stair, b, { view: v, detail: true, riser: RISER, spans, laneGapMm: 0 });
  const g = view('upper');
  const f = makeFrame(stair, insetStairBounds(stair, b, 'upper', null));
  // run1 5 マス＋踊場 1＋run2 7 マス＝13 マス、到達番号 14（＝c+1）、取りつき 2＋2 を足した 18 が総蹴上数
  assert.deepEqual(nums(g), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(radialsAt(g, f.pt(500 / 5000, 0)), 1, '上り口（左＝s 0）の扇形は 2−1 本');
  assert.equal(radialsAt(g, f.pt(4500 / 5000, 0)), 1, '到達口（逆向きに歩くので右＝s 0）の扇形は 2−1 本');
  // 段数字: 取りつき 1〜2、run1 3〜7、踊場 8、run2 9〜15、到達口の取りつき 16〜17、到達番号 18
  for (const n of g.stepNumbers) {
    const t = f.tOf({ x: n.x, y: n.y }), k = Number(n.text);
    if (k <= 2) assert.ok(t < 500 / 5000, `${k}: t=${t}`);
    else if (k <= 7) assert.ok(t > 500 / 5000 && t < 2000 / 5000, `${k}: t=${t}`);
    else if (k === 8) assert.ok(t > 2000 / 5000 && t < 3000 / 5000, `${k}: t=${t}`);
    else if (k <= 15) assert.ok(t > 3000 / 5000 && t < 4500 / 5000, `${k}: t=${t}`);
    else if (k <= 17) assert.ok(t > 4500 / 5000, `${k}: t=${t}`);
  }
  // install の破れ位置: 全蹴上数 18 のマス番号 8（FL+1600/200）から取りつき 2 を引いて直進部のマス 6（run1 の 5 マス＋踊場）。
  // 踊場の起点 L1=2000mm の位置
  const gi = view('install');
  const fi = makeFrame(stair, insetStairBounds(stair, b, 'install', null));
  const c = fi.pt(2000 / 5000, 0.5);
  assert.ok(near((gi.breakLine[1].y1 + gi.breakLine[3].y2) / 2, c.y, 1e-6), `破れ線は踊場の起点: ${JSON.stringify(gi.breakLine)}`);
});
