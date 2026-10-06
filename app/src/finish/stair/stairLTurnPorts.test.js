// 矩折（L_TURN）の側面の出入口（ステップ9c）の本番経路テスト。
// 側面から入る（出る）ときは区画（アーム1の基端の行・アーム2の末端の行）が取りつきの回転部になり、直進部は区画を除いた区間。
// フィクスチャは右向き（right）・flip 無しの L 字: 正規化 (u,v)→world は (x,y) = (u, v)。アーム1＝下の横帯（y 3000〜4000、
// u=x が増える向きに上る）、コーナー＝右下（x 3000〜4000, y 3000〜4000）、アーム2＝右の縦帯（x 3000〜4000, y 0〜3000。上へ上る）。
// 上り口の左＝上（y 小）＝アーム1の内側（空象限側 v=runV）、右＝下（外周側 v=1）。
// 到達口は上へ（−y）歩くので左＝西＝アーム2の内側（u=runU）、右＝東（外周側 u=1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StairPortSide, Stair } from '@core';
import { measureStairSpans, lTurnEndRows } from './stairClassify.js';
import { resolveLTurnPorts, lTurnPortInfoOf, stairPortCandidates } from './stairPorts.js';
import {
  buildStairGeometry, insetStairBounds, stairPortEdges, stairSegmentDims, cellsBeyondBreak, resolveLTurnPortsOf,
} from './stairGeometry.js';
import { normToWorld, worldToNorm } from './stairFrame.js';
import { roomBounds, cellBoundsFromKey } from '../gridCells.js';
import { portSideChange, resetPortSides } from './stairSectionEdit.js';

const { END, LEFT, RIGHT } = StairPortSide;
const RUN_U = 0.75, RUN_V = 0.75; // 3000/4000

