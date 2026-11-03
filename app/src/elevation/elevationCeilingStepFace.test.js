// 天井の段差見付け面（部分詳細図 S8b-4b-1）。elevation/elevationStepFace.js の ceilingStepSegments・insertStepFaces（天井の面・床の面への合流）・
// elevationFaceList.js composeRoomFaces（階段帯では作らない）と、elevationFigure.js appendStepFace の描画（ceilingSteps・壁の無い端）。
// 実グラフ（3 列×1 行の部屋・右列が区画か部分指定の子）で面を作り、描画は合成の面（elevationFigure.test.js と同じ方式）で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { withGraphReadScope } from '../graphReadScope.js';
import { composeRoomFaces } from './elevationFaceList.js';
import { ceilingStepSegments, subtractOpenSpanCoverage } from './elevationStepFace.js';
import { ceilingStepEdgesOf } from './space/zoneCeiling.js';
import { buildFaceFigure } from './elevationFigure.js';

const BASE_CH = 2400;

/**
 * 3 列×1 行（0-2000-4000-6000 × 0-3000）の部屋 LDK（CH 2400）。右列（x 4000〜6000）の天井:
 *   via 'zone'  … 区画（高さ rightCH・形状 shape）／ via 'child' … 部分指定の子（CH rightCH・床 childFL）
 * wall＝右列との境界（x=4000）に壁を立てる。wallHalf＝その壁を y=0〜1500 の半分だけ立てる。
 */
function setup({ via = 'zone', rightCH = 2100, shape = 'flat', wall = false, wallHalf = false, childFL = 0 } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [cl(CenterLineType.HORIZONTAL, 0), cl(CenterLineType.HORIZONTAL, 3000)];
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const room = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2), cellKey(2, 3)]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', String(BASE_CH));
  let child = null, zone = null;
  if (via === 'zone') {
    const dims = shape === 'slope' ? [500, 0] : [];
    const { zones, zoneId } = createZone(graph, room, [cellKey(2, 3)], { heightMm: rightCH, shape, dims });
    room.setCeilingZones(zones);
    zone = zones.find(z => z.id === zoneId);
  } else {
    child = graph.addRoom(new Set([cellKey(2, 3)]), '下がり天井', undefined, new Set([room.id]));
    child.setOverride('ceilingHeight', String(rightCH));
    if (childFL) child.setFloorLevel(childFL);
  }
  if (wall) {
    graph.addWall(xs[2], 0, true, y0, 0, y1, 0, { isRoomWall: false, isExteriorWall: false });
    if (typeof wall === 'object') graph.setKneeDropWall(edgeKey(xs[2].id, y0.id, y1.id), wall);
  }
  if (wallHalf) {
    const ym = cl(CenterLineType.HORIZONTAL, 1500);
    graph.addWall(xs[2], 0, true, y0, 0, ym, 0, { isRoomWall: false, isExteriorWall: false });
  }
  return { graph, room, child, zone };
}
const ceilFaces = faces => faces.filter(f => f.kind === 'step' && f.stepHeightMm === 0);
const stepFaces = faces => faces.filter(f => f.kind === 'step');

test('区画が低い側（右列 2100・左の残りは 2400）: 天井だけの面が 1 枚。inward は高い側（見る側）・持ち主は区画・高さは床の面と同じ式', () => {
  const { graph, room, zone } = setup();
  const faces = composeRoomFaces(room, graph);
  const [f, ...others] = ceilFaces(faces);
  assert.equal(others.length, 0);
  assert.equal(stepFaces(faces).length, 1, '床の面は無い');
  assert.equal(f.isVertical, true);
  assert.equal(f.faceValue, 4000);
  assert.equal(f.inward, -1, '高い側（残り・x が小さい側）を指す');
  assert.equal(f.baseFloorDeltaMm, 0);
  assert.equal(f.ceilAbsMm, 2400, '断面の天井は高い側');
  assert.equal(f.stepEndWallAt0, true);
  assert.equal(f.stepEndWallAtRun, true);
  assert.equal(f.ceilingSteps.length, 1);
  const cs = f.ceilingSteps[0];
  assert.equal(cs.loX, 0);
  assert.equal(cs.hiX, f.run);
  assert.equal(cs.lowCeilAbsMm, 2100);
  assert.equal(cs.ceilStepHeightMm, 300);
  assert.equal(cs.beyondFloorDeltaMm, 0);
  assert.deepEqual(cs.lowSurface, { roomId: room.id, zoneId: zone.id });
});

