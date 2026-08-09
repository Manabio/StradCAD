// swingSideTowardPerp の符号は OpeningsLayer.jsx swingSymbol の開き角度式
// （closedAngle = isVertical? (towardFar>0?90:-90) : (towardFar>0?0:180) /
//   openAngle = closedAngle + swingSide*90）を三角関数でそのまま再現し、
// dir=(cos,sin) の perp成分（isVertical壁ならx＝world.x、水平壁ならy＝world.y）の符号と
// 突き合わせる——本体側の代数的な簡約式（swingSideTowardPerp）とは別経路の計算のため、
// 符号の取り違えを独立に検出できる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import {
  swingSideTowardPerp, isWallRadialHit, wallRadialHitDist, nearestWallHit, findCounterpartWall, exteriorSideDir,
} from './openingGeometry.js';

function makeGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// OpeningsLayer.jsx swingSymbol の角度式をそのまま複製し、開いた状態(dir)のperp成分符号を返す。
function openDirPerpSign(isVertical, hingeSide, swingSide) {
  const towardFar = hingeSide < 0 ? 1 : -1;
  const closedAngle = isVertical
    ? (towardFar > 0 ? 90 : -90)
    : (towardFar > 0 ? 0 : 180);
  const openAngle = closedAngle + swingSide * 90;
  const rad = (openAngle * Math.PI) / 180;
  // isVertical: toWorld(along,perp)={x:perp,y:along} → world.x が perp成分
  // !isVertical: toWorld(along,perp)={x:along,y:perp} → world.y が perp成分
  const perpComponent = isVertical ? Math.cos(rad) : Math.sin(rad);
  return Math.sign(Math.round(perpComponent * 1e9) / 1e9);
}

test('swingSideTowardPerp: isVertical×hingeSide×swingSideの全8通りでswingSymbolの開き角度式（三角関数で独立計算）と一致する', () => {
  for (const isVertical of [true, false]) {
    for (const hingeSide of [-1, 1]) {
      for (const swingSide of [-1, 1]) {
        const perpDir = openDirPerpSign(isVertical, hingeSide, swingSide);
        const got = swingSideTowardPerp(isVertical, hingeSide, perpDir);
        assert.equal(
          got, swingSide,
          `isVertical=${isVertical}, hingeSide=${hingeSide}, swingSide=${swingSide} → perpDir=${perpDir} から逆算した結果が一致しないはず`,
        );
      }
    }
  }
});

// ---- 失敗系: perpDir=0（境界上ちょうど）でも0/NaNを返さない ----
test('【失敗系】swingSideTowardPerp: perpDir=0でも±1のいずれかを返す（0/NaNにならない）', () => {
  for (const isVertical of [true, false]) {
    for (const hingeSide of [-1, 1]) {
      const got = swingSideTowardPerp(isVertical, hingeSide, 0);
      assert.ok(got === 1 || got === -1, `perpDir=0でも±1を返すはず（実際: ${got}）`);
    }
  }
});

// ================================================================
// isWallRadialHit: 壁ラジアルメニューのヒット域（壁線とその部屋側近傍のみ）
// ================================================================

// 単一の水平壁（既定 axisCL=0, axisOffset=75）。material=[0,75]・axisValue(面線)=75・faceDir=+1
// （面線から見て+y側＝部屋側、材は0〜75の間）。
function makeSingleHorizontalWall(graph, { axisOffset = 75, ...extra } = {}) {
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wall = graph.addWall(axisCL, axisOffset, false, clStart, 0, clEnd, 0, { isExteriorWall: false, ...extra });
  return { wall, axisCL };
}

// isWallRadialHit(wall, perp, thresholdWorld, inwardWorld) の既定引数（テスト共通値）:
// 部屋側許容(threshold)=10mm、材側許容(inward)=2mm。
const THRESHOLD = 10, INWARD = 2;

test('isWallRadialHit: 面線ちょうど(perp=axisValue)は受け付ける', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph);
  assert.equal(isWallRadialHit(wall, 75, THRESHOLD, INWARD), true);
});

test('isWallRadialHit: 面線から部屋側へthreshold内は受け付ける', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph);
  assert.equal(isWallRadialHit(wall, 80, THRESHOLD, INWARD), true, 'axisValue(75)より部屋側(+y)へ5mm、threshold(10)内');
});

