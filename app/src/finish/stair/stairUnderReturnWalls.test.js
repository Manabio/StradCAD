// 在来木造・折返し階段の復路下の壁（隔て壁 S3。ユーザー指示 2026-10-14「復路階段下に壁」）の生成・識別・
// 構造/腰壁/展開図中壁検出からの除外・本番経路の確認。
// フィクスチャは stairPartitionWalls.test.js と同じ（EQUAL_UP＝踊り場 y0〜1000・往路 x0〜1000・復路 x1000〜2000。
// upDirection:'up' なので走行軸は縦、踊り場前縁は y=1000。復路の外側は s=1＝x=2000（flip なら x=0））。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Project, StructuralMaterialType, CenterLineType, Discipline, StairType, RoomKind, RoomFeature } from '@core';
import { generateStairPartitionWalls, generateStairUnderReturnWalls } from './stairPartitionWalls.js';
import {
  stairPartitionLines, isStairPartitionWall, stairUnderReturnLines, isStairUnderReturnWall, stairLandingFrontLine,
} from './stairPartition.js';
import { selfWallSegments, wallBackingCenters } from '../../structural/wallBeamAxes.js';
import { stairPartitionEnds } from '../../structural/wallFreeEnds.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { isEligibleWallSpan } from '../kneeDropWall.js';
import { WALL_KEY_VERSION } from '../wallFreshnessKey.js';
import { runFinishExitBoundary } from '../finishBoundary.js';
import { loadMaterialMap, regenerateWalls } from '../wallRegeneration.js';
import { findMidWall } from '../../elevation/section/cuts/switchbackCuts.js';
import { undoManager } from '../../undoManager.js';
import { resolveStairContext } from './stairUnderRooms.js';

const WOOD = TRADITIONAL_WOOD_STRUCTURE;
const EQUAL_UP = [[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]];

function makeStair(rects, stairProps = {}, { clProps = () => ({}) } = {}) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH, ...clProps(type, v) })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v);
  const H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
  return { project, graph, stair, V, H };
}
const genU = (graph, o = {}) => generateStairUnderReturnWalls(graph, { structure: WOOD, ...o });
const genP = (graph, o = {}) => generateStairPartitionWalls(graph, { structure: WOOD, ...o });
const clCount = (graph) => graph.centerLines.length;
const range = (r) => (r ? { lo: r.lo, hi: r.hi } : null);
const physSpan = (w) => [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)];
const designSpan = (w) => [Math.min(w.clStart.effectiveValue, w.clEnd.effectiveValue), Math.max(w.clStart.effectiveValue, w.clEnd.effectiveValue)];

test('在来・SWITCHBACK・等長: 踊り場前縁 y=1000 上に、隔て壁の軸 x=1000 から復路の外側 x=2000 までオーナー壁＋薄壁の2枚。材/下地の範囲・仕上げが隔て壁と同じ。どの Room の generatedWallIds にも入らない', () => {
  const { graph } = makeStair(EQUAL_UP);
  const room = graph.addRoom(new Set(graph.stairs[0].cells), '階段');
  const walls = genU(graph);
  assert.equal(walls.length, 2);
  const [owner, thin] = walls;
  for (const w of walls) {
    assert.equal(w.isRoomWall, true);
    assert.equal(w.isExteriorWall, false);
    assert.equal(w.isVertical, false, '前縁に沿う水平の壁');
    assert.equal(w.axisCL.value, 1000);
    assert.deepEqual(designSpan(w), [1000, 2000], '設計上の区間は隔て壁の軸 x=1000 〜 復路の外側 x=2000');
    assert.equal(w.wallFinish, 12.5);
    assert.equal(w.backingOffset, 0);
  }
  assert.deepEqual([owner.axisOffset, owner.backingDepth, owner.finishSide], [57.5, 90, 1]);
  assert.deepEqual(range(owner.materialRange), { lo: 955, hi: 1057.5 });
  assert.deepEqual(range(owner.backingRange), { lo: 955, hi: 1045 });
  assert.deepEqual([thin.axisOffset, thin.backingDepth, thin.finishSide], [-57.5, 0, -1]);
  assert.deepEqual(range(thin.materialRange), { lo: 942.5, hi: 955 });
  assert.equal(thin.backingRange, null);
  assert.equal(room.generatedWallIds.size, 0);
  assert.ok(graph.rooms.every(r => r.generatedWallIds.size === 0));
});