// arm1 / arm2: 各アームの行数（セル数）。列 0..arm1-1 が下の横帯、列 arm1 がコーナー・右の縦帯。
// w1/w2: アーム1の幅（下の横帯の高さ＝コーナーの y 寸）・アーム2の幅（右の縦帯の幅＝コーナーの x 寸）。既定 1000。
function lTurn(extra = {}, { arm1 = 3, arm2 = 3, type = StairType.L_TURN, w1 = 1000, w2 = 1000 } = {}) {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const xs = [...Array.from({ length: arm1 + 1 }, (_, i) => i * 1000), arm1 * 1000 + w2];
  const ys = [...Array.from({ length: arm2 + 1 }, (_, i) => i * 1000), arm2 * 1000 + w1];
  const V = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const H = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH }));
  const cell = (i, j) => `${V[i].id}:${H[j].id}:${V[i + 1].id}:${H[j + 1].id}`;
  const keys = [];
  for (let i = 0; i <= arm1; i++) keys.push(cell(i, arm2 + 0)); // 下の横帯＋コーナー（行 arm2）
  for (let j = 0; j < arm2; j++) keys.push(cell(arm1, j));       // 右の縦帯
  const stair = graph.addStair({ type, cells: new Set(keys), upDirection: 'right', flip: false, sections: [10, 1, 10], ...extra });
  return { graph, stair, V, H };
}
const RISER = 200;
const geom = (stair, graph, view, { riser = RISER, detail = true } = {}) => buildStairGeometry(stair, roomBounds(stair.cells, graph), {
  view, detail, riser, spans: measureStairSpans(stair, graph), laneGapMm: 0, graph,
});
// build が使う（壁厚ぶん inset した）枠での (u,v) → world と world → (u,v)
function frames(stair, graph, view) {
  const bi = insetStairBounds(stair, roomBounds(stair.cells, graph), view, graph);
  const pt = (fx, fy) => ({ x: bi.x1 + fx * (bi.x2 - bi.x1), y: bi.y1 + fy * (bi.y2 - bi.y1) });
  return { tw: normToWorld(stair, pt), norm: worldToNorm(stair, bi) };
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const radialsAt = (g, p) => g.treads.filter(t => (near(t.x1, p.x) && near(t.y1, p.y)) || (near(t.x2, p.x) && near(t.y2, p.y)))
  .filter(t => !near(t.x1, t.x2) && !near(t.y1, t.y2)).length;
const nums = (g) => g.stepNumbers.map(n => Number(n.text)).sort((a, b) => a - b);
const boundsOf = (stair, graph, keys) => [...keys].map(k => cellBoundsFromKey(k, graph)).map(c => [c.x1, c.y1, c.x2, c.y2].join()).sort();

test('lTurnEndRows: アーム1の基端の行（u 最小）とアーム2の末端の行（v 最小）。幅方向に分割された行は1行、走行方向に分割された行は別の行', () => {
  const { graph, stair } = lTurn();
  const r = lTurnEndRows(stair, graph);
  assert.deepEqual([r.firstRowMm, r.lastRowMm], [1000, 1000]);
  assert.deepEqual([r.firstCells.length, r.lastCells.length], [1, 1]);
  assert.deepEqual([r.runU, r.runV, r.uLen, r.vLen], [RUN_U, RUN_V, 4000, 4000]);
  // アーム1の基端の行（x 0〜1000）を y=3500 の区切り線で幅方向に割ると 2 セルで 1 行
  const split = lTurn();
  split.graph.addCenterLine(CenterLineType.HORIZONTAL, 3500, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(lTurnEndRows(split.stair, split.graph).firstRowMm, 1000);
  // x=500 の区切り線を足しても、保存セル（元のキー）で測れば 1000 のまま（区画は保存セルで測る）
  const cut = lTurn();
  cut.graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  assert.equal(lTurnEndRows(cut.stair, cut.graph).firstRowMm, 1000, '保存セルの行は区切り線で動かない');
  // 取りつきの区画がある実測: measureStairSpans の firstRow/lastRow に載る（矩折だけ。曲がり階段は載らない）
  assert.deepEqual(measureStairSpans(stair, graph), { lengths: [3000, 1000, 3000], widths: [1000, 1000], firstRow: 1000, lastRow: 1000 });
  const flared = lTurn({}, { type: StairType.FLARED });
  assert.deepEqual(measureStairSpans(flared.stair, flared.graph), { lengths: [3000, 1000, 3000], widths: [1000, 1000] });
});

test('【失敗系】lTurnEndRows: セルが無い・L 字として実測できない階段は null。lTurnPortInfoOf は区画の無い実測を null', () => {
  const { graph, stair } = lTurn();
  assert.equal(lTurnEndRows({ ...stair, cells: new Set() }, graph), null);
  assert.equal(lTurnEndRows(stair, null), null);
  assert.equal(lTurnEndRows({ ...stair, cells: new Set([[...stair.cells][0], [...stair.cells][1]]) }, graph), null, '2 セルは L 字でない');
  assert.equal(lTurnPortInfoOf(null), null);
  assert.equal(lTurnPortInfoOf({ lengths: [3000, 1000, 3000], widths: [1000, 1000] }), null, '区画の行が無い実測（曲がり階段）');
  assert.equal(lTurnPortInfoOf({ lengths: [3000], firstRow: 1000, lastRow: 1000 }), null);
});

test('上り口が左（アーム1の内側＝空象限側）: 先頭の行が取りつき回転部。扇形の放射線は蹴上−1 本（pivot＝出口と側辺の角）、段数字は取りつき分ずれる', () => {
  const plain = lTurn({ sections: [10, 1, 10] });
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  assert.equal(stair.totalSteps, plain.stair.totalSteps, '総蹴上数は取りつきを含む（6＋4 ＝ 10）');
  const g = geom(stair, graph, 'upper');
  const { tw, norm } = frames(stair, graph, 'upper');
  const zoneU = 1000 / 4000;
  assert.equal(radialsAt(g, tw(zoneU, RUN_V)), 3, '放射線は 4−1 本（pivot は区画の出口と内側の辺の角）');
  assert.equal(radialsAt(g, tw(zoneU, 1)), 0);
  // 出口境界（直進部の初段線）はアーム1の全幅
  assert.ok(g.treads.some(t => near(t.x1, tw(zoneU, RUN_V).x) && near(t.y1, tw(zoneU, RUN_V).y) && near(t.x2, tw(zoneU, 1).x) && near(t.y2, tw(zoneU, 1).y)));
  // 段数字: 1〜4 は取りつき回転部（u < zoneU）、5〜9 は直進部、10 以降は踊り場・アーム2、最後は到達番号
  assert.deepEqual(nums(g), Array.from({ length: plain.stair.totalSteps }, (_, i) => i + 1));
  for (const n of g.stepNumbers) {
    const { u } = norm({ x: n.x, y: n.y }), k = Number(n.text);
    if (k <= 4) assert.ok(u < zoneU, `${k} は取りつき回転部: u=${u}`);
    else if (k <= 9) assert.ok(u > zoneU && u < RUN_U, `${k} は直進部: u=${u}`);
  }
  // 出入口の outline: 内側の辺（v=runV）の区画だけが thin+port。走行端（u=0）の辺は通常の外周、外周側（v=1）は side
  const ports = g.outline.filter(s => s.port === 'entry');
  assert.equal(ports.length, 1);
  assert.ok(ports[0].thin && near(ports[0].y1, tw(0, RUN_V).y) && near(ports[0].y2, tw(0, RUN_V).y), JSON.stringify(ports[0]));
  assert.ok(near(Math.min(ports[0].x1, ports[0].x2), tw(0, RUN_V).x) && near(Math.max(ports[0].x1, ports[0].x2), tw(zoneU, RUN_V).x));
  const base = g.outline.find(s => near(s.x1, tw(0, 1).x) && near(s.x2, tw(0, 1).x) && Math.abs(s.y1 - s.y2) > 100);
  assert.ok(base?.side && !base.port && !base.thin, JSON.stringify(base));
});

test('上り口が右（アーム1の外周側 v=1）でも対称: 辺は v=1、扇形の pivot もその側', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: RIGHT, entryTurnSteps: 4 });
  const g = geom(stair, graph, 'upper');
  const { tw } = frames(stair, graph, 'upper');
  assert.equal(radialsAt(g, tw(0.25, 1)), 3);
  assert.equal(radialsAt(g, tw(0.25, RUN_V)), 0);
  const p = g.outline.find(s => s.port === 'entry');
  assert.ok(near(p.y1, tw(0, 1).y) && near(p.y2, tw(0, 1).y), JSON.stringify(p));
});

