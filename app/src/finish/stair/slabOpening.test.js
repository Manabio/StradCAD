// slabOpening.js（上階スラブの開口＝上階に床が無い領域）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, StairType } from '@core';
import { getAllCells } from '../gridCells.js';

// 昇降路4属性を固定配列で列挙する（isShaftFeature/SHAFT_FEATURES 本体から作ると、実装側の
// Setから値を外す変異を入れたときテスト対象も一緒に減って赤にならない——検出力を保つため
// 独立した固定リストにする）。EVは既存の専用テストがあるため除く。
const OTHER_SHAFT_FEATURES = [RoomFeature.DW, RoomFeature.FREIGHT_EV, RoomFeature.VEHICLE_EV];
import { slabOpeningRects, slabOpeningFrames, slabOpeningEdges, trimOpeningEdgesAgainstStair, floorOpeningEdges } from './slabOpening.js';

// 2×1マス（x:0-1000-2000, y:0-1500）のグリッドを持つグラフとセルキーを作る。
function makeGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  return {
    graph, x0, xm, x1, y0, y1,
    left:  `${x0.id}:${y0.id}:${xm.id}:${y1.id}`,
    right: `${xm.id}:${y0.id}:${x1.id}:${y1.id}`,
  };
}

test('上階グラフが無い（未解決）なら null を返す＝呼び出し側はクリップしない', () => {
  assert.equal(slabOpeningRects(null), null);
  assert.equal(slabOpeningRects(undefined), null);
});

test('吹抜け・階段吹抜けRoomの占有セルが開口になる', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);
  const rects = slabOpeningRects(graph);
  assert.equal(rects.length, 2);
  // 世界座標がセル矩形（x:0-1000 / 1000-2000, y:0-1500）で返る
  const xs = rects.map(r => [r.x1, r.x2]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(xs, [[0, 1000], [1000, 2000]]);
  assert.ok(rects.every(r => r.y1 === 0 && r.y2 === 1500));
});

// ---- EV（エレベーターシャフト。実装指示書ステップ1・2026-09-28）はVOIDと同じkind='void'扱い ----
test('EV Roomの占有セルが開口になる（kind=\'void\'扱い＝slabOpeningFramesからは除かれ、slabOpeningRectsには含まれる）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.EV);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);

  const rects = slabOpeningRects(graph);
  assert.equal(rects.length, 2, 'EVもSTAIR_VOIDと同じく開口の範囲（rects）には含まれる');
  const xs = rects.map(r => [r.x1, r.x2]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(xs, [[0, 1000], [1000, 2000]]);

  const frames = slabOpeningFrames(graph);
  assert.equal(frames.length, 1, 'EVはVOIDと同じくslabOpeningFramesの縁からは除かれ、STAIR_VOID側だけが残る');
  assert.deepEqual([frames[0].cl.x1, frames[0].cl.x2], [1000, 2000], '残るのはright（STAIR_VOID）のみ');
});

// ---- 昇降路属性の拡張（DW・貨物用EV・車両用EV。2026-09-28）も同じkind='void'扱い ----
for (const feature of OTHER_SHAFT_FEATURES) {
  test(`feature=${feature}（昇降路）の占有セルが開口になる（kind='void'扱い＝slabOpeningFramesからは除かれ、slabOpeningRectsには含まれる）`, () => {
    const { graph, left, right } = makeGrid();
    graph.addRoom(new Set([left])).setFeature(feature);
    graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);

    const rects = slabOpeningRects(graph);
    assert.equal(rects.length, 2, '昇降路もSTAIR_VOIDと同じく開口の範囲（rects）には含まれる');

    const frames = slabOpeningFrames(graph);
    assert.equal(frames.length, 1, '昇降路はVOIDと同じくslabOpeningFramesの縁からは除かれ、STAIR_VOID側だけが残る');
    assert.deepEqual([frames[0].cl.x1, frames[0].cl.x2], [1000, 2000], '残るのはright（STAIR_VOID）のみ');
  });
}

test('通常の部屋（床がある）は開口に数えない', () => {
  const { graph, left } = makeGrid();
  graph.addRoom(new Set([left])); // feature 未設定＝通常の部屋
  assert.deepEqual(slabOpeningRects(graph), []);
});

test('階段も吹抜けも無ければ空配列（呼び出し側は安全側で制約なしとして扱う）', () => {
  const { graph } = makeGrid();
  assert.deepEqual(slabOpeningRects(graph), []);
});

test('slabOpeningFrames: 矩形の開口は境界CL矩形と壁面矩形の対を返す（壁が無ければCLへ落ちる）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const frames = slabOpeningFrames(graph);
  assert.equal(frames.length, 1);
  assert.deepEqual(
    { x1: frames[0].cl.x1, y1: frames[0].cl.y1, x2: frames[0].cl.x2, y2: frames[0].cl.y2 },
    { x1: 0, y1: 0, x2: 2000, y2: 1500 },
  );
  // 壁を生成していないので描画位置はCLと同じ
  assert.equal(frames[0].face.x1, 0);
  assert.equal(frames[0].face.y2, 1500);
});

