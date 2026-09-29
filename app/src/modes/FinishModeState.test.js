// FinishModeState の部屋新規作成経路（QA G2）。mobx以外はDOM/IndexedDBに依存しないため
// node:testから直接importできる（ElevationModeState.test.jsと同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, applyDefaultBaseboard, RoomKind, RoomFeature } from '@core';
import { FinishModeState } from './FinishModeState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { restoreGraph, serializeGraph } from '../graphSnapshot.js';
import { takeUnresolvedCodes, addDocumentAliases, clearDocumentAliases } from '../catalog/codeNormalization.js';
import { worldToCell, refreshCells } from '../finish/gridCells.js';
import { undoManager } from '../undoManager.js';

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

// startDrag/commitDrag が使う regionCellsAt/worldToCell が拾えるよう、区切りCL（非labeled・
// discipline=ARCH・非dashed）で単一セルの矩形を作る（elevationFaces.test.js等と同じ方針）。
function makeSingleCellGraph() {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  return graph;
}

// ---- QA G2(b): ユーザーの新規部屋指定確定（commitDrag）経路でのみ巾木初期値が入る ----
test('FinishModeState.commitDrag: 未指定領域をドラッグして新規部屋を作ると巾木初期値(木製出幅木/h=60)が入る', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  state.startDrag(2000, 1500); // セル中央
  assert.ok(state.dragState, 'ドラッグが開始されるはず（regionCellsAtが単一セルを返す前提）');
  state.commitDrag();

  assert.ok(state.namingRoomId, '新規部屋のダイアログが開くはず');
  assert.equal(state.namingIsNew, true);
  const room = graph.roomMap.get(state.namingRoomId);
  assert.ok(room, '新規Roomが作られるはず');
  assert.equal(room.finish.baseboardMaterial, '木製出幅木');
  assert.equal(room.finish.baseboardHeight, 'h=60');
});

// ---- 単体: applyDefaultBaseboard は指定の2フィールドだけを初期値にする ----
test('applyDefaultBaseboard: baseboardMaterial/baseboardHeightへ既定値を設定する', () => {
  const graph = makeSingleCellGraph();
  const room = graph.addRoom(new Set(['dummy']), 'テスト');
  assert.equal(room.finish.baseboardMaterial, '', '適用前は空文字のまま（コンストラクタ既定値。QA G2）');

  applyDefaultBaseboard(room);
  assert.equal(room.finish.baseboardMaterial, '木製出幅木');
  assert.equal(room.finish.baseboardHeight, 'h=60');
});

// ---- 失敗系: 既存部屋の完全一致ドラッグ（判定1）はaddRoomを呼ばないため巾木初期値も付与しない ----
test('【失敗系・QA G2】FinishModeState.commitDrag: 既存部屋と完全一致するドラッグは新規Roomを作らない（巾木初期値の対象外）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  state.startDrag(2000, 1500);
  state.commitDrag();
  const firstRoomId = state.namingRoomId;
  const room = graph.roomMap.get(firstRoomId);
  room.finish.setField('baseboardMaterial', ''); // ユーザーが明示的にクリアした想定
  state.namingRoomId = null;

  // 同じ領域を再度ドラッグ（既存部屋と完全一致）→ 新規作成されない（判定1。ダイアログは開かない）
  state.startDrag(2000, 1500);
  state.commitDrag();

  assert.equal(state.namingRoomId, null, '判定1はダイアログを開かないはず（既存部屋の編集はカードへ移した）');
  assert.equal(state.selectedRoomId, firstRoomId, '既存部屋がそのまま選択されるはず（新規IDにならない）');
  assert.equal(graph.roomMap.get(firstRoomId).finish.baseboardMaterial, '',
    '既存部屋の完全一致ドラッグでユーザーのクリアが巾木初期値へ巻き戻ってはいけない');
});

// ================================================================
// ステップ1（部屋編集の導線変更）: commitDrag の判定1・判定3-部分指定・判定3-名前セルは
// ダイアログを開かず選択のみ（既存部屋の名称・区分・属性の編集は仕上げ表・内部タブのカードへ移した）。
// 判定2（統合）・判定3-その他セル/未指定（新規Room）は従来どおりダイアログを開く（回帰の固定）。
// ================================================================

