// 小屋組を描く屋根の範囲（roofFramingRegions.js）のテスト。ステップ C3a。
//   region は「在来木造・範囲が矩形・形状が片流れ／切妻／寄棟」の屋根だけ。形状・範囲・高い側の判断は
//   既存の関数（mainRoof.js・roofDefaults.js・roofOrientation.js）を流用しているので、ここでは結果で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape,
} from '@core';
import {
  mainRoofFramingRegion, leanToFramingRegions, leanToFramingCellKeys, leanToFraming, roofFramingRegionsForFigure, roofFramingFigurePrimitives,
  leanToPlanRegions,
} from './roofFramingRegions.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { createLeanToRoofSpec } from '../finish/roof/roofDefaults.js';
import { buildRoofLayout } from '../finish/roofTestFixtures.js';
import { LodLevel } from '../viewport.js';
import { autorun } from 'mobx';
import { graphComputed } from '../renderer/graphDerived.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const WOOD = rulesFor(TRADITIONAL_WOOD_STRUCTURE);

function woodProject(structure = TRADITIONAL_WOOD_STRUCTURE) {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = structure;
  return project;
}

/** 屋内の1部屋（幅 w × 奥行 h）だけの階（最上階を想定）。 */
function singleRoomGraph(w, h) {
  const graph = new PlanGraph(new Plane('p1', 0, '3階', 3, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH, 'x0');
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, w, ARCH, 'x1');
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH, 'y0');
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, h, ARCH, 'y1');
  graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), '居間');
  return graph;
}

/** 格子 xs × ys の階。cell(i,j) は左 i 列・上 j 行のセル。 */
function makeGrid(xs, ys) {
  const graph = new PlanGraph(new Plane('p2', 0, '2階', 2, 1));
  const cx = xs.map((v, i) => graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH, `x${i}`));
  const cy = ys.map((v, j) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH, `y${j}`));
  const cell = (i, j) => `${cx[i].id}:${cy[j].id}:${cx[i + 1].id}:${cy[j + 1].id}`;
  const interior = cells => graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '居間');
  const exterior = cells => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), 'テラス');
    room.setKind(RoomKind.EXTERIOR);
    return room;
  };
  const roof = cells => {
    const room = graph.addRoom(new Set(cells.map(([i, j]) => cell(i, j))), '屋根');
    room.setKind(RoomKind.EXTERIOR);
    room.setFeature(RoomFeature.ROOF);
    room.setRoofSpec(createLeanToRoofSpec());
    return room;
  };
  return { graph, interior, exterior, roof };
}

const XS = [0, 2000, 4000, 6000];
const YS = [0, 1500, 3000, 4500];

/** 外形線の辺の部分（roofOutline の edges）の期待値。 */
const E = (isVertical, coord, lo, hi, outward, overhangMm) => ({ isVertical, coord, lo, hi, outward, overhangMm });

// ---- mainRoofFramingRegion ----

test('mainRoofFramingRegion: 在来・矩形・自動の形状。短手3640超は切妻（棟は長手方向。横長なら x 方向＝ridgeIsVertical false）', () => {
  // D1: region は外形線（edges・outline）を持つ。既定の出幅は軒・妻側とも 455。期待値に項目を足した（既存の項目の assert は同じ）
  assert.deepEqual(mainRoofFramingRegion(singleRoomGraph(9000, 6000), woodProject()), {
    key: 'main', rect: { x1: 0, y1: 0, x2: 9000, y2: 6000 }, shape: 'gable', ridgeIsVertical: false, highSide: null,
    edges: [E(false, 0, 0, 9000, -1, 455), E(true, 9000, 0, 6000, 1, 455), E(false, 6000, 0, 9000, 1, 455), E(true, 0, 0, 6000, -1, 455)],
    outline: [{ points: [9455, -455, 9455, 6455, -455, 6455, -455, -455] }],
  });
  assert.equal(mainRoofFramingRegion(singleRoomGraph(6000, 9000), woodProject()).ridgeIsVertical, true, '縦長は y 方向の棟');
});

test('mainRoofFramingRegion: 片流れ（短手3640以下）の高い側は既定（横長=上・縦長=左）。明示値が優先（highSide の解決）', () => {
  const project = woodProject();
  assert.equal(mainRoofFramingRegion(singleRoomGraph(9000, 3000), project).shape, RoofShape.MONO);
  assert.equal(mainRoofFramingRegion(singleRoomGraph(9000, 3000), project).highSide, 'top');
  assert.equal(mainRoofFramingRegion(singleRoomGraph(3000, 3500), project).highSide, 'left');
  const g = singleRoomGraph(9000, 3000);
  g.mainRoofSpec.setField('highSide', 'right');
  assert.equal(mainRoofFramingRegion(g, project).highSide, 'right');
});

test('mainRoofFramingRegion: 形状の明示値（寄棟・切妻）はそのまま。切妻・寄棟では highSide は null', () => {
  const project = woodProject();
  const hip = singleRoomGraph(9000, 3000);
  hip.mainRoofSpec.setField('shape', RoofShape.HIP);
  hip.mainRoofSpec.setField('highSide', 'left'); // 明示値があっても片流れ以外は使わない
  assert.deepEqual(mainRoofFramingRegion(hip, project), {
    key: 'main', rect: { x1: 0, y1: 0, x2: 9000, y2: 3000 }, shape: 'hip', ridgeIsVertical: false, highSide: null,
    edges: [E(false, 0, 0, 9000, -1, 455), E(true, 9000, 0, 3000, 1, 455), E(false, 3000, 0, 9000, 1, 455), E(true, 0, 0, 3000, -1, 455)],
    outline: [{ points: [9455, -455, 9455, 3455, -455, 3455, -455, -455] }],
  });
});

test('【C2e-1c】mainRoofFramingRegion: 切妻の棟木の向きは ridgeDirection が指定されていればそれ（横長でも縦・縦長でも横）。未指定は長手', () => {
  const project = woodProject();
  const wide = singleRoomGraph(9000, 6000);
  assert.equal(mainRoofFramingRegion(wide, project).ridgeIsVertical, false, '自動・横長');
  wide.mainRoofSpec.setField('ridgeDirection', 'vertical');
  const r = mainRoofFramingRegion(wide, project);
  assert.equal(r.shape, 'gable');
  assert.equal(r.ridgeIsVertical, true, '横長でも縦を指定');
  wide.mainRoofSpec.setField('ridgeDirection', 'horizontal');
  assert.equal(mainRoofFramingRegion(wide, project).ridgeIsVertical, false);
  const tall = singleRoomGraph(6000, 9000);
  tall.mainRoofSpec.setField('ridgeDirection', 'horizontal');
  assert.equal(mainRoofFramingRegion(tall, project).ridgeIsVertical, false, '縦長でも横を指定');
  tall.mainRoofSpec.setField('ridgeDirection', null);
  assert.equal(mainRoofFramingRegion(tall, project).ridgeIsVertical, true, '自動へ戻すと長手');
});