test('slabOpeningFrames: 上階が無ければ null', () => {
  assert.equal(slabOpeningFrames(null), null);
});

test('slabOpeningEdges: 壁が無ければ開口の4辺をそのまま返す', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const edges = slabOpeningEdges(slabOpeningFrames(graph), graph);
  assert.equal(edges.length, 4);
  // 左右は垂直線・上下は水平線
  assert.equal(edges.filter(s => s.x1 === s.x2).length, 2);
  assert.equal(edges.filter(s => s.y1 === s.y2).length, 2);
});

test('slabOpeningEdges: 当該階の壁に覆われた区間は差し引かれる', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const frames = slabOpeningFrames(graph);
  // y=1500（下辺）の全長に壁がある当該階を模す
  const fakeGraph = {
    walls: [{ isVertical: false, axisCL: { value: 1500 }, coord1: 0, coord2: 2000 }],
  };
  const edges = slabOpeningEdges(frames, fakeGraph);
  assert.equal(edges.length, 3); // 下辺が丸ごと消える
  assert.ok(!edges.some(s => s.y1 === 1500 && s.y2 === 1500));
});

test('slabOpeningEdges: frames が空／null なら空配列（描かない）', () => {
  assert.deepEqual(slabOpeningEdges(null, {}), []);
  assert.deepEqual(slabOpeningEdges([], {}), []);
});

test('slabOpeningRects: 矩形の開口は、縁の描画位置と同じ壁面矩形を1枚返す（セル矩形に割らない）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.STAIR_VOID);
  const rects = slabOpeningRects(graph);
  assert.equal(rects.length, 1); // 2セルぶんに割らない
  const face = slabOpeningFrames(graph)[0].face;
  assert.deepEqual(
    [rects[0].x1, rects[0].y1, rects[0].x2, rects[0].y2],
    [face.x1, face.y1, face.x2, face.y2], // 破線を切る範囲＝実際に描く縁と同一
  );
});

// 開口の縁: y=-3557 を x=-2942〜-57。破れ先破線は開口でクリップ済みなので、ささらは
// 縁に端点で接する（x=-1550, y=-3557〜-6000）。破れ先セル＝レーンB x[-3000,-1500] y[-6000,-3500]。
const OPENING_EDGE = [{ x1: -2942, y1: -3557, x2: -57, y2: -3557 }];
const STAIR_SEGS = [{ x1: -1550, y1: -3557, x2: -1550, y2: -6000 }];
const BEYOND = [{ x1: -3000, y1: -6000, x2: -1500, y2: -3500 }];

test('trimOpeningEdgesAgainstStair: 縁に端点で接する直交破線でも交点を拾って切る', () => {
  const out = trimOpeningEdgesAgainstStair(OPENING_EDGE, STAIR_SEGS, BEYOND);
  assert.equal(out.length, 1);
  // レーン間の通り芯 -1500 ではなく、ささら破線の実位置 -1550 で止まる
  assert.deepEqual([out[0].x1, out[0].x2], [-1550, -57]);
  assert.equal(out[0].y1, -3557);
});

test('trimOpeningEdgesAgainstStair: 階段側が縁を担う区間（破れ先セル内）は落とす', () => {
  const out = trimOpeningEdgesAgainstStair(OPENING_EDGE, STAIR_SEGS, BEYOND);
  assert.ok(!out.some(s => Math.min(s.x1, s.x2) < -1550 - 1e-6));
});

test('trimOpeningEdgesAgainstStair: 平行な破線では切らない（直交だけが交点になる）', () => {
  const parallel = [{ x1: -2942, y1: -3500, x2: -1500, y2: -3500 }];
  assert.deepEqual(trimOpeningEdgesAgainstStair(OPENING_EDGE, parallel, BEYOND), OPENING_EDGE);
});

test('trimOpeningEdgesAgainstStair: 縁に届かない・端で接するだけの直交破線では切らない', () => {
  const edges = [{ x1: 0, y1: 0, x2: 1000, y2: 0 }];
  const beyond = [{ x1: -10, y1: -10, x2: 10, y2: 10 }];
  const away = [{ x1: 500, y1: 100, x2: 500, y2: 200 }];
  const atEnd = [{ x1: 0, y1: -50, x2: 0, y2: 50 }];
  for (const segs of [away, atEnd]) {
    assert.deepEqual(trimOpeningEdgesAgainstStair(edges, segs, beyond), edges);
  }
});

test('trimOpeningEdgesAgainstStair: 破れ先セル／階段側の線が無ければ縁をそのまま返す（安全側）', () => {
  assert.deepEqual(trimOpeningEdgesAgainstStair(OPENING_EDGE, STAIR_SEGS, []), OPENING_EDGE);
  assert.deepEqual(trimOpeningEdgesAgainstStair(OPENING_EDGE, [], BEYOND), OPENING_EDGE);
  assert.deepEqual(trimOpeningEdgesAgainstStair([], STAIR_SEGS, BEYOND), []);
});

