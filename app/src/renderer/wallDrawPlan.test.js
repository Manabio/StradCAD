// wallDrawPlan（壁描画の1レンダー分の派生値解決）のテスト。
//
// resolveWallLines は ShapesLayer.jsx が下していた判断（仕上げ面線・内側線をどこで切るか、
// キャップ線を描くか）を集約した純関数——.jsx はその返り値を <Line> へ写すだけになった。
// これを純関数として抽出しただけでは「.jsx が正しい引数を渡すか」は検証されない
// （QA指摘2026-09: isCapSuppressedへ空のcapSuppressを渡す・resolveWallFinSegmentsの戻り値を
// 無視する・仕上げ面線をfinCuts側の区間で切る、の3種の変異がいずれもフルスイート緑のまま
// だった）。本ファイルは実Wallインスタンス（PlanGraphで生成）を使い、
// resolveWallLines／buildWallDrawPlan の呼び出し結果そのものを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, StructuralMaterialType } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { LodLevel } from '../viewport.js';
import { resolveWallTJunctions } from './wallJunctionResolve.js';
import { buildWallDrawPlan, resolveWallLines } from './wallDrawPlan.js';

const vCL = (g, v) => g.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
const hCL = (g, v) => g.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
// 部屋壁と同じ寸法（wallBase=90 / wallFinish=12.5 → axisOffset=±57.5。wallCorner.test.js と同じ）。
const wall = (g, axisCL, axisOffset, isVertical, clS, offS, clE, offE, props = {}) =>
  g.addWall(axisCL, axisOffset, isVertical, clS, offS, clE, offE, { isRoomWall: true, wallFinish: 12.5, ...props });

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
// aOwner+aThin=Aの所有権ペア）。faceSegments/finSegmentsが異なる区間で切られることを
// 実Wall経由で固定する——ここが薄いと「仕上げ面線をfinCuts側の区間で切る」変異を
// 検出できない（QA指摘）。
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

test('resolveWallLines: 通し壁（実Wall）はfaceSegmentsがAの全材幅・finSegmentsがAの下地幅で別々に切られる', () => {
  const { g, b } = buildThroughWallGraph();
  const junctions = resolveWallTJunctions([...g.walls]);

  const bLines = resolveWallLines(b, { junction: junctions.get(b.id) });
  assert.deepEqual(bLines.segments, [[0, 7000]]);
  assert.deepEqual(bLines.faceSegments, [[0, 2425], [2575, 7000]],
    '仕上げ面線はAの全材幅（所有権ペア込み・2425〜2575）で切られるはず');
  assert.deepEqual(bLines.finSegments, [[0, 2437.5], [2562.5, 7000]],
    '内側線はAの下地幅（2437.5〜2562.5）で切られるはず——faceSegmentsとは異なる区間');
});

test('resolveWallLines: 入隅側の壁（実Wall）はfinSegments末尾が相手の内側線平面まで延び、cap抑止が立つ', () => {
  const { g, vThin, hLeft } = buildConcaveGraph();
  const junctions = resolveWallTJunctions([...g.walls]);

  const hLeftLines = resolveWallLines(hLeft, { junction: junctions.get(hLeft.id) });
  assert.deepEqual(hLeftLines.segments, [[57.5, 2442.5]]);
  assert.deepEqual(hLeftLines.finSegments, [[57.5, 2455]],
    'fin線の末尾がVthinの内側線位置(2455)まで延びるはず');
  assert.equal(hLeftLines.capHiSuppressed, true, '入隅側のhi端はcap抑止が立つはず');
  assert.equal(hLeftLines.capLoSuppressed, false, '自由端(lo)は変化しないはず');

  const vThinLines = resolveWallLines(vThin, { junction: junctions.get(vThin.id) });
  assert.deepEqual(vThinLines.finSegments, [[-11900, -5045]],
    '対称側（Vthin）もHleftの内側線位置(-5045)まで延びるはず');
  assert.equal(vThinLines.capHiSuppressed, true);
});

