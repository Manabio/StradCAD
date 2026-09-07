// wallDrawPlan（壁描画の1レンダー分の派生値解決）のテスト。
//
// 仕上げ材の線（面線・妻線・内側線・木口線）は planWallRegion.js が材の領域の合併境界として解き、
// resolveWallLines は壁ごとの `lines`（区別しない1配列）として持ち回る——.jsx はそれを <Line> へ
// 写すだけ。純関数として抽出しただけでは「buildWallDrawPlan が正しい引数を渡すか」は検証されない
// （QA指摘2026-09: 腰壁オーバーレイ・柱の切り欠き・開口を渡し忘れても純関数のテストは緑のまま）。
// 本ファイルは実Wallインスタンス（PlanGraphで生成）を使い、buildWallDrawPlan の呼び出し結果
// そのものを固定する。
//
// 2026-09 領域方式への移行で、旧契約（faceSegments/finSegments/capLoSuppressed/finBoundary…）の
// 検証は同じ幾何を `lines` で言い直した。数値の期待値は移行前と同じ（差分は各テストの注記）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { LodLevel } from '../viewport.js';
import { buildWallDrawPlan, resolveWallLines } from './wallDrawPlan.js';
import { resolveWallRegionLines } from './planWallRegion.js';

const vCL = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const hCL = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
// 部屋壁と同じ寸法（wallBase=90 / wallFinish=12.5 → axisOffset=±57.5。wallCorner.test.js と同じ）。
const wall = (g, axisCL, axisOffset, isVertical, clS, offS, clE, offE, props = {}) =>
  g.addWall(axisCL, axisOffset, isVertical, clS, offS, clE, offE, { isRoomWall: true, wallFinish: 12.5, ...props });

// 同じ直線上（向き・位置）の線分を [lo,hi] の昇順配列で取り出す（旧 faceSegments/finSegments の代わり）。
const at = (lines, vertical, v) => lines
  .filter(l => l.vertical === vertical && Math.abs(l.at - v) < 1e-6)
  .map(l => [l.lo, l.hi]).sort((a, b) => a[0] - b[0]);
// 計画の全壁の線（畳まれた線は代表元の壁が持つので、取り合いの検証は全壁で見る）。
const allLines = (plan) => [...plan.wallLines.values()].flatMap(p => p.lines);
// 位置 v の直線上に、区間 (lo,hi) と重なる線分が在るか——妻線・木口線の有無の判定に使う
// （旧 capLoSuppressed/capHiSuppressed の代わり。同じ位置に直交壁の面線が在りうるので区間で見る）。
const hasLineAt = (lines, vertical, v, lo, hi) => at(lines, vertical, v).some(([a, b]) => a < hi && b > lo);

// ---- 入隅（concave）フィクスチャ: wallJunctionResolve.test.js の実測T字コーナー
// （垂直壁CL x=2500 が水平壁CL y=-5000 へ北側から突き当たる隅）を実Wallで再現する。
function buildConcaveGraph() {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const xAxis = vCL(g, 2500), yAxis = hCL(g, -5000);
  const yFar = hCL(g, -11900), xWestFar = vCL(g, 57.5), xEastFar = vCL(g, 4442.5);

  const vThin  = wall(g, xAxis, -57.5, true, yFar, 0, yAxis, -57.5, { backingDepth: 0, finishSide: -1 });
  const vOwner = wall(g, xAxis, 57.5, true, yFar, 0, yAxis, -57.5, { backingOffset: 0, backingDepth: 90, finishSide: 1 });
  const hLeft  = wall(g, yAxis, -57.5, false, xWestFar, 0, xAxis, -57.5, { backingDepth: 0, finishSide: -1 });
  const hRight = wall(g, yAxis, -57.5, false, xAxis, 57.5, xEastFar, 0, { backingDepth: 0, finishSide: -1 });

  return { g, vThin, vOwner, hLeft, hRight };
}

// ---- 出隅（convex）フィクスチャ: wallCorner.test.js の【実機指摘】closeConvexCorners
// テストと同じ数値（closeConvexCorners適用後の状態を直接組み立てる）。
function buildConvexGraph() {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const x0 = vCL(g, 0), y0 = hCL(g, 0);
  const yFar = hCL(g, -6000), xFar = vCL(g, -6000);
  const v = wall(g, x0, 57.5, true, yFar, 0, y0, 57.5);
  const h = wall(g, y0, 57.5, false, xFar, 0, x0, 57.5);
  return { g, v, h };
}

