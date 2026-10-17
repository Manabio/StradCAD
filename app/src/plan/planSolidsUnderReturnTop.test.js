// planSolids.js の壁の天端＝階段の足元（裏面の footprint）の中の区間は階段の裏面で止める（wallFootSurfaces・wallFootTop）と、
// 復路下の壁（木造の生成壁）の壁全長の平らな天端（underReturnWallTops）。
// 経緯: ユーザー裁定 2026-10-17「復路下の壁の天端を planSolids でも裏面で止める」（moku4-3 2階の踊り場前縁 y=−8247.5 の線は
// 1階の復路下の壁が天井まで立って踏面より高くなり、2階の床の穴ごしに下階レイヤとして描かれたもの）→ 同日「階段の足元の中にある壁は
// 構造・壁の種類によらず裏面より上に立てない」へ一般化（13.stq 2階「6」の階段下の部屋「13」の壁）。
// フィクスチャは sectionUnderReturnTop.test.js の EQUAL_UP（往路 x0〜1000・復路 x1000〜2000・踊り場 y0〜1000、前縁 y=1000）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, StairType, StructuralMaterialType, RoomKind } from '@core';
import { planSolids, layerCeilZ } from './planSolids.js';
import { generateStairUnderReturnWalls } from '../finish/stair/stairPartitionWalls.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { stairSoffitSolids, stairUndersideSurface } from '../ceiling/stairSoffit.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const FH = 2400;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