// ---- capLoSuppressedの配線検証（QA指摘: 既存テストがcapLoSuppressedについて
// 「falseであること」しか主張しておらず、`capLoSuppressed:` を`false`固定に変異しても
// 全緑になっていた）。右の隅（H-right/V-owner）はlo端が入隅、hi端が自由端という
// 左の隅と非対称な構成のため、capLoSuppressedが実際にtrueになる経路を固定できる ----
test('resolveWallLines: 右の隅（実Wall）はH-rightのlo端でcapLoSuppressedがtrueになる', () => {
  const { g, hRight } = buildConcaveGraph();
  const junctions = resolveWallTJunctions([...g.walls]);

  const hRightLines = resolveWallLines(hRight, { junction: junctions.get(hRight.id) });
  assert.deepEqual(hRightLines.segments, [[2557.5, 4442.5]]);
  assert.deepEqual(hRightLines.finSegments, [[2545, 4442.5]],
    'fin線の先頭がVownerの内側線位置(2545)まで延びるはず');
  assert.equal(hRightLines.capLoSuppressed, true, '入隅側のlo端はcap抑止が立つはず');
  assert.equal(hRightLines.capHiSuppressed, false, '自由端(hi)は変化しないはず');
});

test('resolveWallLines: 4枚一括の解決でVownerのhi端もfinSegments/capHiSuppressedが正しく解決される', () => {
  const { g, vOwner } = buildConcaveGraph();
  const junctions = resolveWallTJunctions([...g.walls]); // 4枚（vThin/vOwner/hLeft/hRight）一括

  const vOwnerLines = resolveWallLines(vOwner, { junction: junctions.get(vOwner.id) });
  assert.deepEqual(vOwnerLines.finSegments, [[-11900, -5045]],
    'VownerのfinSegmentsのhi端はHrightの内側線位置(-5045)まで延びるはず');
  assert.equal(vOwnerLines.capHiSuppressed, true);
});

// ---- 2026-09追記: buildConvexGraphのv/hはprops未指定＝対称壁（backingDepth既定式）のため
// 実際にはbackingRangeを持つ（軸±45。core/wall.js「対称(backingDepth未指定)」枝）。
// fin線をVownerの内側線位置(45)まで短縮しただけでは、そこがちょうど相手(h)の下地帯
// [-45,45]の内側に収まってしまい、fin線が相手の下地帯を横切ったまま（角のblock内に
// fin線が残る）——wallJunctionResolve.jsパス3（fin線の直交壁下地貫通防止）により、
// 相手の下地帯ぶんさらに短縮され-45で終わるのが正しい（ユーザー確定仕様「fin線は
// 直交する壁の下地を横切る区間を描かない」）。 ----
test('resolveWallLines: 出隅側の壁（実Wall）はfinSegmentsが角の交点まで届き、cap抑止は立たない', () => {
  const { g, v, h } = buildConvexGraph();
  const junctions = resolveWallTJunctions([...g.walls]);

  const vLines = resolveWallLines(v, { junction: junctions.get(v.id) });
  assert.deepEqual(vLines.segments, [[-6000, 57.5]]);
  assert.deepEqual(vLines.finSegments, [[-6000, 45]],
    'fin線は相手(h)の内側線位置(45)＝角の交点まで届くはず（仕様改訂2026-09後半: 角では2本線が取り合う）');
  assert.equal(vLines.capHiSuppressed, false,
    '出隅ではcap抑止は立たない（キャップの扱いは現状維持というユーザー確定仕様）');

  const hLines = resolveWallLines(h, { junction: junctions.get(h.id) });
  assert.deepEqual(hLines.finSegments, [[-6000, 45]], '相手(v)側も同じく角の交点まで届く');
  assert.equal(hLines.capHiSuppressed, false);
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

  // collapsedV: axisOffset(-12.5) と wallFinish(12.5) の絶対値が等しく、finBoundaryが
  // 軸CL(x=1000)上に潰れる（finVisible=false）。
  const collapsedV = g.addWall(xAxis, -12.5, true, yFar, 0, yAxis, -12.5,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 0, finishSide: -1 });
  // hLeft: 通常の薄壁（finVisible=true）。collapsedVの面(x=987.5)で終端する。
  const hLeft = g.addWall(yAxis, -12.5, false, xWestFar, 0, xAxis, -12.5,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 0, finishSide: -1 });

  return { g, collapsedV, hLeft };
}

