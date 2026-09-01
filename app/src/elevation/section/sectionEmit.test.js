// sectionEmit.js（WP-E2）の単体テスト。「手書きの小さなSectionColumnリテラル→期待するプリミティブ」
// を直接検証する（§9新規テスト方針）。line/z座標のyへの変換はzToY(z)=-z（sectionTypes.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emitLine, emitColumns, emitOpenGapMarks, splitGapMarksByStair, dashHorizontalsBehindStair,
  joinToStairProfile, clipStairDetailInSlabBand,
} from './sectionEmit.js';
import { KNEE_CAP_FACE_MM } from '../elevationStyle.js';
import { buildColumns } from './sectionEngine.js';

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

// ユーザー明示指示2026-08「切断壁の縁は降格しない／『切断壁の縁は太線』が正」で規則変更。
// 旧規則（縁の隣がアキならCUT・塞がれていればSILHOUETTE）は撤回した——断面は隣に何があっても断面。
test('【明示指示2026-08】emitColumns: cut縁は隣が塞がれていても太線のまま（降格しない）', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'cut', z0: 0, z1: 2400 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'cut', z0: 0, z1: 2400 }] },
  ];
  const prims = emitColumns(columns, cut);
  const rightEdge = prims.find(p => p.x1 === 500 && p.x2 === 500 && p.y1 === 0);
  assert.ok(rightEdge);
  assert.equal(rightEdge.weight, 'thick', '隣もcut(塞がれている)側の縁もCUT(thick)のはず');
});

// ---- ユーザー明示指示2026-08「その他の見えがかりの線を直近を中線、それ以外を細線で分類」 ----
test('【明示指示2026-08】emitColumns: 見えがかりは直近が中線・それより奥は細線', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 1000, layerRole: 'self' }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 4000, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 3000 }); // 天井は2400より上（CHの線は描かないため）
  const nearTop = prims.find(p => p.x1 === 0 && p.x2 === 500 && p.y1 === p.y2 && p.y1 === -2400);
  const farTop  = prims.find(p => p.x1 === 500 && p.x2 === 1000 && p.y1 === p.y2 && p.y1 === -2400);
  assert.equal(nearTop.weight, 'medium', '直近(d=1000)の見えがかりは中線');
  assert.equal(farTop.weight, 'thin', '奥(d=4000)の見えがかりは細線');
});

test('【明示指示2026-08】emitColumns:「直近」は列ごとではなく切断（図）全体で決める', () => {
  const cut = makeCut();
  // 単独で見れば各列の最前面だが、図全体で最も手前なのは d=1000 の列だけ。
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 4000, layerRole: 'self' }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 1000, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 3000 }); // 天井は2400より上（CHの線は描かないため）
  const farTop = prims.find(p => p.x1 === 0 && p.x2 === 500 && p.y1 === p.y2 && p.y1 === -2400);
  assert.equal(farTop.weight, 'thin',
    'その列では最前面でも、図全体では奥なので細線（列ごとに最小を取ると奥行きの表現が失われる）');
});

// ---- ユーザー明示指示2026-08「展開図では、断面の中は描画しない」----
// 描けるのは床断面線と天井断面線に挟まれた範囲だけ。天井断面の高さは区間ごとに違うため、
// 列ごとの天井（col.ceilZ。sectionEngine.jsがcut.ceilProfileから付ける）で判定する。
test('【明示指示2026-08】emitColumns: その列の天井断面には見えがかりの水平線を描かない（帯の天井ではなく列の天井）', () => {
  const cut = { ...makeCut(), baseFloorZ: 0, zRange: { loZ: 0, hiZ: 5400 }, layers: [{ floorZMm: 0 }] };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, ceilZ: 2400,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 58, layerRole: 'self' }] },
  ];
  // 帯の天井は5400だが、この列の天井断面は2400。2400に見えがかりの水平線を出してはいけない。
  assert.equal(emitColumns(columns, cut, { ceilZ: 5400 })
    .filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -2400) < 1e-6).length, 0,
  '列の天井(2400)に見えがかりの水平線が出ている＝天井断面線と二重になる');
});

// ---- ユーザー明示指示2026-08「FLの見えがかりは描画しない」「仮想断面からの距離が変わるところに
// 垂直、水平、または、斜めの見えがかり線を描画」 ----
test('【明示指示2026-08】emitColumns: FL（床レベル）には見えがかりの水平線を描かない', () => {
  const cut = { ...makeCut(), baseFloorZ: 0, layers: [{ floorZMm: 0 }] };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 58, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  const atFL = prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1) < 1e-6);
  assert.equal(atFL.length, 0,
    `FLには床断面線（太線）が別に描かれるため、見えがかりの水平線は出さない（実際:${atFL.length}本）`);
});

test('【明示指示2026-08】emitColumns: 上階のFL（層のfloorZMm）にも見えがかりの水平線を描かない', () => {
  const cut = { ...makeCut(), baseFloorZ: 0, zRange: { loZ: 0, hiZ: 5400 },
    layers: [{ floorZMm: 0 }, { floorZMm: 3000 }] };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [
      { kind: 'wall', z0: 0, z1: 2400, distMm: 58, layerRole: 'self' },
      { kind: 'open', z0: 2400, z1: 3000 },
      { kind: 'wall', z0: 3000, z1: 5400, distMm: 58, layerRole: 'above' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 5400 });
  const at2FL = prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -3000) < 1e-6);
  assert.equal(at2FL.length, 0, `2FLにも見えがかりの水平線は出さない（実際:${at2FL.length}本）`);
  // 1階天井（2400。FLではない）には距離が変わる境界として線が出る。
  assert.equal(prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -2400) < 1e-6).length, 1);
});

// ユーザー明示指示2026-08（CHの扱い・4点）:
//   1 CHの上が天井裏なら描画不要（断面線のみ）
//   2 CH下の壁までの距離とCH上の壁までの距離が等しければ描画しない（同一面）
//   3 CH下がアキ、上が壁なら見えがかり
//   4 天井から上階FLまでの間にある面も「壁」扱い
// 4は`sectionProbe`側（`resolveSightlineTopZ`が上階FLまで壁を伸ばす）で満たし、その結果
// 1・2は本ファイルの一般規則（距離が変わるところにだけ描く）から自動的に従う。3は下記。
test('【明示指示2026-08・点3】emitColumns: CH下がアキ・上が壁なら、その境界に見えがかり線を描く', () => {
  const cut = { ...makeCut(), baseFloorZ: -1000, zRange: { loZ: -1000, hiZ: 4000 } };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [
      { kind: 'open', z0: 0, z1: 2400 },
      { kind: 'wall', z0: 2400, z1: 3600, distMm: 900, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 4000 });
  const atCH = prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -2400) < 1e-6);
  assert.equal(atCH.length, 1, `アキ→壁の境界には見えがかり線が1本出るはず（実際:${atCH.length}本）`);
  assert.equal(atCH[0].weight, 'medium', 'その切断で最も手前の面なので中線');
});

