// 屋根区画（PlanGraph.roofZones）ごとの小屋組の region（roofFramingRegions.js topRoofFramingRegions）のテスト。屋根区画 S4。
//   区画は独立した屋根: 区画ごとに region（key `zone:<id>`）＋区画以外の主屋根（key 'main'）。
//   区画どうし・区画と主屋根の接する辺は軒の出 0（谷・棟違いは作らない。ユーザー裁定 2026-10-30）。区画が無ければ従来と同じ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { autorun } from 'mobx';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoofShape, RoofSpec, RoofZone, StructuralMaterialType,
} from '@core';
import { topRoofFramingRegions, mainRoofFramingRegion, roofFramingRegionsForFigure } from './roofFramingRegions.js';
import { autoFillWoodRoofFraming } from './woodRoofFraming.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { ROOF_ZONE_REGION_KEY_PREFIX } from '../core/constants.js';
import { roofZoneHighSideView } from '../finish/roof/mainRoof.js';
import { buildRoofLayout } from '../finish/roofTestFixtures.js';
import { footprintCellKeys } from './wallGate.js';
import { cellBoundsList } from '../finish/gridCells.js';
import { graphComputed } from '../renderer/graphDerived.js';
import { stripCommentLines } from '../uiBusySourceScan.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const EAVE = 455; // 既定の出幅（軒・けらばとも）

function woodProject(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = structure;
  return project;
}

/** 格子 xs × ys の最上階。cells（[i, j] の配列）を1つの屋内の部屋にする。cell(i,j) はセルキー。 */
function topGrid(xs, ys, cells) {
  const graph = new PlanGraph(new Plane('top', 0, '3階', 3, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '居間');
  return { graph, cell };
}

const setZones = (graph, ...zones) => graph.setRoofZones(Object.freeze(zones));
const zoneOf = (id, cells, shape = null) => {
  const spec = new RoofSpec();
  if (shape) spec.setField('shape', shape);
  return new RoofZone({ id, cells, spec });
};
/** region の外形線の辺の部分のうち、向き・座標・外向きが一致するものの出幅の集合。 */
const overhangsAt = (region, isVertical, coord, outward) => region.edges
  .filter(e => e.isVertical === isVertical && e.coord === coord && e.outward === outward).map(e => e.overhangMm);

// ---- 区画なし: 従来と同じ ----

test('【S4】区画が無ければ topRoofFramingRegions は [mainRoofFramingRegion] と deepEqual（従来の region のリテラルにも一致）', () => {
  const { graph } = topGrid([0, 9000], [0, 6000], [[0, 0]]);
  const project = woodProject();
  const regions = topRoofFramingRegions(graph, project);
  assert.deepEqual(regions, [mainRoofFramingRegion(graph, project)]);
  assert.deepEqual(regions, [{
    key: 'main', rect: { x1: 0, y1: 0, x2: 9000, y2: 6000 }, shape: 'gable', ridgeIsVertical: false, highSide: null,
    edges: [
      { isVertical: false, coord: 0, lo: 0, hi: 9000, outward: -1, overhangMm: EAVE }, { isVertical: true, coord: 9000, lo: 0, hi: 6000, outward: 1, overhangMm: EAVE },
      { isVertical: false, coord: 6000, lo: 0, hi: 9000, outward: 1, overhangMm: EAVE }, { isVertical: true, coord: 0, lo: 0, hi: 6000, outward: -1, overhangMm: EAVE },
    ],
    outline: [{ points: [9455, -455, 9455, 6455, -455, 6455, -455, -455] }],
  }]);
});

test('【S4・L字・区画なし】矩形でない寄棟も従来どおり [key:main の rect:null region]', () => {
  const l = buildRoofLayout('notch', 'none').graph;
  const project = woodProject();
  const regions = topRoofFramingRegions(l, project);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].key, 'main');
  assert.equal(regions[0].rect, null);
  assert.deepEqual(regions, [mainRoofFramingRegion(l, project)]);
});