// 3セル横並びグリッド: left[0,2000] / mid[2000,4000] / right[4000,6000] × y[0,3000]
// （各縦CLは非labeled・discipline=ARCH・非dashedのため regionCellsAt はセルをまたがない＝1クリック=1セル）
function makeThreeCellGraph() {
  const graph = makeGraph();
  graph.addCenterLine(CenterLineType.VERTICAL,   0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL,   2000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL,   4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL,   6000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.HORIZONTAL, 3000, { labeled: false, discipline: Discipline.ARCH });
  return graph;
}

test('FinishModeState.commitDrag【判定3-名前セル】: 単一部屋の名前セルをドラッグすると選択のみ（ダイアログ・undoエントリなし）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  // left+midの2セルからなる単一の親部屋（referenceRoomIds空）。名前セルをleftへ明示固定する。
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);
  const room = graph.addRoom(new Set([leftCell.key, midCell.key]), '部屋');
  room.setNamePosition(1000, 1500); // アンカーをleftセルへ固定（roomLabel.js roomNameAnchor）

  const undoCountBefore = undoManager._undoStack.length;
  state.startDrag(1000, 1500); // leftセルのみをドラッグ（親部屋の全セルとは不一致）
  state.commitDrag();

  assert.equal(state.namingRoomId, null, '判定3-名前セルはダイアログを開かないはず');
  assert.equal(state.selectedRoomId, room.id, '名前セルの部屋が選択されるはず');
  assert.equal(state.dragState, null);
  assert.deepEqual([...refreshCells(room.cells, graph)].sort(), [leftCell.key, midCell.key].sort(),
    '部屋のセルは変わらないはず');
  assert.equal(undoManager._undoStack.length, undoCountBefore, 'undoエントリを積まないはず');
});

test('FinishModeState.commitDrag【判定3-部分指定】: 部分指定を含む重複ドラッグ（完全一致・完全包含のいずれでもない）は部分指定を選択のみ', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const midCell   = worldToCell(3000, 1500, graph);
  const leftCell  = worldToCell(1000, 1500, graph);
  const parent  = graph.addRoom(new Set([leftCell.key, midCell.key]), '親');
  const partial = graph.addRoom(new Set([midCell.key]), '子', crypto.randomUUID(), new Set([parent.id]));

  const undoCountBefore = undoManager._undoStack.length;
  state.startDrag(3000, 1500); // 開始セル=mid（部分指定の唯一のセル）
  state.updateDrag(5000, 1500); // rightセルも含めて完全一致・完全包含のどちらも崩す
  state.commitDrag();

  assert.equal(state.namingRoomId, null, '判定3-部分指定はダイアログを開かないはず');
  assert.equal(state.selectedRoomId, partial.id, '部分指定が選択されるはず');
  assert.deepEqual([...refreshCells(partial.cells, graph)], [midCell.key], '部分指定のセルは変わらないはず');
  assert.deepEqual([...refreshCells(parent.cells, graph)].sort(), [leftCell.key, midCell.key].sort(),
    '親のセルも変わらないはず');
  assert.equal(undoManager._undoStack.length, undoCountBefore, 'undoエントリを積まないはず');
});

test('FinishModeState.startDrag【優先1】: 自階階段（破れ線手前）のクリックは階段の選択のみ（stair.roomIdのRoomがあってもダイアログを開かない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const cell = worldToCell(2000, 1500, graph);
  const room = graph.addRoom(new Set([cell.key]), '階段');
  room.setFeature(RoomFeature.STAIR);
  const stair = graph.addStair({ type: 'straight', cells: new Set([cell.key]), roomId: room.id });

  state.startDrag(2000, 1500);

  assert.equal(state.namingRoomId, null, '優先1はダイアログを開かないはず（stair.roomIdのRoomがあっても）');
  assert.equal(state.selectedStairId, stair.id, '階段が選択されるはず');
});

// ---- 回帰の固定: 判定2（統合）・判定3-その他セル/未指定（新規Room）は従来どおりダイアログを開く ----