// ---- T字（貫通）フィクスチャ: wallJunctionResolve.test.js の
// 「faceCutsはAの全材幅…finCutsはAの下地幅になる」合成フィクスチャを実Wallで再現する
// （wallBase=100・wallFinish=12.5 → axisOffset=±75。B=通し壁(下地オーナー)、
// aOwner+aThin=Aの所有権ペア）。面線と内側線が異なる区間で切られることを実Wall経由で固定する。
function buildThroughWallGraph() {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const xAxis = vCL(g, 2500), yAxis = hCL(g, 2000);
  const xWest = vCL(g, 0), xEast = vCL(g, 7000), yTop = hCL(g, 0);

  const b = g.addWall(yAxis, -75, false, xWest, 0, xEast, 0,
    { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 125, finishSide: -1 });
  const aOwner = g.addWall(xAxis, 75, true, yTop, 0, yAxis, -75,
    { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 125, finishSide: 1 });
  const aThin = g.addWall(xAxis, -75, true, yTop, 0, yAxis, -75,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 0, finishSide: -1 });

  return { g, b, aOwner, aThin };
}

test('buildWallDrawPlan: 通し壁（実Wall）の面線はAの全材幅・内側線はAの下地幅で別々に切られる', () => {
  const { g, b } = buildThroughWallGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const bLines = plan.wallLines.get(b.id);

  assert.deepEqual(bLines.segments, [[0, 7000]]);
  assert.deepEqual(at(bLines.lines, false, 1925), [[0, 2425], [2575, 7000]],
    '仕上げ面線はAの全材幅（所有権ペア込み・2425〜2575）で切られるはず');
  assert.deepEqual(at(bLines.lines, false, 1937.5), [[0, 2437.5], [2562.5, 7000]],
    '内側線はAの下地幅（2437.5〜2562.5）で切られるはず——面線とは異なる区間');
});

// 【領域方式での言い直し】旧: hLeft.finSegments=[[57.5,2455]]・capHiSuppressed=true。
// 内側線が相手（Vthin）の内側線 x=2455 まで届き、突き当たり位置 x=2442.5 に妻線が立たないことは同じ。
// 変わったのは y=-5045 の線が x=2455 で終わらず通し（[57.5,4442.5]の1本）になること——
// このフィクスチャには南側の壁が無く、y=-5045 は材の境界そのものなので連続して描かれる
// （南側にオーナー壁があれば、その内側線が突き当たる壁の下地幅で切れる。上の通し壁テスト参照）。
test('buildWallDrawPlan: 入隅側の壁（実Wall）は内側線が相手の内側線平面まで延び、妻線は立たない', () => {
  const { g, vThin, hLeft } = buildConcaveGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const lines = allLines(plan);

  assert.deepEqual(plan.wallLines.get(hLeft.id).segments, [[57.5, 2442.5]]);
  const inner = at(lines, false, -5045);
  assert.equal(inner.length, 1);
  assert.ok(inner[0][0] <= 57.5 && inner[0][1] >= 2455, 'hLeftの内側線はVthinの内側線位置(2455)まで届くはず');
  assert.equal(hasLineAt(lines, true, 2442.5, -5057.5, -5045), false, '入隅側のhi端に妻線は立たないはず');
  assert.equal(hasLineAt(lines, true, 57.5, -5057.5, -5045), true, '自由端(lo)の妻線は残るはず');

  assert.deepEqual(at(lines, true, 2455), [[-11900, -5045]],
    '対称側（Vthinの内側線）もhLeftの内側線位置(-5045)まで延びるはず');
  assert.deepEqual(at(plan.wallLines.get(vThin.id).lines, false, -5057.5), [], 'Vthinのhi端に妻線は立たない');
});

