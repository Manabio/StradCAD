// withFinishUndo が per-floor 設定（PER_FLOOR_SETTERS）を before/after スナップショットの
// 対象に含めているかのテスト。含まれていないと undo しても値が戻らない
// （§昇降路 壁仕上げ材／防音材 ステップ2b の PER_FLOOR_SETTERS 追加分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Plane, PlanGraph, ShaftSoundproof, ElevatorEquipmentCategory, DEFAULT_EV_USAGE, EvUsage,
  Stair, StairType, StairPortSide, StructuralMaterialType, totalStepsFromSections,
  RoomKind, RoomFeature, RoofSpec, ROOF_SPEC_KEYS,
} from '../core.js';
import { NON_DEFAULT_ROOF_SPEC } from './roofTestFixtures.js';
import { undoManager } from '../undoManager.js';
import { withFinishUndo, snapshotFinishState, restoreFinishState } from './finishUndo.js';

function freshGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}

test('shaftWallMaterial を withFinishUndo 経由で変えて undo すると元の値に戻る', () => {
  const graph = freshGraph();
  const before = graph.shaftWallMaterial;
  const after  = '301000000005';
  assert.notEqual(before, after, '前提: 変更後の値は既定値と異なる');

  withFinishUndo(graph, () => graph.setShaftWallMaterial(after));
  assert.equal(graph.shaftWallMaterial, after);

  undoManager.undo();
  assert.equal(graph.shaftWallMaterial, before, 'undo で既定値に戻らない');

  undoManager.redo();
  assert.equal(graph.shaftWallMaterial, after, 'redo で変更後の値に戻らない');
});

test('shaftSoundproof を withFinishUndo 経由で変えて undo すると元の値に戻る', () => {
  const graph = freshGraph();
  const before = graph.shaftSoundproof;
  assert.equal(before, ShaftSoundproof.NONE, '前提: 既定値は none');

  withFinishUndo(graph, () => graph.setShaftSoundproof(ShaftSoundproof.INSULATION));
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.INSULATION);

  undoManager.undo();
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.NONE, 'undo で既定値に戻らない');

  undoManager.redo();
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.INSULATION, 'redo で変更後の値に戻らない');
});

test('graph.equipmentRows の追加を withFinishUndo 経由で行い undo/redo すると器具行が消えたり戻ったりする', () => {
  const graph = freshGraph();
  assert.equal(graph.equipmentRows.length, 0, '前提: 変更前は0件');

  withFinishUndo(graph, () => graph.addEquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: DEFAULT_EV_USAGE, no: 1,
    cellKeys: new Set(['a:b:c:d']),
  }));
  assert.equal(graph.equipmentRows.length, 1);
  assert.equal(graph.equipmentRows[0].id, 'eq1');

  undoManager.undo();
  assert.equal(graph.equipmentRows.length, 0, 'undo で器具行が消えない');

  undoManager.redo();
  assert.equal(graph.equipmentRows.length, 1, 'redo で器具行が戻らない');
  assert.equal(graph.equipmentRows[0].id, 'eq1', 'redo後も同じidで復元されていない');
});

test('graph.equipmentRows の usage 変更を withFinishUndo 経由で行い undo すると元の用途に戻る（同id維持）', () => {
  const graph = freshGraph();
  const row = graph.addEquipmentRow({
    id: 'eq1', category: ElevatorEquipmentCategory.EV, usage: EvUsage.PASSENGER, no: 1,
    cellKeys: new Set(['a:b:c:d']),
  });

  withFinishUndo(graph, () => row.setUsage(EvUsage.FREIGHT));
  assert.equal(graph.equipmentRows[0].usage, EvUsage.FREIGHT);

  undoManager.undo();
  assert.equal(graph.equipmentRows[0].usage, EvUsage.PASSENGER, 'undo で用途が戻らない');
  assert.equal(graph.equipmentRows[0].id, 'eq1', 'undo後も同じidのまま');

  undoManager.redo();
  assert.equal(graph.equipmentRows[0].usage, EvUsage.FREIGHT, 'redo で用途が戻らない');
});

