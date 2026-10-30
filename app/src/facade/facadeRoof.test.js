// 立面図の屋根（S2。facade/facadeRoof.js と facadeGeometry.js の屋根の線・隠れ・頭打ち・下屋の取り合い）のテスト。
// region は本番と同じ解決（modes/FacadeModeState.js facadeRoofRegionsResolver → roofFramingRegions.js）で、最小の graph から作る。
// 期待値は fixture の寸法（屋根範囲・既定の出幅 455・勾配 3/10・外壁の外面＝通り芯から 57.5 外）から手で書く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape } from '@core';
import {
  FacadeDirection, FacadeSkipReason, DEFAULT_ROOF_EAVE_OVERHANG_MM, DEFAULT_ROOF_SLOPE,
} from '../core/constants.js';
import { generateExteriorWalls } from '../finish/wallGeneration.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { leanToPlanRegions, topRoofPlanRegions } from '../structural/roofFramingRegions.js';
import { ElevationLineRole } from '../elevation/elevationStyle.js';
import { facadeRoofRegionsResolver } from '../modes/FacadeModeState.js';
import { buildFacadeInputs } from './facadeInputs.js';
import { facadeViews, buildFacadeLines, facadeFloorProfiles, isHidden } from './facadeGeometry.js';
import { buildFacadeModel } from './facadeFigure.js';
import { facadeRoofOf } from './facadeRoof.js';
import { roofPlanRegionFigure } from '../finish/roof/roofPlanFigure.js';
import { FACADE_ROOF_OCCLUSION_DEPTH_MM, FACADE_ROOF_LINE_KIND } from './facadeStyle.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const OH = DEFAULT_ROOF_EAVE_OVERHANG_MM;   // 455（軒・けらばとも既定）
const K = DEFAULT_ROOF_SLOPE / 10;          // 0.3
const FACE = 57.5;                          // 外壁の外面（DEFAULT_WALL_BASE=90 の半分＋仕上げ12.5）
const TOL = 1;                              // 見え隠れの二分探索（0.5mm）を含む許容差

function woodProject(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = new Project('proj', 'test');
  project.structuralInfo.mainStructure = structure;
  return project;
}

/** 階を足し、格子 xs×ys を張る。interior／roof にセル [i,j] の配列を渡す。 */
function addFloor(project, id, elevation, startFloor, xs, ys, { interior, roof = null }) {
  const { graph } = project.addPlane(elevation, `${startFloor}階`, id, startFloor);
  const cx = xs.map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const cy = ys.map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const cell = ([i, j]) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  graph.addRoom(new Set(interior.map(cell)), '居間');
  if (roof) {
    const room = graph.addRoom(new Set(roof.map(cell)), '屋根');
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
  }
  generateExteriorWalls(graph);
  project.activePlaneId ??= id;
  return graph;
}

const floorsOf = project => project.planes.map(plane => ({ plane, graph: project.graphMap.get(plane.id) }));
const inputsOf = project => buildFacadeInputs(floorsOf(project), project, { roofRegionsOf: facadeRoofRegionsResolver(project) });
const viewOf = dir => facadeViews().find(v => v.direction === dir);
const linesOf = (inputs, dir) => buildFacadeLines(inputs, viewOf(dir));

const isRoof = l => l.kind === FACADE_ROOF_LINE_KIND;
const near = (a, b) => Math.abs(a - b) <= TOL;
const isHoriz = l => Math.abs(l.z1 - l.z2) <= TOL && Math.abs(l.x1 - l.x2) > TOL;
const isVert = l => Math.abs(l.x1 - l.x2) <= TOL && Math.abs(l.z1 - l.z2) > TOL;
const isSloped = l => !isHoriz(l) && !isVert(l);
/** 線を [左の u, 左の z, 右の u, 右の z]（u の小さい方が先。縦線は z の小さい方が先）。 */
const ends = l => (l.x1 < l.x2 - TOL || (near(l.x1, l.x2) && l.z1 <= l.z2) ? [l.x1, l.z1, l.x2, l.z2] : [l.x2, l.z2, l.x1, l.z1]);
const assertNear = (actual, expected, msg) => assert.ok(near(actual, expected), `${msg}: ${actual} ≠ ${expected}`);
const roofHorizAt = (lines, z) => lines.filter(l => isRoof(l) && isHoriz(l) && near(l.z1, z)).map(l => ends(l));
const wallVerts = lines => lines.filter(l => !isRoof(l) && isVert(l)).map(l => ends(l));

