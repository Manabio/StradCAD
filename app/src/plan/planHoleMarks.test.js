// planHoleMarks.js（穴の注記＝×・上階破線）の単体テスト。
// 上階破線の被覆判定は旧 voidGeometry.test.js（S6b で削除）の visibleUpperVoidCrosses の意味を移植している。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';

import { floorOpeningGroups } from '../finish/stair/slabOpening.js';
import { getAllCells } from '../finish/gridCells.js';
import { openingCrossDash } from '../renderer/dimensionStyle.js';
import { LodLevel } from '../viewport.js';
import { isCenterLineDragging } from './planSolidsLayerFilter.js';
import {
  planHoleMarks, planHoleMarksOf, planHoleMarkPrimitives, HOLE_MARK_DASH,
  selfVoidHoleRects, rectCoveredByUnion, showsUpperVoidLabel, insetRect, labelPlacement, UPPER_VOID_DASH_PX,
} from './planHoleMarks.js';

function makeGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const xm = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  return {
    graph, x0, y0, y1,
    left: `${x0.id}:${y0.id}:${xm.id}:${y1.id}`,
    right: `${xm.id}:${y0.id}:${x1.id}:${y1.id}`,
  };
}

// 開口グループの合成（呼び出し側が floorOpeningGroups から受け取る形）
const grp = (id, kind, feature, rect, cellRect = rect) => ({ id, kind, feature, cellKeys: new Set(), cellRect, innerRect: rect });
const R = { x1: 0, y1: 0, x2: 1000, y2: 1500 };

test('自階の×: void・shaft の innerRect が cross になる（階段系・innerRect なしは出ない）', () => {
  const marks = planHoleMarks({
    selfGroups: [
      grp('v', 'void', RoomFeature.VOID, R),
      grp('e', 'shaft', RoomFeature.ELEVATOR_EQUIPMENT, { x1: 1000, y1: 0, x2: 2000, y2: 1500 }),
      { id: 'sv', kind: 'stairVoid', feature: RoomFeature.STAIR_VOID, cellKeys: new Set(), cellRect: null, innerRect: null },
      { id: 'l', kind: 'void', feature: RoomFeature.VOID, cellKeys: new Set(), cellRect: null, innerRect: null },
    ],
  });
  assert.deepEqual(marks.map(m => [m.key, m.role, m.dashKind, m.outline, m.label]), [
    ['cross:v', 'cross', 'openingCross', false, false],
    ['cross:e', 'cross', 'openingCross', false, false],
  ]);
  assert.deepEqual(marks[0].rect, R);
  assert.deepEqual(marks[0].source, { kind: 'void', id: 'v', feature: RoomFeature.VOID });
});

test('上階破線: 自階の穴に全部覆われていれば無し・一部しか覆われなければ有り・自階に穴が無ければ有り', () => {
  const up = [grp('u', 'void', RoomFeature.VOID, R)];
  assert.deepEqual(planHoleMarks({ selfVoidCells: [R], aboveGroups: up }), [], '同位置の穴があれば出さない');
  assert.equal(planHoleMarks({ selfVoidCells: [], aboveGroups: up }).length, 1, '自階に穴が無い');
  assert.equal(planHoleMarks({ aboveGroups: up }).length, 1, 'selfVoidCells 省略も穴なし扱い');
  assert.equal(planHoleMarks({ selfVoidCells: [{ x1: 0, y1: 0, x2: 500, y2: 1500 }], aboveGroups: up }).length, 1, '半分しか覆わない');
  const two = [{ x1: 0, y1: 0, x2: 1000, y2: 750 }, { x1: 0, y1: 750, x2: 1000, y2: 1500 }];
  assert.deepEqual(planHoleMarks({ selfVoidCells: two, aboveGroups: up }), [], '複数の矩形の和で覆えば出さない');
});

test('上階破線: ラベルは VOID だけ・outline あり・rect は innerRect で cellRect は別', () => {
  const inner = { x1: 57.5, y1: 57.5, x2: 942.5, y2: 1442.5 };
  const marks = planHoleMarks({
    aboveGroups: [grp('u', 'void', RoomFeature.VOID, inner, R), grp('e', 'shaft', RoomFeature.ELEVATOR_EQUIPMENT, inner, { x1: 5000, y1: 0, x2: 6000, y2: 1500 })],
  });
  assert.deepEqual(marks.map(m => [m.key, m.role, m.dashKind, m.outline, m.label]), [
    ['upper:u', 'upperVoid', 'upperVoid', true, true],
    ['upper:e', 'upperVoid', 'upperVoid', true, false],
  ]);
  assert.deepEqual(marks[0].rect, inner);
  assert.deepEqual(marks[0].cellRect, R);
});

