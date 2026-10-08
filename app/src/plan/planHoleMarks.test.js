// planHoleMarks.js（穴の注記＝×・上階破線）の単体テスト。
// 上階破線の被覆判定は voidGeometry.test.js の visibleUpperVoidCrosses の意味を移植している。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature } from '@core';

import { floorOpeningGroups } from '../finish/stair/slabOpening.js';
import {
  planHoleMarks, selfVoidHoleRects, rectCoveredByUnion, showsUpperVoidLabel, insetRect, labelPlacement, UPPER_VOID_DASH_PX,
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

test('UPPER_VOID_DASH_PX は旧経路（voidGeometry）と同じ [8,4]', () => {
  assert.deepEqual(UPPER_VOID_DASH_PX, [8, 4]);
});
