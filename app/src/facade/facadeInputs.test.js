// facade/facadeInputs.js の単体テスト（最小の graph。壁は finishGuideGeometry.test.js と同じく本番の generateExteriorWalls で作る）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { FacadeSkipReason, FacadeDirection } from '../core/constants.js';
import { generateExteriorWalls } from '../finish/wallGeneration.js';
import { STORY_HEIGHT_FALLBACK_MM } from '../floorHeights.js';
import { buildFacadeInputs } from './facadeInputs.js';
import { buildFacadeModel } from './facadeFigure.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const TOP_STORY_MM = 2900;
const GL_BELOW = 450;

// Plane(id, elevation, name, startFloor, stories, isAlternative, referenceId, altIndex, isRoofPlane, roofForPlaneId,
//       planCutHeightMm, ceilingCutHeightMm, topStoryHeightMm)
function plane(id, elevation, startFloor, { isAlternative = false, stories = 1 } = {}) {
  return new Plane(id, elevation, `${startFloor}階`, startFloor, stories, isAlternative, null, 0, false, null,
    undefined, undefined, TOP_STORY_MM);
}

// 矩形1室（x0..x1 × y0..y1）＋外壁（DEFAULT_WALL_BASE=90・仕上げ12.5 → 外面は通り芯から 57.5 外）。
function rectGraph(p, x0v, y0v, x1v, y1v, { walls = true } = {}) {
  const graph = new PlanGraph(p);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL,   x0v, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL,   x1v, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, ARCH);
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  if (walls) generateExteriorWalls(graph);
  return { graph, ids: { x0: x0.id, x1: x1.id, y0: y0.id, y1: y1.id } };
}

const project = planes => ({ glBelow1FlMm: GL_BELOW, planes });

test('平屋矩形: zLo＝GL・zHi＝軒桁上端、外壁4本（外面・外向き・軸CL）', () => {
  const p1 = plane('p1', 0, 1);
  const { graph, ids } = rectGraph(p1, 0, 0, 4000, 3000);
  const inputs = buildFacadeInputs([{ plane: p1, graph }], project([p1]));
  assert.equal(inputs.glZMm, -GL_BELOW);
  assert.deepEqual(inputs.skipped, []);
  assert.equal(inputs.floors.length, 1);
  const f = inputs.floors[0];
  assert.equal(f.planeId, 'p1');
  assert.equal(f.zLoMm, -GL_BELOW);
  assert.equal(f.zHiMm, TOP_STORY_MM);
  const byAxis = Object.fromEntries(f.segments.map(s => [s.axisCLId, s]));
  assert.equal(byAxis[ids.x0].outwardSign, -1);
  assert.equal(byAxis[ids.x1].outwardSign, 1);
  assert.equal(byAxis[ids.y0].outwardSign, -1);
  assert.equal(byAxis[ids.y1].outwardSign, 1);
  assert.equal(byAxis[ids.x1].value, 4057.5, '外壁の外面');
  assert.deepEqual([byAxis[ids.x1].lo, byAxis[ids.x1].hi], [-57.5, 3057.5], '角は隣の外面にそろう（lo<hi）');
  assert.ok(f.segments.every(s => s.loopType === 'outer'));
});

test('graph → 図: 平屋矩形の南立面は 幅＝外面の寸法（4000+2×57.5）・高さ＝GL〜軒桁上端', () => {
  const p1 = plane('p1', 0, 1);
  const { graph } = rectGraph(p1, 0, 0, 4000, 3000);
  const model = buildFacadeModel(buildFacadeInputs([{ plane: p1, graph }], project([p1])));
  const south = model.find(f => f.direction === FacadeDirection.SOUTH);
  assert.equal(south.widthMm, 4115);
  assert.equal(south.heightMm, TOP_STORY_MM + GL_BELOW);
  const east = model.find(f => f.direction === FacadeDirection.EAST);
  assert.equal(east.widthMm, 3115);
});

test('2階建て: 1階の zHi＝2FL、2階の zLo＝2FL・zHi＝軒桁上端', () => {
  const p1 = plane('p1', 0, 1), p2 = plane('p2', 3000, 2);
  const g1 = rectGraph(p1, 0, 0, 4000, 3000).graph, g2 = rectGraph(p2, 0, 0, 4000, 3000).graph;
  const inputs = buildFacadeInputs([{ plane: p1, graph: g1 }, { plane: p2, graph: g2 }], project([p1, p2]));
  assert.deepEqual(inputs.floors.map(f => [f.planeId, f.zLoMm, f.zHiMm]),
    [['p1', -GL_BELOW, 3000], ['p2', 3000, 3000 + TOP_STORY_MM]]);
});