test('【明示指示2026-08・点1,2】emitColumns: CHの上下が同じ距離の壁（＝天井裏へ続く同一面）なら描かない', () => {
  const cut = { ...makeCut(), baseFloorZ: -1000, zRange: { loZ: -1000, hiZ: 4000 } };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [
      { kind: 'wall', z0: 0, z1: 2400, distMm: 900, layerRole: 'self' },
      { kind: 'wall', z0: 2400, z1: 3600, distMm: 900, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 4000 });
  assert.equal(prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -2400) < 1e-6).length, 0,
    'CHの上下が同一面なら線は無い（天井断面線のみ）');
});

test('【明示指示2026-08】emitColumns: CH（帯の天井）にも見えがかりの水平線を描かない', () => {
  const cut = { ...makeCut(), baseFloorZ: -1000, zRange: { loZ: -1000, hiZ: 2400 } };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 58, layerRole: 'self' }] },
  ];
  assert.equal(emitColumns(columns, cut, { ceilZ: 2400 })
    .filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -2400) < 1e-6).length, 0,
  'CHには天井断面線（太線）が別に描かれるため、見えがかりの水平線は出さない');
  // 天井がもっと上にあれば、同じ壁の上端は「距離が変わるところ」として描かれる（対照）。
  assert.equal(emitColumns(columns, cut, { ceilZ: 3000 })
    .filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -2400) < 1e-6).length, 1);
});

test('【明示指示2026-08】emitColumns: 距離が変わらない境界には水平線を描かない', () => {
  const cut = { ...makeCut(), baseFloorZ: -1000, zRange: { loZ: -1000, hiZ: 2400 } };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [
      { kind: 'wall', z0: 0, z1: 1200, distMm: 58, layerRole: 'self' },
      { kind: 'wall', z0: 1200, z1: 2400, distMm: 58, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  assert.equal(prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -1200) < 1e-6).length, 0,
    '同じ距離が続く境界は1枚の連続面なので線は無い');
});

test('【明示指示2026-08】emitColumns: 距離が変わる境界には線を1本だけ描き、線種は手前の面が決める', () => {
  const cut = { ...makeCut(), baseFloorZ: -1000, zRange: { loZ: -1000, hiZ: 2400 } };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [
      { kind: 'wall', z0: 0, z1: 1200, distMm: 58, layerRole: 'self' },
      { kind: 'wall', z0: 1200, z1: 2400, distMm: 3000, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  const atBoundary = prims.filter(p => p.y1 === p.y2 && Math.abs(p.y1 - -1200) < 1e-6);
  assert.equal(atBoundary.length, 1, `境界の水平線は1本だけのはず（実際:${atBoundary.length}本）`);
  assert.equal(atBoundary[0].weight, 'medium', '手前(d=58)の面の輪郭なので直近＝中線');
});

test('【明示指示2026-08】emitColumns: 手前に切断壁がある境界には見えがかりの凹み縦線を出さない（断面の縁と二重になる）', () => {
  const cut = makeCut();
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 1000, layerRole: 'self' }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'cut', z0: 0, z1: 2400, wall: { id: 'w1' } }] },
  ];
  const prims = emitColumns(columns, cut);
  const atBoundary = prims.filter(p => p.x1 === 500 && p.x2 === 500);
  assert.equal(atBoundary.length, 1, `境界の縦線は切断壁の断面縁1本だけのはず（実際:${atBoundary.length}本）`);
  assert.equal(atBoundary[0].weight, 'thick', 'その1本は断面＝太線');
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
  // アキ標記は矩形＋「ア キ」＋バツ2本（移行の項目3で appendGapMark から移設）。
  // 本テストの対象はバツの線種なので、線プリミティブだけを見る。
  const prims = emitOpenGapMarks(columns, cut).filter(p => p.type === 'line');
  assert.equal(prims.length, 2, 'X=対角線2本のはず');
  for (const p of prims) assert.equal(p.dash, 'center');
});

test('【WP-E2・線種テーブル】emitOpenGapMarks: 床断面より下のアキXはdash:dashed', () => {
  const cut = makeCut({ baseFloorZ: 500 });
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'open', z0: 0, z1: 400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut).filter(p => p.type === 'line');
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
  assert.equal(prims.filter(p => p.type === 'line').length, 2,
    '連結成分が1つなら対角線2本(=1組のX)のはず（実際:' + prims.length + '本）');
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
  assert.equal(prims.filter(p => p.type === 'line').length, 4,
    'z範囲が重ならなければ連結されず、2組のX(4本)のはず');
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
  assert.equal(prims.filter(p => p.type === 'line').length, 2,
    'wall帯自体はアキ扱いにならないため、open帯単独の1組(2本)のみのはず');
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

// ---- ユーザー実機指摘2026-08「6」D2: 階段断面プロファイルとの取り合い ----
test('【実機指摘】joinToStairProfile: 1F天井断面線を階段断面との交点まで伸ばし、2FLから床線を張り出す', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 3000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  // 階段断面: 左端(x=500)で2FL(3000)、右へ下って(x=2500)で踊り場(1500)。z2400はx=1000で横切る。
  const profile = { type: 'polyline', weight: 'thick',
    points: [[500, -3000], [2500, -1500]] };
  const ceiling = { type: 'line', x1: -285, y1: -2400, x2: 0, y2: -2400, weight: 'medium' };
  const out = joinToStairProfile([ceiling], [profile], cut,
    { ceilLowAbs: 2400, floorHeight: 3000, drawLo: -285, drawHi: 3000 });

  const ceil2 = out.find(p => p.type === 'line' && Math.abs(-p.y1 - 2400) < 1e-6);
  assert.ok(ceil2);
  assert.ok(Math.abs(Math.max(ceil2.x1, ceil2.x2) - 1300) < 1e-6,
    `1F天井断面線は階段断面との交点(x=1300)まで伸びるはず（実際:${Math.max(ceil2.x1, ceil2.x2)}）`);

  const slab = out.find(p => p.type === 'line' && Math.abs(-p.y1 - 3000) < 1e-6);
  assert.ok(slab, '2FLの床断面線が張り出すはず');
  const xs = [slab.x1, slab.x2].sort((a, b) => a - b);
  assert.deepEqual(xs, [-285, 500], '階段の上り切り(x=500)から近い側の端(-285)へ張り出すはず');
});

test('【実機指摘】clipStairDetailInSlabBand: 下ささらだけを帯で切り、上ささらは残す', () => {
  // ささらの見えがかりは上端・下端の2本1組。z1000→z4000へ上がり、天井2400〜床3000の帯を通過する。
  const lower = { type: 'polyline', weight: 'thin', points: [[0, -1000], [3000, -4000]] };
  const upper = { type: 'polyline', weight: 'thin', points: [[0, -1300], [3000, -4300]] }; // 300上
  const profile = { type: 'polyline', weight: 'thick', points: [[0, -1000], [3000, -4000]] };
  const out = clipStairDetailInSlabBand([lower, upper, profile], 2400, 3000);

  assert.ok(out.includes(profile), 'CUT(太線)の断面プロファイルは対象外で素通しのはず');
  assert.ok(out.includes(upper), '上ささらは見えるのでそのまま残るはず');
  assert.ok(!out.includes(lower), '下ささらは帯で切られるはず');
  const parts = out.filter(p => p.weight === 'thin' && p !== upper);
  assert.equal(parts.length, 2, '下ささらは帯の下側・上側の2本に分かれるはず');
  const zsOf = p => p.points.map(([, y]) => -y);
  assert.ok(parts.some(p => Math.max(...zsOf(p)) <= 2400 + 1e-6), '帯より下の区間が残るはず');
  assert.ok(parts.some(p => Math.min(...zsOf(p)) >= 3000 - 1e-6), '帯より上の区間が残るはず');
});

