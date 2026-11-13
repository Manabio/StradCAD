// columnLongPress.js（柱の長クリック: 判定 resolveColumnLongPress・確定 runColumnMenuAction）のテスト。
// 実 PlanGraph・実 composition（structuralFigure.js の図面定義から FigureBindingManager.activate と同じ手順で組む）・
// 実 Viewport の scale で呼ぶ。fixture は原点から離し、scale は縦横で非対称（0.04/0.05）。
// 柱・graph・CL は循環参照を持つため assert.equal に渡さない（assert.ok(a === b) か id で比べる）。
// .jsx/store.js/snap.js は import しない（閾値 8 は呼び出し側が CL_THRESHOLD_PX を渡す想定の引数値）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType, OpeningCategory, centerLineKind, columnSlotKey, DimensionKind, DimensionSide, HDimensionLine, VDimensionLine } from '../core.js';
import { ColumnMenuItemId } from '../core/constants.js';
import { PLACED_FIGURE_MODE_IDS } from '../core/placedFigureModes.js';
import { ERR_COLUMN_ADD_ABORTED, ERR_COLUMN_DEL_ABORTED } from '../error.js';
import { runInAction } from 'mobx';
import { Viewport } from '../viewport.js';
import { findNearestCenterLineEndpointWithDist } from '../snapGeometry.js';
import { hitTestKinds } from '../core/centerLineKindPolicy.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { undoManager } from '../undoManager.js';
import { serializeGraph } from '../graphSnapshot.js';
import { FigureComposition } from '../figure/FigureBindingManager.js';
import { resolveSourcePlanes } from '../figure/figureTypes.js';
import { getFigure } from '../figure/figureRegistry.js';
import { STRUCTURAL_FIGURE_ID } from '../structural/structuralFigure.js';
import { TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from '../structural/structureRules.js';
import { resolveColumnEditTarget, resolveColumnSlot } from '../structural/columnEditTarget.js';
import { FIGURE_TYPE } from '../structural/structuralClassification.js';
import { deleteCenterLineWithUndo } from '../transform/centerLineOps.js';
import { recomputeStructuralForGraph } from '../structural/structuralRecompute.js';
import { autoFillWallBeamAxes, selfWallSegments } from '../structural/wallBeamAxes.js';
import { renumberMembers } from '../structural/memberNumbering.js';
import { resolveColumnLongPress, runColumnMenuAction } from './columnLongPress.js';
import { columnAtPoint, isInsideColumnRect } from './columnPick.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const TH = 8;                 // 呼び出し側が渡す CL_THRESHOLD_PX 相当
const SX = 0.04, SY = 0.05;   // 非対称（8px＝200mm／160mm）
const BIG = 'STEEL-H400x400'; // 半幅 200
const WOOD_120 = 'WOOD-120x120';

let originalPeek;
beforeEach(() => {
  originalPeek = floorSwapManager.peek;
  floorSwapManager.peek = async () => null;
  undoManager._undoStack.splice(0);
  undoManager._redoStack.splice(0);
});
afterEach(() => { floorSwapManager.peek = originalPeek; });

// 1階・2階。通り芯は structGraph（x 1300/5300・y 2700/6700）。structure は両階の実効主構造。
function makeEnv(structure = 'S造') {
  const project = new Project('proj', 'test');
  const f1 = project.addPlane(0, '1階', 'p1');
  const f2 = project.addPlane(2800, '2階', 'p2', 2, 1);
  f1.graph.structureOverride = structure;
  f2.graph.structureOverride = structure;
  const sg = project.structGraph;
  const gx = [1300, 5300].map(v => sg.addCenterLine(V, v, { labeled: true, discipline: Discipline.STRUCT }));
  const gy = [2700, 6700].map(v => sg.addCenterLine(H, v, { labeled: true, discipline: Discipline.STRUCT }));
  return { project, f1, f2, gx, gy };
}
function composeStructural(project, subject, graphOf) {
  const def = getFigure(STRUCTURAL_FIGURE_ID);
  const comp = new FigureComposition(def, subject.plane);
  const byPlaneId = new Map();
  for (const spec of def.layers) {
    for (const plane of resolveSourcePlanes(spec.source, subject.plane, project)) {
      let binding = byPlaneId.get(plane.id);
      if (!binding) {
        binding = { plane, graph: graphOf[plane.id], roles: new Set() };
        byPlaneId.set(plane.id, binding);
        comp.bindings.push(binding);
      }
      binding.roles.add(spec.role);
      comp.layers.push({ spec, binding });
    }
  }
  return comp;
}
const addCol = (graph, vCL, hCL, props = {}) => graph.addColumn(StructuralMaterialType.STEEL, BIG, vCL, hCL, props);
const press = (env, appMode, wx, wy, extra = {}) => resolveColumnLongPress({
  appMode, activeGraph: env.f1.graph, composition: null, project: env.project,
  world: { x: wx, y: wy }, scaleX: SX, scaleY: SY, thresholdPx: TH, endpointDistPx: null, openingHit: false, ...extra,
});
const sameObj = (a, b, msg) => assert.ok(a === b, msg);
// 柱・slot・graph を含む結果を assert.equal に渡すと、失敗時に actual が巨大オブジェクトになり node:test が際限なく
// メモリを確保する——null との比較も assert.ok(x === null) で書く（メッセージにもオブジェクトを埋めない）。
const isNull = (v, msg = 'null のはず') => assert.ok(v === null, msg);

// ---- 平面 ----
test('【長クリック・平面】柱の断面内→column（slot なし・addable 偽）', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  const r = press(env, 'floorplan', 1300 + 150, 2700 - 100);
  sameObj(r.column, c, '断面内の柱');
  isNull(r.slot);
  assert.equal(r.addable, false);
  sameObj(r.graph, env.f1.graph);
});

test('【長クリック・平面】交点（柱なし）→slot・addable 真。柱がある交点は柱が優先', () => {
  const env = makeEnv();
  const r = press(env, 'floorplan', 5300 + 50, 6700 - 40);
  isNull(r.column);
  assert.equal(r.slot.vCL.id, env.gx[1].id);
  assert.equal(r.slot.hCL.id, env.gy[1].id);
  assert.equal(r.slot.x, 5300);
  assert.equal(r.slot.y, 6700);
  assert.equal(r.addable, true);
  const c = addCol(env.f1.graph, env.gx[1], env.gy[1]);
  const r2 = press(env, 'floorplan', 5300, 6700);
  sameObj(r2.column, c, '柱と交点が同時に当たるときは柱');
  isNull(r2.slot);
});

