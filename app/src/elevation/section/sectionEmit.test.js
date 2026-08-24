// sectionEmit.js（WP-E2）の単体テスト。「手書きの小さなSectionColumnリテラル→期待するプリミティブ」
// を直接検証する（§9新規テスト方針）。line/z座標のyへの変換はzToY(z)=-z（sectionTypes.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitLine, emitColumns, emitOpenGapMarks } from './sectionEmit.js';

function makeCut(overrides = {}) {
  return { seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 3000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0, ...overrides };
}

// ---- 線種テーブル各行 ----

test('【WP-E2・線種テーブル】emitColumns: cut縁が接する側がopenならCUT', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'cut', z0: 0, z1: 2400 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'open', z0: 0, z1: 2400 }] },
  ];
  const prims = emitColumns(columns, cut);
  const rightEdge = prims.find(p => p.x1 === 500 && p.x2 === 500);
  assert.ok(rightEdge, '右縁(x=500)の縦線があるはず');
  assert.equal(rightEdge.weight, 'thick', 'open側に接する縁はCUT(thick)のはず');
});

test('【WP-E2・線種テーブル】emitColumns: cut縁が塞がれていれば(隣もcut)SILHOUETTE', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'cut', z0: 0, z1: 2400 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'cut', z0: 0, z1: 2400 }] },
  ];
  const prims = emitColumns(columns, cut);
  const rightEdge = prims.find(p => p.x1 === 500 && p.x2 === 500 && p.y1 === 0);
  assert.ok(rightEdge);
  assert.equal(rightEdge.weight, 'medium', '隣もcut(塞がれている)側の縁はSILHOUETTE(medium)のはず');
});

test('【WP-E2・線種テーブル・§5.5】emitColumns: 隣接列でwallのdistMmが変化した境界にSILHOUETTE縦線(凹み)が出る', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 300 }] },
  ];
  const prims = emitColumns(columns, cut);
  const seam = prims.filter(p => p.x1 === 500 && p.x2 === 500 && p.y1 === 0 && p.y2 === -2400);
  assert.ok(seam.length >= 1, `境界(x=500)に凹みの縦線が出るはず（実際:${JSON.stringify(prims)}）`);
  assert.equal(seam[0].weight, 'medium', '凹みの側面線はSILHOUETTEのはず');
});

test('【失敗系・WP-E2・§5.5】emitColumns: 隣接列でdistMmが同じなら凹みの縦線は出ない', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
  ];
  const prims = emitColumns(columns, cut);
  const seam = prims.filter(p => p.x1 === 500 && p.x2 === 500 && p.y1 === 0 && p.y2 === -2400);
  assert.equal(seam.length, 0, 'distMmが同じ境界には凹みの縦線が出ないはず');
});

test('【WP-E2・線種テーブル】emitOpenGapMarks: baseFloorZより上のアキXはdash:center', () => {
  const cut = makeCut({ baseFloorZ: 0 });
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'open', z0: 500, z1: 2400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 2, 'X=対角線2本のはず');
  for (const p of prims) assert.equal(p.dash, 'center');
});

test('【WP-E2・線種テーブル】emitOpenGapMarks: 床断面より下のアキXはdash:dashed', () => {
  const cut = makeCut({ baseFloorZ: 500 });
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'open', z0: 0, z1: 400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 2);
  for (const p of prims) assert.equal(p.dash, 'dashed');
});

// ---- 最終フィルタ（§5.6最終行）----