test('部分指定の子が低い側: 持ち主は部屋（zoneId null・子の room id）。区画→部屋の継承は無い', () => {
  const { graph, room, child } = setup({ via: 'child' });
  const [f] = ceilFaces(composeRoomFaces(room, graph));
  assert.deepEqual(f.ceilingSteps[0].lowSurface, { roomId: child.id, zoneId: null });
});

test('高さの差が 0.5 以下の境界には面を作らない（0.4 は無し・0.6 は有り）', () => {
  const a = setup({ rightCH: 2399.6 });
  assert.equal(ceilFaces(composeRoomFaces(a.room, a.graph)).length, 0, '差 0.4');
  const b = setup({ rightCH: 2399.4 });
  assert.equal(ceilFaces(composeRoomFaces(b.room, b.graph)).length, 1, '差 0.6');
});

test('境界の上に壁（垂れ壁・腰壁の記録つきも）が立っていれば面を作らない', () => {
  for (const wall of [true, { knee: null, drop: { bottomHeight: 400 } }, { knee: { topHeight: 900 }, drop: null }]) {
    const s = setup({ wall });
    assert.equal(ceilFaces(composeRoomFaces(s.room, s.graph)).length, 0, JSON.stringify(wall));
  }
  const none = setup();
  assert.equal(ceilFaces(composeRoomFaces(none.room, none.graph)).length, 1, '対照: 壁が無ければ面ができる');
});

test('壁が境界の半分だけなら、壁の無い残りの区間だけ面になる（壁の無い端は stepEndWall が false）', () => {
  const { graph, room } = setup({ wallHalf: true });
  const fs = ceilFaces(composeRoomFaces(room, graph));
  assert.equal(fs.length, 1);
  assert.equal(fs[0].lo, 1500, '壁の終わり（y=1500）から');
  assert.ok(fs[0].run > 1400 && fs[0].run < 1500, `南壁の仕上げ面まで（${fs[0].run}）`);
  const [at0, atRun] = fs[0].dirSign > 0 ? [fs[0].stepEndWallAt0, fs[0].stepEndWallAtRun] : [fs[0].stepEndWallAtRun, fs[0].stepEndWallAt0];
  assert.deepEqual([at0, atRun], [false, true], '世界座標の若い側（壁の終わり）は壁の面が無い・南壁側は有る');
});

test('壁越しの隣室との差は面にしない（家族の外）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const [x0, x1, x2] = [0, 3000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [0, 3000].map(v => cl(CenterLineType.HORIZONTAL, v));
  const a = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'A');
  const b = graph.addRoom(new Set([`${x1.id}:${y0.id}:${x2.id}:${y1.id}`]), 'B');
  generateRoomWallsFromOutline(graph, a);
  generateRoomWallsFromOutline(graph, b);
  a.setOverride('ceilingHeight', '2400');
  b.setOverride('ceilingHeight', '2000');
  assert.ok(ceilingStepEdgesOf(graph).length > 0, '前提: 辺としては段差がある');
  assert.equal(ceilFaces(composeRoomFaces(a, graph)).length, 0);
  assert.equal(ceilFaces(composeRoomFaces(b, graph)).length, 0);
});