test('【長クリック・平面】CL 上だが交点でない・空白→column も slot も null（従来のメニューへ）', () => {
  const env = makeEnv();
  for (const [x, y] of [[1300, 4000], [3300, 4700]]) {
    const r = press(env, 'floorplan', x, y);
    assert.ok(r !== null);
    isNull(r.column);
    isNull(r.slot);
    assert.equal(r.addable, false);
  }
});

test('【長クリック・平面】平面の候補は通り芯＋中心線: 中心線の交点は slot・補助線の交点は slot にならない', () => {
  const env = makeEnv();
  const g = env.f1.graph;
  const center = g.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH });
  const aux = g.addCenterLine(V, 4300, { labeled: false, lineType: 'dashed' });
  const r = press(env, 'floorplan', 3300, 2700);
  assert.equal(r.slot.vCL.id, center.id);
  assert.equal(r.slot.hCL.id, env.gy[0].id);
  isNull(press(env, 'floorplan', aux.value, 2700).slot, '補助線の交点は候補外');
});

test('【長クリック・平面】交点に既存柱のキーがあれば（矩形から外れていても）slot.occupied 真・addable 偽', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[1], env.gy[0], { eccentricity: { x: 500, y: 0 } });
  assert.equal(c.x, 5800, '前提: 矩形は交点 x=5300 を含まない');
  const r = press(env, 'floorplan', 5300, 2700);
  isNull(r.column);
  assert.equal(r.slot.occupied, true);
  assert.equal(r.addable, false);
});

test('【長クリック・平面】主構造が未確定・柱を持たない主構造なら addable 偽（slot は返る）', () => {
  for (const structure of [UNSPECIFIED_STRUCTURE, 'RC造(壁式)']) {
    const env = makeEnv(structure);
    const r = press(env, 'floorplan', 1300, 2700);
    assert.ok(r.slot, `${structure}: slot は返る`);
    assert.equal(r.addable, false, `${structure}: 追加不可`);
  }
});

test('【長クリック・閾値】thresholdPx は引数どおり: 4 なら 交点から 6px は slot なし・3px は slot あり（定数 8 に置き換わらない）', () => {
  const env = makeEnv();
  const at = dx => press(env, 'floorplan', 5300 + dx, 6700, { thresholdPx: 4 });
  isNull(at(150).slot, '150mm×0.04=6px ≥ 4');
  assert.ok(at(75).slot, '75mm×0.04=3px < 4');
  assert.ok(press(env, 'floorplan', 5300 + 150, 6700).slot, '閾値 8 なら 6px は slot（対照）');
});

test('【長クリック・閾値】柱の最小の当たり幅も thresholdPx: 4 なら 中心から 100mm（4px）まで。90mm は柱・110mm は柱でも交点でもない', () => {
  const env = makeEnv();
  const c = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[0], env.gy[0], {}); // 半幅 60mm
  const at = dx => press(env, 'floorplan', c.x + dx, c.y, { thresholdPx: 4 });
  sameObj(at(90).column, c, '90mm×0.04=3.6px < 4');
  const far = at(110);
  isNull(far.column, '110mm=4.4px ≥ 4');
  isNull(far.slot);
  sameObj(press(env, 'floorplan', c.x + 110, c.y).column, c, '閾値 8 なら 110mm は柱（対照）');
});

test('【長クリック・scale】x は scaleX・y は scaleY で画面距離にする（0.04/0.05）: 交点から x に 180mm（7.2px）は slot・y に 180mm（9px）は null', () => {
  const env = makeEnv();
  assert.ok(press(env, 'floorplan', 5300 + 180, 6700).slot, 'x 方向 7.2px < 8');
  isNull(press(env, 'floorplan', 5300, 6700 + 180).slot, 'y 方向 9px ≥ 8');
});

test('【長クリック・scale】柱の最小の当たり幅も軸ごとの scale: 半幅 60mm の柱は x に 180mm（200mm まで広がる）は柱・y に 180mm（160mm まで）は柱でない', () => {
  const env = makeEnv();
  const c = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[1], env.gy[1], {});
  sameObj(press(env, 'floorplan', c.x + 180, c.y).column, c);
  isNull(press(env, 'floorplan', c.x, c.y + 180).column);
});

test('【長クリック・本番の形】実 Viewport の scale（1/100）と閾値 8px で、交点から 150mm 離れた点も slot（実 graph.columns を使う）', () => {
  const env = makeEnv();
  const vp = new Viewport(1000, 800);
  const reach = TH / vp.scaleX;
  assert.ok(reach > 150, '前提: 閾値 8px は 150mm より大きい');
  const r = resolveColumnLongPress({
    appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project,
    world: { x: 1300 + 150, y: 2700 }, scaleX: vp.scaleX, scaleY: vp.scaleY, thresholdPx: TH, endpointDistPx: null, openingHit: false,
  });
  assert.equal(r.slot.vCL.id, env.gx[0].id);
  assert.equal(r.addable, true);
});

// ---- 構造 ----
test('【長クリック・構造・非在来】編集先は 1 つ下の階の graph: その階の柱・通り芯の交点に当たる（自階の柱には当たらない）', () => {
  const env = makeEnv('S造');
  const comp = composeStructural(env.project, env.f2, { p1: env.f1.graph, p2: env.f2.graph });
  const lower = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  addCol(env.f2.graph, env.gx[1], env.gy[1]); // 自階の柱は編集先ではない
  const common = { appMode: 'structure', activeGraph: env.f2.graph, composition: comp, project: env.project, scaleX: SX, scaleY: SY, thresholdPx: TH, endpointDistPx: null, openingHit: false };
  const hit = resolveColumnLongPress({ ...common, world: { x: 1300, y: 2700 } });
  sameObj(hit.graph, env.f1.graph, '編集先は下階');
  sameObj(hit.column, lower);
  const slot = resolveColumnLongPress({ ...common, world: { x: 5300, y: 2700 } });
  sameObj(slot.graph, env.f1.graph);
  assert.equal(slot.slot.vCL.id, env.gx[1].id);
  assert.equal(slot.addable, true);
  const own = resolveColumnLongPress({ ...common, world: { x: 5300, y: 6700 } });
  isNull(own.column, '自階の柱（下階の編集先には描かれない）には当たらない');
  assert.equal(own.slot.occupied, false, '下階の graph では空き');
  // 梁芯は非在来の候補にならない
  env.f1.graph.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.FUSE });
  isNull(resolveColumnLongPress({ ...common, world: { x: 3300, y: 2700 } }).slot);
});

