// sectionStructure.js visibleBeamPieces（梁の可視区間の唯一の判定）の単体テスト。
// 線への写像（structuralPrimitivesForCut）・床の遮蔽は含めない——種類・x 範囲・z 範囲だけを見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleBeamPieces, structuralPrimitivesForCut, memberKey, beamSectionShown, beamAlongShown, memberOutlineFloorState,
  wallEntriesOfLayers,
} from './sectionStructure.js';

// 水平の切断線 y=0（室内側＝+y。viewSign=1・dirSign=1・local x = world x）。描画範囲 x 0..2000。
const cutOf = (over = {}) => ({
  seqNo: 'c', line: { isVertical: false, axisValue: 0, lo: 0, hi: 2000 },
  viewSign: 1, dirSign: 1, layers: [{ graph: { walls: [] }, floorZMm: 0, role: 'self' }],
  zRange: { loZ: 0, hiZ: 2400 }, baseFloorZ: 0, ...over,
});
// 空中の梁（y=500・x 0..2000・天 1190・成 200）
const airborneBeam = (over = {}) => ({
  isVertical: false, axisWorld: 500, spanLo: 0, spanHi: 2000, widthMm: 100,
  topZ: 1190, depthMm: 200, role: 'landing', section: null, ...over,
});
// 切断線に直交する梁（x=1000・スパン y -500..1500 が切断位置 y=0 を含む）
const crossBeam = (over = {}) => airborneBeam({ isVertical: true, axisWorld: 1000, spanLo: -500, spanHi: 1500, ...over });
// 切断線の帯の中を通る平行の梁（y=0 が芯）
const parallelBeam = (over = {}) => airborneBeam({ axisWorld: 0, ...over });
const colSolid = (over = {}) => ({
  xLo: 900, xHi: 1100, yLo: -60, yHi: 60, baseZ: 0, covers: {}, trimmed: {}, wallAxes: [], ...over,
});
const noCol = { columnSolids: null };

test('section: 直交する梁は見付け幅の x 範囲・天〜下端の z 範囲の 1 片。芯の x を持つ', () => {
  const [p, ...rest] = visibleBeamPieces([crossBeam()], cutOf(), [], null, noCol);
  assert.equal(rest.length, 0);
  assert.equal(p.kind, 'section');
  assert.deepEqual([p.xLo, p.xHi, p.zLo, p.zHi, p.x], [950, 1050, 990, 1190, 1000]);
});

test('section: 梁の位置が切断線の描画範囲の外なら出さない（失敗系）', () => {
  assert.deepEqual(visibleBeamPieces([crossBeam({ axisWorld: 5000 })], cutOf(), [], null, noCol), []);
});

test('section: 切断位置で梁が壁の足元（embedding.along）に埋まっていれば出さない。対照: along が無ければ出る', () => {
  assert.equal(visibleBeamPieces([crossBeam()], cutOf(), [], null, noCol).length, 1, '対照');
  assert.deepEqual(visibleBeamPieces([crossBeam({ embedding: { along: [[-500, 1500]], alongTol: [] } })], cutOf(), [], null, noCol), []);
});

test('section: 室内側の続きが柱包みに隠れるなら出さない（柱の層・埋没の分岐）', () => {
  // 室内側 [0,1500] を柱包み（y -60..60 では足りないので 0..1500 を覆う柱）で全部隠す
  const col = colSolid({ yLo: -10, yHi: 1600, xLo: 900, xHi: 1100 });
  assert.deepEqual(visibleBeamPieces([crossBeam()], cutOf(), [], null, { columnSolids: [col] }), []);
});

test('airborne: 柱包みに隠れる区間を引いた残り区間ごとに 1 片。z は天〜下端', () => {
  const col = colSolid({ yLo: 440, yHi: 560, xLo: 900, xHi: 1100 });
  const ps = visibleBeamPieces([airborneBeam()], cutOf(), [], null, { columnSolids: [col] });
  assert.deepEqual(ps.map(p => [p.kind, p.xLo, p.xHi, p.zLo, p.zHi]),
    [['airborne', 0, 900, 990, 1190], ['airborne', 1100, 2000, 990, 1190]]);
});

