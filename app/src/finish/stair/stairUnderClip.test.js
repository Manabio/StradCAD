// stairUnderWallClips の復路下の壁への適用（ユーザー指示 2026-10-14「折返し階段復路下の壁：破れ線下のみ描画。
// 復路階段には重ねない」）。2a壁と同じ keep 領域（破れ先セル＋破れ線弦の半平面）のクリップを受ける。
// フィクスチャは stairUnderReturnWalls.test.js と同じ EQUAL_UP（踊り場 y0〜1000・往路 x0〜1000・復路 x1000〜2000。
// 破れ線の弦は (2000,955)〜(1000,1532)。復路下の壁は y=1000 の x942.5〜2000＝弦の手前＝踏面側がほぼ全部）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, PlanGraph, Plane, CenterLineType, Discipline, StairType } from '@core';
import { stairUnderWallClips } from './stairUnderClip.js';
import { generateStairPartitionWalls, generateStairUnderReturnWalls } from './stairPartitionWalls.js';
import { stairUnderReturnLines, isStairUnderReturnWall } from './stairPartition.js';
import { cellsBeyondBreak } from './stairGeometry.js';
import { roomBounds } from '../gridCells.js';
import { measureStairSpans } from './stairClassify.js';
import { regenerateWalls, loadMaterialMap } from '../wallRegeneration.js';
import { TRADITIONAL_WOOD_STRUCTURE as WOOD } from '../../structural/structureRules.js';

const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];
const RISER = 175;

function makeStair(rects = EQUAL_UP, stairProps = {}) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v);
  const H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
  return { graph, stair, V, H };
}
const entryOf = (graph, stair, riser = RISER) => ({
  id: stair.id, stair, graph, bounds: roomBounds(stair.cells, graph), riser, spans: measureStairSpans(stair, graph), view: 'install',
});
const genU = (graph) => generateStairUnderReturnWalls(graph, { structure: WOOD });
const genP = (graph) => generateStairPartitionWalls(graph, { structure: WOOD });

// サブパス群の nonzero 巻き数による「描画される領域」の判定（ShapesLayer のクリップ規則と同じ代数）。
function windingOf(poly, p) {
  let wn = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const isLeft = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
    if (a.y <= p.y) { if (b.y > p.y && isLeft > 0) wn++; }
    else if (b.y <= p.y && isLeft < 0) wn--;
  }
  return wn;
}
const visibleAt = (subpaths, p) => subpaths.reduce((s, poly) => s + windingOf(poly, p), 0) !== 0;

test('復路下の壁: 破れ線の踏面側（弦の手前）の壁の範囲は描画領域の外（壁は描かれない）', () => {
  const { graph, stair } = makeStair();
  const walls = genU(graph);
  assert.equal(walls.length, 2, '前提: 復路下の壁2枚');
  const clips = stairUnderWallClips(graph, [entryOf(graph, stair)], { laneGap: true });
  assert.ok(clips instanceof Map);
  for (const w of walls) {
    const sub = clips.get(w.id);
    assert.ok(sub, '復路下の壁にクリップが付く');
    // 壁 y942.5〜1057.5 のうち、弦（x=1900 で y≒1013）より手前の x1000〜1850 は y 全幅が踏面側
    for (const x of [1000, 1200, 1500, 1800]) {
      for (const y of [945, 1000, 1055]) assert.equal(visibleAt(sub, { x, y }), false, `(${x},${y}) は踏面側＝描かない`);
    }
  }
});

test('復路下の壁: 破れ線を越えた先（弦の先側）の部分も含め、壁の範囲全体が描画領域の外（復路に重ねない）', () => {
  const { graph, stair } = makeStair();
  const walls = genU(graph);
  const clips = stairUnderWallClips(graph, [entryOf(graph, stair)], { laneGap: true });
  for (const w of walls) {
    const sub = clips.get(w.id);
    // 弦は (2000,955)〜(1000,1532)。x=1990 では y≒961 より下（破れ先側）の (1990,1040) も描かない
    assert.equal(visibleAt(sub, { x: 1990, y: 1040 }), false, '破れ先側も描かない');
    assert.equal(visibleAt(sub, { x: 1990, y: 945 }), false, '弦の手前側も描かない');
    for (let x = 950; x <= 2000; x += 50) {
      for (const y of [942.5, 1000, 1057.5]) assert.equal(visibleAt(sub, { x, y }), false, `(${x},${y})`);
    }
  }
});

test('【失敗系】復路下の壁が無ければ（隔て壁だけ）クリップは付かず null', () => {
  const { graph, stair } = makeStair();
  const part = genP(graph);
  assert.equal(part.length, 2, '前提: 隔て壁はある');
  assert.equal(stairUnderWallClips(graph, [entryOf(graph, stair)], { laneGap: true }), null);
});