test('【回帰】FinishModeState.commitDrag【判定2】: 複数部屋を完全包含する統合ドラッグはダイアログを開く（新規Room扱いではなく既存dominantの命名）', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);
  const roomA = graph.addRoom(new Set([leftCell.key]), 'A');
  const roomB = graph.addRoom(new Set([midCell.key]), 'B');

  state.startDrag(1000, 1500);
  state.updateDrag(3000, 1500); // left+midの両方を完全包含
  state.commitDrag();

  assert.ok(state.namingRoomId, '判定2はダイアログを開くはず');
  assert.equal(state.namingIsNew, false, '統合は既存dominantの命名扱い（新規Roomではない）');
  assert.ok(state.namingRoomId === roomA.id || state.namingRoomId === roomB.id);
});

test('【回帰】FinishModeState.commitDrag【判定3-未指定】: 未指定領域のドラッグは新規Roomのダイアログを開く', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  state.startDrag(2000, 1500);
  state.commitDrag();

  assert.ok(state.namingRoomId);
  assert.equal(state.namingIsNew, true);
});

test('【回帰】FinishModeState.commitDrag【判定3-その他セル】: 親/単一部屋の名前セル以外をドラッグすると新規部分指定のダイアログを開く', () => {
  const graph = makeThreeCellGraph();
  const state = new FinishModeState(graph, null);
  const leftCell = worldToCell(1000, 1500, graph);
  const midCell  = worldToCell(3000, 1500, graph);
  const parent = graph.addRoom(new Set([leftCell.key, midCell.key]), '親');
  parent.setNamePosition(1000, 1500); // 名前セルはleft。midは「その他セル」になる

  const undoCountBefore = undoManager._undoStack.length;
  state.startDrag(3000, 1500); // midのみ（親の名前セルではない・親の全セルとも不一致）
  state.commitDrag();

  assert.equal(state.namingIsNew, true, '判定3-その他セルは新規部分指定のダイアログを開くはず');
  assert.ok(state.namingRoomId, 'ダイアログを開くはず');
  assert.notEqual(state.namingRoomId, parent.id, '新規に作られた部分指定のIDのはず（親のIDではない）');
  const newRoom = graph.roomMap.get(state.namingRoomId);
  assert.ok(newRoom, '新規部分指定のRoomが作られるはず');
  assert.deepEqual([...newRoom.referenceRoomIds], [parent.id], '新規部分指定は親を参照するはず');
  // 新規作成（判定3）はダイアログ確定（applyNaming）までundoを保留する契約——この時点ではまだ積まれない
  assert.equal(undoManager._undoStack.length, undoCountBefore, 'ダイアログ確定前はundoを積まないはず');
});

// ---- 屋外部屋（非階段）の外部タブ連動（_syncExteriorRows）----
test('applyNaming: 非階段の部屋をkind=EXTERIORで確定するとexteriorRowsに部位=名前・roomId=部屋IDの行が1件追加される', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');

  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });

  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].part, 'テラス');
});

test('applyNaming: 同じ屋外部屋を別名で再確定すると行は1件のままpartが更新される', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');

  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  state.applyNaming(room.id, { name: 'バルコニー', kind: RoomKind.EXTERIOR, feature: null });

  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1, '行は増えず1件のまま');
  assert.equal(rows[0].part, 'バルコニー');
});

test('applyNaming: 屋外部屋を屋内(kind=INTERIOR)へ再確定するとexteriorRowsの連動行が消える', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');

  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 1);

  state.applyNaming(room.id, { name: '部屋', kind: RoomKind.INTERIOR, feature: null });

  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 0);
});

test('deleteRoom: 非階段の屋外部屋を削除するとexteriorRowsの連動行が消える', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');
  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 1);

  state.deleteRoom(room.id);

  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 0);
  assert.equal(graph.roomMap.has(room.id), false);
});

// ---- 失敗系: 存在しないroomIdはexteriorRowsを増やさない ----
test('【失敗系】applyNaming: 存在しないroomIdを渡すとnullを返しexteriorRowsは増えない', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const before = graph.exteriorRows.length;

  const result = state.applyNaming('no-such-room-id', { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });

  assert.equal(result, null);
  assert.equal(graph.exteriorRows.length, before);
});

