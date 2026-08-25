// sectionEmit.js（WP-E2）の単体テスト。「手書きの小さなSectionColumnリテラル→期待するプリミティブ」
// を直接検証する（§9新規テスト方針）。line/z座標のyへの変換はzToY(z)=-z（sectionTypes.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitLine, emitColumns, emitOpenGapMarks, splitGapMarksByStair } from './sectionEmit.js';

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

// ---- 実機指摘2026-08（「6」D）: 「3500左CLにエッジはない」 ----
// 凹み側面線は「隣接列でwallのdistMmが変化した境界」に出す規則だが、列の外側の端では
// 隣接列が存在しない＝未探査であって「壁が終わる」ことを意味しない。面が壁のない端部だと
// 分かっている側（emitCtx.openEndLo/openEndHi）では縦線を出さない。
test('【実機指摘】emitColumns: 壁のない端部側（openEndLo）は描画範囲の端に凹み側面線を出さない', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0 };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
  ];
  const vertAt = (prims, x) => prims.filter(p =>
    p.type === 'line' && Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.x1 - x) < 1e-6);

  const closed = emitColumns(columns, cut, { ceilZ: 2400 });
  assert.ok(vertAt(closed, 0).length >= 1, '既定（端に壁あり扱い）では左端に縦線が出る');
  assert.ok(vertAt(closed, 1000).length >= 1, '既定では右端にも縦線が出る');

  const openLo = emitColumns(columns, cut, { ceilZ: 2400, openEndLo: true });
  assert.equal(vertAt(openLo, 0).length, 0, '壁のない端部側（左）には縦線を出さないはず');
  assert.ok(vertAt(openLo, 1000).length >= 1, '反対側（右）は従来どおり出る');

  const openHi = emitColumns(columns, cut, { ceilZ: 2400, openEndHi: true });
  assert.ok(vertAt(openHi, 0).length >= 1, '左は従来どおり出る');
  assert.equal(vertAt(openHi, 1000).length, 0, '壁のない端部側（右）には縦線を出さないはず');
});

test('【失敗系・実機指摘】emitColumns: 内部の凹み境界はopenEnd指定の影響を受けない', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0 };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 300 }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 2400, openEndLo: true, openEndHi: true });
  const seam = prims.filter(p => p.type === 'line' && Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.x1 - 500) < 1e-6);
  assert.ok(seam.length >= 1, '内部の凹み境界（x=500）は従来どおり出るはず');
});

// ---- ユーザー実機指摘2026-08「6」C「但し、階段に隠れる部分は破線」 ----
test('【実機指摘】splitGapMarksByStair: アキのバツのうち階段の見付け矩形に入る区間だけ破線になる', () => {
  // x=0..1000・z=0..1000 の対角線（y=-z）。階段は x=0..400 / z=0..400 の矩形に居る。
  const diag = { type: 'line', x1: 0, y1: 0, x2: 1000, y2: -1000, weight: 'thin', dash: 'center' };
  const out = splitGapMarksByStair([diag], [{ xLo: 0, xHi: 400, zLo: 0, zHi: 400 }]);
  assert.equal(out.length, 2, '隠れる区間と見えている区間の2本に分かれるはず');
  const dashed = out.filter(p => p.dash === 'dashed');
  const center = out.filter(p => p.dash === 'center');
  assert.equal(dashed.length, 1);
  assert.equal(center.length, 1);
  assert.ok(Math.abs(dashed[0].x1 - 0) < 1e-6 && Math.abs(dashed[0].x2 - 400) < 1e-6,
    `階段の矩形内(x=0..400)が破線のはず（実際:${dashed[0].x1}..${dashed[0].x2}）`);
  assert.ok(Math.abs(center[0].x1 - 400) < 1e-6 && Math.abs(center[0].x2 - 1000) < 1e-6,
    `矩形の外(x=400..1000)は一点鎖線のままのはず（実際:${center[0].x1}..${center[0].x2}）`);
});