/** 平屋 9000×6000（棟は長手＝x 方向）の最上階。shape を指定すれば主屋根の形状を明示。 */
function oneStory(shape = null, structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = woodProject(structure);
  const graph = addFloor(project, 'p1', 0, 1, [0, 9000], [0, 6000], { interior: [[0, 0]] });
  if (shape) graph.mainRoofSpec.setField('shape', shape);
  return { project, graph };
}

// ---- 切妻 ----
test('切妻（棟が x 方向）: 南立面は軒先の水平線＝軒の高さ−k·出幅、棟の水平線＝軒の高さ+k·(短手/2)、妻の三角なし', () => {
  const { project } = oneStory();
  const inputs = inputsOf(project);
  assert.equal(inputs.roofs.length, 1);
  const eave = inputs.floors[0].zHiMm; // 最上階の zHi＝軒桁上端＝主屋根の軒の高さ
  assert.equal(inputs.roofs[0].eaveZMm, eave);
  const south = linesOf(inputs, FacadeDirection.SOUTH);
  const eaveLow = eave - K * OH;
  const ridge = eave + K * 3000;
  const [eaveLine] = roofHorizAt(south, eaveLow);
  assert.ok(eaveLine, '軒先の線');
  assertNear(eaveLine[0], -OH, '軒先の左端（けらばの出幅）');
  assertNear(eaveLine[2], 9000 + OH, '軒先の右端');
  const [ridgeLine] = roofHorizAt(south, ridge);
  assert.ok(ridgeLine, '棟の線');
  assertNear(ridgeLine[0], -OH, '棟の左端');
  assertNear(ridgeLine[2], 9000 + OH, '棟の右端');
  assert.deepEqual(south.filter(l => isRoof(l) && isSloped(l)), [], '妻の三角は南からは見えない');
  // けらばは端の縦線（軒先〜棟）
  const roofVerts = south.filter(l => isRoof(l) && isVert(l)).map(ends).sort((a, b) => a[0] - b[0]);
  assert.equal(roofVerts.length, 2);
  assertNear(roofVerts[0][1], eaveLow, 'けらばの縦線の下端');
  assertNear(roofVerts[0][3], ridge, 'けらばの縦線の上端');
  assert.ok(south.every(l => l.role !== ElevationLineRole.DETAIL), '切妻に隅木・谷木は無い');
});

test('切妻: 東立面は妻の三角（けらば2辺が棟の端で折れる）。壁の上端の横線は無く、角の縦線は屋根面（−遮蔽の厚み）まで', () => {
  const { project } = oneStory();
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const east = linesOf(inputs, FacadeDirection.EAST); // 東立面: u = −y（左が南）
  const sloped = east.filter(l => isRoof(l) && isSloped(l)).map(ends).sort((a, b) => a[0] - b[0]);
  assert.equal(sloped.length, 2, JSON.stringify(sloped));
  const ridge = eave + K * 3000;
  const eaveLow = eave - K * OH;
  assertNear(sloped[0][0], -(6000 + OH), '左のけらばの下端（南の軒の出）');
  assertNear(sloped[0][1], eaveLow, '左のけらばの下端の高さ');
  assertNear(sloped[0][2], -3000, '頂点＝棟の端');
  assertNear(sloped[0][3], ridge, '頂点の高さ');
  assertNear(sloped[1][0], -3000, '右のけらばの上端');
  assertNear(sloped[1][2], OH, '右のけらばの下端（北の軒の出）');
  assertNear(sloped[1][3], eaveLow, '右のけらばの下端の高さ');
  // 頭打ち: 妻の壁は屋根面まで続くので、壁の上端（zHi）の横線は描かない
  assert.deepEqual(east.filter(l => !isRoof(l) && isHoriz(l) && l.z1 > 0), [], '壁の上端の横線なし');
  // 角（外面の角は水下の辺の外 57.5）の縦線: 屋根面 eave−k·57.5 からけらばの遮蔽の厚みぶん下まで
  const verts = wallVerts(east).sort((a, b) => a[0] - b[0]);
  assert.equal(verts.length, 2);
  for (const v of verts) assertNear(v[3], eave - K * FACE - FACADE_ROOF_OCCLUSION_DEPTH_MM, '角の縦線の上端');
});

