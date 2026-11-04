// 天伏の天井の段差の見切りの線（ceiling/ceilingStepDetailLines.js。部分詳細図 8b-4c C1）の単体テスト。
// specs は実物の PlanGraph（makeGrid）、innerLines・hide は純幾何なので矩形・prim を直接組む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingZone, edgeKey } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, overlayGeneration } from '../catalog/catalogRegistry.js';
import { PenDir, DetailSlot } from '../core/constants.js';
import { ceilingNoseFigure, ceilingStepFigure, stepNoseFigure, move, fixedLen, stretchLen } from '../finish/roomDetailTestFixtures.js';
import { makeGrid } from '../plan/planTestFixtures.js';
import { createZone } from './ceilingZones.js';
import { ceilingSurfacesOf, ceilingFaceId } from './ceilingSurfaces.js';
import {
  CEILING_STEP_DETAIL_ROLE, ceilingStepDetailSpecs, ceilingStepDetailInnerLines, hideCeilingStepDatumLines, ceilingStepDetailCacheTag,
} from './ceilingStepDetailLines.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { CEILING_STEP } = DetailSlot;
const REFS = { [CEILING_STEP]: 'k' };

test.beforeEach(() => setOverlay(DF, { user: [ceilingNoseFigure('k')] }));
test.afterEach(() => clearOverlays());

// 3 列の部屋（CH 2400）。右列を区画（高さ zoneH）にする。assign＝'zone'（区画）／'room'（部屋の残り）／null
function zonedRoom(zoneH, { assign = 'zone' } = {}) {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000]);
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  room.setOverride('ceilingHeight', '2400');
  const { zones, zoneId } = createZone(g.graph, room, [g.cell(2, 0)], { heightMm: zoneH, shape: 'flat', dims: [] });
  room.setCeilingZones(zones.map(z => (z.id === zoneId && assign === 'zone' ? new CeilingZone({ ...z.toData(), detailRefs: REFS }) : z)));
  if (assign === 'room') room.setDetailRefs(REFS);
  return { ...g, room, zone: room.ceilingZones.find(z => z.id === zoneId) };
}
const specsOf = (g, opts = {}) => ceilingStepDetailSpecs(g.graph, ceilingSurfacesOf(g.graph), { minDrawnMm: 30, ...opts });
const EDGE = { isVertical: true, value: 4000, lo: 0, hi: 3000, highSign: -1 };

// 材が s<0（低い側の天井の裏）にしか無い開いた図。fit はできるが下から見える線が 0 本
const offSideFigure = key => ceilingStepFigure(key, [
  move(PenDir.LEFT, fixedLen(100)), move(PenDir.UP, fixedLen(40)), move(PenDir.RIGHT, fixedLen(50)), move(PenDir.UP, stretchLen(100)),
], { closed: false });

// ---- specs ----

test('specs: 低い側の区画に割当て → 群 1 つ（辺・深さ 120）。面一の見切りなので CL の線（x=4000）を隠す区間になる', () => {
  const g = zonedRoom(2100);
  const { groups, hiddenDatum } = specsOf(g);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].lowFaceId, ceilingFaceId({ roomId: g.room.id, zoneId: g.zone.id }));
  assert.equal(groups[0].highFaceId, g.room.id);
  assert.deepEqual(groups[0].edges, [EDGE]);
  assert.deepEqual(groups[0].offsets, [120]);
  assert.equal(groups[0].clVisible, false);
  assert.deepEqual(groups[0].lowRects, [rect(4000, 0, 6000, 3000)]);
  assert.deepEqual(hiddenDatum, [{ isVertical: true, value: 4000, lo: 0, hi: 3000 }]);
});