test('到達口が側面（upper）: アーム2の末端の行が取りつき回転部。到達番号は辺の外側、走行端の辺は通常の外周。左（歩く向きの左）＝西＝内側 u=runU', () => {
  const { graph, stair } = lTurn({ sections: [10, 1, 6], arrivalSide: LEFT, arrivalTurnSteps: 4 });
  const g = geom(stair, graph, 'upper');
  const { tw, norm } = frames(stair, graph, 'upper');
  const zoneV = 1000 / 4000;
  assert.equal(radialsAt(g, tw(RUN_U, zoneV)), 3, 'pivot は内側（u=runU）の辺と出口境界の角');
  assert.deepEqual(nums(g), Array.from({ length: stair.totalSteps }, (_, i) => i + 1));
  const ports = g.outline.filter(s => s.port === 'arrival');
  assert.equal(ports.length, 1);
  assert.ok(ports[0].thin && near(ports[0].x1, tw(RUN_U, 0).x) && near(ports[0].x2, tw(RUN_U, 0).x), JSON.stringify(ports[0]));
  assert.ok(near(Math.min(ports[0].y1, ports[0].y2), tw(RUN_U, 0).y) && near(Math.max(ports[0].y1, ports[0].y2), tw(RUN_U, zoneV).y));
  const far = g.outline.find(s => near(s.y1, tw(1, 0).y) && near(s.y2, tw(1, 0).y) && Math.abs(s.x1 - s.x2) > 100);
  assert.ok(far?.side && !far.port, JSON.stringify(far));
  const arrival = g.stepNumbers.find(n => n.text === String(stair.totalSteps));
  assert.ok(near(arrival.clipX, tw(RUN_U, 0).x) && arrival.x < arrival.clipX, `到達番号は西の辺の外側: ${JSON.stringify(arrival)}`);
  // 取りつき回転部の番号は 16〜19（アーム1 9 マス・踊り場 1・アーム2 5 マスの続き）、到達番号は 20
  const zone = g.stepNumbers.filter(n => norm({ x: n.x, y: n.y }).v < zoneV && n.text !== String(stair.totalSteps)).map(n => Number(n.text)).sort((a, b) => a - b);
  assert.deepEqual(zone, [16, 17, 18, 19]);
  // 右（東＝外周側 u=1）
  const r = lTurn({ sections: [10, 1, 6], arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const gr = geom(r.stair, r.graph, 'upper');
  const fr = frames(r.stair, r.graph, 'upper');
  assert.equal(radialsAt(gr, fr.tw(1, zoneV)), 3);
  const pr = gr.outline.find(s => s.port === 'arrival');
  assert.ok(near(pr.x1, fr.tw(1, 0).x) && near(pr.x2, fr.tw(1, 0).x), JSON.stringify(pr));
  const ar = gr.stepNumbers.find(n => n.text === String(r.stair.totalSteps));
  assert.ok(ar.x > ar.clipX, '東の辺の外側');
});

test('【寸法の取り違え】アーム長・幅が非対称（アーム1 2 行・幅 500／アーム2 3 行・幅 2000）でも、区画長は各アームの軸の全長で正規化される', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 6], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: LEFT, arrivalTurnSteps: 4 }, { arm1: 2, arm2: 3, w1: 500, w2: 2000 });
  // u 軸全長 2000＋2000＝4000、v 軸全長 3000＋500＝3500
  const lp = resolveLTurnPortsOf(stair, graph);
  assert.deepEqual([lp.zone1Mm, lp.zone2Mm, lp.zoneU, lp.zoneV], [1000, 1000, 1000 / 4000, 1000 / 3500]);
  const g = geom(stair, graph, 'upper');
  const { tw } = frames(stair, graph, 'upper');
  const runU = 2000 / 4000, runV = 3000 / 3500;
  assert.equal(radialsAt(g, tw(1000 / 4000, runV)), 3, '上り口（左＝内側 v=runV）の pivot');
  assert.equal(radialsAt(g, tw(runU, 1000 / 3500)), 3, '到達口（左＝内側 u=runU）の pivot');
});

// 区間の踏面線の位置（u／v の正規化）。アーム1の帯（y が v=runV〜1）を縦に横切る線の x、アーム2の帯を横に横切る線の y
const armTreads = (g, tw, kind) => {
  const keep = kind === 'arm1'
    ? (t) => near(t.x1, t.x2) && near(Math.min(t.y1, t.y2), tw(0, RUN_V).y) && near(Math.max(t.y1, t.y2), tw(0, 1).y)
    : (t) => near(t.y1, t.y2) && near(Math.min(t.x1, t.x2), tw(RUN_U, 0).x) && near(Math.max(t.x1, t.x2), tw(1, 0).x);
  return g.treads.filter(keep).map(t => (kind === 'arm1' ? t.x1 : t.y1)).sort((a, b) => a - b);
};

