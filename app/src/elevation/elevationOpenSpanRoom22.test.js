// 展開図の面抽出の受け入れ検証: ユーザー期待図「2階22」（問題修正2026-08その9）。
// 実機ファイルの2階・室22の実座標をそのまま固定化する。この構成は2つの独立した不具合を同時に
// 踏んでいた:
//   (1) Y=-3500に「延長違いの同値CL」が2本ある（-8000..0 と 1000..7000）。外周エッジの端点CLに
//       後者（室22には届いていない方）のidが入り、buildRoomFacesのチェーン探索（隅をCLのidで
//       辿る）が最初の1面で切れ、展開図が「Aのみ」になっていた。
//   (2) X3..X4の帯はY=-3500のCLが届かずセルが上下に割れないため、A1（Y=-3500の壁）の
//       X3..X4の抜けが開放区間として描かれなかった。
// 平面（y下向き正）:
//   X1=-8000 / X2=-3000 / X3=0 / X4=X3+1000=1000、Y2=-7000 / Y2+3500=-3500 / 段差CL=-2000 / Y1=0
//   室22 = 「X1..X2 × -3500..-2000」＋「X2..X3 × -3500..0」＋「X3..X4 × -7000..0」
// 期待図（時計回りのchain順）: A1→D1→A2→B→C1→D2→C2→D3。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { worldToCell } from '../finish/gridCells.js';
import { buildRoomFaces, faceBoundaryLocalX, drawnSpanRanges } from './elevationFaces.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { collectRow1SplitPoints } from './elevationDimSplit.js';
import { wallAdjacentFloorSegments } from './elevationFloorProfile.js';
import { buildFaceFigure } from './elevationFigure.js';

const GRID = { labeled: true, discipline: Discipline.STRUCT }; // 通り芯（延長は常に有効）
const ARCH = { labeled: false, discipline: Discipline.ARCH };

function buildRoom22Fixture() {
  const graph = new PlanGraph(new Plane('p2', 3000, '2階', 2, 1));
  const V = (v, o) => graph.addCenterLine(CenterLineType.VERTICAL, v, o);
  const H = (v, o) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, o);
  const X1 = V(-8000, GRID), X2 = V(-3000, GRID), X3 = V(0, GRID);
  const X4 = V(1000, { ...ARCH, extentLo: -7000, extentHi: 0 });
  V(7000, GRID);                                               // X5（25/26の東端）
  V(-5600, { ...ARCH, extentLo: -2000, extentHi: 0 });         // 23|24 の境界（段差CLより南だけ）
  H(-7000, GRID);                                              // Y2
  H(-3500, { ...ARCH, extentLo: -8000, extentHi: 0 });         // Y2+3500（室22側）
  H(-3500, { ...ARCH, extentLo: 1000, extentHi: 7000 });       // 同値・別延長（右隣の室のCL）
  H(-2000, { ...ARCH, extentLo: -8000, extentHi: -3000 });     // 段差CL（X1..X2だけ）
  H(0, GRID);                                                  // Y1
  void X1; void X2; void X3; void X4;

  const key = (x, y) => worldToCell(x, y, graph).key;
  const room = graph.addRoom(new Set([
    key(-5500, -2500), // X1..X2 × -3500..-2000
    key(-1500, -1000), // X2..X3 × -3500..0
    key(500, -5000),   // X3..X4 × -7000..0（Y=-3500では割れない＝面を跨ぐセル）
  ]), '22');
  // 「向こう側の壁」を作る隣室（寸法の分割点＝S2の源。実モデルと同じ配置の縮約）。
  //   25/26 … X4より東。両者の境界(y=-3500)がBの向こう側の壁になる。
  //   23/24 … 段差CLより南。両者の境界(x=-5600)がC2の向こう側の壁になる。
  const room25 = graph.addRoom(new Set([key(4000, -5000)]), '25');
  const room26 = graph.addRoom(new Set([key(4000, -1000)]), '26');
  const room23 = graph.addRoom(new Set([key(-7000, -1000)]), '23');
  const room24 = graph.addRoom(new Set([key(-4000, -1000)]), '24');
  for (const r of [room, room25, room26, room23, room24]) generateRoomWallsFromOutline(graph, r);
  return { graph, room };
}