test('【C2e-1c・失敗系】mainRoofFramingRegion: ridgeDirection は切妻だけに効く。寄棟・片流れでは指定を無視して長手（region.ridgeIsVertical は変わらない）', () => {
  const project = woodProject();
  const hip = singleRoomGraph(9000, 6000);
  hip.mainRoofSpec.setField('shape', RoofShape.HIP);
  hip.mainRoofSpec.setField('ridgeDirection', 'vertical');
  assert.equal(mainRoofFramingRegion(hip, project).ridgeIsVertical, false, '寄棟・横長');
  const mono = singleRoomGraph(9000, 3000);
  mono.mainRoofSpec.setField('ridgeDirection', 'vertical');
  const m = mainRoofFramingRegion(mono, project);
  assert.equal(m.shape, 'mono');
  assert.equal(m.ridgeIsVertical, false, '片流れ・横長');
});

test('【失敗系】mainRoofFramingRegion: 陸屋根・棟違い（明示）は小屋組を持たず null', () => {
  const project = woodProject();
  for (const shape of [RoofShape.FLAT, RoofShape.STAGGERED]) {
    const g = singleRoomGraph(9000, 6000);
    g.mainRoofSpec.setField('shape', shape);
    assert.equal(mainRoofFramingRegion(g, project), null, shape);
  }
});

test('【失敗系】mainRoofFramingRegion: 非在来（RC・S・SRC・2×4・未定・未知）は null。階ごとの上書きで非在来なら null', () => {
  const g = singleRoomGraph(9000, 6000);
  for (const key of ['RC造(ラーメン)', 'RC造(壁式)', 'S造', 'SRC造', '木造（2"×4"）', UNSPECIFIED_STRUCTURE, 'no-such-structure']) {
    assert.equal(mainRoofFramingRegion(g, woodProject(key)), null, key);
  }
  assert.equal(mainRoofFramingRegion(g, null), null, 'project 無し（主構造が引けない）');
  const over = singleRoomGraph(9000, 6000);
  over.setStructureOverride('S造');
  assert.equal(mainRoofFramingRegion(over, woodProject()), null, '階の上書きが S造');
});

const byPos = (a, b) => a.y1 - b.y1 || a.x1 - b.x1;

test('【C2e-2】mainRoofFramingRegion: 建物範囲が矩形でない（L字＝自動は寄棟）は rect:null・rects＝セル矩形の region（描画のみ）', () => {
  const project = woodProject();
  const l = buildRoofLayout('notch', 'none').graph;
  const region = mainRoofFramingRegion(l, project);
  assert.deepEqual({ ...region, rects: [...region.rects].sort(byPos) }, {
    key: 'main', rect: null,
    rects: [
      { x1: 0, y1: 0, x2: 2000, y2: 1500 }, { x1: 2000, y1: 0, x2: 4000, y2: 1500 }, { x1: 0, y1: 1500, x2: 2000, y2: 3000 },
    ],
    shape: 'hip', ridgeIsVertical: null, highSide: null,
    // D1: 矩形でない寄棟も外形線を持つ（入隅 (2455,1955) を結ぶ6頂点）
    edges: [
      E(false, 0, 0, 4000, -1, 455), E(true, 4000, 0, 1500, 1, 455), E(false, 1500, 2000, 4000, 1, 455),
      E(true, 2000, 1500, 3000, 1, 455), E(false, 3000, 0, 2000, 1, 455), E(true, 0, 0, 3000, -1, 455),
    ],
    outline: [{ points: [4455, -455, 4455, 1955, 2455, 1955, 2455, 3455, -455, 3455, -455, -455] }],
  });
  // rects は graph のセル（mainRoofBounds）の写し。graph 側のオブジェクトを共有しない（書き換えても graph は不変）
  region.rects[0].x1 = -1;
  assert.deepEqual(mainRoofFramingRegion(l, project).rects.map(r => r.x1).sort((a, b) => a - b), [0, 0, 2000]);
  // 寄棟を明示しても同じ
  l.mainRoofSpec.setField('shape', RoofShape.HIP);
  assert.equal(mainRoofFramingRegion(l, project).shape, 'hip');
});

test('【C2e-2・失敗系】mainRoofFramingRegion: 矩形でない建物範囲は寄棟のときだけ。切妻・片流れ・陸屋根・棟違い（明示）・非在来は null', () => {
  const project = woodProject();
  for (const shape of [RoofShape.GABLE, RoofShape.MONO, RoofShape.FLAT, RoofShape.STAGGERED]) {
    const l = buildRoofLayout('notch', 'none').graph;
    l.mainRoofSpec.setField('shape', shape);
    assert.equal(mainRoofFramingRegion(l, project), null, shape);
  }
  const l = buildRoofLayout('notch', 'none').graph;
  for (const key of ['RC造(ラーメン)', 'S造', '木造（2"×4"）', UNSPECIFIED_STRUCTURE]) {
    assert.equal(mainRoofFramingRegion(l, woodProject(key)), null, key);
  }
  l.setStructureOverride('S造');
  assert.equal(mainRoofFramingRegion(l, project), null, '階の上書きが S造');
});