// ---- 階段の出入口の辺・取りつき回転部（entrySide / arrivalSide / entryTurnSteps / arrivalTurnSteps） ----

// 折返し階段（sections あり）。sections [7,2,7] の区間の和は 15（totalStepsFromSections）、回転部 2+3 で 20
function addSwitchbackStair(graph) {
  return graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set(['a:b:c:d']), sections: [7, 2, 7],
    entrySide: StairPortSide.INNER, arrivalSide: StairPortSide.OUTER,
    entryTurnSteps: 2, arrivalTurnSteps: 3,
  }, 's1');
}

function portFields(s) {
  return {
    entrySide: s.entrySide, arrivalSide: s.arrivalSide,
    entryTurnSteps: s.entryTurnSteps, arrivalTurnSteps: s.arrivalTurnSteps,
    totalSteps: s.totalSteps,
  };
}

test('別の仕上げ操作を undo/redo しても、階段の出入口の辺・取りつき回転部・総段数が保たれる', () => {
  const graph = freshGraph();
  const stair = addSwitchbackStair(graph);
  const expected = {
    entrySide: 'inner', arrivalSide: 'outer', entryTurnSteps: 2, arrivalTurnSteps: 3,
    totalSteps: totalStepsFromSections([7, 2, 7]) + 5,
  };
  assert.deepStrictEqual(portFields(stair), expected, '前提: 作成直後の値');
  assert.equal(expected.totalSteps, 20, '前提: 区間の和15＋回転部5');

  const marker = '301000000005';
  const markerBefore = graph.shaftWallMaterial;
  assert.notEqual(markerBefore, marker, '前提: 変更後の値は既定値と異なる');
  withFinishUndo(graph, () => graph.setShaftWallMaterial(marker));

  undoManager.undo();
  assert.equal(graph.shaftWallMaterial, markerBefore, 'undo で対象エントリが戻っていない（積まれていない）');
  assert.deepStrictEqual(portFields(graph.stairMap.get('s1')), expected, 'undo で階段の4項目・総段数が変わった');

  undoManager.redo();
  assert.equal(graph.shaftWallMaterial, marker, 'redo で対象エントリが戻っていない');
  assert.deepStrictEqual(portFields(graph.stairMap.get('s1')), expected, 'redo で階段の4項目・総段数が変わった');
});

test('出入口の辺だけの切替（回転部・総段数は不変）が undo エントリとして積まれ、undo/redo で往復する', () => {
  const graph = freshGraph();
  const stair = addSwitchbackStair(graph);
  const marker = '301000000005';
  const markerBefore = graph.shaftWallMaterial;

  // 直前に別操作を積み、辺の切替が積まれなかった場合は undo 1回でこちらが戻って赤になるようにする
  withFinishUndo(graph, () => graph.setShaftWallMaterial(marker));
  withFinishUndo(graph, () => stair.setField('entrySide', StairPortSide.OUTER));
  assert.equal(graph.stairMap.get('s1').entrySide, 'outer');

  undoManager.undo();
  assert.equal(graph.stairMap.get('s1').entrySide, 'inner', 'undo で辺が inner に戻らない（エントリが積まれていない）');
  assert.equal(graph.shaftWallMaterial, marker, 'undo 1回で直前の別操作まで戻った（辺の切替が積まれていない）');

  undoManager.redo();
  assert.equal(graph.stairMap.get('s1').entrySide, 'outer', 'redo で辺が outer に戻らない');

  undoManager.undo();
  undoManager.undo();
  assert.equal(graph.shaftWallMaterial, markerBefore, '後始末: 別操作も戻しておく');
});

