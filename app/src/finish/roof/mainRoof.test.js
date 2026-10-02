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
import { mainRoofBounds, resolveMainRoofShape, mainRoofHighSideView, mainRoofRidgeDirectionView } from './mainRoof.js';
import { rectOfBounds } from './roofGeometry.js';
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

// ---- C1b: 矩形でない建物範囲の自動の形状は寄棟（主屋根だけ。下屋は短手の規則のまま） ----

/** L字の屋内（3セル）だけの階（buildRoofLayout の notch・屋根なし）。建物範囲は矩形でない。 */
const lShapedGraph = () => buildRoofLayout('notch', 'none').graph;

test('【C1b】resolveMainRoofShape: 建物範囲が矩形でない（L字）なら、木造・主構造未定の自動の形状は寄棟', () => {
  const project = new Project('p', 'test');
  const g = lShapedGraph();
  assert.equal(rectOfBounds(mainRoofBounds(g)), null, '前提: 建物範囲は矩形でない');
  assert.ok(mainRoofBounds(g).length > 0);
  for (const key of [TRADITIONAL_WOOD_STRUCTURE, '木造（2"×4"）', UNSPECIFIED_STRUCTURE]) {
    project.structuralInfo.mainStructure = key;
    assert.equal(resolveMainRoofShape(g, project), RoofShape.HIP, key);
  }
});

test('【C1b】resolveMainRoofShape: 矩形の建物範囲は今までどおり短手の規則（3640以下=片流れ・超=切妻）', () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  assert.equal(resolveMainRoofShape(singleRoomGraph(9000, 3640), project), RoofShape.MONO);
  assert.equal(resolveMainRoofShape(singleRoomGraph(9000, 3641), project), RoofShape.GABLE);
  // 2セルに分かれた矩形（band の屋内部分）も矩形
  assert.equal(resolveMainRoofShape(buildRoofLayout('band', 'roof').graph, project), RoofShape.MONO);
});

test('【C1b】resolveMainRoofShape: 非木造は矩形でなくても陸屋根。明示値は矩形でなくてもそのまま', () => {
  const project = new Project('p', 'test');
  const g = lShapedGraph();
  for (const key of ['RC造(ラーメン)', 'RC造(壁式)', 'S造', 'SRC造']) {
    project.structuralInfo.mainStructure = key;
    assert.equal(resolveMainRoofShape(g, project), RoofShape.FLAT, key);
  }
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  g.mainRoofSpec.setField('shape', RoofShape.GABLE);
  assert.equal(resolveMainRoofShape(g, project), RoofShape.GABLE);
});

test('【C1b・失敗系】建物範囲が空の階は木造でも寄棟にならない（今までどおり短手0＝片流れ）。階段だけの階も空', () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const g = new PlanGraph(new Plane('p1', 0, '3階', 3, 1));
  assert.equal(resolveMainRoofShape(g, project), RoofShape.MONO);
});

test('【C1b】下屋の resolveRoofShape は矩形でなくても今までどおり（L字の下屋は短手で片流れ／切妻。寄棟にならない）', () => {
  const L = [rect(0, 0, 6000, 2000), rect(0, 2000, 3000, 7000)]; // 短手 3000 の L字
  const LBIG = [rect(0, 0, 9000, 4000), rect(0, 4000, 4000, 9000)]; // 短手 4000 超の L字
  assert.equal(rectOfBounds(L), null);
  const rules = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: L }), RoofShape.MONO);
  assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: LBIG }), RoofShape.GABLE);
  assert.equal(resolveRoofShape(new RoofSpec(), { boundsList: LBIG, rules }), RoofShape.GABLE, 'rules を渡しても寄棟にならない');
});

test('【C1b】mainRoofHighSideView: 片流れ＋矩形のとき、既定は横長=上・縦長=左・正方形=上。明示値が優先', () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  assert.deepEqual(mainRoofHighSideView(singleRoomGraph(9000, 3000), project), { visible: true, value: 'top' });
  assert.deepEqual(mainRoofHighSideView(singleRoomGraph(3000, 3500), project), { visible: true, value: 'left' });
  assert.deepEqual(mainRoofHighSideView(singleRoomGraph(3000, 3000), project), { visible: true, value: 'top' });
  const g = singleRoomGraph(9000, 3000);
  g.mainRoofSpec.setField('highSide', 'right');
  assert.deepEqual(mainRoofHighSideView(g, project), { visible: true, value: 'right' });
});