// E1b: L字の下屋は「翼ごとの片流れ」の region になる（C2e-2 の「region にならない」から変更）。E2b: 描画用の leanToFramingRegions だけでなく
// 構造側の leanToFraming・leanToFramingCellKeys も L字を含む（外周の梁・床梁のガード・小屋梁が同じ region を使う）。
test('【E1b・E2b】L字の下屋（屋内に接しない。形6）は翼2つの region（rect:null・shape:mono）。外形線は全辺 455。構造側（leanToFraming・leanToFramingCellKeys）にも同じ region・全セルが入る', () => {
  const l = makeGrid(XS, YS);
  const r = l.roof([[1, 1], [2, 1], [1, 2]]); // L字の下屋。外接 4000×3000（横長）→ 仮の壁は上（y=1500）
  const project = woodProject();
  const rects = [{ x1: 2000, y1: 1500, x2: 4000, y2: 3000 }, { x1: 4000, y1: 1500, x2: 6000, y2: 3000 }, { x1: 2000, y1: 3000, x2: 4000, y2: 4500 }];
  assert.deepEqual(leanToFramingRegions(l.graph, project), [{
    key: `lean:${r.id}`, rect: null, rects, shape: 'mono', ridgeIsVertical: null, highSide: null,
    leanToWings: [
      { highSide: 'top', wallCoord: 1500, wallEdge: { isVertical: false, coord: 1500, lo: 2000, hi: 4000, outward: -1 }, depthMm: 3000,
        rect: { x1: 2000, y1: 1500, x2: 4000, y2: 4500 }, domain: [{ x1: 2000, y1: 1500, x2: 4000, y2: 4500, entry: 'direct' }] },
      { highSide: 'top', wallCoord: 1500, wallEdge: { isVertical: false, coord: 1500, lo: 4000, hi: 6000, outward: -1 }, depthMm: 1500,
        rect: { x1: 4000, y1: 1500, x2: 6000, y2: 3000 }, domain: [{ x1: 4000, y1: 1500, x2: 6000, y2: 3000, entry: 'direct' }] },
    ],
    leanToUnassigned: [],
    // 水下（流れの先の辺。深い翼の下辺 y=4500 と浅い翼の下辺 y=3000）と、母屋の段の基準（長手方向の翼＝水下が同長なら番号の小さい翼の奥行き 3000）
    leanToDrains: [{ isVertical: false, coord: 3000, lo: 4000, hi: 6000, outward: 1 }, { isVertical: false, coord: 4500, lo: 2000, hi: 4000, outward: 1 }],
    leanToPurlinDepthMm: 3000,
    // 屋内に接しないので出幅 0 の区間は無い。上の辺は軒・左右の縦の辺はけらば（既定は同じ 455）
    edges: [E(false, 1500, 2000, 6000, -1, 455), E(true, 6000, 1500, 3000, 1, 455), E(false, 3000, 4000, 6000, 1, 455),
      E(true, 4000, 3000, 4500, 1, 455), E(false, 4500, 2000, 4000, 1, 455), E(true, 2000, 1500, 4500, -1, 455)],
    outline: [{ points: [6455, 1045, 6455, 3455, 4455, 3455, 4455, 4955, 1545, 4955, 1545, 1045] }],
  }]);
  // E2b で書き換え（旧: size 0・regions []。L字は構造側に入らなかった）。構造側は region と全3セルを持つ。
  assert.equal(leanToFramingCellKeys(l.graph, project).size, 3, 'L字の3セルは小屋組の対象セル（自階単独ゲート・床梁のガードが効く）');
  assert.deepEqual([...new Set(leanToFramingCellKeys(l.graph, project).values())], [`lean:${r.id}`], 'セルの値は region の key');
  const both = leanToFraming(l.graph, project);
  assert.deepEqual(both.regions, leanToFramingRegions(l.graph, project), 'L字は構造側の region にも入る（描画と同じ）');
  assert.deepEqual([...both.cellKeys], [...leanToFramingCellKeys(l.graph, project)]);
});

test('【E1b】L字の下屋が屋内に接する（形1a。出隅の回り込み）: 壁ごとの翼2つ・継ぎ目の延長を持つ。屋内に接する2辺は出幅 0・外形線は段差の無い6頂点', () => {
  const { graph, interior, roof } = makeGrid([0, 3640, 5460], [0, 3640, 5460]);
  interior([[0, 0]]);
  const r = roof([[0, 1], [1, 1], [1, 0]]); // 屋内（左上）を下・右から回り込む L字
  const [region] = leanToFramingRegions(graph, woodProject());
  assert.equal(region.key, `lean:${r.id}`);
  assert.equal(region.rect, null);
  assert.deepEqual(region.leanToWings.map(w => [w.highSide, w.wallCoord, w.depthMm]), [['top', 3640, 1820], ['left', 3640, 1820]], '壁の長さが同じ→上が先');
  assert.deepEqual(region.leanToWings.map(w => w.domain.map(d => d.entry)), [['direct', 'left'], ['direct', 'top']], '入隅の角のセルは両方の翼の延長');
  assert.deepEqual(region.leanToUnassigned, []);
  assert.deepEqual(region.outline, [{ points: [5915, -455, 5915, 5915, -455, 5915, -455, 3640, 3640, 3640, 3640, -455] }]);
  assert.deepEqual(region.edges.filter(e => e.overhangMm === 0).map(e => [e.isVertical, e.coord, e.lo, e.hi]), [[false, 3640, 0, 3640], [true, 3640, 0, 3640]], '屋内に接する辺だけ出幅 0');
});

test('【E1b・失敗系】L字の下屋のうち、形状が自動で切妻になる（短手3640超）・明示の寄棟・陸屋根・棟違いは region にならない。非在来も空', () => {
  const big = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  big.roof([[0, 0], [1, 0], [0, 1]]); // 外接 8000×8000 の L字。自動の形状は切妻
  assert.deepEqual(leanToFramingRegions(big.graph, woodProject()), [], '自動が切妻の L字');
  for (const shape of [RoofShape.HIP, RoofShape.GABLE, RoofShape.FLAT, RoofShape.STAGGERED]) {
    const l = makeGrid(XS, YS);
    l.roof([[1, 1], [2, 1], [1, 2]]).roofSpec.setField('shape', shape);
    assert.deepEqual(leanToFramingRegions(l.graph, woodProject()), [], `明示の ${shape}`);
  }
  const l = makeGrid(XS, YS);
  l.roof([[1, 1], [2, 1], [1, 2]]);
  for (const key of ['RC造(ラーメン)', 'S造', UNSPECIFIED_STRUCTURE]) assert.deepEqual(leanToFramingRegions(l.graph, woodProject(key)), [], key);
  assert.equal(leanToFramingRegions(l.graph, woodProject()).length, 1, '前提: 在来なら region がある');
});

test('【E1b】L字の下屋は明示の highSide を使わない（翼ごとに壁で決まる）', () => {
  const l = makeGrid(XS, YS);
  const r = l.roof([[1, 1], [2, 1], [1, 2]]);
  const before = leanToFramingRegions(l.graph, woodProject());
  r.roofSpec.setField('highSide', 'bottom');
  assert.deepEqual(leanToFramingRegions(l.graph, woodProject()), before);
  assert.equal(before[0].highSide, null);
});

test('【失敗系】mainRoofFramingRegion: 空・graph 無しは null', () => {
  const project = woodProject();
  assert.equal(mainRoofFramingRegion(new PlanGraph(new Plane('p1', 0, '3階', 3, 1)), project), null, '部屋が無い');
  assert.equal(mainRoofFramingRegion(null, project), null);
  assert.equal(mainRoofFramingRegion(undefined, project), null);
});

