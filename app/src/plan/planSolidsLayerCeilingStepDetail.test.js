// 天伏（見上げ）の天井の段差の見切りの線の配線（部分詳細図 8b-4c C2）。
// 純関数 ceiling/ceilingStepDetailLines.js の出力が、planSolidsLayerPrimitivesUp（立体の innerLines・CL の線の印）→ visiblePlanPrimitives（LOD の絞り）
// → planSolidsLayerCacheSpec（鍵）まで実物の PlanGraph で通ること。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CeilingZone } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, DetailMaterialField, PenDir } from '../core/constants.js';
import { ceilingNoseFigure, ceilingStepFigure, move, fixedLen, stretchLen, materialLen } from '../finish/roomDetailTestFixtures.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { CEILING_STEP_DETAIL_ROLE, ceilingStepDetailSpecs } from '../ceiling/ceilingStepDetailLines.js';
import { ceilingSurfacesOf, ceilingFaceId } from '../ceiling/ceilingSurfaces.js';
import { LodLevel } from '../viewport.js';
import { makeGrid } from './planTestFixtures.js';
import {
  planSolidsLayerPrimitivesUp, planSolidsLayerSolidsUp, planSolidsLayerCacheSpec, planSolidsLayerResolve, visiblePlanPrimitives,
} from './planSolidsLayerFilter.js';

const DF = CatalogKind.DETAIL_FIGURE;
const CUT = 1500;
const COORD_EPS = 0.5; // 段差の辺（セル矩形の値）と解決器が出す CL の線の座標の一致許容（CEILING_BOUNDARY_EPS_MM と同じ）
const STEP_X = 4000;   // 区画（右列）と部屋の残りの境
const NOSE_X = 3880;   // 出 120 の見切り（高い側＝x の小さい側へ highSign −1）

// 出（最初の長さ）が材 M1 の厚みで決まる見切り。ceilingNoseFigure('k') と同形（出 120・厚 40・見切り 30×30）で、材マスタが無いと fit できない
const materialNoseFigure = key => ceilingStepFigure(key, [
  move(PenDir.RIGHT, materialLen('M1', DetailMaterialField.THICKNESS, 120)), move(PenDir.UP, fixedLen(40)), move(PenDir.LEFT, fixedLen(90)),
  move(PenDir.UP, fixedLen(30)), move(PenDir.LEFT, fixedLen(30)), move(PenDir.UP, stretchLen(100)),
]);
const MATERIALS = () => new Map([['M1', { thickness: 120 }]]);

test.beforeEach(() => setOverlay(DF, { user: [ceilingNoseFigure('k'), materialNoseFigure('km')] }));
test.afterEach(() => clearOverlays());

// 3 列の部屋（天井高 2400）の右列を区画（zoneH）にし、低い側の区画に図 refKey を割り当てる（refKey null は割当てなし）。直上階つき。
function scene({ zoneH = 2100, refKey = 'k' } = {}) {
  const g = makeGrid([0, 2000, 4000, 6000], [0, 3000], { id: 'low', startFloor: 1 });
  const room = g.interior([[0, 0], [1, 0], [2, 0]]);
  room.setOverride('ceilingHeight', '2400');
  const { zones, zoneId } = createZone(g.graph, room, [g.cell(2, 0)], { heightMm: zoneH, shape: 'flat', dims: [] });
  room.setCeilingZones(zones.map(z => (z.id === zoneId && refKey !== null ? new CeilingZone({ ...z.toData(), detailRefs: { [DetailSlot.CEILING_STEP]: refKey } }) : z)));
  const above = makeGrid([0, 2000, 4000, 6000], [0, 3000], { id: 'high', startFloor: 2 });
  above.interior([[0, 0], [1, 0], [2, 0]]);
  const abovePeek = { graph: above.graph, floorHeightMm: 2800, activePlaneId: g.graph.plane.id };
  return { ...g, room, abovePeek };
}
const primsOf = (s, extra = {}) => planSolidsLayerPrimitivesUp({ graph: s.graph, abovePeek: s.abovePeek, cutZ: CUT, ...extra });
const verticalAt = (prims, x) => prims.filter(p => p.kind === 'line' && p.source.kind === 'ceiling' && p.points.length === 4
  && Math.abs(p.points[0] - x) <= COORD_EPS && Math.abs(p.points[2] - x) <= COORD_EPS);
const roleLines = prims => prims.filter(p => p.source?.role === CEILING_STEP_DETAIL_ROLE);
const spanOf = lines => {
  const ivs = lines.map(p => [Math.min(p.points[1], p.points[3]), Math.max(p.points[1], p.points[3])]).sort((a, b) => a[0] - b[0]);
  return ivs.reduce((acc, [lo, hi]) => (acc.length && lo - acc[acc.length - 1][1] <= COORD_EPS ? (acc[acc.length - 1][1] = Math.max(acc[acc.length - 1][1], hi), acc) : [...acc, [lo, hi]]), []);
};