test('isWallRadialHit: 部屋側でもthreshold外は弾く', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph);
  assert.equal(isWallRadialHit(wall, 90, THRESHOLD, INWARD), false, 'axisValue(75)から15mm・threshold(10)外');
});

// ---- 材側のわずかな許容（壁線には描画上の太さがあるため、面線から内側へわずかにずれても受け付ける） ----
test('isWallRadialHit: 面線から材側（軸CL方向）へinward許容内は受け付ける', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // axisValue=75, material=[0,75]
  assert.equal(isWallRadialHit(wall, 74, THRESHOLD, INWARD), true, '面線(75)から材側へ1mm・inward(2)内は受け付けるはず');
});

test('【回帰】isWallRadialHit: 面線から材側へinward許容を超えたら弾く（軸CLより手前でも）', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // axisValue=75, material=[0,75]
  // perp=70は軸CL(0)より手前（材の中だが軸CLではない）。inward(2)を超えるため弾くはず。
  assert.equal(isWallRadialHit(wall, 70, THRESHOLD, INWARD), false, '面線(75)から材側へ5mmはinward(2)を超えるため弾くはず');
});

test('isWallRadialHit: 壁組の中央（軸CL上）はinwardを広く取っても必ず弾く（クランプ）', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // axisValue=75, axisCL=0 → |axisOffset|=75
  // inward(1000)は面線〜軸CLの距離(75)より大きいが、軸CL上ちょうど(perp=0)はmin(1000,75)=75の
  // クランプにより「未満」を満たさず必ず弾かれるはず。
  assert.equal(isWallRadialHit(wall, 0, THRESHOLD, 1000), false, '軸CL上はinwardをどれだけ広く取っても弾くはず');
});

test('isWallRadialHit: 材側許容(inward)が面線〜軸CLの距離より広い薄壁でも、軸CL上だけは弾く（クランプの境界値）', () => {
  const graph = makeGraph();
  // 薄壁: axisOffset=3（面線〜軸CLの距離=3mm）。inward(10)はそれより広い → maxInward=min(10,3)=3。
  const { wall } = makeSingleHorizontalWall(graph, { axisOffset: 3 });
  assert.equal(isWallRadialHit(wall, 1, THRESHOLD, 10), true, '軸CL手前(dist=2<3)は受け付けるはず');
  assert.equal(isWallRadialHit(wall, 0, THRESHOLD, 10), false, '軸CLちょうど(dist=3)はクランプにより必ず弾くはず');
});

test('isWallRadialHit: finishSide明示指定のCL偏芯壁は面の向きがfinishSideに従う（naiveなsignの逆）', () => {
  const graph = makeGraph();
  // axisOffset=50(正) だが finishSide=-1 明示 → naiveなsign(+1)とは逆向きが「部屋側」になる。
  const { wall } = makeSingleHorizontalWall(graph, { axisOffset: 50, finishSide: -1 });
  assert.equal(isWallRadialHit(wall, 45, THRESHOLD, INWARD), true, 'naiveには材側(axisValue未満)だがfinishSide=-1では部屋側のはず');
  assert.equal(isWallRadialHit(wall, 55, THRESHOLD, INWARD), false, 'naiveには部屋側(axisValue超)だがfinishSide=-1では材側のはず');
});

test('【失敗系】isWallRadialHit: axisOffset===0の壁でも例外を投げず判定できる（材側許容は常に0）', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph, { axisOffset: 0 }); // axisValue === axisCL.effectiveValue
  assert.doesNotThrow(() => isWallRadialHit(wall, 0, THRESHOLD, INWARD));
  assert.equal(isWallRadialHit(wall, 0, THRESHOLD, INWARD), true, '面線ちょうどは受け付けるはず');
  assert.equal(isWallRadialHit(wall, -1, THRESHOLD, INWARD), false, '材側許容は|axisOffset|=0とのminで常に0になるはず');
});