test('【C1b・失敗系】mainRoofHighSideView: 形状が片流れでない（切妻・寄棟・陸屋根）・矩形でない・建物範囲が空は非表示', () => {
  const project = new Project('p', 'test');
  const hidden = { visible: false, value: null };
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const gable = singleRoomGraph(9000, 6000);
  gable.mainRoofSpec.setField('highSide', 'left'); // 明示値があっても出さない
  assert.deepEqual(mainRoofHighSideView(gable, project), hidden, '切妻');
  assert.deepEqual(mainRoofHighSideView(lShapedGraph(), project), hidden, 'L字＝寄棟');
  const lMono = lShapedGraph();
  lMono.mainRoofSpec.setField('shape', RoofShape.MONO);
  assert.deepEqual(mainRoofHighSideView(lMono, project), hidden, '矩形でない片流れは出さない');
  // 建物範囲が空: 形状は片流れだが範囲が無いので高い側は導けない
  assert.deepEqual(mainRoofHighSideView(new PlanGraph(new Plane('p1', 0, '3階', 3, 1)), project), hidden, '空');
  project.structuralInfo.mainStructure = 'S造';
  assert.deepEqual(mainRoofHighSideView(singleRoomGraph(9000, 3000), project), hidden, '陸屋根');
  const sMono = singleRoomGraph(9000, 3000);
  sMono.mainRoofSpec.setField('shape', RoofShape.MONO);
  assert.deepEqual(mainRoofHighSideView(sMono, project), { visible: true, value: 'top' }, 'S造でも明示の片流れなら出る');
});

test('【C2e-1c】mainRoofRidgeDirectionView: 切妻＋矩形のとき visible。値は明示値（自動は null）', () => {
  const project = new Project('p', 'test');
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const g = singleRoomGraph(9000, 6000); // 自動は切妻
  assert.deepEqual(mainRoofRidgeDirectionView(g, project), { visible: true, value: null });
  g.mainRoofSpec.setField('ridgeDirection', 'vertical');
  assert.deepEqual(mainRoofRidgeDirectionView(g, project), { visible: true, value: 'vertical' });
});

test('【C2e-1c・失敗系】mainRoofRidgeDirectionView: 形状が切妻でない（片流れ・寄棟・陸屋根）・矩形でない・建物範囲が空は非表示（明示値があっても）', () => {
  const project = new Project('p', 'test');
  const hidden = { visible: false, value: null };
  project.structuralInfo.mainStructure = TRADITIONAL_WOOD_STRUCTURE;
  const mono = singleRoomGraph(9000, 3000);
  mono.mainRoofSpec.setField('ridgeDirection', 'vertical');
  assert.deepEqual(mainRoofRidgeDirectionView(mono, project), hidden, '片流れ');
  const l = lShapedGraph();
  l.mainRoofSpec.setField('ridgeDirection', 'vertical');
  assert.deepEqual(mainRoofRidgeDirectionView(l, project), hidden, 'L字＝寄棟');
  const lGable = lShapedGraph();
  lGable.mainRoofSpec.setField('shape', RoofShape.GABLE);
  assert.deepEqual(mainRoofRidgeDirectionView(lGable, project), hidden, '矩形でない切妻は出さない');
  assert.deepEqual(mainRoofRidgeDirectionView(new PlanGraph(new Plane('p1', 0, '3階', 3, 1)), project), hidden, '空（片流れ扱い）');
  project.structuralInfo.mainStructure = 'S造';
  assert.deepEqual(mainRoofRidgeDirectionView(singleRoomGraph(9000, 6000), project), hidden, '陸屋根');
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

test('【B3】主屋根の全11項目を既定以外にしても、壁の鮮度キー・建物範囲・外壁セグメント・生成壁・境界は変わらない', () => {
  for (const shape of ['band', 'notch']) {
    for (const mode of ['roof', 'none']) {
      const { graph } = buildRoofLayout(shape, mode);
      const project = new Project('p', 'test');
      const before = fingerprint(graph, project);
      assert.ok(before.walls.length > 0 && before.footprint.length > 0, '前提: 壁・建物範囲がある');
      graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
      assert.equal(ROOF_SPEC_KEYS.filter(k => graph.mainRoofSpec[k] !== new RoofSpec()[k]).length, 11, '前提: 全項目が既定以外');
      assert.deepEqual(fingerprint(graph, project), before, `${shape}/${mode}`);
    }
  }
});