test('【失敗系・実機指摘】clipStairDetailInSlabBand: 帯に掛からない・帯が退化していれば素通し', () => {
  const below = { type: 'polyline', weight: 'thin', points: [[0, -100], [1000, -2000]] };
  assert.deepEqual(clipStairDetailInSlabBand([below], 2400, 3000), [below]);
  assert.deepEqual(clipStairDetailInSlabBand([below], 3000, 3000), [below]);
});

test('【失敗系・実機指摘】joinToStairProfile: 階段断面が無ければ何も変えない', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 3000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const ceiling = { type: 'line', x1: -285, y1: -2400, x2: 0, y2: -2400, weight: 'medium' };
  const out = joinToStairProfile([ceiling], [], cut,
    { ceilLowAbs: 2400, floorHeight: 3000, drawLo: -285, drawHi: 3000 });
  assert.deepEqual(out, [ceiling]);
});

// ---- ユーザー実機指摘2026-08「6」C（第2弾）----
test('【実機指摘】emitColumns: 床スラブの上に直に載る腰壁との境界線は描かない（同面のため）', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 2000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const knee = [
    { kind: 'slab', z0: 2400, z1: 3000 },
    { kind: 'wall', z0: 3000, z1: 3800, distMm: 2500, layerRole: 'above', isKneeDrop: true },
  ];
  const far = [
    { kind: 'slab', z0: 2400, z1: 3000 },
    { kind: 'wall', z0: 3000, z1: 5400, distMm: 6000, layerRole: 'above' }, // 腰壁ではない
  ];
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: knee },
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000, bands: far },
  ];
  const at3000 = emitColumns(columns, cut, { ceilZ: 5400 })
    .filter(p => Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(p.y1 - (-3000)) < 1e-6);
  const xs = at3000.flatMap(p => [p.x1, p.x2]);
  assert.ok(xs.length > 0, '腰壁でない側(x=1000..2000)のスラブ小口の線は残るはず');
  assert.equal(Math.min(...xs), 1000, '腰壁の載る区間(x=0..1000)には2FLの線を出さないはず');
});

test('【失敗系・実機指摘】emitColumns: スラブが無ければ腰壁の下端線は従来どおり描く', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 1000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  const columns = [{ x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
    { kind: 'open', z0: 0, z1: 3000 },
    { kind: 'wall', z0: 3000, z1: 3800, distMm: 2500, layerRole: 'above', isKneeDrop: true },
  ] }];
  const at3000 = emitColumns(columns, cut, { ceilZ: 5400 })
    .filter(p => Math.abs(p.y1 - p.y2) < 1e-6 && Math.abs(p.y1 - (-3000)) < 1e-6);
  assert.ok(at3000.length > 0, 'スラブに載っていない腰壁の下端は同面判定にならず描くはず');
});

test('【実機指摘】emitOpenGapMarks: バツは腰壁と交差する区間をクリップする（腰壁でない壁では切らない）', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 2000 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 4000 }, baseFloorZ: 0 };
  const makeCols = kneeFlag => ([
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [
      { kind: 'open', z0: 0, z1: 4000 }] },
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000, bands: [
      { kind: 'open', z0: 0, z1: 1000 },
      { kind: 'wall', z0: 1000, z1: 2000, distMm: 500, layerRole: 'above', isKneeDrop: kneeFlag },
      { kind: 'open', z0: 2000, z1: 4000 }] },
  ]);
  // アキ標記は「ア キ」テキストも積むため、バツの本数は線プリミティブで数える。
  const withKnee = emitOpenGapMarks(makeCols(true), cut).filter(p => p.type === 'line');
  const withPlain = emitOpenGapMarks(makeCols(false), cut).filter(p => p.type === 'line');
  assert.equal(withPlain.length, 2, '腰壁でなければ従来どおり1組のX(2本)のはず');
  assert.ok(withKnee.length > 2, '腰壁と交差する区間で切られ、線分が増えるはず');
  for (const p of withKnee) {
    const zs = [-p.y1, -p.y2].sort((a, b) => a - b);
    const xs = [p.x1, p.x2].sort((a, b) => a - b);
    const insideKnee = xs[0] > 1000 - 1e-6 && zs[0] > 1000 + 1e-6 && zs[1] < 2000 - 1e-6;
    assert.ok(!insideKnee, `腰壁の内側に線分が残っている: x${xs} z${zs}`);
  }
});

test('【実機指摘】dashHorizontalsBehindStair: 階段の見付け範囲に入る水平線は破線へ分割される', () => {
  const line = { type: 'line', x1: 0, y1: -2400, x2: 2885, y2: -2400, weight: 'medium' };
  const rects = [{ xLo: 1492.5, xHi: 2885, zLo: 1500, zHi: 3000 }]; // 復路の見付け矩形
  const out = dashHorizontalsBehindStair([line], rects);
  assert.equal(out.length, 2, '実線＋破線の2本に分かれるはず');
  const solid = out.find(p => !p.dash), dashed = out.find(p => p.dash === 'dashed');
  assert.ok(solid && dashed);
  assert.deepEqual([solid.x1, solid.x2], [0, 1492.5], '復路のささらまでは実線');
  assert.deepEqual([dashed.x1, dashed.x2], [1492.5, 2885], 'その先は破線で右端まで');
});