test('【失敗系・実機指摘】splitGapMarksByStair: 矩形が無い・交わらない・対象外の線は素通しする', () => {
  const diag = { type: 'line', x1: 0, y1: 0, x2: 1000, y2: -1000, weight: 'thin', dash: 'center' };
  assert.deepEqual(splitGapMarksByStair([diag], []), [diag], '矩形が無ければそのまま');
  assert.deepEqual(splitGapMarksByStair([diag], [{ xLo: 2000, xHi: 3000, zLo: 0, zHi: 400 }]), [diag],
    '交わらなければそのまま');
  // 水平線・すでにdashedの線は対象外（アキのバツの斜め一点鎖線だけを分割する）。
  const horiz = { type: 'line', x1: 0, y1: 0, x2: 1000, y2: 0, weight: 'thin', dash: 'center' };
  const already = { type: 'line', x1: 0, y1: 0, x2: 1000, y2: -1000, weight: 'thin', dash: 'dashed' };
  const rect = [{ xLo: 0, xHi: 400, zLo: 0, zHi: 400 }];
  assert.deepEqual(splitGapMarksByStair([horiz, already], rect), [horiz, already]);
});

// ---- ユーザー実機指摘2026-08「6」D: 壁のない端部の2層取り合い（1F天井・腰壁・2FL床）----
// 実機の列構成をそのまま再現する（左CL=x0、腰壁は左CLに芯合わせでx-57.5..57.5、
// 2F床スラブは左CLで終わる＝x<0のみ。1F天井=2400 / 2FL=3000 / 腰壁天端=3800 / 2F天井=5400）。
function kneeAtOpenEndColumns() {
  const knee = { id: 'w-knee' };
  const far = 'self', above = 'above';
  return [
    { x0: -285, x1: -57.5, worldLo: 0, worldHi: 1, bands: [
      { kind: 'wall', z0: 0, z1: 2400, distMm: 2250, layerRole: far },
      { kind: 'slab', z0: 2400, z1: 3000 },
      { kind: 'wall', z0: 3000, z1: 5400, distMm: 7250, layerRole: above }] },
    { x0: -57.5, x1: 0, worldLo: 1, worldHi: 2, bands: [
      { kind: 'wall', z0: 0, z1: 2400, distMm: 2250, layerRole: far },
      { kind: 'slab', z0: 2400, z1: 3000 },
      { kind: 'cut', z0: 3000, z1: 3800, wall: knee, layerRole: above },
      { kind: 'wall', z0: 3800, z1: 5400, distMm: 7250, layerRole: above }] },
    { x0: 0, x1: 45, worldLo: 2, worldHi: 3, bands: [
      { kind: 'wall', z0: 0, z1: 3000, distMm: 2250, layerRole: far },
      { kind: 'cut', z0: 3000, z1: 3800, wall: knee, layerRole: above },
      { kind: 'wall', z0: 3800, z1: 5400, distMm: 2250, layerRole: far }] },
    { x0: 45, x1: 57.5, worldLo: 3, worldHi: 4, bands: [
      { kind: 'wall', z0: 0, z1: 3000, distMm: 2250, layerRole: far },
      { kind: 'cut', z0: 3000, z1: 3800, wall: knee, layerRole: above },
      { kind: 'wall', z0: 3800, z1: 5400, distMm: 2250, layerRole: far }] },
    { x0: 57.5, x1: 3442.5, worldLo: 4, worldHi: 5, bands: [
      { kind: 'wall', z0: 0, z1: 5400, distMm: 2250, layerRole: far }] },
  ];
}
const kneeCut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 3442.5 }, dirSign: 1,
  zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
const horizAt = (prims, z) => prims.filter(p =>
  Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(p.y1 - (-z)) < 1e-6);
const vertAtX = (prims, x) => prims.filter(p =>
  Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.x1 - x) < 1e-6);

