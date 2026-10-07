import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyCellBoundsOverlap, buildStairEntries, buildUpperStairPeekEntries } from './stairEntries.js';
import { generateStairPartitionWalls } from './stairPartitionWalls.js';
import { LodLevel } from '../../viewport.js';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, RoomFeature } from '@core';
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

// ---- N+1 平面の隔て壁の天端の輪郭（partitionOutline）----
// 下階 N: 折返し階段（軸 x=1000・区間 y1000〜4000）＋隔て壁。N+1: 階段室の上に STAIR_VOID（y0〜voidY2）。
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];
function graphWithCells(plane, rects, setup) {
  const graph = new PlanGraph(plane);
  const vs = new Map(), hs = new Map();
  const V = (v) => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = (v) => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  setup(graph, cells);
  return graph;
}
function lowerWithPartition({ walls = true } = {}) {
  const graph = graphWithCells(new Plane('p1', 0, '1階', 1, 1), EQUAL_UP, (g, cells) => {
    g.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up' });
  });
  if (walls) generateStairPartitionWalls(graph, { structure: '木造（在来）' });
  return graph;
}
function upperWithVoid(voidRects, { installStair = false } = {}) {
  return graphWithCells(new Plane('p2', 1, '2階', 1, 1), voidRects, (g, cells) => {
    const room = g.addRoom(cells, '');
    room.setFeature(RoomFeature.STAIR_VOID);
    if (installStair) {
      const sc = new Set(EQUAL_UP.map(([x1, y1, x2, y2]) => {
        const v = (val) => g.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === val)
          ?? g.addCenterLine(CenterLineType.VERTICAL, val, { labeled: false, discipline: Discipline.ARCH });
        const h = (val) => g.centerLines.find(c => c.centerLineType === CenterLineType.HORIZONTAL && c.value === val)
          ?? g.addCenterLine(CenterLineType.HORIZONTAL, val, { labeled: false, discipline: Discipline.ARCH });
        return `${v(x1).id}:${h(y1).id}:${v(x2).id}:${h(y2).id}`;
      }));
      g.addStair({ type: StairType.SWITCHBACK, cells: sc, sections: [6, 1, 6], flip: false, upDirection: 'up' });
    }
  });
}
const buildFor = (upper, lower) => buildStairEntries(upper, { planes: [], activePlane: null }, {
  appMode: 'finish', viewport: { lodLevel: LodLevel.DETAIL },
  upperStairEntriesPeek: buildUpperStairPeekEntries(lower, 2400), stairBreakOverhangMm: 0,
});
const spanOf = (segs) => ({
  y1: Math.min(...segs.flatMap(s => [s.y1, s.y2])), y2: Math.max(...segs.flatMap(s => [s.y1, s.y2])),
  x1: Math.min(...segs.flatMap(s => [s.x1, s.x2])), x2: Math.max(...segs.flatMap(s => [s.x1, s.x2])),
});

test('partitionOutline: 重ならない upper エントリに付き、軸±57.5 の長い2本と踊り場側の端の線になる。上り口側は N+1 の開口の面で切れる', () => {
  const lower = lowerWithPartition();
  const upper = upperWithVoid([[0, 0, 2000, 3000]]); // 開口は y0〜3000（隔て壁の y3000〜4000 は N+1 の床の下）
  const e = buildFor(upper, lower).upperEntries[0];
  assert.ok(e.partitionOutline?.length > 0);
  const sp = spanOf(e.partitionOutline);
  assert.ok(Math.abs(sp.x1 - 942.5) < 1e-6 && Math.abs(sp.x2 - 1057.5) < 1e-6, `x 範囲 ${sp.x1}〜${sp.x2}`);
  assert.equal(sp.y1, 1000, '踊り場側の端');
  assert.ok(sp.y2 < 3200 && sp.y2 > 2800, `上り口側は開口の面（約3000）で切れる: ${sp.y2}`);
  const vertical = e.partitionOutline.filter(s => s.x1 === s.x2 && Math.abs(s.y2 - s.y1) > 1000);
  assert.equal(vertical.length, 2, '軸±57.5 の長い縦線が2本（レーン間の継ぎ目の 955 は合併で消える）');
});

test('partitionOutline【失敗系】自階の開口がこの階段と重ならなければ切らず全長（安全側）', () => {
  const lower = lowerWithPartition();
  const upper = upperWithVoid([[50000, 50000, 51000, 52000]]);
  const e = buildFor(upper, lower).upperEntries[0];
  assert.equal(spanOf(e.partitionOutline).y2, 4000);
});

test('partitionOutline【失敗系】下階に隔て壁が無ければ付かない', () => {
  const lower = lowerWithPartition({ walls: false });
  const upper = upperWithVoid([[0, 0, 2000, 3000]]);
  const e = buildFor(upper, lower).upperEntries[0];
  assert.equal('partitionOutline' in e, false);
});

test('partitionOutline【失敗系】続く層（自階の install 階段と重なる）には付かない', () => {
  const lower = lowerWithPartition();
  const upper = upperWithVoid([[0, 0, 2000, 3000]], { installStair: true });
  const r = buildFor(upper, lower);
  assert.equal(r.upperEntries[0].installOverlap, true);
  assert.equal('partitionOutline' in r.upperEntries[0], false);
});

test('partitionOutline: N+1 の上り口辺（CL y=3000）に壁があり開口が壁の面まで内側に寄る構成では、長い2本の上り口側の端が壁の面で切れる', () => {
  const lower = lowerWithPartition();
  const upper = upperWithVoid([[0, 0, 2000, 3000]]);
  const find = (t, v) => upper.centerLines.find(c => c.centerLineType === t && c.value === v);
  const h3000 = find(CenterLineType.HORIZONTAL, 3000);
  upper.addWall(h3000, -72.5, false, find(CenterLineType.VERTICAL, 0), 0, find(CenterLineType.VERTICAL, 2000), 0,
    { isRoomWall: true, wallFinish: 12.5, backingDepth: 120, backingOffset: 0 });
  const e = buildFor(upper, lower).upperEntries[0];
  const longs = e.partitionOutline.filter(s => s.x1 === s.x2 && Math.abs(s.y2 - s.y1) > 1000);
  assert.equal(longs.length, 2);
  for (const s of longs) {
    const yMax = Math.max(s.y1, s.y2);
    assert.ok(Math.abs(yMax - (3000 - 72.5)) < 1e-6, `壁の面（CL−(60+12.5)）で切れる: ${yMax}`);
  }
});

