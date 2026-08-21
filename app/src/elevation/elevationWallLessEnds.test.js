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

  // 「2」C2（中心3の壁をdM側から見た面）の右端＝中心2: 中心2の壁はy3000..7000で
  // 視点側(y<3000)へ続かない＝切断面を横切らない → 壁のない端部（延長対象）。
  // 実壁自体はある（向こう側へ折れて続く）ため見えがかりエッジ＝縦線（中線）の対象で、
  // 端座標は壁の実端（直交面のfaceValue。ユーザー確認: 中心線位置ではなく実端）へ詰める。
  assert.equal(f2.C2.hasWallAtLocalRun, false, '2のC2右端は壁断面のない端のはず');
  assert.equal(f2.C2.edgeAtLocalRun, true, '2のC2右端は見えがかりエッジ（縦線=中線の対象）のはず');
  assert.equal(f2.C2.lo, 3342.5, 'C2の端は壁の実端（中心2の壁の向こう側面）のはず');

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

test('壁のない端部: 開放スパンの延長端も同じ規則（横切らない直交壁は壁なし・横切る壁あり）で判定される', () => {
  const { graph, room2p } = buildFixture();
  const f2 = byLabel(composeRoomFaces(room2p, graph));

  // B2（中心2の壁をdL側から見た面）は開放スパンで北へ延長され、中心1の壁（切断面を横切る）
  // で終わる → 壁あり
  assert.equal(f2.B2.extendedAtLocal0, true, '前提: B2は開放スパンで北へ延長される');
  assert.equal(f2.B2.hasWallAtLocal0, true, 'B2の延長端は中心1の壁が横切るため壁あり');
  // C2は開放スパンで東へ延長され、X2の壁（横切る）で終わる → 壁あり
  assert.equal(f2.C2.extendedAtLocal0, true, '前提: C2は開放スパンで東へ延長される');
  assert.equal(f2.C2.hasWallAtLocal0, true, 'C2の延長端はX2の壁が横切るため壁あり');
});
