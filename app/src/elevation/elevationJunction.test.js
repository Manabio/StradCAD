// 部屋の取り合い（Room.detailRefs）の断面図から展開の面へ派生する水平線（elevation/elevationJunction.js。部分詳細図 S8a-2）。
// 合成 fixture（elevationFigure.test.js と同じ最小フェイク）で buildFaceFigure の出力を固定する。新 golden は作らない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, OpeningCategory, CenterLineType } from '@core';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays } from '../catalog/catalogRegistry.js';
import { DetailSlot, PenDir, DETAIL_PRIM_SOURCE } from '../core/constants.js';
import { buildFaceFigure } from './elevationFigure.js';
import { junctionPlanForFace, junctionLineSpecs, stepsAtMinDrawn } from './elevationJunction.js';
import {
  junctionFigure, fixedLen, move, baseboardFigure, wallBackedFigure,
} from '../finish/roomDetailTestFixtures.js';

const DF = CatalogKind.DETAIL_FIGURE;
const { FLOOR_WALL, WALL_CEILING } = DetailSlot;
const THIN = 'thin';
const MEDIUM = 'medium';

test.afterEach(() => clearOverlays());

const AXIS_Y0 = { id: 'axisY0', centerLineType: CenterLineType.HORIZONTAL, effectiveValue: 0, value: 0 };
const wallOf = (thickness = 100) => ({
  axisCL: AXIS_Y0, isVertical: false, coord1: 0, coord2: 4000, materialRange: { lo: 0, hi: thickness }, backingRange: null,
});
function makeGraph({ openings = [], kneeDropWalls = new Map(), shapes = new Map(), walls = [wallOf()] } = {}) {
  const shapeMap = new Map(shapes);
  shapeMap.set(AXIS_Y0.id, AXIS_Y0);
  return { openings, kneeDropWalls, shapeMap, walls };
}
const makeFace = (over = {}) => ({
  axisCL: AXIS_Y0, isVertical: false, inward: 1, faceValue: 0, lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0,
  startCLId: 'x0', endCLId: 'x1', ...over,
});
const makeRoom = (detailRefs, baseboard = null) => ({
  getFinishInfo: () => ({}), finish: baseboard ? { baseboardHeight: baseboard } : null, detailRefs,
});
const ctxOf = (over = {}) => ({
  graph: makeGraph(), project: { openingNumberIndex: new Map() }, room: makeRoom(null),
  ceilingHeight: 2400, materialMap: new Map(), gridCLs: [], ...over,
});
const install = (...figures) => setOverlay(DF, { user: figures });
const detailLines = prims => prims.filter(p => p.type === 'line' && p.source === DETAIL_PRIM_SOURCE);
const at = (lines, y) => lines.filter(p => p.y1 === y && p.y2 === y);

/** 階段状の取り合い（floorWall）: t=−60 は印（air）・t=−100 は自動。形は (0,0)→(20,0)→(20,−60)→(10,−60)→(10,−100)→(0,−100)。 */
function steppedFloorWall(key) {
  return junctionFigure(key, FLOOR_WALL, [
    move(PenDir.RIGHT, fixedLen(20)), move(PenDir.UP, fixedLen(60)), { ...move(PenDir.LEFT, fixedLen(10)), edge: 'air' },
    move(PenDir.UP, fixedLen(40)), move(PenDir.LEFT, fixedLen(10)),
  ], { closed: true });
}
/** 矩形の見切り（wallCeiling）。天井面から下へ h。 */
const ceilingTrimFigure = (key, h = 60) => junctionFigure(key, WALL_CEILING, [
  move(PenDir.DOWN, fixedLen(h)), move(PenDir.RIGHT, fixedLen(12)), move(PenDir.UP, fixedLen(h)),
], { closed: true });