test('【長クリック・構造・在来木造】編集先は自階の graph: 梁芯と通り芯の交点が slot（下階柱には当たらない）', () => {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const comp = composeStructural(env.project, env.f2, { p1: env.f1.graph, p2: env.f2.graph });
  const beam = env.f2.graph.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.FUSE });
  const below = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[0], env.gy[0], {});
  const common = { appMode: 'structure', activeGraph: env.f2.graph, composition: comp, project: env.project, scaleX: SX, scaleY: SY, thresholdPx: TH, endpointDistPx: null, openingHit: false };
  const r = resolveColumnLongPress({ ...common, world: { x: 3300, y: 2700 } });
  sameObj(r.graph, env.f2.graph, '在来木造の編集先は自階');
  assert.equal(r.slot.vCL.id, beam.id);
  assert.equal(r.addable, true);
  isNull(resolveColumnLongPress({ ...common, world: { x: 1300, y: 2700 } }).column, '下階柱（×で描かれる）は自階の編集先の柱ではない');
  sameObj(below.verticalCL, env.gx[0]);
});

test('【長クリック・構造】基礎伏図（非在来の最下階）・他のモードは null', () => {
  const env = makeEnv('S造');
  const comp1 = composeStructural(env.project, env.f1, { p1: env.f1.graph, p2: env.f2.graph });
  isNull(resolveColumnLongPress({
    appMode: 'structure', activeGraph: env.f1.graph, composition: comp1, project: env.project,
    world: { x: 1300, y: 2700 }, scaleX: SX, scaleY: SY, thresholdPx: TH, endpointDistPx: null, openingHit: false,
  }), '基礎伏図');
  // 図面モード（姿図配置モード）の id も null＝manualColumnAnchorLines（未対応 appMode で投げる）まで届かない
  for (const appMode of ['finish', 'ceiling', 'opening', 'site', 'elevation', 'facade', ...PLACED_FIGURE_MODE_IDS]) {
    isNull(press(env, appMode, 1300, 2700), appMode);
  }
});

// 在来木造の 1階: 基礎伏図（柱を描かない）では柱の断面内も CL の交点も押しても柱の編集対象にしない（描いていない部材は操作させない）
const viewOf = (planeId, figureType) => Object.freeze({ slotKey: `slot:${figureType}`, planeId, figureType });
function woodFoundationEnv() {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const comp = composeStructural(env.project, env.f1, { p1: env.f1.graph, p2: env.f2.graph });
  const col = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[0], env.gy[0], {});
  const common = { appMode: 'structure', activeGraph: env.f1.graph, composition: comp, project: env.project, scaleX: SX, scaleY: SY, thresholdPx: TH, endpointDistPx: null, openingHit: false };
  return { env, col, common };
}

test('【長クリック・構造・見せ分け】基礎伏図では柱の断面内も CL の交点も null。1階伏図・view なしは従来どおり（柱／slot）', () => {
  const { env, col, common } = woodFoundationEnv();
  const foundation = viewOf(env.f1.plane.id, FIGURE_TYPE.FOUNDATION);
  const above = viewOf(env.f1.plane.id, FIGURE_TYPE.ABOVEGROUND);
  const onColumn = { x: col.x, y: col.y }, onCrossing = { x: 5300, y: 6700 };
  isNull(resolveColumnLongPress({ ...common, world: onColumn, slotView: foundation }), '基礎伏図・柱の断面内');
  isNull(resolveColumnLongPress({ ...common, world: onCrossing, slotView: foundation }), '基礎伏図・CL の交点');
  for (const [label, slotView] of [['1階伏図', above], ['view なし', null], ['view 省略', undefined]]) {
    sameObj(resolveColumnLongPress({ ...common, world: onColumn, slotView })?.column, col, `${label}・柱`);
    const r = resolveColumnLongPress({ ...common, world: onCrossing, slotView });
    assert.equal(r?.slot?.vCL?.id, env.gx[1].id, `${label}・slot`);
  }
});

test('【長クリック・構造・見せ分け】別平面の view は掛けない（2階の基礎伏図 view でも 1階が編集先なら従来どおり）', () => {
  const { env, col, common } = woodFoundationEnv();
  sameObj(resolveColumnLongPress({ ...common, world: { x: col.x, y: col.y }, slotView: viewOf(env.f2.plane.id, FIGURE_TYPE.FOUNDATION) })?.column, col);
});

// 長クリック（1階伏図）からメニュー選択までの間に基礎伏図へ切り替わった: 選択時の再解決（App.jsx handleMenuSelect と同じ手順）で
// 編集先が null になり中止する。対照として、1階伏図のまま選べば削除できる（同じ fixture・同じ柱。view だけが違う）。
test('【確定・見せ分け】1階伏図で長クリック→基礎伏図へ切替→削除を選ぶと中止（柱は残る）。切り替えなければ削除できる', () => {
  const { env, col, common } = woodFoundationEnv();
  const foundation = viewOf(env.f1.plane.id, FIGURE_TYPE.FOUNDATION);
  const above = viewOf(env.f1.plane.id, FIGURE_TYPE.ABOVEGROUND);
  const pressed = resolveColumnLongPress({ ...common, world: { x: col.x, y: col.y }, slotView: above });
  sameObj(pressed?.column, col, '前提: 1階伏図では柱に当たる');
  const columnEdit = { graph: pressed.graph, column: pressed.column, slot: pressed.slot };
  const targetOf = slotView => resolveColumnEditTarget({ appMode: common.appMode, activeGraph: common.activeGraph, composition: common.composition, project: env.project, slotView });
  undoManager._undoStack.splice(0);
  isNull(targetOf(foundation), '基礎伏図へ切り替えた後の編集先');
  expectAbort(env, env.f1.graph, ColumnMenuItemId.DEL, { columnEdit, currentTarget: targetOf(foundation) }, ERR_COLUMN_DEL_ABORTED);
  assert.equal(env.f1.graph.columnMap.get(col.id) === col, true, '柱は残る');
  const res = runColumnMenuAction(ColumnMenuItemId.DEL, { columnEdit, currentTarget: targetOf(above), project: env.project });
  assert.equal(res.ok, true, '1階伏図のままなら削除できる');
  assert.equal(env.f1.graph.columnMap.has(col.id), false, '柱が消える');
});