test('切妻: 南立面の壁の角の縦線は軒の出の下で隠れる（軒先の高さ − 遮蔽の厚みまで）', () => {
  const { project } = oneStory();
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const verts = wallVerts(linesOf(inputs, FacadeDirection.SOUTH)).sort((a, b) => a[0] - b[0]);
  assert.equal(verts.length, 2);
  assertNear(verts[0][0], -FACE, '左の角');
  for (const v of verts) {
    assertNear(v[1], 0, '下端＝GL');
    assertNear(v[3], eave - K * OH - FACADE_ROOF_OCCLUSION_DEPTH_MM, '上端＝手前の軒の出の屋根面の最小 − 厚み');
  }
});

test('切妻: 面の高さは棟まで（facadeExtentsMm の高さ・図の bounds に屋根を含む）、幅は軒の出を含む', () => {
  const { project } = oneStory();
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const south = buildFacadeModel(inputs).find(f => f.direction === FacadeDirection.SOUTH);
  assertNear(south.heightMm, eave + K * 3000 - inputs.glZMm, '高さ＝GL〜棟');
  assertNear(south.widthMm, 9000 + 2 * OH, '幅＝けらばの出幅を含む');
});

// ---- 寄棟・片流れ・陸屋根 ----
test('寄棟: 南立面は台形（軒先の水平線・短い棟・隅木2本＝細線）、東立面は三角（隅木2本が棟の端で出会う）', () => {
  const { project } = oneStory(RoofShape.HIP);
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const eaveLow = eave - K * OH;
  const ridge = eave + K * 3000;
  const south = linesOf(inputs, FacadeDirection.SOUTH);
  const [eaveLine] = roofHorizAt(south, eaveLow);
  assertNear(eaveLine[0], -OH, '軒先の左端');
  assertNear(eaveLine[2], 9000 + OH, '軒先の右端');
  const [ridgeLine] = roofHorizAt(south, ridge);
  assertNear(ridgeLine[0], 3000, '棟の左端（短手/2 内側）');
  assertNear(ridgeLine[2], 6000, '棟の右端');
  const hips = south.filter(l => isRoof(l) && l.role === ElevationLineRole.DETAIL).map(ends).sort((a, b) => a[0] - b[0]);
  assert.equal(hips.length, 2, JSON.stringify(hips));
  assertNear(hips[0][0], -OH, '左の隅木の下端');
  assertNear(hips[0][1], eaveLow, '左の隅木の下端の高さ');
  assertNear(hips[0][2], 3000, '左の隅木の上端＝棟の端');
  assertNear(hips[0][3], ridge, '左の隅木の上端の高さ');
  assert.deepEqual(south.filter(l => isRoof(l) && isSloped(l) && l.role === ElevationLineRole.SILHOUETTE), [], '斜めの外形線は無い');

  const east = linesOf(inputs, FacadeDirection.EAST);
  const eastHips = east.filter(l => isRoof(l) && l.role === ElevationLineRole.DETAIL).map(ends).sort((a, b) => a[0] - b[0]);
  assert.equal(eastHips.length, 2);
  assertNear(eastHips[0][2], -3000, '隅木が棟の端で出会う');
  assertNear(eastHips[0][3], ridge, '頂点の高さ');
  assert.equal(roofHorizAt(east, ridge).length, 0, '東からは棟が点（線にならない）');
  assert.equal(roofHorizAt(east, eaveLow).length, 1, '軒先の水平線');
});

