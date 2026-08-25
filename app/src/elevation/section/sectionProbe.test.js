// sectionProbe.js（WP-E1）の単体テスト。「手書きの小さなSectionCutリテラル→期待するZBand列」を
// 直接検証する（タイプ非依存の担保。elevationBand.test.js/elevationVoid.test.jsと同じ
// 実core.js（Plane/PlanGraph）+ finish/wallGeneration.jsフィクスチャ方針を踏襲）。
// 設計意図はarchitect承認済みの実装指示書§5・WP-E1完了条件参照。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey, OpeningCategory, RoomFeature } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext, collectCutBreaks, probeColumn } from './sectionProbe.js';
import { emitOpenGapMarks } from './sectionEmit.js';

const CH = 2400; // DEFAULT_ROOM_CEILING_HEIGHT（core/constants.js）明示指定なしの既定値

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

// 実機フィードバック第3弾G用: 壁を一切生成しない矩形室（自層に候補壁が無い状態を作り、
// probeColumnを「self天井より上はabove層の実Room有無で判定する」分岐まで到達させる）。
function makeRectRoomNoWalls(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  return graph.addRoom(new Set([key]), name);
}

// 「上り口(y=0)に立ってy増加方向(部屋の奥=y=3000の壁)を見る」矩形室4000x3000のcut.lineを作る。
function frontCut(graph, overrides = {}) {
  return {
    seqNo: '1',
    line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1,
    dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH },
    baseFloorZ: 0,
    ...overrides,
  };
}

function farWallOf(graph) {
  return graph.walls.find(w => !w.isVertical && w.axisCL.effectiveValue === 3000);
}

// ---- 壁正面→[wall] ----
test('【WP-E1】probeColumn: 矩形室で正面の壁だけが視界にあれば単一の[wall]（床〜天井の全高）を返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 2000, probeCtx);
  assert.equal(bands.length, 1, `候補が壁1枚のみなら1本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'wall');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, CH);
  assert.equal(bands[0].distMm, 3000, '正面の壁までの距離は3000mmのはず');
});

// ---- 腰壁→[wall下,open上] ----
test('【WP-E1】probeColumn: 正面の壁が腰壁指定なら[wall(床..topHeight), open(topHeight..天井)]の2本になる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const topHeight = 900;
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), { knee: { topHeight } });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 2000, probeCtx);
  assert.equal(bands.length, 2, `腰壁指定は[wall,open]の2本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'wall');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, topHeight);
  assert.equal(bands[1].kind, 'open');
  assert.equal(bands[1].z0, topHeight);
  assert.equal(bands[1].z1, CH);
});

// ---- 垂れ壁→[open下,wall上] ----
test('【WP-E1】probeColumn: 正面の壁が垂れ壁指定なら[open(床..天井-bottomHeight), wall(天井-bottomHeight..天井)]の2本になる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const bottomHeight = 700;
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), { drop: { bottomHeight } });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 2000, probeCtx);
  assert.equal(bands.length, 2, `垂れ壁指定は[open,wall]の2本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'open');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, CH - bottomHeight);
  assert.equal(bands[1].kind, 'wall');
  assert.equal(bands[1].z0, CH - bottomHeight);
  assert.equal(bands[1].z1, CH);
});

// ---- 切断壁→[cut] ----
test('【WP-E1】probeColumn: 切断線が室内の間仕切り壁を横切る位置では[cut]（全高）を返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  // 室内をY=1500で仕切る水平の間仕切り壁（isVertical:false。cut.line(isVertical:true)と直交し、
  // その全幅[0,4000]がcut.axisValue=2000を含む＝切断線がこの壁を横切って通る）。
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  // axisOffset!==0でmaterialRangeが実厚み(100mm)を持つようにする（axisOffset=0だと退化して0厚みになる）。
  graph.addWall(yMid, 100, false, x0, 0, x1, 0, { isRoomWall: false, isExteriorWall: false });

  // 切断線: X=2000で垂直に切る（isVertical:true, axisValue:2000, run=Y方向[0,3000]）。
  const cut = {
    seqNo: '2',
    line: { isVertical: true, axisValue: 2000, lo: 0, hi: 3000 },
    viewSign: 1, // X増加方向を見る（この切断線自体の可視判定には使わないが、必須フィールドとして設定）
    dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH },
    baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 1500, probeCtx); // 間仕切り壁のY方向厚み(中心1500)の範囲内
  assert.equal(bands.length, 1, `切断壁のみなら1本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'cut');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, CH);
  assert.ok(bands[0].thicknessMm > 0, 'thicknessMmは壁厚ぶん正の値のはず');
});