test('【長クリック・失敗側】基礎伏図の view でも入力検査（world・scale・endpointDistPx・openingHit）は先に throw する（null 返却に隠れない）', () => {
  const { common } = woodFoundationEnv();
  const base = { ...common, world: { x: 1300, y: 2700 }, slotView: viewOf(common.activeGraph.plane.id, FIGURE_TYPE.FOUNDATION) };
  isNull(resolveColumnLongPress(base), '前提: 検査が通れば null');
  assert.throws(() => resolveColumnLongPress({ ...base, world: undefined }), /world/);
  assert.throws(() => resolveColumnLongPress({ ...base, world: { x: NaN, y: 1 } }), /world\.x/);
  assert.throws(() => resolveColumnLongPress({ ...base, scaleX: Infinity }), /scaleX/);
  assert.throws(() => resolveColumnLongPress({ ...base, endpointDistPx: NaN }), /endpointDistPx/);
  assert.throws(() => resolveColumnLongPress({ ...base, openingHit: 'no' }), /openingHit/);
});

test('【長クリック・失敗側】world・scale・閾値の欠落／非有限は throw', () => {
  const env = makeEnv();
  const base = { appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project, world: { x: 1300, y: 2700 }, scaleX: SX, scaleY: SY, thresholdPx: TH, endpointDistPx: null, openingHit: false };
  assert.throws(() => resolveColumnLongPress({ ...base, world: undefined }), /world/);
  assert.throws(() => resolveColumnLongPress({ ...base, world: { x: NaN, y: 1 } }), /world\.x/);
  assert.throws(() => resolveColumnLongPress({ ...base, scaleX: Infinity }), /scaleX/);
  assert.throws(() => resolveColumnLongPress({ ...base, scaleY: undefined }), /scaleY/);
  assert.throws(() => resolveColumnLongPress({ ...base, thresholdPx: undefined }), /thresholdPx/);
  assert.throws(() => resolveColumnLongPress(undefined), /world/);
});

// ---- runColumnMenuAction ----
const snap = graph => serializeGraph(graph);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function slotEdit(env) {
  const r = press(env, 'floorplan', 5300, 2700);
  return { graph: r.graph, column: null, slot: r.slot };
}

test('【確定・追加】成功: 柱 1 本・locked・undo で戻る', () => {
  const env = makeEnv();
  const edit = slotEdit(env);
  const res = runColumnMenuAction(ColumnMenuItemId.ADD, { columnEdit: edit, currentTarget: { graph: env.f1.graph }, project: env.project });
  assert.deepEqual(res, { ok: true });
  assert.equal(env.f1.graph.columns.length, 1);
  assert.equal(env.f1.graph.columns[0].dimensionStatus, 'locked');
  undoManager.undo();
  assert.equal(env.f1.graph.columns.length, 0);
});

test('【確定・追加・在来木造】中心線の交点でも梁芯の組で立つ', () => {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const g = env.f1.graph;
  const axisV = g.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH });
  const axisH = g.addCenterLine(H, 4700, { labeled: false, discipline: Discipline.ARCH });
  g.addWall(axisV, 0, true, env.gy[0], 0, env.gy[1], 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  g.addWall(axisH, 0, false, env.gx[0], 0, env.gx[1], 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  autoFillWallBeamAxes(g, selfWallSegments(g));
  const r = press(env, 'floorplan', 3300, 4700);
  assert.equal(r.slot.vCL.centerLineType, V);
  assert.equal(runColumnMenuAction(ColumnMenuItemId.ADD, { columnEdit: { graph: r.graph, column: null, slot: r.slot }, currentTarget: { graph: g }, project: env.project }).ok, true);
  const col = g.columns[0];
  assert.equal(centerLineKind(col.verticalCL), 'beam');
  assert.equal(centerLineKind(col.horizontalCL), 'beam');
});

test('【確定・削除】成功: 柱が消え除外集合に入り、undo で戻る', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  const key = columnSlotKey(env.gx[0], env.gy[0]);
  const res = runColumnMenuAction(ColumnMenuItemId.DEL, { columnEdit: { graph: env.f1.graph, column: c, slot: null }, currentTarget: { graph: env.f1.graph }, project: env.project });
  assert.deepEqual(res, { ok: true });
  assert.equal(env.f1.graph.columnMap.has(c.id), false);
  assert.equal(env.f1.graph.excludedColumnSlots.has(key), true);
  undoManager.undo();
  assert.equal(env.f1.graph.columnMap.has(c.id), true);
  assert.equal(env.f1.graph.excludedColumnSlots.has(key), false);
});

test('【確定・削除】削除後に残りの柱の番号が詰まる（undo で戻る）', () => {
  const env = makeEnv();
  const g = env.f1.graph;
  const mk = (sec, vCL, hCL) => g.addColumn(StructuralMaterialType.RC, sec, vCL, hCL, {});
  const cols = [mk('RC-300x300', env.gx[0], env.gy[0]), mk('RC-400x400', env.gx[1], env.gy[1]), mk('RC-500x500', env.gx[1], env.gy[0])];
  renumberMembers(g, env.project, 'columnMap');
  const noOf = c => g.columnMap.get(c.id).memberNo;
  const victim = cols.find(c => noOf(c) === 'C1');
  assert.ok(victim, '前提: C1 の柱がある');
  const rest = cols.filter(c => c.id !== victim.id);
  assert.equal(JSON.stringify(rest.map(noOf).sort()), JSON.stringify(['C2', 'C3']), '前提: 残りは C2・C3');
  const res = runColumnMenuAction(ColumnMenuItemId.DEL, { columnEdit: { graph: g, column: victim, slot: null }, currentTarget: { graph: g }, project: env.project });
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(rest.map(noOf).sort()), JSON.stringify(['C1', 'C2']), '残りの番号が詰まっていない');
  undoManager.undo();
  assert.equal(JSON.stringify(cols.map(noOf).sort()), JSON.stringify(['C1', 'C2', 'C3']));
  assert.equal(noOf(victim), 'C1');
});