test('【失敗系・実機指摘】dashHorizontalsBehindStair: 矩形のz端にちょうど載る線・対象外の線は分割しない', () => {
  const rects = [{ xLo: 0, xHi: 1000, zLo: 1500, zHi: 3000 }];
  const onEdge = { type: 'line', x1: 0, y1: -3000, x2: 2000, y2: -3000, weight: 'medium' };
  const thick  = { type: 'line', x1: 0, y1: -2400, x2: 2000, y2: -2400, weight: 'thick' };
  const already = { type: 'line', x1: 0, y1: -2400, x2: 2000, y2: -2400, weight: 'medium', dash: 'dashed' };
  assert.deepEqual(dashHorizontalsBehindStair([onEdge, thick, already], rects), [onEdge, thick, already]);
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

// ---- ユーザー実機指摘2026-08「6」C「バツの４点は、空き面の最も大きい対角を頂点とする」 ----
// 「2Fのアキ・バツ左下点は、左側壁断面と腰壁上端の交点へ移動」＝L字のアキで、外接矩形の隅
// （腰壁の中）ではなく**その端での実際のアキの隅**を頂点にする。
test('【実機指摘】emitOpenGapMarks: L字のアキではバツの頂点が外接矩形の隅ではなく実際の隅になる', () => {
  const cut = { line: { isVertical: true, axisValue: 0, lo: 0, hi: 2885 }, dirSign: 1,
    zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0 };
  // 左列は腰壁(3000..3800)に食われてアキが3800から、右列は3000からアキ。
  const columns = [
    { x0: 0, x1: 1442.5, worldLo: 0, worldHi: 1442.5, bands: [
      { kind: 'wall', z0: 3000, z1: 3800, distMm: 2500, layerRole: 'above', isKneeDrop: true },
      { kind: 'open', z0: 3800, z1: 5400 }] },
    { x0: 1442.5, x1: 2885, worldLo: 1442.5, worldHi: 2885, bands: [
      { kind: 'open', z0: 3000, z1: 5400 }] },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  const ends = prims.map(p => [[p.x1, -p.y1], [p.x2, -p.y2]]);
  const has = (x, z) => ends.some(e => e.some(([px, pz]) => Math.abs(px - x) < 1e-6 && Math.abs(pz - z) < 1e-6));
  assert.ok(has(0, 3800), '左下点は腰壁の天端(z=3800)のはず（外接矩形の3000ではない）');
  assert.ok(has(0, 5400), '左上点は天井(z=5400)');
  assert.ok(has(2885, 3000), '右下点は右列の実際のアキ下端(z=3000)');
  assert.ok(has(2885, 5400), '右上点は天井(z=5400)');
  assert.ok(!has(0, 3000), '外接矩形の左下隅(0,3000)は腰壁の中なので頂点にならないはず');
});

// ---- ユーザー実機指摘2026-08「6」C（撤回・再指示）: 破線範囲は基準線の左右では決まらない ----
// 旧実装は「内側のささらより右（z全域）」を対角線ごとに割り当てていた（裁定「(あ)」）が、
// ユーザーが撤回し「想定したバツに対して描画面+所定距離までレイキャストして、隠れた部分を
// 破線にする」と再指示——渡す矩形は手前に実体がある範囲そのもの（stairOccluderRects）になり、
// 対角線ごとの割り当ては無くなった。
test('【実機指摘・撤回後】splitGapMarksByStair: 矩形は対角線を選ばず、両方に同じように効く', () => {
  const low  = { type: 'line', x1: 0, y1: 0, x2: 1000, y2: -1000, weight: 'thin', dash: 'center' };
  const high = { type: 'line', x1: 0, y1: -1000, x2: 1000, y2: 0, weight: 'thin', dash: 'center' };
  const rects = [{ xLo: 400, xHi: 1000, zLo: 0, zHi: 1000 }];
  const out = splitGapMarksByStair([low, high], rects);
  assert.ok(!out.includes(low) && !out.includes(high), '両方とも分割されるはず');
  assert.equal(out.filter(p => p.dash === 'dashed').length, 2, '各対角線に破線区間が1つずつのはず');
  for (const p of out.filter(q => q.dash === 'dashed')) {
    assert.ok(Math.min(p.x1, p.x2) >= 400 - 1e-6, `破線は矩形の中だけのはず（実際:${p.x1}..${p.x2}）`);
  }
});

test('【実機指摘】splitGapMarksByStair: startsLow未指定の矩形（踊り場の帯）は両方の対角線に効く', () => {
  const low  = { type: 'line', x1: 0, y1: 0, x2: 1000, y2: -1000, weight: 'thin', dash: 'center' };
  const high = { type: 'line', x1: 0, y1: -1000, x2: 1000, y2: 0, weight: 'thin', dash: 'center' };
  const rects = [{ xLo: -1e9, xHi: 1e9, zLo: 400, zHi: 600 }]; // 踊り場桁枠の帯に相当
  const out = splitGapMarksByStair([low, high], rects);
  assert.ok(!out.includes(low) && !out.includes(high), '両方とも分割されるはず');
  assert.equal(out.filter(p => p.dash === 'dashed').length, 2, '各対角線に破線区間が1つずつのはず');
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

test('【実機指摘・6D(b)】emitColumns: 2FL床断面線は袖壁の外側面から外へ張り出し、袖壁の天端はCUTで出る', () => {
  const prims = emitColumns(kneeAtOpenEndColumns(), kneeCut, { ceilZ: 5400, openEndLo: true });
  const xs = horizAt(prims, 3000).flatMap(p => [p.x1, p.x2]);
  // ユーザー実機指摘2026-08「6」D1「2F腰壁断面が2FLまで下りたあと、左を向いて2FL床断面線はりだし」:
  // この線はスラブ自身から描く（遠い壁の下端縁に頼らない——その壁は帯の部屋の外だと探索対象外）。
  assert.equal(Math.min(...xs), -285, '2FL床断面線は外側の列まで張り出すはず');
  assert.equal(Math.max(...xs), -57.5, '袖壁の外側面(x=-57.5)から外側へ向かう線のはず');
  // 袖壁の天端(3800)はcut帯から壁ごとに1本、全幅で出る（トリムの対象外）。
  const top = horizAt(prims, 3800);
  assert.equal(top.length, 1, '天端は壁ごとに1本のはず');
  assert.equal(top[0].weight, 'thick', '天端は断面＝CUT(太線)のはず');
  assert.deepEqual([top[0].x1, top[0].x2].sort((a, b) => a - b), [-57.5, 57.5], '天端は壁の全幅のはず');
});

test('【失敗系・実機指摘・6D】emitColumns: 袖壁の天端より上を通る線（z5400）はトリムされない', () => {
  // ceilZは5400より上に置く——z5400ちょうどを帯の天井にすると「CHの見えがかりは描画しない」
  // （ユーザー明示指示2026-08）で線が消え、本テストの主題（切断壁によるトリム）を検証できない。
  const prims = emitColumns(kneeAtOpenEndColumns(), kneeCut, { ceilZ: 6000, openEndLo: true });
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


// ---- 腰壁の上の縦線（ユーザー明示指示2026-08その17。再発した不具合の根本対策） ----
// 「「6」D1・B: 腰壁上のエッジは不要」。腰壁(cut)に遮られてこの列だけ下端が持ち上がった
// 見えがかり壁の帯は、**同じ壁の続き**であって「そこで壁が終わった」わけではない。
// 側縁の縦線を描くと、腰壁の上に壁の切れ目が無いのに縦線が出る（実機症状: 左CL上のz3800..5400）。
// 水平線側は`trimmedByCutWall`で既に抑止されており、縦線だけが取り残されていた。
test('【明示指示】emitColumns: 手前の腰壁で分割された見えがかり壁の帯には側縁の縦線を描かない', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const columns = [
    // 隣接列: 腰壁が無く、上部は別の見え方（slab）になっている＝厳密一致では壁が見つからない
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 2250, layerRole: 'self' },
              { kind: 'slab', z0: 2400, z1: 3000 }, { kind: 'cut', z0: 3000, z1: 3800 },
              { kind: 'slab', z0: 3800, z1: 5400 }] },
    // 腰壁の列: 腰壁(cut z3000..3800)に切られて見えがかり壁がz3800..5400へ分割されている
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 3000, distMm: 2250, layerRole: 'self' },
              { kind: 'cut', z0: 3000, z1: 3800 },
              { kind: 'wall', z0: 3800, z1: 5400, distMm: 2250, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut);
  const kneeTopEdges = prims.filter(p => p.x1 === p.x2 &&
    Math.abs(Math.max(p.y1, p.y2) - (-3800)) < 1e-6 && Math.abs(Math.min(p.y1, p.y2) - (-5400)) < 1e-6);
  assert.equal(kneeTopEdges.length, 0,
    `腰壁の上(z3800..5400)には側縁の縦線を描かないはず（実際:${JSON.stringify(kneeTopEdges)}）`);
});

test('【失敗系】emitColumns: 手前に腰壁が無ければ、壁が終わる列境界の縦線は従来どおり描く', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'open', z0: 0, z1: 5400 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 3800, z1: 5400, distMm: 2250, layerRole: 'self' }] },
  ];
  const prims = emitColumns(columns, cut);
  const edges = prims.filter(p => p.x1 === p.x2 &&
    Math.abs(Math.max(p.y1, p.y2) - (-3800)) < 1e-6 && Math.abs(Math.min(p.y1, p.y2) - (-5400)) < 1e-6);
  assert.ok(edges.length > 0, '腰壁(cut)が無い列では、壁が終わる境界の縦線は従来どおり出るはず');
});