test('【重複整理 D1】mainRoofFramingRegion は topRoofFramingRegions の末尾（key main）と deepEqual（区画なし・区画あり・主屋根が残らないとき null ↔ 不在）', () => {
  const project = woodProject();
  const none = topGrid([0, 9000], [0, 6000], [[0, 0]]).graph;
  assert.deepEqual(mainRoofFramingRegion(none, project), topRoofFramingRegions(none, project).at(-1));
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(graph, zoneOf('zA', [cell(0, 0)]));
  const withZone = mainRoofFramingRegion(graph, project);
  assert.equal(withZone.key, 'main');
  assert.deepEqual(withZone, topRoofFramingRegions(graph, project).at(-1));
  setZones(graph, zoneOf('zA', [cell(0, 0)]), zoneOf('zB', [cell(1, 0)]));
  assert.equal(topRoofFramingRegions(graph, project).some(r => r.key === 'main'), false, '前提: 全部区画なら main の region は無い');
  assert.equal(mainRoofFramingRegion(graph, project), null);
});

// ---- 区画あり ----

test('【S4】矩形の建物を2区画に分けると、区画ごとの region（key zone:<id>・区画の並び順）だけ。接する辺は両側とも軒の出 0・外側の辺は spec の出幅のまま。主屋根の region は無い', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(graph, zoneOf('zA', [cell(0, 0)]), zoneOf('zB', [cell(1, 0)]));
  const project = woodProject();
  const regions = topRoofFramingRegions(graph, project);
  assert.deepEqual(regions.map(r => r.key), [`${ROOF_ZONE_REGION_KEY_PREFIX}zA`, `${ROOF_ZONE_REGION_KEY_PREFIX}zB`]);
  const [a, b] = regions;
  assert.deepEqual(a.rect, { x1: 0, y1: 0, x2: 5000, y2: 3000 });
  assert.deepEqual(b.rect, { x1: 5000, y1: 0, x2: 10000, y2: 3000 });
  for (const r of regions) {
    assert.equal(r.shape, RoofShape.MONO, '短手 3000 は片流れ（短手の規則）');
  }
  assert.equal(a.highSide, roofZoneHighSideView(graph, graph.roofZones[0], project).value, '高い側は区画の欄の値');
  assert.deepEqual(overhangsAt(a, true, 5000, 1), [0], 'A の右辺（B と接する）は 0');
  assert.deepEqual(overhangsAt(b, true, 5000, -1), [0], 'B の左辺（A と接する）は 0');
  assert.deepEqual(overhangsAt(a, true, 0, -1), [EAVE], 'A の外側（左辺）は出幅のまま');
  assert.deepEqual(overhangsAt(b, true, 10000, 1), [EAVE], 'B の外側（右辺）は出幅のまま');
  assert.deepEqual(overhangsAt(a, false, 0, -1), [EAVE]);
  assert.deepEqual(overhangsAt(b, false, 3000, 1), [EAVE]);
  // 接する辺の外形線は通り芯のまま（段差なく x=5000）
  assert.ok(a.outline[0].points.some((v, i) => i % 2 === 0 && v === 5000), 'A の外形線は x=5000 を通る');
});