// ---- 【失敗系】CL偏芯でaxisOffsetとfinishSideの符号が食い違い、軸CLが部屋側に来るケース ----
// finish/clEccentricity.js:227,304 参照: axisOffsetとfinishSideは独立に設定されるため、
// |e|>b/2+f のとき符号が食い違い、faceDirから見て軸CLが材側でなく部屋側に来ることがある。
// axisOffset=-25, finishSide=1（axisCL@0） → axisValue=-25, faceDir=+1（finishSide優先）
// → toCL=(0-(-25))*1=25>0 ＝ 軸CL(0)がfaceDirから見て部屋側(+25mm)に来る異常系。
test('【失敗系】isWallRadialHit: CL偏芯でaxisOffsetとfinishSideの符号が食い違うと、軸CL上（部屋側扱いの位置）は弾く', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph, { axisOffset: -25, finishSide: 1 });
  // 修正前(|axisOffset|依存)なら perp=0(軸CL上)は「部屋側」判定のまま signedDist(25)<thresholdWorld(100)で
  // trueになってしまうはずの回帰ケース。
  assert.equal(isWallRadialHit(wall, 0, 100, 2), false, '軸CL(0)は部屋側方向にあっても弾かれるはず（通り芯に譲る不変条件）');
  // 軸CLの手前（部屋側でtoCL未満）は受け付ける。
  assert.equal(isWallRadialHit(wall, -10, 100, 2), true, '軸CL(0)の手前(perp=-10, axisValueからの距離15<toCL25)は受け付けるはず');
  // 材側（-faceDir方向）はtoCL>0のため許容0——材側許容内(inward=2)でも弾く。
  assert.equal(isWallRadialHit(wall, -26, 100, 2), false, 'toCL>0の異常系では材側許容が常に0になるはず');
});

// ================================================================
// findCounterpartWall / exteriorSideDir: 境界（反対側の壁）を見た外壁判定
// ================================================================

// 1つの境界に2枚のWall（.claude/opening-model.md参照）: 室内向き壁(axisOffset=+75,isExteriorWall:false)
// と外壁本体(axisOffset=-75,isExteriorWall:true、generateExteriorWallsの符号規約=axisOffset逆符号)。
function makeExteriorBoundaryGraph() {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const innerWall = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  const outerWall = graph.addWall(axisCL, -75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  return { graph, innerWall, outerWall };
}

test('findCounterpartWall: 外壁境界の室内向き壁↔外壁は互いを反対側として検出する', () => {
  const { graph, innerWall, outerWall } = makeExteriorBoundaryGraph();
  assert.equal(findCounterpartWall(innerWall, graph)?.id, outerWall.id);
  assert.equal(findCounterpartWall(outerWall, graph)?.id, innerWall.id);
});

test('【失敗系】findCounterpartWall: 反対側の壁が存在しない孤立壁はnullを返す（例外を投げない）', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph);
  assert.equal(findCounterpartWall(wall, graph), null);
});

test('exteriorSideDir: 室内向き壁(isExteriorWall:false)をホストにしても、反対側の外壁の面が向く側（室外側）を返す', () => {
  const { graph, innerWall, outerWall } = makeExteriorBoundaryGraph();
  const expected = -1; // outerWall: axisOffset=-75 → axisValue=-75 → sign(-75-0)=-1
  assert.equal(exteriorSideDir(innerWall, graph), expected);
  assert.equal(exteriorSideDir(outerWall, graph), expected, '外壁自身をホストにしても同じ室外向きになるはず');
});

test('exteriorSideDir: 両側とも内壁（間仕切り境界）はnull（呼び出し側が触れた側をそのまま使う）', () => {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   3000, { labeled: false, discipline: Discipline.ARCH });
  const wallA = graph.addWall(axisCL, 75,  false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  const wallB = graph.addWall(axisCL, -75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  assert.equal(exteriorSideDir(wallA, graph), null);
  assert.equal(exteriorSideDir(wallB, graph), null);
});

test('【失敗系】exteriorSideDir: 反対側の壁が存在しない孤立した内壁は例外を投げずnullを返す', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // isExteriorWall:false, counterpart無し
  assert.doesNotThrow(() => exteriorSideDir(wall, graph));
  assert.equal(exteriorSideDir(wall, graph), null);
});

// ================================================================
// findCounterpartWall / exteriorSideDir: along（押下位置）による区間の絞り込み
// ================================================================
// 1本の境界の背後が途中まで屋外・途中から隣室（segmented）の平面。host: axisOffset=+75,
// span x=0..5000, isExteriorWall:false。相手①間仕切り(x=2000..5000,外壁でない)を「先に」、
// 相手②外壁(x=0..2000)を「後に」登録する——span重なりだけで最初の1本を拾う旧実装なら
// 登録順で結果が変わってしまう（QA実測で再現した回帰）。

