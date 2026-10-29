// steelSlabBays.js（S造スラブのベイ指定・解除・照会）と、S造スラブを仕上げグリッドの再解釈から除外する配線の単体テスト。
// フィクスチャは slabSecondaryBeamAxes.test.js の buildBay / buildBayWithMidBeam の簡約版（4辺を primary 梁で囲んだ1ベイ。
// 座標系は y 下向き正・ベイは y:[-height,0]）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StructuralMaterialType, SteelSlab, RcSlab } from '../core.js';
import { BeamAxisOrigin } from '../core/centerLine.js';
import { SlabBayFillSkip, SteelSlabKind, BraceMemberType } from '../core/constants.js';
import { cellBoundsFromKey, cellInteriorPoint, regionCellsAt } from '../finish/gridCells.js';
import { findUnresolvableCells, reinterpretSlabsAfterCLRemoval, collectUnresolvableCells } from '../finish/roomReinterpret.js';
import { rulesFor, STRUCTURE_RULES, UNSPECIFIED_RULES, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { listSlabBays } from './slabSecondaryBeamAxes.js';
import { deleteClassificationOverflow } from './structuralAutoFill.js';
import { structureHasMemberKind, MEMBER_KIND, STRUCTURES } from './structuralClassification.js';
import { defaultSteelSlabSpec, projectToKind } from './steelSlabSpec.js';
import {
  bayCellKey, canAssignSteelSlab, assignSteelSlabBays, releaseSteelSlabBays, steelSlabForBay, braceBayMap,
} from './steelSlabBays.js';

const PROJECT = { planes: [], structuralInfo: { mainStructure: '未定', foundationType: 'ベタ基礎', steelSlabSpec: defaultSteelSlabSpec() }, memberGroupLedger: new Map() };

const STRUCT = { labeled: true, discipline: Discipline.STRUCT };
const NO_OPENING = { openingRects: [] };

function buildBay(structure, { width = 5000, height = 7000, plane = new Plane('p1', 0, '1階', 1, 1) } = {}) {
  const graph = new PlanGraph(plane);
  graph.structureOverride = structure;
  const rules = rulesFor(structure);
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, STRUCT);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, width, STRUCT);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, -height, STRUCT);
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, STRUCT);
  const add = (cl, isV, a, b) => graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, cl, isV, a, b, { role: 'primary' });
  add(y0, false, x0, x1); add(y1, false, x0, x1); add(x0, true, y0, y1); add(x1, true, y0, y1);
  return { graph, x0, x1, y0, y1 };
}

// 5000×20000 のベイの y=-8000 に、由来 OPENING の梁芯（通り芯ではない）と小梁を通す＝上下2ベイ（辺の1本が開口由来梁芯）。
function buildBayWithOpeningBeam() {
  const b = buildBay('S造', { width: 5000, height: 20000 });
  const rules = rulesFor('S造');
  const mid = b.graph.addCenterLine(CenterLineType.HORIZONTAL, -8000, {
    labeled: false, discipline: Discipline.FUSE, beamAxisOrigin: BeamAxisOrigin.OPENING,
    extentLoRef: { clId: b.x0.id, offset: 0 }, extentHiRef: { clId: b.x1.id, offset: 0 },
  });
  b.graph.addBeam(rules.baseMaterial, rules.defaultSections.beam, mid, false, b.x0, b.x1, { role: 'secondary' });
  return { ...b, mid };
}

test('bayCellKey: 左:上:右:下 の順（x1Id:y1Id:x2Id:y2Id）で連結する', () => {
  assert.equal(bayCellKey({ x1Id: 'a', y1Id: 'b', x2Id: 'c', y2Id: 'd' }), 'a:b:c:d');
});

test('listSlabBays: S造は4辺の軸CL id から cellBoundsFromKey で解決できる key を返す。S造でない主構造は空', () => {
  const { graph, x0, x1, y0, y1 } = buildBay('S造');
  const bays = listSlabBays(graph, PROJECT);
  assert.equal(bays.length, 1);
  assert.equal(bays[0].key, `${x0.id}:${y0.id}:${x1.id}:${y1.id}`);
  assert.equal(bays[0].skip, null);
  const b = cellBoundsFromKey(bays[0].key, graph);
  assert.deepEqual([b.x1, b.x2, b.y1, b.y2], [0, 5000, -7000, 0]);
  assert.deepEqual(listSlabBays(buildBay('RC造(ラーメン)').graph, PROJECT), []);
});

test('listSlabBays: 開口矩形と重なるベイは skip=OPENING（openingRects を渡したときだけ）', () => {
  const { graph } = buildBay('S造');
  const rect = { x1: 1000, x2: 2000, y1: -3000, y2: -2000, source: 'void' };
  assert.equal(listSlabBays(graph, PROJECT, [rect])[0].skip, SlabBayFillSkip.OPENING);
  assert.equal(listSlabBays(graph, PROJECT)[0].skip, null);
});