test('floorWall: 包絡線の段差の高さに細線（source=detail）が引かれ、既存の巾木線は引かれない（巾木は図が担う）', () => {
  install(baseboardFigure('k'));
  const ref = buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: 'gone' }, 'h=45') }));
  assert.equal(at(ref.filter(p => p.type === 'line'), -45).length, 1, '対照: 参照切れの割当ては従来の巾木線（フォールバック）');
  const prims = buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: 'k' }, 'h=45') }));
  assert.equal(at(prims.filter(p => p.type === 'line'), -45).length, 0, 'fit が成った面は巾木線を引かない');
  const lines = at(detailLines(prims), -60);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].weight, THIN);
  assert.equal(lines[0].x1, 0);
  assert.equal(lines[0].x2, 4000);
});

test('floorWall: 印（air）の段差は中線・自動の段差は細線（同じ高さは 1 本）', () => {
  install(steppedFloorWall('k'));
  const prims = buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: 'k' }) }));
  const lines = detailLines(prims);
  assert.deepEqual(at(lines, -60).map(l => l.weight), [MEDIUM]);
  assert.deepEqual(at(lines, -100).map(l => l.weight), [THIN]);
});

test('floorWall: 床まで達する戸・線の高さを含む窓・壁の無い区間で線が切れる（腰壁では切れない）', () => {
  install(steppedFloorWall('k'));
  const door = { id: 'd', isVertical: false, axisCL: { id: 'axisY0' }, centerCoord: 500, width: 800, height: 2000, sillHeight: 0, category: OpeningCategory.FITTING, subType: 'singleSwing' };
  const win = { id: 'w', isVertical: false, axisCL: { id: 'axisY0' }, centerCoord: 3500, width: 400, height: 1000, sillHeight: 80, category: OpeningCategory.WINDOW, subType: 'fixed' };
  const shapes = new Map([['s', { value: 1500 }], ['e', { value: 2500 }]]);
  const kneeDropWalls = new Map([[edgeKey('axisY0', 's', 'e'), { knee: { topHeight: 80 }, drop: null }]]);
  const face = makeFace({ spans: [{ loX: 0, hiX: 3000, kind: 'wall' }, { loX: 3000, hiX: 3200, kind: 'open', farFloorDeltaMm: 0, farCeilAbsMm: 2400 }, { loX: 3200, hiX: 4000, kind: 'wall' }] });
  const prims = buildFaceFigure(face, ctxOf({
    graph: makeGraph({ openings: [door, win], shapes, kneeDropWalls }), room: makeRoom({ [FLOOR_WALL]: 'k' }),
  }));
  const drawnAt = (lines, x) => lines.some(l => Math.min(l.x1, l.x2) <= x && x <= Math.max(l.x1, l.x2));
  // 高さ 60: 戸（100〜900）と開放スパン（3000〜3200）だけで切れる（窓は窓台 80 の上・腰壁 80 は 60 を覆う）
  const l60 = at(detailLines(prims), -60);
  assert.deepEqual([50, 1000, 2000, 3500, 3900].map(x => drawnAt(l60, x)), [true, true, true, true, true]);
  assert.deepEqual([500, 3100].map(x => drawnAt(l60, x)), [false, false], '戸と開放スパンの中は途切れる');
  // 高さ 100: 戸・窓（窓台 80〜1080 は 100 を含む）・開放スパンで切れる。腰壁の区間（1500〜2500）は壁体があるので切れない
  const l100 = at(detailLines(prims), -100);
  assert.deepEqual([50, 1000, 2000, 2800, 3900].map(x => drawnAt(l100, x)), [true, true, true, true, true]);
  assert.deepEqual([500, 3500, 3100].map(x => drawnAt(l100, x)), [false, false, false], '戸・窓・開放スパンは途切れる');
});