// ---- leanToFramingRegions ----

test('leanToFramingRegions: 屋内に接する辺が高い側（片流れ）。key は部屋 id、棟は短手3640以下なので無し', () => {
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]); // 屋根の左に屋内
  const r = roof([[1, 1]]); // 2000×1500
  assert.deepEqual(leanToFramingRegions(graph, woodProject()), [{
    key: `lean:${r.id}`, rect: { x1: 2000, y1: 1500, x2: 4000, y2: 3000 }, shape: 'mono', ridgeIsVertical: false, highSide: 'left',
    // D1: 屋内に接する左の辺は出幅 0（壁に当たる）。片流れ left は縦の辺が軒・横の辺がけらば（既定は同じ 455）
    edges: [E(false, 1500, 2000, 4000, -1, 455), E(true, 4000, 1500, 3000, 1, 455), E(false, 3000, 2000, 4000, 1, 455), E(true, 2000, 1500, 3000, -1, 0)],
    outline: [{ points: [4455, 1045, 4455, 3455, 2000, 3455, 2000, 1045] }],
  }]);
});

test('leanToFramingRegions: 屋内に接しない下屋は長手に平行な辺の小さい側（横長=上）。明示の highSide が優先', () => {
  const { graph, roof } = makeGrid(XS, YS);
  const r = roof([[1, 1], [2, 1]]); // 4000×1500 横長
  assert.equal(leanToFramingRegions(graph, woodProject())[0].highSide, 'top');
  r.roofSpec.setField('highSide', 'bottom');
  assert.equal(leanToFramingRegions(graph, woodProject())[0].highSide, 'bottom');
});

test('leanToFramingRegions: 短手が3640超の下屋は切妻（正方形は棟が x 方向）。明示の寄棟もそのまま', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const r = roof([[0, 0], [1, 0], [0, 1], [1, 1]]); // 8000×8000
  const [region] = leanToFramingRegions(graph, woodProject());
  assert.equal(region.shape, 'gable');
  assert.equal(region.ridgeIsVertical, false);
  assert.equal(region.highSide, null);
  r.roofSpec.setField('shape', RoofShape.HIP);
  assert.equal(leanToFramingRegions(graph, woodProject())[0].shape, 'hip');
});

test('【C2e-1c】leanToFramingRegions: 切妻の下屋は ridgeDirection に従う。寄棟の下屋は指定を無視する', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const r = roof([[0, 0], [1, 0], [0, 1], [1, 1]]); // 8000×8000（正方形。自動の切妻は棟が x 方向）
  r.roofSpec.setField('ridgeDirection', 'vertical');
  const [g] = leanToFramingRegions(graph, woodProject());
  assert.equal(g.shape, 'gable');
  assert.equal(g.ridgeIsVertical, true, '正方形でも縦を指定');
  r.roofSpec.setField('shape', RoofShape.HIP);
  const [h] = leanToFramingRegions(graph, woodProject());
  assert.equal(h.shape, 'hip');
  assert.equal(h.ridgeIsVertical, false, '寄棟は指定を無視（長手＝正方形は横）');
});

test('leanToFramingRegions: 屋根が複数なら1部屋につき1つ。屋根でない部屋（屋内・屋外）は region にならない', () => {
  const { graph, interior, exterior, roof } = makeGrid(XS, YS);
  interior([[0, 0]]);
  exterior([[2, 0]]); // 屋根でない屋外部屋（テラス）
  const r1 = roof([[1, 1]]);
  const r2 = roof([[2, 2]]);
  const regions = leanToFramingRegions(graph, woodProject());
  assert.deepEqual(regions.map(r => r.key).sort(), [`lean:${r1.id}`, `lean:${r2.id}`].sort());
});

test('【失敗系】leanToFramingRegions: 陸屋根・棟違い（明示）は region にならない。屋根が無い階も空（L字の下屋は E1b から別のテスト）', () => {
  for (const shape of [RoofShape.FLAT, RoofShape.STAGGERED]) {
    const g = makeGrid(XS, YS);
    g.roof([[1, 1]]).roofSpec.setField('shape', shape);
    assert.deepEqual(leanToFramingRegions(g.graph, woodProject()), [], shape);
  }
  assert.deepEqual(leanToFramingRegions(makeGrid(XS, YS).graph, woodProject()), [], '屋根なし');
});

test('【失敗系】leanToFramingRegions: 非在来・project 無し・graph 無しは空', () => {
  const { graph, roof } = makeGrid(XS, YS);
  roof([[1, 1]]);
  for (const key of ['RC造(ラーメン)', 'S造', '木造（2"×4"）', UNSPECIFIED_STRUCTURE]) {
    assert.deepEqual(leanToFramingRegions(graph, woodProject(key)), [], key);
  }
  assert.deepEqual(leanToFramingRegions(graph, null), []);
  assert.deepEqual(leanToFramingRegions(null, woodProject()), []);
});

// ---- 屋根の外形線（軒先・けらば。ステップ D1） ----

test('【D1】mainRoofFramingRegion: 明示の出幅（軒 600・妻側 300）が edges・outline に効く。切妻の棟木の向きを変えると軒とけらばが入れ替わる', () => {
  const project = woodProject();
  const g = singleRoomGraph(9000, 6000); // 自動の切妻・棟は横（x 方向）
  g.mainRoofSpec.setField('eaveOverhangMm', 600);
  g.mainRoofSpec.setField('gableOverhangMm', 300);
  const h = mainRoofFramingRegion(g, project);
  assert.deepEqual(h.edges, [E(false, 0, 0, 9000, -1, 600), E(true, 9000, 0, 6000, 1, 300), E(false, 6000, 0, 9000, 1, 600), E(true, 0, 0, 6000, -1, 300)]);
  assert.deepEqual(h.outline, [{ points: [9300, -600, 9300, 6600, -300, 6600, -300, -600] }]);
  g.mainRoofSpec.setField('ridgeDirection', 'vertical'); // 棟を縦にすると縦の辺が軒
  const v = mainRoofFramingRegion(g, project);
  assert.deepEqual(v.edges, [E(false, 0, 0, 9000, -1, 300), E(true, 9000, 0, 6000, 1, 600), E(false, 6000, 0, 9000, 1, 300), E(true, 0, 0, 6000, -1, 600)]);
  assert.deepEqual(v.outline, [{ points: [9600, -300, 9600, 6300, -600, 6300, -600, -300] }]);
});