test('buildWallDrawPlan: 内側線が軸CL上に来る薄壁（実Wall）も2本線で描かれ、普通に取り合う', () => {
  const { g, collapsedV, hLeft } = buildCollapsedFinGraph();
  const plan = buildWallDrawPlan(g, LodLevel.DETAIL);

  const vLines = plan.wallLines.get(collapsedV.id);
  assert.equal(vLines.finVisible, true, '仕上げ材の帯は面線と内側線の2本で描かれるはず');
  assert.equal(vLines.finBoundary, 1000, '内側線は軸CL上（材の中）に来る');

  const hLeftLines = plan.wallLines.get(hLeft.id);
  assert.deepEqual(hLeftLines.finSegments, [[0, 1000]],
    'fin線は相手(collapsedV)の内側線の位置=1000まで延びるはず');
  assert.equal(hLeftLines.capHiSuppressed, true,
    '入隅として解決される以上キャップは抑止されるはず（内側線が受け手を得たため）');
});

test('buildWallDrawPlan: 詳細LODでwallLinesが入隅・出隅の両方を実グラフ経由で正しく解決する', () => {
  const concave = buildConcaveGraph();
  const concavePlan = buildWallDrawPlan(concave.g, LodLevel.DETAIL);
  assert.deepEqual(concavePlan.wallLines.get(concave.hLeft.id).finSegments, [[57.5, 2455]]);
  assert.equal(concavePlan.wallLines.get(concave.hLeft.id).capHiSuppressed, true);

  const convex = buildConvexGraph();
  const convexPlan = buildWallDrawPlan(convex.g, LodLevel.DETAIL);
  assert.deepEqual(convexPlan.wallLines.get(convex.v.id).finSegments, [[-6000, 45]],
    '角の交点(45)まで届く（仕様改訂2026-09後半。上のresolveWallLinesテスト参照）');
  assert.equal(convexPlan.wallLines.get(convex.v.id).capHiSuppressed, false);
});

// ---- 失敗系: 標準LOD（wallJunctions=null）ではfinEnd/capSuppressが一切効かない
// （T字取り合い解決は詳細LOD限定という既存仕様——標準・略図の描画を変えない）----
test('【失敗系】buildWallDrawPlan: 標準LODではwallJunctionsがnullのままfinSegmentsは無変更', () => {
  const { g, hLeft } = buildConcaveGraph();
  const plan = buildWallDrawPlan(g, LodLevel.STANDARD);

  assert.equal(plan.wallJunctions, null);
  assert.deepEqual(plan.wallLines.get(hLeft.id).finSegments, [[57.5, 2442.5]],
    '標準LODでは入隅の延長が効かず、fin線は物理端のままのはず');
  assert.equal(plan.wallLines.get(hLeft.id).capHiSuppressed, false);
});

