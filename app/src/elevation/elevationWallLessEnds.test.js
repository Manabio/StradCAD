// 壁のない端部（壁断面のない中心線で終わる図の端部）の判定テスト。
// ユーザー報告2026-08の実機シナリオ（7000×7000・部分指定2組・L字部屋）を再現し、
// 「面端の直交面に実壁があっても、その壁がこの面の切断面を室内側へ横切っていなければ
// 図の端部に壁断面は現れない＝壁のない端部（床・天井線を図の外側へ延長する続きがある表現）」
// を面単位で固定する。旧実装は直交面の実壁の有無だけで判定しており、壁が面の向こう側だけに
// ある端（報告: 2'のC2右端・3'のB1右端・3'のD1左端）で延長が描かれなかった。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline, resolveBackingOwnership } from '../finish/wallGeneration.js';
import { worldToCell } from '../finish/gridCells.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { drawnSpanRanges } from './elevationFaces.js';
import { buildFaceFigure } from './elevationFigure.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

// ユーザーシナリオ: X1/X2/Y1/Y2の7000角、中心1〜中心7（中心2上端短縮・中心6上端延長）、
// 部屋1(a)・2'(c+d+b, FL-50)＋部分指定2(b)・3'(e+f+g, FL+100)＋部分指定3(g)・4(h)。
function buildFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const add = (type, value, opts = {}) => graph.addCenterLine(type, value, { ...ARCH, ...opts });
  add(CenterLineType.VERTICAL, 0);
  add(CenterLineType.VERTICAL, 7000);
  add(CenterLineType.HORIZONTAL, 0);
  add(CenterLineType.HORIZONTAL, 7000);
  add(CenterLineType.HORIZONTAL, 2000);                                     // 中心1
  add(CenterLineType.VERTICAL, 3400, { extentLo: 3000, extentHi: 7000 });   // 中心2
  add(CenterLineType.HORIZONTAL, 3000, { extentLo: 3400, extentHi: 7000 }); // 中心3
  add(CenterLineType.HORIZONTAL, 4000, { extentLo: 3400, extentHi: 7000 }); // 中心4
  add(CenterLineType.VERTICAL, 4600, { extentLo: 3000, extentHi: 4000 });   // 中心5
  add(CenterLineType.VERTICAL, 6000, { extentLo: 2000, extentHi: 4000 });   // 中心6
  add(CenterLineType.HORIZONTAL, 3400, { extentLo: 6000, extentHi: 7000 }); // 中心7

  const key = (x, y) => worldToCell(x, y, graph).key;
  const room1  = graph.addRoom(new Set([key(3500, 1000)]), '1'); // a
  const room2p = graph.addRoom(new Set([
    key(6500, 2500), key(1700, 3500), key(5000, 2500), key(6500, 3200), // c, dL, dM, b
  ]), "2'");
  room2p.setFloorLevel(-50);
  graph.addRoom(new Set([key(6500, 3200)]), '2', undefined, new Set([room2p.id])); // 部分指定2=b
  const room3p = graph.addRoom(new Set([
    key(6500, 3700), key(5200, 5500), key(4000, 3500), // e, f, g
  ]), "3'");
  room3p.setFloorLevel(100);
  graph.addRoom(new Set([key(4000, 3500)]), '3', undefined, new Set([room3p.id])); // 部分指定3=g
  const room4 = graph.addRoom(new Set([key(5300, 3500)]), '4'); // h

  const walls = [];
  for (const room of [room1, room2p, room3p, room4]) {
    walls.push(...generateRoomWallsFromOutline(graph, room));
  }
  resolveBackingOwnership(graph, walls);
  return { graph, room1, room2p, room3p, room4 };
}

function byLabel(faces) {
  return Object.fromEntries(faces.map(f => [f.label ?? f.kind, f]));
}

