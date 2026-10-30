// 最上階の屋根（主屋根・屋根区画）の平面用 region（roofFramingRegions.js topRoofPlanRegions）のテスト。天伏の見上げの軒裏用。
//   leanToPlanRegions の主屋根版: 構造ゲートなし（非木造は陸屋根→外形線だけ）。区画どうし・区画と主屋根の接する辺は軒の出 0。
//   最上階（とその検討案）でない・project/graph が無いときは []。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoofShape, RoofSpec, RoofZone,
} from '@core';
import { topRoofPlanRegions, topRoofFramingRegions } from './roofFramingRegions.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { buildRoofLayout } from '../finish/roofTestFixtures.js';
import { footprintCellKeys } from './wallGate.js';
import { cellBoundsList } from '../finish/gridCells.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const EAVE = 455; // 既定の出幅（軒・けらばとも）

/** 最上階（project.planes の末尾）が graph の plane になる project。 */
function projectWith(graph, structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = structure;
  project.planeMap.set(graph.plane.id, graph.plane);
  return project;
}

function topGrid(xs, ys, cells) {
  const graph = new PlanGraph(new Plane('top', 0, '3階', 3, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '居間');
  return { graph, cell };
}

const zoneOf = (id, cells, shape = null) => {
  const spec = new RoofSpec();
  if (shape) spec.setField('shape', shape);
  return new RoofZone({ id, cells, spec });
};
const setZones = (graph, ...zones) => graph.setRoofZones(Object.freeze(zones));
const overhangsAt = (region, isVertical, coord, outward) => region.edges
  .filter(e => e.isVertical === isVertical && e.coord === coord && e.outward === outward).map(e => e.overhangMm);

test('【軒裏】在来木造・矩形・区画なし: key main の1件。伏図の region に exposedPaths・slope・soffitOrientation・zeroZones・planDrains を足した形', () => {
  const { graph } = topGrid([0, 9000], [0, 6000], [[0, 0]]);
  const project = projectWith(graph);
  const regions = topRoofPlanRegions(graph, project);
  assert.equal(regions.length, 1);
  const [r] = regions;
  const [framing] = topRoofFramingRegions(graph, project);
  assert.equal(r.key, 'main');
  assert.equal(r.shape, RoofShape.GABLE);
  assert.equal(r.outlineOnly, undefined, '伏図と同じ region（外形線だけではない）');
  assert.deepEqual(r.edges, framing.edges);
  assert.deepEqual(r.outline, framing.outline);
  assert.equal(r.soffitOrientation, 'sloped');
  assert.equal(r.slope, graph.mainRoofSpec.slope);
  assert.deepEqual(r.zeroZones, []);
  assert.equal(r.planDrains.length, 2, '切妻の水下は棟木と平行な2辺');
  assert.ok(r.exposedPaths.length > 0 && r.exposedPaths.every(p => Array.isArray(p.points)));
  assert.deepEqual(overhangsAt(r, false, 0, -1), [EAVE]);
});

test('【軒裏】2区画: 区画ごと（並び順）。接する辺は両側とも軒の出 0（zeroZones にも入る）・外側は出幅のまま', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(graph, zoneOf('zA', [cell(0, 0)]), zoneOf('zB', [cell(1, 0)]));
  const regions = topRoofPlanRegions(graph, projectWith(graph));
  assert.deepEqual(regions.map(r => r.key), ['zone:zA', 'zone:zB']);
  const [a, b] = regions;
  assert.deepEqual(overhangsAt(a, true, 5000, 1), [0]);
  assert.deepEqual(overhangsAt(b, true, 5000, -1), [0]);
  assert.deepEqual(overhangsAt(a, true, 0, -1), [EAVE]);
  assert.ok(a.zeroZones.length > 0 && b.zeroZones.length > 0, '接する区間が zeroZones');
});

test('【軒裏】L字の右腕だけを区画にすると、区画＋残りの主屋根（zone → main の順）', () => {
  const { graph } = buildRoofLayout('notch', 'none');
  const arm = [...footprintCellKeys(graph)].find(k => cellBoundsList([k], graph)[0].x1 === 2000);
  setZones(graph, zoneOf('arm', [arm]));
  const regions = topRoofPlanRegions(graph, projectWith(graph));
  assert.deepEqual(regions.map(r => r.key), ['zone:arm', 'main']);
});

test('【軒裏・失敗系】S造（既定＝陸屋根）は軒を持たない＝出幅 0 とみなし region を出さない（ユーザー裁定 2026-10-30）。形状を明示（切妻）すれば非木造でも出る', () => {
  const { graph } = topGrid([0, 9000], [0, 6000], [[0, 0]]);
  const project = projectWith(graph, 'S造');
  assert.deepEqual(topRoofFramingRegions(graph, project), [], '前提: 伏図の region は無い');
  assert.deepEqual(topRoofPlanRegions(graph, project), [], '陸屋根の主屋根は軒裏を描かない');
  graph.mainRoofSpec.setField('shape', RoofShape.GABLE);
  const regions = topRoofPlanRegions(graph, project);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].shape, RoofShape.GABLE);
  assert.ok(regions[0].edges.some(e => e.overhangMm === EAVE));
});

test('【軒裏・失敗系】在来木造でも spec が陸屋根（FLAT）の区画は region なし。その区画に接する主屋根の辺は軒の出 0 のまま（区画は独立した屋根）', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(graph, zoneOf('zA', [cell(0, 0)], RoofShape.FLAT));
  const regions = topRoofPlanRegions(graph, projectWith(graph));
  assert.deepEqual(regions.map(r => r.key), ['main'], '陸屋根の区画は出ない');
  const rest = regions[0];
  assert.notEqual(rest.outlineOnly, true, '残りの主屋根は伏図と同じ region');
  assert.deepEqual(overhangsAt(rest, true, 5000, -1), [0], '陸屋根の区画に接する辺は軒の出 0');
  assert.deepEqual(overhangsAt(rest, true, 10000, 1), [EAVE]);
});

test('【軒裏・失敗系】最上階でない階・project なし・graph なしは []', () => {
  const { graph } = topGrid([0, 9000], [0, 6000], [[0, 0]]);
  const project = projectWith(graph);
  project.planeMap.set('up', new Plane('up', 3000, '4階', 4, 1)); // 上に階がある＝graph は最上階でない
  assert.deepEqual(topRoofPlanRegions(graph, project), []);
  assert.deepEqual(topRoofPlanRegions(graph, null), []);
  assert.deepEqual(topRoofPlanRegions(null, project), []);
  const roofPlane = new Plane('roof', 0, '小屋', 3, 1, false, null, 0, true, 'top');
  const roofGraph = new PlanGraph(roofPlane);
  assert.deepEqual(topRoofPlanRegions(roofGraph, project), [], '屋根専用平面');
});

test('【軒裏・失敗系】実効セルが0の区画は飛ばす（残りの主屋根は建物全体）', () => {
  const { graph } = topGrid([0, 9000], [0, 6000], [[0, 0]]);
  setZones(graph, zoneOf('ghost', ['no:such:cell:key']));
  const regions = topRoofPlanRegions(graph, projectWith(graph));
  assert.deepEqual(regions.map(r => r.key), ['main']);
});

test('【軒裏・失敗系】屋内の部屋が無い階（建物範囲が空）は []', () => {
  const graph = new PlanGraph(new Plane('top', 0, '3階', 3, 1));
  assert.deepEqual(topRoofPlanRegions(graph, projectWith(graph)), []);
});