test('specs: 部屋単位の割当て（残りが低い側）も対象。高い側にだけ割当てがあるとき・割当て無しは群なし', () => {
  const low = zonedRoom(2700, { assign: 'room' });
  const r = specsOf(low);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].highFaceId, ceilingFaceId({ roomId: low.room.id, zoneId: low.zone.id }));
  assert.equal(r.groups[0].lowFaceId, low.room.id);
  // 区画が低く、割当ては高い側の部屋にだけ（継承しない）
  const highOnly = zonedRoom(2100, { assign: 'room' });
  assert.deepEqual(specsOf(highOnly), { groups: [], hiddenDatum: [] });
});

test('specs: 割当てが無ければ天井面に触れず空を即返す', () => {
  const g = zonedRoom(2100, { assign: null });
  const trap = new Proxy([], { get() { throw new Error('surfaces に触れた'); } });
  assert.deepEqual(ceilingStepDetailSpecs(g.graph, trap, { minDrawnMm: 30 }), { groups: [], hiddenDatum: [] });
  assert.deepEqual(ceilingStepDetailSpecs(null, [], {}), { groups: [], hiddenDatum: [] });
  assert.deepEqual(ceilingStepDetailSpecs(g.graph, null, {}), { groups: [], hiddenDatum: [] });
});

test('specs: 傾斜の区画との境・同じ高さは対象外（平らな面どうしの段差だけ）', () => {
  const g = zonedRoom(2100);
  g.room.setCeilingZones(g.room.ceilingZones.map(z => new CeilingZone({ ...z.toData(), shape: 'slope', dims: [500, 0] })));
  assert.deepEqual(specsOf(g), { groups: [], hiddenDatum: [] });
  const same = zonedRoom(2400);
  assert.deepEqual(specsOf(same), { groups: [], hiddenDatum: [] });
});

test('specs: 同じ家族の部屋（部分指定の子と親）の境は対象。家族でない部屋どうしは対象外', () => {
  const h = makeGrid([0, 2000, 4000], [0, 3000]);
  const parent = h.interior([[0, 0], [1, 0]]);
  parent.setOverride('ceilingHeight', '2400');
  const child = h.graph.addRoom(new Set([h.cell(1, 0)]), '子', undefined, new Set([parent.id]));
  child.setOverride('ceilingHeight', '2100');
  child.setDetailRefs(REFS);
  const fam = specsOf(h);
  assert.equal(fam.groups.length, 1);
  assert.equal(fam.groups[0].lowFaceId, child.id);
  assert.deepEqual(fam.groups[0].edges, [{ isVertical: true, value: 2000, lo: 0, hi: 3000, highSign: -1 }]);
  // 家族でない（参照関係なし）の隣の部屋
  const o = makeGrid([0, 2000, 4000], [0, 3000]);
  const a = o.interior([[0, 0]]);
  a.setOverride('ceilingHeight', '2400');
  const b = o.interior([[1, 0]]);
  b.setOverride('ceilingHeight', '2100');
  b.setDetailRefs(REFS);
  assert.deepEqual(specsOf(o), { groups: [], hiddenDatum: [] });
});

test('specs: 辺の上の全高の壁の区間は除く。腰壁だけの壁は壁とみなさない。部分的な壁は残りの区間だけ', () => {
  const full = zonedRoom(2100);
  full.graph.addWall(full.cx[2], 0, true, full.cy[0], 0, full.cy[1], 0, {});
  assert.deepEqual(specsOf(full), { groups: [], hiddenDatum: [] }, '全高の壁で辺が覆われる');
  const knee = zonedRoom(2100);
  knee.graph.addWall(knee.cx[2], 0, true, knee.cy[0], 0, knee.cy[1], 0, {});
  knee.graph.setKneeDropWall(edgeKey(knee.cx[2].id, knee.cy[0].id, knee.cy[1].id), { knee: { topHeight: 800 }, drop: null });
  assert.deepEqual(specsOf(knee).groups[0].edges, [EDGE], '腰壁だけは壁とみなさない');
  const part = zonedRoom(2100);
  part.graph.addWall(part.cx[2], 0, true, part.cy[0], 0, part.cy[0], 1500, {});
  assert.deepEqual(specsOf(part).groups[0].edges, [{ ...EDGE, lo: 1500 }], '壁のある y 0..1500 を除いた残り');
  assert.deepEqual(specsOf(part).hiddenDatum, [{ isVertical: true, value: 4000, lo: 1500, hi: 3000 }], 'CL を隠すのも壁の無い区間だけ');
});