test('壁のない端部: 報告された3箇所（2 C2右・3 B1右・3 D1左）が壁断面のない中心線として延長対象になる', () => {
  const { graph, room2p, room3p } = buildFixture();
  const f2 = byLabel(composeRoomFaces(room2p, graph));
  const f3 = byLabel(composeRoomFaces(room3p, graph));

  // 注: 中心7（y=3400・x6000..7000）の面は、その手前の中心3（y=3000）の面に**見えがかりとして
  // 取り込まれる**ため面リストから落ちる（ユーザー明示指示2026-08「見えがかりに取り込まれた面は
  // 常に落とす」。elevationFaceList.jsのdropFacesSeenAsSightline）。その結果、中心3の面のletter内
  // 採番はC2→C1へ繰り上がっている。
  // 「2」C1（中心3の壁をdM側から見た面）の右端＝中心2: 中心2の壁はy3000..7000で
  // 視点側(y<3000)へ続かない＝切断面を横切らない → 壁のない端部（延長対象）。
  // 実壁自体はある（向こう側へ折れて続く）ため見えがかりエッジ＝縦線（中線）の対象で、
  // 端座標は壁の実端（直交面のfaceValue。ユーザー確認: 中心線位置ではなく実端）へ詰める。
  assert.equal(f2.C1.hasWallAtLocalRun, false, '2のC1右端は壁断面のない端のはず');
  assert.equal(f2.C1.edgeAtLocalRun, true, '2のC1右端は見えがかりエッジ（縦線=中線の対象）のはず');
  assert.equal(f2.C1.lo, 3342.5, 'C1の端は壁の実端（中心2の壁の向こう側面）のはず');

  // 「3」B1（中心5の壁をg側から見た面）の右端＝中心4: f|h壁はx4600..6000で面の向こう側のみ
  assert.equal(f3.B1.hasWallAtLocalRun, false, '3のB1右端は壁断面のない端のはず');
  assert.equal(f3.B1.edgeAtLocalRun, true, '3のB1右端は見えがかりエッジのはず');
  assert.equal(f3.B1.hi, 4057.5, 'B1の端は壁の実端（f|h壁の面位置）のはず');

  // 「3」D1（中心6の壁をe側から見た面）の左端＝中心4: 同上（x>6000側に壁なし）
  assert.equal(f3.D1.hasWallAtLocal0, false, '3のD1左端は壁断面のない端のはず');
  assert.equal(f3.D1.edgeAtLocal0, true, '3のD1左端は見えがかりエッジのはず');
  assert.equal(f3.D1.hi, 4057.5, 'D1の端は壁の実端のはず');
});

test('壁のない端部: 壁が切断面を横切る通常の隅は従来どおり壁あり（誤検出しない）', () => {
  const { graph, room1, room2p, room3p, room4 } = buildFixture();
  const f1 = byLabel(composeRoomFaces(room1, graph));
  const f2 = byLabel(composeRoomFaces(room2p, graph));
  const f3 = byLabel(composeRoomFaces(room3p, graph));
  const f4 = byLabel(composeRoomFaces(room4, graph));

  // 矩形部屋（1・4）の全隅は壁あり
  for (const f of [f1.A, f1.B, f1.C, f1.D, f4.A, f4.B, f4.C, f4.D]) {
    assert.equal(f.hasWallAtLocal0, true);
    assert.equal(f.hasWallAtLocalRun, true);
  }
  // 「3」A1（gの北壁）: 両端とも直交壁（中心2・中心5）が視点側を通る＝壁あり
  assert.equal(f3.A1.hasWallAtLocal0, true);
  assert.equal(f3.A1.hasWallAtLocalRun, true);
  // 「2」D1（中心6の壁をc/b側から見た面）の北端: 中心1の壁は切断面を横切る（視点側の
  // 部屋の北壁として続く）ため壁あり＝延長しない
  assert.equal(f2.D1.hasWallAtLocalRun, true, '2のD1北端は中心1の壁が切断面を横切るため壁あり');
  // 段差見付け面（3のC1相当。kind='step'）は本仕様の対象外（両端縦線の扱いは従来どおり）
  const step = composeRoomFaces(room3p, graph).find(f => f.kind === 'step');
  assert.ok(step, '前提: g|f段差の見付け面が挿入される');
});