// ---- 失敗系: 自由端（相手がいない壁単体）はfinSegments/capSuppressedが無変更 ----
test('【失敗系】resolveWallLines: 相手がいない壁（junctionなし）はfinSegments/capSuppressedが無変更', () => {
  const { hLeft } = buildConcaveGraph();
  const lines = resolveWallLines(hLeft, { junction: undefined });

  assert.deepEqual(lines.finSegments, [[57.5, 2442.5]]);
  assert.equal(lines.capLoSuppressed, false);
  assert.equal(lines.capHiSuppressed, false);
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

test('buildWallDrawPlan: 腰壁とL字に取り合う端部は、高い壁が覆って仕上げ材が端を取り巻く', () => {
  const knee = buildKneePartitionGraph(900);
  const lines = buildWallDrawPlan(knee.g, LodLevel.DETAIL).wallLines.get(knee.part.id);

  // 腰壁の帯（オーナー[1942.5,2000]＋薄壁[2000,2057.5]）の遠位面1942.5まで覆う。
  assert.deepEqual(lines.segments, [[1942.5, 4942.5]], '端部を覆うまでスパンごと伸びるはず');
  assert.equal(lines.capLoSuppressed, false, '実際の端部なので妻線（外側線）は端に残るはず');
  assert.equal(lines.endWrapLo, 1955, '木口線は端から仕上げ厚(12.5)内側に立つはず');
  assert.deepEqual(lines.finSegments, [[1955, 4955]],
    '内側線は端まで行かず木口線の位置で止まり、そこで角を作る（外側線は端まで・内側線同士がL字）');
});

test('【失敗系】buildWallDrawPlan: 腰壁の先に同じ通りの壁が続く端は、端部ではないので取り巻かない', () => {
  // 上下室の外周壁（x=0の通り）は腰壁の帯を跨いで上下に続く1枚——妻線も木口線も出さず、
  // 伸びた2本が重なって面線・内側線が連続するのが正しい。
  const knee = buildKneePartitionGraph(900);
  const west = [...knee.g.walls].find(w => w.isVertical && w.materialRange.lo === 0
    && Math.min(w.coord1, w.coord2) > 2000);
  const lines = buildWallDrawPlan(knee.g, LodLevel.DETAIL).wallLines.get(west.id);
  assert.deepEqual(lines.segments, [[1942.5, 4942.5]], '覆うところまでは同じく伸びる');
  assert.equal(lines.endWrapLo, null, '通過点なので取り巻かない');
  assert.equal(lines.capLoSuppressed, true, '妻線も出さない（壁は続いている）');
});

test('【失敗系】buildWallDrawPlan: 切断高さを超える腰壁指定は通常の壁のまま取り合う', () => {
  const tall = buildKneePartitionGraph(1800); // PLAN_CUT_HEIGHT(1500)超＝切断面に切られる
  const lines = buildWallDrawPlan(tall.g, LodLevel.DETAIL).wallLines.get(tall.part.id);
  assert.deepEqual(lines.segments, [[2057.5, 4942.5]], '端部を覆う延長は起きないはず');
  assert.equal(lines.endWrapLo, null);
  assert.equal(lines.capLoSuppressed, true, '切断面まで在る壁どうしなので従来どおり取り合う（キャップ抑止）');
  assert.deepEqual(lines.finSegments, [[2045, 4955]], '内側線は相手の内側線の位置へ寄る（パス2）');
});

// ==== 柱壁（全高）と腰壁の天板 ====
// 天板は壁帯とは別の輪郭で描かれるため、通常の面線カット（faceCuts/colCuts）では守られない
// ——柱壁に占有される区間を描かず、そこへ突き当たる（ユーザー確定2026-09「高い壁が勝つ。
// 柱包みの壁を作って、そこへ腰壁が当たる」）。
const KNEE_OVERLAY = {
  mode: 'knee', capLo: -12, capHi: 69.5,
  capJoins: { lo: { capLoAt: -12, capHiAt: 69.5 }, hi: { capLoAt: 2500, capHiAt: 2400 } },
};

test('resolveWallLines: 天板（capSegments）は柱壁の外形幅で切れる。壁帯のsegmentsは変えない', () => {
  const { hLeft } = buildConcaveGraph(); // スパン[57.5, 2442.5]
  const lines = resolveWallLines(hLeft, { kneeDrop: KNEE_OVERLAY, colCuts: { face: [[1000, 1300]] } });

  assert.deepEqual(lines.capSegments, [[57.5, 1000], [1300, 2442.5]],
    '柱壁の区間だけ天板が抜け、両側に端部（天板幅の線）ができるはず');
  assert.deepEqual(lines.segments, [[57.5, 2442.5]], '壁帯側のスパンは従来どおり無変更');
  assert.deepEqual(lines.capJoins, KNEE_OVERLAY.capJoins, '物理両端は残るので角の取り合いも残る');
});

test('resolveWallLines: 柱壁に切られた端では角の取り合い（capJoins）を落とす', () => {
  const { hLeft } = buildConcaveGraph();
  const lines = resolveWallLines(hLeft, { kneeDrop: KNEE_OVERLAY, colCuts: { face: [[0, 300]] } });

  assert.deepEqual(lines.capSegments, [[300, 2442.5]]);
  assert.equal(lines.capJoins.lo, undefined, '端が柱壁へ移った側は相手の天板ではなく端部の線を描く');
  assert.deepEqual(lines.capJoins.hi, KNEE_OVERLAY.capJoins.hi, '反対の端は影響を受けない');
});

test('【失敗系】resolveWallLines: 柱が無ければ天板は壁帯と同じ区間、腰壁でなければcapJoinsはnull', () => {
  const { hLeft } = buildConcaveGraph();
  const knee = resolveWallLines(hLeft, { kneeDrop: KNEE_OVERLAY });
  assert.deepEqual(knee.capSegments, knee.segments);

  const plain = resolveWallLines(hLeft, {});
  assert.deepEqual(plain.capSegments, plain.segments);
  assert.equal(plain.capJoins, null);
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
  const lines = plan.wallLines.get(kneeWall.id);
  // 素の300角＋層構成102.5×2 ＝ 見付け505mm（x=1747.5〜2252.5）。
  assert.deepEqual(lines.capSegments, [[57.5, 1747.5], [2252.5, 3942.5]]);
  assert.deepEqual(lines.segments, [[57.5, 3942.5]], '壁帯のスパンは変わらない');
});