// ================================================================
// ステップ1（部屋編集の導線変更）: renameExteriorRoom（外部タブの群見出しからの改名）
// ================================================================

test('renameExteriorRoom: 屋外・非階段の部屋を改名するとRoom名と連動exteriorRows行のpartが両方更新される', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');
  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });

  state.renameExteriorRoom(room.id, 'バルコニー');

  assert.equal(graph.roomMap.get(room.id).name, 'バルコニー');
  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1, '行は増えず1件のまま');
  assert.equal(rows[0].part, 'バルコニー');
});

test('renameExteriorRoom: 空文字は既定「屋外」になる（applyNamingの既定と同じ）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');
  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });

  state.renameExteriorRoom(room.id, '   ');

  assert.equal(graph.roomMap.get(room.id).name, '屋外');
  assert.equal(graph.exteriorRows.find(r => r.roomId === room.id).part, '屋外');
});

test('【失敗系】renameExteriorRoom: 存在しないroomId・屋内の部屋・階段の部屋・無変更はno-op（undoエントリを積まない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  // 存在しないroomId
  const undoBefore1 = undoManager._undoStack.length;
  state.renameExteriorRoom('no-such-room-id', 'なにか');
  assert.equal(undoManager._undoStack.length, undoBefore1, '存在しないroomIdはundoを積まないはず');

  // 屋内の部屋
  const interiorRoom = graph.addRoom(new Set(['dummy']), '部屋');
  const undoBefore2 = undoManager._undoStack.length;
  state.renameExteriorRoom(interiorRoom.id, 'なにか');
  assert.equal(graph.roomMap.get(interiorRoom.id).name, '部屋', '屋内の部屋は改名されないはず');
  assert.equal(undoManager._undoStack.length, undoBefore2, '屋内の部屋はundoを積まないはず');

  // 階段の部屋（屋外階段）
  const stairRoom = graph.addRoom(new Set(['dummy2']), '');
  state.applyNaming(stairRoom.id, { name: '', kind: RoomKind.EXTERIOR, feature: RoomFeature.STAIR }, 3000);
  const undoBefore3 = undoManager._undoStack.length;
  state.renameExteriorRoom(stairRoom.id, 'なにか');
  assert.equal(graph.exteriorRows.find(r => r.roomId === stairRoom.id).part, '階段', '階段の部位行は変わらないはず');
  assert.equal(undoManager._undoStack.length, undoBefore3, '階段の部屋はundoを積まないはず');

  // 無変更（同名を渡す）— 注: この undo 件数 assert は、無変更ガード（if (room.name===finalName) return）
  // を外しても room.setName/r.setField に同じ値を書き戻すだけなら pushFinishUndo が差分ゼロとして
  // 捨てるため恒真になりうる（検出力なし）。ガードの有無を実際に見分けるのは下の T2
  // （sessionModifiedRoomIds への記録）。
  const exteriorRoom = graph.addRoom(new Set(['dummy3']), '');
  state.applyNaming(exteriorRoom.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  const undoBefore4 = undoManager._undoStack.length;
  state.renameExteriorRoom(exteriorRoom.id, 'テラス');
  assert.equal(undoManager._undoStack.length, undoBefore4, '無変更はundoを積まないはず');
});

// T2: 無変更ガードは sessionModifiedRoomIds.add も含めて早期returnする（withFinishUndoのfn自体を
// 実行しない）。無変更時の undo 件数assert（恒真になりうる）と違い、こちらはガードが無いと
// sessionModifiedRoomIds に記録されてしまうため、ガードの有無を実際に見分けられる。
test('【失敗系】renameExteriorRoom: 無変更はsessionModifiedRoomIdsに記録しない（trim後空白付き同名を含む）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '');
  state.applyNaming(room.id, { name: 'テラス', kind: RoomKind.EXTERIOR, feature: null });
  state.sessionModifiedRoomIds.clear();

  state.renameExteriorRoom(room.id, 'テラス'); // 同名
  assert.equal(state.sessionModifiedRoomIds.has(room.id), false, '同名は無変更としてsessionModifiedRoomIdsに記録しないはず');

  state.renameExteriorRoom(room.id, '  テラス  '); // 前後空白付き同名（trim後は同じ）
  assert.equal(state.sessionModifiedRoomIds.has(room.id), false, '前後空白付き同名も無変更のはず');
});