test('slabOpeningFrames: 上階の吹抜け(VOID)Roomは縁を返さない（VoidLayerの「上部吹抜け」破線と二重描画しない）', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left, right])).setFeature(RoomFeature.VOID);
  assert.deepEqual(slabOpeningFrames(graph), []);
  assert.deepEqual(slabOpeningEdges(slabOpeningFrames(graph), graph), []);
  // 範囲そのもの（破れ先破線のクリップ用）はVOIDも含めて返り続ける
  assert.equal(slabOpeningRects(graph).length, 1);
});

test('slabOpeningFrames: VOIDとSTAIR_VOIDが混在してもSTAIR_VOID側だけが縁を返す', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);
  const frames = slabOpeningFrames(graph);
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].cl.x1, frames[0].cl.x2], [1000, 2000]); // right（STAIR_VOID）のみ
});

// ================================================================
// floorOpeningEdges（層A・実装指示書ステップ3。2026-09-28）
// ================================================================

// 結合セル（T字・非矩形の実測）を作るため、xmは上段(y:0-1000)では非アクティブ（y:1000-2000のみ）
// にする。上段はx0-x1の1セル、下段はx0-xm/xm-x1の2セルに分かれる（gridCells.js worldToCell
// のL字結合セルと同じ機構）。VOID部屋 = 上段セル ∪ 下段左セル（右下セルは除外）で3セル分のL字。
function makeLShapeGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 1000, extentHi: 2000 });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const cells = getAllCells(graph);
  const topKey = cells.find(c => c.y1 === 0 && c.y2 === 1000 && c.x1 === 0 && c.x2 === 2000).key;
  const blKey  = cells.find(c => c.y1 === 1000 && c.y2 === 2000 && c.x1 === 0 && c.x2 === 1000).key;
  return { graph, x0, xm, x1, y0, ym, y1, topKey, blKey };
}

// SWITCHBACK・L字部屋の階段フィクスチャ（stairUnderRooms.test.js makeStairUnderFixture と同一構成の
// 流用）。beyond（破れ先）はレーンB＝returnKey（矩形1セル。x:[1000,2000], y:[1500,4500]）のみになる
// （stairGeometry.js beyondBreakUTurnLike: sOf>0.5 側だけを先とする）。
function makeSwitchbackBeyondFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4500, opt);
  const landingKey  = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey   = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const stairCells = new Set([landingKey, outboundKey, returnKey]);
  const roomCells  = new Set([landingKey, outboundKey]); // L字。returnKeyは部屋自身に含めない。
  const room = graph.addRoom(roomCells, '階段');
  graph.addStair({
    type: StairType.SWITCHBACK, cells: stairCells, roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  return { graph, xm, x1, ym, y1 };
}

test('floorOpeningEdges: 矩形の吹抜け1セルは4辺・境界CL・外向き符号・source・onGridが正しい', () => {
  const { graph, x0, xm, y0, y1, left } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 4);
  const leftEdge   = edges.find(e => e.isVertical && e.coord === 0);
  const rightEdge  = edges.find(e => e.isVertical && e.coord === 1000);
  const topEdge    = edges.find(e => !e.isVertical && e.coord === 0);
  const bottomEdge = edges.find(e => !e.isVertical && e.coord === 1500);
  assert.equal(leftEdge.axisCL, x0.id);
  assert.equal(leftEdge.clStart, y0.id);
  assert.equal(leftEdge.clEnd, y1.id);
  assert.equal(leftEdge.outwardSign, -1);
  assert.equal(rightEdge.axisCL, xm.id);
  assert.equal(rightEdge.outwardSign, 1);
  assert.equal(topEdge.axisCL, y0.id);
  assert.equal(topEdge.outwardSign, -1); // y軸下向き正：上辺は-1
  assert.equal(bottomEdge.axisCL, y1.id);
  assert.equal(bottomEdge.outwardSign, 1);
  assert.ok(edges.every(e => e.source === 'void' && e.onGrid === false));
});

