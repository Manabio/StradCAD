// 屋根区画 S3: 仕上げモードの平面で区画を作る・選ぶ・消す（roofZonePickActive / selectedRoofZoneId / removeRoofZone）。
// 最上階の判定は core/project.js isTopFloorPlane（project.planes の末尾）。テストでは { planes: [...] } で足りる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { undoManager } from '../undoManager.js';
import { worldToCell } from '../finish/gridCells.js';
import { roofZoneEffectiveCells } from '../finish/roof/roofZones.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

// 左(0-2000)・中(2000-4000)・右(4000-6000)の3セル。部屋は左+中（建物範囲）。右は範囲外。
function setup() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  const graph = new PlanGraph(plane);
  for (const v of [0, 2000, 4000, 6000]) graph.addCenterLine(CenterLineType.VERTICAL, v, ARCH);
  for (const v of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, v, ARCH);
  const left = worldToCell(1000, 1500, graph).key;
  const mid = worldToCell(3000, 1500, graph).key;
  const right = worldToCell(5000, 1500, graph).key;
  graph.addRoom(new Set([left, mid]), '居間');
  const project = { planes: [plane] };
  const state = new FinishModeState(graph, project);
  return { graph, state, project, left, mid, right };
}

const L = [1000, 1500];
const M = [3000, 1500];
const R = [5000, 1500];

/** pick 中に (from)→(to...) をなぞって確定する。 */
function trace(state, from, ...rest) {
  state.startDrag(...from);
  for (const p of rest) state.updateDrag(...p);
  state.commitDrag();
}

const stack = () => undoManager._undoStack.length;

test('【S3】指定中に建物範囲の2セルをなぞると区画が1つできる。undo 1エントリ・undo で消え redo で戻る・作った区画が選択され指定は続く', () => {
  const { graph, state, left, mid } = setup();
  state.setRoofZonePick(true);
  assert.equal(state.roofZonePickActive, true);
  const before = stack();
  trace(state, L, M);
  assert.equal(graph.roofZones.length, 1);
  assert.deepEqual([...graph.roofZones[0].cells].sort(), [left, mid].sort());
  assert.equal(stack(), before + 1);
  assert.equal(state.selectedRoofZoneId, graph.roofZones[0].id);
  assert.equal(state.dragState, null);
  assert.equal(state.roofZonePickActive, true, '続けて別の区画を指定できる');
  assert.equal(state.namingRoomId, null, '部屋の命名ダイアログは開かない');
  undoManager.undo();
  assert.equal(graph.roofZones.length, 0);
  undoManager.redo();
  assert.equal(graph.roofZones.length, 1);
});

test('【S3】区画の初期仕様は主屋根の値を写し、形状・高い側は自動（null）', () => {
  const { graph, state } = setup();
  state.setMainRoofField('slope', 5);
  state.setRoofZonePick(true);
  trace(state, L);
  assert.equal(graph.roofZones[0].spec.slope, 5);
  assert.equal(graph.roofZones[0].spec.shape, null);
});

test('【S3】後から作った区画が既存区画のセルを奪う（古い区画は縮み、全部奪われたら消える）', () => {
  const { graph, state, left, mid } = setup();
  state.setRoofZonePick(true);
  trace(state, L, M); // 区画1 = 左+中
  trace(state, M);    // 区画2 = 中（区画1から奪う）
  assert.equal(graph.roofZones.length, 2);
  assert.deepEqual([...graph.roofZones[0].cells], [left]);
  assert.deepEqual([...graph.roofZones[1].cells], [mid]);
  trace(state, L, M); // 区画3 = 左+中（区画1・2は全部奪われる）
  assert.equal(graph.roofZones.length, 1);
  assert.equal(state.selectedRoofZoneId, graph.roofZones[0].id);
});

test('【S3・失敗系】建物範囲外のセルは無視される（中→右をなぞっても区画は中だけ）', () => {
  const { graph, state, mid, right } = setup();
  state.setRoofZonePick(true);
  trace(state, M, R);
  assert.equal(graph.roofZones.length, 1);
  assert.deepEqual([...graph.roofZones[0].cells], [mid]);
  assert.ok(!roofZoneEffectiveCells(graph.roofZones[0], graph).has(right));
});