test('【実機指摘・6D(a)】emitColumns: 1F天井断面線は袖壁の階段側の面まで進み、そこから2FL床まで立ち上がる', () => {
  const prims = emitColumns(kneeAtOpenEndColumns(), kneeCut, { ceilZ: 5400, openEndLo: true });
  const xs = horizAt(prims, 2400).flatMap(p => [p.x1, p.x2]);
  assert.equal(Math.min(...xs), -285, '外側の列まで1F天井断面線が出るはず');
  assert.equal(Math.max(...xs), 57.5,
    'スラブはx=0(CL)で終わるが、そこに載る袖壁の階段側の面(x=57.5)まで進むはず');

  // 「1FL天井から2FL床までの上へ向かう線分」（これが無いと天井線が宙で終わる）。
  const riser = prims.filter(p => Math.abs(p.x1 - p.x2) < 1e-6 && Math.abs(p.x1 - 57.5) < 1e-6
    && Math.abs(Math.min(-p.y1, -p.y2) - 2400) < 1e-6 && Math.abs(Math.max(-p.y1, -p.y2) - 3000) < 1e-6);
  assert.equal(riser.length, 1, '袖壁の階段側の面に z2400→3000 の立上りが1本出るはず');
});

test('【実機指摘・6D(b)】emitColumns: 2FL床断面線も袖壁の断面線でトリムされ、袖壁の天端はCUTで出る', () => {
  const prims = emitColumns(kneeAtOpenEndColumns(), kneeCut, { ceilZ: 5400, openEndLo: true });
  const xs = horizAt(prims, 3000).flatMap(p => [p.x1, p.x2]);
  assert.equal(Math.min(...xs), -285, '2FL床断面線は外側の列まで出るはず');
  assert.equal(Math.max(...xs), -57.5, '2FL床断面線も袖壁の外側面(x=-57.5)で止まるはず');
  // 袖壁の天端(3800)はcut帯から壁ごとに1本、全幅で出る（トリムの対象外）。
  const top = horizAt(prims, 3800);
  assert.equal(top.length, 1, '天端は壁ごとに1本のはず');
  assert.equal(top[0].weight, 'thick', '天端は断面＝CUT(太線)のはず');
  assert.deepEqual([top[0].x1, top[0].x2].sort((a, b) => a - b), [-57.5, 57.5], '天端は壁の全幅のはず');
});

test('【失敗系・実機指摘・6D】emitColumns: 袖壁の天端より上を通る線（上階天井z5400）はトリムされない', () => {
  const prims = emitColumns(kneeAtOpenEndColumns(), kneeCut, { ceilZ: 5400, openEndLo: true });
  const xs = horizAt(prims, 5400).flatMap(p => [p.x1, p.x2]);
  assert.equal(Math.min(...xs), -285);
  assert.equal(Math.max(...xs), 3442.5, '天端(3800)より上の線は壁に遮られず端まで通るはず');
});

test('【実機指摘・6D(c)】emitColumns: 見えている壁が別の層へ入れ替わっただけの境界には凹み縦線を描かない', () => {
  const prims = emitColumns(kneeAtOpenEndColumns(), kneeCut, { ceilZ: 5400, openEndLo: true });
  // x=0(左CL)のz3800..5400は above(d7250) → self(d2250) の入れ替わり。連続面の凹みではない。
  const atCL = vertAtX(prims, 0).filter(p =>
    Math.min(-p.y1, -p.y2) >= 3800 - 1e-6 && Math.max(-p.y1, -p.y2) <= 5400 + 1e-6);
  assert.equal(atCL.length, 0, '層が入れ替わっただけの境界に縦線は出ないはず');
  // 腰壁の断面の縦線は外縁2本だけ（内部の列分割 x=0/45 には出ない）。
  const kneeVerts = prims.filter(p => Math.abs(p.x1 - p.x2) < 1e-6
    && Math.abs(Math.max(-p.y1, -p.y2) - 3800) < 1e-6 && Math.abs(Math.min(-p.y1, -p.y2) - 3000) < 1e-6)
    .map(p => p.x1).sort((a, b) => a - b);
  assert.deepEqual(kneeVerts, [-57.5, 57.5], '腰壁の縦線は外縁2本だけのはず');
});