// ---- 隣接列の壁が途中までしか無い境界の縦線（ユーザー実機指摘2026-08その17「6」D2） ----
// 「2階X2通りの壁を見ているので、3500左CLの2階に壁エッジ」。手前列は上が吹抜けのため
// 見えがかり壁がz0..5400まで続くのに対し、隣接列は1F天井までの0..2400しか壁が無い。
// その差分(2400..5400)は壁面の実際の終端なので縦線が要る。旧実装は「重なる壁帯が1つでもあれば
// 連続」と band 全体を一括判定していたため、側縁が丸ごと消えていた。
test('【実機指摘】emitColumns: 隣接列の壁が途中までのとき、はみ出したz区間だけに側縁の縦線を描く', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const columns = [
    // 上が吹抜けで壁が全高続く列
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 5400, distMm: 750, layerRole: 'self' }] },
    // 隣接列: 同じ壁面(距離750)だが1F天井までしか無い
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 750, layerRole: 'self' },
              { kind: 'slab', z0: 2400, z1: 5400 }] },
  ];
  const verts = emitColumns(columns, cut).filter(p => p.x1 === p.x2 && p.x1 === 500)
    .map(p => [Math.min(-p.y1, -p.y2), Math.max(-p.y1, -p.y2)]);
  assert.deepEqual(verts, [[2400, 5400]],
    `境界x=500にはz2400..5400の縦線が1本だけ出るはず（実際:${JSON.stringify(verts)}）`);
});

test('【失敗系】emitColumns: 隣接列の壁が同じz範囲を覆っていれば境界に縦線は出ない', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const bands = [{ kind: 'wall', z0: 0, z1: 5400, distMm: 750, layerRole: 'self' }];
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands },
  ];
  const verts = emitColumns(columns, cut).filter(p => p.x1 === p.x2 && p.x1 === 500);
  assert.equal(verts.length, 0, '壁面が連続する境界には縦線を描かないはず');
});

test('【実機指摘】emitColumns: 隣接列の壁が別層のものへ入れ替わっただけの境界には縦線を描かない', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const columns = [
    // 上階側にだけ出隅の角の塊が見える列（自階の壁は1F天井で切れ、その上は床スラブ帯）
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 750, layerRole: 'self' },
              { kind: 'slab', z0: 2400, z1: 3000 },
              { kind: 'wall', z0: 3000, z1: 5400, distMm: 750, layerRole: 'above' }] },
    // 同じ面が自階の壁として全高見えている列
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 5400, distMm: 750, layerRole: 'self' }] },
  ];
  const verts = emitColumns(columns, cut).filter(p => p.x1 === p.x2 && p.x1 === 500)
    .map(p => [Math.min(-p.y1, -p.y2), Math.max(-p.y1, -p.y2)]);
  assert.deepEqual(verts, [[2400, 3000]],
    `2階側(z3000..5400)は層が入れ替わっただけなので縦線を描かず、自階の壁が実際に途切れる`
    + `スラブ帯(z2400..3000)だけが縦線になるはず（実際:${JSON.stringify(verts)}）`);
});


// ---- セル境界は描画対象としない（ユーザー明示指示2026-08その18） ----
// 上階のセルが部屋⇄吹抜けで切り替わる位置では、同じ壁面のz上限（天井キャップ）だけが変わる。
// キャップの切り替わりはセル境界＝CL上に必ず来るため、そこに縦線を出すと一点鎖線に重なる。
// 壁が途切れたわけではないので描かない。
const wallFace = (axisCL, axisValue) => ({ axisCL, axisValue });

test('【明示指示】emitColumns: 同じ壁面のキャップ差（上階セルの切り替わり）では縦線を描かない', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const cl = { id: 'clA' };
  const face = wallFace(cl, -2942.5);
  const columns = [
    // 上が吹抜け＝1階壁が2階天井まで見えている列
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 5400, distMm: 750, layerRole: 'self', wall: face }] },
    // 上が部屋＝同じ壁面が1階天井で切られている列
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 750, layerRole: 'self', wall: face },
              { kind: 'slab', z0: 2400, z1: 5400 }] },
  ];
  const verts = emitColumns(columns, cut).filter(p => p.x1 === p.x2 && p.x1 === 500);
  assert.equal(verts.length, 0,
    `同じ壁面のキャップ差には縦線を描かないはず（実際:${JSON.stringify(verts)}）`);
});

test('【失敗系】emitColumns: 別の壁面なら、はみ出したz区間に従来どおり縦線を描く', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const clA = { id: 'clA' }, clB = { id: 'clB' };
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 5400, distMm: 750, layerRole: 'self', wall: wallFace(clA, -2942.5) }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 750, layerRole: 'self', wall: wallFace(clB, -2942.5) },
              { kind: 'slab', z0: 2400, z1: 5400 }] },
  ];
  const verts = emitColumns(columns, cut).filter(p => p.x1 === p.x2 && p.x1 === 500)
    .map(p => [Math.min(-p.y1, -p.y2), Math.max(-p.y1, -p.y2)]);
  assert.deepEqual(verts, [[2400, 5400]], '別の壁面ならはみ出した区間に縦線が出るはず');
});