test('前縁の線（stairLandingFrontLine）と一致: 壁の軸は前縁の along・区間は sideA/sideB の across のうち隔て壁の軸〜sideB', () => {
  const { graph, stair } = makeStair(EQUAL_UP);
  const front = stairLandingFrontLine(stair, graph);
  const [line] = stairUnderReturnLines(graph);
  assert.equal(line.axisValue, front.along);
  assert.deepEqual([line.lo, line.hi], [1000, front.sideB.x]);
  assert.equal(front.sideA.x, 0, '往路側の辺');
});

test('隔て壁との角: 軸に当たる端（始端 x=1000）は往路側へ隔て壁の外面（軸−57.5）まで延びる。外壁側の端（x=2000）は端CLで止まる。2枚とも同じ', () => {
  const { graph } = makeStair(EQUAL_UP);
  const walls = genU(graph);
  for (const w of walls) {
    assert.deepEqual(physSpan(w), [1000 - 57.5, 2000]);
    assert.equal(w.startOffset, -57.5);
    assert.equal(w.endOffset, 0);
  }
  // 隔て壁の外面（材の範囲の下限＝薄壁の外面 x=942.5）と一致する
  const part = genP(graph);
  assert.equal(Math.min(...part.map(w => w.materialRange.lo)), 942.5);
  assert.equal(physSpan(walls[0])[0], 942.5);
});

test('復路が x=0 側（flip）でも復路の外側へ立つ: 区間 x0〜1000・軸に当たる端は終端で、往路側（x 大）へ +57.5', () => {
  const { graph } = makeStair(EQUAL_UP, { flip: true });
  const walls = genU(graph);
  assert.equal(walls.length, 2);
  for (const w of walls) {
    assert.deepEqual(designSpan(w), [0, 1000]);
    assert.deepEqual(physSpan(w), [0, 1000 + 57.5]);
    assert.equal(w.startOffset, 0);
    assert.equal(w.endOffset, 57.5);
  }
  assert.deepEqual(stairUnderReturnLines(graph), [{ isVertical: false, axisValue: 1000, lo: 0, hi: 1000 }]);
});

test('WINDING でも SWITCHBACK と同じく2枚', () => {
  const { graph } = makeStair(EQUAL_UP, { type: StairType.WINDING, sections: [6, 3, 6] });
  assert.equal(genU(graph).length, 2);
});

test('識別 isStairUnderReturnWall: 復路下の壁2枚は真で隔て壁は偽。隔て壁の識別は復路下の壁を拾わない。普通の壁・手動壁・外壁は偽', () => {
  const { graph, V, H } = makeStair(EQUAL_UP);
  const under = genU(graph);
  const part = genP(graph);
  const uLines = stairUnderReturnLines(graph);
  const pLines = stairPartitionLines(graph);
  assert.deepEqual(uLines, [{ isVertical: false, axisValue: 1000, lo: 1000, hi: 2000 }]);
  assert.ok(under.every(w => isStairUnderReturnWall(w, uLines)));
  assert.ok(under.every(w => !isStairPartitionWall(w, pLines)), '隔て壁としては識別されない');
  assert.ok(part.every(w => !isStairUnderReturnWall(w, uLines)), '隔て壁は復路下の壁ではない');
  assert.equal(isStairUnderReturnWall(under[0], []), false, '線が無ければ偽');
  const y1 = H(1000), x1 = V(1000), x2 = V(2000), x0 = V(0);
  const room = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  const mk = (cl, off, a, b, props) => graph.addWall(cl, off, false, a, 0, b, 0, props);
  assert.equal(isStairUnderReturnWall(mk(y1, 57.5, x1, x2, { ...room, isRoomWall: false }), uLines), false, '手動壁');
  assert.equal(isStairUnderReturnWall(mk(y1, 57.5, x1, x2, { ...room, isExteriorWall: true }), uLines), false, '外壁');
  assert.equal(isStairUnderReturnWall(mk(y1, 0, x1, x2, { isRoomWall: true, wallFinish: 12.5 }), uLines), false, '対称の普通の壁（軸オフセット0）');
  assert.equal(isStairUnderReturnWall(mk(y1, 57.5, x0, x1, room), uLines), false, '区間が線の外（往路側）');
  assert.equal(isStairUnderReturnWall(mk(H(4000), 57.5, x1, x2, room), uLines), false, '別の軸');
});

