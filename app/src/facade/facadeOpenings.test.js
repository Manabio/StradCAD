// 立面図の外壁の建具（S3。facade/facadeOpenings.js と facadeInputs.js・facadeFigure.js の配線）のテスト。
// 壁は本番の generateExteriorWalls で作り（外面＝通り芯から 57.5 外）、建具は graph.addOpening で置く。期待値は fixture の寸法から手で書く。
// 左右の取り違えが最大のリスクなので、片開きドアの吊元の V 字の頂点（吊元側）を 4 面とも図の X で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, OpeningCategory, RoomKind, RoomFeature, ShapeType,
} from '@core';
import { FacadeDirection } from '../core/constants.js';
import { generateExteriorWalls } from '../finish/wallGeneration.js';
import { buildFacadeInputs } from './facadeInputs.js';
import { buildFacadeModel } from './facadeFigure.js';
import { facadeViews, facadeFloorProfiles } from './facadeGeometry.js';
import { buildFacadeOpenings, exteriorOpeningsOn } from './facadeOpenings.js';
import { FACADE_OPENING_KIND } from './facadeStyle.js';
import { facadeRoofRegionsResolver } from '../modes/FacadeModeState.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const TOP_STORY_MM = 2900;
const GL_BELOW = 450;
const GL = -GL_BELOW;   // 世界 z の GL（1FL=0）
const FACE = 57.5;      // 外壁の外面（通り芯から）

function plane(id, elevation, startFloor) {
  return new Plane(id, elevation, `${startFloor}階`, startFloor, 1, false, null, 0, false, null,
    undefined, undefined, TOP_STORY_MM);
}

// 平屋 4000×3000（x 0..4000 × y 0..3000）。split=true なら x=2000 で 2 室に分ける（内壁の通り芯）。
function rectGraph({ split = false } = {}) {
  const p1 = plane('p1', 0, 1);
  const graph = new PlanGraph(p1);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const xm = split ? graph.addCenterLine(CenterLineType.VERTICAL, 2000, ARCH) : null;
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, ARCH);
  if (split) {
    graph.addRoom(new Set([`${x0.id}:${y0.id}:${xm.id}:${y1.id}`]), 'A');
    graph.addRoom(new Set([`${xm.id}:${y0.id}:${x1.id}:${y1.id}`]), 'B');
  } else {
    graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  }
  generateExteriorWalls(graph);
  return { p1, graph, cl: { x0, xm, x1, y0, y1 } };
}

const DOOR = { category: OpeningCategory.FITTING, subType: 'door' };
const WINDOW = { category: OpeningCategory.WINDOW, subType: 'doubleSliding' };

// 建具を置く（refCL からの refOffset＝中心）。axis は壁の軸 CL、isVertical は軸が縦か。
function addOpening(graph, axis, wallSide, refCL, center, width, kind, props = {}) {
  assert.ok(Object.values(CenterLineType).includes(axis.centerLineType), '前提: 軸 CL の種別を読めている');
  return graph.addOpening(axis, wallSide, axis.centerLineType === CenterLineType.VERTICAL, refCL, center, width,
    kind.category, kind.subType, props);
}

const modelOf = (p1, graph, opts = {}) => buildFacadeModel(buildFacadeInputs([{ plane: p1, graph }],
  { glBelow1FlMm: GL_BELOW, planes: [p1] }), opts);
const faceOf = (model, dir) => model.find(f => f.direction === dir);
const openingPrims = face => face.primitives.filter(p => p.kind === FACADE_OPENING_KIND);

// 片開きの V 字（斜めの line 2 本）の頂点＝吊元側の縦辺の中ほど。
function veeApex(prims) {
  const sloped = prims.filter(p => p.type === 'line' && p.x1 !== p.x2 && p.y1 !== p.y2);
  assert.equal(sloped.length, 2, `V 字の斜線は 2 本: ${JSON.stringify(sloped)}`);
  assert.deepEqual([sloped[0].x2, sloped[0].y2], [sloped[1].x2, sloped[1].y2], '2 本は同じ頂点で出会う');
  return { x: sloped[0].x2, y: sloped[0].y2, latchX: sloped[0].x1 };
}
const outerRect = prims => prims.find(p => p.type === 'rect' && p.stroke == null && p.rx == null);