test('aboveGroups が null（上上階なし）・undefined（未解決）なら上階分は無し。cross は影響を受けない', () => {
  const self = [grp('v', 'void', RoomFeature.VOID, R)];
  for (const above of [null, undefined]) {
    const marks = planHoleMarks({ selfGroups: self, aboveGroups: above });
    assert.deepEqual(marks.map(m => m.key), ['cross:v']);
  }
  assert.deepEqual(planHoleMarks(), []);
});

test('【失敗系】不正なグループ（rect なし・非有限・kind 違い・null）は捨てる。上階は cellRect も要る', () => {
  const bad = [
    null,
    { id: 'a', kind: 'void', feature: RoomFeature.VOID },
    { id: 'b', kind: 'void', feature: RoomFeature.VOID, innerRect: { x1: 0, y1: 0, x2: NaN, y2: 1 }, cellRect: R },
    grp('c', 'stairBeyond', null, R),
    { id: 'd', kind: 'void', feature: RoomFeature.VOID, innerRect: R, cellRect: null },
  ];
  assert.doesNotThrow(() => planHoleMarks({ selfGroups: bad, aboveGroups: bad }));
  assert.deepEqual(planHoleMarks({ selfGroups: bad, aboveGroups: bad }).map(m => m.key), ['cross:d'], 'd は cellRect が無くても自階の×は出る');
});

test('実グラフ: floorOpeningGroups→planHoleMarks。上階は壁なし・自階は同位置の穴で除外、別位置なら残る', () => {
  const own = makeGrid();
  own.graph.addRoom(new Set([own.left])).setFeature(RoomFeature.VOID);
  const up1 = makeGrid();
  up1.graph.addRoom(new Set([up1.left])).setFeature(RoomFeature.VOID);
  const up2 = makeGrid();
  up2.graph.addRoom(new Set([up2.right])).setFeature(RoomFeature.VOID);
  const selfGroups = floorOpeningGroups(own.graph);
  const selfVoidCells = selfVoidHoleRects(own.graph);
  assert.deepEqual(selfVoidCells, [{ x1: 0, y1: 0, x2: 1000, y2: 1500 }]);
  assert.deepEqual(planHoleMarks({ selfGroups, selfVoidCells, aboveGroups: floorOpeningGroups(up1.graph) }).map(m => m.role), ['cross']);
  assert.deepEqual(planHoleMarks({ selfGroups, selfVoidCells, aboveGroups: floorOpeningGroups(up2.graph) }).map(m => m.role), ['cross', 'upperVoid']);
});

test('selfVoidHoleRects: 階段吹抜け・破れ先は含めない。graph null は空', () => {
  assert.deepEqual(selfVoidHoleRects(null), []);
  const { graph, left, right } = makeGrid();
  graph.addRoom(new Set([left])).setFeature(RoomFeature.STAIR_VOID);
  graph.addRoom(new Set([right])).setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  assert.deepEqual(selfVoidHoleRects(graph), [{ x1: 1000, y1: 0, x2: 2000, y2: 1500 }]);
});

test('selfVoidHoleRects: STAIR_VOID を先・VOID を後に同じセルへ置いても VOID のセルは落ちず、同位置の上階 VOID の破線は出ない', () => {
  const own = makeGrid();
  own.graph.addRoom(new Set([own.left])).setFeature(RoomFeature.STAIR_VOID);
  own.graph.addRoom(new Set([own.left])).setFeature(RoomFeature.VOID);
  const up = makeGrid();
  up.graph.addRoom(new Set([up.left])).setFeature(RoomFeature.VOID);
  const selfVoidCells = selfVoidHoleRects(own.graph);
  assert.deepEqual(selfVoidCells, [{ x1: 0, y1: 0, x2: 1000, y2: 1500 }]);
  assert.deepEqual(planHoleMarks({ selfVoidCells, aboveGroups: floorOpeningGroups(up.graph) }), []);
});

test('rectCoveredByUnion: eps 内のズレは覆われ・eps 超は覆われない・退化 rect は覆われない扱い', () => {
  const own = [R];
  assert.equal(rectCoveredByUnion({ x1: -0.5, y1: 0, x2: 999.5, y2: 1500 }, own, 1), true);
  assert.equal(rectCoveredByUnion({ x1: -5, y1: 0, x2: 995, y2: 1500 }, own, 1), false);
  assert.equal(rectCoveredByUnion({ x1: 0, y1: 0, x2: 0.5, y2: 1500 }, [{ x1: 5000, y1: 0, x2: 6000, y2: 1500 }]), false);
  assert.equal(rectCoveredByUnion({ x1: 0, y1: 0, x2: 0.5, y2: 1500 }, own), false, '判定した小矩形 0 件');
});