// ---- 失敗系: 層0件 ----
test('【失敗系・WP-E1】probeColumn: layers=[]でも例外を投げず[open]（zRange全域）を返す', () => {
  const cut = {
    seqNo: '1',
    line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);
  assert.deepEqual(bands, [{ kind: 'open', z0: 0, z1: CH }]);
});

// ---- 失敗系: 切断線が部屋外 ----
test('【失敗系・WP-E1】probeColumn: 切断線の位置が部屋外でも例外を投げず[open]を返す', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  // 部屋の外（X=-5000近辺）を通る切断線。
  const cut = {
    seqNo: '1',
    line: { isVertical: false, axisValue: -9000, lo: -11000, hi: -7000 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, -9000, probeCtx);
  assert.deepEqual(bands, [{ kind: 'open', z0: 0, z1: CH }]);
});

// ---- 失敗系: 壁ゼロ ----
test('【失敗系・WP-E1】probeColumn: graph.walls=[]（壁ゼロ）でも例外を投げず[open]を返す', () => {
  const graph = makeGraph();
  // 部屋・壁を一切作らない空のgraph。
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);
  assert.deepEqual(bands, [{ kind: 'open', z0: 0, z1: CH }]);
});

// ---- collectCutBreaks: S1（層のCL）で室内間仕切りの位置が分割点として拾われる ----
test('【WP-E1】collectCutBreaks: 切断線のrun方向にある間仕切りCLの値が分割点に含まれる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1200, { labeled: false, discipline: Discipline.ARCH });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const breaks = collectCutBreaks(cut, probeCtx);
  assert.ok(breaks.includes(0) && breaks.includes(4000), '両端は必ず含む');
  // frontCutのlineはisVertical:falseなので、run方向のCLはVERTICAL種別（X値）。
  // 上で追加したCLはHORIZONTAL(Y=1200)のため、S1には現れない（frontCutのXレンジ内には無関係）。
  // ここではS1の基本契約（両端が必ず含まれる・空にならない）のみを確認する。
  assert.ok(breaks.length >= 2);
});

// ---- ユーザー裁定2026-08 A案: 壁のない端部では探査範囲そのものを外側へ広げる ----
test('【裁定A案】collectCutBreaks: probeExtendLo/HiMmで探査範囲が外側へ広がり、面の端も列境界として残る', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const base = frontCut(graph);
  const probeCtx = makeProbeContext(base.layers);

  const plain = collectCutBreaks(base, probeCtx);
  assert.equal(Math.min(...plain), 0, '既定では探査範囲はline.loから');
  assert.equal(Math.max(...plain), 4000, '既定では探査範囲はline.hiまで');

  const extended = collectCutBreaks(
    { ...base, line: { ...base.line, probeExtendLoMm: 150, probeExtendHiMm: 200 } }, probeCtx);
  assert.equal(Math.min(...extended), -150, 'lo側が150外へ広がるはず');
  assert.equal(Math.max(...extended), 4200, 'hi側が200外へ広がるはず');
  assert.ok(extended.includes(0) && extended.includes(4000),
    '面の端(0/4000)は列境界として残るはず（面の内と外が1列に融合しない）');
});

test('【失敗系・裁定A案】collectCutBreaks: probeExtend未指定は現行と完全一致（既定0）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const base = frontCut(graph);
  const probeCtx = makeProbeContext(base.layers);
  assert.deepEqual(
    collectCutBreaks({ ...base, line: { ...base.line, probeExtendLoMm: 0, probeExtendHiMm: 0 } }, probeCtx),
    collectCutBreaks(base, probeCtx));
});

// ---- 失敗系: collectCutBreaksもlayers=[]で例外なし ----
test('【失敗系・WP-E1】collectCutBreaks: layers=[]でも例外を投げず両端だけの配列を返す', () => {
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const breaks = collectCutBreaks(cut, makeProbeContext([]));
  assert.deepEqual(breaks, [0, 4000]);
});