test('4項目のキーが欠けたスナップショットを復元すると、辺は null・回転部は 0 に正規化され例外にならない', () => {
  const graph = freshGraph();
  addSwitchbackStair(graph);
  const snap = snapshotFinishState(graph);
  for (const k of ['entrySide', 'arrivalSide', 'entryTurnSteps', 'arrivalTurnSteps']) delete snap.stairs.stairs[0][k];

  assert.doesNotThrow(() => restoreFinishState(graph, snap));
  const s = graph.stairMap.get('s1');
  assert.strictEqual(s.entrySide, null);
  assert.strictEqual(s.arrivalSide, null);
  assert.strictEqual(s.entryTurnSteps, 0);
  assert.strictEqual(s.arrivalTurnSteps, 0);
});

test('4項目が null のスナップショットを復元すると、回転部は 0 に正規化される', () => {
  const graph = freshGraph();
  addSwitchbackStair(graph);
  const snap = snapshotFinishState(graph);
  for (const k of ['entrySide', 'arrivalSide', 'entryTurnSteps', 'arrivalTurnSteps']) snap.stairs.stairs[0][k] = null;

  assert.doesNotThrow(() => restoreFinishState(graph, snap));
  const s = graph.stairMap.get('s1');
  assert.strictEqual(s.entrySide, null);
  assert.strictEqual(s.arrivalSide, null);
  assert.strictEqual(s.entryTurnSteps, 0);
  assert.strictEqual(s.arrivalTurnSteps, 0);
  assert.strictEqual(s.totalSteps, totalStepsFromSections([7, 2, 7]));
  assert.strictEqual(s.totalSteps, 15, '区間の和のみ（回転部 0）');
});

test('不変条件: 全項目を既定値以外にした階段は snapshot→restore→snapshot で一致し、各項目が復元される', () => {
  // Stair の全17項目（id 含む）を既定値以外にした fixture。項目が増えたらここへの追加を強制する
  const fixture = {
    id: 's1',
    type: StairType.SWITCHBACK, structure: StructuralMaterialType.STEEL,
    cells: new Set(['a:b:c:d']), sections: [7, 2, 7],
    totalSteps: totalStepsFromSections([7, 2, 7]) + 5,
    tread: 260, riser: 180, nosing: 25, width: 1000, upDirection: 'up', flip: true, roomId: 'r1',
    entrySide: StairPortSide.INNER, arrivalSide: StairPortSide.OUTER,
    entryTurnSteps: 2, arrivalTurnSteps: 3,
  };
  const defaults = new Stair('d', {});
  assert.deepStrictEqual(Object.keys(fixture).sort(), Object.keys(defaults).sort(),
    'Stair の項目と fixture のキー集合が不一致（項目を足したら fixture にも足す）');
  for (const k of Object.keys(fixture)) {
    if (k === 'id') continue;
    assert.notDeepStrictEqual(fixture[k], defaults[k], '前提: fixture の ' + k + ' は既定値以外');
  }
  assert.equal(fixture.totalSteps, 20);

  const graph = freshGraph();
  const { id, ...opts } = fixture;
  graph.addStair(opts, id);
  const before = snapshotFinishState(graph);
  restoreFinishState(graph, before);

  const s = graph.stairMap.get('s1');
  for (const k of Object.keys(fixture)) {
    const actual = k === 'cells' ? [...s.cells] : s[k];
    const exp = k === 'cells' ? [...fixture.cells] : fixture[k];
    assert.deepStrictEqual(actual, exp, '往復後に ' + k + ' が復元されない');
  }
  assert.equal(JSON.stringify(snapshotFinishState(graph)), JSON.stringify(before), '往復前後でスナップショットが一致しない');
});

test('不変条件: 仕上げ undo の階段スナップショットのキー集合は Stair の項目集合と一致する', () => {
  const graph = freshGraph();
  graph.addStair({ cells: new Set(['a:b:c:d']) }, 's1');
  const snapKeys = Object.keys(snapshotFinishState(graph).stairs.stairs[0]).sort();
  const stairKeys = Object.keys(new Stair('s', {})).sort();
  assert.deepStrictEqual(snapKeys, stairKeys,
    'Stair に項目を足したら finishUndo.js の snapshotStairs／restoreStairs にも足す');
});