test('assignSteelSlabBays: 1枚の SteelSlab（steelSpec null＝共通）を作り、cells がベイキー。個別仕様も渡せる', () => {
  const { graph } = buildBay('S造');
  const [bay] = listSlabBays(graph, PROJECT);
  const r = assignSteelSlabBays(graph, PROJECT, [bay.key], NO_OPENING);
  assert.deepEqual(r.releasedFrom, []);
  const slab = graph.slabMap.get(r.slabId);
  assert.ok(slab instanceof SteelSlab);
  assert.deepEqual([...slab.cells], [bay.key]);
  assert.equal(slab.steelSpec, null);
  assert.equal(slab.materialType, StructuralMaterialType.STEEL);
  assert.equal(steelSlabForBay(graph, bay.key), slab);

  const spec = projectToKind(defaultSteelSlabSpec(), SteelSlabKind.BRACE);
  const other = buildBay('S造');
  const [bay2] = listSlabBays(other.graph, PROJECT);
  const r2 = assignSteelSlabBays(other.graph, PROJECT, [bay2.key], { steelSpec: spec, openingRects: [] });
  assert.equal(other.graph.slabMap.get(r2.slabId).steelSpec, spec);
});

test('【失敗系】assignSteelSlabBays: S造でない階・基礎伏図・屋根専用平面・空 keys・現況にないキー・開口のベイは例外で、graph を変えない', () => {
  const { graph } = buildBay('S造');
  const [bay] = listSlabBays(graph, PROJECT);
  const run = (g, p, keys, opts) => assert.throws(() => assignSteelSlabBays(g, p, keys, opts), Error);
  for (const structure of ['RC造(ラーメン)', 'SRC造', '未定', TRADITIONAL_WOOD_STRUCTURE]) {
    const b = buildBay(structure);
    run(b.graph, PROJECT, ['x:y:z:w']);
    assert.equal(b.graph.slabs.length, 0, structure);
  }
  // 基礎伏図（最下階）: project.planes の先頭がこの階
  assert.throws(() => assignSteelSlabBays(graph, { ...PROJECT, planes: [graph.plane] }, [bay.key]), /S造の階だけ/);
  // 屋根専用平面
  const roof = buildBay('S造', { plane: new Plane('r1', 0, '屋根', 1, 1, false, null, 0, true, 'p1') });
  assert.throws(() => assignSteelSlabBays(roof.graph, PROJECT, [listSlabBays(roof.graph, PROJECT)[0].key]), /S造の階だけ/);
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, [], NO_OPENING), /指定するベイがありません/);
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, [bay.key, 'no:such:bay:key'], NO_OPENING), /no:such:bay:key/);
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, [bay.key]), /openingRects は必須/);
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, [bay.key], {}), /openingRects は必須/);
  const rect = { x1: 1000, x2: 2000, y1: -3000, y2: -2000, source: 'void' };
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, [bay.key], { openingRects: [rect] }), /開口/);
  assert.equal(graph.slabs.length, 0, '失敗で graph は変わらない');
});

test('assignSteelSlabBays: 既存の S造スラブからキーを奪い（空になれば削除）、RcSlab には触らない', () => {
  const { graph } = buildBayWithOpeningBeam();
  const [k1, k2] = listSlabBays(graph, PROJECT).map(b => b.key);
  assert.equal(listSlabBays(graph, PROJECT).length, 2);
  const rc = graph.addSlab(StructuralMaterialType.RC, null, new Set([k1]));
  const a = assignSteelSlabBays(graph, PROJECT, [k1, k2], NO_OPENING);
  assert.deepEqual([...rc.cells], [k1], 'RcSlab は奪わない');

  const b = assignSteelSlabBays(graph, PROJECT, [k1], NO_OPENING);
  assert.deepEqual(b.releasedFrom, [a.slabId]);
  assert.deepEqual([...graph.slabMap.get(a.slabId).cells], [k2], '残りのキーは元のスラブに残る');
  assert.equal(steelSlabForBay(graph, k1), graph.slabMap.get(b.slabId));

  const c = assignSteelSlabBays(graph, PROJECT, [k2], NO_OPENING);
  assert.deepEqual(c.releasedFrom, [a.slabId]);
  assert.equal(graph.slabMap.has(a.slabId), false, '空になった S造スラブは削除');
  assert.ok(graph.slabMap.has(b.slabId) && graph.slabMap.has(c.slabId) && rc instanceof RcSlab);
});