// ---- _syncExteriorRows: 屋外階段は既存行のpartを上書きしない（旧挙動維持） ----
test('_syncExteriorRows: 屋外階段（feature=STAIR）は既存行のpartをユーザー編集のまま保つ（上書きしない）', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '階段');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.STAIR);

  const row = graph.addExteriorRow('exteriorRows', '手編集した部位名', room.id);

  state._syncExteriorRows(room);

  assert.equal(row.part, '手編集した部位名', '既存行のpartは上書きされないはず');
  assert.equal(graph.exteriorRows.filter(r => r.roomId === room.id).length, 1, '新規行も追加されないはず');
});

test('_syncExteriorRows: 屋外階段で連動行が無ければ部位「階段」で新規追加する', () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const room = graph.addRoom(new Set(['dummy']), '階段');
  room.setKind(RoomKind.EXTERIOR);
  room.setFeature(RoomFeature.STAIR);

  state._syncExteriorRows(room);

  const rows = graph.exteriorRows.filter(r => r.roomId === room.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].part, '階段');
});

// ---- CL偏芯（clEccentricities）の下地材個別指定も材照合対象に含める（欠落修正） ----
test('FinishModeState.init: CL偏芯のbackingに未知コードがあるとmaterialErrorが立つ', async () => {
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '999999999999' });
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, false);
  assert.ok(state.materialError, 'materialErrorが設定されるはず');
});

test('FinishModeState.init: CL偏芯のbacking===\'\'（per-floor既定を参照する合図）はmaterialErrorを立てない', async () => {
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '' });
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, true);
  assert.equal(state.materialError, null);
});

test('FinishModeState.init: CL偏芯のbackingが既知コードならmaterialErrorを立てない', async () => {
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '201000000001' }); // L-90×90×7（既知コード。ステップ3振り直し後）
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, true);
  assert.equal(state.materialError, null);
});

// ---- ステップ7b: interiorMastersはcomposeCatalog(INTERIOR_MASTER)の結果（Map）----
// （2026-09-23 QA指摘Major-2: 生のINTERIOR_MASTERSオブジェクトへの退行を検知する）。
test('FinishModeState.init: interiorMastersはcomposeCatalog(INTERIOR_MASTER)の結果（Mapインスタンス）になる', async () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.ok, true);
  assert.ok(state.interiorMasters instanceof Map, 'interiorMastersはMapであるはず（旧実装は生のINTERIOR_MASTERSオブジェクトだった）');
  assert.equal(state.getInteriorMaster('LIVING_ROOM').label, '居室');
  assert.equal(state.getInteriorMaster('NOT_A_REAL_KEY'), null, '未登録キーはnull');
});

// ---- 材照合の材データロード（init）でmaterialDiffs（docDiffMap）も張る ----
test.afterEach(() => clearOverlays());

test('FinishModeState.init: 文書同梱材が本体と不一致なら materialDiff(code) が差分情報を返す', async () => {
  // 実材コード（せっこうボード t=12.5）に厚さの違う同梱材を重ねる（設計の例: 厚15（本体12.5）と同じ材）。
  setOverlay(CatalogKind.MATERIAL, {
    doc: [{
      code: '301000000002', name: 'せっこうボード t=12.5', spec: 'JIS A 6901',
      x: 0, y: 0, thickness: 15, note: '壁・天井下地の主流（GB-R）', category: 'panel',
    }],
  });
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  await state.init();

  const diff = state.materialDiff('301000000002');
  assert.ok(diff, 'materialDiffが差分情報を返すはず');
  assert.deepEqual(diff.diffFields, ['thickness']);
  assert.equal(diff.baseOrigin, 'builtin');
  assert.equal(state.materialDiff('201000000001'), null, '差分の無い材はnull');
});

test('FinishModeState.init: 同梱材の重ねが無ければ materialDiff は常にnull', async () => {
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  await state.init();

  assert.equal(state.materialDiff('301000000002'), null);
});