test('specs: 壁が辺の両端を半壁厚ぶん残す隅のすき間（SPAN_OVERLAP_EPS 以下）は壁で隔てられた辺として落とす。それを超えるすき間は残す', () => {
  const corner = zonedRoom(2100);
  corner.graph.addWall(corner.cx[2], 0, true, corner.cy[0], 60, corner.cy[1], -60, {});
  assert.deepEqual(specsOf(corner), { groups: [], hiddenDatum: [] });
  const gap = (second) => {
    const g = zonedRoom(2100);
    g.graph.addWall(g.cx[2], 0, true, g.cy[0], 0, g.cy[0], 1500, {});
    g.graph.addWall(g.cx[2], 0, true, g.cy[0], second, g.cy[1], 0, {});
    return specsOf(g);
  };
  assert.deepEqual(gap(1600), { groups: [], hiddenDatum: [] }, 'すき間 100 は隔てる');
  assert.deepEqual(gap(1700).groups[0].edges, [{ ...EDGE, lo: 1500, hi: 1700 }], 'すき間 200 は残す');
});

test('specs: 最小描画幅への引き上げ — 10・25 の線は 30 に引き上げて併合する（s=0 の線があれば CL は残す＝hiddenDatum なし）。引き上げは minDrawnMm に従う', () => {
  const steps = ceilingStepFigure('k', [
    move(PenDir.UP, fixedLen(10)), move(PenDir.RIGHT, fixedLen(10)), move(PenDir.UP, fixedLen(10)), move(PenDir.RIGHT, fixedLen(15)),
    move(PenDir.UP, fixedLen(40)), move(PenDir.LEFT, fixedLen(25)), move(PenDir.UP, stretchLen(100)),
  ]);
  setOverlay(DF, { user: [steps] });
  const g = zonedRoom(2100);
  const r = specsOf(g);
  assert.deepEqual(r.groups[0].offsets, [30], '10→30・25→30 を併合');
  assert.equal(r.groups[0].clVisible, true);
  assert.deepEqual(r.hiddenDatum, []);
  assert.deepEqual(specsOf(g, { minDrawnMm: 0 }).groups[0].offsets, [10, 25], '引き上げなし');
  assert.deepEqual(specsOf(g, { minDrawnMm: NaN }).groups[0].offsets, [10, 25], '不正な minDrawnMm は 0 扱い');
  assert.deepEqual(specsOf(g, { minDrawnMm: 12 }).groups[0].offsets, [12, 25], '10→12。25 は引き上げ不要');
});

test('【失敗系】specs: 参照切れ・段差高に合わない図・FL 基準の図は群を出さない（CL の線のまま）', () => {
  const gone = zonedRoom(2100);
  gone.room.setCeilingZones(gone.room.ceilingZones.map(z => new CeilingZone({ ...z.toData(), detailRefs: { [CEILING_STEP]: 'df-gone' } })));
  assert.deepEqual(specsOf(gone), { groups: [], hiddenDatum: [] });
  assert.deepEqual(specsOf(zonedRoom(2340)), { groups: [], hiddenDatum: [] }, '段差高 60 は図の固定寸法の和以下で fit できない');
  setOverlay(DF, { user: [stepNoseFigure('k')] });
  assert.deepEqual(specsOf(zonedRoom(2100)), { groups: [], hiddenDatum: [] }, 'FL 基準の図（床の段差の図）');
});