test('壁の無い隣室（家族の外）との天井の差は面にしない（x=4000 に壁なし・親子関係なし）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const [y0, y1] = [0, 3000].map(v => cl(CenterLineType.HORIZONTAL, v));
  const cellKey = (a, b) => `${xs[a].id}:${y0.id}:${xs[b].id}:${y1.id}`;
  const a = graph.addRoom(new Set([cellKey(0, 1), cellKey(1, 2)]), 'A');
  const b = graph.addRoom(new Set([cellKey(2, 3)]), 'B');
  a.setOverride('ceilingHeight', '2400');
  b.setOverride('ceilingHeight', '2100');
  assert.ok(ceilingStepEdgesOf(graph).length > 0, '前提: 辺としては段差がある');
  assert.equal(stepFaces(composeRoomFaces(a, graph)).length, 0);
  assert.equal(stepFaces(composeRoomFaces(b, graph)).length, 0);
});

test('傾斜の区画との境界は面にしない', () => {
  const { graph, room } = setup({ shape: 'slope' });
  assert.equal(ceilFaces(composeRoomFaces(room, graph)).length, 0);
});

test('階段帯（keepWallLessFaces）では作らない', () => {
  const { graph, room } = setup();
  assert.equal(ceilFaces(composeRoomFaces(room, graph, { keepWallLessFaces: true })).length, 0);
  assert.equal(ceilFaces(composeRoomFaces(room, graph)).length, 1, '対照: 既定では作る');
});

test('失敗系: ceilingStepEdgesOf は graph が null・例外を出す graph でも [] を返す', () => {
  assert.deepEqual(ceilingStepEdgesOf(null), []);
  assert.deepEqual(ceilingStepEdgesOf({ rooms: null, roomMap: null }), []);
});

test('失敗系: roomMap に無い部屋の辺は飛ばす', () => {
  const { graph, room, child } = setup({ via: 'child' });
  withGraphReadScope(graph, () => {
    assert.equal(ceilingStepSegments(room, graph).length, 1, '対照: 辺はある');
    graph.roomMap.delete(child.id);
    assert.deepEqual(ceilingStepSegments(room, graph), []);
  });
});

test('小上がり（床 +300）＋下がり天井（CH 1800 → 天井 2100）: 床の面に ceilingSteps が付き、面は重複しない', () => {
  const { graph, room } = setup({ via: 'child', childFL: 300, rightCH: 1800 });
  const faces = composeRoomFaces(room, graph);
  const steps = stepFaces(faces);
  assert.equal(steps.length, 1, '床の面 1 枚だけ（天井だけの面を重ねて作らない）');
  const [f] = steps;
  assert.equal(f.stepHeightMm, 300);
  assert.equal(f.ceilingSteps.length, 1);
  const cs = f.ceilingSteps[0];
  assert.equal(cs.loX, 0);
  assert.equal(cs.hiX, f.run);
  assert.equal(cs.lowCeilAbsMm, 2100);
  assert.equal(cs.ceilStepHeightMm, 300);
});

test('床の面の向きと違う（子の床が低く天井も低い）境界は、床の面と天井だけの面が別々にできる', () => {
  const { graph, room } = setup({ via: 'child', childFL: -100, rightCH: 2400 });
  const steps = stepFaces(composeRoomFaces(room, graph));
  assert.equal(steps.length, 2);
  assert.equal(steps.filter(f => f.stepHeightMm === 100 && !f.ceilingSteps).length, 1, '床の面（ceilingSteps 無し）');
  assert.equal(steps.filter(f => f.stepHeightMm === 0 && f.ceilingSteps.length === 1).length, 1, '天井だけの面');
});

test('島の下がり天井（3×3 の中央セル）: 4 面とも壁の無い両端（stepEndWall が false）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (type, v) => graph.addCenterLine(type, v, { labeled: false, discipline: Discipline.ARCH });
  const xs = [0, 2000, 4000, 6000].map(v => cl(CenterLineType.VERTICAL, v));
  const ys = [0, 1000, 2000, 3000].map(v => cl(CenterLineType.HORIZONTAL, v));
  const cell = (i, j) => `${xs[i].id}:${ys[j].id}:${xs[i + 1].id}:${ys[j + 1].id}`;
  const room = graph.addRoom(new Set([0, 1, 2].flatMap(i => [0, 1, 2].map(j => cell(i, j)))), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  room.setOverride('ceilingHeight', String(BASE_CH));
  room.setCeilingZones(createZone(graph, room, [cell(1, 1)], { heightMm: 2100, shape: 'flat', dims: [] }).zones);
  const fs = ceilFaces(composeRoomFaces(room, graph));
  assert.equal(fs.length, 4);
  for (const f of fs) {
    assert.equal(f.stepEndWallAt0, false);
    assert.equal(f.stepEndWallAtRun, false);
    assert.ok(f.axisCL, '天井芯でも軸 CL を持つ');
  }
  assert.deepEqual(new Set(fs.map(f => f.letter)).size, 4);
});