test('【失敗系】emitColumns: 腰壁で実際に高さが制限された帯（isKneeDrop）はキャップ差扱いにしない', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const cl = { id: 'clA' };
  const face = wallFace(cl, -2942.5);
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500,
      bands: [{ kind: 'wall', z0: 0, z1: 5400, distMm: 750, layerRole: 'self', wall: face }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 800, distMm: 750, layerRole: 'self', wall: face, isKneeDrop: true },
              { kind: 'open', z0: 800, z1: 5400 }] },
  ];
  const verts = emitColumns(columns, cut).filter(p => p.x1 === p.x2 && p.x1 === 500)
    .map(p => [Math.min(-p.y1, -p.y2), Math.max(-p.y1, -p.y2)]);
  assert.deepEqual(verts, [[800, 5400]], '腰壁の実体の高さ差には縦線が出るはず');
});

// ================================================================
// 新仕様2026-08「腰壁の天端」: 天端が露出した帯（isKneeDrop）の上端の下へ、見付ぶんの
// 細線を1本足す。見付は実厚ではなく作図値 KNEE_CAP_FACE_MM（elevationStyle.js）。
// ================================================================

const capY = topZ => -(topZ - KNEE_CAP_FACE_MM); // zToY(z) = -z

test('emitColumns: cutAlongの腰壁（天端が天井より下）は天端の下に見付ぶんの細線を足す', () => {
  const cut = makeCut();
  const columns = [{ x0: 0, x1: 500, worldLo: 0, worldHi: 500,
    bands: [{ kind: 'cutAlong', z0: 0, z1: 800, isKneeDrop: true }] }];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  const top = prims.find(p => p.y1 === -800 && p.y1 === p.y2);
  const cap = prims.find(p => p.y1 === capY(800) && p.y1 === p.y2);
  assert.ok(top, '天端そのもの（CUT水平線）があるはず');
  assert.equal(top.weight, 'thick');
  assert.ok(cap, `天端の${KNEE_CAP_FACE_MM}mm下に細線があるはず`);
  assert.equal(cap.weight, 'thin');
  assert.deepEqual([cap.x1, cap.x2], [0, 500], '天端と同じx範囲のはず');
});

test('【失敗系】emitColumns: 天井まで立つcutAlong（腰壁でない）には天端の細線を足さない', () => {
  const cut = makeCut();
  const columns = [{ x0: 0, x1: 500, worldLo: 0, worldHi: 500,
    bands: [{ kind: 'cutAlong', z0: 0, z1: 2400 }] }];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  assert.equal(prims.filter(p => p.weight === 'thin' && p.y1 === p.y2).length, 0,
    '天端が無い壁には細線を足さないはず');
});

test('emitColumns: 見えがかり（wall）の腰壁も天端の下に細線を足す', () => {
  const cut = makeCut();
  const columns = [{ x0: 0, x1: 500, worldLo: 0, worldHi: 500,
    bands: [{ kind: 'wall', z0: 0, z1: 800, distMm: 1000, layerRole: 'self', isKneeDrop: true }] }];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  const cap = prims.find(p => p.y1 === capY(800) && p.y1 === p.y2 && p.weight === 'thin');
  assert.ok(cap, '見えがかりの腰壁にも天端の細線が出るはず');
});

test('【失敗系】emitColumns: 天端が見付より低い退化した腰壁には細線を足さない（床線と重なる）', () => {
  const cut = makeCut();
  const columns = [{ x0: 0, x1: 500, worldLo: 0, worldHi: 500,
    bands: [{ kind: 'cutAlong', z0: 0, z1: KNEE_CAP_FACE_MM, isKneeDrop: true }] }];
  const prims = emitColumns(columns, cut, { ceilZ: 2400 });
  assert.equal(prims.filter(p => p.y1 === 0 && p.y2 === 0 && p.weight === 'thin').length, 0,
    '床(z=0)に重なる細線は出さないはず');
});

// ================================================================
// 腰壁の端部抑え（仕様2026-08「腰壁の天端・端部」）
// 面図側（elevationFigure.js の kneeCapMarksOnFace）から移し替えた規則。
// 天端＝壁の上端から下への帯。展開図では見付を KNEE_CAP_FACE_MM（作図値）として
// 上端を中線・下端を細線で描き、**壁がそこで終わる端**にだけ端面の細線を足す。
// ================================================================

// 見えがかりの腰壁（isKneeDrop・天端が天井より下）を真ん中の列に置き、両隣を指定できる最小構成。
function kneeCapColumns({ leftBands = [], rightBands = [] } = {}) {
  return [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: leftBands },
    { x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
      bands: [{ kind: 'wall', z0: 0, z1: 900, distMm: 500, layerRole: 'self', isKneeDrop: true }] },
    { x0: 3000, x1: 4000, worldLo: 3000, worldHi: 4000, bands: rightBands },
  ];
}

test('【移行・腰壁の端部】emitColumns: 壁がそこで終わる端に端面の細線（内側KNEE_CAP_FACE_MM）を描く', () => {
  const prims = emitColumns(kneeCapColumns(), makeCut(), { ceilZ: 2400 });
  const verticals = prims.filter(p => p.x1 === p.x2 && p.y1 === 0 && p.y2 === -900);
  const xs = [...new Set(verticals.map(p => p.x1))].sort((a, b) => a - b);
  assert.deepEqual(xs, [1000, 1000 + KNEE_CAP_FACE_MM, 3000 - KNEE_CAP_FACE_MM, 3000],
    `両端の中線＋内側の細線で計4本のはず（実際:${JSON.stringify(verticals)}）`);
  const inner = verticals.filter(p => p.x1 === 1000 + KNEE_CAP_FACE_MM || p.x1 === 3000 - KNEE_CAP_FACE_MM);
  assert.ok(inner.every(p => p.weight === 'thin'), '内側の端面は細線のはず');
});

test('【失敗系・移行】emitColumns: 同じ壁面が隣の列へ続く端には端面の細線を描かない', () => {
  // 隣接列に同じ距離・同じ層の壁が続く＝連続する壁面（凹んでいない）。
  const cont = [{ kind: 'wall', z0: 0, z1: 900, distMm: 500, layerRole: 'self', isKneeDrop: true }];
  const prims = emitColumns(kneeCapColumns({ rightBands: cont }), makeCut(), { ceilZ: 2400 });
  const xs = prims.filter(p => p.x1 === p.x2 && p.y1 === 0 && p.y2 === -900).map(p => p.x1);
  assert.ok(!xs.includes(3000 - KNEE_CAP_FACE_MM), `続く側(x=3000)に端面が出てはいけない（実際:${xs}）`);
  assert.ok(xs.includes(1000 + KNEE_CAP_FACE_MM), '自由端(x=1000)には端面が出るはず');
});

test('【失敗系・移行】emitColumns: 描画範囲の端（隣接列が無い）には端面の細線を描かない', () => {
  // 面の端は直交壁との取り合いで、腰壁は相手の壁表面まで行って終わる——その位置の縦線は
  // 端部処理（buildFaceFigure の端の縦線）が描くため二重にしない。
  const columns = [{ x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
    bands: [{ kind: 'wall', z0: 0, z1: 900, distMm: 500, layerRole: 'self', isKneeDrop: true }] }];
  const prims = emitColumns(columns, makeCut(), { ceilZ: 2400 });
  const xs = prims.filter(p => p.x1 === p.x2).map(p => p.x1);
  assert.ok(!xs.includes(1000 + KNEE_CAP_FACE_MM) && !xs.includes(3000 - KNEE_CAP_FACE_MM),
    `描画範囲の端に端面が出てはいけない（実際:${xs}）`);
});

