// snapGeometry.js findCLCrossing（長クリック位置の縦線×横線の交点判定）のテスト。
// 実 CenterLine を使う。座標は原点から離し、縦横で非対称にする（x/y・scale の取り違え変異を拾うため）。
// snap.js（store.js を引く）は import しない。閾値 8 は呼び出し側が CL_THRESHOLD_PX を渡す想定の引数値。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInAction } from 'mobx';
import { Project, CenterLineType, Discipline } from './core.js';
import { CL_OVERLAP_TOL_MM } from './core/constants.js';
import {
  findCLCrossing as findCLCrossingRaw, findNearestCenterLineEndpoint, findNearestCenterLineEndpointWithDist,
  clEndpointPerpDist, minEndpointHitDistPx, openingHitApplies, pointerTargetScope,
} from './snapGeometry.js';
import { Viewport } from './viewport.js';

// CL は循環参照を持つ大きなオブジェクトで、assert.equal の失敗時 diff が止まる——vCL/hCL は id に畳んで返す。
function findCLCrossing(...args) {
  const r = findCLCrossingRaw(...args);
  return r === null ? null : { ...r, vCL: r.vCL.id, hCL: r.hCL.id };
}

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const TH = 8;

function makeEnv() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  const sg = project.structGraph;
  const grid = (t, v) => sg.addCenterLine(t, v, { labeled: true, discipline: Discipline.STRUCT });
  const center = (t, v, lo, hi) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH, extentLo: lo, extentHi: hi });
  return { graph, grid, center };
}

test('【交点】両線から閾値内で交点が範囲内なら {vCL,hCL,x,y} を返す（x は縦線・y は横線の値）', () => {
  const { grid } = makeEnv();
  const v = grid(V, 1300), h = grid(H, 2700);
  const r = findCLCrossing([v], [h], 1320, 2690, TH, 0.2, 0.5);
  assert.equal(r.vCL, v.id);
  assert.equal(r.hCL, h.id);
  assert.equal(r.x, 1300);
  assert.equal(r.y, 2700);
});

test('【交点・失敗側】片方の線だけ近い・どちらも遠いなら null', () => {
  const { grid } = makeEnv();
  const v = grid(V, 1300), h = grid(H, 2700);
  assert.equal(findCLCrossing([v], [h], 1320, 2670, TH, 0.2, 0.5), null, '横線まで 30mm×0.5=15px');
  assert.equal(findCLCrossing([v], [h], 1360, 2700, TH, 0.2, 0.5), null, '縦線まで 60mm×0.2=12px');
  assert.equal(findCLCrossing([v], [h], 1360, 2670, TH, 0.2, 0.5), null);
});

test('【交点】閾値ちょうどは当たらない（findNearestCenterLine と同じ <）。内側は当たる', () => {
  const { grid } = makeEnv();
  const v = grid(V, 1300), h = grid(H, 2700);
  assert.equal(findCLCrossing([v], [h], 1332, 2700, TH, 0.25, 0.5), null, 'x 距離 32×0.25=8px ちょうど');
  assert.ok(findCLCrossing([v], [h], 1331, 2700, TH, 0.25, 0.5), 'x 距離 7.75px');
  assert.equal(findCLCrossing([v], [h], 1300, 2716, TH, 0.25, 0.5), null, 'y 距離 16×0.5=8px ちょうど');
  assert.ok(findCLCrossing([v], [h], 1300, 2715, TH, 0.25, 0.5), 'y 距離 7.5px');
  assert.equal(findCLCrossing([v], [h], 1268, 2700, TH, 0.25, 0.5), null, '負方向も同じ');
});

test('【交点】scaleX≠scaleY: x は scaleX・y は scaleY で画面距離にする', () => {
  const { grid } = makeEnv();
  const v = grid(V, 1300), h = grid(H, 2700);
  assert.ok(findCLCrossing([v], [h], 1350, 2705, TH, 0.1, 1.0), 'dx=5px・dy=5px');
  assert.equal(findCLCrossing([v], [h], 1350, 2705, TH, 1.0, 0.1), null, 'dx=50px');
});