test('直進部は区画の外側に等ピッチで詰まる（upper）。両口が側面でも段数字は 1〜総蹴上数の連番', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 6], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const g = geom(stair, graph, 'upper');
  const { tw } = frames(stair, graph, 'upper');
  assert.deepEqual(nums(g), Array.from({ length: stair.totalSteps }, (_, i) => i + 1), '取りつき 1〜4・アーム1 5〜9・踊り場 10・アーム2 11〜15・取りつき 16〜19・到達 20');
  // アーム1: 5 マスが [0.25, 0.75] を等分（ピッチ 0.1）。区画の出口 0.25・コーナー入口 0.75 の境界線を含む
  const xs = armTreads(g, tw, 'arm1');
  assert.equal(xs.length, 6, `アーム1の踏面線: ${xs}`);
  [0.25, 0.35, 0.45, 0.55, 0.65, 0.75].forEach((u, i) => assert.ok(near(xs[i], tw(u, 1).x, 1e-6), `u=${u}: ${xs[i]}`));
  // アーム2: 5 マスが v=0.75 から 0.25 まで等分。y は v に対し増加する向き（v が小さいほど上）なので昇順に並べ替わる
  const ys = armTreads(g, tw, 'arm2');
  assert.equal(ys.length, 6, `アーム2の踏面線: ${ys}`);
  [0.25, 0.35, 0.45, 0.55, 0.65, 0.75].forEach((v, i) => assert.ok(near(ys[i], tw(1, v).y, 1e-6), `v=${v}: ${ys[i]}`));
});

test('【破れ位置】install のアーム1内の破れ: 踏面線は破れ線の手前（区画の出口から数えた距離）で止まる', () => {
  // riser 200 → 破れのマス番号 8 → 8−4＝4（アーム1の 4 マス目の始点 u=0.25＋3×0.1）。踏面線は区画の出口 0.25 と 0.35・0.45（0.55 は破れ線の傾きぶん手前で止まって描かない）
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  const g = geom(stair, graph, 'install', { riser: 200 });
  const { tw } = frames(stair, graph, 'install');
  assert.ok(near(g.breakLine[0].x1, tw(0.55, 1).x, 1e-6), `破れ位置 u=0.55: x=${g.breakLine[0].x1}`);
  const xs = armTreads(g, tw, 'arm1');
  assert.equal(xs.length, 3, `踏面線: ${xs}`);
  [0.25, 0.35, 0.45].forEach((u, i) => assert.ok(near(xs[i], tw(u, 1).x, 1e-6), `u=${u}: ${xs[i]}`));
});

test('候補（矩折）: 先頭の行内で終端がそろわないとき区画は短い方に合わせ、側辺の床確認も区画の範囲だけで行う（行の外の床なしで側面を落とさない）', () => {
  const graph = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const cl = (t, v, o = {}) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH, ...o });
  const V = [0, 1000, 2000, 3000, 4000].map(v => cl(CenterLineType.VERTICAL, v));
  const H = [0, 1000, 2000, 3000, 4000].map(v => cl(CenterLineType.HORIZONTAL, v));
  // アーム1の先頭の列（x 0〜1000, y 3000〜4000）を y=3500（x 0〜1000 だけ）で上下に割り、上半分をさらに x=500 で割る。
  // 先頭の行は x 0〜500（上半分の左）と x 0〜1000（下半分）で終端がそろわない → 区画は短い 500mm
  const V500 = cl(CenterLineType.VERTICAL, 500, { extentLo: 3000, extentHi: 3500 });
  const H35 = cl(CenterLineType.HORIZONTAL, 3500, { extentLo: 0, extentHi: 1000 });
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const keys = [
    k(V[0], H[3], V500, H35), k(V500, H[3], V[1], H35), k(V[0], H35, V[1], H[4]),
    k(V[1], H[3], V[2], H[4]), k(V[2], H[3], V[3], H[4]), k(V[3], H[3], V[4], H[4]),
    ...[0, 1, 2].map(j => k(V[3], H[j], V[4], H[j + 1])),
  ];
  const stair = graph.addStair({ type: StairType.L_TURN, cells: new Set(keys), upDirection: 'right', flip: false, sections: [10, 1, 10] });
  assert.equal(lTurnEndRows(stair, graph).firstRowMm, 500, '行内で終端がそろわなければ短い方');
  assert.equal(measureStairSpans(stair, graph).firstRow, 500);
  // 上り口の床: 走行端の外＝西（x -1000〜0 の y 3000〜3500・3500〜4000）、左＝北（x 0〜500・y 2000〜3000）、右＝南（x 0〜500 だけ床あり。500〜1000 は床なし）
  const fl = new PlanGraph(new Plane('f', 0, '1階', 1, 1));
  const fcl = (t, v) => fl.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const FX = [-1000, 0, 500, 1000].map(v => fcl(CenterLineType.VERTICAL, v));
  const FY = [2000, 3000, 3500, 4000, 5000].map(v => fcl(CenterLineType.HORIZONTAL, v));
  const fk = (i, j) => `${FX[i].id}:${FY[j].id}:${FX[i + 1].id}:${FY[j + 1].id}`;
  for (const key of [fk(0, 1), fk(0, 2), fk(1, 0), fk(1, 3)]) fl.addRoom(new Set([key]));
  assert.deepEqual(stairPortCandidates(stair, graph, 'entry', { floorGraph: fl }).sides, [END, LEFT, RIGHT], '南の床は区画の範囲（x 0〜500）だけ確かめる');
});