function makeSegmentedBoundaryGraph() {
  const graph = makeGraph();
  const axisCL  = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  const clMid   = graph.addCenterLine(CenterLineType.VERTICAL,   2000, { labeled: false, discipline: Discipline.ARCH });
  const clEnd   = graph.addCenterLine(CenterLineType.VERTICAL,   5000, { labeled: false, discipline: Discipline.ARCH });
  const host = graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: false });
  // 相手①（間仕切り区間）を先に登録
  const partition = graph.addWall(axisCL, -75, false, clMid, 0, clEnd, 0, { isExteriorWall: false });
  // 相手②（外壁区間）を後に登録
  const exterior = graph.addWall(axisCL, -75, false, clStart, 0, clMid, 0, { isExteriorWall: true });
  return { graph, host, partition, exterior };
}

test('findCounterpartWall: alongを渡すと、その座標を自スパンに含む候補だけに絞る（登録順に依存しない）', () => {
  const { graph, host, partition, exterior } = makeSegmentedBoundaryGraph();
  assert.equal(findCounterpartWall(host, graph, 500)?.id, exterior.id, 'along=500(外壁区間0..2000内)は外壁側が返るはず');
  assert.equal(findCounterpartWall(host, graph, 3000)?.id, partition.id, 'along=3000(間仕切り区間2000..5000内)は間仕切り側が返るはず');
});

test('exteriorSideDir: alongが外壁区間なら室外向き、間仕切り区間ならnullになる（同一hostで区間により結果が変わる）', () => {
  const { graph, host } = makeSegmentedBoundaryGraph();
  const expectedExteriorDir = -1; // exterior: axisOffset=-75 → axisValue=-75 → sign(-75-0)=-1
  assert.equal(exteriorSideDir(host, graph, 500), expectedExteriorDir, 'along=500は外壁区間なので室外向きを返すはず');
  assert.equal(exteriorSideDir(host, graph, 3000), null, 'along=3000は間仕切り区間なのでnullのはず');
});

test('exteriorSideDir: along省略時（null）は従来どおりspanが重なる最初の候補で判定する', () => {
  const { graph, host } = makeSegmentedBoundaryGraph();
  // along省略時はfindCounterpartWallのgraph.walls登録順（partitionが先）に依存する現行挙動を維持する。
  assert.equal(exteriorSideDir(host, graph), null, 'along省略時は先に登録された間仕切り(partition)が拾われnullになるはず');
});

// ================================================================
// nearestWallHit / wallRadialHitDist: findNearestWall の壁ループ本体（node:test対応の切り出し）
// snap.js は store.js を静的importするためnode:testから単体importできないため、ここでテストする。
// ================================================================

test('nearestWallHit: 垂直壁はscaleX・水平壁はscaleYでpx⇔mm換算する（軸を取り違えると反転検出される）', () => {
  const thresholdPx = 8, scaleX = 0.1, scaleY = 1.0, inwardPx = 2;
  // scaleXが小さい(0.1)ため、垂直壁は世界距離50mmでもpx換算では5px(<8px)でヒットするはず。
  const gV = makeGraph();
  const xCL = gV.addCenterLine(CenterLineType.VERTICAL,   1000, { labeled: false, discipline: Discipline.ARCH });
  const y0  = gV.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1  = gV.addCenterLine(CenterLineType.HORIZONTAL, 5000, { labeled: false, discipline: Discipline.ARCH });
  const vWall = gV.addWall(xCL, 75, true, y0, 0, y1, 0, { isExteriorWall: false, isRoomWall: true }); // axisValue=1075,faceDir=+1
  const vHit = nearestWallHit(gV.walls, 1125, 2500, thresholdPx, scaleX, scaleY, inwardPx); // wx=axisValue+50(部屋側)
  assert.equal(vHit?.id, vWall.id, 'scaleX(0.1)換算で50mmは5px(<8px)のはずなのでヒットする');

  // scaleYは1.0のため、水平壁は同じ世界距離50mmだとpx換算50px(>=8px)で弾かれるはず。
  const gH = makeGraph();
  makeSingleHorizontalWall(gH, { isRoomWall: true }); // axisValue=75,faceDir=+1
  const hHit = nearestWallHit(gH.walls, 1500, 125, thresholdPx, scaleX, scaleY, inwardPx); // wy=axisValue+50(部屋側)
  assert.equal(hHit, null, 'scaleY(1.0)換算で50mmは50px(>=8px)のはずなので弾かれる（軸を取り違えるとここが反転してヒットしてしまう）');
});