test('floorWall: 垂れ壁の下も切れない（従来の巾木に合わせる・S8c 裁定。切るのは壁体の無い区間と開口だけ）', () => {
  // 段差の高さ 1000 と 2100。天井 2400・垂れ壁 400 → 垂れ壁の下端は床から 2000
  install(junctionFigure('k', FLOOR_WALL, [
    move(PenDir.RIGHT, fixedLen(20)), move(PenDir.UP, fixedLen(1000)), move(PenDir.LEFT, fixedLen(10)),
    move(PenDir.UP, fixedLen(1100)), move(PenDir.LEFT, fixedLen(10)),
  ], { closed: true }));
  const shapes = new Map([['s', { value: 1500 }], ['e', { value: 2500 }]]);
  const kneeDropWalls = new Map([[edgeKey('axisY0', 's', 'e'), { knee: null, drop: { bottomHeight: 400 } }]]);
  const prims = buildFaceFigure(makeFace(), ctxOf({
    graph: makeGraph({ shapes, kneeDropWalls }), room: makeRoom({ [FLOOR_WALL]: 'k' }),
  }));
  const drawnAt = (lines, x) => lines.some(l => Math.min(l.x1, l.x2) <= x && x <= Math.max(l.x1, l.x2));
  const l1000 = at(detailLines(prims), -1000);
  assert.deepEqual([500, 2000, 3500].map(x => drawnAt(l1000, x)), [true, true, true], '高さ 1000 も垂れ壁の下で切れない');
  const l2100 = at(detailLines(prims), -2100);
  assert.deepEqual([500, 2000, 3500].map(x => drawnAt(l2100, x)), [true, true, true], '高さ 2100 は垂れ壁の中＝切れない');
});

/** floorWall（高さ 100 と 1000）と wallCeiling（60）の両方を持つ面を、記録だけ変えて描く。 */
function drawWithRecords(kneeDropWalls, extra = {}) {
  install(
    junctionFigure('fw', FLOOR_WALL, [
      move(PenDir.RIGHT, fixedLen(20)), move(PenDir.UP, fixedLen(100)), move(PenDir.LEFT, fixedLen(10)),
      move(PenDir.UP, fixedLen(900)), move(PenDir.LEFT, fixedLen(10)),
    ], { closed: true }),
    ceilingTrimFigure('wc'),
  );
  const shapes = new Map([['s', { value: 1500 }], ['e', { value: 2500 }]]);
  const { openings = [], ...faceOver } = extra;
  return buildFaceFigure(makeFace(faceOver), ctxOf({
    graph: makeGraph({ shapes, kneeDropWalls, openings }), room: makeRoom({ [FLOOR_WALL]: 'fw', [WALL_CEILING]: 'wc' }),
  }));
}
const recMap = rec => new Map(rec ? [[edgeKey('axisY0', 's', 'e'), rec]] : []);

test('【保証】派生線（floorWall・wallCeiling）は腰壁・垂れ壁の記録に左右されない（無し・腰壁だけ・垂れ壁だけ・両方で同一）', () => {
  const none = detailLines(drawWithRecords(recMap(null)));
  assert.ok(none.length >= 3, `対照: 記録が無くても派生線は出る（実際:${none.length}）`);
  for (const rec of [{ knee: { topHeight: 80 }, drop: null }, { knee: null, drop: { bottomHeight: 400 } }, { knee: { topHeight: 1000 }, drop: { bottomHeight: 400 } }]) {
    assert.deepEqual(detailLines(drawWithRecords(recMap(rec))), none, JSON.stringify(rec));
  }
});

test('wallCeiling: 腰壁だけの区間の上でも途切れない（廻り縁は 1 本の連続）', () => {
  const lines = detailLines(drawWithRecords(recMap({ knee: { topHeight: 80 }, drop: null }))).filter(p => p.y1 === -2340 && p.y2 === -2340);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].x1, lines[0].x2], [0, 4000]);
});