// underRects … 階段の足元に重ねる普通の部屋（階段下の部屋。壁は部屋の外周から生成）。指定時は比較用の部屋 A は置かない
function makeFloor(id, elevation, { stairRects = null, stairProps = {}, underRects = null, underWalls = true, extraRects = null } = {}) {
  const graph = new PlanGraph(new Plane(id, elevation * 1000, id, elevation, 1));
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  for (const x of [0, 1000, 1500, 2000, 3000]) V(x);
  for (const y of [0, 1000, 3000, 4000, 5000]) H(y);
  const cellKeys = rects => new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  let stair = null, walls = [], stairRoom = null;
  if (stairRects) {
    const cells = cellKeys(stairRects);
    const room = stairRoom = graph.addRoom(new Set(cells), '階段');
    stair = graph.addStair({ type: StairType.SWITCHBACK, cells, roomId: room.id, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
    walls = generateStairUnderReturnWalls(graph, { structure: WOOD });
  }
  if (underRects) {
    const under = graph.addRoom(cellKeys(underRects), '階段下');
    if (underWalls) generateRoomWallsFromOutline(graph, under);
  } else {
    // 比較用の普通の部屋（x2000〜3000。外周の壁は天井高のまま）
    const roomA = graph.addRoom(cellKeys([[2000, 0, 3000, 1000], [2000, 1000, 3000, 4000]]), 'A');
    generateRoomWallsFromOutline(graph, roomA);
  }
  if (extraRects) generateRoomWallsFromOutline(graph, graph.addRoom(cellKeys(extraRects), 'X')); // 階段の足元の外の部屋
  return { graph, stair, walls, stairRoom };
}
const twoFloors = (opts) => {
  const f1 = makeFloor('p1', 0, opts);
  const f2 = makeFloor('p2', 1);
  return { f1, f2, layers: [{ graph: f1.graph, floorZMm: 0, role: 'self' }, { graph: f2.graph, floorZMm: FH, role: 'above' }] };
};
// 期待値: 階段の裏面の式（stairSoffitSolids）を区間の中央 x=1500・壁の厚み方向（y=1000±57.5）で評価した最小値（展開図のテストと同じ）。
// 復路下の壁の壁全長の平らな天端。足元の中の区間は両端でも評価して最小を取るのでこれ以下になる
const soffitAt = (f1, riser = FH / f1.stair.totalSteps, ys = [942.5, 1000, 1057.5]) => {
  const s = stairSoffitSolids({ stair: f1.stair, graph: f1.graph, riser, floorZMm: 0 })[0];
  return Math.min(...ys.map(y => (s.zAt ? s.zAt(1500, y) : s.zLo)));
};
// 復路下の壁（オーナー壁・薄壁。mergeTouchingWalls で 1 件にまとまる）の立体
const underReturnSolids = (solids, walls) => {
  const ids = new Set(walls.map(w => w.id));
  return solids.filter(s => s.kind === 'wall' && [s.source.id, ...(s.source.mergedIds ?? [])].some(id => ids.has(id)));
};
// 矩形の 9 点（両端と中央 × 両端と中央）での裏面 zAt の最小。planSolids の区間の評価点と同じ
const surfaceMinOver = (surface, r) => Math.min(...[r.x1, (r.x1 + r.x2) / 2, r.x2].flatMap(x => [r.y1, (r.y1 + r.y2) / 2, r.y2].map(y => (surface.zAt ? surface.zAt(x, y) : surface.zLo))));
const wallsOf = (solids, layerFloorZ = 0) => solids.filter(s => s.kind === 'wall' && s.source.layerFloorZ === layerFloorZ);

test('復路下の壁（木造）の立体は復路の裏面の高さ以下で止まる（天井 2400 までは立ち上がらない）。他の壁は不変', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  assert.equal(f1.walls.length, 2, '前提: オーナー壁＋薄壁');
  const expected = soffitAt(f1);
  assert.ok(expected > 0 && expected < FH - 1, `前提: 裏面は天井より低い（${expected}）`);
  const solids = planSolids(layers);
  const under = underReturnSolids(solids, f1.walls);
  assert.ok(under.length >= 1, '復路下の壁の立体がある');
  for (const s of under) assert.ok(s.zHi > 0 && s.zHi <= expected + 1e-6, `0 < zHi=${s.zHi} ≤ 裏面 ${expected}`);
  // 1階の他の壁（階段室の外周など）は従来どおり天井高（足元の外の壁に上限を入れない）
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
  for (const s of capped) assert.ok(s.zHi > 0 && s.zHi <= soffitAt(f1, riser) + 1e-6, `zHi=${s.zHi}`);
  const full = underReturnSolids(planSolids(layers), f1.walls);
  assert.ok(full.length >= 1);
  for (const s of full) assert.equal(s.zHi, layerCeilZ(layers[0]), '蹴上が決まらなければ天井高');
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

// ---- 一般化: 階段の足元の中の壁（構造・壁の種類によらない）

const STEEL = { stairProps: { structure: StructuralMaterialType.STEEL } };

test('鉄骨の階段の足元の中にある階段下の部屋の壁は裏面（9 点の最小）以下・天井高より低く、足元の外の壁は天井高のまま', () => {
  const { f1, f2, layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000]], ...STEEL });
  const riser = FH / f1.stair.totalSteps;
  const surface = stairUndersideSurface({ stair: f1.stair, graph: f1.graph, riser, floorZMm: 0, aboveGraph: f2.graph, zStartMm: 0 });
  assert.ok(surface, '前提: 鉄骨でも裏面の面が組める');
  const ceil = layerCeilZ(layers[0]);
  const walls = wallsOf(planSolids(layers));
  const capped = walls.filter(s => s.zHi < ceil - 1e-6);
  assert.ok(capped.length >= 2, `足元の中の壁が裏面で止まる（${capped.length} 件）`);
  for (const s of capped) for (const r of s.footprint.rects) {
    assert.ok(s.zHi <= surfaceMinOver(surface, r) + 1e-6, `zHi=${s.zHi} ≤ 裏面 ${surfaceMinOver(surface, r)}`);
  }
  // 復路レーンの外（x>1942.5）にある東の壁は足元の外＝天井高のまま
  const east = walls.filter(s => s.footprint.rects.every(r => r.x1 >= 1942.5 - 1e-6));
  assert.ok(east.length >= 1, '前提: 東の壁がある');
  for (const s of east) assert.equal(s.zHi, ceil, '足元の外は天井高');
});

test('見下げ: 鉄骨の階段下の部屋の壁のうち足元の中の区間は踏面より下（上階の床の穴ごしに線として現れない）', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000]], ...STEEL });
  const below = [{ graph: layers[1].graph, floorZMm: 0, role: 'self' }, { graph: f1.graph, floorZMm: -FH, role: 'below' }];
  const solids = planSolids(below);
  const treads = solids.filter(s => s.kind === 'stairTread' && s.source.layerFloorZ === -FH);
  assert.ok(treads.length >= 1, '前提: 踏面がある');
  const firstReturn = treads.filter(s => { const p = s.footprint.poly; const xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1); return Math.min(...xs) >= 1000 - 1 && Math.min(...ys) <= 1000 + 60; });
  const treadZ = Math.min(...firstReturn.map(s => s.zHi));
  const north = wallsOf(solids, -FH).filter(s => s.footprint.rects.some(r => r.y1 < 1000 && r.y2 > 1000));
  assert.ok(north.length >= 1, '前提: 前縁上の壁がある');
  for (const s of north) assert.ok(s.zHi <= treadZ + 1e-6, `壁の天端 ${s.zHi} ≤ 踏面 ${treadZ}`);
});