test('showsUpperVoidLabel: VOID だけ true', () => {
  assert.equal(showsUpperVoidLabel({ feature: RoomFeature.VOID }), true);
  assert.equal(showsUpperVoidLabel({ feature: RoomFeature.ELEVATOR_EQUIPMENT }), false);
  assert.equal(showsUpperVoidLabel(null), false);
});

test('insetRect: 内側へ縮める。退化（幅・高さ 0 以下）は null', () => {
  assert.deepEqual(insetRect(R, 10), { x1: 10, y1: 10, x2: 990, y2: 1490 });
  assert.equal(insetRect(R, 500), null, '幅が 0');
  assert.equal(insetRect(R, 600), null, '座標が交差');
});

test('labelPlacement: 広ければ1行・やや狭ければ2行・狭ければ H/4 クランプの1行・退化は null', () => {
  const one = labelPlacement({ x1: 0, y1: 0, x2: 200, y2: 400 }, 12, 2, 2);
  assert.deepEqual(one.lines, ['上部吹抜け']);
  assert.equal(one.cx, 100);
  assert.deepEqual(one.widths, [60]);
  const two = labelPlacement({ x1: 0, y1: 0, x2: 60, y2: 200 }, 12, 2, 2);
  assert.deepEqual(two.lines, ['上部', '吹抜け']);
  assert.deepEqual(two.widths, [24, 36]);
  const clamp = labelPlacement({ x1: 0, y1: 0, x2: 20, y2: 20 }, 12, 2, 2);
  assert.deepEqual(clamp.lines, ['上部吹抜け']);
  assert.equal(clamp.y, 10 - 20 / 4 - 12 / 2, '中心から H/4 上へ');
  assert.equal(labelPlacement({ x1: 0, y1: 0, x2: 0, y2: 10 }, 12, 2, 2), null);
  assert.equal(labelPlacement({ x1: 0, y1: 0, x2: 10, y2: -1 }, 12, 2, 2), null);
});

test('UPPER_VOID_DASH_PX は [8,4]（階段の破れ先の破線 stairDownviewDashPx もこれを参照する）', () => {
  assert.deepEqual(UPPER_VOID_DASH_PX, [8, 4]);
});

test('planHoleMarksOf: 自階が L 字の吹抜け（3セル）で、上階の矩形吹抜け（その中の2セル）を含めば上階破線なし。含まなければあり', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  graph.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 1000, extentHi: 2000 }); // 上段では非アクティブ＝L字結合
  graph.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  // L字 = 上段（0..2000 × 0..1000）∪ 下段左（0..1000 × 1000..2000）
  const cells = getAllCells(graph);
  const topKey = cells.find(c => c.y1 === 0 && c.y2 === 1000 && c.x1 === 0 && c.x2 === 2000).key;
  const blKey = cells.find(c => c.y1 === 1000 && c.y2 === 2000 && c.x1 === 0 && c.x2 === 1000).key;
  graph.addRoom(new Set([topKey, blKey])).setFeature(RoomFeature.VOID);
  assert.equal(floorOpeningGroups(graph)[0].cellRect, null, '前提: 自階は非矩形（L字）');

  // 上階: 矩形の吹抜け 0..2000 × 0..1000（L字の上段に含まれる。2セル相当）
  const upper = new PlanGraph(new Plane('p2', 3000, '2階', 2, 1));
  const ux = [0, 1000, 2000].map(v => upper.addCenterLine(CenterLineType.VERTICAL, v, opt));
  const uy = [0, 1000].map(v => upper.addCenterLine(CenterLineType.HORIZONTAL, v, opt));
  const [l, r] = [`${ux[0].id}:${uy[0].id}:${ux[1].id}:${uy[1].id}`, `${ux[1].id}:${uy[0].id}:${ux[2].id}:${uy[1].id}`];
  upper.addRoom(new Set([l, r])).setFeature(RoomFeature.VOID);
  const aboveGroups = floorOpeningGroups(upper, { stairFilter: () => false });
  assert.deepEqual(aboveGroups[0].cellRect, { x1: 0, y1: 0, x2: 2000, y2: 1000 }, '前提: 上階は矩形');
  const roles = planHoleMarksOf(graph, aboveGroups).map(m => m.role);
  assert.equal(roles.filter(x => x === 'upperVoid').length, 0, 'L字の和に覆われる');
  assert.equal(roles.filter(x => x === 'cross').length, 0, 'L字の自階は×なし');

  // 失敗系: 自階が下段左だけなら覆われず破線が出る
  const small = new PlanGraph(new Plane('p3', 0, '1階', 1, 1));
  small.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  small.addCenterLine(CenterLineType.VERTICAL, 1000, { ...opt, extentLo: 1000, extentHi: 2000 });
  small.addCenterLine(CenterLineType.VERTICAL, 2000, opt);
  small.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  small.addCenterLine(CenterLineType.HORIZONTAL, 1000, opt);
  small.addCenterLine(CenterLineType.HORIZONTAL, 2000, opt);
  const blOnly = getAllCells(small).find(c => c.y1 === 1000 && c.y2 === 2000 && c.x1 === 0 && c.x2 === 1000).key;
  small.addRoom(new Set([blOnly])).setFeature(RoomFeature.VOID);
  assert.equal(planHoleMarksOf(small, aboveGroups).filter(m => m.role === 'upperVoid').length, 1);
});