test('【失敗系】記録があっても、同じ区間の開放スパン・床まで達する戸は線を切る（切る理由は壁体の無さと開口だけ）', () => {
  const rec = recMap({ knee: null, drop: { bottomHeight: 400 } });
  const drawnAt = (lines, x) => lines.some(l => Math.min(l.x1, l.x2) <= x && x <= Math.max(l.x1, l.x2));
  const spans = [{ loX: 0, hiX: 1800, kind: 'wall' }, { loX: 1800, hiX: 2200, kind: 'open', farFloorDeltaMm: 0, farCeilAbsMm: 2400 }, { loX: 2200, hiX: 4000, kind: 'wall' }];
  const door = { id: 'd', isVertical: false, axisCL: { id: 'axisY0' }, centerCoord: 3000, width: 800, height: 2000, sillHeight: 0, category: OpeningCategory.FITTING, subType: 'singleSwing' };
  const l100 = at(detailLines(drawWithRecords(rec, { spans, openings: [door] })), -100);
  assert.deepEqual([1000, 3900].map(x => drawnAt(l100, x)), [true, true]);
  assert.deepEqual([2000, 3000].map(x => drawnAt(l100, x)), [false, false], '開放スパンと戸の中は記録があっても切れる');
});

test('floorWall: 既定の巾木 60 は分母 300 で最小描画幅 150 へ引き上がる（受容を固定）', () => {
  const heights = scaleDenom => [...new Set(detailLines(buildFaceFigure(makeFace(), ctxOf({ room: makeRoom(null, 'h=60'), scaleDenom })))
    .filter(p => p.y1 === p.y2).map(p => -p.y1))];
  assert.deepEqual(heights(100), [60], '対照: 分母 100 は 60');
  assert.deepEqual(heights(300), [150]);
});

test('wallCeiling: 天井面から下へ t の線が区間ごとの天井高に追従する', () => {
  install(ceilingTrimFigure('k'));
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 0, chMm: 2200 },
  ];
  const prims = buildFaceFigure(makeFace(), ctxOf({ floorSegments, room: makeRoom({ [WALL_CEILING]: 'k' }) }));
  const lines = detailLines(prims);
  assert.equal(lines.length, 2);
  const left = at(lines, -2340)[0];
  const right = at(lines, -2140)[0];
  assert.equal(left.x1, 0);
  assert.equal(right.x2, 4000);
  assert.equal(left.weight, THIN);
  // 境界は天井の段差の縦線と同じ位置（drawnCeilingRiserX）で、左右の線は同じ x で接する
  assert.equal(left.x2, right.x1);
  assert.ok(Math.abs(left.x2 - 2000) <= 100, `境界は区間の境界付近（実際:${left.x2}）`);
});

test('wallCeiling: 円弧の天井区間・ceilingProfile の面には引かない', () => {
  install(ceilingTrimFigure('k'));
  const arc = [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 2400, ceilArc: { alongX: 2000, chMm: 2800 } }];
  assert.equal(detailLines(buildFaceFigure(makeFace(), ctxOf({ floorSegments: arc, room: makeRoom({ [WALL_CEILING]: 'k' }) }))).length, 0);
  const prof = buildFaceFigure(makeFace(), ctxOf({ ceilingProfile: [[0, 2400], [4000, 2800]], room: makeRoom({ [WALL_CEILING]: 'k' }) }));
  assert.equal(detailLines(prof).length, 0);
});