test('subtractOpenSpanCoverage（天井の辺も通す）: 同じ平面の面の範囲へ丸めてから、開放スパンが覆う区間を差し引く', () => {
  const face = {
    isVertical: true, axisCL: { value: 4000 }, inward: -1, lo: 1000, hi: 3000, originWorld: 1000, dirSign: 1,
    spans: [{ kind: 'open', loX: 500, hiX: 1000 }],
  };
  const seg = { isVertical: true, value: 4000, inward: -1, lo: 0, hi: 3000 };
  const clipped = subtractOpenSpanCoverage([seg], [face]).map(s => [s.lo, s.hi]);
  assert.deepEqual(clipped, [[1000, 1500], [2000, 3000]], '面の範囲 [1000,3000] へ丸めてから開放スパン [1500,2000] を差し引く');
  const noFace = subtractOpenSpanCoverage([seg], []).map(s => [s.lo, s.hi]);
  assert.deepEqual(noFace, [[0, 3000]], '対照: 同じ平面の面が無ければそのまま');
});

// ---- 描画（合成の面） ----
const AXIS = { id: 'axisY0', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 };
const makeCtx = () => ({
  graph: { openings: [], kneeDropWalls: new Map(), shapeMap: new Map([[AXIS.id, AXIS]]) },
  project: { openingNumberIndex: new Map() }, room: { getFinishInfo: () => ({}), finish: null },
  ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
});
const entry = (loX, hiX, over = {}) => ({
  loX, hiX, lowCeilAbsMm: 2100, ceilStepHeightMm: 300, beyondFloorDeltaMm: 0, lowSurface: { roomId: 'r', zoneId: null }, ...over,
});
const stepFace = (over = {}) => ({
  axisCL: AXIS, isVertical: false, inward: 1, faceValue: 0, lo: 0, hi: 1200, run: 1200, dirSign: 1, originWorld: 0,
  startCLId: 'x0', endCLId: 'x1', label: 'C1', kind: 'step', baseFloorDeltaMm: 0, stepHeightMm: 0, ceilAbsMm: 2400, ...over,
});
const lines = (prims, w) => prims.filter(p => p.type === 'line' && p.weight === w && p.dash !== 'center');
const vertical = (ls, x) => ls.filter(l => l.x1 === x && l.x2 === x);
const horizontal = (ls, y) => ls.filter(l => l.y1 === y && l.y2 === y);
const gapYs = prims => [...new Set(prims.filter(p => p.type === 'line' && p.dash === 'center' && p.x1 !== p.x2).flatMap(p => [p.y1, p.y2]))].sort((a, b) => a - b);

test('描画（島）: 壁の無い端は CUT の縦線を引かず小口の SILHOUETTE だけ。見付け下端 SILHOUETTE・アキは下端の下から。床の段差上端は引かない', () => {
  const face = stepFace({ stepEndWallAt0: false, stepEndWallAtRun: false, ceilingSteps: [entry(300, 900)] });
  const prims = buildFaceFigure(face, makeCtx());
  const cut = lines(prims, 'thick'), sil = lines(prims, 'medium');
  assert.deepEqual(vertical(cut, 0), [], '壁の無い端 0 に CUT の縦線は無い');
  assert.deepEqual(vertical(cut, 1200), [], '壁の無い端 run に CUT の縦線は無い');
  assert.equal(horizontal(cut, -2400).length, 1, '断面の天井は CUT');
  assert.equal(horizontal(cut, 0).length, 1, '見る側の床は CUT');
  assert.equal(horizontal(sil, -2100).length, 1, '見付け下端は SILHOUETTE');
  assert.deepEqual([horizontal(sil, -2100)[0].x1, horizontal(sil, -2100)[0].x2], [300, 900]);
  assert.equal(vertical(sil, 300).length, 1, '小口（左）');
  assert.equal(vertical(sil, 900).length, 1, '小口（右）');
  assert.deepEqual(horizontal(sil, 0), [], 'stepHeightMm 0 は床の段差上端を引かない');
  assert.deepEqual(gapYs(prims), [-2400, -2100, 0], 'アキは下端の下（区間の外は断面の天井から）');
});

