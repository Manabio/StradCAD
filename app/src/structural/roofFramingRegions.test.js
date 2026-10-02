// 小屋組を描く屋根の範囲（roofFramingRegions.js）のテスト。ステップ C3a。
//   region は「在来木造・範囲が矩形・形状が片流れ／切妻／寄棟」の屋根だけ。形状・範囲・高い側の判断は
//   既存の関数（mainRoof.js・roofDefaults.js・roofOrientation.js）を流用しているので、ここでは結果で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, Project, CenterLineType, Discipline, RoomKind, RoomFeature, RoofShape,
} from '@core';
import {
  mainRoofFramingRegion, leanToFramingRegions, roofFramingRegionsForFigure, roofFramingFigurePrimitives,
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

// ---- mainRoofFramingRegion ----

test('mainRoofFramingRegion: 在来・矩形・自動の形状。短手3640超は切妻（棟は長手方向。横長なら x 方向＝ridgeIsVertical false）', () => {
  assert.deepEqual(mainRoofFramingRegion(singleRoomGraph(9000, 6000), woodProject()), {
    key: 'main', rect: { x1: 0, y1: 0, x2: 9000, y2: 6000 }, shape: 'gable', ridgeIsVertical: false, highSide: null,
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
  });
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

test('【失敗系】mainRoofFramingRegion: 建物範囲が矩形でない（L字＝自動は寄棟）・空・graph 無しは null', () => {
  const project = woodProject();
  const l = buildRoofLayout('notch', 'none').graph;
  assert.equal(mainRoofFramingRegion(l, project), null, 'L字は後続ステップ');
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

test('leanToFramingRegions: 屋根が複数なら1部屋につき1つ。屋根でない部屋（屋内・屋外）は region にならない', () => {
  const { graph, interior, exterior, roof } = makeGrid(XS, YS);
  interior([[0, 0]]);
  exterior([[2, 0]]); // 屋根でない屋外部屋（テラス）
  const r1 = roof([[1, 1]]);
  const r2 = roof([[2, 2]]);
  const regions = leanToFramingRegions(graph, woodProject());
  assert.deepEqual(regions.map(r => r.key).sort(), [`lean:${r1.id}`, `lean:${r2.id}`].sort());
});

test('【失敗系】leanToFramingRegions: L字の下屋・陸屋根・棟違い（明示）は region にならない。屋根が無い階も空', () => {
  const l = makeGrid(XS, YS);
  l.roof([[1, 1], [2, 1], [1, 2]]); // L字
  assert.deepEqual(leanToFramingRegions(l.graph, woodProject()), []);
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
  assert.deepEqual(prims.find(p => p.kind === 'ridge').points, [0, 2940, 9000, 2940]);
});

test('roofFramingFigurePrimitives: 実体階の伏図は自階 graph の下屋（片流れ）。束は自階の梁が母屋と交わる所だけ', () => {
  const { graph, interior, roof } = makeGrid(XS, YS);
  interior([[0, 1]]);
  roof([[1, 1]]); // 2000×1500・高い側 left
  const prims = roofFramingFigurePrimitives({
    rules: WOOD, lod: LodLevel.DETAIL, isRoofPlane: false, subjectGraph: graph, topGraph: null, project: woodProject(),
  });
  assert.deepEqual(prims.map(p => [p.kind, ...p.points]), [
    ['purlin', 2455, 1500, 2455, 3000],
    ['purlin', 3365, 1500, 3365, 3000],
  ], '片流れ left: 高い側（x=2000）から幅2000は455始まり（残り635）の x=2455・3365。梁が無いので束なし');
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
