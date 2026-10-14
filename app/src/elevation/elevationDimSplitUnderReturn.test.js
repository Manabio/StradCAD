// 復路下の壁が隣の部屋の面の寸法を割る（moku4-3 1階 便所・2階 廊下の 1820→910+910）のは、新しい壁だけの扱いではなく
// 既存の規約——perpendicularWallsOnFace(face, graph, 'far')（S2。向こう側の壁は isRoomWall でも分割点に拾う。ユーザー実機指摘 2026-08「22」）
// が決めている。同じ位置の普通の内壁でも同じ分割点になることを固定する。
// フィクスチャ: 階段 EQUAL_UP（復路下の壁は y=1000 上の x1000〜2000）の東隣の部屋の面＝軸 x=2000・inward=+1（東向き）の縦の面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType } from '@core';
import { collectRow1SplitPoints } from './elevationDimSplit.js';
import { generateStairUnderReturnWalls } from '../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

function makeGraph() {
  const graph = new PlanGraph(new Plane('p1', 0, 'p1', 0, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const mk = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 1000, 2000].map(v => mk(CenterLineType.VERTICAL, v));
  const ys = [0, 1000, 4000].map(v => mk(CenterLineType.HORIZONTAL, v));
  const V = v => xs.find(c => c.value === v), H = v => ys.find(c => c.value === v);
  const cells = new Set(EQUAL_UP.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const room = graph.addRoom(new Set(cells), '階段');
  graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up' });
  return { graph, V, H };
}
const faceAt = (graph, V) => ({
  axisCL: V(2000), faceValue: 2057.5, inward: 1, isVertical: true, lo: 0, hi: 4000, originWorld: 0, dirSign: 1,
});
const splits = (graph, V) => collectRow1SplitPoints(faceAt(graph, V), graph, { boundary: { lo: 0, hi: 4000 }, floorSegments: null, spans: null, gridXs: [] });

test('向こう側から面の軸 x=2000 に届く壁は、復路下の壁でも普通の内壁（同じ位置・同じ形）でも同じ分割点 y=1000 を作る', () => {
  const under = makeGraph();
  assert.equal(generateStairUnderReturnWalls(under.graph, { structure: TRADITIONAL_WOOD_STRUCTURE }).length, 2);
  const ordinary = makeGraph();
  const own = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  ordinary.graph.addWall(ordinary.H(1000), 57.5, false, ordinary.V(1000), -57.5, ordinary.V(2000), 0, own);
  ordinary.graph.addWall(ordinary.H(1000), -57.5, false, ordinary.V(1000), -57.5, ordinary.V(2000), 0, { ...own, backingDepth: 0, finishSide: -1 });
  assert.deepEqual(splits(under.graph, under.V), [1000]);
  assert.deepEqual(splits(ordinary.graph, ordinary.V), [1000]);
});

test('【対照】向こう側に壁が無ければ分割点は無い', () => {
  const none = makeGraph();
  assert.deepEqual(splits(none.graph, none.V), []);
});
