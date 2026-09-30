// voidGeometry.js（吹抜け(VOID)・昇降機の×描画データ計算）の単体テスト。
// グリッドの作り方は finish/stair/slabOpening.test.js の makeGrid と同じ方針
// （壁は生成しない——faceRect は壁が無ければCLのeffectiveValueへ落ちるため、
// 描画位置の確認だけならCLだけの最小グラフで足りる）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';

import { computeVoidCrosses, showsUpperVoidLabel, visibleUpperVoidCrosses, ownVoidCellRects } from './voidGeometry.js';

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
    graph,
    left:  `${x0.id}:${y0.id}:${xm.id}:${y1.id}`,
    right: `${xm.id}:${y0.id}:${x1.id}:${y1.id}`,
  };
}

// 2×2マス（x:0-1000-2000, y:0-1000-2000）のグリッドを持つグラフとセルキーを作る
// （非矩形の判定に4象限が要るため makeGrid とは別に用意する）。
function makeGrid2x2() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const ym = graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  return {
    graph,
    topLeft:     `${x0.id}:${y0.id}:${xm.id}:${ym.id}`,
    topRight:    `${xm.id}:${y0.id}:${x1.id}:${ym.id}`,
    bottomLeft:  `${x0.id}:${ym.id}:${xm.id}:${y1.id}`,
    bottomRight: `${xm.id}:${ym.id}:${x1.id}:${y1.id}`,
  };
}

test('computeVoidCrosses: VOID・昇降機が列挙され、featureが正しい', () => {
  const { graph, left, right } = makeGrid();
  const voidRoom = graph.addRoom(new Set([left]));
  voidRoom.setFeature(RoomFeature.VOID);
  const evRoom = graph.addRoom(new Set([right]));
  evRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);

  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 2);
  const byId = new Map(result.map(c => [c.id, c]));
  assert.equal(byId.get(voidRoom.id).feature, RoomFeature.VOID);
  assert.equal(byId.get(evRoom.id).feature, RoomFeature.ELEVATOR_EQUIPMENT);
  // 世界座標がセル矩形（left: x:0-1000 / right: x:1000-2000, y:0-1500）で返る（壁未生成のためCL値そのまま）
  assert.deepEqual(
    [byId.get(voidRoom.id).x1, byId.get(voidRoom.id).x2],
    [0, 1000],
  );
  assert.deepEqual(
    [byId.get(evRoom.id).x1, byId.get(evRoom.id).x2],
    [1000, 2000],
  );
  // cellRect（セル境界CLの値。壁が無いためfaceRectと一致）も持つ（QA指摘M1対応で新設）
  assert.deepEqual(byId.get(voidRoom.id).cellRect, { x1: 0, y1: 0, x2: 1000, y2: 1500 });
  assert.deepEqual(byId.get(evRoom.id).cellRect, { x1: 1000, y1: 0, x2: 2000, y2: 1500 });
});

test('【失敗系】computeVoidCrosses: STAIR_VOID・通常部屋（feature未設定）は対象外', () => {
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.STAIR_VOID);
  graph.addRoom(new Set([right])); // feature未設定＝通常の部屋

  assert.deepEqual(computeVoidCrosses(graph), []);
});

test('【失敗系】computeVoidCrosses: 非矩形（L字）のVOID・昇降機は対象外', () => {
  // VOID（bottomRightを欠いたL字・3セル）
  const voidGrid = makeGrid2x2();
  const voidRoom = voidGrid.graph.addRoom(new Set([voidGrid.topLeft, voidGrid.topRight, voidGrid.bottomLeft]));
  voidRoom.setFeature(RoomFeature.VOID);
  assert.deepEqual(computeVoidCrosses(voidGrid.graph), [], 'VOIDの非矩形はスキップされるはず');

  // QA指摘（低3件・2件目）: 昇降機も同じ非矩形判定を通ることを固定する（別グラフ・同じL字形状）。
  const evGrid = makeGrid2x2();
  const evRoom = evGrid.graph.addRoom(new Set([evGrid.topLeft, evGrid.topRight, evGrid.bottomLeft]));
  evRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  assert.deepEqual(computeVoidCrosses(evGrid.graph), [], '昇降機の非矩形はスキップされるはず（VOIDと同じ矩形判定を通る）');
});