// ---- 描画レベル: 症状そのもの（床・天井線の延長とエッジ縦線）を buildFaceFigure の出力で固定 ----
test('壁のない端部: 床線・天井線がextendMmぶん図の外側へ伸び、見えがかりエッジの縦線（中線）が描かれる', () => {
  const { graph, room3p } = buildFixture();
  const faces = composeRoomFaces(room3p, graph);
  const b1 = faces.find(f => f.label === 'B1'); // 右端（中心4側）が壁のない端部（エッジあり）
  const extendMm = 150;
  const CH = 2400;
  const prims = buildFaceFigure(b1, {
    graph, project: { openingNumberIndex: new Map() },
    room: room3p, ceilingHeight: CH, materialMap: new Map(), gridCLs: [],
    wallLessEndExtendModelMm: extendMm,
  });
  const ceiling = prims.find(p => p.type === 'line' && p.y1 === -CH && p.y2 === -CH && p.x2 - p.x1 > 100);
  assert.ok(ceiling, '天井線が見つからない');
  assert.equal(ceiling.x2, b1.run + extendMm, '天井線は壁のない端の外側へextendMmぶん延長されるはず');
  const floorLines = prims.filter(p => p.type === 'line' && p.y1 === p.y2 && p.y1 !== -CH && p.x2 - p.x1 > 100);
  assert.ok(floorLines.some(p => p.x2 === b1.run + extendMm), '床線も同様に延長されるはず');
  // 見えがかりエッジの縦線（中線=SILHOUETTE）は描く（ユーザー明示指示2026-08）。
  // 注記帯のCL一点鎖線（dashあり）と区別するため実線のみを対象にする。
  const edgeLine = prims.find(p => p.type === 'line' && !p.dash && p.x1 === b1.run && p.x2 === b1.run);
  assert.ok(edgeLine, '壁のない端（run端）に見えがかりエッジの縦線が描かれるはず');
  assert.equal(edgeLine.weight, 'medium', 'エッジ縦線は中線（SILHOUETTE）のはず');
  assert.equal(edgeLine.y1, -CH, 'エッジ縦線は天井から');
  assert.equal(edgeLine.y2, 0, 'エッジ縦線は床まで');
});

test('壁のない端部: edgeフラグの無い端（実壁自体が無い端の描画分岐）は縦線を描かない', () => {
  // 描画側分岐の検証: hasWallAtLocalRun=false かつ edgeAtLocalRun=false なら縦線なし。
  // （階段上り口等の実データでこのフラグ組になることは snapFaceEndsToCorners の
  // realAtLo/Hi=false → edge=false 経路が担う——elevationFaces.test.js の既存テスト参照）
  const { graph, room3p } = buildFixture();
  const faces = composeRoomFaces(room3p, graph);
  const b1 = { ...faces.find(f => f.label === 'B1'), edgeAtLocalRun: false };
  const prims = buildFaceFigure(b1, {
    graph, project: { openingNumberIndex: new Map() },
    room: room3p, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
    wallLessEndExtendModelMm: 150,
  });
  assert.ok(!prims.some(p => p.type === 'line' && !p.dash && p.x1 === b1.run && p.x2 === b1.run),
    'エッジの無い壁なし端には縦線（実線）を描かないはず');
});