test('nearestWallHit: 材側で棄却された近い壁が、部屋側の遠い壁を隠さない（登録順を両方向で試す）', () => {
  // wallNear: axisValue=50,faceDir=+1（材[0,50]）。press(y=47)は材側へ3mm＝inward(2)超で棄却される
  // （raw距離3pxはwallFarの6pxより近いが、棄却されるためminDistを更新してはならない）。
  // wallFar: axisValue=53,faceDir=-1。press(y=47)は部屋側(y<=53)へ6mm＝threshold(8)内で採用される。
  function buildGraph(order) {
    const graph = makeGraph();
    const axisCLNear = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,   { labeled: false, discipline: Discipline.ARCH });
    const axisCLFar   = graph.addCenterLine(CenterLineType.HORIZONTAL, 100, { labeled: false, discipline: Discipline.ARCH });
    const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
    const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3000, { labeled: false, discipline: Discipline.ARCH });
    const near = () => graph.addWall(axisCLNear, 50,  false, x0, 0, x1, 0, { isExteriorWall: false, isRoomWall: true });
    const far  = () => graph.addWall(axisCLFar, -47, false, x0, 0, x1, 0, { isExteriorWall: false, isRoomWall: true });
    const walls = order === 'nearFirst' ? [near(), far()] : [far(), near()];
    return { graph, farWall: walls.find(w => Math.abs(w.axisValue - 53) < 1e-6) };
  }

  for (const order of ['nearFirst', 'farFirst']) {
    const { graph, farWall } = buildGraph(order);
    const hit = nearestWallHit(graph.walls, 1500, 47, 8, 1, 1, 2);
    assert.equal(hit?.id, farWall.id, `登録順(${order})によらず、部屋側の遠い壁(wallFar)が採用されるはず`);
  }
});

test('【失敗系】nearestWallHit: graph.wallsが空配列でも例外を投げずnullを返す', () => {
  assert.doesNotThrow(() => nearestWallHit([], 0, 0, 8, 1, 1, 2));
  assert.equal(nearestWallHit([], 0, 0, 8, 1, 1, 2), null);
});

test('wallRadialHitDist: isRoomWall指定はnearestWallHit側の責務（wallRadialHitDist自体はisRoomWallを見ない）', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // isRoomWall指定なし(既定false)
  // wallRadialHitDistは壁1本の当たり判定のみを担い、isRoomWallフィルタはnearestWallHitの責務。
  const dist = wallRadialHitDist(wall, 1500, 75, 8, 1, 1, 2);
  assert.equal(dist, 0, '面線ちょうどはヒットしdist=0を返すはず（isRoomWall値に関係なく）');
});

// ---- QAミューテーション指摘: nearestWallHitのisRoomWallフィルタが未カバーだった（267件全緑で通過） ----
test('nearestWallHit: isRoomWall:false の壁は面線ちょうどでもヒット候補から除外される', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // isRoomWall指定なし(既定false)
  assert.equal(nearestWallHit(graph.walls, 1500, 75, 8, 1, 1, 2), null, 'isRoomWall:falseはnearestWallHitでは弾かれるはず');
  // フィルタの所在を特定できるよう、wallRadialHitDist単体はisRoomWallを見ずヒットすることも併せて確認する。
  assert.equal(wallRadialHitDist(wall, 1500, 75, 8, 1, 1, 2), 0, 'wallRadialHitDist単体はisRoomWallに関係なくdist=0を返すはず');
});

// ---- QAミューテーション指摘: wallRadialHitDistのalong(span)判定が未カバーだった（267件全緑で通過） ----
test('wallRadialHitDist: alongが壁のspan外なら面線ちょうどでもnullを返す（境界値along=0/3000は含む）', () => {
  const graph = makeGraph();
  const { wall } = makeSingleHorizontalWall(graph); // span x=0..3000（clStart=0, clEnd=3000）
  assert.equal(wallRadialHitDist(wall, 3500, 75, 8, 1, 1, 2), null, 'along=3500はspan外(0..3000超)なのでnullのはず');
  assert.equal(wallRadialHitDist(wall, -500, 75, 8, 1, 1, 2), null, 'along=-500はspan外(0..3000未満)なのでnullのはず');
  assert.equal(wallRadialHitDist(wall, 0, 75, 8, 1, 1, 2), 0, 'along=0は端点として含む（閉区間）のでヒットするはず');
  assert.equal(wallRadialHitDist(wall, 3000, 75, 8, 1, 1, 2), 0, 'along=3000は端点として含む（閉区間）のでヒットするはず');
});