test('【失敗系】specs: fit はできるが見える線が 0 本の図（材が s<0 だけ）の群は出さず、hiddenDatum にも入れない（CL の線を隠さない）', () => {
  setOverlay(DF, { user: [offSideFigure('k')] });
  assert.deepEqual(specsOf(zonedRoom(2100)), { groups: [], hiddenDatum: [] });
});

// ---- innerLines ----

const rect = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const group = (over = {}) => ({
  lowFaceId: 'L', highFaceId: 'H', lowRects: [rect(0, 0, 2000, 3000)], highRects: [rect(2000, 0, 4000, 3000)],
  edges: [{ isVertical: true, value: 2000, lo: 0, hi: 3000, highSign: 1 }], offsets: [120], clVisible: false, ...over,
});
const lineKeys = lines => lines.map(l => l.points.join(','));

test('innerLines: 直線の辺は高い側へ深さぶん入った 1 本（CL・高い側の外周に乗る線は除く）。role と、実際の specs との結合', () => {
  const lines = ceilingStepDetailInnerLines([group()], 'H', [rect(2000, 0, 4000, 3000)]);
  assert.deepEqual(lines, [{ points: [2120, 0, 2120, 3000], role: CEILING_STEP_DETAIL_ROLE }]);
  // 実グラフ: 面一の見切り（出 120）は x=4000 の CL から低い側と反対の x=3880 へ
  const g = zonedRoom(2100);
  const surfaces = ceilingSurfacesOf(g.graph);
  const high = surfaces.find(s => s.zoneId === null);
  assert.deepEqual(
    lineKeys(ceilingStepDetailInnerLines(specsOf(g).groups, ceilingFaceId(high), high.rects)),
    ['3880,0,3880,3000'],
  );
});

test('innerLines: 高い側の面でない id・群なし・矩形なしは空配列。複数の深さは深さごとの線', () => {
  assert.deepEqual(ceilingStepDetailInnerLines([group()], 'X', [rect(2000, 0, 4000, 3000)]), []);
  assert.deepEqual(ceilingStepDetailInnerLines([], 'H', [rect(2000, 0, 4000, 3000)]), []);
  assert.deepEqual(ceilingStepDetailInnerLines([group()], 'H', []), []);
  assert.deepEqual(ceilingStepDetailInnerLines(null, 'H', [rect(2000, 0, 4000, 3000)]), []);
  assert.deepEqual(ceilingStepDetailInnerLines([group()], 'H', null), []);
  const two = ceilingStepDetailInnerLines([group({ offsets: [60, 120] })], 'H', [rect(2000, 0, 4000, 3000)]);
  assert.deepEqual(lineKeys(two), ['2060,0,2060,3000', '2120,0,2120,3000']);
});

test('innerLines: 出隅（低い面の角）は四角に回る — 2 辺の帯が角の四角で繋がる', () => {
  const g = group({
    lowRects: [rect(0, 0, 2000, 2000)],
    highRects: [rect(2000, 0, 4000, 4000), rect(0, 2000, 2000, 4000)],
    edges: [
      { isVertical: true, value: 2000, lo: 0, hi: 2000, highSign: 1 },
      { isVertical: false, value: 2000, lo: 0, hi: 2000, highSign: 1 },
    ],
    offsets: [100],
  });
  const lines = ceilingStepDetailInnerLines([g], 'H', [rect(2000, 0, 4000, 4000), rect(0, 2000, 2000, 4000)]);
  assert.deepEqual(lineKeys(lines), ['0,2100,2100,2100', '2100,0,2100,2100']);
});