// ---- 屋根の仕様（ステップB2。Room.roofSpec）。部屋の snapshot は roomReinterpret.snapshotRoomsState 経由 ----
function graphWithRoof() {
  const graph = freshGraph();
  const roof = graph.addRoom(new Set(['a:b:c:d']), '屋根');
  roof.setKind(RoomKind.EXTERIOR);
  roof.setFeature(RoomFeature.ROOF);
  roof.setRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  return { graph, roof };
}

test('不変条件: 仕上げ undo の snapshot の room.roofSpec のキー集合は ROOF_SPEC_KEYS と一致する', () => {
  const { graph } = graphWithRoof();
  const [roomSnap] = snapshotFinishState(graph).rooms.rooms;
  assert.deepStrictEqual(Object.keys(roomSnap.roofSpec).sort(), [...ROOF_SPEC_KEYS].sort(),
    'RoofSpec に項目を足したら roomReinterpret.js の snapshotRoomsState／restoreRoomsState にも足す（toData/fromData が唯一の定義）');
});

test('不変条件: 全項目を既定値以外にした RoofSpec は snapshot→restore→snapshot で一致し、各項目が復元される', () => {
  const { graph, roof } = graphWithRoof();
  const before = snapshotFinishState(graph);
  restoreFinishState(graph, before);
  const spec = graph.roomMap.get(roof.id).roofSpec;
  for (const k of ROOF_SPEC_KEYS) {
    assert.deepStrictEqual(spec[k], NON_DEFAULT_ROOF_SPEC[k], '往復後に ' + k + ' が復元されない');
  }
  assert.equal(JSON.stringify(snapshotFinishState(graph)), JSON.stringify(before), '往復前後でスナップショットが一致しない');
});

test('屋根の項目の変更を withFinishUndo で包むと undo/redo で戻る（1エントリ）', () => {
  const { graph, roof } = graphWithRoof();
  const stackBefore = undoManager._undoStack.length;
  withFinishUndo(graph, () => roof.roofSpec.setField('slope', 4));
  assert.equal(undoManager._undoStack.length, stackBefore + 1);
  assert.equal(graph.roomMap.get(roof.id).roofSpec.slope, 4);
  undoManager.undo();
  assert.equal(graph.roomMap.get(roof.id).roofSpec.slope, 2.5, 'undo で変更前（2.5）へ戻る');
  undoManager.redo();
  assert.equal(graph.roomMap.get(roof.id).roofSpec.slope, 4);
});

test('【C1b】highSide（null→明示）の変更を withFinishUndo で包むと undo/redo で null（自動）へ戻る（下屋・主屋根とも1エントリ）', () => {
  const { graph, roof } = graphWithRoof();
  roof.roofSpec.setField('highSide', null);
  const stackBefore = undoManager._undoStack.length;
  withFinishUndo(graph, () => roof.roofSpec.setField('highSide', 'left'));
  assert.equal(undoManager._undoStack.length, stackBefore + 1);
  undoManager.undo();
  assert.equal(graph.roomMap.get(roof.id).roofSpec.highSide, null);
  undoManager.redo();
  assert.equal(graph.roomMap.get(roof.id).roofSpec.highSide, 'left');

  const g2 = freshGraph();
  const before2 = undoManager._undoStack.length;
  withFinishUndo(g2, () => g2.mainRoofSpec.setField('highSide', 'top'));
  assert.equal(undoManager._undoStack.length, before2 + 1);
  undoManager.undo();
  assert.equal(g2.mainRoofSpec.highSide, null);
  undoManager.redo();
  assert.equal(g2.mainRoofSpec.highSide, 'top');
});

// ---- 主屋根（ステップB3。PlanGraph.mainRoofSpec。snapshot の `mainRoof` キー） ----
test('不変条件（B3）: 仕上げ undo の snapshot の mainRoof のキー集合は ROOF_SPEC_KEYS と一致する', () => {
  const graph = freshGraph();
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const snap = snapshotFinishState(graph);
  assert.deepStrictEqual(Object.keys(snap.mainRoof).sort(), [...ROOF_SPEC_KEYS].sort(),
    'RoofSpec に項目を足したら toData/fromData（唯一の定義）に足す。finishUndo の mainRoof は toData をそのまま採る');
});