test('【S3・失敗系】範囲外のセルだけをなぞっても区画も undo も作らない。範囲外から始めて範囲内へ入れば範囲内だけで作る', () => {
  const { graph, state, mid } = setup();
  state.setRoofZonePick(true);
  const before = stack();
  trace(state, R);
  assert.equal(graph.roofZones.length, 0);
  assert.equal(stack(), before);
  assert.equal(state.dragState, null);
  trace(state, R, M);
  assert.deepEqual(graph.roofZones.map(z => [...z.cells]), [[mid]]);
  assert.equal(stack(), before + 1);
});

test('【S3】指定中に既存区画のセルをタップすると、その区画を選択するだけ（書込みなし・undo なし）', () => {
  const { graph, state } = setup();
  state.setRoofZonePick(true);
  trace(state, L);          // 区画A = 左
  trace(state, M);          // 区画B = 中（選択中）
  const [a, b] = graph.roofZones.map(z => z.id);
  const before = stack();
  const snapshot = JSON.stringify(graph.roofZones.map(z => z.toData()));
  state.startDrag(...L);
  state.commitDrag({ tap: true });
  assert.equal(state.selectedRoofZoneId, a);
  assert.notEqual(state.selectedRoofZoneId, b);
  assert.equal(stack(), before);
  assert.equal(JSON.stringify(graph.roofZones.map(z => z.toData())), snapshot);
});

test('【S3】指定中のなぞりは部屋の選択・命名に回らない（区画を選ぶと部屋の選択は外れ、部屋は増えない）', () => {
  const { graph, state } = setup();
  const room = graph.rooms[0];
  state.selectRoom(room.id);
  state.setRoofZonePick(true);
  trace(state, L);
  assert.equal(state.selectedRoomId, null, '区画を選ぶと部屋の選択は外れる');
  assert.equal(graph.roomMap.size, 1, '部屋は増えない');
});

test('【S3】指定が偽なら従来の部屋のなぞり（範囲外の右セルで新規部屋のダイアログが開く）', () => {
  const { graph, state } = setup();
  assert.equal(state.roofZonePickActive, false);
  trace(state, R);
  assert.ok(state.namingRoomId, '従来どおり新規部屋のダイアログ');
  assert.equal(graph.roofZones.length, 0);
});

test('【S3・失敗系】setRoofZonePick(true): 最上階でない階・project なしでは真にならない。偽にすると途中のなぞりも捨てる', () => {
  const { graph, project } = setup();
  const upper = new Plane('p2', 3000, '2階', 2, 1);
  const lowerState = new FinishModeState(graph, { planes: [graph.plane, upper] });
  lowerState.setRoofZonePick(true);
  assert.equal(lowerState.roofZonePickActive, false);
  lowerState.toggleRoofZonePick();
  assert.equal(lowerState.roofZonePickActive, false);
  const noProject = new FinishModeState(graph, null);
  noProject.setRoofZonePick(true);
  assert.equal(noProject.roofZonePickActive, false);

  const state = new FinishModeState(graph, project);
  state.toggleRoofZonePick();
  assert.equal(state.roofZonePickActive, true);
  state.startDrag(...L);
  assert.ok(state.dragState);
  state.toggleRoofZonePick();
  assert.equal(state.roofZonePickActive, false);
  assert.equal(state.dragState, null);
});

test('【S3・失敗系】オンのまま表示中の階が最上階でなくなったら（階の並べ替え・階変更）区画の指定には入らず、外形も空（QA 指摘。判定は使う側で毎回）', () => {
  const { graph, state, project } = setup();
  state.setRoofZonePick(true);
  trace(state, L);
  assert.equal(graph.roofZones.length, 1);
  assert.equal(state.roofZoneOutlines.length, 1, '前提: 最上階なら外形が出る');
  project.planes.push(new Plane('p2', 3000, '2階', 2, 1)); // 表示中の階の上に階が来た（FinishModeState は作り直されない）
  assert.equal(state.roofZonePickActive, true, 'フラグ自体は残る');
  assert.equal(state.roofZonePicking, false);
  assert.deepEqual(state.roofZoneOutlines, [], '外形は出さない');
  const stack0 = stack();
  trace(state, R);
  assert.ok(state.namingRoomId, '普段の部屋のなぞりに戻る（新規部屋のダイアログ）');
  assert.equal(graph.roofZones.length, 1, '休眠した階に区画を書き続けない');
  assert.equal(stack(), stack0);
});