test('【交点・範囲】交点が線の実範囲の外（はね出し側の延長上）なら null', () => {
  const { grid, center } = makeEnv();
  const h = grid(H, 2700);
  const vOut = center(V, 4100, 3000, 5000); // y=2700 は範囲 [3000,5000] の外
  assert.equal(findCLCrossing([vOut], [h], 4100, 2700, TH, 0.2, 0.2), null);
  const vIn = center(V, 4100, 2000, 5000);
  assert.ok(findCLCrossing([vIn], [h], 4100, 2700, TH, 0.2, 0.2));
  // 横線側の範囲も見る（縦線 x=1300 は横線 [2000,4000] の外）
  const g = grid(V, 1300);
  const hOut = center(H, 3300, 2000, 4000);
  assert.equal(findCLCrossing([g], [hOut], 1300, 3300, TH, 0.2, 0.2), null);
});

test('【交点・範囲】端は許容 CL_OVERLAP_TOL_MM まで当たり、それを超えると null（下端・上端とも）', () => {
  const { grid, center } = makeEnv();
  const h = grid(H, 2700);
  const click = (v) => findCLCrossing([v], [h], 4100, 2700, TH, 0.2, 0.2);
  assert.ok(click(center(V, 4100, 2700 + CL_OVERLAP_TOL_MM / 2, 5000)), '下端が許容内');
  assert.equal(click(center(V, 4100, 2700 + CL_OVERLAP_TOL_MM * 2, 5000)), null, '下端が許容外');
  assert.ok(click(center(V, 4100, 1000, 2700 - CL_OVERLAP_TOL_MM / 2)), '上端が許容内');
  assert.equal(click(center(V, 4100, 1000, 2700 - CL_OVERLAP_TOL_MM * 2)), null, '上端が許容外');
});

test('【交点・範囲】範囲未確定（extent が null）の中心線は全軸に及ぶ扱い', () => {
  const { grid, center } = makeEnv();
  const h = grid(H, 2700);
  assert.ok(findCLCrossing([center(V, 4100, null, null)], [h], 4100, 2700, TH, 0.2, 0.2));
});

test('【交点】候補が複数あれば交点までの画面距離が最小の組（非対称な座標）', () => {
  const { grid } = makeEnv();
  const v1 = grid(V, 1300), v2 = grid(V, 1340), h1 = grid(H, 2700), h2 = grid(H, 2720);
  const r = findCLCrossing([v1, v2], [h1, h2], 1322, 2705, TH, 0.25, 0.25);
  assert.equal(r.vCL, v2.id);
  assert.equal(r.hCL, h1.id);
  assert.equal(r.x, 1340);
  assert.equal(r.y, 2700);
});

test('【交点】最小は縦線ごと・横線ごとの最近傍の組（遠い横線が先に並んでいても、同じ縦線の近い横線を選ぶ）', () => {
  const { grid } = makeEnv();
  const v1 = grid(V, 1300), v2 = grid(V, 1325), h1 = grid(H, 2700), h2 = grid(H, 2720);
  // 点 (1320, 2720)・scale 0.25: v1 は 5px・v2 は 1.25px、h1 は 5px・h2 は 0px。最近傍は (v2, h2)。
  const r = findCLCrossing([v1, v2], [h1, h2], 1320, 2720, TH, 0.25, 0.25);
  assert.equal(r.vCL, v2.id);
  assert.equal(r.hCL, h2.id);
  assert.equal(r.x, 1325);
  assert.equal(r.y, 2720);
  const r2 = findCLCrossing([v2, v1], [h1, h2], 1320, 2720, TH, 0.25, 0.25);
  assert.equal(r2.hCL, h2.id, 'v2 に対して遠い h1 が先に並んでいても h2');
});

