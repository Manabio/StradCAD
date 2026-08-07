// graphSnapshot.test.js / openingEdit.test.js と同じ方針: worldToCell によるセル解決の実挙動
// （CL グリッド・isDividerCL 判定）はダックタイピングでは再現できないため、実 core.js
// （Plane/PlanGraph）と実 finish/gridCells.js の grid を使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory, RoomFeature } from '../core.js';
import { worldToCell } from '../finish/gridCells.js';
import { openingMountLocation } from './openingRoomLabel.js';

function makePlaneGraph(planeId = 'p1') {
  const plane = new Plane(planeId, 0, `${planeId}階`, 1, 1);
  return new PlanGraph(plane);
}

// X0=0 / X1=4000 / X2=8000（垂直CL）× Y0=0 / Y1=4000（水平CL）の2×1グリッド。
// 左セル(0<x<4000,0<y<4000)="リビング"想定、右セル(4000<x<8000,0<y<4000)="廊下"想定。
// X1に内壁（開口openingMid）、X0に外壁（開口openingExt）を持つ。
function makeGrid() {
  const graph = makePlaneGraph();
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addCenterLine(CenterLineType.VERTICAL, 8000, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 4000, { labeled: false, discipline: Discipline.ARCH });

  const wallMid = graph.addWall(x1, 0, true, y0, 0, y1, 0, { isExteriorWall: false });
  const wallExt = graph.addWall(x0, 0, true, y0, 0, y1, 0, { isExteriorWall: true });

  const openingMid = graph.addOpening(x1, 1, true, y0, 2000, 900, OpeningCategory.FITTING, 'singleSwing', {});
  const openingExt = graph.addOpening(x0, 1, true, y0, 2000, 900, OpeningCategory.WINDOW, 'doubleSliding', {});

  const leftCellKey  = worldToCell(2000, 2000, graph).key;
  const rightCellKey = worldToCell(6000, 2000, graph).key;

  return { graph, wallMid, wallExt, openingMid, openingExt, leftCellKey, rightCellKey };
}

// ---- 両側: 内壁の開口は両側の部屋名を「・」区切りで表示する ----
test('openingMountLocation: 内壁の開口は両側の部屋名を「・」区切りで返す', () => {
  const { graph, openingMid, leftCellKey, rightCellKey } = makeGrid();
  graph.addRoom(new Set([leftCellKey]),  'リビング');
  graph.addRoom(new Set([rightCellKey]), '廊下');

  assert.equal(openingMountLocation(openingMid, graph), 'リビング・廊下');
});

// ---- 外壁: 室内側の部屋名のみ ----
test('openingMountLocation: 外壁の開口は室内側の部屋名のみを返す', () => {
  const { graph, openingExt, leftCellKey, rightCellKey } = makeGrid();
  graph.addRoom(new Set([leftCellKey]),  'リビング');
  graph.addRoom(new Set([rightCellKey]), '廊下');

  assert.equal(openingMountLocation(openingExt, graph), 'リビング', '外壁の外側（無名屋外）は含めない');
});

// ---- 片側のみ: 反対側が部屋として登録されていなければ片側の名前のみ ----
test('openingMountLocation: 片側の部屋しか特定できない場合はその名前のみを返す', () => {
  const { graph, openingMid, leftCellKey } = makeGrid();
  graph.addRoom(new Set([leftCellKey]), 'リビング'); // 右側（廊下）は部屋登録なし

  assert.equal(openingMountLocation(openingMid, graph), 'リビング');
});

// ---- 部屋なし: どちらの部屋も特定できなければ空文字 ----
test('openingMountLocation: どちらの部屋も特定できない場合は空文字を返す', () => {
  const { graph, openingMid } = makeGrid(); // 部屋を1件も追加しない

  assert.equal(openingMountLocation(openingMid, graph), '');
});

// ---- 未定義部屋（feature=UNDEFINED）: 特定できない扱いで空表示に寄与しない ----
test('openingMountLocation: 未定義部屋（feature=UNDEFINED）は特定できない扱いになる', () => {
  const { graph, openingMid, leftCellKey, rightCellKey } = makeGrid();
  const left = graph.addRoom(new Set([leftCellKey]), 'リビング');
  left.setFeature(RoomFeature.UNDEFINED);
  graph.addRoom(new Set([rightCellKey]), '廊下');

  assert.equal(openingMountLocation(openingMid, graph), '廊下', '未定義部屋側は除外され、もう片側だけが表示される');
});

// ---- ホスト壁が見つからない場合も空文字（防御） ----
test('openingMountLocation: ホスト壁が見つからない開口は空文字を返す', () => {
  const { graph, openingMid } = makeGrid();
  // ホスト壁そのものを削除して findHostWall が null を返す状況を再現する。
  const wall = graph.walls.find(w => w.axisCL.id === openingMid.axisCL.id && w.isVertical === openingMid.isVertical);
  graph.removeShape(wall.id);

  assert.equal(openingMountLocation(openingMid, graph), '');
});