test('planHoleMarksOf: 自階が器具2基（1マスずつ）の昇降路で、上階が統合1基（2マス）なら破線なし。自階が1基だけなら破線あり', () => {
  const addRow = (g, id, keys, roomId) =>
    g.addEquipmentRow({ id, category: 'ev', usage: 'passenger', no: 1, cellKeys: new Set(keys), roomId });
  const self2 = makeGrid();
  const room2 = self2.graph.addRoom(new Set([self2.left, self2.right]), '');
  room2.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  addRow(self2.graph, 'eq1', [self2.left], room2.id);
  addRow(self2.graph, 'eq2', [self2.right], room2.id);
  const up = makeGrid();
  const roomU = up.graph.addRoom(new Set([up.left, up.right]), '');
  roomU.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  addRow(up.graph, 'equ', [up.left, up.right], roomU.id);
  const aboveGroups = floorOpeningGroups(up.graph, { stairFilter: () => false });
  assert.deepEqual(aboveGroups.map(g => [g.id, g.cellRect]), [['equ', { x1: 0, y1: 0, x2: 2000, y2: 1500 }]], '前提: 上階は統合1基');
  const marks2 = planHoleMarksOf(self2.graph, aboveGroups);
  assert.deepEqual(marks2.map(m => m.role), ['cross', 'cross'], '自階2基の和が上階を覆う＝破線なし');

  const self1 = makeGrid();
  const room1 = self1.graph.addRoom(new Set([self1.left]), '');
  room1.setFeature(RoomFeature.ELEVATOR_EQUIPMENT);
  addRow(self1.graph, 'eq1', [self1.left], room1.id);
  const marks1 = planHoleMarksOf(self1.graph, aboveGroups);
  assert.deepEqual(marks1.map(m => m.role), ['cross', 'upperVoid'], '自階1基だけでは覆われず破線あり');
  assert.equal(marks1[1].label, false, '昇降路にはラベルなし');
});

// ---- planHoleMarkPrimitives（描画プリミティブへの写像）----
const VIEW = { thickPx: 2, thinPx: 1, scale: 0.1, lod: LodLevel.DETAIL }; // inset = 2/0.1 = 20mm
const crossMark = { key: 'cross:a', role: 'cross', rect: R, dashKind: 'openingCross', outline: false, label: false };
const upperMark = { key: 'upper:b', role: 'upperVoid', rect: R, dashKind: 'upperVoid', outline: true, label: true };

test('planHoleMarkPrimitives: cross は太線1本分内側の対角2本・一点鎖線（openingCrossDash(thin)）・外形なし・文字なし', () => {
  const out = planHoleMarkPrimitives([crossMark], VIEW);
  assert.deepEqual(out.map(p => p.key), ['cross:a:d1', 'cross:a:d2']);
  assert.deepEqual(out[0].points, [20, 20, 980, 1480]);
  assert.deepEqual(out[1].points, [980, 20, 20, 1480]);
  for (const p of out) {
    assert.equal(p.kind, 'line');
    assert.equal(p.closed, false);
    assert.deepEqual(p.dash, openingCrossDash(1));
  }
});