test('buildWallDrawPlan: 右の隅（実Wall）はH-rightのlo端に妻線が立たず、内側線が相手の内側線(2545)へ届く', () => {
  const { g, hRight } = buildConcaveGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const lines = allLines(plan);

  assert.deepEqual(plan.wallLines.get(hRight.id).segments, [[2557.5, 4442.5]]);
  const inner = at(lines, false, -5045);
  assert.ok(inner.some(([lo, hi]) => lo <= 2545 && hi >= 4442.5), '内側線はVownerの内側線位置(2545)から届くはず');
  assert.equal(hasLineAt(lines, true, 2557.5, -5057.5, -5045), false, '入隅側のlo端に妻線は立たないはず');
  assert.equal(hasLineAt(lines, true, 4442.5, -5057.5, -5045), true, '自由端(hi)の妻線は残るはず');
});

test('buildWallDrawPlan: 4枚一括の解決でVownerのhi端も内側線が届き、妻線が立たない', () => {
  const { g, vOwner } = buildConcaveGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL); // 4枚（vThin/vOwner/hLeft/hRight）一括
  const own = plan.wallLines.get(vOwner.id).lines;

  assert.deepEqual(at(own, true, 2545), [[-11900, -5045]],
    'Vownerの内側線のhi端はHrightの内側線位置(-5045)まで延びるはず');
  assert.deepEqual(at(own, false, -5057.5), [], 'hi端に妻線は立たない');
  assert.deepEqual(at(own, false, -11900), [[2442.5, 2557.5]], '自由端(lo)の妻線は帯全体で1本');
});

// 出隅では内側線どうしが角の交点で合流する（仕様改訂2026-09後半「角では平行な2本線が取り合う」）。
// 旧: finSegments=[[-6000,45]]・capHiSuppressed=false（妻線は相手の面線に重なって描かれていた）。
// 領域方式では妻線が相手の面線に畳まれ、面線が角まで1本で届く。
test('buildWallDrawPlan: 出隅側の壁（実Wall）は内側線が角の交点まで届き、面線が角を閉じる', () => {
  const { g, v } = buildConvexGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const lines = allLines(plan);

  assert.deepEqual(plan.wallLines.get(v.id).segments, [[-6000, 57.5]]);
  assert.deepEqual(at(lines, true, 45), [[-6000, 45]],
    'vの内側線は相手(h)の内側線位置(45)＝角の交点まで届くはず');
  assert.deepEqual(at(lines, false, 45), [[-6000, 45]], '相手(h)側も同じく角の交点まで届く');
  assert.deepEqual(at(lines, false, 57.5), [[-6000, 57.5]], '面線は角(57.5,57.5)まで1本');
  assert.deepEqual(at(lines, true, 57.5), [[-6000, 57.5]]);
});

// ---- |axisOffset|===wallFinish の薄壁（内側線がちょうど軸CL上に来る）を実Wallで再現する。
// finish/stair/stairUnderWalls.jsのルール2（階段下部屋の外側仕上げ薄壁。
// axisOffset:-sign*outerFinish, wallFinish:outerFinish, backingDepth:0）が実際に生成する形状。
// 2026-09の偏芯壁対応で、この薄壁も**普通に2本線で描かれ普通に取り合う**ようになった
// （旧: 軸CLと重なる内側線を抑止していたため、12.5mmの帯が1本線で描かれ、直交する壁の
// 内側線が受け手を失って宙で終わっていた）。
function buildCollapsedFinGraph() {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const xAxis = vCL(g, 1000), yAxis = hCL(g, 0);
  const yFar = hCL(g, -5000), xWestFar = vCL(g, 0);

  // collapsedV: axisOffset(-12.5) と wallFinish(12.5) の絶対値が等しく、内側線が軸CL(x=1000)上に来る。
  const collapsedV = g.addWall(xAxis, -12.5, true, yFar, 0, yAxis, -12.5,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 0, finishSide: -1 });
  // hLeft: 通常の薄壁。collapsedVの面(x=987.5)で終端する。
  const hLeft = g.addWall(yAxis, -12.5, false, xWestFar, 0, xAxis, -12.5,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 0, finishSide: -1 });

  return { g, collapsedV, hLeft };
}