test('【WP-E2・最終フィルタ】emitLine: 両端がbaseFloorZ未満ならDETAIL+dashed へ降格する', () => {
  const cut = makeCut({ baseFloorZ: 500, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, 100, 0, 400, 'cut'); // roleは本来CUT(thick)だが降格されるはず
  assert.equal(prim.weight, 'thin', 'DETAIL(thin)へ降格されるはず');
  assert.equal(prim.dash, 'dashed');
});

test('【WP-E2・最終フィルタ】emitLine: 両端が天井断面より上ならDETAIL+dashedへ降格する', () => {
  const cut = makeCut({ baseFloorZ: 0, zRange: { loZ: 0, hiZ: 2000 } });
  const prim = emitLine(cut, 0, 2100, 0, 2400, 'wall', { ceilZ: 2000 });
  assert.equal(prim.weight, 'thin');
  assert.equal(prim.dash, 'dashed');
});

test('【失敗系・WP-E2・最終フィルタ】emitLine: baseFloorZ〜天井断面の範囲内ならroleそのまま(降格しない)', () => {
  const cut = makeCut({ baseFloorZ: 0, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, 100, 0, 2000, 'cut');
  assert.equal(prim.weight, 'thick', '範囲内はCUT(thick)のまま降格されないはず');
  assert.equal(prim.dash, undefined);
});

test('【失敗系・WP-E2・最終フィルタ】emitLine: 片端だけがbaseFloorZ未満（もう片端は範囲内）なら「両端とも」条件を満たさないため降格しない', () => {
  const cut = makeCut({ baseFloorZ: 0, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, -100, 0, 100, 'cut'); // z1のみbaseFloorZ未満
  assert.equal(prim.weight, 'thick', '片端だけでは「両端とも向こう側」に該当しないため降格しないはず');
  assert.equal(prim.dash, undefined);
});

// ---- 実機フィードバック第3弾C: neverDowngrade（CUT断面・ささらの見えがかり帯は降格しない） ----

test('【実機フィードバック第3弾C】emitLine: neverDowngrade:trueは両端がbaseFloorZ未満でも降格せずroleそのまま', () => {
  const cut = makeCut({ baseFloorZ: 500, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, 100, 0, 400, 'cut', { neverDowngrade: true });
  assert.equal(prim.weight, 'thick', 'CUT断面はbaseFloorZより下でも太線実線のまま(降格しない)のはず');
  assert.equal(prim.dash, undefined, 'dashは付かないはず');
});

test('【実機フィードバック第3弾C】emitLine: neverDowngrade:trueは天井断面より上でも降格せずDETAILのroleそのまま', () => {
  const cut = makeCut({ baseFloorZ: 0, zRange: { loZ: 0, hiZ: 2000 } });
  const prim = emitLine(cut, 0, 2100, 0, 2400, 'detail', { ceilZ: 2000, neverDowngrade: true });
  assert.equal(prim.weight, 'thin', 'DETAIL(ささらの見えがかり)は天井断面より上でも細線実線のまま(降格しない)のはず');
  assert.equal(prim.dash, undefined, 'dashは付かないはず');
});

test('【失敗系・実機フィードバック第3弾C】emitLine: neverDowngrade:trueでもforceDash単体では降格しない（既定falseと違いforceDashも無効化される）', () => {
  const cut = makeCut({ baseFloorZ: 0, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, 100, 1000, 100, 'cut', { forceDash: true, neverDowngrade: true });
  assert.equal(prim.weight, 'thick', 'neverDowngrade:trueはforceDashも含め降格判定そのものを無効化するはず');
  assert.equal(prim.dash, undefined);
});

test('【失敗系・実機フィードバック第3弾C】emitLine: neverDowngrade未指定(既定false)は従来どおり降格する（回帰ガード）', () => {
  const cut = makeCut({ baseFloorZ: 500, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, 100, 0, 400, 'cut');
  assert.equal(prim.weight, 'thin', '既存呼び出し(neverDowngrade省略)は従来どおり降格するはず');
  assert.equal(prim.dash, 'dashed');
});

// ---- QA最終検証・修正3: 境界単体テスト（水平線でz===baseFloorZちょうどの通常の床線）----
// isDegenerate分岐の`z1 < baseFloorZ - GAP_EPS`はstrict `<`でなければならない——`<=`に変異すると
// 「ちょうどbaseFloorZの通常の床線」まで誤って向こう側(降格)扱いになる。既存の統合テスト
// （stairFaceSequence経由）ではこの1本のstrict比較だけを狙った変異が1本しか赤くならず検出力が
// 弱かったため、emitLine単体でこの境界を直接固定する。
test('【QA修正3・失敗系・WP-E2・最終フィルタ】emitLine: 水平線のz1===z2===baseFloorZ（通常の床線）は降格しない', () => {
  const cut = makeCut({ baseFloorZ: 500, zRange: { loZ: 0, hiZ: 2400 } });
  const prim = emitLine(cut, 0, 500, 1000, 500, 'cut'); // z1=z2=baseFloorZ=500ちょうど
  assert.equal(prim.weight, 'thick', 'baseFloorZちょうどの通常の床線はCUT(thick)のまま降格されないはず');
  assert.equal(prim.dash, undefined, 'dashは付かないはず');
});

// ---- アキX連結（開口+上階アキ=1組のX。defer D1の一般規則） ----

test('【WP-E2・D1】emitOpenGapMarks: 隣接列のopenPassThrough帯とopen帯がz範囲重なりで連結し1組のXになる', () => {
  const cut = makeCut({ baseFloorZ: 0 });
  const columns = [
    // 開口相当（本来kind:'wall'だがWP-E7でopeningPassThrough:trueが付く想定）とアキが隣接し、
    // z範囲が重なる（1900-2400 と 1800-2400）。
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 1900, z1: 2400, distMm: 50, openingPassThrough: true }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'open', z0: 1800, z1: 2400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 2, '連結成分が1つなら対角線2本(=1組のX)のはず（実際:' + prims.length + '本）');
});

test('【失敗系・WP-E2・D1】emitOpenGapMarks: z範囲が重ならなければ連結せず2組のX(4本)になる', () => {
  const cut = makeCut({ baseFloorZ: 0 });
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 100, z1: 400, distMm: 50, openingPassThrough: true }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'open', z0: 1800, z1: 2400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 4, 'z範囲が重ならなければ連結されず、2組のX(4本)のはず');
});

test('【失敗系・WP-E2・D1】emitOpenGapMarks: openingPassThroughが無いkind:wall帯はアキ扱いにならず連結しない', () => {
  const cut = makeCut({ baseFloorZ: 0 });
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 1900, z1: 2400, distMm: 50 }] }, // openingPassThrough無し
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'open', z0: 1800, z1: 2400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 2, 'wall帯自体はアキ扱いにならないため、open帯単独の1組(2本)のみのはず');
});