test('planHoleMarkPrimitives: upperVoid は対角2本＋閉じた外形が UPPER_VOID_DASH_PX、label なら「上部吹抜け」の文字（位置は labelPlacement）', () => {
  const out = planHoleMarkPrimitives([upperMark], VIEW);
  const lines = out.filter(p => p.kind === 'line');
  assert.deepEqual(lines.map(p => p.key), ['upper:b:d1', 'upper:b:d2', 'upper:b:outline']);
  for (const p of lines) assert.deepEqual(p.dash, UPPER_VOID_DASH_PX);
  assert.equal(lines[2].closed, true);
  assert.deepEqual(lines[2].points, [20, 20, 980, 20, 980, 1480, 20, 1480]);
  const texts = out.filter(p => p.kind === 'text');
  const lp = labelPlacement({ x1: 20, y1: 20, x2: 980, y2: 1480 }, 12 / 0.1, 2 / 0.1, 2 / 0.1);
  assert.deepEqual(texts.map(t => t.text), lp.lines);
  assert.equal(texts[0].x, lp.cx);
  assert.equal(texts[0].y, lp.y);
  assert.equal(texts[0].fontSize, 120);
  assert.equal(texts[0].offsetX, lp.widths[0] / 2);
});

test('planHoleMarkPrimitives: LOD SCHEMATIC ではラベルの文字だけ落ち、線は全 LOD で出る。label なしの mark は文字なし', () => {
  const sch = planHoleMarkPrimitives([upperMark], { ...VIEW, lod: LodLevel.SCHEMATIC });
  assert.equal(sch.filter(p => p.kind === 'text').length, 0);
  assert.equal(sch.filter(p => p.kind === 'line').length, 3);
  const std = planHoleMarkPrimitives([upperMark], { ...VIEW, lod: LodLevel.STANDARD });
  assert.ok(std.some(p => p.kind === 'text'), 'STANDARD ではラベルを出す');
  assert.equal(planHoleMarkPrimitives([{ ...upperMark, label: false }], VIEW).filter(p => p.kind === 'text').length, 0);
});

test('【失敗系】planHoleMarkPrimitives: インセットで退化する矩形・空入力は何も出さない（交差した×を描かない）', () => {
  assert.deepEqual(planHoleMarkPrimitives([crossMark], { ...VIEW, thickPx: 100 }), [], '幅が 0 以下');
  assert.deepEqual(planHoleMarkPrimitives([], VIEW), []);
  assert.deepEqual(planHoleMarkPrimitives(undefined, VIEW), []);
});

test('HOLE_MARK_DASH: dashKind → 破線の写像はここ1か所（openingCross＝線幅基準の一点鎖線・upperVoid＝固定 [8,4]）', () => {
  assert.deepEqual(Object.keys(HOLE_MARK_DASH).sort(), ['openingCross', 'upperVoid']);
  assert.deepEqual(HOLE_MARK_DASH.openingCross(2), openingCrossDash(2));
  assert.deepEqual(HOLE_MARK_DASH.upperVoid(2), UPPER_VOID_DASH_PX);
});

// ---- planHoleMarksOf（レイヤが毎レンダーで呼ぶ経路。ドラッグ中も再計算される）----
function dragGrid() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const opt = { labeled: false, discipline: Discipline.ARCH };
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, opt);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 1000, opt);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, opt);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 1500, opt);
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`])).setFeature(RoomFeature.VOID);
  return { graph, x1 };
}

test('planHoleMarksOf: 通り芯ドラッグ中（pendingDelta≠0）でも自階の×は前回のままにならず追従する', () => {
  const { graph, x1 } = dragGrid();
  const before = planHoleMarksOf(graph, null).map(m => m.rect);
  assert.equal(before.length, 1);
  assert.equal(isCenterLineDragging(graph), false);
  x1.pendingDelta = 100;
  assert.equal(isCenterLineDragging(graph), true, '通り芯ドラッグ中');
  const during = planHoleMarksOf(graph, null).map(m => m.rect);
  assert.equal(during.length, 1);
  assert.equal(during[0].x2 - before[0].x2, 100, 'ドラッグ量だけ×の端点が動く');
  assert.equal(during[0].x1, before[0].x1);
});

test('planHoleMarksOf: graph なしは空。aboveGroups が null・undefined なら自階の×だけ。上階があれば自階が覆わない穴の破線が加わる', () => {
  assert.deepEqual(planHoleMarksOf(null, null), []);
  const { graph } = dragGrid();
  assert.deepEqual(planHoleMarksOf(graph, undefined).map(m => m.role), ['cross']);
  assert.deepEqual(planHoleMarksOf(graph, null).map(m => m.role), ['cross']);
  const other = makeGrid();
  other.graph.addRoom(new Set([other.right])).setFeature(RoomFeature.VOID);
  assert.deepEqual(planHoleMarksOf(graph, floorOpeningGroups(other.graph, { stairFilter: () => false })).map(m => m.role), ['cross', 'upperVoid']);
});