test('【失敗系】部屋の無い階・graph の無い階は飛ばして skipped に載る（例外なし）。上の階の zHi は飛ばした階の FL のまま', () => {
  const p1 = plane('p1', 0, 1), p2 = plane('p2', 3000, 2), p3 = plane('p3', 6000, 3);
  const g1 = rectGraph(p1, 0, 0, 4000, 3000).graph;
  const g2 = new PlanGraph(p2); // 部屋なし
  const inputs = buildFacadeInputs(
    [{ plane: p1, graph: g1 }, { plane: p2, graph: g2 }, { plane: p3, graph: null }], project([p1, p2, p3]));
  assert.deepEqual(inputs.floors.map(f => [f.planeId, f.zHiMm]), [['p1', 3000]]);
  assert.deepEqual(inputs.skipped, [
    { planeId: 'p2', reason: FacadeSkipReason.NO_EXTERIOR_WALL },
    { planeId: 'p3', reason: FacadeSkipReason.NO_GRAPH },
  ]);
});

test('【失敗系】外壁の取得で例外が出る階は skipped（reason=error・message）に載せて飛ばし、他の階は返す', () => {
  const p1 = plane('p1', 0, 1), p2 = plane('p2', 3000, 2);
  const g1 = rectGraph(p1, 0, 0, 4000, 3000).graph;
  const broken = { plane: p2 }; // rooms・walls を持たない壊れた graph
  const inputs = buildFacadeInputs([{ plane: p1, graph: g1 }, { plane: p2, graph: broken }], project([p1, p2]));
  assert.deepEqual(inputs.floors.map(f => f.planeId), ['p1']);
  assert.equal(inputs.skipped.length, 1);
  assert.equal(inputs.skipped[0].planeId, 'p2');
  assert.equal(inputs.skipped[0].reason, FacadeSkipReason.ERROR);
  assert.equal(typeof inputs.skipped[0].message, 'string');
});

test('【失敗系】地階・検討案は対象外（地階を除いた最下の地上階の zLo が GL）', () => {
  const b1 = plane('b1', -3000, -1), p1 = plane('p1', 0, 1), alt = plane('alt', 0, 1, { isAlternative: true });
  const gb = rectGraph(b1, 0, 0, 4000, 3000).graph, g1 = rectGraph(p1, 0, 0, 4000, 3000).graph;
  const ga = rectGraph(alt, 0, 0, 9000, 9000).graph;
  const inputs = buildFacadeInputs(
    [{ plane: b1, graph: gb }, { plane: p1, graph: g1 }, { plane: alt, graph: ga }], project([b1, p1]));
  assert.deepEqual(inputs.floors.map(f => [f.planeId, f.zLoMm]), [['p1', -GL_BELOW]]);
  assert.deepEqual(inputs.skipped, []);
});

test('【失敗系】階高が非有限なら STORY_HEIGHT_FALLBACK_MM で補う', () => {
  const p1 = plane('p1', 0, 1, { stories: NaN }); // 軒桁上端＝elevation＋階高×stories が NaN
  const { graph } = rectGraph(p1, 0, 0, 4000, 3000);
  const inputs = buildFacadeInputs([{ plane: p1, graph }], project([p1]));
  assert.equal(inputs.floors[0].zHiMm, -GL_BELOW + STORY_HEIGHT_FALLBACK_MM);
});

test('【失敗系】GL が 2FL より上なら 1階は skipped（reason=belowGl・上端を補わない）・2階だけ描く（z は重ならない）', () => {
  const p1 = plane('p1', 0, 1), p2 = plane('p2', 3000, 2);
  const g1 = rectGraph(p1, 0, 0, 4000, 3000).graph, g2 = rectGraph(p2, 0, 0, 4000, 3000).graph;
  const glAbove = { glBelow1FlMm: -3500, planes: [p1, p2] }; // GL＝1FL+3500（2FL=3000 より上）
  const inputs = buildFacadeInputs([{ plane: p1, graph: g1 }, { plane: p2, graph: g2 }], glAbove);
  assert.equal(inputs.glZMm, 3500);
  assert.deepEqual(inputs.skipped, [{ planeId: 'p1', reason: FacadeSkipReason.BELOW_GL }]);
  assert.deepEqual(inputs.floors.map(f => [f.planeId, f.zLoMm, f.zHiMm]), [['p2', 3000, 3000 + TOP_STORY_MM]]);
  const south = buildFacadeModel(inputs).find(f => f.direction === FacadeDirection.SOUTH);
  assert.equal(south.heightMm, 3000 + TOP_STORY_MM - 3500, '高さは GL〜軒桁上端（2階の GL より下は切る）');
});

test('【失敗系】floors・project が無くても例外にならない', () => {
  assert.deepEqual(buildFacadeInputs(undefined, undefined), { glZMm: 0, floors: [], skipped: [] });
  assert.deepEqual(buildFacadeModel(buildFacadeInputs([], null)), []);
});