test('東面の窓: 位置（X＝u−uMin、u＝−y）と Y（GL 基準・上が負）に窓台高さ・建具高さが写る', () => {
  const { p1, graph, cl } = rectGraph();
  // 東の壁（x=4000・外向き+1）の y=1500 を中心に幅 1690、窓台 800・高さ 1170
  addOpening(graph, cl.x1, 1, cl.y0, 1500, 1690, WINDOW, { sillHeight: 800, height: 1170 });
  const east = faceOf(modelOf(p1, graph), FacadeDirection.EAST);
  assert.deepEqual(east.openingCounts, { drawn: 1, hidden: 0, noEntry: 0 });
  const r = outerRect(openingPrims(east));
  // 東面の u＝−y、uMin＝−(3000+57.5)。窓の u は −(1500+845)..−(1500−845) → X＝(−2345)−(−3057.5)＝712.5
  assert.equal(r.x, -(1500 + 845) + (3000 + FACE));
  assert.equal(r.w, 1690);
  // Y＝GL − z。上端 z＝800+1170 → Y＝−450−1970、高さ 1170
  assert.equal(r.y, GL - (800 + 1170));
  assert.equal(r.h, 1170);
  assert.ok(openingPrims(east).every(p => p.openingId != null), '建具ごとに openingId');
  // 他の面には出ない
  for (const dir of [FacadeDirection.SOUTH, FacadeDirection.WEST, FacadeDirection.NORTH]) {
    assert.equal(openingPrims(faceOf(modelOf(p1, graph), dir)).length, 0, dir);
  }
});

test('左右: 東面で吊元が南側（y 大＝u 小）の片開きドアは、吊元の V 字の頂点が図の左', () => {
  const { p1, graph, cl } = rectGraph();
  // 東の壁 y=1100..1900。hingeSide=+1＝coord2 側（y=1900＝南）
  addOpening(graph, cl.x1, 1, cl.y0, 1500, 800, DOOR, { height: 2000, hingeSide: 1 });
  const apex = veeApex(openingPrims(faceOf(modelOf(p1, graph), FacadeDirection.EAST)));
  // 吊元 y=1900 → u=−1900 → X＝−1900+3057.5
  assert.equal(apex.x, -1900 + 3000 + FACE);
  assert.ok(apex.x < apex.latchX, `吊元（頂点）が左: ${apex.x} < ${apex.latchX}`);
  assert.equal(apex.y, GL - 1000, '頂点は扉の高さの中ほど（FL+1000）');
});

// 4 面それぞれで、見る人の左手側に吊元があるドア（東＝南・南＝西・西＝北・北＝東）。頂点の X は手で書いた値。
const LEFT_HINGE_CASES = [
  // 東: x=4000 の壁・吊元 y=1900（南）。u＝−y、uMin＝−3057.5（鏡像あり）
  { dir: FacadeDirection.EAST,  axis: 'x1', side: 1,  ref: 'y0', center: 1500, hingeSide: 1,  apexX: -1900 + 3057.5 },
  // 南: y=3000 の壁・吊元 x=600（西）。u＝x、uMin＝−57.5（鏡像なし）
  { dir: FacadeDirection.SOUTH, axis: 'y1', side: 1,  ref: 'x0', center: 1000, hingeSide: -1, apexX: 600 + 57.5 },
  // 西: x=0 の壁・吊元 y=1100（北）。u＝y、uMin＝−57.5（鏡像なし）
  { dir: FacadeDirection.WEST,  axis: 'x0', side: -1, ref: 'y0', center: 1500, hingeSide: -1, apexX: 1100 + 57.5 },
  // 北: y=0 の壁・吊元 x=1400（東）。u＝−x、uMin＝−4057.5（鏡像あり）
  { dir: FacadeDirection.NORTH, axis: 'y0', side: -1, ref: 'x0', center: 1000, hingeSide: 1,  apexX: -1400 + 4057.5 },
];
for (const c of LEFT_HINGE_CASES) {
  test(`左右（4面の向きの固定）: ${c.dir} 面で見る人の左手側に吊元のドアは V 字の頂点が図の左（X=${c.apexX}）`, () => {
    const { p1, graph, cl } = rectGraph();
    addOpening(graph, cl[c.axis], c.side, cl[c.ref], c.center, 800, DOOR, { height: 2000, hingeSide: c.hingeSide });
    const face = faceOf(modelOf(p1, graph), c.dir);
    assert.equal(face.openingCounts.drawn, 1);
    const apex = veeApex(openingPrims(face));
    assert.equal(apex.x, c.apexX);
    assert.ok(apex.x < apex.latchX, `吊元が左: ${apex.x} < ${apex.latchX}`);
  });
}