test('releaseSteelSlabBays: キーを外し、空になったスラブを削除して id を返す。未知のキーは無視（例外なし）', () => {
  const { graph } = buildBayWithOpeningBeam();
  const [k1, k2] = listSlabBays(graph, PROJECT).map(b => b.key);
  const rc = graph.addSlab(StructuralMaterialType.RC, null, new Set([k1]));
  const a = assignSteelSlabBays(graph, PROJECT, [k1, k2], NO_OPENING);
  assert.deepEqual(releaseSteelSlabBays(graph, [k1, 'unknown:key:x:y']), [], '一部だけなら削除なし');
  assert.deepEqual([...graph.slabMap.get(a.slabId).cells], [k2]);
  assert.deepEqual(releaseSteelSlabBays(graph, [k2]), [a.slabId]);
  assert.equal(graph.slabMap.has(a.slabId), false);
  assert.deepEqual([...rc.cells], [k1], 'RcSlab は解除の対象外');
  assert.deepEqual(releaseSteelSlabBays(graph, ['nothing:here:at:all']), []);
  assert.equal(steelSlabForBay(graph, k2), null);
});

test('assignSteelSlabBays: 作ったスラブは locked（手動追加材と同じ扱い）。主構造変更の撤去段 deleteClassificationOverflow が「×」化したスラブとして消さない', () => {
  const { graph } = buildBay('S造');
  const [bay] = listSlabBays(graph, PROJECT);
  const r = assignSteelSlabBays(graph, PROJECT, [bay.key], NO_OPENING);
  const slab = graph.slabMap.get(r.slabId);
  assert.equal(slab.dimensionStatus, 'locked');
  // スラブが「×」になる主構造を探す（検出力の前提。無ければ撤去段の検証が空振りになる）。
  const noSlabStructure = STRUCTURES.find(s => !structureHasMemberKind(MEMBER_KIND.SLAB, s));
  assert.ok(noSlabStructure, '前提: スラブが×の主構造がある');
  graph.structureOverride = noSlabStructure;
  // （梁など他の auto 部材も×で消えるため、スラブ id が含まれるかで見る）
  assert.ok(!deleteClassificationOverflow(graph, PROJECT).includes(r.slabId), 'locked は撤去されない');
  assert.ok(graph.slabMap.has(r.slabId));
  // 対照: auto のままなら同じ撤去段で消える。
  slab.setDimensionStatus('auto');
  assert.ok(deleteClassificationOverflow(graph, PROJECT).includes(r.slabId));
  assert.ok(!graph.slabMap.has(r.slabId));
});

test('braceBayMap:実効仕様（個別＞共通）がブレースのベイだけ、部材種別つきで返す', () => {
  const { graph } = buildBayWithOpeningBeam();
  const [k1, k2] = listSlabBays(graph, PROJECT).map(b => b.key);
  const brace = { ...projectToKind(defaultSteelSlabSpec(), SteelSlabKind.BRACE), braceMemberType: BraceMemberType.ANGLE };
  assignSteelSlabBays(graph, PROJECT, [k1], { steelSpec: brace, openingRects: [] });
  assignSteelSlabBays(graph, PROJECT, [k2], NO_OPENING); // 共通（既定＝デッキ）
  assert.deepEqual([...braceBayMap(graph, PROJECT)], [[k1, BraceMemberType.ANGLE]]);
  const commonBrace = { ...PROJECT, structuralInfo: { ...PROJECT.structuralInfo, steelSlabSpec: { ...defaultSteelSlabSpec(), kind: SteelSlabKind.BRACE } } };
  const m = braceBayMap(graph, commonBrace);
  assert.equal(m.size, 2, '共通がブレースなら個別なしのベイも対象');
  assert.equal(m.get(k2), defaultSteelSlabSpec().braceMemberType);
});

test('steelSlabAssignment: S造だけ true（RC・SRC・木造・未定・未知は false）。canAssignSteelSlab は基礎伏図・屋根専用平面でも false', () => {
  for (const key of Object.keys(STRUCTURE_RULES)) {
    assert.equal(rulesFor(key).steelSlabAssignment, key === 'S造', key);
  }
  assert.equal(UNSPECIFIED_RULES.steelSlabAssignment, false);
  assert.equal(rulesFor('不明な構造').steelSlabAssignment, false);
  const s = buildBay('S造');
  assert.equal(canAssignSteelSlab(s.graph, PROJECT), true);
  assert.equal(canAssignSteelSlab(s.graph, { ...PROJECT, planes: [s.graph.plane] }), false, '基礎伏図');
  assert.equal(canAssignSteelSlab(s.graph, { ...PROJECT, planes: [new Plane('b', -3000, 'B', 0, 1), s.graph.plane] }), true, '最下階でなければ可');
  const roof = buildBay('S造', { plane: new Plane('r1', 0, '屋根', 1, 1, false, null, 0, true, 'p1') });
  assert.equal(canAssignSteelSlab(roof.graph, PROJECT), false, '屋根専用平面');
  assert.equal(canAssignSteelSlab(buildBay('SRC造').graph, PROJECT), false);
});