test('airborne: 天井より下端が上の区間は出さない（ceilZAtWorld）。天井が取れなければ見える側', () => {
  const ceil = (z) => ({ columnSolids: null, ceilZAtWorld: () => z });
  assert.deepEqual(visibleBeamPieces([airborneBeam()], cutOf(), [], null, ceil(990)), []);
  assert.equal(visibleBeamPieces([airborneBeam()], cutOf(), [], null, ceil(null)).length, 1);
});

test('airborne: 切断線の背後（viewSign の逆側）の梁は出さない（失敗系）', () => {
  assert.deepEqual(visibleBeamPieces([airborneBeam({ axisWorld: -500 })], cutOf(), [], null, noCol), []);
});

test('airborne: 描画範囲（0..2000）の外へはみ出すスパンは描画範囲に切り詰める', () => {
  const ps = visibleBeamPieces([airborneBeam({ spanLo: -500, spanHi: 2500 })], cutOf(), [], null, noCol);
  assert.deepEqual(ps.map(p => [p.xLo, p.xHi]), [[0, 2000]]);
});

test('airborne: 切断線と梁の間の全高の壁が覆う区間は引く。対照: 壁が無ければ 1 片', () => {
  const wall = { isVertical: false, axisValue: 300, materialRange: { lo: 290, hi: 310 }, coord1: 800, coord2: 1200 };
  const ps = visibleBeamPieces([airborneBeam()], cutOf({ layers: [{ graph: { walls: [wall] }, floorZMm: 0, role: 'self' }] }), [], null, noCol);
  assert.deepEqual(ps.map(p => [p.xLo, p.xHi]), [[0, 800], [1200, 2000]]);
  assert.equal(visibleBeamPieces([airborneBeam()], cutOf(), [], null, noCol).length, 1, '対照');
});

test('airborne: 最も手前の面から奥行きの上限（SIGHTLINE_DEPTH_LIMIT_MM）以上奥の梁は出さない。対照: 上限内は出る', () => {
  const cols = [{ bands: [{ kind: 'wall', distMm: 0 }] }];
  assert.deepEqual(visibleBeamPieces([airborneBeam({ axisWorld: 1000 })], cutOf(), cols, null, noCol), [], '奥行き 950 ≥ 800');
  assert.equal(visibleBeamPieces([airborneBeam({ axisWorld: 500 })], cutOf(), cols, null, noCol).length, 1, '対照: 奥行き 450');
});

test('airborne: 部屋の帯（bandRoomBounds）の外の梁は出さない。対照: 帯の中は出る', () => {
  const bounds = (y2) => ({ bandRoomBounds: { x1: 0, x2: 2000, y1: 0, y2 } });
  assert.deepEqual(visibleBeamPieces([airborneBeam()], cutOf(bounds(400)), [], null, noCol), [], 'y=500 は帯 0..400 の外');
  assert.equal(visibleBeamPieces([airborneBeam()], cutOf(bounds(600)), [], null, noCol).length, 1, '対照');
});

test('parallel: 切断線の帯の中の梁は天地の x 範囲と、梁の元の端である側の縦線の x を持つ', () => {
  const [p] = visibleBeamPieces([parallelBeam()], cutOf(), [], null, noCol);
  assert.equal(p.kind, 'parallel');
  assert.deepEqual([p.xLo, p.xHi, p.zLo, p.zHi, ...p.ends], [0, 2000, 990, 1190, 0, 2000]);
});

test('parallel: 壁の足元（embedding.along）で中断された梁は区間ごと。縦線は元の端が残る側だけ', () => {
  const ps = visibleBeamPieces([parallelBeam({ embedding: { along: [[800, 1200]], alongTol: [] } })], cutOf(), [], null, noCol);
  assert.deepEqual(ps.map(p => [p.xLo, p.xHi, p.ends]), [[0, 800, [0]], [1200, 2000, [2000]]]);
});

