// 展開図の本番経路: 姿図の詳細図に開き勝手線（dashRole=SWING）を持つ共有壁の片開き戸は、部屋ごとに片側だけ一点鎖線になる。
// 「どちらの部屋へ開く戸か」の基準は、詳細図なしの同じ戸の開き線（V 字）の線種（elevationOpeningViewSide.test.js で検証済み）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory, CenterLineType, Plane, PlanGraph, Discipline } from '@core';
import { clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailDash, DetailSlot } from '../core/constants.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { buildFaceFigure } from './elevationFigure.js';
import { buildRoomFaces } from './elevationFaces.js';
import { elevationFigure, installElevationFigures } from '../openings/openingDetailTestFixtures.js';

test.afterEach(() => clearOverlays());

const ARCH = { labeled: false, discipline: Discipline.ARCH };
const ctxOf = (graph, room) => ({
  graph, project: { openingNumberIndex: new Map() }, room, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
});

// 上室（y 0..2000）と下室（y 2000..5000）。共有壁は yMid=2000。
function twoRooms() {
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
  return { graph, upper, lower, cl: { x0, yMid } };
}
const faceOn = (room, graph, axisCLId) => {
  const face = buildRoomFaces(room, graph).find(f => f.axisCL.id === axisCLId);
  assert.ok(face, `前提: 軸 ${axisCLId} の面がある`);
  return face;
};
const veeDashes = prims => prims.filter(p => p.type === 'line' && p.openingId != null && p.source !== 'detail' && p.x1 !== p.x2 && p.y1 !== p.y2).map(p => p.dash);
const detailDashes = prims => prims.filter(p => p.type === 'line' && p.source === 'detail').map(p => p.dash);

test('共有壁の片開き戸＋姿図の SWING 線: 開く側の部屋は実線（線分なし）・反対の部屋は一点鎖線の線分 2 本（swingSide ±1 とも）', () => {
  const f = elevationFigure('df-swing', { dashX: 130 });
  installElevationFigures([{ ...f, strokes: f.strokes.map(s => (s.id === 'dash' ? { ...s, line: { weightRole: 'thin', dashRole: DetailDash.SWING } } : s)) }]);
  const seen = new Set();
  for (const swingSide of [1, -1]) {
    const make = withDetail => {
      const { graph, upper, lower, cl } = twoRooms();
      const o = graph.addOpening(cl.yMid, 1, false, cl.x0, 1500, 870, OpeningCategory.FITTING, 'singleSwing', { hingeSide: -1, swingSide });
      if (withDetail) o.detailRefs = { [DetailSlot.FIGURE]: 'df-swing' };
      return {
        upper: buildFaceFigure(faceOn(upper, graph, cl.yMid.id), ctxOf(graph, upper)),
        lower: buildFaceFigure(faceOn(lower, graph, cl.yMid.id), ctxOf(graph, lower)),
      };
    };
    // 基準: 詳細図なしの V 字。手前（実線）の部屋はどちらか
    const base = make(false);
    const intoUpper = JSON.stringify(veeDashes(base.upper)) === JSON.stringify([undefined, undefined]);
    seen.add(intoUpper);
    const detailed = make(true);
    // 前提: 詳細図が使われている（実線側は polyline 3 本・一点鎖線側は polyline 2 本＋線分 2 本）
    assert.equal(detailed.upper.filter(p => p.source === 'detail').length, intoUpper ? 3 : 4, `上室の詳細図 swingSide=${swingSide}`);
    assert.equal(detailed.lower.filter(p => p.source === 'detail').length, intoUpper ? 4 : 3, `下室の詳細図 swingSide=${swingSide}`);
    assert.deepEqual(detailDashes(detailed.upper), intoUpper ? [] : ['center', 'center'], `上室 swingSide=${swingSide}`);
    assert.deepEqual(detailDashes(detailed.lower), intoUpper ? ['center', 'center'] : [], `下室 swingSide=${swingSide}`);
  }
  assert.deepEqual([...seen].sort(), [false, true], '前提: swingSide ±1 で上室向き・下室向きの両方が出る');
});