test('矢印: 側面の口は側辺の中点から入る折れ線。走行端の口のままなら従来の矢印', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  const a = geom(stair, graph, 'install').arrows[0];
  const { tw } = frames(stair, graph, 'install');
  assert.ok(a.points && near(a.x1, tw(1 / 8, RUN_V).x) && near(a.y1, tw(1 / 8, RUN_V).y), `始点は内側の辺の中点: ${JSON.stringify(a)}`);
  assert.equal(a.label, 'U');
  const plain = lTurn({ sections: [10, 1, 10] });
  assert.equal(geom(plain.stair, plain.graph, 'install', { riser: 400 }).arrows[0].points, undefined, 'アーム1内の破れは従来の直線矢印');
  // upper の下り矢印（D）は到達口から出る
  const both = lTurn({ sections: [6, 1, 6], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const fu = frames(both.stair, both.graph, 'upper');
  const d = geom(both.stair, both.graph, 'upper').arrows[0];
  assert.equal(d.label, 'D');
  assert.ok(near(d.x1, fu.tw(1, 1 / 8).x) && near(d.y1, fu.tw(1, 1 / 8).y), `到達口（右＝東 u=1）の辺の中点から出発: ${JSON.stringify(d)}`);
});

// 破れ位置の単一ソース: build（install の破れ線）・cellsBeyondBreak・install で見える最大の段数字が、取りつきを含む総蹴上数の
// FL+1600 を指す（上り口の取りつきぶんを引いた直進部のマス番号で換算）。lTurnBreakState の 1 か所を build と cellsBeyondBreak が共有する。
test('【破れ位置の単一ソース】取りつきを含む総蹴上数で FL+1600 を引き、build・cellsBeyondBreak・段数字が同じ位置を指す（コーナー／アーム2 の境）', () => {
  // 上り口 left・取りつき 4。run1 は 5 マス（直進部 #5〜#9 でなく、取りつき #1〜#4 の後ろの #5〜）・踊り場 #6・run2 #7〜。
  // riser 140 → 破れの高さのマス番号 11 → 11−4＝7＝run2 の先頭。アームは 2 セルずつ（cellsBeyondBreak の象限判定 0.5 に合わせる）
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 }, { arm1: 2, arm2: 2 });
  const { tw } = frames(stair, graph, 'install');
  const runV = 2 / 3;
  const g = geom(stair, graph, 'install', { riser: 140 });
  assert.ok(near(g.breakLine[0].y1, tw(1, runV).y, 1e-6), `破れ線はコーナーとアーム2の境（v=runV）: y=${g.breakLine[0].y1} 期待 ${tw(1, runV).y}`);
  assert.equal(Math.max(...nums(g)), 10, '見える最大の段数字は 10（破れの段 11 の手前。取りつき 4 を含む番号）');
  const beyond = cellsBeyondBreak(stair, graph, 140);
  const arm2 = [...stair.cells].filter(k => cellBoundsFromKey(k, graph).x1 === 2000 && cellBoundsFromKey(k, graph).y2 <= 2000);
  assert.equal(arm2.length, 2);
  assert.deepEqual(boundsOf(stair, graph, beyond), boundsOf(stair, graph, arm2), '破れ先はアーム2の 2 セル（コーナーは手前）');
});