test('座標の一致（最大リスク）: 段差の辺の CL の線は x=4000 に出て、hiddenDatum の許容 0.5 以内で全長が hiddenAtDetail になる', () => {
  const prims = primsOf(scene());
  const cl = verticalAt(prims, STEP_X);
  assert.ok(cl.length > 0, 'CL の線が x=4000 に出ている');
  assert.ok(cl.every(p => p.hiddenAtDetail === true), 'x=4000 の線はすべて詳細 LOD で隠す印つき');
  assert.deepEqual(spanOf(cl), [[0, 3000]], '辺の全長を覆う');
});

test('見切りの線: 高い側 x=3880 に role 線（細線・detailOnly）が辺の全長で出て、CL の線（x=4000）は残るが印つき', () => {
  const prims = primsOf(scene());
  const nose = roleLines(prims);
  assert.ok(nose.length > 0);
  assert.ok(nose.every(p => p.detailOnly === true && p.weight === 'thin' && p.cls === 'below' && p.source.kind === 'ceiling'));
  const atNose = nose.filter(p => Math.abs(p.points[0] - NOSE_X) <= COORD_EPS && Math.abs(p.points[2] - NOSE_X) <= COORD_EPS);
  assert.deepEqual(spanOf(atNose), [[0, 3000]]);
  // 天井の外周の線（無印）は印を付けられても削除はされない: x=0 や x=6000 の外形には印が付かない
  assert.ok(verticalAt(prims, 0).every(p => !p.hiddenAtDetail));
  assert.ok(verticalAt(prims, 6000).every(p => !p.hiddenAtDetail));
});

test('LOD の絞り: 詳細は hiddenAtDetail を除いて role 線を出し、標準・概略は detailOnly（role 線）を除いて CL の線を出す', () => {
  const prims = primsOf(scene());
  const detail = visiblePlanPrimitives(prims, LodLevel.DETAIL);
  assert.equal(verticalAt(detail, STEP_X).length, 0, '詳細: CL の線は隠れる');
  assert.ok(roleLines(detail).length > 0, '詳細: 見切りの線が出る');
  for (const lod of [LodLevel.STANDARD, LodLevel.SCHEMATIC]) {
    const other = visiblePlanPrimitives(prims, lod);
    assert.deepEqual(spanOf(verticalAt(other, STEP_X)), [[0, 3000]], `${lod}: CL の線は従来どおり`);
    assert.equal(roleLines(other).length, 0, `${lod}: 見切りの線は出さない`);
  }
});

test('立体: 見切りの線は高い側の天井面の innerLines になり、footprint は変えない', () => {
  const s = scene();
  const specs = ceilingStepDetailSpecs(s.graph, ceilingSurfacesOf(s.graph), { minDrawnMm: 30 });
  assert.equal(specs.groups.length, 1);
  const plain = planSolidsLayerSolidsUp({ graph: s.graph, abovePeek: s.abovePeek });
  const withDetail = planSolidsLayerSolidsUp({ graph: s.graph, abovePeek: s.abovePeek, ceilingStepDetail: specs });
  const ceilingOf = (solids, id) => solids.find(x => x.kind === 'ceiling' && (x.source.layerFloorZ ?? 0) === 0 && x.source.id === id);
  const highId = ceilingFaceId({ roomId: s.room.id, zoneId: null });
  const lowId = ceilingFaceId({ roomId: s.room.id, zoneId: s.room.ceilingZones[0].id });
  assert.equal(ceilingOf(plain, highId).innerLines, undefined, 'ceilingStepDetail を渡さない立体に線は付かない');
  const inner = ceilingOf(withDetail, highId).innerLines;
  assert.ok(inner.length > 0 && inner.every(l => l.role === CEILING_STEP_DETAIL_ROLE), '高い側の面に role つきの innerLines');
  assert.deepEqual(ceilingOf(withDetail, highId).footprint, ceilingOf(plain, highId).footprint, 'footprint は変えない');
  assert.equal(ceilingOf(withDetail, lowId).innerLines, undefined, '低い側の面には付かない');
});

test('失敗系: 図が見つからない割当て（参照切れ）は CL の線を隠さず、見切りの線も出さない（出力は割当てなしと同じ）', () => {
  const broken = primsOf(scene({ refKey: 'missing' }));
  assert.equal(roleLines(broken).length, 0);
  assert.ok(broken.every(p => !p.hiddenAtDetail && !p.detailOnly));
  const shape = prims => prims.map(p => ({ kind: p.kind, points: p.points, weight: p.weight, cls: p.cls, style: p.style, detailOnly: p.detailOnly }));
  assert.deepEqual(shape(broken), shape(primsOf(scene({ refKey: null }))), 'ids を除いて割当てなしと同じ');
});