test('buildWallDrawPlan: 内側線が軸CL上に来る薄壁（実Wall）も2本線で描かれ、普通に取り合う', () => {
  const { g, collapsedV, hLeft } = buildCollapsedFinGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const lines = allLines(plan);

  const vLines = plan.wallLines.get(collapsedV.id).lines;
  assert.ok(at(vLines, true, 987.5).length === 1 && at(vLines, true, 1000).length === 1,
    '仕上げ材の帯は面線と内側線（軸CL上）の2本で描かれるはず');
  assert.deepEqual(at(lines, false, 0), [[0, 1000]],
    'hLeftの内側線は相手(collapsedV)の内側線の位置=1000まで延びるはず');
  assert.equal(hasLineAt(lines, true, 987.5, -12.5, 0), false,
    '入隅として解決される以上、hLeftのhi端に妻線は立たないはず');
  assert.equal(plan.wallLines.get(hLeft.id).segments[0][1], 987.5, '描画上のスパンは物理端のまま');
});

test('buildWallDrawPlan: 詳細LODでwallLinesが入隅・出隅の両方を実グラフ経由で正しく解決する', () => {
  const concave = buildConcaveGraph();
  const concaveLines = allLines(buildWallDrawPlan(concave.g, LodLevel.DETAIL));
  assert.ok(at(concaveLines, false, -5045).some(([lo, hi]) => lo <= 57.5 && hi >= 2455));
  assert.equal(hasLineAt(concaveLines, true, 2442.5, -5057.5, -5045), false);

  const convex = buildConvexGraph();
  const convexLines = allLines(buildWallDrawPlan(convex.g, LodLevel.DETAIL));
  assert.deepEqual(at(convexLines, true, 45), [[-6000, 45]],
    '角の交点(45)まで届く（仕様改訂2026-09後半。上の出隅テスト参照）');
});

// ---- 標準LODも領域方式（ユーザー確定2026-09）: 材の合併境界＝面線と妻線だけを描く。
// 規則: **材が続く端に線は出ない**（旧標準LODは取り合いを解かず、壁の継ぎ目という継ぎ目に妻線が出ていた）。
test('buildWallDrawPlan: 標準LODは材の合併境界を描き、材が続く端に妻線は出ない・内側線は描かない', () => {
  const { g, hLeft, hRight, vThin, vOwner } = buildConcaveGraph();
  const plan = buildWallDrawPlan(g, LodLevel.STANDARD);
  const lines = allLines(plan);

  assert.deepEqual(lines.filter(l => l.kind === 'fin' || l.kind === 'ecap'), [], '標準LODに内側線・木口線は無い');
  // 入隅で材が続く端（hLeft の hi・hRight の lo・vThin/vOwner の hi）には妻線が出ない。
  assert.equal(hasLineAt(lines, true, 2442.5, -5057.5, -5045), false);
  assert.equal(hasLineAt(lines, true, 2557.5, -5057.5, -5045), false);
  assert.equal(hasLineAt(lines, false, -5057.5, 2442.5, 2557.5), false);
  // 材が終わる自由端には妻線が出る。
  assert.equal(hasLineAt(lines, true, 57.5, -5057.5, -5045), true);
  assert.equal(hasLineAt(lines, true, 4442.5, -5057.5, -5045), true);
  assert.deepEqual(at(plan.wallLines.get(vOwner.id).lines, false, -11900), [[2442.5, 2557.5]]);
  // 面線は材の合併境界（同じ直線上の材は1本に畳まれる）。
  assert.deepEqual(at(lines, false, -5045), [[57.5, 4442.5]]);
  assert.deepEqual(at(plan.wallLines.get(hLeft.id).lines, false, -5057.5), [[57.5, 2442.5]]);
  assert.deepEqual(at(plan.wallLines.get(hRight.id).lines, false, -5057.5), [[2557.5, 4442.5]]);
  assert.deepEqual(at(plan.wallLines.get(vThin.id).lines, true, 2442.5), [[-11900, -5057.5]]);
});

test('buildWallDrawPlan: 標準LODでも高さが違う壁の取り合い（パス0）を解く＝低い壁の帯を覆う延長が効く', () => {
  // 詳細LODと同じフィクスチャ。標準LODで wallJunctions が無いと、覆う延長も覆われる区間の抑止も効かず、
  // 詳細では隠れる交差部の駒が閉じた矩形として残る（実機 2階 (0,-2000)）。
  const knee = buildKneePartitionGraph(900);
  const plan = buildWallDrawPlan(knee.g, LodLevel.STANDARD);
  assert.notEqual(plan.wallJunctions, null, '標準LODでも取り合いを解く');
  assert.deepEqual(plan.wallLines.get(knee.part.id).segments, [[1942.5, 4942.5]], '腰壁の帯の遠位面まで覆って伸びる');
  assert.deepEqual(allLines(plan).filter(l => l.kind === 'fin' || l.kind === 'ecap'), []);
});

