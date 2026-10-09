// stairSectionEdit.js（階段パネルの図中編集・タイプ切替が sections へ書く値と型導出）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stair, StairType, StairPortSide, StructuralMaterialType, Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { applySectionDimEdit, sectionsForType, isTurnStepsDim, portSideChange, resetPortSides, alignPortTurnSteps, alignPortStairsOnGraph, clampPortTurnStepsEdit } from './stairSectionEdit.js';
import { classifyStairArea } from './stairClassify.js';

test('回り階段の回転部（index1）に R=0 を入れると sections[1]=1・タイプは SWITCHBACK に導出', () => {
  const r = applySectionDimEdit({ type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }, 1, 0);
  assert.deepEqual(r.sections, [5, 1, 4]);
  assert.equal(r.type, StairType.SWITCHBACK);
});

test('折返し階段の踊り場（index1）に R=3 を入れると sections[1]=4・タイプは WINDING に導出', () => {
  const r = applySectionDimEdit({ type: StairType.SWITCHBACK, sections: [7, 1, 6], totalSteps: 13 }, 1, 3);
  assert.deepEqual(r.sections, [7, 4, 6]);
  assert.equal(r.type, StairType.WINDING);
});

test('直進部（偶数index）は 踏面数+1、タイプ不変。L字のコーナー（index1）は従来どおり値そのまま', () => {
  const a = applySectionDimEdit({ type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }, 0, 6);
  assert.deepEqual(a.sections, [7, 5, 4]);
  assert.equal(a.type, StairType.WINDING);
  const l = applySectionDimEdit({ type: StairType.FLARED, sections: [5, 3, 5], totalSteps: 12 }, 1, 2);
  assert.deepEqual(l.sections, [5, 2, 5]);
  assert.equal(l.type, StairType.FLARED);
  assert.equal(isTurnStepsDim(StairType.FLARED, 1), false);
});

test('【失敗系】sections 未設定（null）でも既定値から組み立てて編集できる', () => {
  const r = applySectionDimEdit({ type: StairType.SWITCHBACK, sections: null, totalSteps: 12 }, 1, 2);
  assert.equal(r.sections.length, 3);
  assert.equal(r.sections[1], 3);
  assert.equal(r.type, StairType.WINDING);
});

test('sectionsForType: 回り→折返しは回転部を 1（R=0）に、折返し→回りで R=0 のままなら既定の回り段数へ', () => {
  assert.deepEqual(sectionsForType(StairType.SWITCHBACK, { type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }), [5, 1, 4]);
  assert.deepEqual(sectionsForType(StairType.WINDING, { type: StairType.SWITCHBACK, sections: [7, 1, 6], totalSteps: 13 }), [7, 3, 6]);
  // 既に回り段（R>0）を持つ sections はそのまま
  assert.deepEqual(sectionsForType(StairType.WINDING, { type: StairType.WINDING, sections: [5, 5, 4], totalSteps: 13 }), [5, 5, 4]);
});

test('sectionsForType: 区間数が合わないタイプ切替（直進→踊り場付）は既定値で組み直す。既定の無いタイプは null', () => {
  const r = sectionsForType(StairType.STRAIGHT_LANDING, { type: StairType.STRAIGHT, sections: [13], totalSteps: 13 });
  assert.equal(r.length, 3);
  assert.equal(r[1], 1);
  assert.equal(sectionsForType('unknown', { type: StairType.STRAIGHT, sections: [13], totalSteps: 13 }), null);
});

const apply = (stair, fields) => { for (const [k, v] of Object.entries(fields)) stair.setField(k, v); };