test('【S4・QA T3】L字の建物の右腕だけを区画にすると、区画の region（矩形）＋残りの主屋根（key main・矩形で寄棟ではない）。区画に接する辺は両側 0', () => {
  const { graph } = buildRoofLayout('notch', 'none');
  const arm = [...footprintCellKeys(graph)].find(k => cellBoundsList([k], graph)[0].x1 === 2000);
  setZones(graph, zoneOf('arm', [arm]));
  const project = woodProject();
  assert.equal(mainRoofFramingRegion(graph, project).key, 'main', '前提: 残りの主屋根の region');
  const regions = topRoofFramingRegions(graph, project);
  assert.deepEqual(regions.map(r => r.key), ['zone:arm', 'main']);
  const [zone, rest] = regions;
  assert.deepEqual(zone.rect, { x1: 2000, y1: 0, x2: 4000, y2: 1500 });
  assert.deepEqual(rest.rect, { x1: 0, y1: 0, x2: 2000, y2: 3000 }, '残りは矩形（寄棟の rects ではない）');
  assert.notEqual(rest.shape, RoofShape.HIP);
  assert.deepEqual(overhangsAt(zone, true, 2000, -1), [0], '区画の左辺（主屋根に接する）');
  assert.deepEqual(overhangsAt(rest, true, 2000, 1), [0, EAVE], '主屋根の右辺: 区画に接する y 0..1500 は 0・その下（外）は出幅');
  assert.deepEqual(rest.edges.filter(e => e.isVertical && e.coord === 2000 && e.outward === 1).map(e => [e.lo, e.hi]), [[0, 1500], [1500, 3000]]);
  assert.deepEqual(overhangsAt(zone, true, 4000, 1), [EAVE], '区画の外側の辺は出幅のまま');
});

test('【S4】区画が建物全体（L字）なら region は区画の寄棟（rect:null・rects）だけ。主屋根の region は省かれ、例外にならない', () => {
  const { graph } = buildRoofLayout('notch', 'none');
  setZones(graph, zoneOf('all', [...footprintCellKeys(graph)]));
  let regions;
  assert.doesNotThrow(() => { regions = topRoofFramingRegions(graph, woodProject()); });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].key, 'zone:all');
  assert.equal(regions[0].rect, null);
  assert.equal(regions[0].shape, RoofShape.HIP);
  assert.equal(regions[0].rects.length, 3);
  assert.ok(regions[0].edges.every(e => e.overhangMm === EAVE), '他の屋根に接する辺は無い');
  assert.equal(mainRoofFramingRegion(graph, woodProject()), null, '残りが空の主屋根は region なし');
});

test('【S4】区画の spec の出幅は区画の region に効く（主屋根の spec ではなく）', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  const zone = zoneOf('zA', [cell(0, 0)]);
  zone.spec.setField('eaveOverhangMm', 300);
  zone.spec.setField('gableOverhangMm', 300);
  setZones(graph, zone);
  const [z, rest] = topRoofFramingRegions(graph, woodProject());
  assert.deepEqual(overhangsAt(z, true, 0, -1), [300]);
  assert.deepEqual(overhangsAt(rest, true, 10000, 1), [EAVE], '主屋根は 455 のまま');
});

// ---- 失敗系 ----

test('【失敗系・S4】実効セルが無い区画（建物範囲外・存在しないセル）は region なし。残りの主屋根は建物全体のまま', () => {
  const { graph } = topGrid([0, 9000], [0, 6000], [[0, 0]]);
  setZones(graph, zoneOf('ghost', ['no:such:cell:key']));
  const project = woodProject();
  const regions = topRoofFramingRegions(graph, project);
  assert.deepEqual(regions.map(r => r.key), ['main']);
  assert.deepEqual(regions[0].rect, { x1: 0, y1: 0, x2: 9000, y2: 6000 });
});

test('【失敗系・S4】形状が陸屋根・棟違いの区画は region なし（他の区画・主屋根は出る）。region の無い区画に接する主屋根の辺も軒の出 0（区画は独立した屋根）', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(graph, zoneOf('flat', [cell(0, 0)], RoofShape.FLAT), zoneOf('stag', [cell(1, 0)], RoofShape.STAGGERED));
  const project = woodProject();
  assert.deepEqual(topRoofFramingRegions(graph, project), []);
  setZones(graph, zoneOf('flat', [cell(0, 0)], RoofShape.FLAT));
  const regions = topRoofFramingRegions(graph, project);
  assert.deepEqual(regions.map(r => r.key), ['main'], '陸屋根の区画は無し・残りの主屋根だけ');
  assert.deepEqual(overhangsAt(regions[0], true, 5000, -1), [0], '陸屋根の区画に接する辺も軒の出 0（独立した屋根どうしの取り合い）');
});

