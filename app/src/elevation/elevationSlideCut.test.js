// S10: 展開図の外付け引き戸は「穴（J 込み cut）の代理」で扱う（openingsOnFace・sectionHits の通過範囲）。
// 外壁ホスト・他の建具は同じオブジェクト（===）＝他の出力不変の根拠。実 core（PlanGraph/Opening）で computed を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { cutSpanOpening } from '../openings/slideOutset.js';
import { OpeningMechanism } from '../openings/openingCatalog.js';
import { findHostWall } from '../openings/openingGeometry.js';
import { buildRoomFaces, openingsOnFace, openingBelongsToFaceRoom, openingsReachingCorner, localXOf } from './elevationFaces.js';
import { makeProbeContext, collectCutBreaks } from './section/sectionProbe.js';
import { buildColumns } from './section/sectionEngine.js';
import { buildFaceFigure } from './elevationFigure.js';
import { openingPassThroughRangesFor } from './section/sectionHits.js';

// 上室 (0,0)-(6000,2000) と下室 (0,2000)-(6000,4000)。共有 CL y=2000 の上室側（wallSide −1）に建具を置く。
function fixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), x1 = cl(CenterLineType.VERTICAL, 6000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), yMid = cl(CenterLineType.HORIZONTAL, 2000), y2 = cl(CenterLineType.HORIZONTAL, 4000);
  const upper = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${yMid.id}`]), '上室');
  const lower = graph.addRoom(new Set([`${x0.id}:${yMid.id}:${x1.id}:${y2.id}`]), '下室');
  generateRoomWallsFromOutline(graph, upper);
  generateRoomWallsFromOutline(graph, lower);
  const open = (subType, lo, width, props = {}, category = OpeningCategory.FITTING) =>
    graph.addOpening(yMid, -1, false, x0, lo + width / 2, width, category, subType, { swingSide: 1, hingeSide: -1, ...props });
  const faceC = (room) => buildRoomFaces(room, graph).find(f => f.letter === 'C');
  return { graph, upper, lower, yMid, open, faceC, x0 };
}

// hingeSide −1（戸尻＝lo 側）の W 1550 を 1000〜2550 に置く → latchAlong＝hi=2550・cut＝[2550−780, 2550+30]＝[1770,2580]（長さ 810）。
test('openingsOnFace: 内壁の引き戸は穴 cut の代理（W 1550→810・W 1750→910）。computed は有限で id・他フィールドは残る', () => {
  for (const [w, cutLen] of [[1550, 810], [1750, 910]]) {
    const { graph, upper, open, faceC } = fixture();
    const o = open('sliding', 1000, w, { height: 2000, frameDepth: 150, detailRefs: { fitting: 'df-x' } });
    const list = openingsOnFace(faceC(upper), graph);
    assert.equal(list.length, 1);
    const p = list[0];
    assert.notEqual(p, o, '代理に替わる');
    const hi = 1000 + w;
    assert.deepEqual([p.coord1, p.coord2], [hi - (cutLen - 30), hi + 30]);
    assert.equal(p.width, cutLen);
    assert.equal(p.centerCoord, (p.coord1 + p.coord2) / 2);
    for (const k of ['coord1', 'coord2', 'centerCoord', 'width']) assert.ok(Number.isFinite(p[k]), k);
    // spread で落ちるフィールドが無い（computed 以外の全フィールドが実体と一致）
    for (const k of ['id', 'axisCL', 'refCL', 'refOffset', 'wallSide', 'isVertical', 'category', 'subType', 'hingeSide', 'swingSide',
      'fixtureType', 'sillHeight', 'height', 'handleHeight', 'frameDepth', 'frameFaceWidth', 'frameProjection', 'detailRefs']) {
      assert.deepEqual(p[k], o[k], `${k} が代理に残る`);
    }
    assert.equal(p.height, 2000);
    assert.equal(p.frameDepth, 150);
  }
});

test('openingsOnFace: 他の建具（開き戸）・外壁ホストの引き戸は実体そのもの（===）', () => {
  const { graph, upper, open, faceC } = fixture();
  const door = open('singleSwing', 500, 800);
  const [got] = openingsOnFace(faceC(upper), graph);
  assert.equal(got, door);
  // 外壁ホスト（R12）: ホスト壁を外壁扱いにすると恒等
  const slide = open('sliding', 2000, 1550);
  const host = findHostWall(slide, graph);
  host.isExteriorWall = true;
  const slideGot = openingsOnFace(faceC(upper), graph).find(o => o.id === slide.id);
  assert.equal(slideGot, slide);
});

test('cutSpanOpening: layout null（引き戸でない・外壁・W≤50）は同じオブジェクト／引き戸は cut。失敗側の W≤50 も恒等', () => {
  const { graph, open } = fixture();
  const slide = open('sliding', 1000, 1550);
  const host = findHostWall(slide, graph);
  assert.equal(cutSpanOpening(slide, OpeningMechanism.SWING, host), slide);
  assert.equal(cutSpanOpening(slide, OpeningMechanism.SLIDE_SINGLE, { isExteriorWall: true }), slide);
  const tiny = open('sliding', 4000, 50);
  assert.equal(cutSpanOpening(tiny, OpeningMechanism.SLIDE_SINGLE, host), tiny);
  const cut = cutSpanOpening(slide, OpeningMechanism.SLIDE_SINGLE, host);
  assert.deepEqual([cut.coord1, cut.coord2, cut.width, cut.centerCoord], [1770, 2580, 810, 2175]);
});

test('展開の図: 巾木の途切れ・姿図の幅が cut に揃う（W 1550→810）。記号丸は穴の中心', () => {
  const { graph, upper, open, faceC } = fixture();
  open('sliding', 1000, 1550, { height: 2000 });
  const face = faceC(upper);
  upper.finish.baseboardHeight = 'h=60';
  const prims = buildFaceFigure(face, {
    graph, project: { openingNumberIndex: new Map() }, room: upper, ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
  });
  const lx = [localXOf(face, 1770), localXOf(face, 2580)].sort((a, b) => a - b);
  const outer = prims.find(p => p.type === 'rect' && p.stroke === undefined);
  assert.deepEqual([outer.x, outer.w], [lx[0], 810], '姿図の外形＝cut（W 1550 ではなく 810）');
  const tag = prims.find(p => p.type === 'tag');
  assert.equal(tag.cx, (lx[0] + lx[1]) / 2, '記号丸は穴の中心（受容）');
  // 巾木（h=60）は穴の区間で途切れる（W 基準なら途切れの端が cut と一致しない）
  const base = prims.filter(p => p.type === 'line' && p.y1 === -60 && p.y2 === -60)
    .map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0]);
  assert.equal(base.length, 2, '巾木は穴で 2 本に分かれる');
  assert.ok(Math.abs(base[0][1] - lx[0]) < 1 && Math.abs(base[1][0] - lx[1]) < 1, `途切れ＝cut（${lx}）: ${JSON.stringify(base)}`);
});

test('sectionHits openingPassThroughRangesFor: 通過範囲＝cut（W の外・cut の内は通過、cut の外は通過しない）', () => {
  const { graph, open } = fixture();
  const slide = open('sliding', 1000, 1550, { height: 2000 });
  const wall = findHostWall(slide, graph);
  const ranges = (mid) => openingPassThroughRangesFor(wall, graph, mid, 0, 0, 2400);
  assert.equal(ranges(2565).length, 1, 'W(〜2550)の外・cut(〜2580)の内');
  assert.equal(ranges(1775).length, 1, 'cut の下端の内側（W の内でもある）');
  assert.equal(ranges(1760).length, 0, 'W の内でも cut の外（引き代側の欠き込み域）は通過しない（従来は W 基準で通過）');
  assert.equal(ranges(2600).length, 0, 'cut の外');
});

test('【配線】openingsOnFace と sectionHits が host 付き（3 引数）で cutSpanOpening / openingCutSpan を呼ぶ（コメント除外）', () => {
  const strip = t => t.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const read = f => strip(fs.readFileSync(path.resolve(import.meta.dirname, f), 'utf8'));
  assert.match(read('elevationFaces.js'), /cutSpanOpening\(o, mechanism, isOutsetSlide\(mechanism\) \? findHostWall\(o, graph\) : null\)/);
  assert.match(read('section/sectionHits.js'), /openingCutSpan\(o, mechanism, isOutsetSlide\(mechanism\) \? findHostWall\(o, graph\) : null\)/);
  assert.doesNotMatch(read('section/sectionHits.js'), /Math\.min\(o\.coord1, o\.coord2\)/);
});

// ---- (a) 列の区切り: cut の端が入り、openingPassThrough の列が cut に一致する ----
function farWallFixture() {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), x1 = cl(CenterLineType.VERTICAL, 4000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), y1 = cl(CenterLineType.HORIZONTAL, 3000);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const wall = graph.walls.find(w => !w.isVertical && w.axisCL.effectiveValue === 3000);
  const slide = graph.addOpening(wall.axisCL, -1, false, x0, 1775, 1550, OpeningCategory.FITTING, 'sliding', { swingSide: 1, hingeSide: -1, height: 2000 });
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 }, viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }], zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0,
  };
  return { graph, wall, slide, cut };
}
const passSpans = (columns) => columns.filter(c => c.bands.some(b => b.openingPassThrough))
  .map(c => [c.worldLo, c.worldHi]).reduce((acc, [a, b]) => {
    const last = acc[acc.length - 1];
    if (last && Math.abs(last[1] - a) < 1e-6) last[1] = b; else acc.push([a, b]);
    return acc;
  }, []);

test('buildColumns: 引き戸のある面の列の区切りに cut の端（1770・2580）が入り、通過の列は cut と一致する', () => {
  const { slide, wall, cut } = farWallFixture();
  assert.ok(!findHostWall(slide, cut.layers[0].graph).isExteriorWall, '前提: 内壁ホスト');
  const probeCtx = makeProbeContext(cut.layers);
  const breaks = collectCutBreaks(cut, probeCtx);
  for (const v of [1000, 1770, 2550, 2580]) assert.ok(breaks.some(b => Math.abs(b - v) < 1e-6), `区切りに ${v}`);
  assert.deepEqual(passSpans(buildColumns(cut, probeCtx)), [[1770, 2580]], '1000〜1770（欠き込みだけ）は通過でなく 2550〜2580（穴）は通過');
  assert.ok(wall);
});

test('buildColumns: 外壁ホストの引き戸は従来（W の端だけ・通過＝W 全幅）', () => {
  const { slide, cut } = farWallFixture();
  findHostWall(slide, cut.layers[0].graph).isExteriorWall = true;
  const probeCtx = makeProbeContext(cut.layers);
  const breaks = collectCutBreaks(cut, probeCtx);
  assert.ok(!breaks.some(b => Math.abs(b - 1770) < 1e-6 || Math.abs(b - 2580) < 1e-6), 'cut の端は入らない');
  assert.deepEqual(passSpans(buildColumns(cut, probeCtx)), [[1000, 2550]]);
});

// ---- (c) 面の所属は実体の中心で判定する ----
test('openingBelongsToFaceRoom: 手前の部屋の境界が W の中心と cut の中心の間にあっても所属は実体の中心どおり', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 3000), x1 = cl(CenterLineType.VERTICAL, 6000);
  const y0 = cl(CenterLineType.HORIZONTAL, 0), y1 = cl(CenterLineType.HORIZONTAL, 2000);
  const p = graph.addRoom(new Set([`${x0.id}:${y0.id}:${xm.id}:${y1.id}`]), 'P');
  const q = graph.addRoom(new Set([`${xm.id}:${y0.id}:${x1.id}:${y1.id}`]), 'Q');
  generateRoomWallsFromOutline(graph, p);
  generateRoomWallsFromOutline(graph, q);
  // W 2000〜3550（実体の中心 2775＝P 内）・hingeSide −1 → cut [2770,3580]（中心 3175＝Q 内）。境界 x=3000 は 2 つの中心の間。
  const slide = graph.addOpening(y1, -1, false, x0, 2775, 1550, OpeningCategory.FITTING, 'sliding', { swingSide: 1, hingeSide: -1 });
  const proxy = cutSpanOpening(slide, OpeningMechanism.SLIDE_SINGLE, null);
  assert.equal(proxy.centerCoord, 3175);
  assert.equal(proxy.entityCenterCoord, 2775);
  const faceP = buildRoomFaces(p, graph).find(f => f.letter === 'C');
  assert.equal(openingBelongsToFaceRoom(proxy, faceP, p, graph), true, '実体の中心は P 側＝P の面の建具');
  assert.equal(openingBelongsToFaceRoom({ ...proxy, entityCenterCoord: undefined }, faceP, p, graph), false, '対照: 代理の中心（Q 側）で引くと外れる');
});

// ---- (b) 隅の建具断面: 穴（cut）が隅に届くときだけ（受容・リード裁定） ----
test('openingsReachingCorner: cut が隅に届く向き（hingeSide）だけ拾う。届かない向きは拾わない', () => {
  for (const corner of ['start', 'end']) {
    const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
    const x0 = cl(CenterLineType.VERTICAL, 0), x1 = cl(CenterLineType.VERTICAL, 6000);
    const y0 = cl(CenterLineType.HORIZONTAL, 0), y1 = cl(CenterLineType.HORIZONTAL, 3000);
    const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
    generateRoomWallsFromOutline(graph, room);
    const perp = buildRoomFaces(room, graph).find(f => f.letter === 'B');
    const cornerWorld = perp.originWorld + perp.dirSign * (corner === 'end' ? perp.run : 0);
    const into = corner === 'end' ? -perp.dirSign : perp.dirSign; // 面の内側へ向かう世界方向
    const wLo = Math.min(cornerWorld, cornerWorld + into * 1550), wHi = Math.max(cornerWorld, cornerWorld + into * 1550);
    const cornerIsWorldHi = cornerWorld === wHi;
    const reachingHinge = cornerIsWorldHi ? -1 : 1; // 戸先端（cut が W の外へ J 伸びる端）が隅にある向き
    const place = hingeSide => graph.addOpening(x1, 1, true, y0, (wLo + wHi) / 2, 1550, OpeningCategory.FITTING, 'sliding', { swingSide: 1, hingeSide });
    const reach = place(reachingHinge);
    const noReach = place(-reachingHinge);
    const ids = openingsReachingCorner(perp, graph, corner).map(o => o.id);
    assert.ok(ids.includes(reach.id), `${corner}: cut が隅に届く向きは拾う`);
    assert.ok(!ids.includes(noReach.id), `${corner}: 届かない向きは拾わない（W なら届くが穴は届かない）`);
  }
});
