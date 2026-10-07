// レーンあき（LANE_GAP）の閉じ辺＝内側ささらが取りつく踊り場線の生成テスト。
// buildStairGeometry はスカラ属性しか参照しない（graph 未指定）ので素のオブジェクトで足りる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StairType, StructuralMaterialType, Plane, PlanGraph, CenterLineType, Discipline, RoomKind } from '@core';
import { buildStairGeometry, laneGapMmFor, LANE_GAP } from './stairGeometry.js';
import { PARTITION_THICKNESS_MM } from './stairPartition.js';

const BOUNDS = { x1: 0, y1: 0, x2: 2000, y2: 4000 };
const stairOf = (type) => ({
  type, upDirection: 'up', flip: false, tread: 250, totalSteps: 14,
  sections: type === StairType.WINDING ? [7, 3, 4] : [7, 1, 6],
});
const build = (type, laneGapMm) => buildStairGeometry(stairOf(type), BOUNDS, {
  view: 'upper', detail: false, riser: null, spans: null, laneGap: laneGapMm > 0,
});
const len = (s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

// 2026-10-08 裁定: 100mm のあきは鉄骨。木造は隔て壁が立つときだけ隔て壁厚（115）、立たなければ 0。
const WOOD_TRAD = '木造（在来）';
const mk = (structure, type = StairType.SWITCHBACK, buildingStructure = WOOD_TRAD) => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const [v0, v1, v2, h0, h1, h2] = [V(0), V(1000), V(2000), H(0), H(1000), H(4000)];
  const cells = new Set([`${v0.id}:${h0.id}:${v2.id}:${h1.id}`, `${v0.id}:${h1.id}:${v1.id}:${h2.id}`, `${v1.id}:${h1.id}:${v2.id}:${h2.id}`]);
  const stair = graph.addStair({ type, cells, sections: [6, 1, 6], flip: false, upDirection: 'up' });
  stair.structure = structure; // addStair の既定（WOOD）を避け、undefined/null も直接入れる
  graph.setStructureOverride(buildingStructure);
  return { graph, stair };
};
const exterior = ({ graph, stair }) => {
  const room = graph.addRoom(new Set(stair.cells), '階段');
  room.kind = RoomKind.EXTERIOR;
  stair.roomId = room.id;
};
const gapOf = ({ graph, stair }) => laneGapMmFor(stair, graph);

test('laneGapMmFor: 在来の屋内 SWITCHBACK の木造=隔て壁厚115', () => {
  assert.equal(PARTITION_THICKNESS_MM, 115);
  assert.equal(gapOf(mk(StructuralMaterialType.WOOD)), 115);
});
test('laneGapMmFor: 木造でも屋外・回り階段・2×4・S造の建物は隔て壁が立たないので0', () => {
  const ext = mk(StructuralMaterialType.WOOD); exterior(ext);
  assert.equal(gapOf(ext), 0, '屋外');
  assert.equal(gapOf(mk(StructuralMaterialType.WOOD, StairType.WINDING)), 0, '回り階段');
  assert.equal(gapOf(mk(StructuralMaterialType.WOOD, StairType.SWITCHBACK, '木造（2"×4"）')), 0, '2×4');
  assert.equal(gapOf(mk(StructuralMaterialType.WOOD, StairType.SWITCHBACK, 'S造')), 0, 'S造の建物');
});
test('laneGapMmFor: 鉄骨=100（建物の構造に依らない）・structure 未設定=100・簡略=0', () => {
  assert.equal(gapOf(mk(StructuralMaterialType.STEEL)), LANE_GAP);
  assert.equal(gapOf(mk(StructuralMaterialType.STEEL, StairType.SWITCHBACK, 'S造')), LANE_GAP);
  assert.equal(gapOf(mk(null)), LANE_GAP);
  assert.equal(gapOf(mk(undefined)), LANE_GAP);
  assert.equal(laneGapMmFor({ structure: StructuralMaterialType.STEEL }, null), LANE_GAP, 'graph なしでも鉄骨は100');
  for (const st of [StructuralMaterialType.WOOD, StructuralMaterialType.STEEL]) {
    const m = mk(st);
    assert.equal(laneGapMmFor(m.stair, m.graph, { simplified: true }), 0);
  }
});

const mid = 1000;
const bounds = { x1: 0, y1: 0, x2: 2000, y2: 4000 };
const geomOf = (m, laneGap) => buildStairGeometry(m.stair, bounds, { view: 'upper', detail: false, riser: null, spans: null, laneGap, graph: m.graph });

test('SWITCHBACK 在来の木造: 閉じ辺（heavy）が中央±57.5、踏面端もそこで止まる', () => {
  const g = geomOf(mk(StructuralMaterialType.WOOD), true);
  const heavy = g.treads.filter(s => s.heavy);
  assert.equal(heavy.length, 1);
  assert.ok(Math.abs(len(heavy[0]) - 115) < 1e-6, `幅=${len(heavy[0])}`);
  const xs = g.treads.flatMap(s => [s.x1, s.x2, s.y1, s.y2]);
  assert.ok(xs.some(v => Math.abs(Math.abs(v - mid) - 57.5) < 1e-6), '±57.5 に踏面端が無い');
  assert.ok(!xs.some(v => Math.abs(Math.abs(v - mid) - 50) < 1e-6), '±50 に踏面端が残っている');
});

test('SWITCHBACK 鉄骨: 従来どおり中央±50（不変）', () => {
  const heavy = geomOf(mk(StructuralMaterialType.STEEL), true).treads.filter(s => s.heavy);
  assert.ok(Math.abs(len(heavy[0]) - 100) < 1e-6);
});

test('SWITCHBACK 木造で隔て壁が立たない（2×4）: あき0・閉じ辺なし', () => {
  const m = mk(StructuralMaterialType.WOOD, StairType.SWITCHBACK, '木造（2"×4"）');
  assert.equal(geomOf(m, true).treads.filter(s => s.heavy).length, 0);
});

test('SWITCHBACK 木造でも簡略LOD（laneGap=false）ではあき0・閉じ辺なし', () => {
  assert.equal(geomOf(mk(StructuralMaterialType.WOOD), false).treads.filter(s => s.heavy).length, 0);
});

for (const type of [StairType.SWITCHBACK, StairType.WINDING]) {
  test(`${type}: あきがあるとき、閉じ辺が1本だけ heavy で幅＝LANE_GAP になる`, () => {
    const heavy = build(type, LANE_GAP).treads.filter(s => s.heavy);
    assert.equal(heavy.length, 1);
    assert.ok(Math.abs(len(heavy[0]) - LANE_GAP) < 1e-6, `幅=${len(heavy[0])}`);
  });

  test(`${type}: あき0（簡略LOD）では閉じ辺が生まれない`, () => {
    assert.equal(build(type, 0).treads.filter(s => s.heavy).length, 0);
  });

  test(`${type}: あき0のときの踏面線は、閉じ辺の分離前と同じ本数になる（退化区間を出さない）`, () => {
    const zero = build(type, 0).treads;
    assert.ok(zero.every(s => len(s) > 1e-6), '長さ0の踏面線が混ざっている');
  });
}
