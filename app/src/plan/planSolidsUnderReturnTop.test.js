// planSolids.js underReturnWallTops（復路下の壁の天端＝復路レーンの裏面。ユーザー裁定 2026-10-17「復路下の壁の天端を planSolids でも
// 裏面で止める」）。供給源は展開図と同じ sectionProbe.js stairUnderReturnSoffit。フィクスチャは sectionUnderReturnTop.test.js の
// EQUAL_UP（往路 x0〜1000・復路 x1000〜2000・踊り場 y0〜1000、前縁 y=1000。復路下の壁は y=1000 上の x1000〜2000）。
// 経緯: moku4-3 2階の踊り場前縁に出た線（y=−8247.5）は 1階の復路下の壁が天井まで立って踏面より高くなり、2階の床の穴ごしに
// 下階レイヤとして描かれたもの（小梁 B1 ではない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType } from '@core';
import { planSolids, layerCeilZ } from './planSolids.js';
import { generateStairUnderReturnWalls } from '../finish/stair/stairPartitionWalls.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { stairSoffitSolids } from '../ceiling/stairSoffit.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const FH = 2400;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

function makeFloor(id, elevation, { stairRects = null, stairProps = {} } = {}) {
  const graph = new PlanGraph(new Plane(id, elevation * 1000, id, elevation, 1));
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  for (const x of [0, 1000, 2000, 3000]) V(x);
  for (const y of [0, 1000, 4000]) H(y);
  const cellKeys = rects => new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  let stair = null, walls = [];
  if (stairRects) {
    const cells = cellKeys(stairRects);
    const room = graph.addRoom(new Set(cells), '階段');
    stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
    walls = generateStairUnderReturnWalls(graph, { structure: WOOD });
  }
  // 比較用の普通の部屋（x2000〜3000。外周の壁は天井高のまま）
  const roomA = graph.addRoom(cellKeys([[2000, 0, 3000, 1000], [2000, 1000, 3000, 4000]]), 'A');
  generateRoomWallsFromOutline(graph, roomA);
  return { graph, stair, walls };
}
const twoFloors = (opts) => {
  const f1 = makeFloor('p1', 0, opts);
  const f2 = makeFloor('p2', 1);
  return { f1, layers: [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }] };
};
// 期待値: 階段の裏面の式（stairSoffitSolids）を区間の中央 x=1500・壁の厚み方向（y=1000±57.5）で評価した最小値（展開図のテストと同じ）
const soffitAt = (f1, riser = FH / f1.stair.totalSteps, ys = [942.5, 1000, 1057.5]) => {
  const s = stairSoffitSolids({ stair: f1.stair, graph: f1.graph, riser, floorZMm: 0 })[0];
  return Math.min(...ys.map(y => (s.zAt ? s.zAt(1500, y) : s.zLo)));
};
// 復路下の壁（オーナー壁・薄壁。mergeTouchingWalls で 1 件にまとまる）の立体
const underReturnSolids = (solids, walls) => {
  const ids = new Set(walls.map(w => w.id));
  return solids.filter(s => s.kind === 'wall' && [s.source.id, ...(s.source.mergedIds ?? [])].some(id => ids.has(id)));
};

test('復路下の壁の立体は復路の裏面の高さで止まる（天井 2400 までは立ち上がらない）。他の壁は不変', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  assert.equal(f1.walls.length, 2, '前提: オーナー壁＋薄壁');
  const expected = soffitAt(f1);
  assert.ok(expected > 0 && expected < FH - 1, `前提: 裏面は天井より低い（${expected}）`);
  const solids = planSolids(layers);
  const under = underReturnSolids(solids, f1.walls);
  assert.ok(under.length >= 1, '復路下の壁の立体がある');
  for (const s of under) assert.ok(Math.abs(s.zHi - expected) < 1e-6, `zHi=${s.zHi} ≒ 裏面 ${expected}`);
  // 1階の他の壁（階段室の外周など）は従来どおり天井高（復路下の壁以外に上限を入れない）
  const others = solids.filter(s => s.kind === 'wall' && s.source.layerFloorZ === 0 && !under.includes(s));
  assert.ok(others.length >= 1, '前提: 他の壁がある');
  for (const s of others) assert.equal(s.zHi, layerCeilZ(layers[0]), '他の壁は天井高のまま');
});

test('最上の層（直上の層なし）でも opts.riserOf から階高を戻して裏面で止める。riserOf も無ければ従来どおり天井高', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }];
  const riser = FH / f1.stair.totalSteps;
  const capped = underReturnSolids(planSolids(layers, { riserOf: () => riser }), f1.walls);
  assert.ok(capped.length >= 1);
  for (const s of capped) assert.ok(Math.abs(s.zHi - soffitAt(f1, riser)) < 1e-6, `zHi=${s.zHi}`);
  const full = underReturnSolids(planSolids(layers), f1.walls);
  assert.ok(full.length >= 1);
  for (const s of full) assert.equal(s.zHi, layerCeilZ(layers[0]), '蹴上が決まらなければ天井高');
});

test('【失敗系】鉄骨の階段 → 裏面が求まらず天井高のまま', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  f1.stair.structure = StructuralMaterialType.STEEL;
  const under = underReturnSolids(planSolids(layers), f1.walls);
  assert.ok(under.length >= 1);
  for (const s of under) assert.equal(s.zHi, layerCeilZ(layers[0]));
});

test('見下げ（上階の自階＋下階の層）で、下階の復路下の壁は踏面の下に収まる＝踏面の z 以下', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  const below = [{ graph: layers[1].graph, floorZMm: 0, role: 'self' }, { graph: f1.graph, floorZMm: -FH, role: 'below' }];
  const solids = planSolids(below);
  const under = underReturnSolids(solids, f1.walls);
  assert.ok(under.length >= 1);
  // 復路レーン（x1000〜2000）の踏面のうち前縁 y=1000 に接するもの＝復路の 1 段目。壁の天端はその踏面より低い
  const treads = solids.filter(s => s.kind === 'stairTread' && s.source.layerFloorZ === -FH);
  const firstReturn = treads.filter(s => { const p = s.footprint.poly; const xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1); return Math.min(...xs) >= 1000 - 1 && Math.min(...ys) <= 1000 + 60; });
  assert.ok(firstReturn.length >= 1, '前提: 復路 1 段目の踏面が前縁に接する');
  const treadZ = Math.min(...firstReturn.map(s => s.zHi));
  for (const s of under) assert.ok(s.zHi <= treadZ + 1e-6, `壁の天端 ${s.zHi} ≤ 踏面 ${treadZ}`);
});
