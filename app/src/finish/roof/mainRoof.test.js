// 主屋根（最上階の外部タブ先頭の固定の群）の導出・独立性のテスト。ステップ B3。
//   - 形状の既定は主構造のルール（rulesFor(...).mainRoofDefaultShape）経由。構造種別の直接比較はしない。
//   - 主屋根は壁・境界・建物範囲・壁の鮮度キーに一切影響しない（値の保持と外部タブの表示だけ）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoofSpec, RoofShape, ROOF_SPEC_KEYS,
} from '@core';
import { rulesFor, UNSPECIFIED_STRUCTURE, TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { footprintCellKeys } from '../../structural/wallGate.js';
import { resolveRoofShape } from './roofDefaults.js';
import { mainRoofBounds, resolveMainRoofShape } from './mainRoof.js';
import { wallFreshnessKey } from '../wallFreshnessKey.js';
import { generateExteriorWalls, generateRoomWallsFromOutline, computeExteriorWallSegments } from '../wallGeneration.js';
import { computeNamedBoundaryEdges } from '../edgeClassify.js';
import { buildRoofLayout, NON_DEFAULT_ROOF_SPEC } from '../roofTestFixtures.js';

const rect = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const ARCH = { labeled: false, discipline: Discipline.ARCH };

/** 屋内の1部屋（幅 w × 奥行 h）だけの階。 */
function singleRoomGraph(w, h) {
  const graph = new PlanGraph(new Plane('p1', 0, '3階', 3, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH, 'x0');
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, w, ARCH, 'x1');
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH, 'y0');
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, h, ARCH, 'y1');
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '居間');
  return graph;
}

// ---- resolveRoofShape × 主構造（rulesFor 経由） ----

const BIG = [rect(0, 0, 9000, 9000)];   // 短手 9000（切妻になる範囲）
const SMALL = [rect(0, 0, 9000, 3640)]; // 短手 3640（片流れになる範囲）

test('【B3】resolveRoofShape: 非木造（RC造ラーメン・壁式・S造・SRC造）の主屋根は範囲に関係なく陸屋根', () => {
  for (const key of ['RC造(ラーメン)', 'RC造(壁式)', 'S造', 'SRC造']) {
    const rules = rulesFor(key);
    assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: BIG, rules }), RoofShape.FLAT, key);
    assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: SMALL, rules }), RoofShape.FLAT, key);
  }
});

test('【B3】resolveRoofShape: 木造（在来・2×4）・主構造未定・未知の主構造は短手の規則（3640以下=片流れ・超=切妻）', () => {
  for (const key of [TRADITIONAL_WOOD_STRUCTURE, '木造（2"×4"）', UNSPECIFIED_STRUCTURE, 'no-such-structure', undefined]) {
    const rules = rulesFor(key);
    assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: SMALL, rules }), RoofShape.MONO, String(key));
    assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: BIG, rules }), RoofShape.GABLE, String(key));
  }
});

test('【B3】resolveRoofShape: 明示された形状は主構造に依らずそのまま', () => {
  for (const key of ['RC造(ラーメン)', 'S造', TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE]) {
    for (const shape of Object.values(RoofShape)) {
      assert.equal(resolveRoofShape(new RoofSpec({ shape }), { boundsList: BIG, rules: rulesFor(key) }), shape, `${key}/${shape}`);
    }
  }
});

// ---- resolveMainRoofShape（最上階の graph・project から導く） ----

test('【B3】resolveMainRoofShape: 最上階の建物範囲の短手と実効主構造から導く（S造=陸屋根／在来木造=短手）', () => {
  const project = new Project('p', 'test');
  const small = singleRoomGraph(9000, 3000); // 短手 3000
  const big = singleRoomGraph(9000, 6000);   // 短手 6000
  project.structuralInfo.mainStructure = 'S造';
  assert.equal(resolveMainRoofShape(small, project), RoofShape.FLAT);
  assert.equal(resolveMainRoofShape(big, project), RoofShape.FLAT);
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  assert.equal(resolveMainRoofShape(small, project), RoofShape.MONO);
  assert.equal(resolveMainRoofShape(big, project), RoofShape.GABLE);
  project.structuralInfo.mainStructure = UNSPECIFIED_STRUCTURE;
  assert.equal(resolveMainRoofShape(small, project), RoofShape.MONO, '主構造が未定のときは木造と同じ短手の規則');
  assert.equal(resolveMainRoofShape(big, project), RoofShape.GABLE);
});