// 水上の軒の出は屋根面の延長として上がる（リード裁定 2026-10-30）ので、高い側の軒先は奥行＋出幅ぶん上（従来は奥行ぶん＝水平に出ていた）。
test('片流れ: 高い側（北）の軒先の水平線＝軒の高さ+k·(奥行+出幅)、低い側（南）の軒先＝軒の高さ−k·出幅。東立面は1本の斜めのけらば', () => {
  const { project, graph } = oneStory(RoofShape.MONO);
  const [region] = topRoofPlanRegions(graph, project);
  assert.equal(region.highSide, 'top', '前提: 高い側は北（y の小さい側）');
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const high = eave + K * (6000 + OH);
  const eaveLow = eave - K * OH;
  const south = linesOf(inputs, FacadeDirection.SOUTH);
  assert.equal(roofHorizAt(south, eaveLow).length, 1, '低い側の軒先');
  assert.equal(roofHorizAt(south, high).length, 1, '高い側の線（水上の軒）');
  const east = linesOf(inputs, FacadeDirection.EAST);
  const sloped = east.filter(l => isRoof(l) && isSloped(l)).map(ends);
  assert.equal(sloped.length, 1, JSON.stringify(sloped));
  assertNear(sloped[0][0], -(6000 + OH), 'けらばの下端（南の軒の出）');
  assertNear(sloped[0][1], eaveLow, 'けらばの下端の高さ');
  assertNear(sloped[0][2], OH, 'けらばの上端＝高い側の軒先（y=−出幅。水上の軒の出も同じ勾配で上がる）');
  assertNear(sloped[0][3], high, 'けらばの上端の高さ');
});

test('片流れ: 水上の軒の出は屋根面の延長として上がる（北立面の軒先＝軒の高さ+k·(奥行+出幅)）。けらばの出は水平のまま', () => {
  const { project } = oneStory(RoofShape.MONO);
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const north = linesOf(inputs, FacadeDirection.NORTH); // 北立面: u = −x
  const [eaveLine] = roofHorizAt(north, eave + K * (6000 + OH));
  assert.ok(eaveLine, `水上の軒先: ${JSON.stringify(north.filter(isRoof))}`);
  assertNear(eaveLine[0], -(9000 + OH), '水上の軒先の左端');
  assertNear(eaveLine[2], OH, '水上の軒先の右端');
  assert.deepEqual(roofHorizAt(north, eave + K * 6000), [], '水上の辺の高さで水平に出た線は無い');
  const roof = inputs.roofs[0];
  assertNear(roof.zAt(4500, -OH), eave + K * (6000 + OH), '水上の軒先の高さ');
  assertNear(roof.zAt(-OH, 3000), eave + K * 3000, 'けらばの出は屋根範囲の端と同じ高さ');
});

test('片流れ: 北立面（水上側）のけらばの縦線2本は自分の屋根で消えない（外形線の辺に沿う視線は見える）', () => {
  const { project } = oneStory(RoofShape.MONO);
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  const north = linesOf(inputs, FacadeDirection.NORTH); // 北立面: u = −x
  const verts = north.filter(l => isRoof(l) && isVert(l)).map(ends).sort((a, b) => a[0] - b[0]);
  assert.equal(verts.length, 2, JSON.stringify(verts));
  assertNear(verts[0][0], -(9000 + OH), '東のけらば');
  assertNear(verts[1][0], OH, '西のけらば');
  for (const v of verts) {
    assertNear(v[1], eave - K * OH, 'けらばの縦線の下端＝水下の軒先');
    assertNear(v[3], eave + K * (6000 + OH), 'けらばの縦線の上端＝水上の軒先');
  }
});

test('寄棟の L 字（谷あり）: 谷木は細線（DETAIL）', () => {
  const project = woodProject();
  const graph = addFloor(project, 'p1', 0, 1, [0, 4000, 8000], [0, 3000, 6000], { interior: [[0, 0], [1, 0], [0, 1]] });
  graph.mainRoofSpec.setField('shape', RoofShape.HIP);
  const [region] = topRoofPlanRegions(graph, project);
  const valleys = roofPlanRegionFigure(region).lines.filter(l => l.role === 'valley');
  assert.ok(valleys.length > 0, '前提: 谷木がある');
  const { roof } = facadeRoofOf(region, 3000);
  const valleySegs = roof.segments.filter(s => valleys.some(v => near(v.points[0], s.x1) && near(v.points[1], s.y1)
    && near(v.points[2], s.x2) && near(v.points[3], s.y2)));
  assert.equal(valleySegs.length, valleys.length);
  assert.ok(valleySegs.every(s => s.role === ElevationLineRole.DETAIL), JSON.stringify(valleySegs));
});