// ---- 失敗系: 自由端（相手がいない壁単体）は両端に妻線が立ち、内側線は物理端のまま ----
test('【失敗系】相手がいない壁は取り合わず、面線は物理端まで・両端に妻線が立つ', () => {
  const { hLeft } = buildConcaveGraph();
  const alone = [...resolveWallRegionLines([hLeft]).lines.values()].flat();
  assert.deepEqual(at(alone, false, -5045), [[57.5, 2442.5]]);
  assert.deepEqual(at(alone, true, 57.5), [[-5057.5, -5045]]);
  assert.deepEqual(at(alone, true, 2442.5), [[-5057.5, -5045]]);

  // resolveWallLines は領域の結果を持ち回るだけ——渡さなければ線も下地の範囲も無い。
  const plain = resolveWallLines(hLeft, { junction: undefined });
  assert.deepEqual(plain.lines, []);
  assert.equal(plain.backingSpan, null);
  assert.deepEqual(plain.segments, [[57.5, 2442.5]]);
});

// ---- 腰壁は取り合いの相手にならない／L字の端部は高い方が覆って取り巻く（2026-09ユーザー確定）----
// resolveWallTJunctions 側の単体テストは wallJunctionResolve.test.js にあるが、
// buildWallDrawPlan が腰壁オーバーレイを**実際に渡しているか**はここでしか守れない
// （渡し忘れても純関数のテストは緑のまま）。実グラフで固定する。
// 間仕切り（x=2000・y=2000〜5000）は上下室の境（y=2000。腰壁指定）で**終わる**壁——
// 実機2026-09のX3通りと同じ形（相手が腰壁で、その先に同じ通りの壁が続かない端部）。
function buildKneePartitionGraph(kneeTopHeight) {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const x0 = vCL(g, 0), xm = vCL(g, 2000), x1 = vCL(g, 4000);
  const y0 = hCL(g, 0), yMid = hCL(g, 2000), y2 = hCL(g, 5000);
  const upper = g.addRoom(new Set([`${x0.id}:${y0.id}:${xm.id}:${yMid.id}`, `${xm.id}:${y0.id}:${x1.id}:${yMid.id}`]), '上室');
  const lowerL = g.addRoom(new Set([`${x0.id}:${yMid.id}:${xm.id}:${y2.id}`]), '下左');
  const lowerR = g.addRoom(new Set([`${xm.id}:${yMid.id}:${x1.id}:${y2.id}`]), '下右');
  for (const r of [upper, lowerL, lowerR]) generateRoomWallsFromOutline(g, r);
  if (kneeTopHeight != null) {
    for (const [s2, e2] of [[x0, xm], [xm, x1]]) {
      g.setKneeDropWall(edgeKey(yMid.id, s2.id, e2.id), { knee: { topHeight: kneeTopHeight } });
    }
  }
  // 下2室を仕切る間仕切りのうち下左室側（材[1942.5,2000]）。lo端で腰壁の帯とL字に取り合う。
  const part = [...g.walls].find(w => w.isVertical && w.axisCL === xm
    && Math.min(w.coord1, w.coord2) > 2000 && w.materialRange.hi <= 2000);
  return { g, part };
}