test('床（断面線）: 断面線の輪郭に梁成以上届かない梁は断面・平行とも落とす。踊り場受け梁は残す', () => {
  const profile = [[0, 1200], [2000, 1200]];
  const low = { topZ: 0, role: 'floor' };
  assert.deepEqual(visibleBeamPieces([crossBeam(low)], cutOf(), [], profile, noCol), [], 'section');
  assert.deepEqual(visibleBeamPieces([parallelBeam(low)], cutOf(), [], profile, noCol), [], 'parallel');
  assert.equal(visibleBeamPieces([crossBeam({ ...low, role: 'landing' })], cutOf(), [], profile, noCol).length, 1);
});

// ---- 面の切断（opts.facePlane＝面の通りの梁・opts.fromRoomSide＝断面の続きを室内側で見る）----
// 面 y=0（室内側＝+y）。仮想断面は室内側へ 100 下がった y=100、壁を見る向き（viewSign=-1）。
const faceCutOf = (over = {}) => cutOf({
  line: { isVertical: false, axisValue: 100, lo: 0, hi: 2000 }, viewSign: -1,
  face: { isVertical: false, axisCL: { effectiveValue: 0 } }, ...over,
});
const roomFace = { columnSolids: null, fromRoomSide: true };
const stairFace = noCol; // 階段帯: fromRoomSide を渡さない・facePlane も渡さない（cut.face があれば既定で効く）

test('facePlane: 面の平面上の梁（面の軸が梁の幅の帯の中）は、切断線が帯の外でも parallel（細線）。対照: facePlane:false なら空中の梁（中線）', () => {
  const beam = parallelBeam({ widthMm: 100 }); // 帯 -50..50。切断線 y=100 は帯の外、面の軸 y=0 は帯の中
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, roomFace).map(p => p.kind), ['parallel']);
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, { columnSolids: null, facePlane: false }).map(p => p.kind), ['airborne'], '対照');
});

test('facePlane: 階段帯（fromRoomSide 無し）でも cut.face があれば面の通りの梁は parallel（S3b-2）。壁に埋まる区間は描かない', () => {
  const beam = parallelBeam({ widthMm: 100, embedding: { along: [[800, 1200]], alongTol: [] } });
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, stairFace).map(p => [p.kind, p.xLo, p.xHi]),
    [['parallel', 0, 800], ['parallel', 1200, 2000]]);
});

test('facePlane: 面の通りの梁は天井裏の区間で切れる（airborne と同じ処理）。対照: 天井が取れない cut では切れない（失敗系）', () => {
  const beam = parallelBeam({ widthMm: 100 }); // 下端 990
  const ceil = (f) => ({ columnSolids: null, ceilZAtWorld: f });
  const cutAt = visibleBeamPieces([beam], faceCutOf(), [], null, ceil((x) => (x < 1000 ? 990 : 5000)));
  assert.equal(cutAt.length, 1);
  assert.ok(Math.abs(cutAt[0].xLo - 1000) < 0.1 && cutAt[0].xHi === 2000 && cutAt[0].kind === 'parallel', 'x<1000 は天井裏で落ちる（境界は二分探索の精度）');
  assert.deepEqual(cutAt[0].ends, [2000], '残りの区間の元の端の縦線だけ残る');
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, ceil(() => 990)), [], '全区間が天井裏なら出ない');
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, ceil(() => null)).map(p => [p.xLo, p.xHi]), [[0, 2000]], '天井が取れなければ見える側');
});

test('facePlane: 面の通りの梁は切断線の描画範囲へ切り詰める（範囲外の端の縦線は出ない）。対照: 切断線の帯の中を通る梁は従来どおり切り詰めない', () => {
  const wide = { spanLo: -500, spanHi: 2500 };
  assert.deepEqual(visibleBeamPieces([parallelBeam({ widthMm: 100, ...wide })], faceCutOf(), [], null, noCol).map(p => [p.xLo, p.xHi, p.ends]),
    [[0, 2000, []]]);
  assert.deepEqual(visibleBeamPieces([parallelBeam(wide)], cutOf(), [], null, noCol).map(p => [p.xLo, p.xHi, p.ends]),
    [[-500, 2500, [-500, 2500]]], '対照: 面を持たない切断の parallel');
});