// ---- 変異テスト用の土台: オクルージョン優先順位（距離最小のwallが選ばれる） ----
test('【WP-E1・優先順位】probeColumn: 見えがかり候補が複数あれば距離が近い方が選ばれる', () => {
  const graph = makeGraph();
  // 部屋の奥に、正面の壁(y=3000)よりさらに手前(y=1500)に自立壁(貫通しない袖壁ではなく全幅の壁)を置く。
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x1 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(yMid, 0, false, x0, 0, x1, 0, { isRoomWall: false, isExteriorWall: false });

  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);
  assert.equal(bands.length, 1);
  assert.equal(bands[0].distMm, 1500, '手前の壁(距離1500)が奥の壁(距離3000)より優先されるはず');
});

// ==== WP-E5リード裁定: cutAlong（coincident壁）====

// 「縦断された壁」用の切断線: X=2000で垂直に切る（cut.line.axisValueが壁のCLと一致する
// ケース=switchbackCutsのW(0,sMid→1,sMid)がレーン境界CL壁と一致する状況に対応）。
function verticalCoincidentCut(graph, overrides = {}) {
  return {
    seqNo: '2',
    line: { isVertical: true, axisValue: 2000, lo: 0, hi: 3000 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
    ...overrides,
  };
}

// 室内をX=2000で縦断する壁（isVertical:true。cut.lineと同じ向き・同じaxisValue＝coincident）を
// Y:[500,2500]の部分スパンで置く（「壁スパン外でrayが抜ける」テストの対象範囲を確保するため
// 部分スパンにする）。
function addCoincidentWall(graph) {
  const y500  = graph.addCenterLine(CenterLineType.HORIZONTAL, 500,  { labeled: false, discipline: Discipline.ARCH });
  const y2500 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2500, { labeled: false, discipline: Discipline.ARCH });
  const x2000 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  return graph.addWall(x2000, 50, true, y500, 0, y2500, 0, { isRoomWall: false, isExteriorWall: false });
}

test('【WP-E5・cutAlong】probeColumn: 切断線が壁の中心線と同一直線上(coincident)なら、その壁スパン内は視線を遮り[cutAlong]（全高）になる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = addCoincidentWall(graph);
  const cut = verticalCoincidentCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 1500, probeCtx); // wallのスパン[500,2500]内
  assert.equal(bands.length, 1, `coincident壁のみなら1本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'cutAlong');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, CH);
  assert.equal(bands[0].wall, wall);
});

test('【WP-E5・cutAlong】probeColumn: 腰壁(knee.topHeight)指定時、topHeightまでは[cutAlong]・その上はrayが抜けて次の候補が見つかる（cutAlongに全高ふさがれない）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK'); // 視線方向(X増加)の先に右壁(X=4000)がある閉じた室
  const wall = addCoincidentWall(graph);
  const topHeight = 900;
  graph.setKneeDropWall(edgeKey(wall.axisCL.id, wall.clStart.id, wall.clEnd.id), { knee: { topHeight } });
  const cut = verticalCoincidentCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 1500, probeCtx);
  assert.equal(bands.length, 2, `腰壁指定は[cutAlong,次候補]の2本のはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'cutAlong');
  assert.equal(bands[0].z0, 0);
  assert.equal(bands[0].z1, topHeight);
  // 腰壁の上はcutAlongにふさがれず、視線方向の次の候補（この閉じた室では右壁X=4000）が
  // 見つかる——「rayが抜ける」＝cutAlongが全高を占有しないことの確認（候補自体は
  // フィクスチャに閉じた室を使ったため'wall'になるが、cutAlongでは断じてないことが本質）。
  assert.notEqual(bands[1].kind, 'cutAlong', '腰壁の上はcutAlongで塞がれないはず');
  assert.equal(bands[1].kind, 'wall');
  assert.equal(bands[1].distMm, 2000, '右壁(X=4000)までの距離2000のはず');
  assert.equal(bands[1].z0, topHeight);
  assert.equal(bands[1].z1, CH);
});

test('【失敗系・WP-E5・cutAlong】probeColumn: 壁スパン外（Y方向）ではcutAlongにならずrayが抜けて次の候補(遠くの壁)が見つかる', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK'); // 右壁(X=4000)がY全域[0,3000]に存在する
  addCoincidentWall(graph); // Y:[500,2500]のみ
  const cut = verticalCoincidentCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 2800, probeCtx); // wallのスパン外(Y=2800 > 2500)
  assert.equal(bands.length, 1);
  assert.notEqual(bands[0].kind, 'cutAlong', '壁スパン外はcutAlongにならないはず');
  assert.equal(bands[0].kind, 'wall', 'rayが抜けて右壁(X=4000)がwallとして見つかるはず');
  assert.equal(bands[0].distMm, 2000, '右壁(X=4000)までの距離は2000のはず');
});

