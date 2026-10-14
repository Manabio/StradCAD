// 復路下の壁の天端（sectionProbe.js addUnderReturnTops）。壁は復路レーンの裏面（ceiling/stairSoffit.js stairSoffitSolids）で止まり、
// その上へ立ち上がらない。フィクスチャは sectionWallTop.test.js の EQUAL_UP（往路 x0〜1000・復路 x1000〜2000・踊り場 y0〜1000、
// 前縁 y=1000。復路下の壁は y=1000 上の x1000〜2000）。復路の縦の切断線 x=1500 が壁（y=1000）を横切る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { makeProbeContext } from './sectionProbe.js';
import { probeColumnHits } from './sectionHits.js';
import { generateStairUnderReturnWalls } from '../../finish/stair/stairPartitionWalls.js';
import { stairSoffitSolids } from '../../ceiling/stairSoffit.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const FH = 2400;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

function makeFloor(id, elevation, { stairRects = null, stairProps = {} } = {}) {
  const graph = new PlanGraph(new Plane(id, elevation * 1000, id, elevation, 1));
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  for (const x of [0, 1000, 2000]) V(x);
  for (const y of [0, 1000, 4000]) H(y);
  let stair = null, walls = [];
  if (stairRects) {
    const cells = new Set(stairRects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
    const room = graph.addRoom(new Set(cells), '階段');
    stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
    walls = generateStairUnderReturnWalls(graph, { structure: WOOD });
  }
  return { graph, stair, walls };
}

// 復路の縦の切断線 x=1500（run は y）で、壁（y=1000 上）に当たる cut の z1
const cutZ1s = (layers, walls, worldMid = 1000) => {
  const cut = {
    seqNo: '0',
    line: { isVertical: true, axisValue: 1500, lo: 0, hi: 4000, buttToleranceMm: 0 },
    viewSign: 1, dirSign: 1, layers,
    zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
    ceilProfile: [{ x0: 0, x1: 4000, ceilZ: 2400 }],
  };
  const { hits } = probeColumnHits(cut, worldMid, makeProbeContext(layers));
  return hits.filter(h => h.kind === 'cut' && walls.includes(h.wall)).map(h => h.z1).sort((a, b) => a - b);
};
const twoFloors = (opts) => {
  const f1 = makeFloor('p1', 0, opts);
  const f2 = makeFloor('p2', 1);
  return { f1, layers: [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }] };
};
// 期待値: 階段の裏面の式（stairSoffitSolids）を、区間の中央 x=1500・壁の厚み方向（y=1000±57.5）で評価した最小値
const soffitAt = (f1, ys = [942.5, 1000, 1057.5]) => {
  const riser = f1.stair.riser ?? FH / f1.stair.totalSteps;
  const s = stairSoffitSolids({ stair: f1.stair, graph: f1.graph, riser, floorZMm: 0 })[0];
  return Math.min(...ys.map(y => (s.zAt ? s.zAt(1500, y) : s.zLo)));
};

test('復路下の壁は復路の裏面の高さで止まる（オーナー壁・薄壁とも）。天井 2400 までは立ち上がらない', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  assert.equal(f1.walls.length, 2);
  const expected = soffitAt(f1);
  assert.ok(expected > 0 && expected < FH - 1, `前提: 裏面は天井より低い（${expected}）`);
  // オーナー壁は y 955〜1057.5・薄壁は 942.5〜955 の列で当たる
  [[f1.walls[0], 1000], [f1.walls[1], 948]].forEach(([w, y]) => {
    const z = cutZ1s(layers, [w], y)[0];
    assert.ok(Math.abs(z - expected) < 1e-6, `z1=${z} ≒ ${expected}`);
  });
});

test('【失敗系】直上の層が無い（階高が決まらず蹴上が求まらない）→ フルハイト', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }];
  assert.deepEqual(cutZ1s(layers, f1.walls), [2400], '前提: 壁には当たっていて、天井まで立つ');
});

test('【失敗系】鉄骨の階段 → 裏面が求まらずフルハイト', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  f1.stair.structure = StructuralMaterialType.STEEL;
  assert.deepEqual(cutZ1s(layers, f1.walls), [2400]);
});

test('【失敗系】sections が不正な階段 → 例外を投げずフルハイト', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  f1.stair.sections = [6, 1];
  assert.deepEqual(cutZ1s(layers, f1.walls), [2400]);
});

test('天端は壁の厚みの最も低い点（回転部側の面）で評価する。軸だけで評価した値より高くはならない', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP, stairProps: { type: StairType.WINDING, sections: [6, 3, 6] } });
  const top = soffitAt(f1);
  const axisOnly = soffitAt(f1, [1000]);
  assert.ok(top <= axisOnly + 1e-9, `${top} <= ${axisOnly}`);
  assert.ok(top < axisOnly - 1, `回り階段では厚みの両面で裏面の高さが違う（${top} < ${axisOnly}）`);
  assert.ok(Math.abs(cutZ1s(layers, [f1.walls[0]], 1000)[0] - top) < 1e-6);
});