test('facePlane: 面の通りの梁は切断線と梁の間の全高の壁（規則A）が覆う区間で切れる。手前の壁が腰壁なら切れない（失敗系）', () => {
  // 面 y=0 の梁（帯 -50..50）と切断線 y=100 の間（y=60・材 55..65）に、x 800..1200 の壁
  const wall = { isVertical: false, axisValue: 60, materialRange: { lo: 55, hi: 65 }, coord1: 800, coord2: 1200, axisCL: { id: 'H', centerLineType: 'h', effectiveValue: 60 } };
  const layersOf = (graph) => ({ layers: [{ graph: { walls: [wall], ...graph }, floorZMm: 0, role: 'self' }] });
  const beam = parallelBeam({ widthMm: 100 });
  const spans = (cut) => visibleBeamPieces([beam], cut, [], null, noCol).map(p => [p.kind, p.xLo, p.xHi]);
  assert.deepEqual(spans(faceCutOf(layersOf({}))), [['parallel', 0, 800], ['parallel', 1200, 2000]], '全高の壁が覆う 800..1200 は描かない');
  const knee = { kneeDropWalls: new Map([['H:S:E', { knee: { topHeight: 900 } }]]),
    shapeMap: new Map([['H', { centerLineType: 'h', effectiveValue: 60 }], ['S', { value: 800 }], ['E', { value: 1200 }]]) };
  assert.deepEqual(spans(faceCutOf(layersOf(knee))), [['parallel', 0, 2000]], '腰壁は梁を隠さない');
});

test('facePlane: cut.face が無い切断（吹抜け帯の線からの cut 等）では効かず従来どおり空中の梁（失敗系）', () => {
  assert.deepEqual(visibleBeamPieces([parallelBeam()], faceCutOf({ face: undefined }), [], null, stairFace).map(p => p.kind), ['airborne']);
});

test('fromRoomSide: 階段帯では偽のまま＝断面の続きを従来どおり壁側で見る（壁側 [20,100] が埋まっていれば出ない）。対照: 部屋帯は出る', () => {
  const beam = crossBeam({ spanLo: 20, spanHi: 1500, embedding: { along: [], alongTol: [[-500, 200]] } });
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, stairFace), [], '階段帯: facePlane が既定 true でも断面の続きの向きは変わらない');
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, roomFace).map(p => p.kind), ['section'], '対照');
});

test('facePlane: 面の軸が梁の幅の帯の外なら parallel にしない・面を持たない切断も従来どおり（失敗系）', () => {
  assert.deepEqual(visibleBeamPieces([parallelBeam({ axisWorld: 300 })], faceCutOf(), [], null, roomFace), [], '面の軸も切断線も帯の外・梁は切断線の手前側（壁を見る向きの逆）');
  const noFace = faceCutOf({ face: undefined });
  assert.deepEqual(visibleBeamPieces([parallelBeam()], noFace, [], null, roomFace).map(p => p.kind), ['airborne'], '面が無ければ従来どおり切断線だけで判定');
});

test('fromRoomSide: 断面の続きは室内側（viewSign の逆）で見る。壁の中に埋まった側ではなく室内へ張り出す側の残りで出る', () => {
  // 梁は x=1000・スパン y 20..1500（壁芯 y=0 の手前の 20 から室内へ）。壁の足元（embedding.alongTol）が壁側 -500..200 を覆う
  const beam = crossBeam({ spanLo: 20, spanHi: 1500, embedding: { along: [], alongTol: [[-500, 200]] } });
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, roomFace).map(p => p.kind), ['section']);
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, noCol), [], '対照: 指定が無ければ壁側 [20,100] が埋まっていて出ない');
});

test('fromRoomSide: 室内側の続きが柱包みに全部隠れるなら断面は出ない（失敗系）', () => {
  const beam = crossBeam({ spanLo: 20, spanHi: 1500 });
  const col = colSolid({ yLo: 90, yHi: 1600, xLo: 900, xHi: 1100 });
  assert.deepEqual(visibleBeamPieces([beam], faceCutOf(), [], null, { columnSolids: [col], fromRoomSide: true }), []);
  assert.equal(visibleBeamPieces([beam], faceCutOf(), [], null, roomFace).length, 1, '対照: 柱が無ければ出る');
});