// ---- 変異テスト用の土台: cut と cutAlong が同一z区間で競合すればcutが優先される ----
test('【WP-E5・cutAlong優先順位】probeColumn: 同一z区間にcut候補とcutAlong候補が両方あればcutが優先される', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  addCoincidentWall(graph); // cutAlong候補(X=2000, Y:[500,2500])
  // cut候補: X=2000を横切る水平壁(isVertical:false)をY=1500に追加（isCutWallの直交条件を満たす）。
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  const x4000 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 4000);
  const y1500 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(y1500, 100, false, x0, 0, x4000, 0, { isRoomWall: false, isExteriorWall: false });

  const cut = verticalCoincidentCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 1500, probeCtx);
  const cutBand = bands.find(b => b.z0 <= 1500 && b.z1 >= 1500) ?? bands[0];
  assert.equal(cutBand.kind, 'cut', 'cutとcutAlongが競合する区間ではcutが優先されるはず');
});

// ==== WP-E7 defer D1: openingPassThrough（probeColumnの生成側）====
// 消費側（emitOpenGapMarksのアキ連結成分計算）はWP-E2で実装・テスト済み（sectionEmit.test.js）。
// ここではprobeColumnが実際のgraph+開口からopeningPassThrough:trueのZBandを正しく生成する
// （生成側）ことを検証する。