// 面の寸法の鎖（隣り合う分割点の差。ROW1の実際の寸法値と同じ並び）。
function dimsOf(face, graph) {
  const boundary = faceBoundaryLocalX(face, graph);
  const marks = [boundary.lo, ...collectRow1SplitPoints(face, graph, { boundary, spans: face.spans }), boundary.hi];
  return marks.slice(1).map((m, i) => Math.round(m - marks[i]));
}

const summarize = f => ({
  label: f.label, lo: f.lo, hi: f.hi, spans: (f.spans ?? []).map(s => s.kind),
});

test('期待図「2階22」: 外周チェーンが1周し、8面が期待図どおりの範囲・spansで並ぶ', () => {
  const { graph, room } = buildRoom22Fixture();
  assert.equal(buildRoomFaces(room, graph).length, 8,
    '同値CLで隅のidが食い違い、チェーンが1面で切れる不具合の回帰確認（旧: A 1面のみ）');
  assert.deepEqual(composeRoomFaces(room, graph).map(summarize), [
    // A1: Y=-3500の壁（X1..X3）＋出口側の隅を越えてX4までの開放区間（セルが面を跨ぐ帯）
    { label: 'A1', lo: -7942.5, hi: 942.5,   spans: ['wall', 'open'] },
    // D1: X3の壁（Y2..-3500）のみ。入口側の隅の先は情報ゼロのアキが図の1/4を超えるため延ばさない
    { label: 'D1', lo: -6942.5, hi: -3442.5, spans: ['wall'] },
    { label: 'A2', lo: 57.5,    hi: 942.5,   spans: ['wall'] },
    { label: 'B',  lo: -6942.5, hi: -57.5,   spans: ['wall'] },
    { label: 'C1', lo: -2942.5, hi: 942.5,   spans: ['wall'] },
    // D2: X2の壁（段差CL..Y1）＋出口側の隅を越えて-3500までの開放区間
    { label: 'D2', lo: -3442.5, hi: -57.5,   spans: ['wall', 'open'] },
    { label: 'C2', lo: -7942.5, hi: -2942.5, spans: ['wall'] },
    { label: 'D3', lo: -3442.5, hi: -2057.5, spans: ['wall'] },
  ]);
});

test('期待図「2階22」: A1のX3..X4は「面を跨ぐセル」由来の開放区間として描かれる', () => {
  const { graph, room } = buildRoom22Fixture();
  const a1 = composeRoomFaces(room, graph).find(f => f.label === 'A1');
  const open = a1.spans.find(s => s.kind === 'open');
  assert.ok(open, `A1に開放区間があるはず（実際:${JSON.stringify(a1.spans)}）`);
  // 描画は仕上げ面基準。X3(0)の壁面〜X4(1000)の壁面ぶん＝942.5の抜け。
  assert.equal(Math.round(open.hiX - open.loX), 943);
  assert.equal(a1.extendedAtLocalRun, true, '出口側（X4方向）への延長のはず');
  assert.equal(a1.extendedAtLocal0, false);
});

test('期待図「2階22」: D1は入口側へ延ばさず、壁断面のない端（見えがかりエッジ）で終わる', () => {
  const { graph, room } = buildRoom22Fixture();
  const d1 = composeRoomFaces(room, graph).find(f => f.label === 'D1');
  assert.equal(d1.run, 3500, 'D1はY2..-3500の壁ぶん（仕上げ面間3500）のはず');
  assert.equal(d1.extendedAtLocal0, false, '入口側の隅の先は情報ゼロのアキ（50%）のため延ばさない');
  assert.equal(d1.hasWallAtLocal0, false);
  assert.equal(d1.edgeAtLocal0, true, 'A1の壁が向こう側へ折れて続く角＝見えがかりエッジ');
});