// ---- 指示UI（ステップ6-3）場面(b)unresolved-code: catalogResolveRows ----
test.afterEach(() => { clearDocumentAliases(); takeUnresolvedCodes(); }); // 後始末（他テストへ蓄積を持ち越さない）

test('FinishModeState.init: 自階が参照する未知コード（missing）はcatalogResolveRowsにunresolved-code行として現れ、usageにfloor参照が付く', async () => {
  takeUnresolvedCodes(); // 前のテストの蓄積を持ち越さない
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '999999999999' });
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.catalogResolveRows.length, 1);
  const row = result.catalogResolveRows[0];
  assert.equal(row.scenario, 'unresolved-code');
  assert.equal(row.targetKey, '999999999999');
  assert.ok(row.usage.some(u => u.location === 'floor'), 'missing由来のusageはlocation:floorのはず');
  assert.equal(state.catalogResolveRows, result.catalogResolveRows, 'stateにも同じ配列が反映される');
});

// ---- QA F2: 昇降路壁材（graph.shaftWallMaterial）も MATERIAL_CODE_GRAPH_FIELDS の対象 ----
test('FinishModeState.init【QA F2】: graph.shaftWallMaterialが未知コードだとcatalogResolveRowsにunresolved-code行として現れる（_collectReferencedCodesの対象）', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  graph.setShaftWallMaterial('999999999999');
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.catalogResolveRows.length, 1);
  const row = result.catalogResolveRows[0];
  assert.equal(row.scenario, 'unresolved-code');
  assert.equal(row.targetKey, '999999999999');
  assert.ok(row.usage.some(u => u.location === 'floor'), 'shaftWallMaterial由来のusageもlocation:floorのはず');
});

test('FinishModeState.init: 解決済み・存在するコードはcatalogResolveRowsに行を作らない', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  const cl = graph.centerLines[0];
  graph.setCLEccentricity(cl.id, { mode: 'value', value: 0, side: 1, backing: '201000000001' }); // 既知コード
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.deepEqual(result.catalogResolveRows, []);
});

test('FinishModeState.init: 削除材（peekUnresolvedCodesの全階累積）を参照する旧コード文書は、自階のmissingとは別ソースとしてcatalogResolveRowsに現れる', async () => {
  takeUnresolvedCodes();
  // 「他の階が既にデコードされ、削除材(111111111211=アスファルトプライマー)への参照が
  // 未解決として蓄積された」状態を restoreGraph 経由で再現する（本番の起動時peek/activateと同じ経路）。
  const otherFloorGraph = makeSingleCellGraph();
  otherFloorGraph.setExteriorWallBacking('111111111211');
  restoreGraph(otherFloorGraph, serializeGraph(otherFloorGraph)); // applyDocumentCodeNormalizationを通す

  // 今回テスト対象の（別の）階は、この削除材コードを一切参照しない。
  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  const row = result.catalogResolveRows.find(r => r.targetKey === '111111111211');
  assert.ok(row, '全階累積由来の未解決コードも行に現れるはず');
  assert.equal(row.usage[0].location, 'exteriorWallBacking');
  assert.equal(row.targetLabel, 'アスファルトプライマー', 'REMOVED_MATERIALSの旧名称がtargetLabelになる');
  assert.ok(row.candidates.length >= 0); // 候補の有無は問わない（0でもよい）
});

test('FinishModeState.init: 読み替え（addDocumentAliases）が付いた後は、同じ未解決コードが再掲されない（今のコード表とmaterialMapで再フィルタ）', async () => {
  takeUnresolvedCodes();
  const otherFloorGraph = makeSingleCellGraph();
  otherFloorGraph.setExteriorWallBacking('111111111211');
  restoreGraph(otherFloorGraph, serializeGraph(otherFloorGraph));

  // ユーザーが指示UIで「せっこうボード t=9.5(301000000001)」を代替材として指示した想定。
  addDocumentAliases(CatalogKind.MATERIAL, [{ from: '111111111211', to: '301000000001' }]);

  const graph = makeSingleCellGraph();
  const state = new FinishModeState(graph, null);
  const result = await state.init();

  assert.equal(result.catalogResolveRows.find(r => r.targetKey === '111111111211'), undefined,
    '読み替え後にmaterialMapへ存在するようになったコードは再掲されないはず');
});