test('壁のない端部: 壁断面を描かない端には直交壁の建具断面も描かない（QA指摘）', () => {
  const { graph, room3p } = buildFixture();
  const faces = composeRoomFaces(room3p, graph);
  const i = faces.findIndex(f => f.label === 'B1');
  const b1 = faces[i];
  // B1の右端（中心4）の隣接面A2側に、その隅へ届く建具を置く。壁断面が現れない端のため
  // 建具の[枠][扉][枠]断面も描かれないはず（旧実装は隅共有前提のガードのみで描いてしまった）。
  const nextFace = faces.find(f => f.label === 'A2');
  const c4 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.HORIZONTAL && cl.value === 4000);
  const x1cl = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  graph.addOpening(c4, 1, false, x1cl, nextFace.lo + 300, 800, OpeningCategory.FITTING, 'singleSwing', {});
  const prims = buildFaceFigure(b1, {
    graph, project: { openingNumberIndex: new Map() },
    room: room3p, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
    nextFace, wallLessEndExtendModelMm: 150,
  });
  assert.ok(!prims.some(p => p.type === 'rect' && p.h === 2000),
    '壁のない端には建具断面の[枠][扉][枠]rectを描かないはず');
});

// ---- 床断面より下にある向こう側の断面は細線の破線（ユーザー明示指示2026-08） ----
// 「3」のA2面（中心4の壁をf側から見た面）の1200区間＝g領域の開放スパン（far床が100低い）。
test('開放スパン: 床断面より下の遠側床線と端部の縦線は細線の破線で、角が交点で接続する', () => {
  const { graph, room3p } = buildFixture();
  const faces = composeRoomFaces(room3p, graph);
  const a2 = faces.find(f => f.label === 'A2');
  // 描画位置は内部境界を「壁厚×1/2だけ開放側」へずらした値（drawnSpanRanges。ユーザー実機指摘2026-08）。
  const gIdx = a2.spans.findIndex(s => s.kind === 'open' && s.farFloorDeltaMm === -100);
  const gSpan = gIdx < 0 ? null : { ...a2.spans[gIdx], ...drawnSpanRanges(a2, graph)[gIdx] };
  assert.ok(gSpan, '前提: A2にg領域の開放スパン（far床-100）がある');

  const prims = buildFaceFigure(a2, {
    graph, project: { openingNumberIndex: new Map() },
    room: room3p, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
    wallLessEndExtendModelMm: 150,
  });

  // 遠側床線（y=+100=床断面より下）: 細線の破線が「1本だけ」（重複描画がないことまで固定する。
  // かつてはアキ矩形の実線が同座標に重なると細破線が覆われて見えなくなる問題があった——
  // 矩形は後に廃止したが、重複を作らないという要求自体は変わらない）
  const farLines = prims.filter(p => p.type === 'line' && p.y1 === 100 && p.y2 === 100 && p.x2 - p.x1 > 100);
  assert.equal(farLines.length, 1, '床断面下の遠側床線は1本だけのはず（重複描画なし）');
  const farLine = farLines[0];
  assert.equal(farLine.weight, 'thin', '床断面より下の遠側床線は細線のはず');
  assert.equal(farLine.dash, 'dashed', '床断面より下の遠側床線は破線のはず');
  assert.equal(farLine.x1, gSpan.loX);
  assert.equal(farLine.x2, gSpan.hiX);

  // アキ標記の範囲は近側床（床断面=y0）まで（far床まで伸ばすとバツが床断面下の細破線の領域へ
  // 入り込む）。輪郭の矩形は描かない（ユーザー明示指示「矩形をやめて」）のでバツで見る。
  assert.equal(prims.filter(p => p.type === 'rect').length, 0, 'アキの輪郭の矩形は描かないはず');
  const gapDiag = prims.filter(p => p.type === 'line' && p.dash === 'center'
    && Math.min(p.x1, p.x2) === gSpan.loX && Math.max(p.x1, p.x2) === gSpan.hiX);
  assert.ok(gapDiag.length >= 1, 'アキのバツが見つからない');
  const gapYs = [...new Set(gapDiag.flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);
  assert.deepEqual(gapYs, [-2400, 0], 'アキは天井(-2400)〜近側床（床断面=0）までのはず');

  // 端部の縦線（far床+100〜床断面0）: 同じ細線の破線が両端にあり、遠側床線と角で交わる。
  // 始点は角（far床側）——破線の位相が角から始まり「破線同士の角は必ず破線の交点」になる
  for (const x of [gSpan.loX, gSpan.hiX]) {
    const edge = prims.find(p =>
      p.type === 'line' && p.x1 === x && p.x2 === x && p.y1 === 100 && p.y2 === 0);
    assert.ok(edge, `x=${x} に床断面下の縦線（角起点）が見つからない`);
    assert.equal(edge.weight, 'thin', '床断面下の縦線は細線のはず');
    assert.equal(edge.dash, 'dashed', '床断面下の縦線は破線のはず');
    // 角の接続: 縦線の始点(y1=100)が遠側床線のyと厳密に一致（破線同士の角＝交点）
    assert.equal(edge.y1, farLine.y1);
  }
});

test('開放スパン: 床〜天井の間に見える遠側床線（見上げ方向）は従来どおり中線の実線のまま', () => {
  const { graph, room2p } = buildFixture();
  const faces = composeRoomFaces(room2p, graph);
  // 中心3（y=3000）の面。中心7の面が見えがかりに取り込まれて落ちるためC1へ繰り上がっている
  // （dropFacesSeenAsSightline）。
  const c2 = faces.find(f => f.label === 'C1'); // b領域の開放スパン（far床+50=見上げ方向）
  const bSpan = c2.spans.find(s => s.kind === 'open' && s.farFloorDeltaMm === 50);
  assert.ok(bSpan, '前提: この面にb領域の開放スパン（far床+50）がある');

  const prims = buildFaceFigure(c2, {
    graph, project: { openingNumberIndex: new Map() },
    room: room2p, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
    wallLessEndExtendModelMm: 150,
  });
  const farLine = prims.find(p => p.type === 'line' && p.y1 === -50 && p.y2 === -50 && p.x2 - p.x1 > 100);
  assert.ok(farLine, '遠側床線が見つからない');
  assert.equal(farLine.weight, 'medium', '見上げ方向の遠側床線は中線のまま');
  assert.equal(farLine.dash, undefined, '見上げ方向の遠側床線は実線のまま');
  // 床断面下の細線縦線は見上げ方向には出ない
  assert.ok(!prims.some(p => p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed'
    && p.x1 === p.x2 && (p.x1 === bSpan.loX || p.x1 === bSpan.hiX) && p.y2 === -50),
    '見上げ方向には床断面下の縦線を描かないはず');
});

test('壁のない端部: 開放スパンの延長端も同じ規則（横切らない直交壁は壁なし・横切る壁あり）で判定される', () => {
  const { graph, room2p } = buildFixture();
  const f2 = byLabel(composeRoomFaces(room2p, graph));

  // B2（中心2の壁をdL側から見た面）は開放スパンで北へ延長され、中心1の壁（切断面を横切る）
  // で終わる → 壁あり
  assert.equal(f2.B2.extendedAtLocal0, true, '前提: B2は開放スパンで北へ延長される');
  assert.equal(f2.B2.hasWallAtLocal0, true, 'B2の延長端は中心1の壁が横切るため壁あり');
  // 中心3の面（C1へ繰り上がり）は開放スパンで東へ延長され、X2の壁（横切る）で終わる → 壁あり
  assert.equal(f2.C1.extendedAtLocal0, true, '前提: この面は開放スパンで東へ延長される');
  assert.equal(f2.C1.hasWallAtLocal0, true, 'その延長端はX2の壁が横切るため壁あり');
});

// ---- 実機指摘2026-08「C1のX2上に線はなく、C1からC2へ至る間にもエッジはない。
// 比較的単純なプローブに思う。判定方法をよく確認してみて」 ----
// 根本原因: 隅の「実壁あり」判定に、直交面の**面全体**のフラグ（hasRealWall＝面のスパン全域で
// 壁を1本でも見つけたか）を流用していた。直交面の遠い側にだけ壁がある構成では、何も無い隅が
// 「壁あり」と誤判定され、線が描かれていた。判定を隅の周り±100mmの局所プローブへ改める。
function buildFarWallFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const add = (type, value) => graph.addCenterLine(type, value, ARCH);
  const x0 = add(CenterLineType.VERTICAL, 0);
  const x1 = add(CenterLineType.VERTICAL, 4000);
  const y0 = add(CenterLineType.HORIZONTAL, 0);
  const yMid = add(CenterLineType.HORIZONTAL, 2000);
  const y1 = add(CenterLineType.HORIZONTAL, 3000);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'いま');
  // 壁は手で置く（外周自動生成だと全辺フル長になり、この構成を作れない）。
  graph.addWall(y0, 57.5, false, x0, 0, x1, 0, {});   // A（上辺）フル長
  graph.addWall(y1, -57.5, false, x0, 0, x1, 0, {});  // C（下辺）フル長
  graph.addWall(x1, -57.5, true, y0, 0, y1, 0, {});   // B（右辺）フル長
  // D（左辺）は yMid〜y1 だけ＝A面との隅（y≈0）には壁材が無い。
  graph.addWall(x0, 57.5, true, yMid, 0, y1, 0, {});
  return { graph, room, x0, y0, yMid, y1 };
}