test('innerLines: 入隅（低い面の凹んだ角）は線が短くなる — 相手の帯の深さぶん手前から始まる。高い面が回り込まない端（脚の先）は延長しない', () => {
  const g = group({
    lowRects: [rect(0, 0, 2000, 1000), rect(0, 1000, 1000, 2000)],
    highRects: [rect(1000, 1000, 3000, 3000), rect(2000, 0, 3000, 1000)],
    edges: [
      { isVertical: false, value: 1000, lo: 1000, hi: 2000, highSign: 1 },
      { isVertical: true, value: 1000, lo: 1000, hi: 2000, highSign: 1 },
      { isVertical: true, value: 2000, lo: 0, hi: 1000, highSign: 1 },
    ],
    offsets: [100],
  });
  const lines = ceilingStepDetailInnerLines([g], 'H', [rect(1000, 1000, 3000, 3000), rect(2000, 0, 3000, 1000)]);
  assert.deepEqual(lineKeys(lines), ['1100,1100,2100,1100', '1000,2000,1100,2000', '1100,1100,1100,2000', '2100,0,2100,1100']);
});

test('innerLines: 低い面の角の片側が壁で高い面だけが先へ続く角は延長しない（壁の面を越えて食み出さない・先の木口も付けない）', () => {
  const highRects = [rect(2000, 0, 3940, 3000), rect(2060, 3000, 3940, 6000)];
  const g = group({ highRects, edges: [{ isVertical: true, value: 2000, lo: 0, hi: 3000, highSign: 1 }] });
  const lines = ceilingStepDetailInnerLines([g], 'H', highRects);
  assert.deepEqual(lineKeys(lines), ['2060,3000,2120,3000', '2120,0,2120,3000']);
  assert.ok(lines.every(l => Math.max(l.points[1], l.points[3]) <= 3000), '低い面の端（y=3000）を越えない');
});

test('innerLines: 壁で止まる端（辺の区間の端の先も低い面の内側）には見切りの木口の短い線が出る。深さが違う木口は結合する', () => {
  const g = group({ edges: [{ isVertical: true, value: 2000, lo: 1500, hi: 3000, highSign: 1 }], offsets: [60, 120] });
  const lines = ceilingStepDetailInnerLines([g], 'H', [rect(2000, 0, 4000, 3000)]);
  assert.deepEqual(lineKeys(lines), ['2000,1500,2120,1500', '2060,1500,2060,3000', '2120,1500,2120,3000']);
});

test('innerLines: 高い側の面が出より狭いと、外側の線は高い側の外周に乗って消える', () => {
  assert.deepEqual(ceilingStepDetailInnerLines([group()], 'H', [rect(2000, 0, 2050, 3000)]), []);
  assert.deepEqual(lineKeys(ceilingStepDetailInnerLines([group({ offsets: [30, 120] })], 'H', [rect(2000, 0, 2050, 3000)])), ['2030,0,2030,3000']);
});

// ---- hide ----

const ceilingLine = (key, points, extra = {}) => ({ kind: 'line', key, points, source: { kind: 'ceiling', id: 'r' }, ...extra });
const DATUM = [{ isVertical: true, value: 4000, lo: 500, hi: 2500 }];

test('hide: CL 上の無印の線は覆われる部分だけ分割して hiddenAtDetail を付ける（鍵は 元の鍵:h番号）。全体が覆われる線は鍵のまま印だけ', () => {
  const prims = [ceilingLine('a', [4000, 0, 4000, 3000]), ceilingLine('b', [4000, 600, 4000, 2400])];
  const out = hideCeilingStepDatumLines(prims, DATUM);
  assert.deepEqual(out.filter(p => p.key.startsWith('a')).map(p => [p.key, p.points, p.hiddenAtDetail === true]), [
    ['a:h0', [4000, 0, 4000, 500], false],
    ['a:h1', [4000, 500, 4000, 2500], true],
    ['a:h2', [4000, 2500, 4000, 3000], false],
  ]);
  const b = out.find(p => p.key === 'b');
  assert.deepEqual([b.points, b.hiddenAtDetail], [[4000, 600, 4000, 2400], true]);
  assert.equal(prims[0].hiddenAtDetail, undefined, '入力は変更しない');
  assert.equal(prims.length, 2);
});

