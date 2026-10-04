// roomNameAnchor（部屋名ラベルの配置ルール単一情報源）のテスト。
// 描画（FinishModeLayer.jsx）とクリック判定（FinishModeState._nameCellKeyOf）の共通契約。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, ROOF_ROOM_NAME } from '@core';
import { roomNameAnchor, showsRoomNameLabel } from './roomLabel.js';
import { worldToCell } from './gridCells.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };

test('roomNameAnchor: namePosition 明示指定はそのまま使い、refWidth は包絡矩形の幅', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  for (const x of [0, 4000, 7000]) graph.addCenterLine(CenterLineType.VERTICAL, x, ARCH);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, ARCH);
  const cellA = worldToCell(2000, 1500, graph).key;
  const cellB = worldToCell(5500, 1500, graph).key;
  const room = graph.addRoom(new Set([cellA, cellB]), '部屋');
  room.setNamePosition(1234, 567);

  const a = roomNameAnchor(room, graph);
  assert.deepEqual({ x: a.x, y: a.y }, { x: 1234, y: 567 });
  assert.equal(a.refWidth, 7000, '包絡矩形（0..7000）の幅のはず');
});

// 親が粗い旧分割キーのまま・部分指定は細分キー、という粒度差は通常運用で発生する
// （部屋指定後に floorplan モードで CL を追加すると、親の cells は更新されず
// 新規部分指定だけが refreshCells 由来の細分キーで作られる）。
test('roomNameAnchor: 親が粗い旧分割キー・部分指定が細分キーでも、親ラベルは奪われていないセルへ出る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  for (const x of [0, 7000, 12000]) graph.addCenterLine(CenterLineType.VERTICAL, x, ARCH);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, ARCH);
  const coarseA = worldToCell(3500, 1500, graph).key; // 0..7000（粗キー）
  const cellB   = worldToCell(9500, 1500, graph).key; // 7000..12000
  const parent = graph.addRoom(new Set([coarseA, cellB]), '親');

  // 部屋指定後に CL 追加（親のキーは粗いまま）。部分指定は細分キーで粗キー全域を覆う
  graph.addCenterLine(CenterLineType.VERTICAL, 3500, ARCH);
  const fineA1 = worldToCell(1750, 1500, graph).key; // 0..3500
  const fineA2 = worldToCell(5250, 1500, graph).key; // 3500..7000
  graph.addRoom(new Set([fineA1, fineA2]), '子', undefined, new Set([parent.id]));

  const a = roomNameAnchor(parent, graph);
  assert.deepEqual({ x: a.x, y: a.y }, { x: 9500, y: 1500 },
    '粗キー全域が奪われているため、親ラベルは残余セル（7000..12000）の中心に出るはず');
});

// ---- 失敗系: 部分指定が親の全域を覆う退化ケース（normalizePartialDominance も
// remaining.size===0 で手を出さない）は全セルへのフォールバックでラベルを出す。
// このときラベルが重なるのは意図した挙動（ラベル消失より重なりを選ぶ）。
test('【失敗系】roomNameAnchor: 部分指定が親全域を覆う退化ケースは全セルへフォールバックしラベルを出す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  for (const x of [0, 4000]) graph.addCenterLine(CenterLineType.VERTICAL, x, ARCH);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, ARCH);
  const cellA = worldToCell(2000, 1500, graph).key;
  const parent = graph.addRoom(new Set([cellA]), '親');
  graph.addRoom(new Set([cellA]), '子', undefined, new Set([parent.id]));

  const a = roomNameAnchor(parent, graph);
  assert.ok(a, '除外で候補が尽きてもラベル自体は消えないはず');
  assert.deepEqual({ x: a.x, y: a.y }, { x: 2000, y: 1500 });
});

// ---- showsRoomNameLabel（室名を出す判断。平面 RoomLabelsLayer・仕上げ FinishModeLayer 共通。裁定2026-10-04「屋根の室名は隠す」）----
test('showsRoomNameLabel: 名前のある通常の部屋・階段・屋外部屋は出す。屋根の部屋（feature=ROOF）は名前があっても出さない', () => {
  assert.equal(showsRoomNameLabel({ name: '居間', feature: null }), true);
  assert.equal(showsRoomNameLabel({ name: 'テラス', feature: null }), true);
  assert.equal(showsRoomNameLabel({ name: '階段', feature: RoomFeature.STAIR }), true);
  assert.equal(showsRoomNameLabel({ name: '吹抜け', feature: RoomFeature.VOID }), true);
  assert.equal(showsRoomNameLabel({ name: ROOF_ROOM_NAME, feature: RoomFeature.ROOF }), false, '屋根（固定名「屋根」）は出さない');
  assert.equal(showsRoomNameLabel({ name: '任意の名前', feature: RoomFeature.ROOF }), false, '名前の値に依らず feature で判断する');
});

test('【失敗系】showsRoomNameLabel: 名前が空・未設定の部屋は（屋根でなくても）出さない', () => {
  assert.equal(showsRoomNameLabel({ name: '', feature: null }), false);
  assert.equal(showsRoomNameLabel({ name: undefined, feature: null }), false);
  assert.equal(showsRoomNameLabel({ name: null, feature: RoomFeature.STAIR }), false);
  assert.equal(showsRoomNameLabel({ name: '', feature: RoomFeature.ROOF }), false);
});

// ---- 失敗系: セルが1つも解決できない場合は null（呼び出し側がラベル非表示にする）----
test('【失敗系】roomNameAnchor: 全セルキーが解決不能なら null を返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  for (const x of [0, 4000]) graph.addCenterLine(CenterLineType.VERTICAL, x, ARCH);
  for (const y of [0, 3000]) graph.addCenterLine(CenterLineType.HORIZONTAL, y, ARCH);
  const room = graph.addRoom(new Set(['gone1:gone2:gone3:gone4']), '欠損');

  assert.equal(roomNameAnchor(room, graph), null);
});