test('portSideChange: 側面へ切り替えても totalSteps は変わらない（取りつき蹴上ぶん往路の直進部が減る）。走行端へ戻すと取りつき 0・直進部へ戻る', () => {
  const stair = new Stair('s', { type: StairType.SWITCHBACK, sections: [8, 5, 8] });
  const total = stair.totalSteps;
  apply(stair, portSideChange(stair, 'entry', StairPortSide.RIGHT, 1000));
  assert.equal(stair.entrySide, 'right');
  assert.equal(stair.entryTurnSteps, 4, '木造: 区間 1000mm ÷ 踏面 250');
  assert.deepEqual(stair.sections, [4, 5, 8]);
  assert.equal(stair.totalSteps, total);
  // 到達口は復路（sections[2]）から引く
  apply(stair, portSideChange(stair, 'arrival', StairPortSide.LEFT, 500));
  assert.equal(stair.arrivalTurnSteps, 2);
  assert.deepEqual(stair.sections, [4, 5, 6]);
  assert.equal(stair.totalSteps, total);
  // 走行端へ戻す
  apply(stair, portSideChange(stair, 'entry', StairPortSide.END, 1000));
  assert.equal(stair.entryTurnSteps, 0);
  assert.deepEqual(stair.sections, [8, 5, 6]);
  assert.equal(stair.totalSteps, total);
  apply(stair, portSideChange(stair, 'arrival', StairPortSide.END, 500));
  assert.deepEqual(stair.sections, [8, 5, 8]);
  assert.equal(stair.totalSteps, total);
});

test('【失敗系】portSideChange: 直進部が 2 段未満になる側面は拒否（null）。鉄骨は蹴上 0 なので直進部を食わない。sections が組めない型は null', () => {
  const stair = new Stair('s', { type: StairType.SWITCHBACK, sections: [5, 5, 8] });
  assert.equal(portSideChange(stair, 'entry', StairPortSide.LEFT, 1000), null, '5−4=1 段');
  assert.equal(portSideChange(stair, 'entry', StairPortSide.END, 1000).entryTurnSteps, 0, '走行端へは常に切り替えられる');
  stair.setField('structure', 'STEEL');
  assert.deepEqual(portSideChange(stair, 'entry', StairPortSide.LEFT, 1000), { entrySide: 'left', entryTurnSteps: 0 });
  // 区間数が合わない sections（直進に 3 区間など。直進は 1 区間）の stair で取りつきを足す・戻す切替は組めない
  const bad = { type: StairType.STRAIGHT, structure: 'WOOD', tread: 250, sections: [13, 1, 5], entryTurnSteps: 0 };
  assert.equal(portSideChange(bad, 'entry', StairPortSide.LEFT, 1000), null);
  assert.equal(portSideChange({ ...bad, entryTurnSteps: 3 }, 'entry', StairPortSide.END, 1000), null);
});

test('portSideChange（直進）: 総蹴上数を保つ。区間が 1 つなので上り口・到達口とも sections[0] から引き、戻すと sections[0] へ戻る', () => {
  const stair = new Stair('s', { type: StairType.STRAIGHT, sections: [15] });
  assert.equal(stair.totalSteps, 15);
  const apply = (fields) => { for (const [k, v] of Object.entries(fields)) stair.setField(k, v); };
  apply(portSideChange(stair, 'entry', StairPortSide.LEFT, 1000));
  assert.deepEqual([stair.sections, stair.entryTurnSteps, stair.totalSteps], [[11], 4, 15]);
  apply(portSideChange(stair, 'arrival', StairPortSide.RIGHT, 1000));
  assert.deepEqual([stair.sections, stair.arrivalTurnSteps, stair.totalSteps], [[7], 4, 15]);
  apply(portSideChange(stair, 'entry', StairPortSide.END, 1000));
  assert.deepEqual([stair.sections, stair.entryTurnSteps, stair.totalSteps], [[11], 0, 15]);
  // 直進部が 2 段未満になる側面は拒否
  const small = new Stair('t', { type: StairType.STRAIGHT, sections: [5] });
  assert.equal(portSideChange(small, 'arrival', StairPortSide.LEFT, 1000), null);
  // 踊場付直進の到達口は復路側（sections[2]）から引く
  const landing = new Stair('u', { type: StairType.STRAIGHT_LANDING, sections: [8, 1, 9] });
  assert.deepEqual(portSideChange(landing, 'arrival', StairPortSide.LEFT, 1000).sections, [8, 1, 5]);
  assert.deepEqual(portSideChange(landing, 'entry', StairPortSide.LEFT, 1000).sections, [4, 1, 9]);
});