test('floorOpeningEdges: 非矩形（L字・結合セル）は除外セルの内部に辺を作らず、切り欠きの2辺が交わる', () => {
  // 除外セル（部屋に含めないセル）は右下: x[1000,2000], y[1000,2000]（makeLShapeGrid参照）。
  const { graph, xm, ym, topKey, blKey } = makeLShapeGrid();
  graph.addRoom(new Set([topKey, blKey])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  // outlineSegments自体は完全一致する共有辺だけを消し、隣接するが範囲が異なる辺同士（例:
  // x=0の左辺はtopKey由来[0,1000]とblKey由来[1000,2000]の2本のsegsに分かれる）を結合しない
  // （既存仕様。gridCells.test.js 参照）が、floorOpeningEdgesはそれらをoutlineSegmentsをまたいで
  // 同じaxisCLへ結合し直す（QA再裁定2026-09-28 P5・mergeAdjacentPieces）。結果としてL字1個の
  // 外形は6本の辺レコードになる（左辺x=0は[0,2000]の1本に結合済み。補助的な確認。主張の核は
  // この後の「内部辺が無い」「切り欠き2辺が正しい」「左辺が結合済み」assert）。
  assert.equal(edges.length, 6);
  assert.ok(edges.every(e => e.source === 'void'));
  // 左辺x=0は2つのセル（topKey・blKey）にまたがるが同じaxisCL(x0)のため1本に結合される
  const leftEdges = edges.filter(e => e.isVertical && e.coord === 0);
  assert.equal(leftEdges.length, 1);
  assert.equal(leftEdges[0].lo, 0);
  assert.equal(leftEdges[0].hi, 2000);
  // 本当に消えるべき内部辺（topKeyとblKeyが共有するy=1000, x[0,1000]区間）が無い
  // （QA指摘2026-09-28 F4: 旧assertはisVerticalの取り違えで、その辺のx=1000&y[0,1000]という
  // 起こりえない条件を検査していた）
  assert.ok(!edges.some(e => !e.isVertical && e.coord === 1000 && e.lo < 1000));
  // 切り欠きの実境界（除外セルに接する2辺）
  const notchV = edges.find(e => e.isVertical && e.coord === 1000 && e.lo === 1000 && e.hi === 2000);
  const notchH = edges.find(e => !e.isVertical && e.coord === 1000 && e.lo === 1000 && e.hi === 2000);
  assert.ok(notchV && notchH);
  assert.equal(notchV.axisCL, xm.id);
  assert.equal(notchH.axisCL, ym.id);
  // 開口セル(blKey: x[0,1000],y[1000,2000])はx=1000のx2側・y=1000のtopKeyのy2側に接するため、
  // 外向き符号は仕様の規約（x2===value→+1・y2===value→+1）どおりどちらも+1になる
  // （テスト1の左辺=-1(x1側)・右辺=+1(x2側)と同じ規約。QA指摘のF4では「x=1000は-1」とあったが、
  // 本規約に照らすと開口セルはx2側で接しているため+1が正しい——コーディネータへ確認事項として報告）。
  assert.equal(notchV.outwardSign, 1);
  assert.equal(notchH.outwardSign, 1);
});

test('floorOpeningEdges: 通り芯上の辺だけonGrid=trueになる', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true,  discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const right = `${xm.id}:${y0.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([right])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 4);
  const onGridEdges = edges.filter(e => e.onGrid);
  assert.equal(onGridEdges.length, 1);
  assert.equal(onGridEdges[0].axisCL, xm.id);
});

test('floorOpeningEdges【QA指摘F1-1】: 同一直線上の有効区間が異なる2本のCLは区間ごとに正しいaxisCLへ分割される', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  // 同じvalue=1000に、有効区間の異なる2本のCL（xa:y[0,1000]・xb:y[1000,2000]）を置く
  // （COEXISTENCE「center×center=extent」で許される構成。QA probe相当）。
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 0, extentHi: 1000 });
  const xb = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 1000, extentHi: 2000 });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt); // ymid: 分割点でclStart/clEndを解決可能にする
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const key = `${x0.id}:${y0.id}:${xa.id}:${y1.id}`; // 単一セル x:[0,1000] y:[0,2000]（右辺x=1000がxa/xbにまたがる）
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const rightLower = edges.find(e => e.isVertical && e.coord === 1000 && e.lo === 0);
  const rightUpper = edges.find(e => e.isVertical && e.coord === 1000 && e.lo === 1000);
  assert.ok(rightLower, '下側区間(y:0-1000)の辺が存在する');
  assert.ok(rightUpper, '上側区間(y:1000-2000)の辺が存在する');
  assert.equal(rightLower.hi, 1000);
  assert.equal(rightUpper.hi, 2000);
  assert.equal(rightLower.axisCL, xa.id); // 座標一致だけで先頭のCLを返すと取り違える（旧実装のバグ）
  assert.equal(rightUpper.axisCL, xb.id);
});

test('floorOpeningEdges【QA指摘F1-2】: clStart/clEndは有効区間で決まる（座標が一致するだけの無関係CLを選ばない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  // F7: idを明示する（yFar='a-far'＜yNear='z-near'）。有効区間の判定を外す変異が起きると
  // id昇順のタイブレークでyFarが勝ってしまう位置関係にし、UUIDの偶然に依存せず毎回検出できるようにする。
  // yFarを先に追加する（value=0だが有効区間はx:[3000,4000]で本題の開口とは無関係の位置）
  const yFar = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { ...opt, extentLo: 3000, extentHi: 4000 }, 'a-far');
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const yNear = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { ...opt, extentLo: 0, extentHi: 1000 }, 'z-near');
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  const key = `${x0.id}:${yNear.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const topEdge = edges.find(e => !e.isVertical && e.coord === 0);
  const leftEdge = edges.find(e => e.isVertical && e.coord === 0);
  assert.equal(topEdge.axisCL, yNear.id); // yFarは先に追加されたが有効区間外なので選ばれない
  assert.equal(leftEdge.clStart, yNear.id); // 左辺(lo=0)のclStartも同様
  assert.notEqual(topEdge.axisCL, yFar.id);
});

test('floorOpeningEdges【QA裁定F2】: 同座標に通り芯と中心線が共存する場合は通り芯を優先しonGrid=trueになる（追加順に依存しない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  // F7: idを明示する（centerCl='a-center'＜structCl='z-grid'）。通り芯優先の判定を外す変異が
  // 起きるとid昇順のタイブレークでcenterClが勝ってしまう位置関係にし、UUIDの偶然に依存せず
  // 毎回検出できるようにする。中心線を先に追加し、通り芯を後から同じ座標へ追加する
  // （追加順が逆でも結果が変わらないことを見る）。
  const centerCl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: false, discipline: Discipline.ARCH }, 'a-center');
  const structCl = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { labeled: true, discipline: Discipline.STRUCT }, 'z-grid');
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${centerCl.id}:${y1.id}`;
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const rightEdge = edges.find(e => e.isVertical && e.coord === 1000);
  assert.equal(rightEdge.axisCL, structCl.id);
  assert.equal(rightEdge.onGrid, true);
});

test('floorOpeningEdges【QA指摘F1任意6】: 0.3mmずれたCLがあっても完全一致のCLが選ばれる', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const xExact = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  graph.addCenterLine(CenterLineType.VERTICAL, 1000.3, opt); // 0.3mmずれ（許容差0.5mm内なので候補に入る）
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  const key = `${x0.id}:${y0.id}:${xExact.id}:${y1.id}`;
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const rightEdge = edges.find(e => e.isVertical && e.coord === 1000);
  assert.equal(rightEdge.axisCL, xExact.id);
});

test('floorOpeningEdges【QA再指摘P4】: 1つのセル辺を2本の短いCLが分担していても辺は消えず1本になる', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  // x=1000に、有効区間が過不足なく接する2本の短いCL（水平方向の分割CLは無し＝単一セル）
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 0, extentHi: 1000 }, 'p4-xa');
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 1000, extentHi: 2000 }, 'p4-xb');
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const key = `${x0.id}:${y0.id}:${xa.id}:${y1.id}`; // 単一セル x:[0,1000] y:[0,2000]
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const rightEdges = edges.filter(e => e.isVertical && e.coord === 1000);
  assert.equal(rightEdges.length, 1, '辺が消えず1本残る（旧方式は分割点y=1000に直交CLが無く両区間とも消えていた）');
  assert.equal(rightEdges[0].lo, 0);
  assert.equal(rightEdges[0].hi, 2000);
  assert.equal(rightEdges[0].axisCL, xa.id); // 実効重なり長が同点（1000mmずつ）のためid昇順でxaが勝つ
});

test('floorOpeningEdges【QA再指摘P5・F8】: 全長CLと短いCLが同座標にあるとき、id順に関わらず実効重なり長の長いCLが両ピースで勝ち1本に結合される', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  // idはxsが辞書順で先（'a-xs'<'z-xf'）だが、実効重なり長はxf（全長）がxs（1000mm）より両ピースとも長い。
  // ymidでセルを2分割し、xfが両ピースで勝つことで「結合」ロジックも同時に検証する
  // （F1-1と異なり、ここは片方だけが勝つケースではなく両方とも同じCLが勝つケース）。
  const xs = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 500, extentHi: 1500 }, 'a-xs');
  const xf = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt, 'z-xf');
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt); // ymid: セルをy:[0,1000]/[1000,2000]に2分割
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const key = `${x0.id}:${y0.id}:${xf.id}:${y1.id}`; // 単一キー（refreshCellsがymidで2セルへ再正規化する）
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const rightEdges = edges.filter(e => e.isVertical && e.coord === 1000);
  assert.equal(rightEdges.length, 1, 'id順で短いCLが勝つ、または結合が効かないと複数本に割れていた（旧方式・結合欠落の不良）');
  assert.equal(rightEdges[0].lo, 0);
  assert.equal(rightEdges[0].hi, 2000);
  assert.equal(rightEdges[0].axisCL, xf.id); // idはxsが先だが実効重なり長でxfが両ピースとも勝つ
  assert.notEqual(rightEdges[0].axisCL, xs.id);
});

test('floorOpeningEdges【QA再指摘P6】: セルを区切る短いCL1本だけでも、セル境界そのものの辺として残る（extentで切り詰めない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  // xaの有効区間y[0,900]はセルの高さy[0,1000]よりわずかに短い
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 0, extentHi: 900 });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const key = `${x0.id}:${y0.id}:${xa.id}:${y1.id}`;
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const rightEdge = edges.find(e => e.isVertical && e.coord === 1000);
  assert.ok(rightEdge, 'CLのextentがセルよりわずかに短いだけで辺が消えてはいけない');
  assert.equal(rightEdge.lo, 0);
  assert.equal(rightEdge.hi, 1000); // セル境界の全長（xaのextentである900までに切り詰めない）
  assert.equal(rightEdge.axisCL, xa.id);
});

test('floorOpeningEdges【QA再指摘F9】: clStart/clEndも接セルの区間（±1mm点窓ではない）で解決される', () => {
  // P6型（短いxa extent[0,900]・左列1セルy[0,2000]）で、下辺y=2000のclEndを固定する。
  // 旧実装（clStart/clEndを±1mm点窓で判定）は、xaの有効区間[0,900]がy=2000から遠いため
  // clEndが解決できず辺が丸ごと消えていた。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xa = graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 0, extentHi: 900 });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const key = `${x0.id}:${y0.id}:${xa.id}:${y1.id}`; // 単一セル x:[0,1000] y:[0,2000]
  graph.addRoom(new Set([key])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 4, '辺は4本すべて出る（下辺のclEndが解決できず消えてはいけない）');
  const bottomEdge = edges.find(e => !e.isVertical && e.coord === 2000);
  assert.ok(bottomEdge);
  assert.equal(bottomEdge.lo, 0);
  assert.equal(bottomEdge.hi, 1000);
  assert.equal(bottomEdge.clStart, x0.id);
  assert.equal(bottomEdge.clEnd, xa.id); // xaは接セル(y:[0,2000])の区間で有効（isActiveAcrossRange(xa,0,2000)）
});

test('floorOpeningEdges【QA再指摘F10】: x=1000に沿って離れた2開口は同じaxisCL・同符号でも2本のまま（隣接しなければ結合しない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xc = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt); // 全長CL。両開口で共通のaxisCLになる
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const y3 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, opt);
  const keyA = `${x0.id}:${y0.id}:${xc.id}:${y1.id}`; // y:[0,1000]
  const keyB = `${x0.id}:${y2.id}:${xc.id}:${y3.id}`; // y:[2000,3000]（y:[1000,2000]は開口なしの隙間）
  graph.addRoom(new Set([keyA])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([keyB])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const xEdges = edges.filter(e => e.isVertical && e.coord === 1000);
  assert.equal(xEdges.length, 2, '隙間があるため2本のまま（結合しない）');
  assert.ok(xEdges.every(e => e.axisCL === xc.id));
  const ranges = xEdges.map(e => [e.lo, e.hi]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(ranges, [[0, 1000], [2000, 3000]]);
});

test('floorOpeningEdges【QA再指摘F11】: 対角で角だけ接する2開口はoutwardSignが異なるため2本のまま（結合しない）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const keyVoid  = `${x0.id}:${y0.id}:${xm.id}:${ym.id}`; // x:[0,1000] y:[0,1000]
  const keyStair = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`; // x:[1000,2000] y:[1000,2000]（対角）
  graph.addRoom(new Set([keyVoid])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([keyStair])).setFeature(RoomFeature.STAIR_VOID);
  const edges = floorOpeningEdges(graph);
  const xEdges = edges.filter(e => e.isVertical && e.coord === 1000);
  assert.equal(xEdges.length, 2);
  const voidEdge = xEdges.find(e => e.lo === 0 && e.hi === 1000);
  const stairEdge = xEdges.find(e => e.lo === 1000 && e.hi === 2000);
  assert.ok(voidEdge && stairEdge);
  assert.equal(voidEdge.outwardSign, 1);
  assert.equal(voidEdge.source, 'void');
  assert.equal(stairEdge.outwardSign, -1);
  assert.equal(stairEdge.source, 'stairVoid');
});