test('【失敗系】鉄骨の階段・在来木造以外の建物・U 字系以外は0枚（対照: 木造の階段は2枚）', () => {
  const wood = makeStair(EQUAL_UP);
  assert.equal(genU(wood.graph).length, 2, '対照');
  const steel = makeStair(EQUAL_UP);
  steel.stair.structure = StructuralMaterialType.STEEL;
  assert.equal(genU(steel.graph).length, 0);
  assert.equal(steel.graph.walls.length, 0);
  for (const structure of ['S造', 'RC造(ラーメン)', '木造（2"×4"）', null]) {
    assert.equal(genU(wood.graph, { structure }).length, 0, String(structure));
  }
  for (const type of [StairType.STRAIGHT, StairType.STRAIGHT_LANDING, StairType.L_TURN, StairType.FLARED, StairType.OPEN_WELL]) {
    const t = makeStair(EQUAL_UP, { type });
    assert.equal(genU(t.graph).length, 0, type);
    assert.deepEqual(stairUnderReturnLines(t.graph), [], type);
  }
});

test('【失敗系】屋外階段（ペア部屋が EXTERIOR）は0枚で線にも含めない。対照: 屋内は2枚', () => {
  const { graph, stair } = makeStair(EQUAL_UP);
  const pair = graph.addRoom(new Set(stair.cells), '階段');
  pair.setFeature(RoomFeature.STAIR);
  stair.roomId = pair.id;
  assert.equal(genU(graph).length, 2, '対照（屋内）');
  graph.walls.forEach(w => graph.removeShape(w.id));
  pair.setKind(RoomKind.EXTERIOR);
  assert.equal(genU(graph).length, 0);
  assert.deepEqual(stairUnderReturnLines(graph), []);
});

test('【失敗系】軸CL（y=1000）が梁芯／端CL（x=2000）が梁芯／隔て壁の軸 CL（x=1000）が無い構成 → 0枚で例外を投げず CL を作らない', () => {
  const noAxis = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.HORIZONTAL && v === 1000 ? { discipline: Discipline.FUSE } : {}) });
  let before = clCount(noAxis.graph);
  assert.deepEqual(genU(noAxis.graph), []);
  assert.equal(clCount(noAxis.graph), before);
  const noOuter = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 2000 ? { discipline: Discipline.FUSE } : {}) });
  before = clCount(noOuter.graph);
  assert.deepEqual(genU(noOuter.graph), []);
  assert.equal(clCount(noOuter.graph), before);
  const noInner = makeStair(EQUAL_UP, {}, { clProps: (type, v) => (type === CenterLineType.VERTICAL && v === 1000 ? { discipline: Discipline.FUSE } : {}) });
  assert.deepEqual(genU(noInner.graph), []);
});