test('【D1】mainRoofFramingRegion: 片流れは高い側の指定で軒の辺が決まる。寄棟（矩形）は全辺が軒', () => {
  const project = woodProject();
  const mono = singleRoomGraph(9000, 3000);
  mono.mainRoofSpec.setField('eaveOverhangMm', 600);
  mono.mainRoofSpec.setField('gableOverhangMm', 300);
  mono.mainRoofSpec.setField('highSide', 'right'); // 縦の辺が軒（600）・横の辺がけらば（300）
  assert.deepEqual(mainRoofFramingRegion(mono, project).outline, [{ points: [9600, -300, 9600, 3300, -600, 3300, -600, -300] }]);
  const hip = singleRoomGraph(9000, 3000);
  hip.mainRoofSpec.setField('shape', RoofShape.HIP);
  hip.mainRoofSpec.setField('eaveOverhangMm', 600);
  hip.mainRoofSpec.setField('gableOverhangMm', 300); // 寄棟には妻が無いので効かない
  assert.deepEqual(mainRoofFramingRegion(hip, project).outline, [{ points: [9600, -600, 9600, 3600, -600, 3600, -600, -600] }]);
});

test('【D1・失敗系】mainRoofFramingRegion: 出幅が負・NaN の spec は既定値（455）で描く（例外にしない）。0 は正当で外形線＝屋根範囲', () => {
  const project = woodProject();
  const g = singleRoomGraph(9000, 6000);
  g.mainRoofSpec.eaveOverhangMm = -5;
  g.mainRoofSpec.gableOverhangMm = NaN;
  assert.deepEqual(mainRoofFramingRegion(g, project).outline, [{ points: [9455, -455, 9455, 6455, -455, 6455, -455, -455] }]);
  g.mainRoofSpec.eaveOverhangMm = 0;
  g.mainRoofSpec.gableOverhangMm = 0;
  assert.deepEqual(mainRoofFramingRegion(g, project).outline, [{ points: [9000, 0, 9000, 6000, 0, 6000, 0, 0] }]);
});

test('【D1】leanToFramingRegions: 下屋の辺が一部だけ屋内に接するとき、接する部分だけ出幅 0（辺を分けて段差）。接しない下屋は全辺に出幅', () => {
  const project = woodProject();
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]); // x 0..2000・y 1500..3000。屋根（2000..6000 × 1500..3000）の左の辺 x=2000 に全体で接する
  const r = roof([[1, 1], [2, 1]]);
  r.roofSpec.setField('shape', RoofShape.HIP);
  r.roofSpec.setField('eaveOverhangMm', 600);
  const [full] = leanToFramingRegions(graph, project);
  assert.deepEqual(full.edges.filter(e => e.overhangMm === 0), [E(true, 2000, 1500, 3000, -1, 0)], '左の辺だけ 0');
  // 屋内を上の段へ移すと、屋根（2000..6000 × 1500..3000）の上の辺 y=1500 のうち x 0..4000 と重なる 2000..4000 だけが接する
  const g2 = makeGrid(XS, YS);
  g2.interior([[1, 0]]); // x 2000..4000・y 0..1500（屋根の上の辺の左半分に接する）
  const r2 = g2.roof([[1, 1], [2, 1]]);
  r2.roofSpec.setField('shape', RoofShape.HIP);
  r2.roofSpec.setField('eaveOverhangMm', 600);
  const [part] = leanToFramingRegions(g2.graph, project);
  assert.deepEqual(part.edges, [
    E(false, 1500, 2000, 4000, -1, 0), E(false, 1500, 4000, 6000, -1, 600), // 上の辺: 屋内に接する 2000..4000 は 0、残りは 600
    E(true, 6000, 1500, 3000, 1, 600), E(false, 3000, 2000, 6000, 1, 600), E(true, 2000, 1500, 3000, -1, 600),
  ]);
  // 段差: 屋内に接する 2000..4000 は y=1500（出幅 0）、残りは y=900（600 外へ）。x=4000 で小辺が挿入される
  assert.deepEqual(part.outline, [{ points: [4000, 1500, 4000, 900, 6600, 900, 6600, 3600, 1400, 3600, 1400, 1500] }]);
});

test('【D1】leanToFramingRegions: 屋内に接しない下屋は全辺に出幅。切妻の下屋は棟木の向きで軒・けらばが入れ替わる', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const r = roof([[0, 0], [1, 0], [0, 1], [1, 1]]); // 8000×8000（自動の切妻・棟は横）
  r.roofSpec.setField('eaveOverhangMm', 600);
  r.roofSpec.setField('gableOverhangMm', 300);
  const project = woodProject();
  assert.deepEqual(leanToFramingRegions(graph, project)[0].outline, [{ points: [8300, -600, 8300, 8600, -300, 8600, -300, -600] }]);
  r.roofSpec.setField('ridgeDirection', 'vertical');
  assert.deepEqual(leanToFramingRegions(graph, project)[0].outline, [{ points: [8600, -300, 8600, 8300, -600, 8300, -600, -300] }]);
});

// ---- roofFramingRegionsForFigure（どの伏図にどの region が載るか） ----

test('roofFramingRegionsForFigure: 屋根専用平面は最上階の graph から主屋根だけ。実体階の伏図は自階の graph から下屋だけ', () => {
  const project = woodProject();
  const top = singleRoomGraph(9000, 6000);
  const { graph: lean, roof } = makeGrid(XS, YS);
  const r = roof([[1, 1]]);
  const onRoofPlane = roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: lean, topGraph: top, project });
  assert.deepEqual(onRoofPlane.map(x => x.key), ['main'], '屋根専用平面に下屋は載せない（subjectGraph に屋根セルがあっても）');
  const onFloor = roofFramingRegionsForFigure({ isRoofPlane: false, subjectGraph: lean, topGraph: top, project });
  assert.deepEqual(onFloor.map(x => x.key), [`lean:${r.id}`], '実体階の伏図に主屋根は載せない（topGraph があっても）');
});

test('【失敗系】roofFramingRegionsForFigure: 屋根専用平面で最上階の graph が無い・主屋根が region でないなら空', () => {
  const project = woodProject();
  assert.deepEqual(roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: null, topGraph: null, project }), []);
  const flat = singleRoomGraph(9000, 6000);
  flat.mainRoofSpec.setField('shape', RoofShape.FLAT);
  assert.deepEqual(roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: null, topGraph: flat, project }), []);
  assert.deepEqual(roofFramingRegionsForFigure({ isRoofPlane: false, subjectGraph: null, topGraph: null, project }), []);
});

