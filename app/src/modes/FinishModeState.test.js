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

  // 同じ領域を再度ドラッグ（既存部屋と完全一致）→ 既存ダイアログが開くだけで新規作成されない
  state.startDrag(2000, 1500);
  state.commitDrag();

  assert.equal(state.namingRoomId, firstRoomId, '既存部屋がそのまま選択されるはず（新規IDにならない）');
  assert.equal(state.namingIsNew, false);
  assert.equal(graph.roomMap.get(firstRoomId).finish.baseboardMaterial, '',
    '既存部屋の完全一致ドラッグでユーザーのクリアが巾木初期値へ巻き戻ってはいけない');
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

// ---- R13: 材照合の材データロード（init）でmaterialDiffs（docDiffMap）も張る ----
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