test('陸屋根（S造の既定）: 屋根の線なし＝S1 と同じ線（region が出ない）', () => {
  const { project } = oneStory(null, 'S造');
  const inputs = inputsOf(project);
  assert.deepEqual(inputs.roofs, []);
  assert.deepEqual(inputs.skipped, []);
  const withoutRoofs = buildFacadeInputs(floorsOf(project), project);
  for (const view of facadeViews()) {
    assert.deepEqual(buildFacadeLines(inputs, view), buildFacadeLines(withoutRoofs, view), view.direction);
  }
  const south = linesOf(inputs, FacadeDirection.SOUTH);
  assert.ok(south.some(l => isHoriz(l) && near(l.z1, inputs.floors[0].zHiMm)), '壁の上端の横線は S1 どおり');
});

// ---- 2階建て＋下屋 ----
/** 1階 9000×6000、2階は北の 9000×4000。2階の屋根セル（x 3000..6000 × y 4000..6000）が下屋（水下は南）。 */
function twoStoryLeanTo() {
  const project = woodProject();
  const xs = [0, 3000, 6000, 9000], ys = [0, 4000, 6000];
  addFloor(project, 'p1', 0, 1, xs, ys, { interior: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] });
  const g2 = addFloor(project, 'p2', 3000, 2, xs, ys, { interior: [[0, 0], [1, 0], [2, 0]], roof: [[1, 1]] });
  return { project, g2 };
}

test('2階建て＋下屋: 下屋の軒の高さ＝2FL。南立面は下屋の軒先・2階の壁との取り合いの線、下屋の屋根面の z 範囲で 2階の壁が隠れる', () => {
  const { project, g2 } = twoStoryLeanTo();
  const [region] = leanToPlanRegions(g2);
  assert.ok(region && !region.outlineOnly, '前提: 下屋の region');
  const inputs = inputsOf(project);
  const lean = inputs.roofs.find(r => r.key === region.key);
  assert.equal(lean.eaveZMm, 3000, '下屋の軒の高さ＝屋根セルが付く階（2階）の FL');
  const south = linesOf(inputs, FacadeDirection.SOUTH);
  const eaveLow = 3000 - K * OH;
  const [eaveLine] = roofHorizAt(south, eaveLow);
  assert.ok(eaveLine, '下屋の軒先');
  assertNear(eaveLine[0], 3000 - OH, '下屋の軒先の左端');
  assertNear(eaveLine[2], 6000 + OH, '下屋の軒先の右端');
  // 2階の南の壁（外面 y=4057.5）に屋根面が取りつく高さ＝2FL + k·(水下までの距離 6000−4057.5)
  const junction = 3000 + K * (6000 - 4000 - FACE);
  const [junctionLine] = roofHorizAt(south, junction);
  assert.ok(junctionLine, `取り合いの線 z=${junction}: ${JSON.stringify(south.filter(isRoof))}`);
  assertNear(junctionLine[0], 3000 - OH, '取り合いの線の左端（けらばの出幅まで）');
  assertNear(junctionLine[2], 6000 + OH, '取り合いの線の右端');
  // 下屋の範囲では 2階の壁の下端（2FL）の横線は描かない（屋根面に隠れ、取り合いの線が代わる）
  const bottom = south.filter(l => !isRoof(l) && isHoriz(l) && near(l.z1, 3000)).map(ends);
  for (const [a, , b] of bottom) assert.ok(b <= 3000 - OH + TOL || a >= 6000 + OH - TOL, `下屋の前の 2階の下端: ${a}..${b}`);
  // 2階の南の壁（u=4500・外面の深さ −4057.5）: 取り合いより下は下屋の屋根面に隠れ、上は見える
  const view = viewOf(FacadeDirection.SOUTH);
  const profiles = facadeFloorProfiles(inputs, view.normal);
  const wallDepth = -(4000 + FACE);
  assert.equal(isHidden(profiles, 4500, junction - 10, wallDepth, inputs.roofs, view.normal), true, '下屋の屋根面の z 範囲で 2階の壁は隠れる');
  assert.equal(isHidden(profiles, 4500, junction + 10, wallDepth, inputs.roofs, view.normal), false, '下屋の屋根面の上に 2階の壁が見える');
  assert.equal(isHidden(profiles, 1500, 3010, wallDepth, inputs.roofs, view.normal), false, '下屋の無い u では 2FL のすぐ上も見える');
});