test('fromRoomSide: 切断位置が梁のスパンの外（壁芯の手前で止まる梁が切断線にも届かない）なら断面は出ない（失敗系）', () => {
  assert.deepEqual(visibleBeamPieces([crossBeam({ spanLo: 150, spanHi: 1500 })], faceCutOf(), [], null, roomFace), []);
});

test('contribution が空・未指定でも例外を投げず空', () => {
  assert.deepEqual(visibleBeamPieces([], cutOf(), [], null, noCol), []);
  assert.deepEqual(visibleBeamPieces(undefined, cutOf(), [], null, noCol), []);
});

// ---- 梁の断面・along は帯（memberCut）が担う（opts.memberCuts。U1b B3-1）----
test('memberCuts: 帯が持つ梁（断面・along・空中・面の通りの見え掛かり）は出さない。dropped の梁（memberKey）だけ従来どおり出す', () => {
  const none = { columnSolids: null, memberCuts: { dropped: new Set() } };
  assert.deepEqual(visibleBeamPieces([crossBeam()], cutOf(), [], null, none), [], 'section は帯が描く');
  assert.deepEqual(visibleBeamPieces([parallelBeam()], cutOf(), [], null, none), [], 'along（切断線の帯の中）は帯が描く');
  assert.deepEqual(visibleBeamPieces([airborneBeam()], cutOf(), [], null, none), [], '空中の見え掛かりも帯（memberFace）が描く（B6: 統合）');
  assert.deepEqual(visibleBeamPieces([parallelBeam({ widthMm: 100 })], faceCutOf(), [], null, { ...none, fromRoomSide: true }), [],
    '面の通りの梁（facePlane）も帯が描く（B6: 統合）');
  // dropped
  const dropped = (b) => ({ columnSolids: null, memberCuts: { dropped: new Set([memberKey(b)]) } });
  const cross = crossBeam(), par = parallelBeam();
  assert.deepEqual(visibleBeamPieces([cross], cutOf(), [], null, dropped(cross)).map(p => p.kind), ['section']);
  assert.deepEqual(visibleBeamPieces([par], cutOf(), [], null, dropped(par)).map(p => p.kind), ['parallel']);
  // only: dropped の部材だけ（断面・along・見え掛かり。帯が持つ部材は返さない）
  const only = (b) => ({ columnSolids: null, memberCuts: { dropped: new Set([memberKey(b)]) } });
  const air = airborneBeam();
  assert.deepEqual(visibleBeamPieces([air, cross], cutOf(), [], null, { columnSolids: null, memberCuts: { dropped: new Set([memberKey(cross)]) } }).map(p => p.kind),
    ['section'], 'only は帯が持つ（dropped でない）空中の見え掛かりを返さない');
  assert.deepEqual(visibleBeamPieces([air], cutOf(), [], null, only(air)).map(p => p.kind), ['airborne'], 'only: dropped の空中の梁は見え掛かりを返す（B3-2）');
  assert.deepEqual(visibleBeamPieces([parallelBeam({ widthMm: 100 })], faceCutOf(), [], null, { columnSolids: null, memberCuts: { dropped: new Set() }, fromRoomSide: true }), [],
    'only: 帯が持つ（dropped でない）面の通りの梁は返さない');
  assert.deepEqual(visibleBeamPieces([parallelBeam({ widthMm: 100 })], faceCutOf(), [], null, { ...only(parallelBeam({ widthMm: 100 })), fromRoomSide: true }).map(p => p.kind),
    ['parallel'], 'only: dropped の面の通りの梁は返す（B3-2）');
  // 省略（memberCuts なし）は全部描く（既定は従来どおり）
  assert.deepEqual(visibleBeamPieces([cross, par], cutOf(), [], null, noCol).map(p => p.kind), ['section', 'parallel']);
});