test('【失敗系】破れ先が判定できない（footprint 不正・中間階ガード）階段では復路下の壁にもクリップを付けない（従来どおり描く）', () => {
  const { graph, stair } = makeStair();
  const walls = genU(graph);
  assert.equal(walls.length, 2, '前提');
  assert.ok(cellsBeyondBreak(stair, graph, RISER).size > 0, '前提: 破れ先セルはある');
  const ok = entryOf(graph, stair);
  assert.equal(stairUnderWallClips(graph, [{ ...ok, bounds: { x1: NaN, y1: 0, x2: 1, y2: 1 } }], { laneGap: true }), null, 'footprint 不正');
  const lowerStair = [{ x1: 1000, y1: 1000, x2: 2000, y2: 4000 }]; // 下階階段の見下げが破れ先に重なる＝中間階
  assert.equal(stairUnderWallClips(graph, [ok], { laneGap: true, lowerStairCellBounds: lowerStair }), null, '中間階ガード');
  // 対照: どちらも無ければ付く
  assert.ok(stairUnderWallClips(graph, [ok], { laneGap: true })?.has(walls[0].id));
});

test('【失敗系】普通の壁・隔て壁にはクリップを付けない（復路下の壁の2枚だけ）', () => {
  const { graph, stair, V, H } = makeStair();
  const under = genU(graph);
  const part = genP(graph);
  const own = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  const plain = graph.addWall(H(1000), 57.5, false, V(1000), 0, V(2000), 0, { ...own, isRoomWall: false });
  const outer = graph.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, own);
  const clips = stairUnderWallClips(graph, [entryOf(graph, stair)], { laneGap: true });
  assert.deepEqual([...clips.keys()].sort(), under.map(w => w.id).sort());
  for (const w of [plain, outer, ...part]) assert.equal(clips.has(w.id), false, w.id);
});

test('復路下の壁の線は階段ごと: 識別は stairUnderReturnLines と同じ壁（クリップ対象 = 識別された壁）', () => {
  const { graph, stair } = makeStair();
  genU(graph);
  genP(graph);
  const lines = stairUnderReturnLines(graph);
  const clips = stairUnderWallClips(graph, [entryOf(graph, stair)], { laneGap: true });
  const expected = graph.walls.filter(w => isStairUnderReturnWall(w, lines)).map(w => w.id).sort();
  assert.deepEqual([...clips.keys()].sort(), expected);
});

// 2a壁（階段下部屋）のある構成（stairEntries.test.js graphWithStairUnderWalls と同構成）
async function graphWith2a() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1)); // structureOverride なし＝再生成は復路下の壁を作らない
  const V = v => graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH });
  const H = v => graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = V(0), xm = V(1000), x1 = V(2000), y0 = H(0), ym = H(1500), y1 = H(4500);
  const landingKey = `${x0.id}:${y0.id}:${x1.id}:${ym.id}`;
  const outboundKey = `${x0.id}:${ym.id}:${xm.id}:${y1.id}`;
  const returnKey = `${xm.id}:${ym.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([landingKey, outboundKey]), '階段');
  const stair = graph.addStair({
    type: StairType.SWITCHBACK, cells: new Set([landingKey, outboundKey, returnKey]), roomId: room.id,
    sections: [6, 1, 6], riser: null, upDirection: 'up', flip: false,
  });
  const under = graph.addRoom(new Set(cellsBeyondBreak(stair, graph, stair.riser ?? null)), '階段下');
  await regenerateWalls(graph, { materialMap: await loadMaterialMap(), stairUnderEntries: [{ stair, room: under, splitCLIds: new Set() }] });
  return { graph, stair, under };
}

test('2a壁のクリップは復路下の壁の有無で変わらない（2a壁のエントリは同じ値のまま・復路下の壁の分だけ増える）', async () => {
  const { graph, stair, under } = await graphWith2a();
  const entry = { ...entryOf(graph, stair, null), riser: null };
  const returnWallsOf = () => graph.walls.filter(w => isStairUnderReturnWall(w, stairUnderReturnLines(graph)));
  // 復路下の壁を全部外した状態＝2a壁だけのクリップ
  returnWallsOf().forEach(w => graph.removeShape(w.id));
  const before = stairUnderWallClips(graph, [entry], { laneGap: true });
  assert.ok(before && before.size > 0, '前提: 2a壁のクリップがある');
  for (const id of before.keys()) assert.ok(under.generatedWallIds.has(id), '前提: キーは2a壁');
  const uw = genU(graph);
  assert.ok(uw.length > 0, '前提: 復路下の壁が追加された');
  const after = stairUnderWallClips(graph, [entry], { laneGap: true });
  for (const [id, sub] of before) assert.deepEqual(after.get(id), sub, `2a壁 ${id} は不変`);
  assert.equal(after.size, before.size + uw.length);
  for (const w of uw) assert.ok(after.has(w.id), '復路下の壁にもクリップ');
});