test('対象外: 内壁の建具・外壁でも線分の範囲外の建具・wallSide が内側（室内側の壁）の建具は出ない', () => {
  const { p1, graph, cl } = rectGraph({ split: true });
  addOpening(graph, cl.xm, 1, cl.y0, 1500, 800, DOOR, { height: 2000 });          // 内壁（x=2000）
  addOpening(graph, cl.x1, 1, cl.y0, 3500, 800, DOOR, { height: 2000 });          // 東の壁の範囲（y −57.5..3057.5）の外
  addOpening(graph, cl.x1, -1, cl.y0, 1500, 800, DOOR, { height: 2000 });         // 東の通り芯の室内側
  const inputs = buildFacadeInputs([{ plane: p1, graph }], { glBelow1FlMm: GL_BELOW, planes: [p1] });
  assert.deepEqual(inputs.floors[0].openings, []);
  const model = buildFacadeModel(inputs);
  for (const face of model) {
    assert.equal(openingPrims(face).length, 0, face.direction);
    assert.deepEqual(face.openingCounts, { drawn: 0, hidden: 0, noEntry: 0 });
  }
  // 対照: 同じ東の壁の範囲内・外向きなら出る（上の 3 件が出ないのは判定のため）
  addOpening(graph, cl.x1, 1, cl.y0, 1500, 800, DOOR, { height: 2000 });
  assert.equal(faceOf(modelOf(p1, graph), FacadeDirection.EAST).openingCounts.drawn, 1);
});

test('三方枠（扉のない建具）: 枠の三方の線だけ（アキのバツ・文字なし）。内法は minFaceMm の 1px 保証に従う', () => {
  const { p1, graph, cl } = rectGraph();
  addOpening(graph, cl.y1, 1, cl.x0, 1000, 800, { category: OpeningCategory.FITTING, subType: 'threeSidedFrame' }, { height: 2000 });
  const prims = openingPrims(faceOf(modelOf(p1, graph, { minFaceMm: 50 }), FacadeDirection.SOUTH));
  assert.equal(prims.length, 6, JSON.stringify(prims));
  assert.ok(prims.every(p => p.type === 'line'), 'line だけ（text・バツの polyline なし）');
  // 南面 u＝x、uMin＝−57.5。内法の左竪は x=600 + max(見付20, 50)
  const xs = [...new Set(prims.flatMap(p => [p.x1, p.x2]))].sort((a, b) => a - b);
  assert.deepEqual(xs, [600 + FACE, 650 + FACE, 1350 + FACE, 1400 + FACE]);
});