test('【M8・T1】roofFramingRegionsForFigure: 屋根専用平面では、最上階 graph が屋内部屋＋矩形の下屋（片流れ）を持っていても下屋は載らず、主屋根の key だけ', () => {
  const project = woodProject();
  const { graph: top, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]);
  const r = roof([[1, 1]]);
  assert.deepEqual(leanToFramingRegions(top, project).map(x => x.key), [`lean:${r.id}`], '前提: この graph 単体なら下屋の region が出る');
  const regions = roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: { beams: [] }, topGraph: top, project });
  assert.deepEqual(regions.map(x => x.key), ['main']);
});

// ---- region の導出の memo 化（T5。StructuralLayer は graphComputed を渡す） ----

/** graphComputed を包んで「実際に compute が走った回数」を数える memo。 */
function countingMemo() {
  const state = { calls: 0 };
  state.memo = (graph, key, compute) => graphComputed(graph, key, () => { state.calls++; return compute(); });
  return state;
}

test('【T5】region の導出（主屋根）: 同じ graph で2回呼んでも再計算せず同じインスタンス。屋根の入力を変えると再計算される', () => {
  const project = woodProject();
  const top = singleRoomGraph(9000, 6000);
  const spy = countingMemo();
  let last;
  const dispose = autorun(() => { last = roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: null, topGraph: top, project, memo: spy.memo }); });
  try {
    assert.equal(spy.calls, 1);
    assert.equal(last[0].shape, 'gable');
    const again = roofFramingRegionsForFigure({ isRoofPlane: true, subjectGraph: null, topGraph: top, project, memo: spy.memo });
    assert.equal(spy.calls, 1, '2回目は再計算しない');
    assert.equal(again, last, '同じインスタンス');
    // 屋根の入力（mainRoofSpec の項目）
    top.mainRoofSpec.setField('shape', RoofShape.HIP);
    assert.equal(spy.calls, 2);
    assert.equal(last[0].shape, 'hip');
    // 主構造の変更（project.structuralInfo）
    project.structuralInfo.mainStructure = 'S造';
    assert.equal(spy.calls, 3);
    assert.deepEqual(last, []);
    project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
    assert.equal(spy.calls, 4);
    // 階ごとの主構造の上書き
    top.setStructureOverride('S造');
    assert.equal(spy.calls, 5);
    assert.deepEqual(last, []);
    top.setStructureOverride(null);
    assert.equal(spy.calls, 6);
    // 建物範囲の変更（通り芯＝中心線の移動・部屋の追加）
    const x1 = top.centerLines.find(c => c.centerLineType === CenterLineType.VERTICAL && c.value === 9000);
    x1.value = 12000;
    assert.equal(spy.calls, 7, '中心線の移動に追随する');
    assert.deepEqual(last[0].rect, { x1: 0, y1: 0, x2: 12000, y2: 6000 });
  } finally { dispose(); }
});

test('【T5】region の導出（下屋）: 同じ graph で2回呼んでも再計算せず、屋根セルの追加・屋根の項目・部屋の変更で再計算される', () => {
  const project = woodProject();
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]);
  const r1 = roof([[1, 1]]);
  const spy = countingMemo();
  let last;
  const run = () => roofFramingRegionsForFigure({ isRoofPlane: false, subjectGraph: graph, topGraph: null, project, memo: spy.memo });
  const dispose = autorun(() => { last = run(); });
  try {
    assert.equal(spy.calls, 1);
    assert.equal(run(), last, '2回目は再計算せず同じインスタンス');
    assert.equal(spy.calls, 1);
    r1.roofSpec.setField('highSide', 'right');
    assert.equal(spy.calls, 2);
    assert.equal(last[0].highSide, 'right');
    roof([[2, 2]]); // addRoom・setKind・setFeature・setRoofSpec の各書込みで再計算が走る（バッチしない）
    assert.ok(spy.calls > 2, '屋根セル（屋根の部屋）の追加で再計算される');
    assert.equal(last.length, 2, '追加した屋根の region が出る');
  } finally { dispose(); }
});

// ---- roofFramingFigurePrimitives ----

const POISON = { get rooms() { throw new Error('graph を読んではいけない'); }, get beams() { throw new Error('graph を読んではいけない'); } };

test('roofFramingFigurePrimitives: 小屋伏図（屋根専用平面）は最上階の主屋根の棟木2本＋母屋6本、束は軒桁（subject の primary 梁）との交点', () => {
  const top = singleRoomGraph(9000, 6000); // 切妻・棟は y=3000 の x 方向
  // 棟・母屋は x 方向の線なので、直交する縦の梁（x=0 の壁線の通し梁）との交点に束が立つ
  const eaves = { role: 'primary', materialType: 'WOOD', isVertical: true, axisValue: 0, clStart: { effectiveValue: 0 }, clEnd: { effectiveValue: 6000 } };
  const floorBeam = { ...eaves, role: 'floor', axisValue: 4500 };
  const prims = roofFramingFigurePrimitives({
    rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: true,
    subjectGraph: { beams: [eaves, floorBeam] }, topGraph: top, project: woodProject(),
  });
  const count = kind => prims.filter(p => p.kind === kind).length;
  assert.equal(count('ridge'), 2);
  assert.equal(count('purlin'), 6, '半スパン3000は455始まり（残り725）で棟から両側に3本ずつ');
  const struts = prims.filter(p => p.kind === 'strut');
  assert.equal(struts.length, 7, '壁線梁 x=0 と棟木1・母屋6 の交点。床梁 x=4500 には立たない');
  assert.ok(struts.every(s => s.x === 0 && s.radius === 45));
  assert.deepEqual(struts.map(s => s.y),
    [725, 1635, 2545, 3000, 3455, 4365, 5275], '棟 y=3000 から 455・1365・2275');
  // D2: 棟木・母屋の端はけらば（縦の辺 x=0・9000）の出幅 455 ぶん外形線まで延びる。束の位置（上）は延長前の線のまま
  assert.deepEqual(prims.find(p => p.kind === 'ridge').points, [-455, 2940, 9455, 2940]);
  assert.deepEqual(prims.find(p => p.kind === 'purlin').points, [-455, 725, 9455, 725]);
});