// EVは既存のfeature別専用テスト（上のslabOpeningRects系）が固定しているためDWと2件を固定配列にする
// （実装本体（SHAFT_FEATURES）から作ると変異で対象ごと減って赤にならないため）。
const FLOOR_OPENING_SHAFT_FEATURES = [RoomFeature.EV, RoomFeature.DW];
for (const feature of FLOOR_OPENING_SHAFT_FEATURES) {
  test(`floorOpeningEdges: 昇降路（feature=${feature}）はsource='shaft'`, () => {
    const { graph, left } = makeGrid();
    graph.addRoom(new Set([left])).setFeature(feature);
    const edges = floorOpeningEdges(graph);
    assert.equal(edges.length, 4);
    assert.ok(edges.every(e => e.source === 'shaft' && e.sources.length === 1 && e.sources[0] === 'shaft'));
  });
}

test('floorOpeningEdges: STAIR_VOIDはsource=\'stairVoid\'', () => {
  const { graph, right } = makeGrid();
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 4);
  assert.ok(edges.every(e => e.source === 'stairVoid'));
});

test('floorOpeningEdges: 階段の破れ先セルの外形辺だけが出る（破れ手前＝とりつき部の辺は出ない）', () => {
  const { graph, xm, x1, ym, y1 } = makeSwitchbackBeyondFixture();
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 4);
  assert.ok(edges.every(e => e.source === 'stairBeyond'));
  const left   = edges.find(e => e.isVertical && e.coord === 1000);
  const right  = edges.find(e => e.isVertical && e.coord === 2000);
  const top    = edges.find(e => !e.isVertical && e.coord === 1500);
  const bottom = edges.find(e => !e.isVertical && e.coord === 4500);
  assert.equal(left.axisCL, xm.id);
  assert.equal(right.axisCL, x1.id);
  assert.equal(top.axisCL, ym.id);
  assert.equal(bottom.axisCL, y1.id);
  // とりつき部（landingKey・outboundKey）は破れ手前＝辺を出さない
  assert.ok(!edges.some(e => e.isVertical && e.coord === 0)); // outboundKeyの左端(x0)
});