test('【失敗系・移行】emitColumns: 天端の見付に満たない低い腰壁には端面の細線を描かない', () => {
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] },
    { x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
      bands: [{ kind: 'wall', z0: 0, z1: KNEE_CAP_FACE_MM - 10, distMm: 500, layerRole: 'self', isKneeDrop: true }] },
    { x0: 3000, x1: 4000, worldLo: 3000, worldHi: 4000, bands: [] },
  ];
  const prims = emitColumns(columns, makeCut(), { ceilZ: 2400 });
  const xs = prims.filter(p => p.x1 === p.x2).map(p => p.x1);
  assert.ok(!xs.includes(1000 + KNEE_CAP_FACE_MM), `退化指定では端面を描かない（実際:${xs}）`);
});

test('【失敗系・移行】emitColumns: 天井まで届く壁（天端が露出していない）には端面の細線を描かない', () => {
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [] },
    { x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 500, layerRole: 'self', isKneeDrop: true }] },
    { x0: 3000, x1: 4000, worldLo: 3000, worldHi: 4000, bands: [] },
  ];
  const prims = emitColumns(columns, makeCut(), { ceilZ: 2400 });
  const xs = prims.filter(p => p.x1 === p.x2).map(p => p.x1);
  assert.ok(!xs.includes(1000 + KNEE_CAP_FACE_MM), `天端が露出していなければ端面は無い（実際:${xs}）`);
});

// ================================================================
// 袖壁・腰壁の断面（旧 elevationFigure.js の partitionCutAtLocal0/Run → appendPartitionCut）
// 面図側は「面の端に厚みthicknessMmの枠を起こす」近似だったが、実体の位置・幅・高さを知って
// いるのはエンジンだけ——袖壁で2断片に分かれた面では、同じ1枚の袖壁を両断片が別々の近似で
// 描いていた。移行後は cut 帯の縁（cutEdgeLo/Hi）＋天端（cutWallTopEdges）＋天端下端
// （kneeCapUnderline）が唯一の表現。
// ================================================================

// 袖壁1枚（軸CLを挟む2つのWallオブジェクト）が中央3列を占める最小構成。
function sleeveColumns({ topZ = 900, axisCL = { id: 'sleeve' } } = {}) {
  const near = { axisCL, axisValue: -57.5 };
  const far = { axisCL, axisValue: 57.5 };
  return [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'open', z0: 0, z1: 2400 }] },
    { x0: 1000, x1: 1057.5, worldLo: 1000, worldHi: 1057.5,
      bands: [{ kind: 'cut', z0: 0, z1: topZ, wall: near, isKneeDrop: topZ < 2400 }] },
    { x0: 1057.5, x1: 1115, worldLo: 1057.5, worldHi: 1115,
      bands: [{ kind: 'cut', z0: 0, z1: topZ, wall: far, isKneeDrop: topZ < 2400 }] },
    { x0: 1115, x1: 2000, worldLo: 1115, worldHi: 2000, bands: [{ kind: 'open', z0: 0, z1: 2400 }] },
  ];
}

test('【移行・袖壁の断面】emitColumns: 袖壁の断面は外縁2本＋天端の水平線になり、内部（軸CL）に縦線を出さない', () => {
  const prims = emitColumns(sleeveColumns(), makeCut(), { ceilZ: 2400 });
  const verts = [...new Set(prims.filter(p => p.x1 === p.x2 && p.weight === 'thick').map(p => p.x1))]
    .sort((a, b) => a - b);
  assert.deepEqual(verts, [1000, 1115],
    `外縁2本だけのはず（軸CL x=1057.5 は1枚の壁の内部。実際:${verts}）`);
  const top = prims.find(p => p.y1 === p.y2 && p.y1 === -900 && p.weight === 'thick');
  assert.ok(top, '天端のCUT水平線があるはず');
  assert.deepEqual([top.x1, top.x2], [1000, 1115], '天端は袖壁の実幅いっぱいに1本だけ引かれるはず');
});

test('【移行・袖壁の断面】emitColumns: 腰壁の袖壁には天端下端の細線が付く', () => {
  const prims = emitColumns(sleeveColumns(), makeCut(), { ceilZ: 2400 });
  const cap = prims.find(p => p.y1 === p.y2 && p.y1 === -(900 - KNEE_CAP_FACE_MM) && p.weight === 'thin');
  assert.ok(cap, `天端下端の細線があるはず（実際:${JSON.stringify(prims.filter(p => p.weight === 'thin'))}）`);
  assert.deepEqual([cap.x1, cap.x2], [1000, 1115], '天端下端も袖壁の実幅ぶん');
});

test('【失敗系・移行】emitColumns: 天井まで届く袖壁には天端も天端下端も描かない', () => {
  const prims = emitColumns(sleeveColumns({ topZ: 2400 }), makeCut(), { ceilZ: 2400 });
  assert.equal(prims.find(p => p.y1 === p.y2 && p.y1 === -2400 && p.weight === 'thick'), undefined,
    '天井と同じ高さで終わる壁の上端は断面の一部ではない（天井線が描く）');
  assert.equal(prims.find(p => p.weight === 'thin' && p.y1 === p.y2), undefined,
    '天端が無い袖壁には細線を足さないはず');
});

test('【失敗系・移行】emitColumns: 軸CLが違う（＝別々の）切断壁が接する境界には縦線を描く', () => {
  const columns = sleeveColumns();
  columns[2].bands[0].wall = { axisCL: { id: 'other' }, axisValue: 57.5 };
  const verts = [...new Set(emitColumns(columns, makeCut(), { ceilZ: 2400 })
    .filter(p => p.x1 === p.x2 && p.weight === 'thick').map(p => p.x1))].sort((a, b) => a - b);
  assert.deepEqual(verts, [1000, 1057.5, 1057.5, 1115].filter((v, i, a) => a.indexOf(v) === i),
    `別の壁同士の境界(x=1057.5)には縦線が出るはず（実際:${verts}）`);
});

// ================================================================
// アキの標記（旧 elevationFigure.js の kneeDropGapsOnFace ＋ appendGapMark）
// 面図側は「腰壁・垂れ壁の指定がある区間」しか知らなかったが、実際に抜けているかは他階・
// 遮蔽まで見ないと決まらない。移行後は emitOpenGapMarks が矩形＋バツ＋「ア キ」を出す。
// ================================================================

const gapRect = prims => prims.find(p => p.type === 'rect');
const gapText = prims => prims.find(p => p.type === 'text' && p.text === 'ア キ');
const gapDiagonals = prims => prims.filter(p => p.type === 'line');