test('【破れ位置】アーム2 の途中・アーム1 の取りつき内（clamp）・到達口の clamp でも 3 か所が一致', () => {
  // riser 100 → 破れのマス番号 16 → 16−4＝12（アーム2 の 6 マス目。run2 先頭 #7 から 5 マス進む）。pitch2＝0.75/9
  const a = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  const fa = frames(a.stair, a.graph, 'install');
  const ga = geom(a.stair, a.graph, 'install', { riser: 100 });
  assert.ok(near(ga.breakLine[0].y1, fa.tw(1, RUN_V - 5 * (RUN_V / 9)).y, 1e-6), `アーム2 内の破れ: y=${ga.breakLine[0].y1}`);
  assert.equal(Math.max(...nums(ga)), 15);
  assert.equal(cellsBeyondBreak(a.stair, a.graph, 100).size, 0, 'アーム2 は部分可視（1 セル内では判定不能）なので破れ先は無い');
  // riser 400 → 破れのマス番号 4 → 4−4＝0 → [1, 最終マス] に収めて 1（区画の出口＝直進部の初段）。アーム1 は全て破れの先
  const b = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  const fb = frames(b.stair, b.graph, 'install');
  const gb = geom(b.stair, b.graph, 'install', { riser: 400 });
  assert.ok(near(gb.breakLine[0].x1, fb.tw(0.25, 1).x, 1e-6), `区画の出口（u=zoneU）の破れ: x=${gb.breakLine[0].x1}`);
  assert.equal(Math.max(...nums(gb)), 4, '見える段数字は取りつき回転部の 1〜4 だけ');
  assert.equal(cellsBeyondBreak(b.stair, b.graph, 400).size, b.stair.cells.size - 1, '区画の行（x 0〜1000）以外が破れの先');
  // 到達口だけ側面: 総蹴上数に到達口の取りつき 4 を含めて 16 → 最終マス（アーム2 の 15 マス目の始点）に収める
  const c = lTurn({ sections: [10, 1, 6], arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const fc = frames(c.stair, c.graph, 'install');
  const gc = geom(c.stair, c.graph, 'install', { riser: 100 });
  assert.ok(near(gc.breakLine[0].y1, fc.tw(1, RUN_V - 4 * ((RUN_V - 0.25) / 5)).y, 1e-6), `最終マスの始点: y=${gc.breakLine[0].y1}`);
  assert.equal(Math.max(...nums(gc)), 14);
});

test('【破れ位置】区画（アーム1の基端の行）を横切る区切り線があっても cellsBeyondBreak は同じ位置で切る（区画は保存セルで測る）', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  const before = boundsOf(stair, graph, cellsBeyondBreak(stair, graph, 140));
  graph.addCenterLine(CenterLineType.VERTICAL, 500, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3500, { labeled: false, discipline: Discipline.ARCH });
  const after = [...cellsBeyondBreak(stair, graph, 140)].map(k => cellBoundsFromKey(k, graph));
  const area = (list) => list.reduce((s, c) => s + (c.x2 - c.x1) * (c.y2 - c.y1), 0);
  assert.equal(area(after), area(before.map(c => { const [x1, y1, x2, y2] = c.split(',').map(Number); return { x1, y1, x2, y2 }; })), '覆う範囲は同じ（アーム2 の 3 セル）');
  assert.ok(after.every(c => c.x1 === 3000 && c.y2 <= 3000));
  assert.equal(resolveLTurnPortsOf(stair, graph).entry, 'side', '区画は保存セルで測るので区切り線で消えない');
});

test('【破れ位置】上り口の取りつきで breakCell が 1 になっても区画の行は破れ手前（build は破れ線を区画の出口に引く）', () => {
  // riser 200 → 破れのマス番号 8 → 8−7＝1。区画の行（x 0〜1000）は手前、アーム1の残り・コーナー・アーム2 は先
  const { graph, stair } = lTurn({ sections: [3, 1, 6], entrySide: RIGHT, entryTurnSteps: 7 });
  const { tw } = frames(stair, graph, 'install');
  const g = geom(stair, graph, 'install', { riser: 200 });
  assert.ok(near(g.breakLine[0].x1, tw(0.25, 1).x, 1e-6), '破れ線は区画の出口');
  const beyond = boundsOf(stair, graph, cellsBeyondBreak(stair, graph, 200));
  assert.ok(!beyond.includes('0,3000,1000,4000'), `区画の行は先に入れない: ${beyond}`);
  assert.ok(beyond.includes('1000,3000,2000,4000') && beyond.includes('2000,3000,3000,4000'), 'アーム1の残りは先');
});

test('【破れ位置】コーナーだけを割る短い中心線を足しても、区画は保存セルで測り破れ先は変わらない', () => {
  const { graph, stair } = lTurn({ sections: [2, 1, 6], entrySide: RIGHT, entryTurnSteps: 4 });
  const before = boundsOf(stair, graph, cellsBeyondBreak(stair, graph, 250));
  assert.ok(before.length > 0);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3500, { labeled: false, discipline: Discipline.ARCH, extentLo: 3000, extentHi: 4000 });
  assert.deepEqual(boundsOf(stair, graph, cellsBeyondBreak(stair, graph, 250)).length > 0, true);
  const area = (list) => list.reduce((s, c) => { const [x1, y1, x2, y2] = c.split(',').map(Number); return s + (x2 - x1) * (y2 - y1); }, 0);
  assert.equal(area(boundsOf(stair, graph, cellsBeyondBreak(stair, graph, 250))), area(before));
});

test('【破れ位置】riser 未指定でも到達口の取りつき蹴上が総蹴上数に入る', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 2], arrivalSide: LEFT, arrivalTurnSteps: 4 }, { arm1: 2, arm2: 2 });
  const g = geom(stair, graph, 'install', { riser: null });
  assert.deepEqual(nums(g), [1, 2, 3, 4, 5, 6]);
  assert.equal(cellsBeyondBreak(stair, graph, null).size, 2);
});

test('【破れ位置】アーム境界は実測で分ける: コーナーに隣るアーム2のセルも先に入る（0.5 象限判定では漏れていた）', () => {
  // riser 140 → 破れのマス番号 11＝run2 の先頭（コーナーは手前、アーム2 は全て先）
  const { graph, stair } = lTurn({ sections: [10, 1, 10] });
  const beyond = boundsOf(stair, graph, cellsBeyondBreak(stair, graph, 140));
  assert.deepEqual(beyond, ['3000,0,4000,1000', '3000,1000,4000,2000', '3000,2000,4000,3000']);
});