test('【確定・削除】編集先がアクティブ階でない graph（1 階）でも、その graph を採番し、アクティブ階（2 階）の memberNo は変えない', () => {
  const env = makeEnv();
  const mk = (g, sec, vCL, hCL) => g.addColumn(StructuralMaterialType.RC, sec, vCL, hCL, {});
  const secs = ['RC-300x300', 'RC-400x400', 'RC-500x500'];
  const g1 = env.f1.graph, g2 = env.f2.graph;
  const cols1 = [mk(g1, secs[0], env.gx[0], env.gy[0]), mk(g1, secs[1], env.gx[1], env.gy[1]), mk(g1, secs[2], env.gx[1], env.gy[0])];
  secs.forEach((s, i) => mk(g2, s, env.gx[i % 2], env.gy[i === 1 ? 1 : 0]));
  renumberMembers(g1, env.project, 'columnMap');
  runInAction(() => { env.project.activePlaneId = env.f2.plane.id; });
  assert.ok(env.project.activeGraph === g2, '前提: アクティブは 2 階');
  for (const c of g2.columnMap.values()) c.setMemberNo('ZZ'); // 2 階を採番すると変わる状態
  const nos2 = () => JSON.stringify([...g2.columnMap.values()].map(c => c.memberNo));
  const stale2 = nos2();
  const noOf = c => g1.columnMap.get(c.id).memberNo;
  const victim = cols1.find(c => noOf(c) === 'C1');
  const rest = cols1.filter(c => c.id !== victim.id);
  const res = runColumnMenuAction(ColumnMenuItemId.DEL, { columnEdit: { graph: g1, column: victim, slot: null }, currentTarget: { graph: g1 }, project: env.project });
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(rest.map(noOf).sort()), JSON.stringify(['C1', 'C2']), '編集先（1 階）が採番されていない');
  assert.equal(nos2(), stale2, '2 階の memberNo が変わった');
});

function expectAbort(env, graph, itemId, args, error) {
  const before = snap(graph);
  const res = runColumnMenuAction(itemId, { project: env.project, ...args });
  assert.equal(res.ok, false);
  assert.equal(res.error, error);
  assert.ok(sameBytes(before, snap(graph)), 'graph が変わった');
  isNull(undoManager.peekUndo(), 'undo を積んではいけない');
}

// 中止の理由は 1 テスト 1 つ。env は作り直し、**その理由以外の中止条件が成り立っていない**ことを先に確かめる
// （どの理由で中止されたかを取り違えないため）。
const lineAlive = (graph, cl) => graph.gridXs.includes(cl) || graph.gridYs.includes(cl) || graph.shapeMap.get(cl.id) === cl;
// 追加: 編集先は同じ・線は生きている・交点は空き（resolveColumnSlot で再確認すると占有でない）
function assertAddOtherwiseOk(env, edit) {
  assert.ok(lineAlive(env.f1.graph, edit.slot.vCL) && lineAlive(env.f1.graph, edit.slot.hCL), '前提: 交点の線は生きている');
  assert.equal(resolveColumnSlot(env.f1.graph, env.project, edit.slot).occupied, false, '前提: 交点は空き（占有で中止されない）');
}
// 削除: 柱は同じインスタンスで実在
function assertDelOtherwiseOk(graph, c) {
  assert.ok(graph.columnMap.get(c.id) === c, '前提: 柱は同じインスタンスで実在');
}

test('【確定・中止・追加】編集先が別 graph→中止（graph・undo 不変）', () => {
  const env = makeEnv();
  const edit = slotEdit(env);
  assertAddOtherwiseOk(env, edit);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.ADD, { columnEdit: edit, currentTarget: { graph: env.f2.graph } }, ERR_COLUMN_ADD_ABORTED);
});

test('【確定・中止・追加】編集先が null→中止', () => {
  const env = makeEnv();
  const edit = slotEdit(env);
  assertAddOtherwiseOk(env, edit);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.ADD, { columnEdit: edit, currentTarget: null }, ERR_COLUMN_ADD_ABORTED);
});

test('【確定・中止・削除】編集先が別 graph→中止', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  undoManager._undoStack.splice(0);
  assertDelOtherwiseOk(env.f1.graph, c);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.DEL, { columnEdit: { graph: env.f1.graph, column: c, slot: null }, currentTarget: { graph: env.f2.graph } }, ERR_COLUMN_DEL_ABORTED);
});

test('【確定・中止・削除】編集先が null→中止', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  undoManager._undoStack.splice(0);
  assertDelOtherwiseOk(env.f1.graph, c);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.DEL, { columnEdit: { graph: env.f1.graph, column: c, slot: null }, currentTarget: null }, ERR_COLUMN_DEL_ABORTED);
});

test('【確定・中止・追加】選択までに同じ位置へ他経路で柱が立った（占有）→中止。線は生きている', () => {
  const env = makeEnv();
  const edit = slotEdit(env);
  assertAddOtherwiseOk(env, edit); // 立てる前は空き
  addCol(env.f1.graph, env.gx[1], env.gy[0]);
  undoManager._undoStack.splice(0);
  assert.ok(lineAlive(env.f1.graph, edit.slot.vCL) && lineAlive(env.f1.graph, edit.slot.hCL), '前提: 線は生きている（占有だけが理由）');
  expectAbort(env, env.f1.graph, ColumnMenuItemId.ADD, { columnEdit: edit, currentTarget: { graph: env.f1.graph } }, ERR_COLUMN_ADD_ABORTED);
});

test('【確定・中止・追加】slot が無い→中止', () => {
  const env = makeEnv();
  const edit = slotEdit(env);
  assertAddOtherwiseOk(env, edit);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.ADD, { columnEdit: { graph: env.f1.graph, column: null, slot: null }, currentTarget: { graph: env.f1.graph } }, ERR_COLUMN_ADD_ABORTED);
});

test('【確定・中止・追加】選択までに交点の線（中心線）が本番の削除で消えた→中止（柱は無く占有では中止されない）', async () => {
  const env = makeEnv();
  const g = env.f1.graph;
  const center = g.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH });
  const r = press(env, 'floorplan', 3300, 2700);
  assert.equal(r.slot.vCL.id, center.id, '前提: 中心線 × 通り芯の交点の slot');
  const edit = { graph: r.graph, column: null, slot: r.slot };
  assertAddOtherwiseOk(env, edit);
  assert.equal(g.columns.length, 0, '前提: 柱は無い');
  await deleteCenterLineWithUndo(g, env.project, center); // 本番の中心線削除（centerLineOps.js）
  assert.equal(lineAlive(g, center), false, '前提: 線は消えた');
  undoManager._undoStack.splice(0);
  assert.equal(g.columns.length, 0);
  expectAbort(env, g, ColumnMenuItemId.ADD, { columnEdit: edit, currentTarget: { graph: g } }, ERR_COLUMN_ADD_ABORTED);
});

