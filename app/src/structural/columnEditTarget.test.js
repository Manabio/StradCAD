// columnEditTarget.js（長クリックの柱追加・削除の編集先の階の解決と占有判定）のテスト。
// 構造の composition は本番と同じ図面定義（structuralFigure.js）から組む（composeStructural は
// FigureBindingManager.activate の写し。peek の代わりに階ごとの graph を直接結ぶ）。graph・結果は循環参照を持つ
// 巨大オブジェクトで assert.equal の失敗時 diff が止まるため、同一性は assert.ok(a === b) に plane id の
// メッセージを付けて書く。fixture は原点から離した座標。.jsx/store.js/snap.js は import しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, CenterLineType, Discipline, StructuralMaterialType, CL_OVERLAP_TOL_MM } from '../core.js';
import { FigureComposition } from '../figure/FigureBindingManager.js';
import { resolveSourcePlanes, LayerRole } from '../figure/figureTypes.js';
import { getFigure } from '../figure/figureRegistry.js';
import { STRUCTURAL_FIGURE_ID } from './structuralFigure.js';
import { TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { FIGURE_TYPE, SLOT_TYPE, resolveSharedPlaneView } from './structuralClassification.js';
import { buildStructuralFigureSlots } from './structuralFigureSlots.js';
import { resolveColumnEditTarget, isColumnSlotOccupied } from './columnEditTarget.js';
import { PLACED_FIGURE_MODE_IDS } from '../core/placedFigureModes.js';

const V = CenterLineType.VERTICAL, H = CenterLineType.HORIZONTAL;
const BIG = 'STEEL-H400x400'; // 400 角（半幅 200）

// 1階・2階の 2 層 project。structure はどちらの階の実効主構造にも与える。
function makeProject(structure) {
  const project = new Project('proj', 'test');
  const f1 = project.addPlane(0, '1階', 'p1');
  const f2 = project.addPlane(2800, '2階', 'p2', 2, 1);
  f1.graph.structureOverride = structure;
  f2.graph.structureOverride = structure;
  return { project, f1, f2 };
}

// FigureBindingManager.activate の写し（供給階の解決・planeId 重複排除の手順を同じにし、peek だけを省略して
// 階ごとの graph の直渡しで代用する。出典: figure/FigureBindingManager.js activate）。
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

const planeIdOf = r => r?.graph?.plane?.id ?? null;
function assertTargetIs(r, graph, what = '') {
  assert.ok(r?.graph === graph, `${what}編集先の階が違う（期待 ${graph.plane.id}・実際 ${planeIdOf(r)}）`);
}
function assertNoTarget(r, what = '') {
  assert.ok(r === null, `${what}編集先は null のはず（実際 ${planeIdOf(r)}）`);
}

function target(appMode, project, subject, graphOf) {
  return resolveColumnEditTarget({
    appMode, activeGraph: subject.graph, composition: composeStructural(project, subject, graphOf), project,
  });
}

test('【編集先】平面は表示中の階（activeGraph）。composition は見ない', () => {
  const { project, f2 } = makeProject('S造');
  const r = resolveColumnEditTarget({ appMode: 'floorplan', activeGraph: f2.graph, composition: null, project });
  assertTargetIs(r, f2.graph);
});

test('【編集先・失敗側】平面で activeGraph が無ければ null', () => {
  const { project } = makeProject('S造');
  assertNoTarget(resolveColumnEditTarget({ appMode: 'floorplan', activeGraph: null, composition: null, project }));
});

test('【編集先】構造・非在来: 柱一覧と同じく 1 つ下の階の graph', () => {
  const { project, f1, f2 } = makeProject('S造');
  const r = target('structure', project, f2, { p1: f1.graph, p2: f2.graph });
  assertTargetIs(r, f1.graph);
});

test('【編集先】構造・在来木造: 自階柱□の供給階＝自階（参照レイヤでも供給階が主題階なら編集可）', () => {
  const { project, f1, f2 } = makeProject(TRADITIONAL_WOOD_STRUCTURE);
  const r = target('structure', project, f2, { p1: f1.graph, p2: f2.graph });
  assertTargetIs(r, f2.graph);
  const r1 = target('structure', project, f1, { p1: f1.graph, p2: f2.graph });
  assertTargetIs(r1, f1.graph, '最下階の在来木造も自階柱□が編集先: ');
});

test('【編集先・失敗側】構造・非在来の最下階（基礎伏図＝下階柱の供給階なし）は null', () => {
  const { project, f1, f2 } = makeProject('S造');
  assertNoTarget(target('structure', project, f1, { p1: f1.graph, p2: f2.graph }));
});

test('【編集先・失敗側】参照のみのレイヤで供給階が主題階でなければ null', () => {
  const { project, f1, f2 } = makeProject(TRADITIONAL_WOOD_STRUCTURE);
  const comp = composeStructural(project, f2, { p1: f1.graph, p2: f2.graph });
  // 自階柱□の供給階を別の階（1階）に差し替えた composition（REFERENCE かつ主題階 2階 ≠ 供給階 1階）
  const spec = comp.layers.find(l => l.spec.categories.includes('columnMapSelf')).spec;
  assert.equal(spec.role, LayerRole.REFERENCE);
  const odd = new FigureComposition(comp.figureDef, f2.plane);
  odd.layers.push({ spec, binding: { plane: f1.plane, graph: f1.graph, roles: new Set() } });
  const r = resolveColumnEditTarget({ appMode: 'structure', activeGraph: f2.graph, composition: odd, project });
  assertNoTarget(r);
});

test('【編集先・失敗側】他の appMode・構造で composition なしは null', () => {
  const { project, f1, f2 } = makeProject('S造');
  const comp = composeStructural(project, f2, { p1: f1.graph, p2: f2.graph });
  // 図面モード（姿図配置モード）の id も全部 null（柱の長クリックは平面・構造だけ。表に行が増えても一般に成り立つ）
  for (const appMode of ['finish', 'ceiling', 'opening', 'site', 'elevation', 'facade', 'noSuchMode', ...PLACED_FIGURE_MODE_IDS]) {
    assertNoTarget(resolveColumnEditTarget({ appMode, activeGraph: f2.graph, composition: comp, project }), `${appMode}: `);
  }
  assertNoTarget(resolveColumnEditTarget({ appMode: 'structure', activeGraph: f2.graph, composition: null, project }));
});

// ---- 見せ分け（slotView）: 描いていない部材は操作させない ----
// view は frozen な { slotKey, planeId, figureType } を手で作る（resolveSharedPlaneView の戻りと同じ形）。
const viewOf = (planeId, figureType) => Object.freeze({ slotKey: `slot:${figureType}`, planeId, figureType });
const targetWith = (project, subject, graphOf, slotView, appMode = 'structure') => resolveColumnEditTarget({
  appMode, activeGraph: subject.graph, composition: composeStructural(project, subject, graphOf), project, slotView,
});

test('【見せ分け】構造・在来木造: 基礎伏図（柱を描かない）は null・1階伏図と view なしは従来どおり編集先', () => {
  const { project, f1, f2 } = makeProject(TRADITIONAL_WOOD_STRUCTURE);
  const graphOf = { p1: f1.graph, p2: f2.graph };
  assertNoTarget(targetWith(project, f1, graphOf, viewOf(f1.plane.id, FIGURE_TYPE.FOUNDATION)), '基礎伏図: ');
  assertTargetIs(targetWith(project, f1, graphOf, viewOf(f1.plane.id, FIGURE_TYPE.ABOVEGROUND)), f1.graph, '1階伏図: ');
  assertTargetIs(targetWith(project, f1, graphOf, null), f1.graph, 'view なし: ');
  assertTargetIs(targetWith(project, f1, graphOf, undefined), f1.graph, 'view 省略: ');
});

// 手書きの view がスロット列の実物と食い違っていないことの確認: App.jsx と同じ手順（スロット列→resolveSharedPlaneView）で作る。
test('【見せ分け】実物のスロット列から作った view でも同じ（基礎伏図＝null・1階伏図＝編集先）', () => {
  const { project, f1, f2 } = makeProject(TRADITIONAL_WOOD_STRUCTURE);
  project.structuralInfo.setField('mainStructure', TRADITIONAL_WOOD_STRUCTURE);
  const slots = buildStructuralFigureSlots(project);
  const onF1 = slots.filter(s => s.planeId === f1.plane.id);
  const fSlot = onF1.find(s => s.slotType === SLOT_TYPE.FOUNDATION);
  const gSlot = onF1.find(s => s.slotType === SLOT_TYPE.GROUND_FLOOR);
  assert.equal(fSlot != null && gSlot != null, true, '前提: 1階の平面に基礎伏図と1階伏図の両スロットが乗る');
  const fView = resolveSharedPlaneView(fSlot, slots, f1.plane.id);
  const gView = resolveSharedPlaneView(gSlot, slots, f1.plane.id);
  assert.equal(fView?.figureType, FIGURE_TYPE.FOUNDATION, '基礎伏図の視点');
  assert.equal(gView?.figureType, FIGURE_TYPE.ABOVEGROUND, '1階伏図の視点');
  const graphOf = { p1: f1.graph, p2: f2.graph };
  assertNoTarget(targetWith(project, f1, graphOf, fView), '基礎伏図（実物）: ');
  assertTargetIs(targetWith(project, f1, graphOf, gView), f1.graph, '1階伏図（実物）: ');
});

test('【見せ分け】view の平面が編集先 graph の平面と違えば絞らない（別平面の参照レイヤには掛けない）', () => {
  const { project, f1, f2 } = makeProject(TRADITIONAL_WOOD_STRUCTURE);
  const graphOf = { p1: f1.graph, p2: f2.graph };
  assertTargetIs(targetWith(project, f2, graphOf, viewOf(f1.plane.id, FIGURE_TYPE.FOUNDATION)), f2.graph, '編集先は 2階・view は 1階の基礎伏図: ');
  // 非在来の 2階では編集先＝下階（1階）。1階の基礎伏図 view は 1階の graph に掛かるので null・2階の view は掛からない
  const s = makeProject('S造');
  const sGraphOf = { p1: s.f1.graph, p2: s.f2.graph };
  assertNoTarget(targetWith(s.project, s.f2, sGraphOf, viewOf(s.f1.plane.id, FIGURE_TYPE.FOUNDATION)), '下階が編集先で view もその平面: ');
  assertTargetIs(targetWith(s.project, s.f2, sGraphOf, viewOf(s.f2.plane.id, FIGURE_TYPE.FOUNDATION)), s.f1.graph, 'view が別平面: ');
});

test('【見せ分け】平面モードは slotView を読まない（基礎伏図の view が渡っても activeGraph）', () => {
  const { project, f1, f2 } = makeProject(TRADITIONAL_WOOD_STRUCTURE);
  const r = targetWith(project, f1, { p1: f1.graph, p2: f2.graph }, viewOf(f1.plane.id, FIGURE_TYPE.FOUNDATION), 'floorplan');
  assertTargetIs(r, f1.graph);
});

// ---- 占有判定 ----
function makeGrid() {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'S造';
  const sg = project.structGraph;
  const cl = (t, v) => sg.addCenterLine(t, v, { labeled: true, discipline: Discipline.STRUCT });
  const add = (vCL, hCL, props = {}) => graph.addColumn(StructuralMaterialType.STEEL, BIG, vCL, hCL, props);
  return { graph, cl, add };
}

test('【占有】既存柱のキーが一致する交点は、偏芯で矩形から外れていても占有', () => {
  const { graph, cl, add } = makeGrid();
  const v = cl(V, 1300), h = cl(H, 2700);
  const c = add(v, h, { eccentricity: { x: 500, y: 0 } });
  assert.equal(c.x, 1800); // 前提: 矩形は x 1600〜2000 で交点 x=1300 を含まない
  assert.equal(isColumnSlotOccupied(graph, { vCL: v, hCL: h, x: 1300, y: 2700 }), true);
});

test('【占有】キーが違っても既存柱の断面矩形が交点を含めば占有（許容 CL_OVERLAP_TOL_MM を含む）', () => {
  const { graph, cl, add } = makeGrid();
  const v = cl(V, 1300), h = cl(H, 2700);
  const v2 = cl(V, 1450), v3 = cl(V, 1500 + CL_OVERLAP_TOL_MM / 2), v4 = cl(V, 1500 + CL_OVERLAP_TOL_MM * 2);
  add(v, h); // 矩形 x 1100〜1500・y 2500〜2900
  const q = (vCL, x, y = 2700) => isColumnSlotOccupied(graph, { vCL, hCL: h, x, y });
  assert.equal(q(v2, 1450), true, '矩形の内側');
  assert.equal(q(v3, 1500 + CL_OVERLAP_TOL_MM / 2), true, '端から許容内');
  assert.equal(q(v4, 1500 + CL_OVERLAP_TOL_MM * 2), false, '端から許容外');
  assert.equal(q(v2, 1450, 2900 + CL_OVERLAP_TOL_MM * 2), false, 'Y が矩形の外');
});

test('【占有】どちらでもなければ空き・柱が無ければ空き', () => {
  const { graph, cl, add } = makeGrid();
  const v = cl(V, 1300), h = cl(H, 2700), v2 = cl(V, 5300), h2 = cl(H, 6700);
  assert.equal(isColumnSlotOccupied(graph, { vCL: v, hCL: h, x: 1300, y: 2700 }), false);
  add(v, h);
  assert.equal(isColumnSlotOccupied(graph, { vCL: v2, hCL: h2, x: 5300, y: 6700 }), false);
  assert.equal(isColumnSlotOccupied(graph, { vCL: v2, hCL: h, x: 5300, y: 2700 }), false);
});

test('【占有】柱が 2 本あり、遠い柱が先・交点を含む柱が後でも占有（1 本でも該当すれば真）', () => {
  const { graph, cl, add } = makeGrid();
  const v = cl(V, 1300), h = cl(H, 2700), vFar = cl(V, 5300), hFar = cl(H, 6700), vNear = cl(V, 5400);
  add(vFar, hFar); // 先に遠い柱（矩形 x 5100〜5500・y 6500〜6900）
  add(v, h);       // 後から交点付近の柱
  assert.equal(graph.columns.length, 2);
  assert.equal(isColumnSlotOccupied(graph, { vCL: vNear, hCL: h, x: 1450, y: 2700 }), true, '2 本目（交点を含む柱）で真');
  assert.equal(isColumnSlotOccupied(graph, { vCL: vNear, hCL: hFar, x: 5400, y: 6700 }), true, '1 本目（遠い柱）で真');
});

test('【占有・失敗側】vCL/hCL 欠落・x/y 非有限は throw', () => {
  const { graph, cl } = makeGrid();
  const v = cl(V, 1300), h = cl(H, 2700);
  assert.throws(() => isColumnSlotOccupied(graph, { vCL: null, hCL: h, x: 1300, y: 2700 }), /必須/);
  assert.throws(() => isColumnSlotOccupied(graph, { vCL: v, hCL: undefined, x: 1300, y: 2700 }), /必須/);
  assert.throws(() => isColumnSlotOccupied(graph, { vCL: v, hCL: h, x: NaN, y: 2700 }), /有限/);
  assert.throws(() => isColumnSlotOccupied(graph, { vCL: v, hCL: h, x: 1300, y: Infinity }), /有限/);
  assert.throws(() => isColumnSlotOccupied(graph, undefined), /必須/);
});