test('【失敗系】選べない保存値（1 行のアーム1・曲がり階段）は走行端と同じ出力・同じ破れ位置・同じ候補', () => {
  // アーム1が 1 行（コーナーの手前に 1 セル）: 区画が全体で直進部が残らない → 走行端
  const one = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 }, { arm1: 1 });
  const oneEnd = lTurn({ sections: [6, 1, 10] }, { arm1: 1 });
  for (const view of ['install', 'upper']) {
    assert.deepEqual(geom(one.stair, one.graph, view), geom(oneEnd.stair, oneEnd.graph, view), view);
  }
  assert.equal(resolveLTurnPortsOf(one.stair, one.graph), null);
  assert.deepEqual([...cellsBeyondBreak(one.stair, one.graph, RISER)].length, [...cellsBeyondBreak(oneEnd.stair, oneEnd.graph, RISER)].length);
  // 曲がり階段（FLARED）は保存値が側面でも走行端のまま（buildLTurn を共有するが出入口は走行端固定）
  const fl = lTurn({ sections: [6, 2, 10], entrySide: LEFT, entryTurnSteps: 4 }, { type: StairType.FLARED });
  const flEnd = lTurn({ sections: [6, 2, 10] }, { type: StairType.FLARED });
  for (const view of ['install', 'upper']) {
    assert.deepEqual(geom(fl.stair, fl.graph, view), geom(flEnd.stair, flEnd.graph, view), `FLARED ${view}`);
  }
  assert.equal(resolveLTurnPortsOf(fl.stair, fl.graph), null);
  assert.deepEqual(boundsOf(fl.stair, fl.graph, cellsBeyondBreak(fl.stair, fl.graph, RISER)), boundsOf(flEnd.stair, flEnd.graph, cellsBeyondBreak(flEnd.stair, flEnd.graph, RISER)));
  // 2 行: 区画（先頭の行）を除いても直進部が残るので上り口は側面にできる
  const two = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 }, { arm1: 2 });
  assert.equal(resolveLTurnPortsOf(two.stair, two.graph).entry, 'side');
});

test('【走行端のまま】出入口が走行端・自動（null）の矩折は取りつき無しの従来出力（end と null と未指定が一致）', () => {
  const base = lTurn({ sections: [10, 1, 10] });
  const withEnd = lTurn({ sections: [10, 1, 10], entrySide: StairPortSide.END, arrivalSide: StairPortSide.END });
  for (const view of ['install', 'upper']) {
    for (const riser of [RISER, 100, 400]) {
      assert.deepEqual(geom(withEnd.stair, withEnd.graph, view, { riser }), geom(base.stair, base.graph, view, { riser }), `${view} ${riser}`);
    }
  }
  assert.equal(resolveLTurnPortsOf(base.stair, base.graph), null);
  // 走行端の外周: 従来どおり u=0 の辺が thin+port（entry）、アーム2 の far 端が thin+port（arrival）
  const g = geom(base.stair, base.graph, 'upper');
  assert.equal(g.outline.filter(s => s.port === 'entry').length, 1);
  assert.equal(g.outline.filter(s => s.port === 'arrival').length, 1);
});

test('resolveLTurnPorts: 自動は走行端。左右は進行方向の左右で高低へ。区画が直進部を食うときは走行端へ戻す。上り口と到達口は別アームなので互いに影響しない', () => {
  const { graph, stair } = lTurn();
  const info = lTurnPortInfoOf(measureStairSpans(stair, graph));
  assert.deepEqual(info, { L1: 3000, L2: 3000, uLen: 4000, vLen: 4000, firstRow: 1000, lastRow: 1000 });
  assert.deepEqual(resolveLTurnPorts(stair, info), { entry: 'end', arrival: 'end', entryHi: null, arrivalHi: null, zoneU: 0, zoneV: 0, zone1Mm: 0, zone2Mm: 0 });
  const r = resolveLTurnPorts({ ...stair, entrySide: LEFT, arrivalSide: LEFT }, info);
  assert.deepEqual([r.entry, r.arrival, r.entryHi, r.arrivalHi, r.zoneU, r.zoneV], ['side', 'side', 0, 0, 0.25, 0.25]);
  // 1 行のアーム1（区画＝アーム全体）は走行端。アーム2 は影響されない
  const one = lTurn({}, { arm1: 1 });
  const info1 = lTurnPortInfoOf(measureStairSpans(one.stair, one.graph));
  const r1 = resolveLTurnPorts({ ...one.stair, entrySide: LEFT, arrivalSide: RIGHT }, info1);
  assert.deepEqual([r1.entry, r1.arrival], ['end', 'side']);
  assert.equal(resolveLTurnPorts({ ...stair, entrySide: LEFT }, null).entry, 'end', '実測できない');
  // 1 行のアーム2（区画＝アーム全体）は到達口が走行端。アーム1 は影響されない
  const one2 = lTurn({}, { arm2: 1 });
  const info2 = lTurnPortInfoOf(measureStairSpans(one2.stair, one2.graph));
  const r2 = resolveLTurnPorts({ ...one2.stair, entrySide: LEFT, arrivalSide: RIGHT }, info2);
  assert.deepEqual([r2.entry, r2.arrival], ['side', 'end']);
});