test('roofFramingFigurePrimitives: 実体階の伏図は自階 graph の下屋（片流れ）。束は自階の梁が母屋と交わる所だけ', () => {
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]);
  roof([[1, 1]]); // 2000×1500・高い側 left
  const prims = roofFramingFigurePrimitives({
    rules: WOOD, lod: LodLevel.DETAIL, isRoofPlane: false, subjectGraph: graph, topGraph: null, project: woodProject(),
  });
  assert.deepEqual(prims.map(p => [p.kind, ...p.points]), [
    ['purlin', 2455, 1045, 2455, 3455], // D2: けらば（横の辺）の出幅 455 ぶん外形線まで延びる
    ['purlin', 3365, 1045, 3365, 3455],
    // D1: 屋根の外形線（左の辺は屋内に接するので出幅 0）。母屋・束の数は変わらない
    ['outline', 4455, 1045, 4455, 3455, 2000, 3455, 2000, 1045],
  ], '片流れ left: 高い側（x=2000）から幅2000は455始まり（残り635）の x=2455・3365。梁が無いので束なし');
  assert.ok(prims.filter(p => p.kind === 'outline').every(p => p.closed === true && p.key.includes(':outline:')));
});

test('【失敗系】roofFramingFigurePrimitives: 略図・非在来は graph を一切読まずに空（region 導出を省く）', () => {
  for (const [rules, lod] of [
    [WOOD, LodLevel.SCHEMATIC],
    [rulesFor('S造'), LodLevel.STANDARD],
    [rulesFor('RC造(ラーメン)'), LodLevel.DETAIL],
    [rulesFor('木造（2"×4"）'), LodLevel.STANDARD],
    [rulesFor(UNSPECIFIED_STRUCTURE), LodLevel.STANDARD],
  ]) {
    assert.deepEqual(roofFramingFigurePrimitives({
      rules, lod, isRoofPlane: true, subjectGraph: POISON, topGraph: POISON, project: woodProject(),
    }), [], `${rules.key}/${lod}`);
  }
});

test('【失敗系】roofFramingFigurePrimitives: subject の graph が無い・屋根が無い階・主屋根が陸屋根なら空', () => {
  const project = woodProject();
  assert.deepEqual(roofFramingFigurePrimitives({ rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: true, subjectGraph: null, topGraph: singleRoomGraph(9000, 6000), project }), []);
  assert.deepEqual(roofFramingFigurePrimitives({ rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: false, subjectGraph: makeGrid(XS, YS).graph, topGraph: null, project }), []);
  const flat = singleRoomGraph(9000, 6000);
  flat.mainRoofSpec.setField('shape', RoofShape.FLAT);
  assert.deepEqual(roofFramingFigurePrimitives({ rules: WOOD, lod: LodLevel.STANDARD, isRoofPlane: true, subjectGraph: { beams: [] }, topGraph: flat, project }), []);
});

// ---- leanToPlanRegions（下屋の平面表示。ステップ1。構造ゲートなし・補完 region あり） ----

/** 平面用 region から平面専用の項目（exposedPaths・slope・zeroZones）を除いたもの＝伏図用 region と同じ幾何のはず。 */
const withoutPlanFields = region => {
  const rest = { ...region };
  delete rest.exposedPaths;
  delete rest.slope;
  delete rest.zeroZones;
  return rest;
};

test('【平面】leanToPlanRegions: 木造の矩形の下屋は leanToFramingRegions と同じ幾何に、exposedPaths（屋内に接する辺を除いた外形線）と slope が加わる', () => {
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]); // 屋根（x 2000..6000・y 1500..3000）の左の辺 x=2000 に全体で接する
  roof([[1, 1], [2, 1]]);
  const project = woodProject();
  const framing = leanToFramingRegions(graph, project);
  const before = JSON.parse(JSON.stringify(framing));
  const plan = leanToPlanRegions(graph);
  assert.equal(plan.length, 1);
  assert.deepEqual(withoutPlanFields(plan[0]), framing[0], '伏図用と同じ幾何（key・rect・shape・highSide・edges・outline）');
  assert.equal(plan[0].shape, 'mono');
  assert.equal(plan[0].highSide, 'left', '屋内に接する辺が高い側');
  assert.equal(plan[0].slope, 3, 'slope は roofSpec.slope（既定 3）');
  // 左の辺（出幅 0＝壁の中）を除いた開いた1本。上下はけらば・右は軒（既定は同じ 455）
  assert.deepEqual(plan[0].exposedPaths, [{ points: [2000, 1045, 6455, 1045, 6455, 3455, 2000, 3455], closed: false }]);
  assert.deepEqual(leanToFramingRegions(graph, project), before, '平面用の導出は伏図用の結果を変えない（exposedPaths・slope を伏図用 region に足さない）');
  assert.ok(!('exposedPaths' in framing[0]) && !('slope' in framing[0]) && !('zeroZones' in framing[0]));
  // 平面用 region は屋内に接する区間（壁に当たる線の端を外壁面で止める roofPlanWallTrim.js が使う）を持つ
  assert.deepEqual(plan[0].zeroZones, [{ isVertical: true, coord: 2000, lo: 1500, hi: 3000, outward: -1 }]);
});

test('【平面】leanToPlanRegions: 屋内に接しない下屋は外形線が closed の1本。切妻の矩形は木造と同じ region', () => {
  const { graph, roof } = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  const r = roof([[0, 0], [1, 0], [0, 1], [1, 1]]); // 8000×8000（自動の切妻・棟は横）
  r.roofSpec.setField('slope', 4.5);
  const [plan] = leanToPlanRegions(graph);
  assert.deepEqual(withoutPlanFields(plan), leanToFramingRegions(graph, woodProject())[0]);
  assert.equal(plan.shape, 'gable');
  assert.equal(plan.slope, 4.5);
  assert.deepEqual(plan.exposedPaths, [{ points: [8455, -455, 8455, 8455, -455, 8455, -455, -455], closed: true }]);
});

test('【平面】leanToPlanRegions: S造・RC造・未定でも出る（project 不要）。伏図側のゲートは今までどおり S造・未定で leanToFramingRegions・leanToFramingCellKeys・leanToFraming が空', () => {
  const { graph, roof } = makeGrid(XS, YS);
  roof([[1, 1], [2, 1]]);
  assert.equal(leanToPlanRegions(graph).length, 1, '構造種別に関わらず出る');
  assert.equal(leanToFramingRegions(graph, woodProject()).length, 1, '前提: 在来なら伏図側も region がある');
  for (const key of ['S造', 'RC造(ラーメン)', UNSPECIFIED_STRUCTURE]) {
    const project = woodProject(key);
    assert.deepEqual(leanToFramingRegions(graph, project), [], `leanToFramingRegions ${key}`);
    assert.equal(leanToFramingCellKeys(graph, project).size, 0, `leanToFramingCellKeys ${key}`);
    const both = leanToFraming(graph, project);
    assert.deepEqual(both.regions, [], `leanToFraming.regions ${key}`);
    assert.equal(both.cellKeys.size, 0, `leanToFraming.cellKeys ${key}`);
  }
  assert.deepEqual(leanToFramingRegions(graph, null), [], 'project 無しの伏図側は空（今までどおり）');
});