test('【実機指摘】隅の実壁判定は局所プローブ: 直交面の遠い側にだけ壁がある隅は「壁なし」になる', () => {
  const { graph, room } = buildFarWallFixture();
  const faces = byLabel(composeRoomFaces(room, graph));
  const faceA = faces.A;
  assert.ok(faceA, 'A面が得られるはず');
  // A面の左隅（x=0＝D面の軸）にはD壁が届いていない。
  assert.equal(faceA.hasWallAtLocal0, false, 'A面の左隅は壁断面なしのはず');
  assert.equal(faceA.edgeAtLocal0, false,
    'A面の左隅は見えがかりエッジでもない（壁材がそもそも隅に無い）はず');
  // 図としても縦線が出ない（床・天井の延長だけ）。
  const prims = buildFaceFigure(faceA, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400,
    materialMap: null, gridCLs: [], wallLessEndExtendModelMm: 150,
  });
  const leftVerticals = prims.filter(p =>
    p.type === 'line' && p.x1 === p.x2 && Math.abs(p.x1) < 1e-6 && p.weight !== 'thin');
  assert.equal(leftVerticals.length, 0, '隅に壁が無ければ縦線は描かれないはず');
});

test('【失敗系・実機指摘】同じ構成でも隅まで壁が届いていれば従来どおり壁ありになる', () => {
  const { graph, room, x0, y0, y1 } = buildFarWallFixture();
  // D壁を隅（y=0）まで届く長さへ置き換える。
  for (const w of graph.walls.filter(w => w.isVertical && w.axisCL.id === x0.id)) graph.removeShape(w.id);
  graph.addWall(x0, 57.5, true, y0, 0, y1, 0, {});
  const faceA = byLabel(composeRoomFaces(room, graph)).A;
  assert.equal(faceA.hasWallAtLocal0, true, '隅まで壁が届けば従来どおり壁断面ありのはず');
});