test('resetPortSides/alignPortTurnSteps（直進系）: 取りつき蹴上は直進部（sections[0]）へ戻り総蹴上数を保つ。矩折ほかは {}', () => {
  const stair = new Stair('s', { type: StairType.STRAIGHT, sections: [7], entrySide: StairPortSide.LEFT, entryTurnSteps: 4, arrivalSide: StairPortSide.RIGHT, arrivalTurnSteps: 4 });
  assert.equal(stair.totalSteps, 15);
  assert.deepEqual(resetPortSides(stair), { entrySide: null, arrivalSide: null, entryTurnSteps: 0, arrivalTurnSteps: 0, sections: [15] });
  assert.deepEqual(alignPortTurnSteps(stair, { entry: 'end', arrival: 'side' }), { entryTurnSteps: 0, sections: [11] });
  assert.deepEqual(alignPortTurnSteps(stair, { entry: 'side', arrival: 'side' }), {});
  assert.deepEqual(resetPortSides({ type: StairType.FLARED }), {});
  assert.deepEqual(resetPortSides({ type: StairType.OPEN_WELL }), {});
  assert.equal(portSideChange({ type: StairType.FLARED, sections: [8, 2, 8], structure: 'WOOD', tread: 250, entryTurnSteps: 0 }, 'entry', StairPortSide.LEFT, 1000), null, '曲がり階段は切替不可');
});

// ---- 木造の側面の口は取りつき蹴上が最低 1（平場 0 は鉄骨だけ。ユーザー裁定 2026-10-09）----
const build = (props) => new Stair('s', { type: StairType.SWITCHBACK, ...props });

test('alignPortTurnSteps: 木造・側面・蹴上 0 → 1 にし、その口のレーンの直進部から 1 段引く（総蹴上数不変）。上り口は往路、到達口は復路', () => {
  const stair = build({ sections: [8, 5, 8] });
  const total = stair.totalSteps;
  const fixed = alignPortTurnSteps(stair, { entry: 'inner', arrival: 'end' });
  assert.deepEqual(fixed, { entryTurnSteps: 1, sections: [7, 5, 8] });
  apply(stair, fixed);
  assert.equal(stair.totalSteps, total);
  const both = alignPortTurnSteps(build({ sections: [8, 5, 8] }), { entry: 'side', arrival: 'outer' });
  assert.deepEqual(both, { entryTurnSteps: 1, arrivalTurnSteps: 1, sections: [7, 5, 7] });
  // 直進（区間 1 つ）は sections[0] から引く
  assert.deepEqual(alignPortTurnSteps(new Stair('t', { type: StairType.STRAIGHT, sections: [9] }), { entry: 'side', arrival: 'end' }),
    { entryTurnSteps: 1, sections: [8] });
});

test('alignPortTurnSteps: 鉄骨の平場 0・既に 1 以上・走行端は触らない。走行端の残り蹴上は従来どおり 0 へ戻す', () => {
  assert.deepEqual(alignPortTurnSteps(build({ sections: [8, 5, 8], structure: StructuralMaterialType.STEEL }), { entry: 'inner', arrival: 'outer' }), {});
  assert.deepEqual(alignPortTurnSteps(build({ sections: [5, 5, 8], entryTurnSteps: 3 }), { entry: 'inner', arrival: 'end' }), {});
  assert.deepEqual(alignPortTurnSteps(build({ sections: [8, 5, 8] }), { entry: 'end', arrival: 'end' }), {});
  // 走行端の戻し（entry）と側面の引上げ（arrival）が同時でも sections は 1 本にまとまる
  const mixed = alignPortTurnSteps(build({ sections: [5, 5, 8], entryTurnSteps: 3 }), { entry: 'end', arrival: 'inner' });
  assert.deepEqual(mixed, { entryTurnSteps: 0, sections: [8, 5, 7], arrivalTurnSteps: 1 });
});