test('stairPortEdges: 側面の出入口は区画の側辺。到達口はアーム2の末端の行。走行端のままなら従来の端の辺', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 10], entrySide: LEFT, entryTurnSteps: 4 });
  const e = stairPortEdges(stair, graph, ['entry']);
  assert.ok(e.length >= 1 && e.every(x => !x.isVertical && x.value === 3000), `内側の辺は y=3000 の水平線: ${JSON.stringify(e)}`);
  assert.ok(e.some(x => x.lo <= 0 && x.hi >= 1000), '先頭の行（x 0〜1000）を覆う');
  stair.setField('entrySide', RIGHT);
  const r = stairPortEdges(stair, graph, ['entry']);
  assert.ok(r.every(x => !x.isVertical && x.value === 4000), `外周側の辺は y=4000: ${JSON.stringify(r)}`);
  stair.setField('entrySide', null);
  // 走行端は従来どおり（u=0 の縦の辺 x=0）
  assert.deepEqual(stairPortEdges(stair, graph, ['entry']), [{ isVertical: true, value: 0, lo: 3000, hi: 4000 }]);
  stair.setField('arrivalSide', LEFT);
  stair.setField('arrivalTurnSteps', 4);
  const a = stairPortEdges(stair, graph, ['arrival']);
  assert.ok(a.length >= 1 && a.every(x => x.isVertical && x.value === 3000), `到達口の左＝西の辺は x=3000: ${JSON.stringify(a)}`);
  assert.ok(a.some(x => x.lo <= 0 && x.hi >= 1000), 'アーム2の末端の行（y 0〜1000）を覆う');
});

test('寸法: 側面の口は「取付 段数N」（取りつき蹴上の編集口）がアームの前後に付く。走行端のままなら従来の3区間', () => {
  const { graph, stair } = lTurn({ sections: [6, 1, 6], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const dims = stairSegmentDims(stair, roomBounds(stair.cells, graph), 300, measureStairSpans(stair, graph));
  assert.deepEqual(dims.map(d => [d.label, d.target, d.index ?? null]), [
    ['取付 段数4', 'entryTurnSteps', null], ['アーム1 踏面5', 'sections', 0], ['踊り場', undefined, null],
    ['アーム2 踏面5', 'sections', 2], ['取付 段数4', 'arrivalTurnSteps', null],
  ]);
  // 位置: アーム1側（横）は x 0→1000（取付）→3000（アーム1）、アーム2側（縦）は y 3000→1000（アーム2）→0（取付）。区画の長さは 1000mm
  assert.deepEqual(dims.map(d => [d.dir, d.from, d.to]), [
    ['h', 0, 1000], ['h', 1000, 3000], ['h', 3000, 4000], ['v', 3000, 1000], ['v', 1000, 0],
  ]);
  const plain = lTurn({ sections: [10, 1, 10] });
  const pd = stairSegmentDims(plain.stair, roomBounds(plain.stair.cells, plain.graph), 300, measureStairSpans(plain.stair, plain.graph));
  assert.deepEqual(pd.map(d => d.label), ['アーム1 踏面9', '踊り場', 'アーム2 踏面9']);
});

test('portSideChange（矩折）: 総蹴上数を保つ。上り口はアーム1（sections[0]）・到達口はアーム2（sections[2]）から引き、走行端へ戻すと戻す。直進部 2 段未満は拒否。曲がり階段は切替不可', () => {
  const s = { type: StairType.L_TURN, structure: 'WOOD', tread: 250, sections: [10, 1, 10], entryTurnSteps: 0, arrivalTurnSteps: 0 };
  const e = portSideChange(s, 'entry', LEFT, 1000);
  assert.deepEqual(e, { entrySide: LEFT, entryTurnSteps: 4, sections: [6, 1, 10] });
  const a = portSideChange({ ...s, ...e }, 'arrival', RIGHT, 1000);
  assert.deepEqual(a, { arrivalSide: RIGHT, arrivalTurnSteps: 4, sections: [6, 1, 6] });
  const s3 = { ...s, ...e, ...a };
  assert.equal(s3.sections[0] + s3.sections[2] + s3.entryTurnSteps + s3.arrivalTurnSteps, 20, '総蹴上数（取りつきを含む）は 20 のまま');
  assert.deepEqual(portSideChange(s3, 'entry', StairPortSide.END, 1000), { entrySide: 'end', entryTurnSteps: 0, sections: [10, 1, 6] });
  assert.equal(portSideChange({ ...s, sections: [5, 1, 10] }, 'entry', LEFT, 1000), null, '5−4=1 段');
  assert.equal(portSideChange({ ...s, sections: [10, 1, 5] }, 'arrival', LEFT, 1000), null);
  assert.equal(portSideChange({ ...s, type: StairType.FLARED }, 'entry', LEFT, 1000), null, '曲がり階段は走行端固定');
});

test('矩折→曲がりの型切替前に resetPortSides を適用すると、側面・取りつきが直進部へ戻り総蹴上数が保たれる', () => {
  const stair = new Stair('s', { type: StairType.L_TURN, sections: [6, 1, 6], entrySide: LEFT, entryTurnSteps: 4, arrivalSide: RIGHT, arrivalTurnSteps: 4 });
  const total = stair.totalSteps;
  for (const [k, v] of Object.entries(resetPortSides(stair))) stair.setField(k, v);
  assert.deepEqual([stair.entrySide, stair.arrivalSide, stair.entryTurnSteps, stair.arrivalTurnSteps, stair.sections], [null, null, 0, 0, [10, 1, 10]]);
  assert.equal(stair.totalSteps, total);
});