test('【S3】指定中に建物範囲の未指定セルをクリック（tap）すると、そのセルだけの区画ができる（undo 1件）', () => {
  const { graph, state, left } = setup();
  state.setRoofZonePick(true);
  const stack0 = stack();
  state.startDrag(...L);
  state.commitDrag({ tap: true });
  assert.equal(graph.roofZones.length, 1);
  assert.deepEqual([...roofZoneEffectiveCells(graph.roofZones[0], graph)], [left]);
  assert.equal(stack(), stack0 + 1);
});

test('【S3】最上階の検討案でも指定できる（isAlternative・referenceId＝最上階）', () => {
  const top = new Plane('p1', 0, '1階', 1, 1);
  const alt = new Plane('p1-a', 0, '1階 案', 1, 1, true, 'p1', 1);
  const graph = new PlanGraph(alt);
  const state = new FinishModeState(graph, { planes: [top] });
  state.setRoofZonePick(true);
  assert.equal(state.roofZonePickActive, true);
  assert.equal(state.roofZonePicking, true);
});

test('【S3】dispose で指定中フラグと区画の選択を戻す', () => {
  const { state } = setup();
  state.setRoofZonePick(true);
  trace(state, L);
  assert.ok(state.selectedRoofZoneId);
  state.dispose();
  assert.equal(state.roofZonePickActive, false);
  assert.equal(state.selectedRoofZoneId, null);
});

test('【S3】removeRoofZone: 確認なしで消え undo 1エントリ・undo で戻る。選択中の区画なら選択も外れる', () => {
  const { graph, state } = setup();
  state.setRoofZonePick(true);
  trace(state, L);
  const id = graph.roofZones[0].id;
  assert.equal(state.selectedRoofZoneId, id);
  const before = stack();
  assert.equal(state.removeRoofZone(id), true);
  assert.equal(graph.roofZones.length, 0);
  assert.equal(stack(), before + 1);
  assert.equal(state.selectedRoofZoneId, null);
  undoManager.undo();
  assert.deepEqual(graph.roofZones.map(z => z.id), [id]);
});

test('【S3・失敗系】removeRoofZone: 存在しない id は false で何も変えない（undo なし・選択も保つ）', () => {
  const { graph, state } = setup();
  state.setRoofZonePick(true);
  trace(state, L);
  const sel = state.selectedRoofZoneId;
  const before = stack();
  assert.equal(state.removeRoofZone('ghost'), false);
  assert.equal(state.removeRoofZone(undefined), false);
  assert.equal(graph.roofZones.length, 1);
  assert.equal(stack(), before);
  assert.equal(state.selectedRoofZoneId, sel);
});

test('【S3】選択の排他: 区画を選ぶと部屋・階段・器具の選択が外れ、部屋・階段・器具を選ぶと区画の選択が外れる', () => {
  const { graph, state } = setup();
  state.selectedRoomId = graph.rooms[0].id;
  state.selectedEquipmentId = 'eq';
  state.selectRoofZone('z');
  assert.deepEqual([state.selectedRoomId, state.selectedStairId, state.selectedEquipmentId, state.selectedRoofZoneId], [null, null, null, 'z']);
  state.selectRoom(graph.rooms[0].id);
  assert.equal(state.selectedRoofZoneId, null);
  state.selectRoofZone('z');
  state.selectEquipment('eq');
  assert.equal(state.selectedRoofZoneId, null);
  state.selectRoofZone('z');
  state.selectStair('nope');
  assert.equal(state.selectedRoofZoneId, null);
});

test('【S3】roofZoneOutlines: 指定中だけ区画の外形を返し、指定を終えると空', () => {
  const { state } = setup();
  state.setRoofZonePick(true);
  trace(state, L, M);
  assert.equal(state.roofZoneOutlines.length, 1);
  assert.equal(state.roofZoneOutlines[0].boundsList.length, 2);
  assert.deepEqual(state.roofZoneOutlines[0].segments.filter(s => s.isVertical).map(s => s.value).sort((p, q) => p - q), [0, 4000], '縦は左右の外周だけ（中の仕切りは出ない）');
  state.setRoofZonePick(false);
  assert.deepEqual(state.roofZoneOutlines, []);
});