// ---- 実機指摘2026-08「「5」C2：X2上にエッジ線が消えていない／アキ・バツも残っている」 ----
// 実機の診断ログで確定した原因: 5/C2 は `hw0=F`（壁のない端部）に開放スパン(0..400)が接しており、
// そこへ appendGapMark が矩形（中線の輪郭）＋対角線2本＋「ア キ」を積んでいた。矩形の左辺が
// 面端ちょうどの縦線として現れ、「X2上のエッジ線」に見えていた（エッジ線とアキは同一の標記）。
// 壁のない端部は床・天井の延長で既に「続きがある」ことを表しているため、アキは重ねない。
// 実機5/C2と同じ入力（hw0=F の端に接する開放スパン）を面へ直接与えて描画規則を固定する。
// 面のトポロジー（なぜhw0=Fになるか）は本ファイルの他のテストが別途固定しているため、
// ここは「その入力のときアキを描かない」という描画側の規則だけを対象にする。
function faceWithOpenSpanAtWallLessEnd(overrides = {}) {
  return {
    axisCL: { id: 'axisY0', effectiveValue: 0 }, isVertical: false, inward: -1, faceValue: 0,
    lo: 0, hi: 3142.5, run: 3142.5, dirSign: -1, originWorld: 3142.5,
    startCLId: 'x0', endCLId: 'x1', label: 'C2',
    hasWallAtLocal0: false, hasWallAtLocalRun: true,
    edgeAtLocal0: false, edgeAtLocalRun: false,
    spans: [
      { kind: 'open', loX: 0, hiX: 400, farFloorDeltaMm: 0 },
      { kind: 'wall', loX: 400, hiX: 3142.5 },
    ],
    ...overrides,
  };
}