test('2a が受け持つ区間は差し引く: 全区間なら0枚・別軸や向き違いは影響しない。一部（x1000〜1500）なら残り x1500〜2000 だけ（始端は軸に当たらないので延ばさない）', () => {
  const { graph, H, V } = makeStair(EQUAL_UP);
  assert.equal(genU(graph, { underEdges: [{ isVertical: false, value: 1000, lo: 0, hi: 5000 }] }).length, 0);
  assert.equal(genU(graph, { underEdges: [{ isVertical: false, value: 1000.4, lo: 0, hi: 5000 }] }).length, 0, '軸の許容0.5mm以内');
  assert.equal(genU(graph, { underEdges: [{ isVertical: false, value: 1500, lo: 0, hi: 5000 }] }).length, 2, '別の軸');
  assert.equal(genU(graph, { underEdges: [{ isVertical: true, value: 1000, lo: 0, hi: 5000 }] }).length, 2, '向きが違う');
  graph.walls.forEach(w => graph.removeShape(w.id));
  // 残りの端（x=1500）に CL が無ければ黙って生成しない
  assert.equal(genU(graph, { underEdges: [{ isVertical: false, value: 1000, lo: 1000, hi: 1500 }] }).length, 0);
  V(1500);
  const part = genU(graph, { underEdges: [{ isVertical: false, value: 1000, lo: 1000, hi: 1500 }] });
  assert.deepEqual(part.map(designSpan), [[1500, 2000], [1500, 2000]]);
  assert.ok(part.every(w => w.startOffset === 0 && w.endOffset === 0), '切れた端は延ばさない');
  assert.ok(H(1000));
});

test('再生成の冪等: 削除して作り直しても2枚のまま（壁数・形が同じ）', () => {
  const { graph } = makeStair(EQUAL_UP);
  const shape = () => graph.walls.map(w => [w.axisOffset, w.backingDepth, ...physSpan(w)].join('|')).sort();
  genU(graph);
  const first = shape();
  assert.equal(graph.walls.length, 2);
  graph.walls.forEach(w => graph.removeShape(w.id));
  genU(graph);
  assert.equal(graph.walls.length, 2);
  assert.deepEqual(shape(), first);
});

// ---- 除外（隔て壁と同じ判断）----
function addOuterWalls(graph, V, H) {
  const own = { isRoomWall: true, wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 };
  graph.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, own);
  graph.addWall(V(2000), -57.5, true, H(0), 0, H(4000), 0, { ...own, finishSide: -1 });
  graph.addWall(H(0), 57.5, false, V(0), 0, V(2000), 0, own);
  graph.addWall(H(4000), -57.5, false, V(0), 0, V(2000), 0, { ...own, finishSide: -1 });
}

test('構造の除外: selfWallSegments・wallBackingCenters に復路下の壁は含まれず（外周4壁だけ）、素の素材は下地オーナー（検出力）', () => {
  const { graph, V, H } = makeStair(EQUAL_UP);
  addOuterWalls(graph, V, H);
  const walls = genU(graph);
  assert.equal(walls.length, 2);
  assert.notEqual(walls[0].backingRange, null, '前提: 除外しなければ壁ソースに入る下地オーナー');
  const segs = selfWallSegments(graph);
  assert.equal(segs.length, 4);
  assert.equal(segs.some(s => !s.isVertical && Math.abs(s.coord - 1000) < 1), false);
  const centers = wallBackingCenters(graph);
  assert.equal(centers.length, 4);
  assert.equal(centers.some(c => c.axisCLId === walls[0].axisCL.id), false);
});

test('腰壁・垂れ壁: isEligibleWallSpan は復路下の壁で false、普通の内壁で true', () => {
  const { graph, V, H } = makeStair(EQUAL_UP);
  const [owner, thin] = genU(graph);
  assert.equal(isEligibleWallSpan(owner, graph), false);
  assert.equal(isEligibleWallSpan(thin, graph), false);
  const plain = graph.addWall(V(0), 57.5, true, H(0), 0, H(4000), 0, { isRoomWall: true, wallFinish: 12.5 });
  assert.equal(isEligibleWallSpan(plain, graph), true);
});

test('展開図の中壁検出: findMidWall は隔て壁を拾い、前縁に沿う復路下の壁（向きが直交）は拾わない', () => {
  const wEntry = { lo: 0, hi: 2000, faceValue: 4000 };
  const wLanding = { faceValue: 0 };
  const f = { vertical: true };
  const onlyUnder = makeStair(EQUAL_UP);
  genU(onlyUnder.graph);
  assert.equal(findMidWall(onlyUnder.graph, wEntry, wLanding, 1000, f), null);
  const both = makeStair(EQUAL_UP);
  genU(both.graph);
  const part = genP(both.graph);
  assert.equal(findMidWall(both.graph, wEntry, wLanding, 1000, f)?.id, part[0].id, '対照: 隔て壁は拾う');
});