// 【領域方式での言い直し】旧: endWrapLo=1955・finSegments=[[1955,4955]]・capLoSuppressed=false。
// 木口線（ecap）は下地の端の辺として材の中に出る＝内側線の間（x∈[1955,2045]）だけになり、
// 内側線と木口線がL字の角を作る（旧は材幅いっぱい[1942.5,2000]で面線まで届いていた）。
test('buildWallDrawPlan: 腰壁とL字に取り合う端部は、高い壁が覆って仕上げ材が端を取り巻く', () => {
  const knee = buildKneePartitionGraph(900);
  const lines = buildWallDrawPlan(knee.g, LodLevel.DETAIL).wallLines.get(knee.part.id);

  // 腰壁の帯（オーナー[1942.5,2000]＋薄壁[2000,2057.5]）の遠位面1942.5まで覆う。
  assert.deepEqual(lines.segments, [[1942.5, 4942.5]], '端部を覆うまでスパンごと伸びるはず');
  assert.deepEqual(at(lines.lines, false, 1942.5), [[1942.5, 2057.5]], '実際の端部なので妻線（外側線）は端に残るはず');
  const ecap = lines.lines.filter(l => l.kind === 'ecap');
  assert.equal(ecap.length, 1);
  assert.equal(ecap[0].at, 1955, '木口線は端から仕上げ厚(12.5)内側に立つはず');
  assert.equal(ecap[0].lo, 1955, '木口線は内側線の位置から始まり、内側線とL字の角を作る');
  assert.deepEqual(at(lines.lines, true, 1955), [[1955, 4955]],
    '内側線は端まで行かず木口線の位置で止まり、そこで角を作る（外側線は端まで・内側線同士がL字）');
  assert.deepEqual(lines.backingSpan, [1955, 4955], '下地スタッドの範囲も木口線から');
});

test('【失敗系】buildWallDrawPlan: 腰壁の先に同じ通りの壁が続く端は、端部ではないので取り巻かない', () => {
  // 上下室の外周壁（x=0の通り）は腰壁の帯を跨いで上下に続く1枚——妻線も木口線も出さず、
  // 伸びた2本が重なって面線・内側線が連続するのが正しい。
  const knee = buildKneePartitionGraph(900);
  const west = [...knee.g.walls].find(w => w.isVertical && w.materialRange.lo === 0
    && Math.min(w.coord1, w.coord2) > 2000);
  const plan = buildWallDrawPlan(knee.g, LodLevel.DETAIL);
  const lines = plan.wallLines.get(west.id);
  assert.deepEqual(lines.segments, [[1942.5, 4942.5]], '覆うところまでは同じく伸びる');
  assert.deepEqual(lines.lines.filter(l => l.kind === 'ecap'), [], '通過点なので取り巻かない');
  assert.equal(hasLineAt(allLines(plan), false, 1942.5, 0, 57.5), false, '妻線も出さない（壁は続いている）');
  assert.ok(at(allLines(plan), true, 57.5).some(([lo, hi]) => lo <= 57.5 && hi >= 4942.5), '面線は上下に連続する1本');
});

test('【失敗系】buildWallDrawPlan: 切断高さを超える腰壁指定は通常の壁のまま取り合う', () => {
  const tall = buildKneePartitionGraph(1800); // PLAN_CUT_HEIGHT(1500)超＝切断面に切られる
  const plan = buildWallDrawPlan(tall.g, LodLevel.DETAIL);
  const lines = plan.wallLines.get(tall.part.id);
  assert.deepEqual(lines.segments, [[2057.5, 4942.5]], '端部を覆う延長は起きないはず');
  assert.deepEqual(lines.lines.filter(l => l.kind === 'ecap'), []);
  assert.equal(hasLineAt(lines.lines, false, 2057.5, 1942.5, 2057.5), false,
    '切断面まで在る壁どうしなので従来どおり取り合う（妻線は立たない）');
  assert.deepEqual(at(allLines(plan), true, 1955), [[2045, 4955]], '内側線は相手の内側線の位置へ寄る');
});