// ==== WP-E5リード裁定: cutAlongの描画規則（上端エッジCUT・端部縦線） ====

test('【WP-E5・cutAlong】emitColumns: cutAlongの上端エッジはCUT水平線', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'cutAlong', z0: 0, z1: 900 }] },
  ];
  const prims = emitColumns(columns, cut);
  const top = prims.find(p => p.y1 === -900 && p.y2 === -900);
  assert.ok(top, '上端エッジ(y=-900の水平線)があるはず');
  assert.equal(top.weight, 'thick', '上端エッジはCUT(thick)のはず');
});

test('【WP-E5・cutAlong】emitColumns: cutAlongのx方向の実端にはCUT縦線（端部縦線）が出る', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'cutAlong', z0: 0, z1: 900 }] },
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000, bands: [{ kind: 'open', z0: 0, z1: 2400 }] },
  ];
  const prims = emitColumns(columns, cut);
  const leftEdge  = prims.find(p => p.x1 === 0 && p.x2 === 0 && p.y1 === 0 && p.y2 === -900);
  const rightEdge = prims.find(p => p.x1 === 1000 && p.x2 === 1000 && p.y1 === 0 && p.y2 === -900);
  assert.ok(leftEdge, '壁の左端(x=0)にCUT縦線があるはず');
  assert.equal(leftEdge.weight, 'thick');
  assert.ok(rightEdge, '壁の右端(x=1000。隣列がcutAlongでない)にCUT縦線があるはず');
  assert.equal(rightEdge.weight, 'thick');
});

test('【失敗系・WP-E5・cutAlong】emitColumns: 隣接列も同じcutAlongなら境界に端部縦線は出ない', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'cutAlong', z0: 0, z1: 900 }] },
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000, bands: [{ kind: 'cutAlong', z0: 0, z1: 900 }] },
  ];
  const prims = emitColumns(columns, cut);
  const seam = prims.filter(p => p.x1 === 1000 && p.x2 === 1000 && p.y1 === 0 && p.y2 === -900);
  assert.equal(seam.length, 0, '同じcutAlongが続く境界には端部縦線は出ないはず');
});