test('floorWall: 床段差のある区間は区間ごとの床に沿う水平線 2 本＋段差の縦線（すべて source=detail）', () => {
  install(baseboardFigure('k'));
  const floorSegments = [
    { loX: 0, hiX: 2000, floorDeltaMm: 0, chMm: 2400 },
    { loX: 2000, hiX: 4000, floorDeltaMm: 300, chMm: 2400 },
  ];
  const prims = buildFaceFigure(makeFace(), ctxOf({ floorSegments, room: makeRoom({ [FLOOR_WALL]: 'k' }) }));
  const lines = detailLines(prims);
  const horizontals = lines.filter(p => p.y1 === p.y2).map(p => [p.y1, Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[1] - b[1]);
  assert.equal(horizontals.length, 2);
  assert.equal(horizontals[0][0], -60);
  assert.equal(horizontals[0][1], 0);
  assert.equal(horizontals[1][0], -360);
  assert.equal(horizontals[1][2], 4000);
  const verticals = lines.filter(p => p.x1 === p.x2);
  assert.equal(verticals.length, 1, '床段差の縦線');
  assert.deepEqual([Math.min(verticals[0].y1, verticals[0].y2), Math.max(verticals[0].y1, verticals[0].y2)], [-360, -60]);
});

test('wallCeiling: 勾配天井の区間では天井に平行な斜めの派生線（両端が天井の下 t）', () => {
  install(ceilingTrimFigure('k'));
  const floorSegments = [{ loX: 0, hiX: 4000, floorDeltaMm: 0, chMm: 2400, chHiMm: 3000 }];
  const prims = buildFaceFigure(makeFace(), ctxOf({ floorSegments, room: makeRoom({ [WALL_CEILING]: 'k' }) }));
  const lines = detailLines(prims);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].x1, 0);
  assert.equal(lines[0].x2, 4000);
  assert.ok(Math.abs(lines[0].y1 - (-2400 + 60)) < 1e-6, `左端 y=${lines[0].y1}`);
  assert.ok(Math.abs(lines[0].y2 - (-3000 + 60)) < 1e-6, `右端 y=${lines[0].y2}`);
});

test('junctionLineSpecs: 床〜天井の外の高さは引かない（天井より高い段差・FL 上の t=0）', () => {
  install(baseboardFigure('k', 12, 2500));
  const prims = buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: 'k' }) }));
  assert.equal(detailLines(prims).length, 0, '高さ 2500 は天井 2400 の外');
});

test('【失敗系】存在しないキー・壁厚に合わない図・壁が引けない面: 線を出さず出力は割当て無しと byte 一致（巾木も従来どおり）', () => {
  // 基準＝従来の巾木線（参照切れの割当てはフォールバック）。割当て無しは組込みが既定になるので基準にしない（S8c）
  const base = buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: 'gone0' }, 'h=45') }));
  assert.equal(at(base.filter(p => p.type === 'line'), -45).length, 1);
  install(wallBackedFigure('thick-only')); // 固定 5mm＋伸縮: 壁厚 4 では FIXED_EXCEEDS_TARGET
  const gone = buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: 'gone' }, 'h=45') }));
  assert.deepEqual(gone, base);
  const tooThin = buildFaceFigure(makeFace(), ctxOf({ graph: makeGraph({ walls: [wallOf(4)] }), room: makeRoom({ [FLOOR_WALL]: 'thick-only' }, 'h=45') }));
  assert.deepEqual(tooThin, base);
  const noWall = buildFaceFigure(makeFace(), ctxOf({ graph: makeGraph({ walls: [] }), room: makeRoom({ [FLOOR_WALL]: 'thick-only' }, 'h=45') }));
  assert.deepEqual(noWall, base);
  assert.equal(junctionPlanForFace(makeFace(), { graph: makeGraph(), room: makeRoom({ [FLOOR_WALL]: 'gone' }) }), null);
  assert.equal(junctionPlanForFace(makeFace(), { graph: makeGraph(), room: makeRoom(null) }), null);
});

test('skipBaseboard の帯（階段帯等）・段差見付け面・吹抜けの面には引かない', () => {
  install(baseboardFigure('k'));
  const room = makeRoom({ [FLOOR_WALL]: 'k' });
  assert.equal(detailLines(buildFaceFigure(makeFace(), ctxOf({ room, skipBaseboard: true }))).length, 0);
  assert.equal(junctionPlanForFace(makeFace({ kind: 'step' }), { graph: makeGraph(), room }), null);
  assert.equal(junctionPlanForFace(makeFace({ voidAbove: { selfLocal: [] } }), { graph: makeGraph(), room }), null);
});