// ==== 2a壁の描画クリップ単位（clipGroups）の配線 ====
// planWallRegion.js の純関数テストは「正しい引数を渡せば畳まない」ことしか守れない。buildWallDrawPlan が
// `clipGroups` を実際に領域へ渡しているかはここでしか守れない（渡し忘れると全緑のまま2a壁の線が隣の壁へ
// 畳まれ、壁id単位の Group clipFunc が効かなくなる）。
test('buildWallDrawPlan: clipGroups を渡すと、単位が違う共線の壁の線は畳まれず自分の壁が持つ', () => {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const y0 = hCL(g, 0), x0 = vCL(g, 0), xm = vCL(g, 3000), x1 = vCL(g, 3500);
  const A = wall(g, y0, 57.5, false, x0, 0, xm, 0);
  const B = wall(g, y0, 57.5, false, xm, 0, x1, 0);

  const folded = buildWallDrawPlan(g, LodLevel.DETAIL);
  assert.deepEqual(at(folded.wallLines.get(B.id).lines, false, 57.5), [], '既定では B の面線は A の線に畳まれる');
  assert.deepEqual(at(folded.wallLines.get(A.id).lines, false, 57.5), [[0, 3500]]);

  const grouped = buildWallDrawPlan(g, LodLevel.DETAIL, { clipGroups: new Map([[B.id, '0']]) });
  assert.deepEqual(at(grouped.wallLines.get(B.id).lines, false, 57.5), [[3000, 3500]], 'B の区間は B が持つ');
  assert.deepEqual(at(grouped.wallLines.get(A.id).lines, false, 57.5), [[0, 3000]]);
});

// ==== 高さが違う腰壁どうしの角（900×1000）。現状の挙動を記述するだけのテスト ====
// 高さクラスが違う天板は角で取り合わず（低い方が高い方の帯を差し引くだけ）、外角に出幅ぶんの欠けが残る。
// **期待値は未確定**（HEAD も同じ描画。ユーザーへ別途確認する）——ここでは現挙動が黙って変わらないことだけを固定する。
test('【現状記述】buildWallDrawPlan: 高さが違う腰壁どうしの角は取り合わず、低い方が高い方の帯の幅だけ途切れる', () => {
  const g = new PlanGraph(new Plane('p', 0, '2階', 1, 1));
  const x0 = vCL(g, 0), x1 = vCL(g, 4000), y0 = hCL(g, 0), y1 = hCL(g, 5000);
  const room = g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '室');
  generateRoomWallsFromOutline(g, room);
  g.setKneeDropWall(edgeKey(y0.id, x0.id, x1.id), { knee: { topHeight: 900 } });   // 横（低い）
  g.setKneeDropWall(edgeKey(x0.id, y0.id, y1.id), { knee: { topHeight: 1000 } });  // 縦（高い）
  const kd = allLines(buildWallDrawPlan(g, LodLevel.DETAIL)).filter(l => l.kind === 'kd' || l.kind === 'kdcap');
  // 横（900）の天板は縦（1000）の帯 x∈[-12,69.5] の幅だけ途切れ、帯の面上の端部の線は出幅ぶんだけ残る。
  assert.deepEqual(at(kd, false, -12), [[69.5, 3942.5]]);
  assert.deepEqual(at(kd, false, 69.5), [[69.5, 3942.5]]);
  assert.deepEqual(at(kd, true, 69.5), [[-12, 0], [0, 4942.5]]);
  // 縦（1000）の天板は横の帯へ伸びず、自分の端 y=0 で端部の線を描く。
  assert.deepEqual(at(kd, true, -12), [[0, 4942.5]]);
  assert.deepEqual(at(kd, false, 0), [[-12, 69.5]]);
});

// ==== 柱壁（全高）と腰壁の天板 ====
// 天板は壁帯とは別の輪郭で描かれるため、通常の面線カット（faceCuts/colCuts）では守られない
// ——柱壁に占有される区間を描かず、そこへ突き当たる（ユーザー確定2026-09「高い壁が勝つ。
// 柱包みの壁を作って、そこへ腰壁が当たる」）。
// 天板の輪郭も planWallRegion.js が高さクラスごとの領域として解き、`lines`（kind 'kd'|'kdcap'・
// `style` が線種）で返す。resolveWallLines は持ち回るだけ。
test('【失敗系】resolveWallLines: 領域の結果を渡さなければ天板の線も無く、segments は壁帯のまま', () => {
  const { hLeft } = buildConcaveGraph();
  const plain = resolveWallLines(hLeft, {});
  assert.deepEqual(plain.lines, []);
  assert.deepEqual(plain.segments, [[57.5, 2442.5]]);
});

