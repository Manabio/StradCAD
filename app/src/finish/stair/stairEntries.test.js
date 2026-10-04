import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyCellBoundsOverlap, buildStairEntries } from './stairEntries.js';
import { LodLevel } from '../../viewport.js';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { classifyStairArea } from './stairClassify.js';

// ---- anyCellBoundsOverlap（下階階段の見下げ upper エントリが自階 install エントリと同一
//      footprint かどうかの判定。cellBounds 同士の総当たり。RECT_OVERLAP_EPS=1mm未満は無視） ----

test('anyCellBoundsOverlap: 空配列・undefined は false', () => {
  const rect = { x1: 0, x2: 10, y1: 0, y2: 10 };
  assert.equal(anyCellBoundsOverlap([], [rect]), false);
  assert.equal(anyCellBoundsOverlap([rect], []), false);
  assert.equal(anyCellBoundsOverlap(undefined, [rect]), false);
  assert.equal(anyCellBoundsOverlap([rect], undefined), false);
});

test('anyCellBoundsOverlap: ちょうど接触（0mm）は false', () => {
  const a = { x1: 0, x2: 10, y1: 0, y2: 10 };
  const b = { x1: 10, x2: 20, y1: 0, y2: 10 }; // aの右端とbの左端が一致
  assert.equal(anyCellBoundsOverlap([a], [b]), false);
});

test('anyCellBoundsOverlap: EPS(1mm)未満の重なりは false', () => {
  const a = { x1: 0, x2: 10, y1: 0, y2: 10 };
  const b = { x1: 9.5, x2: 19.5, y1: 0, y2: 10 }; // x方向に0.5mmだけ重なる
  assert.equal(anyCellBoundsOverlap([a], [b]), false);
});

test('anyCellBoundsOverlap: EPS(1mm)を超える重なりは true', () => {
  const a = { x1: 0, x2: 10, y1: 0, y2: 10 };
  const b = { x1: 5, x2: 15, y1: 0, y2: 10 }; // x方向に5mm重なる
  assert.equal(anyCellBoundsOverlap([a], [b]), true);
});

test('anyCellBoundsOverlap: listA・listBのいずれかの組み合わせで重なれば true（総当たり）', () => {
  const farA  = { x1: 0,   x2: 10,  y1: 0, y2: 10 };
  const nearA = { x1: 100, x2: 110, y1: 0, y2: 10 };
  const b     = { x1: 105, x2: 115, y1: 0, y2: 10 }; // nearA とだけ重なる
  assert.equal(anyCellBoundsOverlap([farA, nearA], [b]), true);
});

// ---- isStairMode（どのモードで階段を描くか） ----
// 不具合2026-09: 建具モードに入ると階段関連の図が消えた——ここのモード列挙だけが壁・建具・柱の
// 述語（renderer/planFigureVisibility.js）と食い違っていたのが原因。両者が同じ述語を引くこと、
// つまり「平面図を描くモード＝階段を描くモード」を固定する。
test('buildStairEntries: 平面図を描くモード（建具・敷地を含む）で階段を描き、伏図・展開図では描かない', () => {
  const graph = { stairs: [] };
  const project = { planes: [], activePlane: null };
  const viewport = { lodLevel: LodLevel.DETAIL };
  const call = (appMode) => buildStairEntries(graph, project, {
    appMode, viewport, upperStairEntriesPeek: null, stairBreakOverhangMm: 0,
  });
  for (const mode of ['floorplan', 'finish', 'opening', 'site']) {
    assert.equal(call(mode).isStairMode, true, mode);
  }
  for (const mode of ['structure', 'elevation']) {
    assert.equal(call(mode).isStairMode, false, mode);
  }
});

// ---- upper エントリの wallGraph（上の階から見る側面線は表示中の階の壁で判定する） ----
// 判断は純モジュール（ここ）に置き、StairLayer は e.wallGraph を渡すだけにする。
function activeGraphWithStair() {
  const graph = new PlanGraph(new Plane('p2', 1, '2階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), y0 = H(0), y1 = H(2800);
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const cells = new Set([key]);
  const cls = classifyStairArea(cells, graph, 2800, [key]);
  graph.addStair({ type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: cls.sections });
  return graph;
}
const peekEntry = (id, rect) => ({ id, stair: {}, graph: { tag: 'below' }, cellBounds: [rect] });

test('buildStairEntries: upperEntries は installOverlap あり・なしとも wallGraph === 自階グラフ、installEntries は持たない', () => {
  const graph = activeGraphWithStair();
  const project = { planes: [], activePlane: null };
  const viewport = { lodLevel: LodLevel.DETAIL };
  const overlapping = peekEntry('low-a', { x1: 0, y1: 0, x2: 1000, y2: 2800 });
  const apart = peekEntry('low-b', { x1: 50000, y1: 50000, x2: 51000, y2: 52800 });
  const r = buildStairEntries(graph, project, {
    appMode: 'finish', viewport, upperStairEntriesPeek: [overlapping, apart], stairBreakOverhangMm: 0,
  });
  assert.equal(r.installEntries.length, 1);
  assert.equal(r.upperEntries.length, 2);
  const a = r.upperEntries.find(e => e.id === 'low-a');
  const b = r.upperEntries.find(e => e.id === 'low-b');
  assert.equal(a.installOverlap, true, '重なる側は installOverlap');
  assert.equal(b.installOverlap, undefined, '重ならない側は installOverlap 無し');
  assert.equal(a.wallGraph, graph);
  assert.equal(b.wallGraph, graph);
  assert.notEqual(a.graph, graph, 'footprint 用の graph は下階のまま');
  assert.equal(r.installEntries.every(e => !('wallGraph' in e)), true);
});

test('buildStairEntries: 平面を描かないモード（structure）では upperEntries は空（wallGraph を付ける対象が無い）', () => {
  const graph = activeGraphWithStair();
  const r = buildStairEntries(graph, { planes: [], activePlane: null }, {
    appMode: 'structure', viewport: { lodLevel: LodLevel.DETAIL },
    upperStairEntriesPeek: [peekEntry('low-a', { x1: 0, y1: 0, x2: 1000, y2: 2800 })], stairBreakOverhangMm: 0,
  });
  assert.deepEqual(r.upperEntries, []);
});