test('D2は出口側の隅を越えるため、アキだけ（FL差なし）でも従来どおり延長する', () => {
  const { graph, room } = buildRoom22Fixture();
  const d2 = composeRoomFaces(room, graph).find(f => f.label === 'D2');
  assert.equal(d2.extendedAtLocalRun, true);
  const open = d2.spans.find(s => s.kind === 'open');
  assert.ok(open);
  assert.equal(open.farFloorDeltaMm, 0, '開放先は同じ室22＝FL差なし（情報ゼロ）でも出口側なら残す');
});

// 失敗系: 入口側でもFL差があれば（informative）従来どおり延長する。
test('例外: 入口側でもFL差のある区間なら1/4の閾値に関わらず延長する', () => {
  const { graph, room } = buildRoom22Fixture();
  const farKey = worldToCell(-1500, -1000, graph).key; // D1の入口側の先（X2..X3 × -3500..0）
  const child = graph.addRoom(new Set([farKey]), "22'", undefined, new Set([room.id]));
  child.setFloorLevel(-100);

  const d1 = composeRoomFaces(room, graph).find(f => f.label === 'D1');
  assert.equal(d1.extendedAtLocal0, true, 'FL差があれば入口側でも延長するはず');
  const open = d1.spans.find(s => s.kind === 'open');
  assert.ok(open, `D1にFL差の開放区間が現れるはず（実際:${JSON.stringify(d1.spans)}）`);
  assert.equal(open.farFloorDeltaMm, -100);
});


// ---- 寸法の鎖: 面の「向こう側」に立つ壁で割れる（S2。問題修正2026-08その9） ----
// perpendicularWallsOnFace が isRoomWall を一律除外していたため、実データ（全ての壁が部屋の
// 外周生成壁）ではこの分割源が常に空だった。向こう側の壁は定義上どこかの部屋の外周生成壁である。
test('寸法の鎖: Bは向こう側（25|26境界）の壁で3500+3500に割れる', () => {
  const { graph, room } = buildRoom22Fixture();
  assert.deepEqual(dimsOf(composeRoomFaces(room, graph).find(f => f.label === 'B'), graph), [3500, 3500]);
});

test('寸法の鎖: C2は向こう側（23|24境界）の壁で2600+2400に割れる', () => {
  const { graph, room } = buildRoom22Fixture();
  assert.deepEqual(dimsOf(composeRoomFaces(room, graph).find(f => f.label === 'C2'), graph), [2600, 2400]);
});

test('【失敗系】寸法の鎖: 向こう側へ突き出さない自室の壁では割れない（D1・C1は1本のまま）', () => {
  const { graph, room } = buildRoom22Fixture();
  const faces = composeRoomFaces(room, graph);
  assert.deepEqual(dimsOf(faces.find(f => f.label === 'D1'), graph), [3500]);
  assert.deepEqual(dimsOf(faces.find(f => f.label === 'C1'), graph), [4000]);
});

// ---- 巾木の途切れ区間は描画基準（壁の面まで）。ユーザー実機指摘2026-08その9 ----
// 「A1：X3の巾木はCL右側の壁まで」「D2：2000の巾木は2000CL右側の壁まで」。
// 巾木は描画要素のため、open区間の範囲もCL基準(spans)ではなく描画基準(drawnSpanRanges)を使う
// ——CL基準だとCLと壁面の間（半壁厚）に巾木の無い隙間ができる。
test('巾木: 開放区間の途切れはCLではなく「境界に立つ壁の開放側の面」から始まる', () => {
  const { graph, room } = buildRoom22Fixture();
  const faces = composeRoomFaces(room, graph);
  for (const [label, clX, wallFaceX] of [['A1', 7943, 8000], ['D2', 1943, 2000]]) {
    const f = faces.find(x => x.label === label);
    const i = f.spans.findIndex(s => s.kind === 'open');
    assert.equal(Math.round(f.spans[i].loX), clX, `${label}: spansはCL基準のまま（寸法用）`);
    assert.equal(Math.round(drawnSpanRanges(f, graph)[i].loX), wallFaceX,
      `${label}: 描画基準は壁の面（CLから半壁厚ぶん開放側）のはず`);
  }
});

