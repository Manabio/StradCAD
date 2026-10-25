// 展開図の階段帯への N+2（直上階のさらに上）の配線（S10-6 S2）。ElevationModeState が planes[idx+2] を peek して
// buildStairBand の ctx.upperUpperGraph へ渡すと、N+1 の階段の裏面（＝階段帯の天井 E5）の到達辺が N+2 の床梁の面になる。
// 配線の照合はソースの関数本体（行コメントを落として 1 行まるごと一致）、振る舞いは 3 階建ての fixture で init する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, StairType, StructuralMaterialType } from '@core';
import { makeGrid } from '../plan/planTestFixtures.js';
import { generateStairPartitionWalls } from '../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../structural/structureRules.js';
import { buildStairBand } from '../elevation/elevationStair.js';
import { ElevationModeState } from './ElevationModeState.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { stripCommentLines, extractFunctionBody } from '../uiBusySourceScan.js';

const src = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'ElevationModeState.js'), 'utf8'));
const STRUCT = { labeled: false, discipline: Discipline.STRUCT };

test('【配線】ElevationModeState: init は _peekSecondAboveGraph を peek 群に加え _upperUpperGraph へ保持。_peekSecondAboveGraph は planes[idx + 2] を peek。階段帯の ctx にだけ upperUpperGraph を渡す', () => {
  const init = extractFunctionBody(src, 'async init()');
  assert.match(init, /^\s*const \[upperGraph, lowerGraph, upperUpperGraph\] = await Promise\.all\(\[\s*$/m);
  assert.match(init, /^\s*this\._peekSecondAboveGraph\(\),\s*$/m);
  assert.match(init, /^\s*this\._upperUpperGraph = upperUpperGraph;\s*$/m);
  const peek2 = extractFunctionBody(src, 'async _peekSecondAboveGraph()');
  assert.match(peek2, /^\s*const above2 = idx >= 0 && idx \+ 2 < planes\.length \? planes\[idx \+ 2\] : null;\s*$/m);
  assert.match(peek2, /^\s*const temp = await floorSwapManager\.peek\(above2, project\.structGraph\);\s*$/m);
  assert.match(peek2, /^\s*return this\._disposed \? null : temp;\s*$/m);
  const build = extractFunctionBody(src, '_buildBandsInner()');
  assert.equal((build.match(/\bupperUpperGraph:/g) ?? []).length, 1, '階段帯の 1 箇所だけ（部屋帯・吹抜け帯へは渡さない）');
  assert.match(build, /^\s*return buildStairBand\(room, this\.graph, upperGraph, \{ \.\.\.ctx, stair: stairByRoomId\.get\(room\.id\) \?\? null, lowerGraph, upperUpperGraph: this\._upperUpperGraph \}\);\s*$/m);
  assert.match(extractFunctionBody(src, '_buildBands() {'), /withGraphReadScope\(this\._upperUpperGraph, /);
});

// 縦走行（上り）の木造 SWITCHBACK が壁つきで 1 つある階。階段の到達辺は y=4000
function stairFloor(id, floor, elevation) {
  const g = makeGrid([0, 1000, 2000], [0, 1000, 4000], { id, startFloor: floor });
  g.graph.plane.elevation = elevation;
  const room = g.interior([[0, 0], [1, 0], [0, 1], [1, 1]], { walls: false }); // 隔て壁だけ（外周の壁があると到達辺が柱の面でなくなり、裏面の到達辺は N+2 に依らない）
  room.setFeature(RoomFeature.STAIR); // 階段帯（buildStairBand）へ振り分けられる部屋
  const cells = new Set([g.cell(0, 0), g.cell(1, 0), g.cell(0, 1), g.cell(1, 1)]);
  const stair = g.graph.addStair({ type: StairType.SWITCHBACK, cells, sections: [6, 1, 6], flip: false, upDirection: 'up', roomId: room.id });
  stair.structure = StructuralMaterialType.WOOD;
  stair.riser = 200;
  g.graph.setStructureOverride('木造（在来）');
  for (const w of generateStairPartitionWalls(g.graph, { structure: TRADITIONAL_WOOD_STRUCTURE })) {
    const sign = Math.sign(w.clEnd.effectiveValue - w.clStart.effectiveValue) || 1;
    w.startOffset = -sign * 57.5;
    w.endOffset = sign * 57.5;
  }
  return { graph: g.graph, room, stair };
}

// 3 階: 到達辺（y=4000）に横梁を 1 本（withBeam）。N+1 の階段の裏面の到達辺が梁の面（FACE）か Q3 かが帯の天井線に出る。
function thirdFloor(withBeam) {
  const g = new PlanGraph(new Plane('p3', 4800, '3階', 3, 1));
  if (withBeam) {
    const axis = g.addCenterLine(CenterLineType.HORIZONTAL, 4000, STRUCT);
    const mk = v => g.addCenterLine(CenterLineType.VERTICAL, v, STRUCT);
    g.addBeam(StructuralMaterialType.WOOD, 'WOOD-120x120', axis, false, mk(0), mk(2000), {});
  }
  return g;
}

// QA 所見 A-1: buildStairBand 単位。ctx.upperUpperGraph が stairSoffitAbove の aboveGraph へ届く（届かなければ梁あり N+2 でも Q3 のまま）
const directBand = (upperUpperGraph) => {
  const n = stairFloor('p1', 1, 0), u = stairFloor('p2', 2, 2400);
  const ctx = { stair: n.stair, floorHeight: 2400, ...(upperUpperGraph === undefined ? {} : { upperUpperGraph }) };
  return JSON.stringify(buildStairBand(n.room, n.graph, u.graph, ctx).primitives);
};

test('【S10-6 S2・A-1】buildStairBand: ctx.upperUpperGraph の梁で裏面の到達辺が変わる。省略・null・梁なしは同一（Q3）', () => {
  const q3 = directBand();
  assert.notEqual(directBand(thirdFloor(true)), q3, '梁あり N+2＝到達辺が梁の面（FACE）');
  assert.equal(directBand(null), q3, 'null は省略と同じ');
  assert.equal(directBand(thirdFloor(false)), q3, '梁なしの N+2 は Q3 のまま');
});

async function stairBandOf({ withThird, withBeam, rejectThird = false, peeked = null }) {
  const n = stairFloor('p1', 1, 0), u = stairFloor('p2', 2, 2400);
  const third = withThird ? thirdFloor(withBeam) : null;
  const planes = [n.graph.plane, u.graph.plane, ...(third ? [third.plane] : [])];
  const byId = new Map([[u.graph.plane.id, u.graph]]);
  if (third) byId.set(third.plane.id, third);
  const project = { planes, activePlane: n.graph.plane, structGraph: null, openingNumberIndex: new Map() };
  const origPeek = floorSwapManager.peek;
  floorSwapManager.peek = async plane => {
    peeked?.push(plane.id);
    if (rejectThird && third && plane.id === third.plane.id) throw new Error('peek 失敗');
    return byId.get(plane.id) ?? null;
  };
  const origWarn = console.warn;
  if (rejectThird) console.warn = () => {};
  try {
    const state = new ElevationModeState(n.graph, project, { width: 1000, height: 800 });
    assert.equal((await state.init()).ok, true, '帯が構築できるはず');
    const band = state.bands.find(b => b.roomId === n.room.id);
    assert.ok(band, '前提: 階段帯がある');
    return JSON.stringify(band.primitives);
  } finally {
    floorSwapManager.peek = origPeek;
    console.warn = origWarn;
  }
}

test('【S10-6 S2・失敗系 A-1】N+2 の peek が reject しても init は ok で、階段帯は 2 階建てと同一（Q3）', async () => {
  const failed = await stairBandOf({ withThird: true, withBeam: true, rejectThird: true });
  const twoFloors = await stairBandOf({ withThird: false, withBeam: false });
  assert.equal(failed, twoFloors);
});

test('【S10-6 S2・A-2】自階に階段が無ければ N+2 は peek しない。階段があれば peek する', async () => {
  const withStair = [];
  await stairBandOf({ withThird: true, withBeam: true, peeked: withStair });
  assert.ok(withStair.length > 0 && withStair.includes('p3'), `前提: 階段ありは N+2 を peek: ${withStair}`);
  // 階段の無い階（部屋のみ）
  const g = makeGrid([0, 2000], [0, 2000], { id: 'p1', startFloor: 1 });
  g.interior([[0, 0]], { walls: true });
  const u = new PlanGraph(new Plane('p2', 2400, '2階', 2, 1));
  const third = thirdFloor(true);
  const peeked = [];
  const origPeek = floorSwapManager.peek;
  floorSwapManager.peek = async plane => { peeked.push(plane.id); return plane.id === 'p2' ? u : third; };
  try {
    const project = { planes: [g.graph.plane, u.plane, third.plane], activePlane: g.graph.plane, structGraph: null, openingNumberIndex: new Map() };
    assert.equal((await new ElevationModeState(g.graph, project, { width: 1000, height: 800 }).init()).ok, true);
  } finally {
    floorSwapManager.peek = origPeek;
  }
  assert.ok(peeked.includes('p2'), 'N+1 は peek する');
  assert.ok(!peeked.includes('p3'), `N+2 は peek しない: ${peeked}`);
});

test('【S10-6 S2・振る舞い】ElevationModeState.init: 3 階に到達辺の梁があると、1 階の階段帯の天井（N+1 の階段の裏面の到達辺）が変わる', async () => {
  const withBeam = await stairBandOf({ withThird: true, withBeam: true });
  const twoFloors = await stairBandOf({ withThird: false, withBeam: false });
  assert.notEqual(withBeam, twoFloors, '梁の面（FACE）の到達辺は、N+2 が無い（Q3）の帯と違う');
});

test('【S10-6 S2・失敗系】ElevationModeState.init: 3 階が梁なし（空の階）なら 2 階建てと同一の帯（Q3）', async () => {
  const noBeam = await stairBandOf({ withThird: true, withBeam: false });
  const twoFloors = await stairBandOf({ withThird: false, withBeam: false });
  assert.equal(noBeam, twoFloors);
});