test('失敗系: 段差高に合わせられない図（段差 20 < 見切りの高さ）は CL の線を隠さない', () => {
  const prims = primsOf(scene({ zoneH: 2380 }));
  assert.equal(roleLines(prims).length, 0);
  assert.ok(prims.every(p => !p.hiddenAtDetail));
});

test('割当てが無ければ出力も鍵も従来と同じ（印・role・detailOnly なし。鍵に世代の印が付かない）', () => {
  const s = scene({ refKey: null });
  const prims = primsOf(s);
  assert.ok(prims.every(p => p.hiddenAtDetail === undefined && !p.detailOnly && p.source?.role !== CEILING_STEP_DETAIL_ROLE));
  assert.equal(planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'up', {}).key, `planSection:up:${s.graph.plane.id}:1500:high:-`);
  assert.equal(planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'up').key, `planSection:up:${s.graph.plane.id}:1500:high:-`);
});

test('鍵: 割当てがあれば overlay の世代と材マスタの有無が入り、世代が変わる・材マスタが載ると鍵が変わる。見下げの鍵は不変', () => {
  const s = scene();
  const k0 = planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'up', null).key;
  assert.match(k0, /^planSection:up:.*:high:-:cs\d+\.0$/);
  assert.equal(planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'up', null).key, k0, '同じ入力は同じ鍵');
  assert.match(planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'up', new Map()).key, /:cs\d+\.1$/, '材マスタが載ると .1');
  setOverlay(DF, { user: [ceilingNoseFigure('k')] }); // 図の差し替え（世代が進む）
  assert.notEqual(planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'up', null).key, k0, 'overlay の世代が変わると鍵が変わる');
  assert.equal(planSolidsLayerCacheSpec(s.graph, s.abovePeek, 'down').key, `planSection:${s.graph.plane.id}:1500:high`);
});

test('planSolidsLayerResolve: materialMap を省略（null）しても例外なく、見上げの memo の鍵に印が入る', () => {
  const s = scene();
  const keys = [];
  const out = planSolidsLayerResolve({ graph: s.graph, abovePeek: s.abovePeek, direction: 'up', memo: (h, k, c) => { keys.push(k); return c(); } });
  assert.ok(roleLines(out).length > 0);
  assert.match(keys[0], /:cs\d+\.0$/);
  const mapped = planSolidsLayerResolve({ graph: s.graph, abovePeek: s.abovePeek, direction: 'up', materialMap: new Map(), memo: (h, k, c) => { keys.push(k); return c(); } });
  assert.match(keys[1], /:cs\d+\.1$/);
  assert.ok(roleLines(mapped).length > 0);
});

test('材マスタが要る図: materialMap が null なら線も隠しもなく、材を載せた Map なら見切りの線が出て CL の線を隠す（primitivesUp と resolve の両経路）', () => {
  const s = scene({ refKey: 'km' });
  const memo = (h, k, c) => c();
  const paths = {
    primitivesUp: mm => primsOf(s, { materialMap: mm }),
    resolve: mm => planSolidsLayerResolve({ graph: s.graph, abovePeek: s.abovePeek, direction: 'up', materialMap: mm, memo }),
  };
  for (const [name, run] of Object.entries(paths)) {
    // fit の局所メモは材の値を鍵に持たない（成功した fit を使い回す）ので、経路ごとに overlay を入れ直してメモを捨てる
    setOverlay(DF, { user: [ceilingNoseFigure('k'), materialNoseFigure('km')] });
    const without = run(null);
    assert.equal(roleLines(without).length, 0, `${name}: null は見切りの線なし`);
    assert.ok(without.every(p => !p.hiddenAtDetail), `${name}: null は CL の線を隠さない`);
    const withMap = run(MATERIALS());
    assert.ok(roleLines(withMap).length > 0, `${name}: Map は見切りの線が出る`);
    const cl = verticalAt(withMap, STEP_X);
    assert.ok(cl.length > 0 && cl.every(p => p.hiddenAtDetail === true), `${name}: Map は x=4000 の CL の線を詳細で隠す`);
  }
});

test('最上階（abovePeek なし）でも見切りの線が辺の全長で出て、CL の線は全部詳細で隠れる', () => {
  const s = scene();
  const prims = primsOf(s, { abovePeek: null });
  const atNose = roleLines(prims).filter(p => Math.abs(p.points[0] - NOSE_X) <= COORD_EPS && Math.abs(p.points[2] - NOSE_X) <= COORD_EPS);
  assert.deepEqual(spanOf(atNose), [[0, 3000]]);
  const cl = verticalAt(prims, STEP_X);
  assert.ok(cl.length > 0 && cl.every(p => p.hiddenAtDetail === true));
});