test('【交点】距離は画面上のユークリッド距離（範囲で組が欠けると、dx+dy や dx だけの比較では別の組になる）', () => {
  const { grid, center } = makeEnv();
  const v1 = grid(V, 1003);
  const v2 = center(V, 1000, 2004, 2500); // y=2003 は範囲外（下端 2004−0.5 未満）・y=2005 は範囲内
  const h1 = grid(H, 2003), h2 = grid(H, 2005);
  // 点 (1000, 2000)・scale 1: (v1,h1)=(3,3)→4.24（和 6）、(v2,h2)=(0,5)→5（和 5）、(v1,h2)=(3,5)。(v2,h1) は範囲外。
  const r = findCLCrossing([v1, v2], [h1, h2], 1000, 2000, TH, 1, 1);
  assert.equal(r.vCL, v1.id);
  assert.equal(r.hCL, h1.id);
  const r2 = findCLCrossing([v2, v1], [h2, h1], 1000, 2000, TH, 1, 1);
  assert.equal(r2.vCL, v1.id, '並び順に依らない');
  assert.equal(r2.hCL, h1.id);
});

test('【交点】ドラッグ中の線（pendingDelta≠0）でも描かれている位置 value で判定し、x は value', () => {
  const { grid } = makeEnv();
  const v = grid(V, 1300), h = grid(H, 2700);
  runInAction(() => { v.pendingDelta = 40; }); // effectiveValue は 1340
  const near = findCLCrossing([v], [h], 1310, 2700, TH, 0.25, 0.25); // value から 10mm=2.5px
  assert.equal(near.x, 1300, 'x は value（effectiveValue 1340 ではない）');
  assert.equal(findCLCrossing([v], [h], 1340, 2700, TH, 0.25, 0.25), null, 'effectiveValue 位置は value から 40mm=10px で当たらない');
});

test('【交点・範囲】extent が設定された通り芯でも全域扱い（範囲の外でも当たる）', () => {
  const { graph } = makeEnv();
  const sg = graph._structGraph;
  const gridWithExtent = (t, v) => sg.addCenterLine(t, v, { labeled: true, discipline: Discipline.STRUCT, extentLo: 9000, extentHi: 9500 });
  const v = gridWithExtent(V, 1300), h = gridWithExtent(H, 2700);
  assert.notEqual(v.extentLo, null, '前提: extent が非 null');
  assert.ok(findCLCrossing([v], [h], 1300, 2700, TH, 0.2, 0.2));
});

test('【交点・範囲】extent が片側だけ null の中心線は全域扱い（findNearestCenterLine と同じ）', () => {
  const { grid, center } = makeEnv();
  const h = grid(H, 2700);
  assert.ok(findCLCrossing([center(V, 4100, 9000, null)], [h], 4100, 2700, TH, 0.2, 0.2), 'extentHi だけ null');
  assert.ok(findCLCrossing([center(V, 4100, null, 1000)], [h], 4100, 2700, TH, 0.2, 0.2), 'extentLo だけ null');
});

test('【交点】非有限の押下位置・scale は null（throw しない）', () => {
  const { grid } = makeEnv();
  const v = grid(V, 1300), h = grid(H, 2700);
  assert.equal(findCLCrossing([v], [h], NaN, 2700, TH, 0.2, 0.2), null);
  assert.equal(findCLCrossing([v], [h], 1300, 2700, TH, NaN, 0.2), null);
  assert.equal(findCLCrossing([v], [h], 1300, 2700, TH, 0.2, NaN), null);
});