test('computeVoidCrosses: 器具行を持つ昇降路Roomは器具単位で×が出る（1列2基・重ならず合わせるとRoom全体）', () => {
  const { graph, left, right } = makeGrid();
  const room = graph.addRoom(new Set([left, right]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([left]), roomId: room.id });
  graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set([right]), roomId: room.id });

  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 2, 'Room単位ではなく器具単位で2件');
  const byId = new Map(result.map(c => [c.id, c]));
  assert.ok(byId.has('eq1') && byId.has('eq2'), 'idは行のid');
  assert.ok(!byId.has(room.id), 'Room単位の×は出ない');

  const a = byId.get('eq1'), b = byId.get('eq2');
  // 重ならない（aの右端とbの左端が一致 or 逆）
  assert.ok(a.x2 <= b.x1 || b.x2 <= a.x1, `矩形が重なっている: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
  // 合わせるとRoom全体（x:0〜2000）になる
  assert.deepEqual([Math.min(a.x1, b.x1), Math.max(a.x2, b.x2)], [0, 2000]);
});

test('computeVoidCrosses: L字に統合されたRoom（2行）でも×が2つ（idは行のid）', () => {
  const grid = makeGrid2x2();
  const room = grid.graph.addRoom(new Set([grid.topLeft, grid.topRight, grid.bottomLeft]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  grid.graph.addEquipmentRow({
    id: 'eqTop', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set([grid.topLeft, grid.topRight]), roomId: room.id,
  });
  grid.graph.addEquipmentRow({
    id: 'eqBottom', category: 'ev', usage: 'passenger', no: 2,
    cellKeys: new Set([grid.bottomLeft]), roomId: room.id,
  });

  const result = computeVoidCrosses(grid.graph);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(c => c.id).sort(), ['eqBottom', 'eqTop']);
});

test('computeVoidCrosses: 器具行の無い矩形の昇降路Roomは従来どおり×が1つ（idはRoomのid）', () => {
  const { graph, left, right } = makeGrid();
  const room = graph.addRoom(new Set([left, right]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  // 器具行を一切追加しない（旧データ相当）

  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, room.id);
});

test('【失敗系】computeVoidCrosses: 行のcellKeysが解決できない（CL無し）行は×を出さず例外にもならない', () => {
  const { graph, left } = makeGrid();
  const room = graph.addRoom(new Set([left]), '');
  room.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  graph.addEquipmentRow({
    id: 'eqBroken', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set(['no-such-cl-1:no-such-cl-2:no-such-cl-3:no-such-cl-4']), roomId: room.id,
  });

  assert.doesNotThrow(() => computeVoidCrosses(graph));
  const result = computeVoidCrosses(graph);
  assert.deepEqual(result.map(c => c.id), [], '解決できない行の×は出ない（他に器具行が無いためRoom側も無し）');
});

test('【失敗系】computeVoidCrosses: 行のroomIdが存在しないRoomを指しても例外にならない', () => {
  const { graph, left } = makeGrid();
  graph.addEquipmentRow({
    id: 'eqOrphan', category: 'ev', usage: 'passenger', no: 1,
    cellKeys: new Set([left]), roomId: 'no-such-room-id',
  });

  assert.doesNotThrow(() => computeVoidCrosses(graph));
  const result = computeVoidCrosses(graph);
  assert.equal(result.length, 1, '行自体のセルは解決できるので×は出る（roomIdの有効性はcross算出に無関係）');
  assert.equal(result[0].id, 'eqOrphan');
});

test('showsUpperVoidLabel: VOIDのみtrue（昇降機・feature無しはfalse）', () => {
  assert.equal(showsUpperVoidLabel({ feature: RoomFeature.VOID }), true);
  assert.equal(showsUpperVoidLabel({ feature: RoomFeature.ELEVATOR_EQUIPMENT }), false, '昇降機は同じシャフトが続くだけなので、破線を描く場合もラベルは付けない（裁定Q8のうち存続する部分）');
  assert.equal(showsUpperVoidLabel({ feature: null }), false);
  assert.equal(showsUpperVoidLabel(null), false, 'crossが無くても例外を投げない');
});

// visibleUpperVoidCrosses / ownVoidCellRects
// （2026-10-01裁定・QA指摘M1/M2で改訂: セル境界CLの値ベース・自階セルの和集合で判定する）

// upperCrosses に渡す「呼び出し側が実際に構築して渡す形」（cellRect付き）の合成ヘルパー。
const upper = (id, feature, r, cellRect = r) => ({ id, feature, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, cellRect });

test('visibleUpperVoidCrosses: 正常系（3階建て相当）— 2・3階に吹抜けがあるとき1階だけ破線が残り、2階には出ない', () => {
  const rect = { x1: 0, y1: 0, x2: 1000, y2: 1500 };
  const voidCross = upper('void-2f-3f', RoomFeature.VOID, rect);
  // 1階: 自階に吹抜け無し（ownCellRects=[]）→ 2階を peek した upperCrosses がそのまま残る
  assert.deepEqual(visibleUpperVoidCrosses([voidCross], []), [voidCross], '1階には自階に同位置の吹抜けが無いので破線が残るはず');

  // 2階: 自階に同位置の吹抜けセルがある（own=2階自身のセル矩形）→ 3階を peek した upperCrosses が除かれる
  assert.deepEqual(visibleUpperVoidCrosses([voidCross], [rect]), [], '2階には自階に同位置の吹抜けがあるので破線は出ないはず');
});

test('visibleUpperVoidCrosses: 昇降路 — 自階に同位置のセル矩形（設置階〜最上階で続くシャフト）があれば除かれ、無ければ残る', () => {
  const rect = { x1: 2000, y1: 0, x2: 3000, y2: 1500 };
  const evUpper = upper('eq1', RoomFeature.ELEVATOR_EQUIPMENT, rect);

  // EVを2階から設置: 1階（自階に昇降路が無い）には破線が出る
  assert.deepEqual(visibleUpperVoidCrosses([evUpper], []), [evUpper]);
  // 2階（自階に同じシャフトのセル矩形がある）には出ない
  assert.deepEqual(visibleUpperVoidCrosses([evUpper], [rect]), []);
});

test('visibleUpperVoidCrosses: featureを問わず自階セル矩形に収まれば除かれる（自階VOID・上階EVでも同様）', () => {
  const rect = { x1: 0, y1: 0, x2: 1000, y2: 1500 };
  const upperEv = upper('eq1', RoomFeature.ELEVATOR_EQUIPMENT, rect);
  assert.deepEqual(visibleUpperVoidCrosses([upperEv], [rect]), [], 'featureが違っても同位置なら除かれるはず');
});

test('visibleUpperVoidCrosses（実グラフ・QA指摘M1対応）: 上階は壁なし（cellRect=CL値）・自階は壁あり、でも同じセルなら除外される', () => {
  // 自階: EV室（x:0-1000,y:0-1500）の左辺（x=0のCL）に壁厚115mm相当（axisOffset=+57.5）の壁を持つ。
  // 旧実装（faceRectのx1..y2をeps=50で比較）ならこの壁厚ぶんで包含判定から外れうるが、
  // ownVoidCellRects は壁を一切見ない（cellBoundsList→CL値のみ）ため影響を受けないはず。
  const ownGrid = makeGrid();
  const ownRoom = ownGrid.graph.addRoom(new Set([ownGrid.left]));
  ownRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const [x0id, y0id, , y1id] = ownGrid.left.split(':');
  const x0 = ownGrid.graph.shapeMap.get(x0id), y0 = ownGrid.graph.shapeMap.get(y0id), y1 = ownGrid.graph.shapeMap.get(y1id);
  ownGrid.graph.addWall(x0, 57.5, true, y0, 0, y1, 0, { isRoomWall: true, wallFinish: 12.5 });
  const ownRects = ownVoidCellRects(ownGrid.graph);
  assert.deepEqual(ownRects, [{ x1: 0, y1: 0, x2: 1000, y2: 1500 }], '壁を足してもownVoidCellRectsはCL値のまま（壁厚の影響を受けない）');

  // 上階: 同座標のEV室・壁なし（別グラフ）。
  const upperGrid = makeGrid();
  const upperRoom = upperGrid.graph.addRoom(new Set([upperGrid.left]));
  upperRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  const upperCrosses = computeVoidCrosses(upperGrid.graph);
  assert.equal(upperCrosses.length, 1);
  assert.deepEqual(upperCrosses[0].cellRect, { x1: 0, y1: 0, x2: 1000, y2: 1500 });

  assert.deepEqual(visibleUpperVoidCrosses(upperCrosses, ownRects), [], '自階に壁があっても同じセルなら除外されるはず');
});

test('visibleUpperVoidCrosses（実グラフ・QA指摘M2対応）: 自階が器具2基（1マスずつ）・上階が統合1基（2マス）なら除外、自階の和集合が上階の一部しか覆わなければ残る', () => {
  const ownGrid = makeGrid();
  const ownRoom = ownGrid.graph.addRoom(new Set([ownGrid.left, ownGrid.right]), '');
  ownRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  ownGrid.graph.addEquipmentRow({ id: 'eq1', category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set([ownGrid.left]), roomId: ownRoom.id });
  ownGrid.graph.addEquipmentRow({ id: 'eq2', category: 'ev', usage: 'passenger', no: 2, cellKeys: new Set([ownGrid.right]), roomId: ownRoom.id });
  const ownRects = ownVoidCellRects(ownGrid.graph);
  assert.equal(ownRects.length, 2, '器具2基分の2セル矩形が返るはず（Room単位に丸めない）');

  const upperGrid = makeGrid();
  const upperRoom = upperGrid.graph.addRoom(new Set([upperGrid.left, upperGrid.right]), '');
  upperRoom.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  // 器具行を追加しない＝統合1基（Room単位の×が1件、cellRectはRoom全体x:0-2000）
  const upperCrosses = computeVoidCrosses(upperGrid.graph);
  assert.equal(upperCrosses.length, 1);
  assert.deepEqual(upperCrosses[0].cellRect, { x1: 0, y1: 0, x2: 2000, y2: 1500 });

  assert.deepEqual(visibleUpperVoidCrosses(upperCrosses, ownRects), [], '自階の2セル矩形の和集合が上階の統合1基を覆うので除外されるはず');

  // 自階がleftのみ（rightに器具・部屋が無い）なら、和集合は上階の左半分しか覆わないので残る
  const ownRectsLeftOnly = ownRects.filter(r => r.x1 === 0);
  assert.deepEqual(visibleUpperVoidCrosses(upperCrosses, ownRectsLeftOnly), upperCrosses, '自階の和集合が上階の一部しか覆わなければ残るはず');
});

test('visibleUpperVoidCrosses（実グラフ・QA指摘M2対応）: 自階の非矩形（L字）吹抜けが上階の矩形吹抜けを含めば除外される', () => {
  const ownGrid = makeGrid2x2();
  const ownRoom = ownGrid.graph.addRoom(new Set([ownGrid.topLeft, ownGrid.topRight, ownGrid.bottomLeft]));
  ownRoom.setFeature(RoomFeature.VOID);
  const ownRects = ownVoidCellRects(ownGrid.graph);
  assert.equal(ownRects.length, 3, 'L字（3セル）はcomputeVoidCrossesでは非矩形でスキップされるが、ownVoidCellRectsはセル単位で返す');

  // 上階: topLeft+topRight のみの矩形VOID（L字の上半分と同じ範囲。別グラフだが同座標のCL）
  const upperGrid = makeGrid2x2();
  const upperRoom = upperGrid.graph.addRoom(new Set([upperGrid.topLeft, upperGrid.topRight]));
  upperRoom.setFeature(RoomFeature.VOID);
  const upperCrosses = computeVoidCrosses(upperGrid.graph);
  assert.equal(upperCrosses.length, 1);
  assert.deepEqual(upperCrosses[0].cellRect, { x1: 0, y1: 0, x2: 2000, y2: 1000 });

  assert.deepEqual(visibleUpperVoidCrosses(upperCrosses, ownRects), [], '上階の矩形が自階L字の一部（欠けの無い範囲）に収まるので除外されるはず');
});

test('【失敗系】visibleUpperVoidCrosses: 部分的にしか重ならない・別位置の上階crossは残る', () => {
  const own = { x1: 0, y1: 0, x2: 1000, y2: 1500 };
  const partial = upper('partial', RoomFeature.VOID, { x1: 500, y1: 0, x2: 1500, y2: 1500 }); // 右へはみ出す
  const elsewhere = upper('elsewhere', RoomFeature.VOID, { x1: 2000, y1: 0, x2: 3000, y2: 1500 });
  assert.deepEqual(visibleUpperVoidCrosses([partial, elsewhere], [own]), [partial, elsewhere]);
});

test('【失敗系】visibleUpperVoidCrosses: 自階セル矩形が空なら全件残る', () => {
  const a = upper('a', RoomFeature.VOID, { x1: 0, y1: 0, x2: 1000, y2: 1500 });
  const b = upper('b', RoomFeature.ELEVATOR_EQUIPMENT, { x1: 2000, y1: 0, x2: 3000, y2: 1500 });
  assert.deepEqual(visibleUpperVoidCrosses([a, b], []), [a, b]);
  assert.deepEqual(visibleUpperVoidCrosses([a, b], undefined), [a, b], 'ownCellRects省略時も全件残るはず');
});

test('【失敗系】visibleUpperVoidCrosses: upperCrossesが空なら空を返す', () => {
  const own = { x1: 0, y1: 0, x2: 1000, y2: 1500 };
  assert.deepEqual(visibleUpperVoidCrosses([], [own]), []);
  assert.deepEqual(visibleUpperVoidCrosses(undefined, [own]), [], 'upperCrossesが未指定でも例外にならないはず');
});

test('【失敗系】visibleUpperVoidCrosses: eps境界 — eps以内のズレは覆われているとみなし、eps超のズレは残る', () => {
  const own = [{ x1: 0, y1: 0, x2: 1000, y2: 1500 }];
  const withinEps = upper('withinEps', RoomFeature.VOID, { x1: -0.5, y1: 0, x2: 999.5, y2: 1500 });
  const beyondEps = upper('beyondEps', RoomFeature.VOID, { x1: -5, y1: 0, x2: 995, y2: 1500 });
  assert.deepEqual(visibleUpperVoidCrosses([withinEps], own, 1), [], 'eps=1以内のズレは覆われているとみなし除外されるはず');
  assert.deepEqual(visibleUpperVoidCrosses([beyondEps], own, 1), [beyondEps], 'eps=1を超えるズレは覆われず残るはず');
  // 既定 eps（CELL_RECT_EPS_MM）を固定する——引数省略でも 0.5mm のズレは除外されるはず（既定を 0 にする変異で赤）
  assert.deepEqual(visibleUpperVoidCrosses([withinEps], own), [], '既定 eps でも 0.5mm のズレは覆われているとみなし除外されるはず');
});

test('【失敗系】visibleUpperVoidCrosses: 幅がeps以下に退化した上階crossは、自階が遠くにあっても「覆われた」扱いにしない', () => {
  const own = [{ x1: 5000, y1: 0, x2: 6000, y2: 1500 }];
  const degenerate = upper('degenerate', RoomFeature.VOID, { x1: 0, y1: 0, x2: 0.5, y2: 1500 });
  assert.deepEqual(visibleUpperVoidCrosses([degenerate], own), [degenerate], '判定した小矩形が0件なら覆われていない扱いで残るはず');
});

test('ownVoidCellRects: graphが無ければ空配列、VOID・昇降路以外の部屋は含めない', () => {
  assert.deepEqual(ownVoidCellRects(null), []);
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.STAIR_VOID);
  graph.addRoom(new Set([right])); // feature未設定＝通常の部屋
  assert.deepEqual(ownVoidCellRects(graph), []);
});