test('巾木: 描画される巾木線がCLではなく壁の面まで伸びる（buildFaceFigure）', () => {
  const { graph, room } = buildRoom22Fixture();
  room.finish.setField('baseboardHeight', 'h=60');
  const a1 = composeRoomFaces(room, graph).find(f => f.label === 'A1');
  const CH = 2400;
  const prims = buildFaceFigure(a1, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: CH,
    materialMap: new Map(), gridCLs: [],
    floorSegments: wallAdjacentFloorSegments(a1, room, graph),
  });
  // 巾木は床(y=0)からh=60上の水平線。open区間の手前で途切れる終端xを見る。
  const ends = prims.filter(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60).map(p => Math.round(Math.max(p.x1, p.x2)));
  assert.ok(ends.includes(8000), `巾木はX3の壁の面(8000)まで伸びるはず（実際:${JSON.stringify(ends)}）`);
  assert.ok(!ends.includes(7943), '旧挙動（CL位置7943で途切れる）に戻っていないこと');
});


// ---- 通り芯の縦線は寸法行で分ける（ユーザー明示指示2026-08その10） ----
// 「構造芯ラベルの丸とCLが離れている。丸の位置はそのまま、線分を調整」「通り芯の一点鎖線が
// からむと再度、寸法線が交点を持たない可能性があるので、寸法線から丸までは実線描画」。
test('通り芯の縦線: 天井上〜寸法行は一点鎖線・寸法行〜丸番号は実線の2本になる', () => {
  const { graph, room } = buildRoom22Fixture();
  const a1 = composeRoomFaces(room, graph).find(f => f.label === 'A1');
  const CH = 2400, DIM_ROW_Y = 600, GRID_GAP = 900;
  const gridCLs = [...graph.centerLines].filter(cl => cl.labeled && cl.centerLineType === 'X');
  assert.ok(gridCLs.length > 0, '前提: 通り芯（labeled）が存在する');
  const prims = buildFaceFigure(a1, {
    graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: CH,
    materialMap: new Map(), gridCLs, dimRowGapModelMm: DIM_ROW_Y, gridRowGapModelMm: GRID_GAP,
    floorSegments: wallAdjacentFloorSegments(a1, room, graph),
  });
  const circleRowY = DIM_ROW_Y + GRID_GAP;
  const circles = prims.filter(p => p.type === 'circle' && p.cy === circleRowY);
  assert.ok(circles.length > 0, '前提: 通り芯の丸番号が描かれる');

  for (const c of circles) {
    const at = prims.filter(p => p.type === 'line' && p.x1 === c.cx && p.x2 === c.cx);
    // 上側: 一点鎖線。寸法行で終わり、位相アンカーも寸法行。
    const upper = at.find(p => p.dash === 'center');
    assert.ok(upper, `x=${c.cx}: 上側の一点鎖線があるはず`);
    assert.equal(Math.max(upper.y1, upper.y2), DIM_ROW_Y, '一点鎖線は寸法行で終わるはず');
    assert.equal(upper.dashAnchor, DIM_ROW_Y);
    // 下側: 実線で寸法行から丸の中心まで（丸は背景色で塗られ線の上に重なる＝丸の縁に接する）。
    const lower = at.find(p => p.dash == null && Math.min(p.y1, p.y2) === DIM_ROW_Y);
    assert.ok(lower, `x=${c.cx}: 寸法行〜丸の実線があるはず`);
    assert.equal(Math.max(lower.y1, lower.y2), circleRowY, '実線は丸の中心まで届くはず');
    // 旧挙動（一点鎖線1本が丸まで通る）に戻っていないこと。
    assert.ok(!at.some(p => p.dash === 'center' && Math.max(p.y1, p.y2) === circleRowY),
      '一点鎖線が丸まで通ってはいけない（丸との隙間・寸法線との交点欠けの原因）');
  }
});