test('hide: ceilingBoundary 印・他の種別・別の座標・上階の層・role 線・斜めの線には触らない', () => {
  const prims = [
    ceilingLine('st', [4000, 0, 4000, 3000], { style: 'ceilingBoundary' }),
    { kind: 'line', key: 'w', points: [4000, 0, 4000, 3000], source: { kind: 'wall', id: 'w' } },
    ceilingLine('x', [4100, 0, 4100, 3000]),
    ceilingLine('up', [4000, 0, 4000, 3000], { source: { kind: 'ceiling', id: 'r', layerFloorZ: 2800 } }),
    ceilingLine('rl', [4000, 0, 4000, 3000], { source: { kind: 'ceiling', id: 'r', role: CEILING_STEP_DETAIL_ROLE } }),
    ceilingLine('dg', [3900, 0, 4100, 3000]),
    { kind: 'text', key: 't', x: 4000, y: 1000, text: 'x', source: { kind: 'ceiling', id: 'r' } },
  ];
  const out = hideCeilingStepDatumLines(prims, DATUM);
  for (const key of ['st', 'w', 'x', 'up', 'dg', 't']) assert.deepEqual(out.find(p => p.key === key), prims.find(p => p.key === key), key);
  const rl = out.find(p => p.key === 'rl');
  assert.deepEqual([rl.hiddenAtDetail, rl.detailOnly], [undefined, true], 'role 線は隠さず detailOnly だけ付く');
});

test('hide: role 線に detailOnly を付ける（隠す区間が無くても）。変更が無ければ同じ配列を返す。空・非配列の入力はそのまま', () => {
  const role = { kind: 'line', key: 'r', points: [0, 0, 10, 0], source: { kind: 'ceiling', id: 'r', role: CEILING_STEP_DETAIL_ROLE } };
  const out = hideCeilingStepDatumLines([role], []);
  assert.equal(out[0].detailOnly, true);
  assert.equal(role.detailOnly, undefined);
  const done = [{ ...role, detailOnly: true }];
  assert.equal(hideCeilingStepDatumLines(done, []), done, '付与済みは同じ配列');
  const plain = [ceilingLine('a', [4000, 0, 4000, 3000])];
  assert.equal(hideCeilingStepDatumLines(plain, []), plain, '隠す区間なし');
  assert.equal(hideCeilingStepDatumLines(plain, [{ isVertical: true, value: 9999, lo: 0, hi: 3000 }]), plain, '重ならない');
  const empty = [];
  assert.equal(hideCeilingStepDatumLines(empty, DATUM), empty);
  assert.equal(hideCeilingStepDatumLines(null, DATUM), null);
  assert.equal(hideCeilingStepDatumLines(plain, null), plain);
});

// ---- cacheTag ----

test('cacheTag: 割当てが無ければ空（鍵は従来と同じ）。あれば :cs<overlay の世代>.<材マスタの有無>。世代が変わると変わる', () => {
  assert.equal(ceilingStepDetailCacheTag(zonedRoom(2100, { assign: null }).graph, null), '');
  assert.equal(ceilingStepDetailCacheTag(null, {}), '');
  const g = zonedRoom(2100);
  assert.equal(ceilingStepDetailCacheTag(g.graph, null), `:cs${overlayGeneration()}.0`);
  assert.equal(ceilingStepDetailCacheTag(g.graph, {}), `:cs${overlayGeneration()}.1`);
  const before = ceilingStepDetailCacheTag(g.graph, null);
  setOverlay(DF, { user: [ceilingNoseFigure('k2')] });
  assert.notEqual(ceilingStepDetailCacheTag(g.graph, null), before);
  assert.equal(ceilingStepDetailCacheTag(zonedRoom(2100, { assign: 'room' }).graph, null), `:cs${overlayGeneration()}.0`, '部屋単位の割当てでも付く');
});