test('【B3】resolveMainRoofShape: 階ごとの主構造の上書き（structureOverride）が建物全体値より優先される', () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const g = singleRoomGraph(9000, 6000);
  assert.equal(resolveMainRoofShape(g, project), RoofShape.GABLE);
  g.setStructureOverride('RC造(ラーメン)');
  assert.equal(resolveMainRoofShape(g, project), RoofShape.FLAT);
});

test('【B3】resolveMainRoofShape: 明示値（ユーザーが選んだ形状）は主構造・範囲に依らずそのまま', () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = 'S造';
  const g = singleRoomGraph(9000, 6000);
  g.mainRoofSpec.setField('shape', RoofShape.HIP);
  assert.equal(resolveMainRoofShape(g, project), RoofShape.HIP);
});

test('【B3・失敗系】resolveMainRoofShape: 部屋が無い階（建物範囲が空）・project が無い（主構造が引けない）でも例外にならず短手0＝片流れ', () => {
  const g = new PlanGraph(new Plane('p1', 0, '3階', 3, 1));
  assert.equal(mainRoofBounds(g).length, 0);
  assert.equal(resolveMainRoofShape(g, null), RoofShape.MONO);
  assert.equal(resolveMainRoofShape(g), RoofShape.MONO);
});

test('【B3】mainRoofBounds: 建物範囲（footprintCellKeys）のセル矩形。屋根セルのある階では屋根セルを含まない', () => {
  const { graph } = buildRoofLayout('band', 'roof');
  const bounds = mainRoofBounds(graph);
  assert.equal(bounds.length, footprintCellKeys(graph).size);
  assert.equal(Math.max(...bounds.map(b => b.x2)), 4000, '屋根セル（x:4000..8000）は建物範囲に入らない');
});

// ---- 主屋根は壁・境界・建物範囲・鮮度キーに影響しない ----

function fingerprint(graph, project) {
  const wallKey = w => JSON.stringify([w.isVertical, w.axisCL.value, w.coord1, w.coord2, w.axisOffset]);
  const walls = [
    ...generateExteriorWalls(graph, {}),
    ...graph.rooms.flatMap(r => generateRoomWallsFromOutline(graph, r, {})),
  ].map(wallKey).sort();
  const segs = computeExteriorWallSegments(graph).map(s => JSON.stringify([s.isVertical, s.value, s.start, s.end, s.loopType])).sort();
  return {
    key: wallFreshnessKey(graph, project),
    footprint: [...footprintCellKeys(graph)].sort().join(','),
    walls: walls.join('|'),
    segs: segs.join('|'),
    boundary: [...computeNamedBoundaryEdges(graph)].sort().join('|'),
  };
}

test('【B3】主屋根の全9項目を既定以外にしても、壁の鮮度キー・建物範囲・外壁セグメント・生成壁・境界は変わらない', () => {
  for (const shape of ['band', 'notch']) {
    for (const mode of ['roof', 'none']) {
      const { graph } = buildRoofLayout(shape, mode);
      const project = new Project('p', 'test');
      const before = fingerprint(graph, project);
      assert.ok(before.walls.length > 0 && before.footprint.length > 0, '前提: 壁・建物範囲がある');
      graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
      assert.equal(ROOF_SPEC_KEYS.filter(k => graph.mainRoofSpec[k] !== new RoofSpec()[k]).length, 9, '前提: 全項目が既定以外');
      assert.deepEqual(fingerprint(graph, project), before, `${shape}/${mode}`);
    }
  }
});