test('2階建て＋下屋: 北立面では下屋は建物に隠れる（屋根の線は2階の主屋根だけ）', () => {
  const { project, g2 } = twoStoryLeanTo();
  const [region] = leanToPlanRegions(g2);
  const inputs = inputsOf(project);
  const lean = inputs.roofs.find(r => r.key === region.key);
  const north = linesOf(inputs, FacadeDirection.NORTH);
  const leanTop = lean.segments.reduce((m, s) => Math.max(m, s.z1, s.z2), -Infinity);
  const roofBelowLeanTop = north.filter(l => isRoof(l) && Math.max(l.z1, l.z2) <= leanTop + TOL);
  assert.deepEqual(roofBelowLeanTop, [], '下屋の高さ以下の屋根の線は無い');
});

test('2階建て＋端の下屋: 下屋の妻の壁（1階の壁の頭打ち）と面一の 2階の壁の角の縦線は、屋根面より下を描かない', () => {
  // 下屋を西の端（x 0..3000 × y 4000..6000）に置く: 1階・2階の西の壁は x=−57.5 で面一
  const project = woodProject();
  const xs = [0, 3000, 9000], ys = [0, 4000, 6000];
  addFloor(project, 'p1', 0, 1, xs, ys, { interior: [[0, 0], [1, 0], [0, 1], [1, 1]] });
  addFloor(project, 'p2', 3000, 2, xs, ys, { interior: [[0, 0], [1, 0]], roof: [[0, 1]] });
  const inputs = inputsOf(project);
  const west = linesOf(inputs, FacadeDirection.WEST); // 西立面: u = y（左が北）
  const corner = 4000 + FACE; // 2階の西の壁の南の角
  const roofAtCorner = 3000 + K * (6000 - corner);
  const cornerLines = wallVerts(west).filter(v => near(v[0], corner));
  assert.ok(cornerLines.length > 0, '2階の角の縦線（屋根面より上）はある');
  for (const v of cornerLines) {
    assert.ok(v[1] >= roofAtCorner - FACADE_ROOF_OCCLUSION_DEPTH_MM - TOL, `屋根面より下に角の線が出ない: ${v[1]}..${v[3]}`);
  }
});

test('L 字の片流れ下屋（東と南の翼・出隅に隅木。roof-test1 と同じ形）: 南立面に細線なし（隅木は東の翼の真横の線に重なる）・取り合いの線と隅木の上端が一致', () => {
  // 1階 8000×6000、2階は北西の 6000×4000。2階の屋根セル＝東（x 6000..8000 × y 0..4000）・南（y 4000..6000）・出隅のL字
  const project = woodProject();
  const xs = [0, 6000, 8000], ys = [0, 4000, 6000];
  addFloor(project, 'p1', 0, 1, xs, ys, { interior: [[0, 0], [1, 0], [0, 1], [1, 1]] });
  const g2 = addFloor(project, 'p2', 3000, 2, xs, ys, { interior: [[0, 0]], roof: [[1, 0], [0, 1], [1, 1]] });
  const [region] = leanToPlanRegions(g2);
  assert.equal(region?.leanToWings?.length, 2, '前提: 翼が2つの L 字の片流れ');
  const inputs = inputsOf(project);
  const lean = inputs.roofs.find(r => r.key === region.key);
  assert.equal(lean.segments.filter(s => s.role === ElevationLineRole.DETAIL).length, 1, '前提: 隅木が1本');
  const south = linesOf(inputs, FacadeDirection.SOUTH); // 南立面: u = x
  assert.deepEqual(south.filter(l => l.role === ElevationLineRole.DETAIL), [], '隅木は外形線に譲る');
  // 2階の南の壁（外面 y=4057.5）への取り合いの線＝2FL + k·(南の翼の奥行 − 57.5)
  const junction = 3000 + K * (2000 - FACE);
  const [junctionLine] = roofHorizAt(south, junction);
  assert.ok(junctionLine, `取り合いの線 z=${junction}: ${JSON.stringify(south.filter(isRoof))}`);
  assertNear(junctionLine[2], 6000 + FACE, '取り合いの線の右端＝2階の南東の角');
  // 隅木（＝東の翼の真横の線）の見える上端は取り合いの線の右端に一致
  const sloped = south.filter(l => isRoof(l) && isSloped(l)).map(ends);
  assert.equal(sloped.length, 1, JSON.stringify(sloped));
  assertNear(sloped[0][0], 6000 + FACE, '斜めの線の上端の u');
  assertNear(sloped[0][1], junction, '斜めの線の上端の高さ＝取り合いの線');
  assertNear(sloped[0][2], 8000 + OH, '斜めの線の下端＝東の軒先');
  assertNear(sloped[0][3], 3000 - K * OH, '斜めの線の下端の高さ');
});