test('floorOpeningEdges: 吹抜けと階段吹抜けが隣接するとき共有辺は出ないが、同じaxisCLを持つ上下辺は結合される', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.STAIR_VOID);
  const edges = floorOpeningEdges(graph);
  // 共有辺(x=1000)は消える。上辺(y=0)・下辺(y=1500)はvoid/stairVoid両セルの境界が同じaxisCL
  // （y0・y1）のためmergeAdjacentPiecesで1本に結合される（QA再裁定2026-09-28）
  // ——4本（左・右・上・下）になる。
  assert.equal(edges.length, 4);
  assert.ok(!edges.some(e => e.isVertical && e.coord === 1000));
  const leftEdge  = edges.find(e => e.isVertical && e.coord === 0);
  const rightEdge = edges.find(e => e.isVertical && e.coord === 2000);
  assert.equal(leftEdge.source, 'void');
  assert.deepEqual(leftEdge.sources, ['void']);
  assert.equal(rightEdge.source, 'stairVoid');
  assert.deepEqual(rightEdge.sources, ['stairVoid']);
  // 結合された上辺・下辺はx:[0,2000]全幅になり、両方のsourceを持つ
  const topEdge = edges.find(e => !e.isVertical && e.coord === 0);
  const bottomEdge = edges.find(e => !e.isVertical && e.coord === 1500);
  for (const e of [topEdge, bottomEdge]) {
    assert.equal(e.lo, 0);
    assert.equal(e.hi, 2000);
    assert.deepEqual(e.sources, ['void', 'stairVoid']);
  }
  // Minor-3是正: 辺を共有する2つの開口（void・stairVoid）は同じcomponentId。
  assert.equal(leftEdge.componentId, rightEdge.componentId);
  assert.equal(topEdge.componentId, leftEdge.componentId);
  assert.equal(bottomEdge.componentId, leftEdge.componentId);
});