test('不変条件（B3）: 全項目を既定値以外にした主屋根は snapshot→restore→snapshot で一致し、各項目が復元される', () => {
  const graph = freshGraph();
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const before = snapshotFinishState(graph);
  graph.setMainRoofSpec(new RoofSpec()); // 既定へ崩してから復元
  restoreFinishState(graph, before);
  for (const k of ROOF_SPEC_KEYS) {
    assert.deepStrictEqual(graph.mainRoofSpec[k], NON_DEFAULT_ROOF_SPEC[k], '往復後に ' + k + ' が復元されない');
  }
  assert.equal(JSON.stringify(snapshotFinishState(graph)), JSON.stringify(before));
});

test('主屋根の変更を withFinishUndo で包むと undo/redo で戻る（1エントリ）', () => {
  const graph = freshGraph();
  const stackBefore = undoManager._undoStack.length;
  withFinishUndo(graph, () => graph.mainRoofSpec.setField('slope', 4));
  assert.equal(undoManager._undoStack.length, stackBefore + 1);
  assert.equal(graph.mainRoofSpec.slope, 4);
  undoManager.undo();
  assert.equal(graph.mainRoofSpec.slope, 3, 'undo で既定の勾配3へ戻る');
  undoManager.redo();
  assert.equal(graph.mainRoofSpec.slope, 4);
});

test('主屋根を編集した後に別の仕上げ操作を挟んで undo/redo しても、主屋根の値は初期化されない（階段の4項目と同型の列挙漏れ対策）', () => {
  const graph = freshGraph();
  withFinishUndo(graph, () => graph.mainRoofSpec.setField('note', '主屋根メモ'));
  withFinishUndo(graph, () => graph.setShaftSoundproof(ShaftSoundproof.INSULATION)); // 別の操作
  undoManager.undo(); // 別の操作を戻す
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.NONE);
  assert.equal(graph.mainRoofSpec.note, '主屋根メモ', '別操作の undo で主屋根の値が失われない');
  undoManager.redo();
  assert.equal(graph.shaftSoundproof, ShaftSoundproof.INSULATION);
  assert.equal(graph.mainRoofSpec.note, '主屋根メモ', '別操作の redo でも保たれる');
  undoManager.undo();
  undoManager.undo(); // 主屋根の編集を戻す
  assert.equal(graph.mainRoofSpec.note, '');
});

test('restoreFinishState: 主屋根は snap.mainRoof で全置換される。旧スナップショット（mainRoof キー欠落）は既定値、壊れた値は正規化される', () => {
  const graph = freshGraph();
  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const snap = snapshotFinishState(freshGraph()); // 既定の主屋根
  restoreFinishState(graph, snap);
  assert.deepStrictEqual(graph.mainRoofSpec.toData(), new RoofSpec().toData(), 'snap の既定値で全置換');

  graph.setMainRoofSpec(RoofSpec.fromData(NON_DEFAULT_ROOF_SPEC));
  const legacy = { ...snap };
  delete legacy.mainRoof;
  restoreFinishState(graph, legacy);
  assert.deepStrictEqual(graph.mainRoofSpec.toData(), new RoofSpec().toData(), 'キー欠落は既定値');

  restoreFinishState(graph, { ...snap, mainRoof: { ...NON_DEFAULT_ROOF_SPEC, slope: -1, shape: 'dome', eaveOverhangMm: -1 } });
  assert.equal(graph.mainRoofSpec.slope, 3);
  assert.equal(graph.mainRoofSpec.shape, null);
  assert.equal(graph.mainRoofSpec.eaveOverhangMm, 455);
  assert.equal(graph.mainRoofSpec.note, NON_DEFAULT_ROOF_SPEC.note, '壊れていない項目は保たれる');
});