test('下屋の軒の出の帯に立つ上の階の角の縦線は、屋根面まで下ろす（けらばの線との間に切れ目を作らない。roof-test2 と同じ形）', () => {
  // 1階 9000×6000、2階は北西の欠けた L 字。欠け（x 0..4000 × y 0..3000）が下屋（水下＝北）で、北の軒の出は 2階の北の壁の前まで回る
  const project = woodProject();
  const xs = [0, 4000, 9000], ys = [0, 3000, 6000];
  addFloor(project, 'p1', 0, 1, xs, ys, { interior: [[0, 0], [1, 0], [0, 1], [1, 1]] });
  const g2 = addFloor(project, 'p2', 3000, 2, xs, ys, { interior: [[1, 0], [0, 1], [1, 1]], roof: [[0, 0]] });
  const [region] = leanToPlanRegions(g2);
  assert.ok(region && !region.outlineOnly, '前提: 下屋の region');
  const inputs = inputsOf(project);
  const lean = inputs.roofs.find(r => r.key === region.key);
  const corner = { x: 4000 - FACE, y: -FACE }; // 2階の欠けの東の壁の北の角（西立面の u = y）
  const roofZ = lean.zAt(corner.x, corner.y);
  assertNear(roofZ, 3000 - K * FACE, '前提: 角は北の軒の出の帯（屋根面は 2FL より下）');
  const west = linesOf(inputs, FacadeDirection.WEST);
  const cornerLines = wallVerts(west).filter(v => near(v[0], corner.y) && v[3] > 3000);
  assert.equal(cornerLines.length, 1, JSON.stringify(wallVerts(west)));
  assertNear(cornerLines[0][1], roofZ, '2階の角の縦線の下端＝屋根面（けらばの線に接する）');
});

// ---- 外形線だけの region ----
test('外形線だけの region（L字の最上階に明示の切妻＝矩形でない切妻）: 軒の高さの水平線だけ（隅木・棟なし。skipped に載せない）', () => {
  const project = woodProject();
  const graph = addFloor(project, 'p1', 0, 1, [0, 4000, 8000], [0, 3000, 6000], { interior: [[0, 0], [1, 0], [0, 1]] });
  graph.mainRoofSpec.setField('shape', RoofShape.GABLE);
  const [region] = topRoofPlanRegions(graph, project);
  assert.equal(region.outlineOnly, true, '前提: 外形線だけの補完 region');
  const inputs = inputsOf(project);
  const eave = inputs.floors[0].zHiMm;
  assert.equal(inputs.roofs[0].flat, true);
  assert.deepEqual(inputs.skipped, []);
  for (const view of facadeViews()) {
    const roofLines = buildFacadeLines(inputs, view).filter(isRoof);
    assert.ok(roofLines.length > 0, view.direction);
    assert.ok(roofLines.every(l => isHoriz(l) && near(l.z1, eave)), `${view.direction}: ${JSON.stringify(roofLines)}`);
  }
});

// ---- 失敗系 ----
function gableRegion() {
  const { project, graph } = oneStory();
  const [region] = topRoofPlanRegions(graph, project);
  return region;
}

test('【失敗系】facadeRoofOf: region が空・範囲なし・外形線なしは roof:null（ROOF_NO_OUTLINE）。例外にしない', () => {
  assert.deepEqual(facadeRoofOf(null, 3000), { roof: null, reason: FacadeSkipReason.ROOF_NO_OUTLINE });
  assert.deepEqual(facadeRoofOf({}, 3000), { roof: null, reason: FacadeSkipReason.ROOF_NO_OUTLINE });
  const region = gableRegion();
  assert.equal(facadeRoofOf({ ...region, outline: [] }, 3000).reason, FacadeSkipReason.ROOF_NO_OUTLINE);
  assert.equal(facadeRoofOf({ ...region, rect: null, rects: [] }, 3000).reason, FacadeSkipReason.ROOF_NO_OUTLINE);
  assert.equal(facadeRoofOf(region, NaN).reason, FacadeSkipReason.ROOF_NO_OUTLINE, '軒の高さが不正');
});