test('【失敗系】alignPortTurnSteps: 直進部が MIN_RUN_RISERS 未満になるなら sections は不変で蹴上だけ 1（総蹴上数 +1）。出入口を選べない型は {}。sections が null は既定値から組む', () => {
  const stair = build({ sections: [2, 5, 8] });
  const total = stair.totalSteps;
  const fixed = alignPortTurnSteps(stair, { entry: 'inner', arrival: 'end' });
  assert.deepEqual(fixed, { entryTurnSteps: 1, sections: [2, 5, 8] });
  apply(stair, fixed);
  assert.equal(stair.totalSteps, total + 1);
  assert.deepEqual(alignPortTurnSteps({ type: StairType.FLARED, structure: 'WOOD' }, { entry: 'inner', arrival: 'outer' }), {});
  const noSections = build({ totalSteps: 15 });
  assert.equal(noSections.sections, null);
  const f = alignPortTurnSteps(noSections, { entry: 'inner', arrival: 'end' });
  assert.equal(f.entryTurnSteps, 1);
  assert.equal(f.sections.length, 3);
  apply(noSections, f);
  assert.equal(noSections.totalSteps, 15, 'sections が組まれて総蹴上数が同期され、不変');
  // 区間数が合わない sections は書かない（蹴上だけ）
  assert.deepEqual(alignPortTurnSteps({ type: StairType.STRAIGHT, structure: 'WOOD', sections: [5, 1, 5], entryTurnSteps: 0 }, { entry: 'side', arrival: 'end' }), { entryTurnSteps: 1 });
});

test('clampPortTurnStepsEdit: 鉄骨以外は取りつき蹴上の直接編集を下限 1 に止める（0 を入れても e=1・sections・total 不変）。鉄骨は 0 を受け付け、他のフィールドは触らない', () => {
  const stair = build({ sections: [4, 6, 5], entryTurnSteps: 1 });
  const total = stair.totalSteps;
  for (const field of ['entryTurnSteps', 'arrivalTurnSteps']) {
    assert.equal(clampPortTurnStepsEdit(stair, field, 0), 1, field);
    assert.equal(clampPortTurnStepsEdit(stair, field, 3), 3, field);
  }
  stair.setField('entryTurnSteps', clampPortTurnStepsEdit(stair, 'entryTurnSteps', 0));
  assert.deepEqual([stair.entryTurnSteps, stair.sections, stair.totalSteps], [1, [4, 6, 5], total]);
  assert.equal(clampPortTurnStepsEdit(stair, 'riser', 0), 0, '他のフィールドは値そのまま');
  const steel = build({ sections: [4, 6, 5], structure: StructuralMaterialType.STEEL });
  assert.equal(clampPortTurnStepsEdit(steel, 'entryTurnSteps', 0), 0);
});

test('alignPortTurnSteps: 型の範囲は hasPortSides の全型。矩折 [6,1,6] の両側面 → [5,1,5]・e=a=1、踊場付直進の側面 0 → 1。曲がり階段ほかは {}', () => {
  const l = new Stair('l', { type: StairType.L_TURN, sections: [6, 1, 6] });
  const fixed = alignPortTurnSteps(l, { entry: 'side', arrival: 'side' });
  assert.deepEqual(fixed, { entryTurnSteps: 1, sections: [5, 1, 5], arrivalTurnSteps: 1 });
  const sl = new Stair('s', { type: StairType.STRAIGHT_LANDING, sections: [8, 1, 9] });
  assert.deepEqual(alignPortTurnSteps(sl, { entry: 'side', arrival: 'end' }), { entryTurnSteps: 1, sections: [7, 1, 9] });
  assert.deepEqual(alignPortTurnSteps(new Stair('f', { type: StairType.FLARED, sections: [8, 2, 8] }), { entry: 'side', arrival: 'side' }), {});
});

// 境界（読込み時の alignPortStairsOnGraph）: 2列×3行のセル格子 d c / a b / e f。f,b,c,d,a は往路が f から張り出し、上り口が側面（自動＝内側）に解決される
function portGraph(order = ['f', 'b', 'c', 'd', 'a']) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const V = (v) => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = (v) => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), x1 = V(1000), x2 = V(2000), y0 = H(0), y1 = H(1000), y2 = H(2000), y3 = H(3000);
  const k = (l, t, r, b) => `${l.id}:${t.id}:${r.id}:${b.id}`;
  const c = { d: k(x0, y0, x1, y1), c: k(x1, y0, x2, y1), a: k(x0, y1, x1, y2), b: k(x1, y1, x2, y2), e: k(x0, y2, x1, y3), f: k(x1, y2, x2, y3) };
  const keys = order.map(n => c[n]);
  const cells = new Set(keys);
  const cls = classifyStairArea(cells, graph, 2800, keys);
  return { graph, cells, cls };
}
// 保存済みの旧データ（moku1-6 型: 側面の上り口で蹴上 0 の平場）を作る。蹴上ぶんは直進部へ戻して総蹴上数を保つ
function legacyStair(graph, cells, cls, structure) {
  const sections = [...cls.sections];
  sections[0] += cls.entryTurnSteps ?? 0;
  sections[2] += cls.arrivalTurnSteps ?? 0;
  return graph.addStair({
    type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections, structure,
    entryTurnSteps: 0, arrivalTurnSteps: 0,
  });
}