test('足元の端をまたぐ壁は境界で割れる（足元の中は裏面以下・外は天井高）', () => {
  // 階段下の部屋を x1000〜3000 に広げる。北の壁 y=1000 は復路レーンの端 x=1942.5 をまたぐ
  const { layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000], [2000, 1000, 3000, 4000]], ...STEEL });
  const ceil = layerCeilZ(layers[0]);
  const north = wallsOf(planSolids(layers)).filter(s => s.footprint.rects.some(r => r.y1 < 1000 && r.y2 > 1000));
  const inside = north.filter(s => s.zHi < ceil - 1e-6), outside = north.filter(s => s.zHi === ceil);
  assert.ok(inside.length >= 1 && outside.length >= 1, `割れる: 内 ${inside.length} 件・外 ${outside.length} 件`);
  const edge = Math.max(...inside.flatMap(s => s.footprint.rects.map(r => r.x2)));
  assert.ok(edge < 2000 + 1e-6 && Math.min(...outside.flatMap(s => s.footprint.rects.map(r => r.x1))) >= edge - 1e-6, '境界は足元の端で内外が接する');
});

test('傾斜に沿う長い壁は段の境界でも割れ、区間ごとに裏面以下で止まる（低い端の値へ全長下がらない）', () => {
  const { f1, f2, layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 1500, 4000]], ...STEEL });
  const surface = stairUndersideSurface({ stair: f1.stair, graph: f1.graph, riser: FH / f1.stair.totalSteps, floorZMm: 0, aboveGraph: f2.graph, zStartMm: 0 });
  // 東の壁 x=1500（軸が復路レーンの中）。y 方向に走り、足元の中で裏面が傾斜する
  const west = wallsOf(planSolids(layers)).filter(s => s.footprint.rects.every(r => r.x1 >= 1442.5 - 1e-6 && r.x2 <= 1557.5 + 1e-6));
  assert.ok(west.length >= 3, `段の境界で割れる（${west.length} 件）`);
  assert.ok(new Set(west.map(s => Math.round(s.zHi * 1e3))).size >= 3, '区間ごとに高さが違う');
  for (const s of west) for (const r of s.footprint.rects) assert.ok(s.zHi <= surfaceMinOver(surface, r) + 1e-6, `zHi=${s.zHi} ≤ 裏面 ${surfaceMinOver(surface, r)}`);
});

test('【失敗系】蹴上が決まらない（直上の層なし・riserOf なし）→ 鉄骨でも天井高のまま。例外なし', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000]], ...STEEL });
  const layers = [{ graph: f1.graph, floorZMm: 0, role: 'self' }];
  const walls = wallsOf(planSolids(layers));
  assert.ok(walls.length >= 1);
  for (const s of walls) assert.equal(s.zHi, layerCeilZ(layers[0]));
});

test('【失敗系】裏面が組めない型（L_TURN）→ 天井高のまま。例外なし', () => {
  const { f1, f2, layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000]], ...STEEL });
  f1.stair.type = StairType.L_TURN;
  assert.equal(stairUndersideSurface({ stair: f1.stair, graph: f1.graph, riser: FH / f1.stair.totalSteps, floorZMm: 0, aboveGraph: f2.graph }), null, '前提: 裏面が組めない');
  const walls = wallsOf(planSolids(layers));
  assert.ok(walls.length >= 1);
  for (const s of walls) assert.equal(s.zHi, layerCeilZ(layers[0]));
});

test('【失敗系】階段の足元に壁が無い層 → 例外なく壁の立体は 0 件', () => {
  const { layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000]], underWalls: false, ...STEEL });
  assert.equal(wallsOf(planSolids(layers)).length, 0);
});