test('【失敗系・S4】非在来（RC・S・未定）・project 無し・graph 無しは区画があっても []', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(graph, zoneOf('zA', [cell(0, 0)]));
  for (const key of ['RC造(ラーメン)', 'S造', '木造（2"×4"）']) {
    assert.deepEqual(topRoofFramingRegions(graph, woodProject(key)), [], key);
  }
  assert.deepEqual(topRoofFramingRegions(graph, null), []);
  assert.deepEqual(topRoofFramingRegions(null, woodProject()), []);
  const over = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  setZones(over.graph, zoneOf('zA', [over.cell(0, 0)]));
  over.graph.setStructureOverride('S造');
  assert.deepEqual(topRoofFramingRegions(over.graph, woodProject()), [], '階の上書きが S造');
});

// ---- 図面の region 導出（memo）----

function countingMemo() {
  const state = { calls: 0 };
  state.memo = (graph, key, compute) => graphComputed(graph, key, () => { state.calls++; return compute(); });
  return state;
}

test('【S4】小屋伏図の region の導出（memo）は区画の増減・セル・spec の変更で再計算される', () => {
  const { graph, cell } = topGrid([0, 5000, 10000], [0, 3000], [[0, 0], [1, 0]]);
  const project = woodProject();
  const spy = countingMemo();
  let last;
  const dispose = autorun(() => { last = roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: null, topGraph: graph, project, memo: spy.memo }); });
  try {
    assert.deepEqual(last.map(r => r.key), ['main']);
    const before = spy.calls;
    const zone = zoneOf('zA', [cell(0, 0)]);
    setZones(graph, zone);
    assert.ok(spy.calls > before, '区画の追加で再計算');
    assert.deepEqual(last.map(r => r.key), ['zone:zA', 'main']);
    const c = spy.calls;
    zone.spec.setField('shape', RoofShape.HIP);
    assert.ok(spy.calls > c, '区画の spec の変更で再計算');
    assert.equal(last[0].shape, RoofShape.HIP);
    setZones(graph);
    assert.deepEqual(last.map(r => r.key), ['main'], '区画の削除で元に戻る');
  } finally { dispose(); }
});

// ---- 小屋梁: 区画ごとの region から生成される ----

test('【S4・既知の限界】区画が残りを2つに分けると main は寄棟の rect:null（rects 2）で例外なし。主屋根が切妻なら main は出ない', () => {
  const W = 3640;
  const { graph, cell } = topGrid([0, W, 2 * W, 3 * W], [0, 2 * W], [[0, 0], [1, 0], [2, 0]]);
  setZones(graph, zoneOf('mid', [cell(1, 0)]));
  const project = woodProject();
  const regions = topRoofFramingRegions(graph, project);
  assert.deepEqual(regions.map(r => r.key), ['zone:mid', 'main']);
  const rest = regions[1];
  assert.equal(rest.rect, null);
  assert.equal(rest.rects.length, 2, '残りは分かれた2矩形を1つの寄棟 region として持つ');
  assert.equal(rest.shape, RoofShape.HIP);
  graph.mainRoofSpec.setField('shape', RoofShape.GABLE);
  assert.deepEqual(topRoofFramingRegions(graph, project).map(r => r.key), ['zone:mid'], '矩形でない残りの切妻は region なし（従来の主屋根と同じ）');
});