// 1室の直交する2辺（y=0の辺・x=0の辺）に同じ高さの腰壁を指定する（finish/kneeDropWall.test.js の
// makeCornerKneeGraph と同じ）。天板の角（実機2026-09「22」2階 X3×Y1+3500）が実グラフ経由で
// 外側どうし・内側どうしで出会い、端部の線が出ないことを固定する。
test('buildWallDrawPlan: 角で出会う同高の天板は外側どうし・内側どうしで出会い、端部の線は出ない（実グラフ）', () => {
  const g = new PlanGraph(new Plane('p', 0, '2階', 1, 1));
  const x0 = vCL(g, 0), x1 = vCL(g, 4000), y0 = hCL(g, 0), y1 = hCL(g, 5000);
  const room = g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '室');
  generateRoomWallsFromOutline(g, room);
  g.setKneeDropWall(edgeKey(y0.id, x0.id, x1.id), { knee: { topHeight: 900 } });
  g.setKneeDropWall(edgeKey(x0.id, y0.id, y1.id), { knee: { topHeight: 900 } });
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const kd = allLines(plan).filter(l => l.kind === 'kd' || l.kind === 'kdcap');
  // 天板の帯は材（[0,57.5]）の外へ12mm出る＝[-12, 69.5]。角は(x,y)=(57.5,57.5)側が内側。
  assert.ok(at(kd, false, -12).some(([lo]) => lo === -12), '外側の長辺(y=-12)は相手の帯の遠位面(x=-12)まで');
  assert.ok(at(kd, false, 69.5).some(([lo]) => lo === 69.5), '内側の長辺(y=69.5)は近位面(x=69.5)で止まる');
  assert.ok(at(kd, true, -12).some(([lo]) => lo === -12));
  assert.ok(at(kd, true, 69.5).some(([lo]) => lo === 69.5));
  assert.equal(kd.some(l => l.kind === 'kdcap' && (l.at === 57.5 || l.at === -12)), false, '角に端部の線は出ない');
  assert.ok(kd.every(l => l.style === 'knee'), '腰壁は実線');
});

// buildWallDrawPlan が腰壁オーバーレイと柱の切り欠きを**実際に天板へ配線しているか**は
// ここでしか守れない（純関数のテストは渡し忘れを検出しない）。実グラフで固定する。
test('buildWallDrawPlan: 腰壁の通りに立つ柱の包みで天板が分割される（実グラフ経由の配線）', () => {
  const g = new PlanGraph(new Plane('p', 0, '2階', 1, 1));
  const x0 = vCL(g, 0), x1 = vCL(g, 4000);
  const y0 = hCL(g, 0), yMid = hCL(g, 2000), y2 = hCL(g, 5000);
  const upper = g.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${yMid.id}`]), '上室');
  const lower = g.addRoom(new Set([`${x0.id}:${yMid.id}:${x1.id}:${y2.id}`]), '下室');
  for (const r of [upper, lower]) generateRoomWallsFromOutline(g, r);
  g.addColumn(StructuralMaterialType.RC, 'RC-300x300', vCL(g, 2000), yMid, {});
  g.setKneeDropWall(edgeKey(yMid.id, x0.id, x1.id), { knee: { topHeight: 900 } });

  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);
  const kneeWall = [...g.walls].find(w => plan.kneeDropOverlays.has(w.id));
  const kd = allLines(plan).filter(l => l.kind === 'kd' || l.kind === 'kdcap');
  const { capLo, capHi } = plan.kneeDropOverlays.get(kneeWall.id);
  // 素の300角＋層構成102.5×2 ＝ 見付け505mm（x=1747.5〜2252.5）。天板の長辺はそこで途切れ、
  // 切られた端の線は柱壁の材に覆われて天板側からは出ない——その辺は柱壁（StructuralLayer）が描く
  // （天板の輪郭で描かれる壁と取り合う辺は `continued=false`＝柱壁が自分で描く）。
  assert.deepEqual(at(kd, false, capLo), [[57.5, 1747.5], [2252.5, 3942.5]], '天板の長辺は柱壁の区間で途切れる');
  assert.deepEqual(at(kd, false, capHi), [[57.5, 1747.5], [2252.5, 3942.5]]);
  assert.deepEqual(at(kd, true, 1747.5), [], '柱壁の面上の端部の線は天板側からは出ない');
  assert.deepEqual(at(kd, true, 2252.5), []);
  assert.deepEqual(plan.wallLines.get(kneeWall.id).segments, [[57.5, 3942.5]], '壁帯のスパンは変わらない');
});