test('【端点の距離】findNearestCenterLineEndpointWithDist は findNearestCenterLineEndpoint と同じ候補を選び、突端円は中心までの画面距離を返す', () => {
  const { graph, center } = makeEnv();
  const cl = center(V, 3300, 2700, 6700);
  const vp = new Viewport(1000, 800);
  runInAction(() => { vp.scaleX = vp.pxPerMmX / 100; vp.scaleY = vp.pxPerMmY / 100; }); // 1/100: 下端の突端は 2700−300=2400
  const any = () => true;
  const withDist = findNearestCenterLineEndpointWithDist(graph, 3300, 2500, TH, vp.scaleX, vp.scaleY, vp, any);
  const plain = findNearestCenterLineEndpoint(graph, 3300, 2500, TH, vp.scaleX, vp.scaleY, vp, any);
  assert.ok(withDist.cl === cl && plain.cl === cl);
  assert.equal(withDist.side, 'lo');
  assert.equal(plain.side, 'lo');
  assert.deepEqual(Object.keys(plain).sort(), ['cl', 'side'], '既存関数の戻り値の形は不変（dist を足さない）');
  assert.ok(Math.abs(withDist.dist - 100 * vp.scaleY) < 1e-9, '突端（2400）まで 100mm の画面距離');
  assert.ok(findNearestCenterLineEndpointWithDist(graph, 3300, 4500, TH, vp.scaleX, vp.scaleY, vp, any) === null, '端から遠い点は候補なし');
});

test('【交点・失敗側】空配列は null', () => {
  const { grid } = makeEnv();
  assert.equal(findCLCrossing([], [], 1300, 2700, TH, 0.2, 0.2), null);
  assert.equal(findCLCrossing([grid(V, 1300)], [], 1300, 2700, TH, 0.2, 0.2), null);
  assert.equal(findCLCrossing([], [grid(H, 2700)], 1300, 2700, TH, 0.2, 0.2), null);
});

// ---- 端点までの最短距離（柱の長クリックが交点と比べる値）と建具の当たりの適用モード ----
const vLine = value => ({ centerLineType: V, value });
const hLine = value => ({ centerLineType: H, value });

test('【clEndpointPerpDist】縦線は x 距離×scaleX・横線は y 距離×scaleY（非対称 scale）', () => {
  assert.equal(clEndpointPerpDist(vLine(1000), 1100, 9999, 0.04, 0.05), 100 * 0.04);
  assert.equal(clEndpointPerpDist(hLine(2000), 9999, 2100, 0.04, 0.05), 100 * 0.05);
});

test('【minEndpointHitDistPx】突端だけ→tip.dist・足だけ→足の線への垂直距離・両方→小さいほう・どちらも無ければ null', () => {
  const tip = { dist: 3 };
  const leg = { cl: vLine(1000), side: 'lo' }; // 点 x=1100・scaleX 0.04 → 4px
  assert.equal(minEndpointHitDistPx(tip, null, 1100, 0, 0.04, 0.05), 3, '突端だけ');
  assert.equal(minEndpointHitDistPx(null, leg, 1100, 0, 0.04, 0.05), 100 * 0.04, '足だけ');
  assert.equal(minEndpointHitDistPx(tip, leg, 1100, 0, 0.04, 0.05), 3, '両方: 突端のほうが近い');
  assert.equal(minEndpointHitDistPx({ dist: 6 }, leg, 1100, 0, 0.04, 0.05), 100 * 0.04, '両方: 足のほうが近い');
  assert.ok(minEndpointHitDistPx(null, null, 1100, 0, 0.04, 0.05) === null, 'どちらも無ければ null');
});

test('【openingHitApplies】建具を解決する平面は真・構造と天伏は偽（pointerTargetScope.planTargets と同じ）', () => {
  assert.equal(openingHitApplies('floorplan'), true);
  assert.equal(openingHitApplies('structure'), false);
  assert.equal(openingHitApplies('ceiling'), false);
  for (const m of ['floorplan', 'structure', 'ceiling', 'finish']) {
    assert.equal(openingHitApplies(m), pointerTargetScope(m).planTargets, m);
  }
});