test('memberKey: 作り直した梁の立体（clipBeamsToBand のコピー等）でも同じキー。別の梁は別のキー', () => {
  const b = crossBeam({ layerTopZ: 1190, layerDepthMm: 200 });
  assert.equal(memberKey({ ...b, topZ: 1000, depthMm: 100 }), memberKey(b), '帯への切り詰めで topZ/depthMm が変わっても層の元の天端・成で同一');
  assert.notEqual(memberKey(crossBeam({ axisWorld: 1100 })), memberKey(crossBeam()));
  assert.notEqual(memberKey(parallelBeam()), memberKey(crossBeam()));
});

test('共有する可視判定: beamSectionShown は visibleBeamPieces の section と同じ答え（描画範囲外・壁の足元・柱包み・断面線）', () => {
  const profile = [[0, 1200], [2000, 1200]];
  const cases = [
    ['基本', crossBeam(), cutOf(), null, noCol, true],
    ['描画範囲の外', crossBeam({ axisWorld: 5000 }), cutOf(), null, noCol, false],
    ['壁の足元に埋まる', crossBeam({ embedding: { along: [[-500, 1500]], alongTol: [] } }), cutOf(), null, noCol, false],
    ['断面線より下に浮く', crossBeam({ topZ: 0, role: 'floor' }), cutOf(), profile, noCol, false],
    ['踊り場受け梁は残す', crossBeam({ topZ: 0, role: 'landing' }), cutOf(), profile, noCol, true],
    ['柱包みに隠れる', crossBeam(), cutOf(), null, { columnSolids: [colSolid({ yLo: -10, yHi: 1600, xLo: 900, xHi: 1100 })] }, false],
  ];
  for (const [label, beam, cut, floorProfile, opts, expected] of cases) {
    const viaPieces = visibleBeamPieces([beam], cut, [], floorProfile, opts).some(p => p.kind === 'section');
    const wc = { wallEntries: wallEntriesOfLayers(cut.layers), partitionLinesOf: () => [] };
    const viaShared = beamSectionShown(cut, beam, { wc, columnSolids: opts.columnSolids, layers: cut.layers, floorProfile, fromRoomSide: !!opts.fromRoomSide });
    assert.equal(viaPieces, expected, `${label}（加算）`);
    assert.equal(viaShared, viaPieces, `${label}（共有関数が加算と同じ答え）`);
  }
});

test('共有する可視判定: beamAlongShown は parallel の入口と同じ（スパンが切断線の範囲に掛かる・断面線より下に浮かない）', () => {
  assert.equal(beamAlongShown(cutOf(), parallelBeam()), true);
  assert.equal(beamAlongShown(cutOf(), parallelBeam({ spanLo: 5000, spanHi: 6000 })), false, '範囲の外');
  assert.equal(beamAlongShown(cutOf(), parallelBeam({ topZ: 0, role: 'floor' }), [[0, 1200], [2000, 1200]]), false, '断面線より下');
});

test('memberOutlineFloorState: 床なし区間と重ならなければ clip／区間の中は whole／境界をまたいで階段側の壁が覆うなら drop', () => {
  const wc = { wallEntries: [], partitionLinesOf: () => [] };
  const beam = crossBeam(); // x 950..1050
  assert.equal(memberOutlineFloorState(cutOf(), beam, [], wc), 'clip');
  assert.equal(memberOutlineFloorState(cutOf(), beam, [{ lo: 0, hi: 500 }], wc), 'clip', '重ならない');
  assert.equal(memberOutlineFloorState(cutOf(), beam, [{ lo: 900, hi: 1100 }], wc), 'whole', '区間の中');
  assert.equal(memberOutlineFloorState(cutOf(), beam, [{ lo: 1000, hi: 2000 }], wc), 'whole', '境界をまたぐが壁が無い＝覆わない');
});

test('structuralPrimitivesForCut は visibleBeamPieces の返り値を線へ写すだけ（片の数と線の数が対応する）', () => {
  const lines = (beams) => structuralPrimitivesForCut(beams, cutOf(), [], null, noCol).length;
  assert.equal(lines([crossBeam()]), 4, 'section: 矩形 4 辺');
  assert.equal(lines([airborneBeam()]), 2, 'airborne: 天地 2 本');
  assert.equal(lines([parallelBeam()]), 4, 'parallel: 天地 2 本＋両端の縦線 2 本');
});