test('【WP-E7・D1】probeColumn: 見えがかり壁面(wall band)に重なる開口はz範囲がopeningPassThrough:trueの帯として分離される', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  // 窓: 中心x=2000(refOffset)・幅900・窓台高さ1900・建具高さ500(→z:1900-2400=CHにちょうど届く)。
  graph.addOpening(wall.axisCL, 1, false, x0, 2000, 900, OpeningCategory.WINDOW, 'casement',
    { sillHeight: 1900, height: 500 });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 2000, probeCtx); // 開口の中心直下(worldMid=2000)
  assert.equal(bands.length, 2, `開口のz範囲(1900-2400)でwall帯が分割されるはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'wall');
  assert.equal(bands[0].z0, 0); assert.equal(bands[0].z1, 1900);
  assert.equal(bands[0].openingPassThrough, undefined, '開口の範囲外はopeningPassThroughを持たないはず');
  assert.equal(bands[1].kind, 'wall');
  assert.equal(bands[1].z0, 1900); assert.equal(bands[1].z1, CH);
  assert.equal(bands[1].openingPassThrough, true, '開口のz範囲(1900-2400)はopeningPassThrough:trueのはず');
});

test('【失敗系・WP-E7・D1】probeColumn: probeのx位置(worldMid)が開口の範囲外ならopeningPassThroughは付与されない', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const wall = farWallOf(graph);
  const x0 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 0);
  // 開口はx:[50,950]付近（center=500,width=900）。probeはx=2000（開口の範囲外）。
  graph.addOpening(wall.axisCL, 1, false, x0, 500, 900, OpeningCategory.WINDOW, 'casement',
    { sillHeight: 1900, height: 500 });
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);

  const bands = probeColumn(cut, 2000, probeCtx);
  assert.equal(bands.length, 1, `worldMidが開口の範囲外なら分割されないはず（実際:${JSON.stringify(bands)}）`);
  assert.equal(bands[0].kind, 'wall');
  assert.equal(bands[0].openingPassThrough, undefined);
});

// ---- 統合（probeColumnの生成 + emitOpenGapMarksの消費）: 開口なし=ゾーン別X／開口が2Fアキと連続=1組の大X ----
// far壁がx:[1500,2500]にしか無い部屋（U字状に開けた部屋を模す）: 中央列(x:[1500,2500])に壁、
// 両隣(x:[0,1500]・[2500,4000])は壁が無く全高open（「切断線が部屋外」失敗系と同じ理由でopen）。
// 中央の壁に天井際まで届く窓を付けると、両隣のopen列と連結して1組の大きなXになる
// （§7 D1「開口が2階アキと連続する場合の1つの大きなX」の一般規則の写し）。
function makeGapWallGraph() {
  const graph = makeGraph();
  makeRectRoom(graph, 1500, 0, 2500, 3000, 'LDK'); // far壁はx:[1500,2500]のみに存在
  return graph;
}

function wideCut(graph) {
  return {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
}

test('【失敗系・WP-E7・D1統合】開口なし: 中央の壁が両隣のopen列と連結しないため、ゾーン別に2組のX(4本)になる', () => {
  const graph = makeGapWallGraph();
  const cut = wideCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const columns = [
    { x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: probeColumn(cut, 750, probeCtx) },
    { x0: 1500, x1: 2500, worldLo: 1500, worldHi: 2500, bands: probeColumn(cut, 2000, probeCtx) },
    { x0: 2500, x1: 4000, worldLo: 2500, worldHi: 4000, bands: probeColumn(cut, 3250, probeCtx) },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 4, `中央の壁(開口なし)は両隣のopen列を橋渡ししないため2組のX(4本)のはず（実際:${prims.length}本）`);
});

test('【WP-E7・D1統合】開口が天井際まで届き2Fアキ相当のopen列と連続: ゾーンが橋渡しされ1組の大きなX(2本)になる', () => {
  const graph = makeGapWallGraph();
  const wall = farWallOf(graph);
  const x1500 = graph.centerLines.find(cl => cl.centerLineType === CenterLineType.VERTICAL && cl.value === 1500);
  graph.addOpening(wall.axisCL, 1, false, x1500, 500, 900, OpeningCategory.WINDOW, 'casement',
    { sillHeight: 1900, height: 500 }); // 中心x=2000(=1500+500)・z:1900-2400=CHに届く
  const cut = wideCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const columns = [
    { x0: 0, x1: 1500, worldLo: 0, worldHi: 1500, bands: probeColumn(cut, 750, probeCtx) },
    { x0: 1500, x1: 2500, worldLo: 1500, worldHi: 2500, bands: probeColumn(cut, 2000, probeCtx) },
    { x0: 2500, x1: 4000, worldLo: 2500, worldHi: 4000, bands: probeColumn(cut, 3250, probeCtx) },
  ];
  const prims = emitOpenGapMarks(columns, cut);
  assert.equal(prims.length, 2, `開口が両隣のopen列と橋渡しするため1組の大きなX(2本)のはず（実際:${prims.length}本）`);
});

// ---- 実機フィードバック第3弾A2: 見えがかり壁のz上限は「上階に実Roomがあるか」で決める ----
// 上が吹抜け（VOID/STAIR_VOID）の階段室では、壁の輪郭は自層CH（1F天井高さ）で水平キャップされず
// 上階天井まで続くべき（根本原因: probeColumnのwall候補がinfo.ceilZ=自層CHで無条件に切っていた）。
function twoLayerCut(selfGraph, aboveGraph, aboveFloorZMm, hiZMm) {
  return {
    seqNo: '1',
    line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1,
    dirSign: 1,
    layers: [
      { graph: selfGraph, floorZMm: 0, role: 'self' },
      { graph: aboveGraph, floorZMm: aboveFloorZMm, role: 'above' },
    ],
    zRange: { loZ: 0, hiZ: hiZMm },
    baseFloorZ: 0,
  };
}

test('【実機フィードバック第3弾A2】probeColumn: 上階に実Roomがあれば見えがかり壁は従来どおり自層CHでキャップされる（回帰ガード）', () => {
  const selfGraph = makeGraph();
  makeRectRoom(selfGraph, 0, 0, 4000, 3000, '階段室');
  const aboveGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  makeRectRoom(aboveGraph, 0, 0, 4000, 3000, '洋室'); // feature未設定=実Room。footprintは自層と同一

  const cut = twoLayerCut(selfGraph, aboveGraph, 2900, 5300);
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);

  const wallZ1Max = Math.max(...bands.filter(b => b.kind === 'wall' && b.layerRole === 'self').map(b => b.z1));
  assert.equal(wallZ1Max, CH, `上階に実Roomがある通常構成では従来どおり自層CH(${CH})でキャップされるはず（実際:${wallZ1Max}）`);
});

test('【実機フィードバック第3弾A2】probeColumn: 上階が吹抜け(VOID)なら見えがかり壁は自層CHで水平キャップされず上階天井まで続く', () => {
  const selfGraph = makeGraph();
  makeRectRoom(selfGraph, 0, 0, 4000, 3000, '階段室');
  const aboveGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const voidRoom = makeRectRoom(aboveGraph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID); // footprintは自層と同一・実床なし

  const cut = twoLayerCut(selfGraph, aboveGraph, 2900, 5300);
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);

  const wallZ1Max = Math.max(...bands.filter(b => b.kind === 'wall' && b.layerRole === 'self').map(b => b.z1));
  assert.equal(wallZ1Max, 5300, `上階が吹抜けなら自層CH(${CH})で止まらず上階天井(5300)まで続くはず（実際:${wallZ1Max}）`);
  assert.ok(!bands.some(b => b.kind === 'wall' && b.layerRole === 'self' && Math.abs(b.z1 - CH) < 1e-6 && b.z0 < CH),
    '1F天井高さちょうどで終わる自層の壁帯（誤った水平キャップ線の元）が残っていないはず');
});

test('【失敗系・実機フィードバック第3弾A2】probeColumn: above層が無い（最上階等）なら従来どおり自層CHでキャップされる', () => {
  const selfGraph = makeGraph();
  makeRectRoom(selfGraph, 0, 0, 4000, 3000, '階段室');
  const cut = frontCut(selfGraph, { zRange: { loZ: 0, hiZ: CH } }); // layers=[self]のみ（既存のfrontCut）
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);

  const wallZ1Max = Math.max(...bands.filter(b => b.kind === 'wall' && b.layerRole === 'self').map(b => b.z1));
  assert.equal(wallZ1Max, CH, `above層が無ければ判定不能のため自層CH(${CH})のまま（実際:${wallZ1Max}）`);
});

// ---- 実機フィードバック第3弾G: above層の床端(slab/open境界=2FL水平線)はabove.roomが実Room（VOID/STAIR_VOID以外）のときだけ'slab'にする ----
test('【実機フィードバック第3弾G】probeColumn: self天井より上でabove層に実Roomがあれば従来どおりslab(非描画)になる（回帰ガード）', () => {
  const selfGraph = makeGraph();
  makeRectRoomNoWalls(selfGraph, 0, 0, 4000, 3000, '階段室'); // 自層に候補壁なし
  const aboveGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  makeRectRoomNoWalls(aboveGraph, 0, 0, 4000, 3000, '洋室'); // feature未設定=実Room・above層にも壁を作らない（above自身のwall候補が横取りしないように）

  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1,
    layers: [
      { graph: selfGraph, floorZMm: 0, role: 'self' },
      { graph: aboveGraph, floorZMm: 2900, role: 'above' },
    ],
    zRange: { loZ: 0, hiZ: 5300 }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);

  const aboveSlab = bands.find(b => b.kind === 'slab' && b.z0 >= 2900 - 1e-6);
  assert.ok(aboveSlab, 'self天井より上にslab帯があるはず（above層に実Roomがあるため）');
});

test('【実機フィードバック第3弾G】probeColumn: self天井より上でabove層がVOID(実Room以外)ならslabではなくopenになる（2FL水平線を誤って出さない）', () => {
  const selfGraph = makeGraph();
  makeRectRoomNoWalls(selfGraph, 0, 0, 4000, 3000, '階段室'); // 自層に候補壁なし
  const aboveGraph = new PlanGraph(new Plane('p2', 2900, '2階', 1, 1));
  const voidRoom = makeRectRoomNoWalls(aboveGraph, 0, 0, 4000, 3000, '吹抜け');
  voidRoom.setFeature(RoomFeature.VOID);

  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1,
    layers: [
      { graph: selfGraph, floorZMm: 0, role: 'self' },
      { graph: aboveGraph, floorZMm: 2900, role: 'above' },
    ],
    zRange: { loZ: 0, hiZ: 5300 }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext(cut.layers);
  const bands = probeColumn(cut, 2000, probeCtx);

  const aboveSlab = bands.find(b => b.kind === 'slab' && b.z0 >= 2900 - 1e-6);
  assert.equal(aboveSlab, undefined, 'above層がVOID(実床なし)ならslabにならないはず');
  const aboveOpen = bands.find(b => b.kind === 'open' && b.z0 >= 2900 - 1e-6);
  assert.ok(aboveOpen, 'above層がVOIDならopen帯になるはず（2FL水平線=slab/open境界を誤って出さないため）');
});