// ---- ステップ7d: 内装マスター・境界マスターの未知キーもcatalogResolveRowsに行として現れる ----
test('FinishModeState.init: 部屋のtemplateKeyが本体・同梱・ユーザーライブラリのどこにも無いキーなら、interiorMasterのunresolved-code行が現れる', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  const room = graph.addRoom(new Set(['dummy']), 'テスト');
  room.setTemplateKey('GHOST_ROOM');
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  const row = result.catalogResolveRows.find(r => r.kind === CatalogKind.INTERIOR_MASTER);
  assert.ok(row, '内装マスターの未知キーがcatalogResolveRowsに現れるはず');
  assert.equal(row.scenario, 'unresolved-code');
  assert.equal(row.targetKey, 'GHOST_ROOM');
  assert.ok(row.usage.some(u => u.location === 'room' && u.roomId === room.id));
  assert.deepEqual(row.candidates, [], '内装マスターのunresolved-codeは候補が出ない契約（材料コード専用のsuggestByClass）');
});

test('FinishModeState.init: 部屋のtemplateKeyが解決できるキーならinteriorMasterの行は現れない', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  const room = graph.addRoom(new Set(['dummy']), 'テスト');
  room.setTemplateKey('LIVING_ROOM'); // 本体INTERIOR_MASTERSに実在するキー
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.catalogResolveRows.find(r => r.kind === CatalogKind.INTERIOR_MASTER), undefined);
});

test('FinishModeState.init: edgeのmasterTypeが7キーのどれでもなければboundaryMasterのunresolved-code行が現れる（次のモード境界で消える一過性）', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  graph.addEdge('a:b:c', 'GHOST_MASTER');
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  const row = result.catalogResolveRows.find(r => r.kind === CatalogKind.BOUNDARY_MASTER);
  assert.ok(row, '境界マスターの未知キーがcatalogResolveRowsに現れるはず');
  assert.equal(row.targetKey, 'GHOST_MASTER');
  assert.ok(row.usage.some(u => u.location === 'edge' && u.edgeKey === 'a:b:c'));
});

test('FinishModeState.init: edgeのmasterTypeが7キーのいずれかならboundaryMasterの行は現れない', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  graph.addEdge('a:b:c', 'EXTERIOR_WALL'); // BOUNDARY_MASTERSに実在するキー
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.catalogResolveRows.find(r => r.kind === CatalogKind.BOUNDARY_MASTER), undefined);
});

// ---- ステップ7d QA指摘Minor-4: materialErrorはmaterialのmissingUsageだけから算出する
// （内装・境界マスターの未解決を合算しない）。errorの算出を全種別合算に広げる変異で赤になる ----
test('【ステップ7d QA指摘Minor-4】FinishModeState.init: 内装・境界マスターだけが未解決（材は全解決）なら materialError は null・ok:true になり、かつ内装・境界のunresolved-code行は両方現れる', async () => {
  takeUnresolvedCodes();
  const graph = makeSingleCellGraph();
  const room = graph.addRoom(new Set(['dummy']), 'テスト');
  room.setTemplateKey('GHOST_ROOM'); // 内装マスターだけ未解決
  graph.addEdge('a:b:c', 'GHOST_MASTER'); // 境界マスターだけ未解決
  const state = new FinishModeState(graph, null);

  const result = await state.init();

  assert.equal(result.error, null, '材は未解決が無いのでerrorはnullのはず（変異=全種別合算で赤）');
  assert.equal(result.ok, true);
  assert.equal(state.materialError, null, '材は未解決が無いのでmaterialErrorはnullのはず');
  assert.ok(
    result.catalogResolveRows.some(r => r.kind === CatalogKind.INTERIOR_MASTER),
    '内装マスターのunresolved-code行は現れるはず',
  );
  assert.ok(
    result.catalogResolveRows.some(r => r.kind === CatalogKind.BOUNDARY_MASTER),
    '境界マスターのunresolved-code行は現れるはず',
  );
});