test('【確定・中止・追加】選択までに交点の線（通り芯）が消えた→中止（柱は無く占有では中止されない）', () => {
  const env = makeEnv();
  const edit = slotEdit(env);
  assertAddOtherwiseOk(env, edit);
  env.project.structGraph.removeCenterLine(env.gx[1].id); // 通り芯は全階共有の structGraph から消える
  assert.equal(lineAlive(env.f1.graph, env.gx[1]), false, '前提: 線は消えた');
  assert.equal(env.f1.graph.columns.length, 0, '前提: 柱は無い');
  undoManager._undoStack.splice(0);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.ADD, { columnEdit: edit, currentTarget: { graph: env.f1.graph } }, ERR_COLUMN_ADD_ABORTED);
});

test('【確定・中止・削除】選択までに柱が消えた→中止', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  assertDelOtherwiseOk(env.f1.graph, c);
  env.f1.graph.columnMap.delete(c.id);
  undoManager._undoStack.splice(0);
  expectAbort(env, env.f1.graph, ColumnMenuItemId.DEL, { columnEdit: { graph: env.f1.graph, column: c, slot: null }, currentTarget: { graph: env.f1.graph } }, ERR_COLUMN_DEL_ABORTED);
});

test('【確定・中止・削除】同じ id の別インスタンスに替わった→中止（同じ id は実在する）', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  const replacement = addCol(env.f1.graph, env.gx[1], env.gy[1]);
  assertDelOtherwiseOk(env.f1.graph, c);
  env.f1.graph.columnMap.set(c.id, replacement);
  undoManager._undoStack.splice(0);
  assert.equal(env.f1.graph.columnMap.has(c.id), true, '前提: 同じ id は実在する（消えたのが理由ではない）');
  expectAbort(env, env.f1.graph, ColumnMenuItemId.DEL, { columnEdit: { graph: env.f1.graph, column: c, slot: null }, currentTarget: { graph: env.f1.graph } }, ERR_COLUMN_DEL_ABORTED);
});

test('【確定・失敗側】未知の itemId は throw（graph・undo 不変）', () => {
  const env = makeEnv();
  const before = snap(env.f1.graph);
  assert.throws(() => runColumnMenuAction('column-nope', { columnEdit: slotEdit(env), currentTarget: { graph: env.f1.graph }, project: env.project }), /未知の itemId/);
  assert.ok(sameBytes(before, snap(env.f1.graph)));
  isNull(undoManager.peekUndo());
});

// ---- 長クリックで消した柱は再計算で復活しない（本番と同じ recomputeStructuralForGraph を 3 回まで） ----
const colsAt = (graph, x, y) => graph.columns.filter(c => Math.abs(c.x - x) < 1 && Math.abs(c.y - y) < 1);
async function recompute3(graph, project, structure) {
  for (let i = 0; i < 3; i++) await recomputeStructuralForGraph(graph, project, structure);
}
function deleteByLongPress(env, graph, column) {
  const res = runColumnMenuAction(ColumnMenuItemId.DEL, { columnEdit: { graph, column, slot: null }, currentTarget: { graph }, project: env.project });
  assert.equal(res.ok, true);
}

test('【削除→再計算・非在来】通り芯交点の auto 柱を長クリックで消すと、再計算 3 回でも復活しない', async () => {
  const env = makeEnv('S造');
  const g = env.f1.graph;
  await recomputeStructuralForGraph(g, env.project, 'S造');
  // S造（ラーメン）は柱芯オフセットで実位置が交点からずれる（柱は CL の組で見分ける）
  const at = () => g.columns.filter(c => c.verticalCL.id === env.gx[1].id && c.horizontalCL.id === env.gy[0].id);
  const target = at();
  assert.equal(target.length, 1, '前提: 交点に auto 柱が立つ');
  assert.equal(target[0].dimensionStatus, 'auto');
  const total = g.columns.length;
  deleteByLongPress(env, g, target[0]);
  await recompute3(g, env.project, 'S造');
  assert.equal(at().length, 0, '復活しない');
  assert.equal(g.columns.length, total - 1, '他の柱は不変');
});

function buildWoodCross(env) {
  const g = env.f1.graph;
  const wall = (isV, value, a, b) => {
    const axisCL = g.addCenterLine(isV ? V : H, value, { labeled: false, discipline: Discipline.ARCH });
    return g.addWall(axisCL, 0, isV, a, 0, b, 0, { backingOffset: 0, backingDepth: 120, wallFinish: 12.5 });
  };
  wall(true, 3300, env.gy[0], env.gy[1]);
  return wall(false, 4700, env.gx[0], env.gx[1]);
}