test('stairUndersideSurface は構造によらず面を返す（木造は天伏の立体と同じ面）。stairSoffitSolids（天伏）は木造だけが立体にする', () => {
  const f1 = makeFloor('p1', 0, { stairRects: EQUAL_UP });
  const riser = FH / f1.stair.totalSteps;
  const args = { stair: f1.stair, graph: f1.graph, riser, floorZMm: 0 };
  const wood = stairSoffitSolids(args)[0];
  const surfaceWood = stairUndersideSurface(args);
  assert.deepEqual(wood.footprint, surfaceWood.footprint);
  assert.equal(wood.zAt(1500, 1000), surfaceWood.zAt(1500, 1000), '天伏の立体は同じ面');
  f1.stair.structure = StructuralMaterialType.STEEL;
  assert.ok(stairUndersideSurface(args)?.zAt, '鉄骨でも面が組める');
  assert.deepEqual(stairSoffitSolids(args), [], '鉄骨は天伏の立体にしない');
});

test('下地の壁と仕上げの薄壁は裏面で止めても 1 立体にまとまる（補間の float 誤差で割れない。木造 EQUAL_UP）', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  const under = underReturnSolids(planSolids(layers), f1.walls);
  assert.equal(under.length, 1, `1 立体（${under.length} 件）`);
  assert.equal(under[0].source.mergedIds?.length, 2, 'オーナー壁＋薄壁がまとまっている');
});

test('軸（帯の中央）が足元の外・帯だけ足元の縁と重なる壁（階段室の外周壁）は天井高のまま', () => {
  // 階段の下側（y4000〜5000）の部屋。その北壁 y=4000 は復路の到達側の縁に乗り、帯だけが足元と重なる
  const { layers } = twoFloors({ stairRects: EQUAL_UP, extraRects: [[0, 4000, 1000, 5000], [1000, 4000, 2000, 5000]], ...STEEL });
  const ceil = layerCeilZ(layers[0]);
  const walls = wallsOf(planSolids(layers));
  assert.ok(walls.length >= 1, '前提: 壁がある');
  for (const s of walls) assert.equal(s.zHi, ceil, '足元の外の壁は天井高');
});

test('屋外階段の足元の壁は天井高のまま（屋外階段の下に壁は立たない）', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[1000, 1000, 2000, 4000]], ...STEEL });
  f1.stairRoom.kind = RoomKind.EXTERIOR;
  const walls = wallsOf(planSolids(layers));
  assert.ok(walls.length >= 1, '前提: 壁がある');
  for (const s of walls) assert.equal(s.zHi, layerCeilZ(layers[0]));
});

test('往路の基端の下の壁は立体を作らない（zHi ≤ 0 の区間が出ない）', () => {
  const { layers } = twoFloors({ stairRects: EQUAL_UP, underRects: [[0, 3000, 1000, 4000]], ...STEEL });
  const walls = wallsOf(planSolids(layers));
  assert.ok(walls.length >= 1, '前提: 壁がある');
  for (const s of walls) assert.ok(s.zHi > s.zLo && s.zHi > 0, `zHi=${s.zHi}`);
  assert.equal(walls.filter(s => s.footprint.rects.some(r => r.y1 >= 3900)).length, 0, 'y=4000 の帯に立体なし');
});

test('鉄骨でも下地の壁と仕上げの薄壁は足元の中の区間ごとに同じ高さで止まり 1 立体にまとまる（float 誤差で割れない）', () => {
  const { f1, layers } = twoFloors({ stairRects: EQUAL_UP });
  f1.stair.structure = StructuralMaterialType.STEEL; // 壁は木造の生成壁のまま、階段だけ鉄骨にする（underReturnWallTops の対象外にして一般規則だけで止める）
  assert.equal(f1.walls.length, 2, '前提: オーナー壁＋薄壁');
  const under = underReturnSolids(planSolids(layers), f1.walls);
  const capped = under.filter(s => s.zHi < layerCeilZ(layers[0]) - 1e-6);
  assert.ok(capped.length >= 1, '前提: 足元の中で裏面に止まる区間がある');
  assert.ok(capped.some(s => (s.source.mergedIds?.length ?? 0) === 2), '止まった区間のうち、オーナー壁と薄壁が両方ある区間は 1 立体にまとまる');
});