// ---- 下屋の前の窓（2階建て＋下屋。facadeRoof.test.js の twoStoryLeanTo と同じ形） ----
function twoStoryLeanTo() {
  const project = new Project('proj', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const xs = [0, 3000, 6000, 9000], ys = [0, 4000, 6000];
  const floor = (id, elevation, startFloor, interior, roof) => {
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
    return { graph, cx, cy };
  };
  floor('p1', 0, 1, [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]);
  const f2 = floor('p2', 3000, 2, [[0, 0], [1, 0], [2, 0]], [[1, 1]]);
  return { project, ...f2 };
}

test('隠れ: 下屋の前の 2階の窓は、屋根面の取り合い（3582.75）より下なら出ない・上なら出る', () => {
  const { project, graph, cx, cy } = twoStoryLeanTo();
  // 2階の南の壁（y=4000・外向き+1）の x=4500（下屋の範囲 3000..6000 の中）
  addOpening(graph, cy[1], 1, cx[0], 4500, 800, WINDOW, { sillHeight: 0, height: 500 });     // z 3000..3500（取り合いより下）
  addOpening(graph, cy[1], 1, cx[0], 4500, 800, WINDOW, { sillHeight: 1000, height: 1000 }); // z 4000..5000（屋根の上）
  const floors = project.planes.map(plane => ({ plane, graph: project.graphMap.get(plane.id) }));
  const inputs = buildFacadeInputs(floors, project, { roofRegionsOf: facadeRoofRegionsResolver(project) });
  const south = faceOf(buildFacadeModel(inputs), FacadeDirection.SOUTH);
  assert.deepEqual(south.openingCounts, { drawn: 1, hidden: 1, noEntry: 0 });
  const r = outerRect(openingPrims(south));
  assert.equal(r.y, inputs.glZMm - 5000, '描かれたのは上の窓（上端 z=5000）');
});

// 下屋の前の 2階南面（取り合い 3582.75）の窓 1 枚の件数
function leanToSouthCounts(sillHeight, height) {
  const { project, graph, cx, cy } = twoStoryLeanTo();
  addOpening(graph, cy[1], 1, cx[0], 4500, 800, WINDOW, { sillHeight, height });
  const floors = project.planes.map(plane => ({ plane, graph: project.graphMap.get(plane.id) }));
  const inputs = buildFacadeInputs(floors, project, { roofRegionsOf: facadeRoofRegionsResolver(project) });
  return faceOf(buildFacadeModel(inputs), FacadeDirection.SOUTH).openingCounts;
}

test('隠れ: 下屋の取り合いをまたぐ窓で、中心は隠れ上の角が見えるものは描く', () => {
  // z 3000..3700。中心 3350 は取り合い（3582.75）より下＝隠れ、上の角 3700 は屋根より上＝見える
  assert.deepEqual(leanToSouthCounts(0, 700), { drawn: 1, hidden: 0, noEntry: 0 });
});

test('隠れ: 窓台で判定が変わる（窓台 500・高さ 200 は描く。窓台を無視すると全点が取り合いより下）', () => {
  // z 3500..3700。中心 3600・上の角 3700 は見え、下の角 3500 は隠れる。窓台 0 なら 3000..3200、高さを無視すると全点 3500＝全部隠れる
  assert.deepEqual(leanToSouthCounts(500, 200), { drawn: 1, hidden: 0, noEntry: 0 });
});

// 3×3（0..9000）。center='exterior' なら中央のセルを屋外部屋（中庭）、edge なら 2×1 の屋内の東に屋外部屋（テラス）。
function courtyardGraph(layout) {
  const p1 = plane('p1', 0, 1);
  const graph = new PlanGraph(p1);
  const cx = [0, 3000, 6000, 9000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const cy = [0, 3000, 6000, 9000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  const addExterior = (cells) => graph.addRoom(new Set(cells), '屋外').setKind(RoomKind.EXTERIOR);
  if (layout === 'center') {
    const ring = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== 1 || j !== 1) ring.push(cell(i, j));
    graph.addRoom(new Set(ring), '居間');
    addExterior([cell(1, 1)]);
  } else {
    graph.addRoom(new Set([cell(0, 0), cell(1, 0)]), '居間');
    addExterior([cell(2, 0)]);
  }
  generateExteriorWalls(graph);
  return { p1, graph, cx, cy };
}

test('中庭（courtyard）の外壁の建具は外周の包絡に隠れる。縁の屋外部屋に面する建具は見える', () => {
  // 中庭の北の辺（y=3000・外向き +1＝中庭側）の窓は南面を向くが、手前の外周の南の壁に隠れる
  const court = courtyardGraph('center');
  addOpening(court.graph, court.cy[1], 1, court.cx[0], 4500, 1690, WINDOW, { sillHeight: 800, height: 1170 });
  const courtInputs = buildFacadeInputs([{ plane: court.p1, graph: court.graph }], { glBelow1FlMm: GL_BELOW, planes: [court.p1] });
  assert.equal(courtInputs.floors[0].openings.length, 1, '前提: 中庭の建具は対象に入る');
  assert.equal(courtInputs.floors[0].openings[0].segment.loopType, 'courtyard', '前提: 中庭の線分に乗る');
  const south = faceOf(buildFacadeModel(courtInputs), FacadeDirection.SOUTH);
  assert.deepEqual(south.openingCounts, { drawn: 0, hidden: 1, noEntry: 0 });
  assert.equal(openingPrims(south).length, 0);
  // 対照: 屋内の東の屋外部屋（x=6000 の辺は courtyard だが外周に隠れない）に面する窓は東面に描く
  const edge = courtyardGraph('edge');
  addOpening(edge.graph, edge.cx[2], 1, edge.cy[0], 1500, 1690, WINDOW, { sillHeight: 800, height: 1170 });
  const edgeInputs = buildFacadeInputs([{ plane: edge.p1, graph: edge.graph }], { glBelow1FlMm: GL_BELOW, planes: [edge.p1] });
  assert.equal(edgeInputs.floors[0].openings[0].segment.loopType, 'courtyard', '前提: 屋外部屋に面する線分も courtyard');
  const east = faceOf(buildFacadeModel(edgeInputs), FacadeDirection.EAST);
  assert.deepEqual(east.openingCounts, { drawn: 1, hidden: 0, noEntry: 0 });
});

test('線分の境目に乗る建具は 1 回だけ描く', () => {
  // 屋内 x 0..6000 × y 0..3000。南の壁（y=3000）の下は x 0..3000 が無割当（outer）・x 3000..6000 が屋外部屋（courtyard）
  // ＝同じ軸・同じ外向きの線分が x=3000 付近で 2 本に割れる。
  const p1 = plane('p1', 0, 1);
  const graph = new PlanGraph(p1);
  const cx = [0, 3000, 6000].map(v => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH));
  const cy = [0, 3000, 6000].map(v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  graph.addRoom(new Set([cell(0, 0), cell(1, 0)]), '居間');
  graph.addRoom(new Set([cell(1, 1)]), '屋外').setKind(RoomKind.EXTERIOR);
  generateExteriorWalls(graph);
  const inputs0 = buildFacadeInputs([{ plane: p1, graph }], { glBelow1FlMm: GL_BELOW, planes: [p1] });
  const southSegs = inputs0.floors[0].segments.filter(s => !s.isVertical && s.outwardSign === 1);
  assert.equal(southSegs.length, 2, `前提: 南の壁が 2 本に割れている: ${JSON.stringify(southSegs)}`);
  const [first, second] = [...southSegs].sort((a, b) => a.lo - b.lo);
  const boundary = first.hi;
  assert.ok(boundary >= second.lo - 1e-6, `前提: 境目 ${boundary} が両方の線分の範囲に入る: ${JSON.stringify(southSegs)}`);
  addOpening(graph, cy[1], 1, cx[0], boundary, 800, DOOR, { height: 2000 });
  const inputs = buildFacadeInputs([{ plane: p1, graph }], { glBelow1FlMm: GL_BELOW, planes: [p1] });
  assert.equal(inputs.floors[0].openings.length, 1, '建具は 1 件（線分ごとに重複しない）');
  const south = faceOf(buildFacadeModel(inputs), FacadeDirection.SOUTH);
  assert.deepEqual(south.openingCounts, { drawn: 1, hidden: 0, noEntry: 0 });
  veeApex(openingPrims(south)); // V 字の斜線がちょうど 2 本（2 回描くと 4 本）
});

test('【失敗系】カタログに無い種別の建具は飛ばして noEntry に数える（例外なし）。他の建具は描く', () => {
  const { p1, graph, cl } = rectGraph();
  addOpening(graph, cl.x1, 1, cl.y0, 1000, 800, { category: OpeningCategory.FITTING, subType: 'noSuchType' }, { height: 2000 });
  addOpening(graph, cl.x1, 1, cl.y0, 2200, 800, DOOR, { height: 2000 });
  const east = faceOf(modelOf(p1, graph), FacadeDirection.EAST);
  assert.deepEqual(east.openingCounts, { drawn: 1, hidden: 0, noEntry: 1 });
  // entryOf の差し替え（null を返す）でも同じく飛ばす
  const none = faceOf(modelOf(p1, graph, { entryOf: () => null }), FacadeDirection.EAST);
  assert.deepEqual(none.openingCounts, { drawn: 0, hidden: 0, noEntry: 2 });
  assert.equal(openingPrims(none).length, 0);
});

test('【失敗系】graph.openings が空・undefined、floors に openings が無い入力でも例外なし（建具 0）', () => {
  assert.deepEqual(exteriorOpeningsOn(undefined, [], 0), []);
  assert.deepEqual(exteriorOpeningsOn([], [], 0), []);
  assert.deepEqual(exteriorOpeningsOn([{ axisCL: null }, { axisCL: { id: 'a' }, centerCoord: NaN }], [], 0), []);
  const { p1, graph } = rectGraph();
  const inputs = buildFacadeInputs([{ plane: p1, graph }], { glBelow1FlMm: GL_BELOW, planes: [p1] });
  assert.deepEqual(inputs.floors[0].openings, []);
  const legacy = { ...inputs, floors: inputs.floors.map(f => ({ ...f, openings: undefined })) };
  const view = facadeViews().find(v => v.direction === FacadeDirection.EAST);
  const out = buildFacadeOpenings(legacy, view, { uMin: 0, profiles: facadeFloorProfiles(legacy, view.normal) });
  assert.deepEqual(out, { primitives: [], counts: { drawn: 0, hidden: 0, noEntry: 0 } });
});

test('【失敗系】建具の読み取りが例外の階は skipped（ERROR）に載せ、壁は描く', () => {
  const { p1, graph, cl } = rectGraph();
  // 壊れた建具（中心座標の読み取りで例外。graph.openings は shapeMap の type で拾う）
  graph.shapeMap.set('bad', { id: 'bad', type: ShapeType.OPENING, axisCL: cl.x1, get centerCoord() { throw new Error('boom'); } });
  const inputs = buildFacadeInputs([{ plane: p1, graph }], { glBelow1FlMm: GL_BELOW, planes: [p1] });
  assert.equal(inputs.floors.length, 1, '壁は残る');
  assert.deepEqual(inputs.floors[0].openings, []);
  assert.ok(inputs.skipped.some(s => s.planeId === 'p1' && s.message === 'boom'), JSON.stringify(inputs.skipped));
});