test('【平面】leanToPlanRegions: 陸屋根は軒先の線だけ（全辺軒）。屋内に接する部分は出幅 0 で線を描かない。伏図側は region なし', () => {
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]);
  roof([[1, 1], [2, 1]]).roofSpec.setField('shape', RoofShape.FLAT);
  const [plan] = leanToPlanRegions(graph);
  assert.equal(plan.shape, 'flat');
  assert.deepEqual(plan.rect, { x1: 2000, y1: 1500, x2: 6000, y2: 3000 });
  assert.deepEqual(plan.exposedPaths, [{ points: [2000, 1045, 6455, 1045, 6455, 3455, 2000, 3455], closed: false }], '全辺 455（軒）。左は壁に接して除く');
  assert.deepEqual(plan.edges.filter(e => e.overhangMm === 0).map(e => [e.isVertical, e.coord]), [[true, 2000]]);
  assert.deepEqual(leanToFramingRegions(graph, woodProject()), [], '伏図側は陸屋根を region にしない（不変）');
});

test('【平面】leanToPlanRegions: 陸屋根の L字も軒先の線だけ（rects・屋内に接しなければ closed）', () => {
  const { graph, roof } = makeGrid(XS, YS);
  roof([[1, 1], [2, 1], [1, 2]]).roofSpec.setField('shape', RoofShape.FLAT);
  const [plan] = leanToPlanRegions(graph);
  assert.equal(plan.rect, null);
  assert.equal(plan.rects.length, 3);
  assert.equal(plan.exposedPaths.length, 1);
  assert.equal(plan.exposedPaths[0].closed, true);
  assert.deepEqual(plan.exposedPaths[0].points, [6455, 1045, 6455, 3455, 4455, 3455, 4455, 4955, 1545, 4955, 1545, 1045], '全辺 455 の閉路（L字の6頂点）');
});

test('【平面】leanToPlanRegions: 切妻になる L字（自動で短手3640超・明示の切妻）と棟違いは暫定で外形線だけ（翼・棟木の導出なし）。伏図側は region なし', () => {
  const big = makeGrid([0, 4000, 8000], [0, 4000, 8000]);
  big.roof([[0, 0], [1, 0], [0, 1]]); // 外接 8000×8000 の L字。自動の形状は切妻
  const [auto] = leanToPlanRegions(big.graph);
  assert.equal(auto.shape, 'gable');
  assert.equal(auto.rect, null);
  assert.equal(auto.leanToWings, undefined, '翼は作らない');
  assert.equal(auto.exposedPaths.length, 1);
  assert.equal(auto.exposedPaths[0].closed, true);
  assert.deepEqual(leanToFramingRegions(big.graph, woodProject()), []);
  for (const shape of [RoofShape.GABLE, RoofShape.STAGGERED]) {
    const l = makeGrid(XS, YS);
    l.roof([[1, 1], [2, 1], [1, 2]]).roofSpec.setField('shape', shape);
    const [plan] = leanToPlanRegions(l.graph);
    assert.equal(plan.shape, shape);
    assert.equal(plan.exposedPaths.length, 1, `明示の ${shape}（L字）`);
  }
  const rect = makeGrid(XS, YS);
  rect.roof([[1, 1], [2, 1]]).roofSpec.setField('shape', RoofShape.STAGGERED);
  const [stag] = leanToPlanRegions(rect.graph);
  assert.equal(stag.shape, 'staggered');
  assert.deepEqual(stag.exposedPaths, [{ points: [6455, 1045, 6455, 3455, 1545, 3455, 1545, 1045], closed: true }], '棟違い（矩形）は全辺軒の閉路');
});

test('【平面】leanToPlanRegions: 明示の寄棟の L字は rect:null・rects の寄棟 region。伏図側は region なし', () => {
  const l = makeGrid(XS, YS);
  l.roof([[1, 1], [2, 1], [1, 2]]).roofSpec.setField('shape', RoofShape.HIP);
  const [plan] = leanToPlanRegions(l.graph);
  assert.equal(plan.shape, 'hip');
  assert.equal(plan.rect, null);
  assert.deepEqual(plan.rects, [{ x1: 2000, y1: 1500, x2: 4000, y2: 3000 }, { x1: 4000, y1: 1500, x2: 6000, y2: 3000 }, { x1: 2000, y1: 3000, x2: 4000, y2: 4500 }]);
  assert.equal(plan.ridgeIsVertical, null);
  assert.equal(plan.highSide, null);
  assert.deepEqual(plan.exposedPaths, [{ points: [6455, 1045, 6455, 3455, 4455, 3455, 4455, 4955, 1545, 4955, 1545, 1045], closed: true }]);
  assert.deepEqual(leanToFramingRegions(l.graph, woodProject()), []);
});

test('【平面・失敗系】leanToPlanRegions: 範囲が空・不正（セルが解決できない）・roofSpec が null・屋根でない部屋・graph 無しは出ない', () => {
  assert.deepEqual(leanToPlanRegions(null), []);
  assert.deepEqual(leanToPlanRegions(undefined), []);
  const none = makeGrid(XS, YS);
  none.interior([[0, 0]]);
  none.exterior([[1, 1]]);
  assert.deepEqual(leanToPlanRegions(none.graph), [], '屋根でない部屋（屋内・屋外）は出ない');
  const bad = makeGrid(XS, YS);
  const room = bad.roof([[1, 1]]);
  room.cells.clear();
  room.cells.add('no:such:cell:key');
  assert.deepEqual(leanToPlanRegions(bad.graph), [], 'セルが解決できない屋根は何も描かない');
  const nullSpec = makeGrid(XS, YS);
  nullSpec.roof([[1, 1]]).setRoofSpec(null);
  assert.deepEqual(leanToPlanRegions(nullSpec.graph), [], 'roofSpec が null（I1 違反）は出ない');
});

test('【平面】leanToPlanRegions: 屋根が複数なら部屋ごとに1つ（key は部屋 id）', () => {
  const g = makeGrid(XS, YS);
  const a = g.roof([[0, 0]]);
  const b = g.roof([[2, 2]]);
  assert.deepEqual(leanToPlanRegions(g.graph).map(r => r.key), [`lean:${a.id}`, `lean:${b.id}`]);
});