test('鮮度キーの版は v9 以上（復路下の壁の生成で壁集合が変わるため既存キーを不一致にする）', () => {
  assert.ok(Number(WALL_KEY_VERSION.slice(1)) >= 9, WALL_KEY_VERSION);
});

// ---- 本番経路（runFinishExitBoundary）----
async function makeFixtureNo2a({ type = StairType.SWITCHBACK, sections = [6, 1, 6], structure = null } = {}) {
  const project = new Project('proj', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = WOOD;
  const mk = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [-3000, 0, 1000, 2000, 5000].map(v => mk(CenterLineType.VERTICAL, v));
  const ys = [-3000, 0, 1000, 4000, 6000].map(v => mk(CenterLineType.HORIZONTAL, v));
  const key = (c, r) => `${xs[c].id}:${ys[r].id}:${xs[c + 1].id}:${ys[r + 1].id}`;
  const cells = new Set([key(1, 1), key(2, 1), key(1, 2), key(2, 2)]);
  const pair = graph.addRoom(new Set(cells), '階段');
  pair.setFeature(RoomFeature.STAIR);
  const stair = graph.addStair({ type, cells, roomId: pair.id, sections, riser: null, upDirection: 'up', flip: false });
  if (structure) stair.structure = structure;
  const materialMap = await loadMaterialMap();
  return { project, graph, stair, fmode: { materialMap, stairUnderRooms: () => [] } };
}
const underWalls = (graph) => { const l = stairUnderReturnLines(graph); return graph.walls.filter(w => isStairUnderReturnWall(w, l)); };
const partWalls = (graph) => { const l = stairPartitionLines(graph); return graph.walls.filter(w => isStairPartitionWall(w, l)); };
const shapeSet = (graph) => graph.walls
  .map(w => [w.isVertical ? 'V' : 'H', w.axisCL.effectiveValue, w.axisOffset, ...physSpan(w), w.backingDepth, w.finishSide].join('|')).sort();

test('本番経路: 脱出で復路下の壁2枚（物理端 x=942.5〜2000）。隔て壁は2枚のまま踊り場側が前縁より 57.5 はね出す（y=942.5〜4000）で変わらず、踊り場側は自由端のまま', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const under = underWalls(graph);
  assert.equal(under.length, 2);
  for (const w of under) {
    assert.deepEqual(physSpan(w), [942.5, 2000]);
    assert.deepEqual(designSpan(w), [1000, 2000]);
  }
  const part = partWalls(graph);
  assert.equal(part.length, 2);
  for (const w of part) assert.deepEqual(physSpan(w), [942.5, 4000], '隔て壁の柱包みは変わらない');
  const landing = stairPartitionEnds(graph, project).find(e => e.side === 'landing');
  assert.equal(landing.free, true, '復路下の壁は壁ソースに入らないので踊り場側は自由端のまま');
  // 冪等: 2回目でも壁の形状集合が同じ
  const first = shapeSet(graph);
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  assert.deepEqual(shapeSet(graph), first);
  assert.equal(underWalls(graph).length, 2);
});

test('【失敗系】本番経路: 鉄骨の階段・S造の建物では脱出しても復路下の壁は出ない', async () => {
  const steel = await makeFixtureNo2a({ structure: StructuralMaterialType.STEEL });
  await runFinishExitBoundary(steel.graph, steel.project, steel.fmode, { goingToStructure: false });
  assert.equal(underWalls(steel.graph).length, 0);
  const s = await makeFixtureNo2a();
  s.graph.structureOverride = 'S造';
  await runFinishExitBoundary(s.graph, s.project, s.fmode, { goingToStructure: false });
  assert.equal(underWalls(s.graph).length, 0);
});