test('【移行・アキ】emitOpenGapMarks: 対角2本（一点鎖線）＋「ア キ」を出し、輪郭の矩形は描かない', () => {
  const columns = [{ x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
    bands: [{ kind: 'open', z0: 600, z1: 2000 }] }];
  const prims = emitOpenGapMarks(columns, makeCut({ baseFloorZ: 0 }));
  // 輪郭は必ず周囲の実体（壁の断面・床/天井の断面線）が描くため、矩形を足すと必ず二重になり、
  // 中線が断面（太線）を上書きしてしまう（ユーザー明示指示「矩形をやめて」）。
  assert.equal(gapRect(prims), undefined, 'アキの輪郭の矩形は描かないはず');
  assert.equal(gapDiagonals(prims).length, 2, 'バツは対角2本');
  assert.ok(gapDiagonals(prims).every(p => p.dash === 'center'), '床断面より上のバツは一点鎖線');
  const text = gapText(prims);
  assert.ok(text, '「ア キ」があるはず');
  assert.deepEqual([text.x, text.y], [2000, -1300], 'テキストは抜けの中心');
});

test('【失敗系・移行・アキ】emitOpenGapMarks: 建具の開口を含む成分には矩形・テキストを付けない（バツのみ）', () => {
  const columns = [{ x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
    bands: [{ kind: 'wall', z0: 600, z1: 2000, distMm: 500, openingPassThrough: true }] }];
  const prims = emitOpenGapMarks(columns, makeCut({ baseFloorZ: 0 }));
  assert.equal(gapText(prims), undefined, '建具の姿図が描く場所を「アキ」と書いてはいけない');
  assert.equal(gapDiagonals(prims).length, 2, 'バツ自体は従来どおり出る');
});

test('【失敗系・移行・アキ】emitOpenGapMarks: 床断面より下の抜けには矩形・テキストを付けない', () => {
  const columns = [{ x0: 1000, x1: 3000, worldLo: 1000, worldHi: 3000,
    bands: [{ kind: 'open', z0: 0, z1: 400 }] }];
  const prims = emitOpenGapMarks(columns, makeCut({ baseFloorZ: 500 }));
  assert.equal(gapText(prims), undefined, '床断面より下は「向こう側の断面＝細線の破線」で実線の標記は出さない');
  assert.ok(gapDiagonals(prims).every(p => p.dash === 'dashed'));
});

test('【失敗系・移行・アキ】emitOpenGapMarks: L字（外接矩形と食い違う）成分には「ア キ」を付けない', () => {
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'open', z0: 600, z1: 2000 }] },
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000, bands: [{ kind: 'open', z0: 1200, z1: 2000 }] },
  ];
  const prims = emitOpenGapMarks(columns, makeCut({ baseFloorZ: 0 }));
  assert.equal(gapText(prims), undefined, '外接矩形の中心はアキでない場所（腰壁の上）に落ちるため文字を置かない');
  assert.equal(gapDiagonals(prims).length, 2, 'バツは「空き面の実際の隅」を結ぶ従来どおりの2本');
});

// ================================================================
// 切断壁による帯の分割判定（ユーザー実機指摘: 実機「5」A「1階X2右側に壁エッジ（中線）がない」）
// 「切断壁に切られて下端が持ち上がった帯」＝**帯の下端が切断壁の天端にちょうど一致する**帯。
// 旧実装は「天端が帯の下端以上の切断壁がこの列にあるか」で見ており、切断壁より**下**にある
// 帯まで巻き込んで側縁を消していた。
// ================================================================

test('【実機「5」A】emitColumns: 切断壁より下にある見えがかり帯の側縁は消さない', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const columns = [
    // 手前の列: 1階の壁（z0..2400）だけ。天井より上には何も無い。
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 58, layerRole: 'self', wall: { axisCL: { id: 'A' }, axisValue: 0 } }] },
    // 壁の端の列: 同じ1階の壁に加えて、その**上**に2階の壁の断面（z2400..5400）が立つ。
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 58, layerRole: 'self', wall: { axisCL: { id: 'A' }, axisValue: 0 } },
              { kind: 'cut', z0: 2400, z1: 5400, wall: { axisCL: { id: 'X2' }, axisValue: 57.5 } }] },
    // その先: 1階の壁は無い（抜け）＝x=2000で壁面が終わる。
    { x0: 2000, x1: 3000, worldLo: 2000, worldHi: 3000, bands: [{ kind: 'open', z0: 0, z1: 5400 }] },
  ];
  const edge = emitColumns(columns, cut, { ceilZ: 5400 }).find(p =>
    p.x1 === p.x2 && p.x1 === 2000 && Math.min(-p.y1, -p.y2) === 0 && Math.max(-p.y1, -p.y2) === 2400);
  assert.ok(edge, '1階の壁が終わる位置の側縁が出るはず（上に立つ切断壁は下の帯を遮らない）');
  assert.equal(edge.weight, 'medium', '直近の見えがかりなので中線');
});

test('【失敗系・実機「6」D1】emitColumns: 切断壁の天端で下端が持ち上がった帯の側縁は従来どおり消す', () => {
  const cut = makeCut({ zRange: { loZ: 0, hiZ: 5400 } });
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000,
      bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 2250, layerRole: 'self' },
              { kind: 'slab', z0: 2400, z1: 3000 }, { kind: 'cut', z0: 3000, z1: 3800 },
              { kind: 'slab', z0: 3800, z1: 5400 }] },
    { x0: 1000, x1: 2000, worldLo: 1000, worldHi: 2000,
      bands: [{ kind: 'cut', z0: 3000, z1: 3800 },
              // 下端(3800)が切断壁の天端(3800)にちょうど一致＝腰壁に切られて持ち上がった帯
              { kind: 'wall', z0: 3800, z1: 5400, distMm: 2250, layerRole: 'self' }] },
  ];
  const edges = emitColumns(columns, cut, { ceilZ: 5400 }).filter(p =>
    p.x1 === p.x2 && Math.min(-p.y1, -p.y2) === 3800 && Math.max(-p.y1, -p.y2) === 5400);
  assert.equal(edges.length, 0, `腰壁の上には側縁を描かないはず（実際:${JSON.stringify(edges)}）`);
});

test('【実機「5」】buildColumns: 探査延長で面の外にできる列も、端の区間の天井で打ち切る', () => {
  // ceilProfileは面の範囲(0..2000)しか持たない。壁のない端部の探査延長で作られる x<0 の列が
  // 打ち切られないと、描かれている天井線より上の帯がそこだけ残る。
  const cut = {
    seqNo: 'x', dirSign: 1, viewSign: 1,
    line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000, probeExtendLoMm: 150 },
    layers: [], zRange: { loZ: 0, hiZ: 5400 }, baseFloorZ: 0,
    ceilProfile: [{ loX: 0, hiX: 2000, ceilZ: 2400 }],
  };
  const probeCtxStub = { cellToRoomFor: () => new Map(), chOf: () => 2400, floorZOf: () => 0 };
  const cols = buildColumns(cut, probeCtxStub);
  assert.ok(cols.length > 0, '列が返るはず');
  for (const c of cols) {
    assert.equal(c.ceilZ, 2400,
      `面の外の列(x=${c.x0}..${c.x1})も端の区間の天井(2400)へクランプされるはず（実際:${c.ceilZ}）`);
  }
});