test('【S4】小屋梁: 2区画（切妻）の region 配列を渡すと、区画ごとの範囲に小屋梁ができる。区画 B を陸屋根にすると B の auto の小屋梁だけ撤去される', () => {
  const W = 3640;
  const { graph: top, cell } = topGrid([0, W, 2 * W], [0, 2 * W], [[0, 0], [1, 0]]);
  const zA = zoneOf('zA', [cell(0, 0)], RoofShape.GABLE);
  const zB = zoneOf('zB', [cell(1, 0)], RoofShape.GABLE);
  zA.spec.setField('ridgeDirection', 'vertical');
  zB.spec.setField('ridgeDirection', 'vertical');
  setZones(top, zA, zB);
  const regions = topRoofFramingRegions(top, woodProject());
  assert.deepEqual(regions.map(r => [r.key, r.shape, r.ridgeIsVertical]), [['zone:zA', 'gable', true], ['zone:zB', 'gable', true]]);

  // 小屋伏図相当の屋根専用平面: 軒桁を区画の外周＋境界（x=W）に通す
  const roof = new PlanGraph(new Plane('roof1', 6000, '小屋伏図', 1, 1, false, null, 0, true, 'top'));
  roof.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const cl = {
    x0: roof.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT), x1: roof.addCenterLine(CenterLineType.VERTICAL, W, STRUCT),
    x2: roof.addCenterLine(CenterLineType.VERTICAL, 2 * W, STRUCT),
    y0: roof.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT), y1: roof.addCenterLine(CenterLineType.HORIZONTAL, 2 * W, STRUCT),
  };
  const add = (axisCL, isVertical, a, b) => roof.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axisCL, isVertical, a, b, { role: 'primary', beamType: '軒桁' });
  add(cl.x0, true, cl.y0, cl.y1); add(cl.x1, true, cl.y0, cl.y1); add(cl.x2, true, cl.y0, cl.y1);
  add(cl.y0, false, cl.x0, cl.x1); add(cl.y0, false, cl.x1, cl.x2);
  add(cl.y1, false, cl.x0, cl.x1); add(cl.y1, false, cl.x1, cl.x2);

  const project = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎' } };
  const roofBeams = () => roof.beams.filter(b => b.role === 'roofBeam');
  const xRange = b => [Math.min(b.clStart.effectiveValue, b.clEnd.effectiveValue), Math.max(b.clStart.effectiveValue, b.clEnd.effectiveValue)];
  autoFillWoodRoofFraming(roof, project, regions);
  const inA = roofBeams().filter(b => xRange(b)[1] <= W);
  const inB = roofBeams().filter(b => xRange(b)[0] >= W);
  assert.ok(inA.length > 0 && inB.length > 0, `両方の区画に小屋梁がある（A ${inA.length}・B ${inB.length}）`);
  assert.equal(inA.length + inB.length, roofBeams().length, '区画をまたぐ小屋梁は無い');
  assert.equal(inA.length, inB.length, '同じ寸法の区画は同じ本数');

  // 区画を A だけにする（B の範囲は主屋根の残りになり、切妻でない… ここでは B を陸屋根にして region 無し）
  zB.spec.setField('shape', RoofShape.FLAT);
  autoFillWoodRoofFraming(roof, project, topRoofFramingRegions(top, woodProject()));
  assert.equal(roofBeams().filter(b => xRange(b)[0] >= W).length, 0, 'region の無い区画の auto の小屋梁は撤去される');
  assert.equal(roofBeams().filter(b => xRange(b)[1] <= W).length, inA.length, 'A の小屋梁は残る');
});

// ---- 配線 ----

const read = rel => stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));

test('【S4・配線】structuralRecompute.js は屋根専用平面の region を topRoofFramingRegions(belowGraph, project) で得る（mainRoofFramingRegion は使わない）', () => {
  const src = read('structuralRecompute.js');
  assert.match(src, /isRoof \? topRoofFramingRegions\(belowGraph, project\) : leanTo\.regions/);
  assert.doesNotMatch(src, /mainRoofFramingRegion/);
});

test('【S4・配線】roofFramingRegionsForFigure の小屋伏図は topRoofFramingRegions を memo の中で呼ぶ', () => {
  const src = read('roofFramingRegions.js');
  assert.match(src, /memo\(topGraph, 'roofFramingMainRegions', \(\) => topRoofFramingRegions\(topGraph, project\)\)/);
});