// ---- 仕上げグリッドの再解釈からの除外（roomReinterpret.js） ----

test('S造スラブ: 開口由来梁芯を辺に持つベイキーは、CL 削除後始末（再解釈・復元不能判定）で変わらず、CL 削除を止めない', () => {
  const { graph, x0 } = buildBayWithOpeningBeam();
  const keys = listSlabBays(graph, PROJECT).map(b => b.key);
  const { slabId } = assignSteelSlabBays(graph, PROJECT, keys, NO_OPENING);
  const slab = graph.slabMap.get(slabId);
  const before = [...slab.cells];
  // 辺が開口由来梁芯（通り芯ではない）のベイも cellBoundsFromKey で矩形に解決できる（shapeMap／索引経由）
  const rects = keys.map(k => cellBoundsFromKey(k, graph));
  assert.ok(rects.every(r => r != null), '開口由来梁芯の辺を持つベイキーも解決できる');
  assert.deepEqual(rects.map(r => [r.y1, r.y2]).sort((a, b) => a[0] - b[0]), [[-20000, -8000], [-8000, 0]]);
  // 無関係な通り芯を足して削除する想定（ベイの辺ではない）
  const extra = graph.addCenterLine(CenterLineType.VERTICAL, 9000, STRUCT);
  assert.deepEqual(reinterpretSlabsAfterCLRemoval(graph), { unresolved: [] });
  assert.deepEqual([...slab.cells], before, 'セルは変わらない');
  assert.deepEqual(findUnresolvableCells(graph, extra.id), []);
  assert.deepEqual(findUnresolvableCells(graph, x0.id), [], 'ベイの辺の通り芯でも S造スラブは復元不能に数えない');
  assert.deepEqual([...collectUnresolvableCells(graph)], []);
});

test('S造スラブ: ベイの辺の CL が消えても例外なく、データは保持され cellBoundsFromKey は null（描かない）', () => {
  const { graph, mid } = buildBayWithOpeningBeam();
  const keys = listSlabBays(graph, PROJECT).map(b => b.key);
  const { slabId } = assignSteelSlabBays(graph, PROJECT, keys, NO_OPENING);
  graph.removeCenterLine(mid.id);
  const slab = graph.slabMap.get(slabId);
  assert.deepEqual([...slab.cells], keys, '消えた辺を持つキーも保持する');
  assert.ok(keys.some(k => cellBoundsFromKey(k, graph) === null), '消えたキーは解決できない（描かない）');
  assert.doesNotThrow(() => reinterpretSlabsAfterCLRemoval(graph));
  assert.deepEqual([...slab.cells], keys);
});

test('S造スラブ: 辺の CL を消した後の collectUnresolvableCells（安全網）はベイキーを復元不能に数えない。生の判定では復元不能（空振り防止の対照）', () => {
  const { graph, mid, y0 } = buildBayWithOpeningBeam();
  const keys = listSlabBays(graph, PROJECT).map(b => b.key);
  assignSteelSlabBays(graph, PROJECT, keys, NO_OPENING);
  graph.removeCenterLine(mid.id);
  graph.removeCenterLine(y0.id);
  // 対照: 生の判定（collectUnresolvableCells の内部と同じ cellInteriorPoint／regionCellsAt）ではキーが復元不能になっている
  const rawUnresolvable = keys.map((key) => {
    const pt = cellInteriorPoint(key, graph);
    return !pt || regionCellsAt(pt.x, pt.y, graph).length === 0;
  });
  assert.ok(rawUnresolvable.some(Boolean), '前提: 辺を失ったキーは生の判定で復元不能');
  const unresolvable = collectUnresolvableCells(graph);
  assert.ok(keys.every(k => !unresolvable.has(k)), 'S造スラブのキーは数えない');
});

test('【失敗系】assignSteelSlabBays: 一部のキーが不正で例外のとき、先に検証するので既存の S造スラブは奪われず変わらない', () => {
  const { graph } = buildBayWithOpeningBeam();
  const [a] = listSlabBays(graph, PROJECT).map(b => b.key);
  const { slabId } = assignSteelSlabBays(graph, PROJECT, [a], NO_OPENING);
  assert.throws(() => assignSteelSlabBays(graph, PROJECT, [a, 'no:such:bay:key'], NO_OPENING), /no:such:bay:key/);
  assert.equal(graph.slabs.length, 1);
  assert.deepEqual([...graph.slabMap.get(slabId).cells], [a]);
});