test('【削除→再計算・在来木造】壁交点（3a）の auto 柱を長クリックで消すと、再計算 3 回でも復活しない', async () => {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const g = env.f1.graph;
  buildWoodCross(env);
  await recomputeStructuralForGraph(g, env.project, TRADITIONAL_WOOD_STRUCTURE);
  const target = colsAt(g, 3300, 4700);
  assert.equal(target.length, 1, '前提: 壁交点に auto 柱が立つ');
  const total = g.columns.length;
  deleteByLongPress(env, g, target[0]);
  await recompute3(g, env.project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(colsAt(g, 3300, 4700).length, 0, '復活しない');
  assert.equal(g.columns.length, total - 1);
});

test('【削除→再計算・在来木造】袖柱を長クリックで消すと、再計算 3 回でも復活しない', async () => {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const g = env.f1.graph;
  const hWall = buildWoodCross(env);
  g.addOpening(hWall.axisCL, 1, false, env.gx[0], 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});
  await recomputeStructuralForGraph(g, env.project, TRADITIONAL_WOOD_STRUCTURE);
  const jambs = g.columns.filter(c => c.woodJambRef);
  assert.ok(jambs.length >= 1, '前提: 袖柱が立つ');
  const victim = jambs[0];
  const ref = { ...victim.woodJambRef };
  deleteByLongPress(env, g, victim);
  await recompute3(g, env.project, TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(g.columns.some(c => c.woodJambRef && c.woodJambRef.openingId === ref.openingId && c.woodJambRef.side === ref.side), false, '復活しない');
});

// ---- 案 1-A: 交点より端点の先端のほうが近ければ端点メニューに譲る（柱追加にしない）----
// 端点までの距離は本番（snap.js endpointHitDistancePx）と同じ判定の findNearestCenterLineEndpointWithDist（突端円・はね出し線分）で
// 求めて渡す。縮尺は実 Viewport の分母（1/100 ではみ出し 300mm≒11px・1/500 以上ではみ出し 0）。
function scaled(denom) {
  const vp = new Viewport(1000, 800);
  runInAction(() => { vp.scaleX = vp.pxPerMmX / denom; vp.scaleY = vp.pxPerMmY / denom; });
  return vp;
}
function pressWithEndpoint(env, vp, wx, wy, opts = {}) {
  const { appMode = 'floorplan', activeGraph = env.f1.graph, composition = null, targetGraph = env.f1.graph } = opts;
  const hitKinds = hitTestKinds(appMode);
  const tip = findNearestCenterLineEndpointWithDist(targetGraph, wx, wy, TH, vp.scaleX, vp.scaleY, vp, k => hitKinds.includes(k));
  return resolveColumnLongPress({
    appMode, activeGraph, composition, project: env.project, world: { x: wx, y: wy },
    scaleX: vp.scaleX, scaleY: vp.scaleY, thresholdPx: TH, endpointDistPx: tip ? tip.dist : null, openingHit: false,
  });
}

test('【端点に譲る・T 字】中心線の端が通り芯上で止まる T 字（1/100）: 突端寄りは slot なし（端点メニュー）・交点寄りは slot・等距離は slot', () => {
  const env = makeEnv();
  env.f1.graph.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH, extentLo: 2700, extentHi: 6700 }); // 下端 2700 が通り芯 y=2700 の上
  const vp = scaled(100);
  const tipProbe = findNearestCenterLineEndpointWithDist(env.f1.graph, 3300, 2400, TH, vp.scaleX, vp.scaleY, vp, k => hitTestKinds('floorplan').includes(k));
  assert.ok(tipProbe && tipProbe.dist < 0.001, '前提: 突端は端から 300mm 先（2400）にある');
  isNull(pressWithEndpoint(env, vp, 3300, 2500).slot, '交点から 7.6px・突端から 3.8px → 端点に譲る');
  assert.ok(pressWithEndpoint(env, vp, 3300, 2640).slot, '交点から 2.3px・突端は 9px（当たらない）→ 柱追加');
  assert.ok(pressWithEndpoint(env, vp, 3300, 2550).slot, '交点・突端とも 5.7px（等距離）→ 柱追加');
});

test('【端点に譲る・はね出し線分】外寸法（CENTER 寸法）に届く側のはね出し線分上は、突端円ではなく線への垂直距離で譲る', () => {
  const env = makeEnv();
  const g = env.f1.graph;
  // CENTER 寸法の行があると、中心線の端が最外の通り芯（y=2700）に届く側のはね出し線分（2400〜2700）も端点の当たりになる
  g.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT });
  g.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP });
  g.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH, extentLo: 2700, extentHi: 6700 });
  const vp = scaled(100);
  const hitKinds = hitTestKinds('floorplan');
  const probe = (x, y) => findNearestCenterLineEndpointWithDist(g, x, y, TH, vp.scaleX, vp.scaleY, vp, k => hitKinds.includes(k));
  // 前提（点 (3320, 2550)）: 線から x に 20mm（約 0.76px）・突端（2400）までは y に 150mm（約 5.7px）
  const p = probe(3320, 2550);
  const perpPx = 20 * vp.scaleX, tipPx = Math.hypot(20 * vp.scaleX, 150 * vp.scaleY);
  assert.ok(p && Math.abs(p.dist - perpPx) < 1e-9, '前提: 端点の dist は垂直距離（突端円までの距離ではない）');
  assert.ok(tipPx - perpPx > 4, '前提: 突端円までは垂直距離よりずっと遠い');
  isNull(pressWithEndpoint(env, vp, 3320, 2550).slot, '垂直距離 0.76px < 交点 5.7px → 端点に譲る（突端円の距離なら等距離で柱追加になる）');
  // 線分の内側（extent 側。y=2740 は端点の当たりでない）は交点が近い → 柱追加
  isNull(probe(3320, 2740), '前提: extent の内側は端点の当たりでない');
  assert.ok(pressWithEndpoint(env, vp, 3320, 2740).slot, 'extent の内側 → 柱追加');
});

test('【端点に譲る・T 字】1/500（はね出し 0＝突端と交点が同じ点）→ 等距離なので柱追加', () => {
  const env = makeEnv();
  env.f1.graph.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH, extentLo: 2700, extentHi: 6700 });
  const vp = scaled(500);
  assert.ok(pressWithEndpoint(env, vp, 3300, 2660).slot, '突端＝交点: 距離が等しい');
  assert.ok(pressWithEndpoint(env, vp, 3300, 2740).slot);
});

test('【端点に譲る・L 字】中心線どうしの L 字（1/100）: 先端寄りは slot なし・角寄りは slot', () => {
  const env = makeEnv();
  const g = env.f1.graph;
  g.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH, extentLo: 4000, extentHi: 6000 });
  g.addCenterLine(H, 4000, { labeled: false, discipline: Discipline.ARCH, extentLo: 3300, extentHi: 5000 });
  const vp = scaled(100);
  isNull(pressWithEndpoint(env, vp, 3300, 3800).slot, '角から 7.6px・縦線の突端から 3.8px → 端点に譲る');
  assert.ok(pressWithEndpoint(env, vp, 3300, 3950).slot, '角から 1.9px・突端は遠い → 柱追加');
  assert.ok(pressWithEndpoint(env, vp, 3350, 4020).slot, '角のすぐ内側 → 柱追加');
});

test('【端点に譲る・十字】どちらの線も端でない十字の交点は従来どおり slot（端点候補なし）', () => {
  const env = makeEnv();
  env.f1.graph.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.ARCH, extentLo: 2000, extentHi: 6700 }); // 下端は通り芯より 700mm 外
  const vp = scaled(100);
  assert.ok(pressWithEndpoint(env, vp, 3300, 2650).slot);
  assert.ok(pressWithEndpoint(env, vp, 3330, 2690).slot);
});

test('【端点に譲る・構造・在来木造】梁芯の T（端が通り芯上）: 突端寄りは slot なし・交点寄りは slot', () => {
  const env = makeEnv(TRADITIONAL_WOOD_STRUCTURE);
  const comp = composeStructural(env.project, env.f2, { p1: env.f1.graph, p2: env.f2.graph });
  const beam = env.f2.graph.addCenterLine(V, 3300, { labeled: false, discipline: Discipline.FUSE, extentLo: 2700, extentHi: 6700 });
  const vp = scaled(100);
  const opts = { appMode: 'structure', activeGraph: env.f2.graph, composition: comp, targetGraph: env.f2.graph };
  isNull(pressWithEndpoint(env, vp, 3300, 2500, opts).slot, '梁芯の突端に譲る');
  const near = pressWithEndpoint(env, vp, 3300, 2640, opts);
  assert.equal(near.slot.vCL.id, beam.id);
});