test('stepsAtMinDrawn: |t| が最小幅未満なら最小幅へ（符号を保つ）・60 は不変・t=0 は触らない・入力は書き換えない', () => {
  const input = [{ t: 20, weight: 'auto' }, { t: -20, weight: 'air' }, { t: 60, weight: 'auto' }, { t: 0, weight: 'auto' }];
  const snapshot = JSON.parse(JSON.stringify(input));
  assert.deepEqual(stepsAtMinDrawn(input, 50), [
    { t: 50, weight: 'auto' }, { t: -50, weight: 'air' }, { t: 60, weight: 'auto' }, { t: 0, weight: 'auto' },
  ]);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(stepsAtMinDrawn(input, 10), snapshot, '最小幅 10（1/20）なら 20 は 20 のまま');
  assert.deepEqual(stepsAtMinDrawn(null, 50), []);
});

test('stepsAtMinDrawn: 調整後に同じ t へ畳まれる段差は 1 本・auto と air が重なれば air（順序によらない）', () => {
  assert.deepEqual(stepsAtMinDrawn([{ t: 20, weight: 'auto' }, { t: 30, weight: 'auto' }], 50), [{ t: 50, weight: 'auto' }]);
  assert.deepEqual(stepsAtMinDrawn([{ t: 20, weight: 'auto' }, { t: 30, weight: 'air' }], 50), [{ t: 50, weight: 'air' }]);
  assert.deepEqual(stepsAtMinDrawn([{ t: 20, weight: 'air' }, { t: 50, weight: 'auto' }], 50), [{ t: 50, weight: 'air' }]);
  assert.deepEqual(stepsAtMinDrawn([{ t: 20, weight: 'auto' }, { t: -30, weight: 'auto' }], 50), [{ t: 50, weight: 'auto' }, { t: -50, weight: 'auto' }], '符号が違えば別の線');
});

test('floorWall: 厚 20 の段差は分母 100（未指定）で高さ 50・1/20 で 20・厚 60 はどちらでも 60（最小描画幅）', () => {
  install(baseboardFigure('k20', 12, 20), baseboardFigure('k60', 12, 60));
  const heights = (key, extra = {}) => detailLines(buildFaceFigure(makeFace(), ctxOf({ room: makeRoom({ [FLOOR_WALL]: key }), ...extra })))
    .filter(p => p.y1 === p.y2).map(p => -p.y1);
  assert.deepEqual([...new Set(heights('k20'))], [50], '分母未指定＝100');
  assert.deepEqual([...new Set(heights('k20', { scaleDenom: 100 }))], [50]);
  assert.deepEqual([...new Set(heights('k20', { scaleDenom: 20 }))], [20]);
  assert.deepEqual([...new Set(heights('k60'))], [60]);
  assert.deepEqual([...new Set(heights('k60', { scaleDenom: 20 }))], [60]);
});

test('junctionLineSpecs: 仕様は純粋に包絡線から（段差の高さ・役割・途切れ）', () => {
  install(steppedFloorWall('k'));
  const face = makeFace();
  const plan = junctionPlanForFace(face, { graph: makeGraph(), room: makeRoom({ [FLOOR_WALL]: 'k' }) });
  const specs = junctionLineSpecs(plan, {
    face, graph: makeGraph(), run: 4000, segs: [{ loX: 0, hiX: 4000, floorDeltaMm: 0 }], openings: [], wallLessRuns: [],
    ceilRiserXAt: () => 0, segCeilAbsAt: () => 2400,
  });
  assert.deepEqual(specs.floorWall.map(s => [s.heightMm, s.role]).sort((a, b) => a[0] - b[0]), [[60, 'silhouette'], [100, 'detail']]);
  assert.deepEqual(specs.wallCeiling, []);
});