test('【失敗系】facadeRoofOf: 勾配 0・水下なし・到達時刻が作れない（水下が範囲に届かない）は平ら（軒の高さの外形線だけ・flatFallback）', () => {
  const region = gableRegion();
  for (const [name, bad] of [
    ['勾配 0', { ...region, slope: 0 }],
    ['水下なし', { ...region, planDrains: [] }],
    ['到達時刻が作れない', { ...region, planDrains: [{ isVertical: true, coord: 99999, lo: 0, hi: 1, outward: 1 }] }],
  ]) {
    const { roof } = facadeRoofOf(bad, 3000);
    assert.ok(roof, name);
    assert.equal(roof.flat, true, name);
    assert.equal(roof.flatFallback, true, name);
    assert.ok(roof.segments.length > 0 && roof.segments.every(s => s.z1 === 3000 && s.z2 === 3000), name);
    assert.ok(roof.segments.every(s => s.role === ElevationLineRole.SILHOUETTE), `${name}: 棟・隅木は無い`);
  }
});

test('【失敗系】facadeRoofOf: 例外（水下の値が不正）は roof:null・ERROR と message', () => {
  const region = gableRegion();
  const out = facadeRoofOf({ ...region, planDrains: [{ isVertical: true, coord: NaN, lo: 0, hi: 1, outward: 1 }] }, 3000);
  assert.equal(out.roof, null);
  assert.equal(out.reason, FacadeSkipReason.ERROR);
  assert.equal(typeof out.message, 'string');
});

test('【失敗系】buildFacadeInputs: 屋根の解決が例外の階は skipped（ERROR）で壁は描く。不正な region はその屋根だけ落ち、平らに落とした屋根は ROOF_FLAT_FALLBACK', () => {
  const { project } = oneStory();
  const throwing = buildFacadeInputs(floorsOf(project), project, { roofRegionsOf: () => { throw new Error('boom'); } });
  assert.equal(throwing.floors.length, 1, '壁は残る');
  assert.deepEqual(throwing.roofs, []);
  assert.deepEqual(throwing.skipped, [{ planeId: 'p1', reason: FacadeSkipReason.ERROR, message: 'boom' }]);

  const good = gableRegion();
  const mixed = buildFacadeInputs(floorsOf(project), project, {
    roofRegionsOf: () => ({
      top: [{ ...good, key: 'bad', outline: [] }, good, { ...good, key: 'flat', slope: 0 }],
    }),
  });
  assert.deepEqual(mixed.roofs.map(r => r.key), [good.key, 'flat'], '不正な region だけ落ちる');
  assert.deepEqual(mixed.skipped, [
    { planeId: 'p1', roofKey: 'bad', reason: FacadeSkipReason.ROOF_NO_OUTLINE },
    { planeId: 'p1', roofKey: 'flat', reason: FacadeSkipReason.ROOF_FLAT_FALLBACK },
  ]);
  assert.doesNotThrow(() => buildFacadeModel(mixed));
});

test('【失敗系】buildFacadeInputs: 下屋の region は最上階でなくても載る／主屋根（top）は最上階の分だけ', () => {
  const { project, g2 } = twoStoryLeanTo();
  const region = gableRegion();
  // 1階にも top を返す解決器: 最上階でない階の top は使わない
  const inputs = buildFacadeInputs(floorsOf(project), project, {
    roofRegionsOf: graph => ({ leanTo: graph === g2 ? leanToPlanRegions(g2) : [], top: [{ ...region, key: `top:${graph.plane.id}` }] }),
  });
  assert.deepEqual(inputs.roofs.filter(r => r.key.startsWith('top:')).map(r => r.key), ['top:p2']);
  assert.equal(inputs.roofs.filter(r => r.key.startsWith('lean:')).length, 1);
});