test('描画（壁のある端）: 両端は CUT の縦線で、小口の SILHOUETTE は引かない', () => {
  const face = stepFace({ ceilingSteps: [entry(0, 1200)] });
  const prims = buildFaceFigure(face, makeCtx());
  const cut = lines(prims, 'thick'), sil = lines(prims, 'medium');
  assert.equal(vertical(cut, 0).length, 1);
  assert.equal(vertical(cut, 1200).length, 1);
  assert.deepEqual(vertical(sil, 0), []);
  assert.deepEqual(vertical(sil, 1200), []);
  assert.equal(horizontal(sil, -2100).length, 1);
  assert.deepEqual(gapYs(prims), [-2100, 0]);
});

test('描画（合流した床の面）: 床の段差上端と見付け下端がともに出て、アキは [下端, 段差上端]', () => {
  const face = stepFace({ stepHeightMm: 300, ceilingSteps: [entry(0, 1200, { beyondFloorDeltaMm: undefined })] });
  const sil = lines(buildFaceFigure(face, makeCtx()), 'medium');
  assert.equal(horizontal(sil, -300).length, 1, '床の段差上端');
  assert.equal(horizontal(sil, -2100).length, 1, '見付け下端');
  assert.deepEqual(gapYs(buildFaceFigure(face, makeCtx())), [-2100, -300]);
});

test('描画: 向こうの床が見る側の床より低いときだけ DETAIL の破線を引く（同じ高さなら引かない）', () => {
  const below = buildFaceFigure(stepFace({ ceilingSteps: [entry(0, 1200, { beyondFloorDeltaMm: -100 })] }), makeCtx());
  const dashed = below.filter(p => p.type === 'line' && p.weight === 'thin' && p.dash === 'dashed' && p.y1 === 100);
  assert.equal(dashed.length, 1);
  assert.deepEqual([dashed[0].x1, dashed[0].x2], [0, 1200]);
  const same = buildFaceFigure(stepFace({ ceilingSteps: [entry(0, 1200, { beyondFloorDeltaMm: 0 })] }), makeCtx());
  assert.equal(same.filter(p => p.type === 'line' && p.dash === 'dashed').length, 0);
});

test('描画: 見付け下端が断面の天井以上、または床以下なら見付けを描かない（従来のアキ 1 枚）', () => {
  for (const lowCeilAbsMm of [2400, 2500, 0, -10]) {
    const prims = buildFaceFigure(stepFace({ ceilingSteps: [entry(0, 1200, { lowCeilAbsMm })] }), makeCtx());
    assert.equal(lines(prims, 'medium').filter(l => l.y1 === l.y2).length, 0, `lowCeilAbsMm ${lowCeilAbsMm}`);
    assert.deepEqual(gapYs(prims), [-2400, 0]);
  }
});

test('描画: ceilingSteps の無い床の面は従来どおり（段差上端・両端の縦線・アキ全幅）', () => {
  const prims = buildFaceFigure(stepFace({ stepHeightMm: 100, baseFloorDeltaMm: -100, ceilAbsMm: 2300, beyondCeilAbsMm: 2400 }), makeCtx());
  const cut = lines(prims, 'thick'), sil = lines(prims, 'medium');
  assert.equal(vertical(cut, 0).length, 1);
  assert.equal(vertical(cut, 1200).length, 1);
  assert.equal(horizontal(sil, 0).length, 1, '見付け上端');
  assert.deepEqual(gapYs(prims), [-2300, 0]);
});