// ---- Minor-3是正（2026-09-28QAレビュー）: 連結成分はセルの4近傍。角だけで接する開口は別成分 ----
test('floorOpeningEdges【Minor-3是正】: 角だけで接する2つの開口（対角）はcomponentIdが異なる', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  // 左上セル(x:[0,1000],y:[0,1000])と右下セル(x:[1000,2000],y:[1000,2000])——角(1000,1000)だけで接する。
  const topLeft = `${x0.id}:${y0.id}:${xm.id}:${ym.id}`;
  const bottomRight = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([topLeft])).setFeature(RoomFeature.VOID);
  graph.addRoom(new Set([bottomRight])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 8, '角だけで接する2つの正方形はそれぞれ独立した4辺＝計8辺（辺は結合されない）');
  const topLeftEdges = edges.filter(e => e.coord === 0);
  const bottomRightEdges = edges.filter(e => e.coord === 2000);
  assert.ok(topLeftEdges.length > 0 && bottomRightEdges.length > 0, '前提: 各セルの外側の辺（x/y=0とx/y=2000）が存在する');
  const idsA = new Set(topLeftEdges.map(e => e.componentId));
  const idsB = new Set(bottomRightEdges.map(e => e.componentId));
  assert.equal(idsA.size, 1, '左上セル由来の辺は同一componentId');
  assert.equal(idsB.size, 1, '右下セル由来の辺は同一componentId');
  assert.notEqual([...idsA][0], [...idsB][0], '角だけで接する開口は別のcomponentId（端点共有では同じになってしまう不良の是正）');
});

test('floorOpeningEdges【QA指摘F5】: 複数辺の並びはisVertical→coord→lo昇順で決定的', () => {
  // makeGridの2セル（VOID/STAIR_VOID）では上下辺が結合されて1本ずつになり、lo比較の対象が
  // 無くなるため、L字（複数のlo違いの辺が実在する）フィクスチャで並びを固定する。
  const { graph, topKey, blKey } = makeLShapeGrid();
  graph.addRoom(new Set([topKey, blKey])).setFeature(RoomFeature.VOID);
  const edges = floorOpeningEdges(graph);
  const actualOrder = edges.map(e => [e.isVertical, e.coord, e.lo]);
  const expectedOrder = [...actualOrder].sort((a, b) =>
    (Number(a[0]) - Number(b[0])) || (a[1] - b[1]) || (a[2] - b[2]));
  assert.deepEqual(actualOrder, expectedOrder); // sortを削除すると挿入順（groups Mapの走査順）のままになり崩れる
  assert.deepEqual(actualOrder, [
    [false, 0, 0], [false, 1000, 1000], [false, 2000, 0],
    [true, 0, 0], [true, 1000, 1000], [true, 2000, 0],
  ]);
});