// ---- ユーザー裁定2026-08 A案: 端部の延長は「線の引き伸ばし」ではなく探査範囲の拡張で行う ----
// emitColumns自身は延長を一切しない（sectionProbe.jsのprobeExtendLo/HiMmが外側の列を作り、
// 延長ぶんの線は通常の帯の縁として出る）。両方やると二重に伸びるため、その回帰ガード。
function slabEdgeColumns() {
  // 各列: 下がopen（下階の空間）／上がslab（上階の床）→ 境界z=2400にSILHOUETTE水平線が出る。
  const bands = [{ kind: 'open', z0: 0, z1: 2400 }, { kind: 'slab', z0: 2400, z1: 3000 }];
  return [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands },
  ];
}
const slabEdges = prims => prims.filter(p =>
  p.type === 'line' && Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(p.y1 - (-2400)) < 1e-6);

// ---- ユーザー実機指摘2026-08「6」D: 腰壁断面の内部に列分割由来の縦線が出ていた ----
test('【実機指摘・cut内部線】emitColumns: 同じ壁のcut帯が隣接列に続く境界には縦線を出さず、外縁2本だけ描く', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const knee = { id: 'w-knee' }; // 同一Wall参照
  const columns = [
    { x0: 0, x1: 300, worldLo: 0, worldHi: 300, bands: [{ kind: 'cut', z0: 3000, z1: 3800, wall: knee }] },
    { x0: 300, x1: 700, worldLo: 300, worldHi: 700, bands: [{ kind: 'cut', z0: 3000, z1: 3800, wall: knee }] },
    { x0: 700, x1: 1000, worldLo: 700, worldHi: 1000, bands: [{ kind: 'cut', z0: 3000, z1: 3800, wall: knee }] },
  ];
  const verts = emitColumns(columns, cut, { ceilZ: 5400 })
    .filter(p => Math.abs(p.x1 - p.x2) < 1e-6).map(p => p.x1).sort((a, b) => a - b);
  assert.deepEqual(verts, [0, 1000], '内部境界(x=300/700)には縦線を出さず、壁の外縁だけ描くはず');
});

test('【失敗系・実機指摘・cut内部線】emitColumns: 別の壁のcut帯が隣接する境界には従来どおり縦線を描く', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'cut', z0: 3000, z1: 3800, wall: { id: 'a' } }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'cut', z0: 3000, z1: 3800, wall: { id: 'b' } }] },
  ];
  const verts = emitColumns(columns, cut, { ceilZ: 5400 })
    .filter(p => Math.abs(p.x1 - p.x2) < 1e-6).map(p => p.x1);
  assert.ok(verts.includes(500), '別の壁同士が接する境界（x=500）には縦線が出るはず');
});

test('【裁定A案】emitColumns: openEnd指定があっても線は列の範囲どおりで、自前の延長は一切しない', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const columns = slabEdgeColumns();

  const prims = slabEdges(emitColumns(columns, cut, { ceilZ: 5400, openEndLo: true, openEndHi: true }));
  const xs = prims.flatMap(p => [p.x1, p.x2]);
  assert.equal(Math.min(...xs), 0, '列がx=0から始まる以上、線もx=0で始まるはず（二重延長の防止）');
  assert.equal(Math.max(...xs), 1000, '同じく列の右端x=1000を超えないはず');
});

test('【裁定A案】emitColumns: 外側まで列が伸びていれば、スラブ端の線はその列の範囲どおりに外側まで出る', () => {
  // sectionProbeが延長した結果として先頭列がx<0から始まるケース（本番相当）。
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const bands = [{ kind: 'open', z0: 0, z1: 2400 }, { kind: 'slab', z0: 2400, z1: 3000 }];
  const columns = [
    { x0: -150, x1: 0, worldLo: -150, worldHi: 0, bands },
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands },
  ];
  const xs = slabEdges(emitColumns(columns, cut, { ceilZ: 5400, openEndLo: true }))
    .flatMap(p => [p.x1, p.x2]);
  assert.equal(Math.min(...xs), -150, '外側の列(x=-150..0)のスラブ端線がそのまま出るはず');
});