test('【端点に譲る・柱は別】柱の断面内は端点に関係なく柱（端点距離 0 でも）', () => {
  const env = makeEnv();
  const c = addCol(env.f1.graph, env.gx[0], env.gy[0]);
  const r = press(env, 'floorplan', c.x, c.y, { endpointDistPx: 0 });
  sameObj(r.column, c);
});

test('【端点に譲る・非対称 scale】交点までの距離は x に scaleX・y に scaleY: (dx,dy)=(100,50)mm は hypot(4, 2.5)=4.72px。端点 5px は譲らず slot・4.5px は譲る', () => {
  const env = makeEnv();
  // 取り違え（x に scaleY・y に scaleX）なら hypot(5, 2)=5.39px になり、端点 5px が近いことになって譲ってしまう
  const near = press(env, 'floorplan', 1400, 2750, { endpointDistPx: 5 });
  assert.ok(near.slot !== null, '5px > 4.72px なので交点が近い＝slot');
  const far = press(env, 'floorplan', 1400, 2750, { endpointDistPx: 4.5 });
  isNull(far.slot, '4.5px < 4.72px なので端点に譲る');
  isNull(far.column);
});

test('【端点に譲る・失敗側】endpointDistPx・openingHit の欠落・型違いは throw', () => {
  const env = makeEnv();
  const base = { appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project, world: { x: 1300, y: 2700 }, scaleX: SX, scaleY: SY, thresholdPx: TH };
  assert.throws(() => resolveColumnLongPress({ ...base, openingHit: false }), /endpointDistPx/);
  assert.throws(() => resolveColumnLongPress({ ...base, endpointDistPx: NaN, openingHit: false }), /endpointDistPx/);
  assert.throws(() => resolveColumnLongPress({ ...base, endpointDistPx: null }), /openingHit/);
  assert.throws(() => resolveColumnLongPress({ ...base, endpointDistPx: null, openingHit: 1 }), /openingHit/);
});

// ---- 案 2-A: 柱の広げた当たり幅（実際の断面の外）が建具に重なるときは建具に譲る ----
test('【建具に譲る】1/200 で袖柱の広げた部分が建具の上→柱でない。実断面の内側は柱・建具なし・壁の上は柱', () => {
  const env = makeEnv();
  const c = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[0], env.gy[0], {}); // 半幅 60mm
  const vp = scaled(200);
  const at = (dx, openingHit) => resolveColumnLongPress({
    appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project, world: { x: c.x + dx, y: c.y },
    scaleX: vp.scaleX, scaleY: vp.scaleY, thresholdPx: TH, endpointDistPx: null, openingHit,
  });
  assert.ok(8 / vp.scaleX > 400, '前提: 広げた当たり幅は 400mm を超える');
  const yielded = at(200, true);
  isNull(yielded.column, '広げた部分で建具の上→柱にしない');
  isNull(yielded.slot, '建具メニューへ（柱追加にもしない）');
  sameObj(at(30, true).column, c, '実際の断面の内側は建具があっても柱');
  sameObj(at(200, false).column, c, '建具が無い（建具と反対側・壁の上）なら広げた部分も柱');
});

test('【建具に譲る】広げた部分で建具の上でも、点を実際の断面に含む別の柱があればその柱（inner のフォールバック）', () => {
  const env = makeEnv();
  const vB = env.project.structGraph.addCenterLine(V, 1630, { labeled: true, discipline: Discipline.STRUCT });
  const a = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[0], env.gy[0], {}); // 中心 1300・半幅 60
  const b = env.f1.graph.addColumn(StructuralMaterialType.STEEL, BIG, vB, env.gy[0], {});            // 中心 1630・半幅 200 → 実断面 1430〜1830
  const vp = scaled(200);
  const px = 1450, py = 2700; // a の広げた部分（中心から 150mm）かつ b の実断面の内側（b の中心からは 180mm）
  const mm = { scaleX: vp.scaleX, scaleY: vp.scaleY, minHalfPx: TH };
  assert.ok(8 / vp.scaleX > 400, '前提: 広げた当たり幅は 400mm を超える');
  sameObj(columnAtPoint([a, b], px, py, mm), a, '前提: 最初の hit は a（中心に最も近い）');
  assert.ok(!isInsideColumnRect(a, px, py), '前提: 点は a の実断面の外（広げた部分）');
  assert.ok(isInsideColumnRect(b, px, py), '前提: 点は b の実断面の内側');
  const r = resolveColumnLongPress({
    appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project, world: { x: px, y: py },
    scaleX: vp.scaleX, scaleY: vp.scaleY, thresholdPx: TH, endpointDistPx: null, openingHit: true,
  });
  assert.equal(r.column?.id, b.id, '建具の上でも、点を実断面に含む b が返る（a には譲らない・建具にも譲らない）');
  // 対照: b が無ければ a は広げた部分だけなので建具に譲る
  env.f1.graph.columnMap.delete(b.id);
  const yielded = resolveColumnLongPress({
    appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project, world: { x: px, y: py },
    scaleX: vp.scaleX, scaleY: vp.scaleY, thresholdPx: TH, endpointDistPx: null, openingHit: true,
  });
  isNull(yielded.column, 'b が無ければ建具に譲る');
});

test('【建具に譲る】構造モードは建具を解決しないので、openingHit が真でも柱', () => {
  const env = makeEnv('S造');
  const comp = composeStructural(env.project, env.f2, { p1: env.f1.graph, p2: env.f2.graph });
  const c = env.f1.graph.addColumn(StructuralMaterialType.WOOD, WOOD_120, env.gx[0], env.gy[0], {});
  const vp = scaled(200);
  const r = resolveColumnLongPress({
    appMode: 'structure', activeGraph: env.f2.graph, composition: comp, project: env.project, world: { x: c.x + 200, y: c.y },
    scaleX: vp.scaleX, scaleY: vp.scaleY, thresholdPx: TH, endpointDistPx: null, openingHit: true,
  });
  sameObj(r.column, c);
});

test('【解決確認】resolveColumnEditTarget の結果が currentTarget として使える（平面）', () => {
  const env = makeEnv();
  const target = resolveColumnEditTarget({ appMode: 'floorplan', activeGraph: env.f1.graph, composition: null, project: env.project });
  sameObj(target.graph, env.f1.graph);
});