test('alignPortStairsOnGraph: 木造・側面の上り口・e=0 の保存データは e=1・往路 −1・総蹴上数不変になり、2 回通しても冪等。鉄骨は不変', () => {
  const { graph, cells, cls } = portGraph();
  assert.ok((cls.entryTurnSteps ?? 0) >= 1, 'フィクスチャ前提: 木造の既定は側面の口で 1 以上');
  const wood = legacyStair(graph, cells, cls, StructuralMaterialType.WOOD);
  const total = wood.totalSteps;
  const run0 = wood.sections[0];
  assert.equal(alignPortStairsOnGraph(graph), true);
  assert.equal(wood.entryTurnSteps, 1);
  assert.equal(wood.sections[0], run0 - 1);
  assert.equal(wood.totalSteps, total);
  assert.equal(alignPortStairsOnGraph(graph), false, '冪等');
  assert.equal(wood.entryTurnSteps, 1);

  const steel = portGraph();
  const st = legacyStair(steel.graph, steel.cells, steel.cls, StructuralMaterialType.STEEL);
  const before = JSON.stringify([st.entryTurnSteps, st.sections, st.totalSteps]);
  assert.equal(alignPortStairsOnGraph(steel.graph), false);
  assert.equal(JSON.stringify([st.entryTurnSteps, st.sections, st.totalSteps]), before, '鉄骨の平場 0 は不変');
});

test('alignPortStairsOnGraph: 復路が張り出す b,c,d,a,e の到達口は a 0→1・復路 sections[2] −1・総蹴上数不変。鉄骨は不変', () => {
  const order = ['b', 'c', 'd', 'a', 'e'];
  const { graph, cells, cls } = portGraph(order);
  assert.ok((cls.arrivalTurnSteps ?? 0) >= 1, 'フィクスチャ前提: 到達口が側面');
  const wood = legacyStair(graph, cells, cls, StructuralMaterialType.WOOD);
  const total = wood.totalSteps, run2 = wood.sections[2], run0 = wood.sections[0];
  assert.equal(alignPortStairsOnGraph(graph), true);
  assert.equal(wood.arrivalTurnSteps, 1);
  assert.equal(wood.sections[2], run2 - 1);
  assert.equal(wood.sections[0], run0, '往路は触らない');
  assert.equal(wood.totalSteps, total);
  const steel = portGraph(order);
  const st = legacyStair(steel.graph, steel.cells, steel.cls, StructuralMaterialType.STEEL);
  assert.equal(alignPortStairsOnGraph(steel.graph), false);
  assert.equal(st.arrivalTurnSteps, 0);
});

test('alignPortStairsOnGraph: 走行端に蹴上が残った階段（両方 >0 の事前除外をしない）は 0 へ戻し、直進部へ返す', () => {
  const { graph, cells, cls } = portGraph(['b', 'c', 'd', 'a']);
  const s = graph.addStair({ type: cls.type, cells, upDirection: cls.upDirection, flip: cls.flip, sections: [5, 1, 5], entryTurnSteps: 2, arrivalTurnSteps: 2 });
  const total = s.totalSteps;
  assert.equal(alignPortStairsOnGraph(graph), true);
  assert.deepEqual([s.entryTurnSteps, s.arrivalTurnSteps, s.totalSteps], [0, 0, total]);
});

test('【失敗系】alignPortStairsOnGraph: 階段が無い・出入口が走行端・出入口を選べない型の graph は何も書かず false', () => {
  assert.equal(alignPortStairsOnGraph(new PlanGraph(new Plane('p', 0, '1階', 1, 1))), false);
  const { graph, cells } = portGraph();
  // 出入口を選べない型（曲がり階段）は対象外
  const s = graph.addStair({ type: StairType.FLARED, cells, sections: [5, 2, 5], entryTurnSteps: 0 });
  assert.equal(alignPortStairsOnGraph(graph), false);
  assert.equal(s.entryTurnSteps, 0);
});