const FIG_CTX = {
  graph: { openings: [], walls: [], kneeDropWalls: new Map(), shapeMap: new Map(), centerLines: [] },
  project: { openingNumberIndex: new Map() },
  room: { getFinishInfo: () => ({}), finish: null },
  ceilingHeight: 2400, materialMap: null, gridCLs: [], wallLessEndExtendModelMm: 150,
};

test('【実機指摘】開放スパンが壁のない端部に接する面では、アキ（矩形・バツ・「ア キ」）を描かない', () => {
  const prims = buildFaceFigure(faceWithOpenSpanAtWallLessEnd(), FIG_CTX);
  assert.equal(prims.filter(p => p.type === 'text' && p.text === 'ア キ').length, 0,
    'アキの文字は描かれないはず');
  assert.equal(prims.filter(p => p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2 && p.dash === 'center').length, 0,
    'アキのバツ（対角線）は描かれないはず');
  assert.equal(prims.filter(p => p.type === 'rect').length, 0,
    'アキ矩形（その辺が面端の縦線に見える）も描かれないはず');
  // 床・天井の延長は従来どおり残る（ユーザー「天井と床の延長は、このままで良い」）。
  const floorLine = prims.find(p => p.type === 'line' && p.weight === 'thick' && p.y1 === p.y2 && p.y1 === 0);
  assert.ok(floorLine && Math.min(floorLine.x1, floorLine.x2) === -150,
    '壁のない端部の延長(150mm)は残るはず');
});

test('【失敗系・実機指摘】同じ面でもその端に壁があれば従来どおりアキを描く', () => {
  const prims = buildFaceFigure(faceWithOpenSpanAtWallLessEnd({ hasWallAtLocal0: true }), FIG_CTX);
  assert.equal(prims.filter(p => p.type === 'text' && p.text === 'ア キ').length, 1,
    '端が壁で閉じていればアキは従来どおり描かれるはず');
});

test('【失敗系・実機指摘】開放スパンの両端が壁で閉じていれば従来どおりアキを描く', () => {
  const { graph, room } = buildFixture(); // Round F（10/B2・11'/A2等と同型: 端に壁がある開放スパン）
  const withGap = [];
  for (const r of [room, ...[]]) void r;
  for (const rm of graph.rooms) {
    for (const f of composeRoomFaces(rm, graph)) {
      const open = (f.spans ?? []).find(s => s.kind === 'open');
      if (!open) continue;
      const touchesWallLess = (!f.hasWallAtLocal0 && Math.abs(open.loX) < 1) ||
        (!f.hasWallAtLocalRun && Math.abs(open.hiX - f.run) < 1);
      if (touchesWallLess) continue;
      const prims = buildFaceFigure(f, {
        graph, project: { openingNumberIndex: new Map() }, room: rm, ceilingHeight: 2400,
        materialMap: null, gridCLs: [],
      });
      if (prims.some(p => p.type === 'text' && p.text === 'ア キ')) withGap.push(`${rm.name}/${f.label}`);
    }
  }
  assert.ok(withGap.length > 0, `端が壁で閉じた開放スパンではアキが残るはず（実際:${withGap}）`);
});