test('本番経路【undo/redo】脱出の undo で復路下の壁が消え、redo で同じ値（物理端込み）に戻る', async () => {
  const { project, graph, fmode } = await makeFixtureNo2a();
  await runFinishExitBoundary(graph, project, fmode, { goingToStructure: false });
  const after = shapeSet(graph);
  assert.equal(underWalls(graph).length, 2, '前提');
  undoManager.undo();
  undoManager.undo();
  assert.equal(underWalls(graph).length, 0, 'undo で消える');
  undoManager.redo();
  undoManager.redo();
  assert.deepEqual(shapeSet(graph), after, 'redo で同じ値');
});

// ---- 下階の続き階段（復路の下は下階の階段の頭上空間＝壁で塞がない）----
function addFloorWithStair(project, elevation, name, id, rects, stairProps = {}) {
  const { graph } = project.addPlane(elevation, name, id);
  graph.structureOverride = WOOD;
  const vs = new Map(), hs = new Map();
  const mk = (type, map, v) => map.get(v) ?? map.set(v, graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const V = (v) => mk(CenterLineType.VERTICAL, vs, v);
  const H = (v) => mk(CenterLineType.HORIZONTAL, hs, v);
  const cells = new Set(rects.map(([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`));
  const stair = graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', ...stairProps });
  return { graph, stair };
}

test('下階の続き階段: 最下階（belowGraph なし）は2枚。同じ足元の階段が下階にある階は0枚。足元が一致しない階段は2枚', () => {
  const project = new Project('proj', 'test');
  const f1 = addFloorWithStair(project, 0, '1階', 'p1', EQUAL_UP);
  const f2 = addFloorWithStair(project, 3000, '2階', 'p2', EQUAL_UP);
  assert.equal(genU(f1.graph).length, 2, '1階（下階なし）');
  assert.equal(genU(f2.graph, { belowGraph: f1.graph }).length, 0, '2階: 下階に同じ足元の階段がある');
  f2.graph.walls.forEach(w => f2.graph.removeShape(w.id));
  // 足元が違う（下階の階段は y 2000〜）階段なら対象外＝壁を立てる
  const other = new Project('proj2', 'test');
  const g1 = addFloorWithStair(other, 0, '1階', 'q1', [[0, 0, 2000, 1000], [0, 1000, 1000, 3000], [1000, 1000, 2000, 3000]]);
  assert.equal(genU(f2.graph, { belowGraph: g1.graph }).length, 2, '足元が一致しない');
  // 下階に階段が無い
  const bare = new Project('proj3', 'test');
  const b1 = bare.addPlane(0, '1階', 'r1').graph;
  f2.graph.walls.forEach(w => f2.graph.removeShape(w.id));
  assert.equal(genU(f2.graph, { belowGraph: b1 }).length, 2, '下階に階段なし');
});

test('配線: resolveStairContext が直下階を返し、regenerateWalls が下階の続き階段を見て2階の復路下の壁を立てない（1階は立てる）。隔て壁は変わらない', async () => {
  const project = new Project('proj', 'test');
  const f1 = addFloorWithStair(project, 0, '1階', 'p1', EQUAL_UP);
  const f2 = addFloorWithStair(project, 3000, '2階', 'p2', EQUAL_UP);
  const materialMap = await loadMaterialMap();
  const peek = async (plane) => project.graphMap.get(plane.id) ?? null;
  const ctx1 = await resolveStairContext(f1.graph, project, peek);
  assert.equal(ctx1.belowGraph, null, '最下階は下階なし');
  await regenerateWalls(f1.graph, { materialMap, project, ...ctx1 });
  assert.equal(underWalls(f1.graph).length, 2, '1階');
  const ctx2 = await resolveStairContext(f2.graph, project, peek);
  assert.equal(ctx2.belowGraph, f1.graph);
  await regenerateWalls(f2.graph, { materialMap, project, ...ctx2 });
  assert.equal(underWalls(f2.graph).length, 0, '2階（続き階段あり）');
  assert.equal(partWalls(f2.graph).length, 2, '隔て壁は変わらず立つ');
});
