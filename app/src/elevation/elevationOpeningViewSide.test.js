// 展開図の建具の開き線の線種（見る側）の本番経路テスト。実面・実壁（buildRoomFaces）経由で buildFaceFigure を呼ぶ。
// 「どちらの部屋へ開く戸か」は平面記号の戸板の先端（どちらの部屋の中にあるか）から独立に決める。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory, CenterLineType, Plane, PlanGraph, Discipline } from '@core';
import { generateRoomWallsFromOutline, generateExteriorWalls } from '../finish/wallGeneration.js';
import { buildFaceFigure } from './elevationFigure.js';
import { buildRoomFaces } from './elevationFaces.js';
import { buildOpeningPlanSymbol } from '../openings/openingPlanSymbol.js';
import { findHostWall } from '../openings/openingGeometry.js';
import { findCatalogEntry } from '../openings/openingCatalog.js';
import { LodLevel } from '../viewport.js';

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const ctxOf = (graph, room) => ({
  graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
});

// 上室（y 0..2000）と下室（y 2000..5000）。共有壁は yMid=2000。外壁を作る exterior=true なら外周に外壁も生成する。
function twoRooms({ exterior = false } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, ARCH);
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, ARCH);
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, ARCH);
  const yMid = graph.addCenterLine(CenterLineType.HORIZONTAL, 2000, ARCH);
  const y2 = graph.addCenterLine(CenterLineType.HORIZONTAL, 5000, ARCH);
  const upper = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${yMid.id}`]), '上室');
  const lower = graph.addRoom(new Set([`${x0.id}:${yMid.id}:${x1.id}:${y2.id}`]), '下室');
  generateRoomWallsFromOutline(graph, upper);
  generateRoomWallsFromOutline(graph, lower);
  if (exterior) generateExteriorWalls(graph);
  return { graph, upper, lower, cl: { x0, x1, y0, yMid, y2 } };
}

// 面の建具の開き線（建具に属する斜線）の線種。
function veeDashes(prims) {
  return prims.filter(p => p.type === 'line' && p.openingId != null && p.x1 !== p.x2 && p.y1 !== p.y2).map(p => p.dash);
}
const faceOn = (room, graph, axisCLId) => {
  const face = buildRoomFaces(room, graph).find(f => f.axisCL.id === axisCLId);
  assert.ok(face, `前提: 軸 ${axisCLId} の面がある`);
  return face;
};

test('共有壁の片開き戸: 開く側の部屋の面は実線（手前）・反対の部屋の面は一点鎖線（向こう）（swingSide ±1 とも）', () => {
  const seen = new Set();
  for (const swingSide of [1, -1]) {
    const { graph, upper, lower, cl } = twoRooms();
    const o = graph.addOpening(cl.yMid, 1, false, cl.x0, 1500, 900, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide });
    // 平面記号の戸板の先端が上室（y<2000）の中なら上室へ開く戸
    const host = findHostWall(o, graph);
    const plan = buildOpeningPlanSymbol(o, {
      entry: findCatalogEntry(o.category, o.subType), lodLevel: LodLevel.STANDARD,
      axisValue: host.axisValue, exteriorDirOf: () => host.faceDir,
    });
    const tip = plan.find(p => p.type === 'line' && p.role === 'leaf');
    assert.ok(tip, '前提: 平面記号に戸板の線がある');
    const opensIntoUpper = tip.y2 < 2000;
    seen.add(opensIntoUpper);
    const upperDash = veeDashes(buildFaceFigure(faceOn(upper, graph, cl.yMid.id), ctxOf(graph, upper)));
    const lowerDash = veeDashes(buildFaceFigure(faceOn(lower, graph, cl.yMid.id), ctxOf(graph, lower)));
    assert.deepEqual(upperDash, opensIntoUpper ? [undefined, undefined] : ['center', 'center'], `上室 swingSide=${swingSide}`);
    assert.deepEqual(lowerDash, opensIntoUpper ? ['center', 'center'] : [undefined, undefined], `下室 swingSide=${swingSide}`);
  }
  assert.deepEqual([...seen].sort(), [false, true], '前提: swingSide ±1 で上室向き・下室向きの両方が出る');
});

test('共有壁の常時開放式防火折戸（FIRE_FOLD）: 開く側の部屋の面は実線・反対の部屋の面は一点鎖線（swingSide ±1 で側が入れ替わる）', () => {
  const solid = Array(8).fill(undefined), chain = Array(8).fill('center');
  const intoUpper = [];
  for (const swingSide of [1, -1]) {
    const { graph, upper, lower, cl } = twoRooms();
    graph.addOpening(cl.yMid, 1, false, cl.x0, 1500, 1600, OpeningCategory.FITTING, 'fireFold90', { hingeSide: -1, swingSide });
    const upperDash = veeDashes(buildFaceFigure(faceOn(upper, graph, cl.yMid.id), ctxOf(graph, upper)));
    const lowerDash = veeDashes(buildFaceFigure(faceOn(lower, graph, cl.yMid.id), ctxOf(graph, lower)));
    const upperSolid = JSON.stringify(upperDash) === JSON.stringify(solid);
    assert.deepEqual(upperDash, upperSolid ? solid : chain, `上室 swingSide=${swingSide}`);
    assert.deepEqual(lowerDash, upperSolid ? chain : solid, `下室 swingSide=${swingSide}`);
    intoUpper.push(upperSolid);
  }
  assert.deepEqual([...intoUpper].sort(), [false, true], '前提: swingSide ±1 で上室向き・下室向きの両方が出る');
});

test('外壁の突出し窓（外開き）: 室内の面では向こうへ開くので一点鎖線（openingExteriorPerp の経路）', () => {
  const { graph, upper, cl } = twoRooms({ exterior: true });
  // 上室の北外壁（y0）。wallSide=-1 が外側
  graph.addOpening(cl.y0, -1, false, cl.x0, 1500, 900, OpeningCategory.WINDOW, 'projectedOut', { sillHeight: 800, height: 900 });
  const dashes = veeDashes(buildFaceFigure(faceOn(upper, graph, cl.y0.id), ctxOf(graph, upper)));
  assert.deepEqual(dashes, ['center', 'center']);
});

test('外壁の内倒し窓（内開き）: 室内の面では手前に開くので実線', () => {
  const { graph, upper, cl } = twoRooms({ exterior: true });
  graph.addOpening(cl.y0, -1, false, cl.x0, 1500, 900, OpeningCategory.WINDOW, 'hopper', { sillHeight: 800, height: 900 });
  const dashes = veeDashes(buildFaceFigure(faceOn(upper, graph, cl.y0.id), ctxOf(graph, upper)));
  assert.deepEqual(dashes, [undefined, undefined]);
});

test('【失敗系】間仕切り（外壁なし）の突出し窓は室外側が無いので正準のまま実線（両側の面とも）', () => {
  const { graph, upper, lower, cl } = twoRooms();
  graph.addOpening(cl.yMid, 1, false, cl.x0, 1500, 900, OpeningCategory.WINDOW, 'projectedOut', { sillHeight: 800, height: 900 });
  for (const [label, room] of [['上室', upper], ['下室', lower]]) {
    const dashes = veeDashes(buildFaceFigure(faceOn(room, graph, cl.yMid.id), ctxOf(graph, room)));
    assert.deepEqual(dashes, [undefined, undefined], label);
  }
});