test('floorOpeningEdges【不変条件】: 矩形1件のケースで座標がslabOpeningRectsの外形と一致する（同じ情報源の固定）', () => {
  // left+rightの外形（x:0-2000, y:0-1500）と同じ矩形を単一セル（内部分割なし）で作る
  // ——分割ありだとoutlineSegmentsが辺を割るため（floorOpeningEdges: 非矩形テスト参照）、
  // 「4辺一致」の比較には単一セルの矩形を使う。
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  graph.addRoom(new Set([key])).setFeature(RoomFeature.STAIR_VOID);
  const [rect] = slabOpeningRects(graph);
  const edges = floorOpeningEdges(graph);
  assert.equal(edges.length, 4);
  const vertLo = edges.find(e => e.isVertical && e.coord === rect.x1);
  const vertHi = edges.find(e => e.isVertical && e.coord === rect.x2);
  const horLo  = edges.find(e => !e.isVertical && e.coord === rect.y1);
  const horHi  = edges.find(e => !e.isVertical && e.coord === rect.y2);
  for (const e of [vertLo, vertHi]) { assert.equal(e.lo, rect.y1); assert.equal(e.hi, rect.y2); }
  for (const e of [horLo, horHi]) { assert.equal(e.lo, rect.x1); assert.equal(e.hi, rect.x2); }
});

test('floorOpeningEdges【失敗系a】: 部屋開口が無く、riserOfがnullを返す階段だけなら空配列', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), '階段');
  graph.addStair({
    type: StairType.STRAIGHT, cells: new Set([key]), roomId: room.id,
    sections: [4], riser: null, upDirection: 'up', flip: false,
  });
  assert.deepEqual(floorOpeningEdges(graph, { riserOf: () => null }), []);
});

// QA指摘F3: riserOfの戻り値で破れ先の位置が変わることを確認するための多セル直進階段フィクスチャ
// （x方向に1000mmピッチ8セル・y:[0,1000]の1列。upDirection='right'でt方向=x方向）。
// sections=[9]（run.cells=8）: riser=200→breakCell=8→破れ先はx:[7000,8000]の1セルのみ、
// riser=400→breakCell=4→破れ先はx:[3000,8000]の5セル（実測で確認済み・VERIFIED）。
function makeStraightRunFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const xs = [];
  for (let i = 0; i <= 8; i++) xs.push(graph.addCenterLine(CenterLineType.VERTICAL, i * 1000, opt));
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const keys = [];
  for (let i = 0; i < 8; i++) keys.push(`${xs[i].id}:${y0.id}:${xs[i + 1].id}:${y1.id}`);
  const cells = new Set(keys);
  const room = graph.addRoom(cells, '階段');
  graph.addStair({
    type: StairType.STRAIGHT, cells, roomId: room.id,
    sections: [9], riser: null, upDirection: 'right', flip: false,
  });
  return { graph };
}

test('floorOpeningEdges【QA指摘F3】: riserOfの戻り値で破れ先の辺の座標が変わる', () => {
  const { graph } = makeStraightRunFixture();
  const edges200 = floorOpeningEdges(graph, { riserOf: () => 200 });
  const edges400 = floorOpeningEdges(graph, { riserOf: () => 400 });
  assert.ok(edges200.length > 0 && edges400.length > 0, '両riserとも破れ先が出る');
  const xCoords200 = new Set(edges200.filter(e => e.isVertical).map(e => e.coord));
  const xCoords400 = new Set(edges400.filter(e => e.isVertical).map(e => e.coord));
  assert.ok(xCoords200.has(7000)); // riser=200: 破れ先はx:[7000,8000]の1セルのみ
  assert.ok(!xCoords400.has(7000));
  assert.ok(xCoords400.has(3000)); // riser=400: 破れ先はx:[3000,8000]の5セル
  assert.ok(!xCoords200.has(3000));
});

test('floorOpeningEdges【QA指摘F3】: riserOfを省略（既定null）した、部屋開口の無い階段だけの階は空配列', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), '階段');
  graph.addStair({
    type: StairType.STRAIGHT, cells: new Set([key]), roomId: room.id,
    sections: [4], riser: null, upDirection: 'up', flip: false,
  });
  assert.deepEqual(floorOpeningEdges(graph), []); // opts自体を省略（既定 riserOf:()=>null）
});

test('floorOpeningEdges【失敗系b】: セルキーが指すCLが削除済みならその辺は落ち、例外にならない', () => {
  const { graph, xm, left } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.VOID);
  graph.removeShape(xm.id); // leftキーが参照するCLの1本を削除する（右端=xm）
  assert.doesNotThrow(() => floorOpeningEdges(graph));
  assert.deepEqual(floorOpeningEdges(graph), []);
});

test('floorOpeningEdges【失敗系c】: graphがnullなら空配列', () => {
  assert.deepEqual(floorOpeningEdges(null), []);
});
