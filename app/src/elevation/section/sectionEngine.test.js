// sectionEngine.js（WP-E4: buildSectionFigure）の単体テスト。
// 完了条件: floorSegmentsが隙間なく面全幅・hiX>loX／ceilingProfile昇順。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, edgeKey } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { makeProbeContext } from './sectionProbe.js';
import { buildSectionFigure, buildColumns, mergeColumns, splitOpenByFarFace } from './sectionEngine.js';
import { SIGHTLINE_DEPTH_LIMIT_MM } from '../elevationStyle.js';

const CH = 2400;

function makeGraph() {
  const plane = new Plane('p1', 0, '1階', 1, 1);
  return new PlanGraph(plane);
}

function makeRectRoom(graph, x0v, y0v, x1v, y1v, name = 'LDK') {
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, x0v, { labeled: false, discipline: Discipline.ARCH });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, x1v, { labeled: false, discipline: Discipline.ARCH });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, y0v, { labeled: false, discipline: Discipline.ARCH });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, y1v, { labeled: false, discipline: Discipline.ARCH });
  const key = `${x0.id}:${y0.id}:${x1.id}:${y1.id}`;
  const room = graph.addRoom(new Set([key]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

function frontCut(graph, overrides = {}) {
  return {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0, ...overrides,
  };
}

test('【WP-E4】buildSectionFigure: floorSegmentsは隙間なく面全幅を覆い、hiX>loX', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const fig = buildSectionFigure(cut, probeCtx);

  assert.ok(Array.isArray(fig.floorSegments) && fig.floorSegments.length > 0);
  for (const seg of fig.floorSegments) assert.ok(seg.hiX > seg.loX, `hiX(${seg.hiX})>loX(${seg.loX})のはず`);
  // 隙間なく面全幅を覆う: 隣接区間のhiX===次のloX、先頭loX===0、末尾hiX===face.run。
  const sorted = [...fig.floorSegments].sort((a, b) => a.loX - b.loX);
  assert.equal(sorted[0].loX, 0, '先頭区間のloXは面のローカル原点0のはず');
  assert.equal(sorted[sorted.length - 1].hiX, fig.face.run, '末尾区間のhiXは面全幅(face.run)のはず');
  for (let i = 0; i + 1 < sorted.length; i++) {
    assert.equal(sorted[i].hiX, sorted[i + 1].loX, '隣接区間は隙間なく連続するはず');
  }
});

test('【WP-E4】buildSectionFigure: ceilingProfileはlocalX昇順', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const fig = buildSectionFigure(cut, probeCtx);

  assert.ok(Array.isArray(fig.ceilingProfile) && fig.ceilingProfile.length >= 2);
  for (let i = 0; i + 1 < fig.ceilingProfile.length; i++) {
    assert.ok(fig.ceilingProfile[i][0] <= fig.ceilingProfile[i + 1][0],
      `ceilingProfileはlocalX昇順のはず（${JSON.stringify(fig.ceilingProfile)}）`);
  }
});

test('【WP-E4】buildSectionFigure: skipBaseboard/skipWallLabelは常にtrue（階段の下は原則描かない規約）', () => {
  const graph = makeGraph();
  makeRectRoom(graph, 0, 0, 4000, 3000, 'LDK');
  const cut = frontCut(graph);
  const probeCtx = makeProbeContext(cut.layers);
  const fig = buildSectionFigure(cut, probeCtx);
  assert.equal(fig.skipBaseboard, true);
  assert.equal(fig.skipWallLabel, true);
  assert.equal(fig.seqNo, '1');
});

test('【WP-E4】mergeColumns: bandsが完全一致する隣接列は1列に統合される', () => {
  const columns = [
    { x0: 0, x1: 500, worldLo: 0, worldHi: 500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 500, x1: 1000, worldLo: 500, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 100 }] },
    { x0: 1000, x1: 1500, worldLo: 1000, worldHi: 1500, bands: [{ kind: 'wall', z0: 0, z1: 2400, distMm: 999 }] },
  ];
  const merged = mergeColumns(columns);
  assert.equal(merged.length, 2, '先頭2列は同一bandsのため統合され、3列目だけ独立するはず');
  assert.equal(merged[0].x0, 0);
  assert.equal(merged[0].x1, 1000);
  assert.equal(merged[1].x0, 1000);
  assert.equal(merged[1].x1, 1500);
});

// ================================================================
// Phase 4: splitOpenByFarFace（水平面ヒットの深度上限適用・アキの範囲を縮める。設計§5.5）
// ================================================================

test('【Phase4・a】splitOpenByFarFace: 上限内のfarCeilZは区間を[z0,farCeilZ]の open と [farCeilZ,z1]の非描画(farVoid)へ2分割する', () => {
  const band = { kind: 'open', z0: 800, z1: 3000, farFloorZ: null, farCeilZ: 2400, farDepthMm: 100 };
  const parts = splitOpenByFarFace(band, 0); // nearestMm=0 → 100-0=100 < 800（上限内）
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { kind: 'open', z0: 800, z1: 2400, farFloorZ: null, farCeilZ: 2400, farDepthMm: 100 });
  assert.deepEqual(parts[1], { kind: 'farVoid', z0: 2400, z1: 3000 });
});

test('【Phase4・b】splitOpenByFarFace: 深度上限"以上"なら付帯情報を落として従来どおり全域アキ（分割しない）', () => {
  const farDepthMm = SIGHTLINE_DEPTH_LIMIT_MM; // ちょうど上限（>=なので上限超え扱い）
  const band = { kind: 'open', z0: 800, z1: 3000, farFloorZ: null, farCeilZ: 2400, farDepthMm };
  const parts = splitOpenByFarFace(band, 0);
  assert.deepEqual(parts, [{ kind: 'open', z0: 800, z1: 3000 }],
    '上限ちょうど(境界含む)は水平面を無かったことにし、付帯情報の無い単一open帯に戻すはず');
});

test('【Phase4】splitOpenByFarFace: farFloorZ/farCeilZが両方とも区間の内部にあれば[非描画,open,非描画]の3分割', () => {
  const band = { kind: 'open', z0: 0, z1: 3000, farFloorZ: 500, farCeilZ: 2400, farDepthMm: 100 };
  const parts = splitOpenByFarFace(band, 0);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.map(p => [p.kind, p.z0, p.z1]),
    [['farVoid', 0, 500], ['open', 500, 2400], ['farVoid', 2400, 3000]]);
});

test('【Phase4・d相当】splitOpenByFarFace: farFloorZ/farCeilZが区間の境界そのもの（内部でない）なら分割せず1本のopenのまま', () => {
  const band = { kind: 'open', z0: 0, z1: 1800, farFloorZ: undefined, farCeilZ: undefined, farDepthMm: undefined };
  const parts = splitOpenByFarFace(band, 0);
  assert.deepEqual(parts, [band], '付帯情報が無い（=境界扱いで付かなかった）帯はそのまま素通りするはず');
});

test('【Phase4・e相当】splitOpenByFarFace: farCeilZがnull（天井高が解決できない縮退）ならfarVoidは下側だけ・open上端は元のz1のまま', () => {
  const band = { kind: 'open', z0: 800, z1: 3000, farFloorZ: 1500, farCeilZ: null, farDepthMm: 100 };
  const parts = splitOpenByFarFace(band, 0);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0], { kind: 'farVoid', z0: 800, z1: 1500 });
  assert.deepEqual(parts[1], { kind: 'open', z0: 1500, z1: 3000, farFloorZ: 1500, farCeilZ: null, farDepthMm: 100 });
});

test('【Phase5・実機「11ダッシュ」A2型】splitOpenByFarFace: farFloorZが区間の外（z0より下）なら、farVoidを作らず下端をfarFloorZまで伸ばす', () => {
  // z0(0)の下に隠す実体は無い（区間の外＝farFloorZ側は「そこまで抜けている」）ため、farVoidを
  // 作らずopen自体の下端を書き換える——「区間の内部を縮める」Phase4とは逆方向の変更。
  const band = { kind: 'open', z0: 0, z1: 2400, farFloorZ: -100, farCeilZ: 2400, farDepthMm: 58 };
  const parts = splitOpenByFarFace(band, 0);
  assert.deepEqual(parts, [{ kind: 'open', z0: -100, z1: 2400, farFloorZ: -100, farCeilZ: 2400, farDepthMm: 58,
    extendedFromZ: 0 }],
    'farVoidを挟まず、open帯自体の下端がfarFloorZ(-100)まで伸びるはず。extendedFromZ(=伸ばす前のz0)は' +
    'emitOpenGapMarksの一点鎖線/破線切替がこの帯自身の下降と誤認しないための印');
});

test('【失敗系・Phase5】splitOpenByFarFace: farFloorZがz1以上（不正・境界）なら区間の外でも下端は伸ばさない', () => {
  const band = { kind: 'open', z0: 0, z1: 2400, farFloorZ: 2400, farCeilZ: null, farDepthMm: 58 };
  const parts = splitOpenByFarFace(band, 0);
  assert.deepEqual(parts, [{ kind: 'open', z0: 0, z1: 2400, farFloorZ: 2400, farCeilZ: null, farDepthMm: 58 }],
    'farFloorZ(2400)がz1と同値（不正値扱い）ならz0は変えないはず');
});

// QA是正2026-09（検算・実機「11'」A2）: 全高壁の向こうにある別室の天井（深度1057.5・上限超え）が、
// 手前で開いている別室の床（深度57.5・上限内）と`farDepthMm`（両者の最小値）を共有していたため、
// 本来上限外で採用されないはずの天井が上限判定をすり抜けて採用されていた。
// farFloorDepthMm/farCeilDepthMmで個別に判定することを固定する。
test('【QA是正・検算】splitOpenByFarFace: 近い床（上限内）と遠い天井（上限外）が同じopen区間にあれば、床だけ縮み天井は縮まず天井線も出ない', () => {
  // 床は57.5mm先（上限内）・天井は1057.5mm先（nearestMm=57.5からは1000mm差で上限800超え）。
  const band = {
    kind: 'open', z0: 0, z1: 2400, farFloorZ: -100, farCeilZ: 2300,
    farDepthMm: 57.5, farFloorDepthMm: 57.5, farCeilDepthMm: 1057.5,
  };
  const parts = splitOpenByFarFace(band, 57.5); // nearestMm=57.5（最も手前の壁面までの距離）
  assert.deepEqual(parts, [{
    kind: 'open', z0: -100, z1: 2400, farFloorZ: -100, farCeilZ: null,
    farDepthMm: 57.5, farFloorDepthMm: 57.5, farCeilDepthMm: 1057.5, extendedFromZ: 0,
  }], '床(farFloorZ=-100)だけ下端に反映され、天井(farCeilZ)は上限超えでnullへ落ち、z1(2400)のまま縮まないはず');
});

test('【失敗系・QA是正・検算】splitOpenByFarFace: 逆に遠い床（上限外）と近い天井（上限内）なら、天井だけ縮み床は伸びない', () => {
  const band = {
    kind: 'open', z0: 0, z1: 2400, farFloorZ: -100, farCeilZ: 2300,
    farDepthMm: 57.5, farFloorDepthMm: 1057.5, farCeilDepthMm: 57.5,
  };
  const parts = splitOpenByFarFace(band, 57.5);
  assert.deepEqual(parts, [
    { kind: 'open', z0: 0, z1: 2300, farFloorZ: null, farCeilZ: 2300,
      farDepthMm: 57.5, farFloorDepthMm: 1057.5, farCeilDepthMm: 57.5 },
    { kind: 'farVoid', z0: 2300, z1: 2400 },
  ], '天井(farCeilZ=2300)だけ区間内部として縮み、床(farFloorZ)は上限超えでnullへ落ち、z0(0)のまま伸びないはず');
});

// ---- 失敗系 ----
test('【失敗系・Phase4】splitOpenByFarFace: kind!=="open"やfarDepthMm欠落の帯はそのまま1件で返る（対象外は無変化）', () => {
  assert.deepEqual(splitOpenByFarFace({ kind: 'wall', z0: 0, z1: 800, distMm: 57.5 }, 0),
    [{ kind: 'wall', z0: 0, z1: 800, distMm: 57.5 }]);
  const plainOpen = { kind: 'open', z0: 0, z1: 800 };
  assert.deepEqual(splitOpenByFarFace(plainOpen, 0), [plainOpen]);
});

// QA是正C: nearestMmが非有限（この切断にwall帯が1枚も無い＝上限の基準点そのものが無い）ときは
// 「上限を超えている」と同じ扱いにする（buildColumnsは`Number.isFinite(nearestMm) ?
// nearestMm : -Infinity`をsplitOpenByFarFaceへ渡す——本テストはその-Infinity契約そのものを
// 直接検証する。buildColumnsレベルでnearestMmを非有限にする実データ相当の幾何
// 〈この切断のどの列にも'wall'帯が1枚も無い〉は、現行のフィクスチャ手段（矩形室＋
// generateRoomWallsFromOutline）では壁の無い辺を作れないため構成できない——呼び出し側の
// 配線（buildColumns内の三項演算子）はコードレビューで確認済み・本関数の契約はここで固定する）。
test('【失敗系・QA是正C】splitOpenByFarFace: nearestMmが非有限(-Infinity)なら、farDepthMmが小さくても上限超え扱いになり付帯情報を落とす', () => {
  const band = { kind: 'open', z0: 800, z1: 3000, farFloorZ: null, farCeilZ: 2400, farDepthMm: 57.5 };
  // 有限なnearestMm(0)なら上限内（57.5-0=57.5<800）で分割されるはず、という前提を先に確認する。
  assert.equal(splitOpenByFarFace(band, 0).length, 2, '前提: 有限なnearestMmなら上限内で分割されるはず');
  const parts = splitOpenByFarFace(band, -Infinity);
  assert.deepEqual(parts, [{ kind: 'open', z0: 800, z1: 3000 }],
    '基準点が無い(-Infinity)なら上限超えと同じ扱いで、付帯情報の無い単一open帯に戻すはず');
});

// ================================================================
// QA是正A: `wall`帯が深度上限超えで`open`へ作り替えられる経路（buildColumns内の
// nearestSightlineDistMm比較）でも、farFloorZ/farCeilZ/farDepthMmが失われず引き継がれ、
// buildColumnsの結果にfarVoid分割が出ることを**実データ相当の幾何**で確認する。
// ================================================================
//
// フィクスチャ: 部屋A(0..4000,0..4000・天井3000)の南に腰壁(topHeight800)を挟んで部屋B
// (天井2400)。腰壁面のcutをbandRoomBoundsで絞らずに探査すると、腰壁の上(z800..)の
// 見えがかり壁の勝者は**部屋Bのさらに南（外周壁。距離4057.5mm）**になる——この壁自身の
// z上限は「視線方向の所有Room＝部屋A」の天井(3000)まで解決される（sectionLayerStack.jsの
// resolveSightlineTopZ）ため、**部屋B自身の天井(2400)より高い**。この壁は深度上限
// （4057.5-57.5=4000>=800）を超えるため`open`へ作り替えられるが、部屋Bの天井(2400)は
// その壁の帯の**内部**（800<2400<3000）にあり、かつ部屋Bの天井の見えがかり自体の深度は
// **cellsAlongの段差歩き＝腰壁のすぐ向こう＝57.5mm**（壁自身の距離4057.5mmとは別物）で
// 上限内——「壁は上限超え・その向こうの天井は上限内」という、QA是正Aが直す実例そのもの。
function makeFarWallKneeFixture() {
  const graph = makeGraph();
  const roomA = makeRectRoom(graph, 0, 0, 4000, 4000, 'A');
  roomA.setOverride('ceilingHeight', '3000');
  const roomB = makeRectRoom(graph, 0, 4000, 4000, 8000, 'B');
  roomB.setOverride('ceilingHeight', '2400');
  const nearWall = graph.walls.find(w =>
    !w.isVertical && w.axisCL.effectiveValue === 4000 && w.materialRange.hi === 4000);
  graph.setKneeDropWall(
    edgeKey(nearWall.axisCL.id, nearWall.clStart.id, nearWall.clEnd.id), { knee: { topHeight: 800 } });
  return { graph, roomA, roomB, nearWall };
}
function kneeFaceCutForFarWallFixture(graph, nearWall) {
  return {
    seqNo: 'kneeFace',
    line: { isVertical: false, axisValue: nearWall.materialRange.lo, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
    // bandRoomBoundsは意図的に付けない——部屋Bのさらに南の外周壁が候補として通る必要がある。
  };
}

test('【QA是正A】buildColumns: 深度上限超えの壁(distMm4057.5)がopenへ作り替えられても、その内部にある近いceilFace(部屋Bの天井2400・深度57.5)は失われず、open/farVoidへ分割される', () => {
  const { graph, nearWall } = makeFarWallKneeFixture();
  const cut = kneeFaceCutForFarWallFixture(graph, nearWall);
  const probeCtx = makeProbeContext(cut.layers);

  const columns = buildColumns(cut, probeCtx);
  const midCol = columns.find(c => Math.abs(c.x0 - 57.5) < 1 && Math.abs(c.x1 - 3942.5) < 1);
  assert.ok(midCol, '腰壁の面幅ぶんの列があるはず');
  const openBand = midCol.bands.find(b => b.kind === 'open');
  const farVoidBand = midCol.bands.find(b => b.kind === 'farVoid');
  assert.ok(openBand, 'open帯（腰壁の上・部屋Bの天井まで）があるはず');
  assert.equal(openBand.z0, 800); assert.equal(openBand.z1, 2400,
    '上限内のfarCeilZ(2400)まで縮むはず（作り替え元のwall帯の元々のz1は3000だった）');
  assert.ok(farVoidBand, 'farVoid帯（部屋Bの天井懐。z2400..3000）があるはず');
  assert.equal(farVoidBand.z0, 2400); assert.equal(farVoidBand.z1, 3000);
});

// ---- 失敗系 ----
test('【失敗系・WP-E4】buildSectionFigure: layers=[]（候補ゼロ）でも例外を投げずfloorSegments/ceilingProfileが返る', () => {
  const cut = {
    seqNo: '1', line: { isVertical: false, axisValue: 0, lo: 0, hi: 4000 },
    viewSign: 1, dirSign: 1, layers: [], zRange: { loZ: 0, hiZ: CH }, baseFloorZ: 0,
  };
  const probeCtx = makeProbeContext([]);
  const fig = buildSectionFigure(cut, probeCtx);
  assert.ok(fig.floorSegments.length > 0);
  assert.ok(fig.floorSegments[0].hiX > fig.floorSegments[0].loX);
  assert.ok(fig.ceilingProfile.length >= 2);
});

test('【失敗系・WP-E4】mergeColumns: 列0件でも例外を投げず空配列を返す', () => {
  assert.deepEqual(mergeColumns([]), []);
});

// ================================================================
// 傾斜天井の受け口（E3a-1）: cut.ceilProfile の区間が ceilZHi（hiX での高さ）を持つと、列は
// 低い側（ceilZ）で水平に打ち切られ、傾いた列には ceilEdge（図のx0側/x1側の高さ）が付く。
// 切断壁の帯だけは天端が天井の斜線に沿う（ceilEdge付き・z1は高い側）。topEdge（隔て壁の斜めの天端）とは別物。
// ================================================================
const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''} 期待 ${expected} 実際 ${actual}`);

// 部屋 0..4000×0..3000（天井 roomCh）を y=1500 で x 方向に切る。切断線は世界x -100..4100（図のローカルx＝世界x+100）。
// 壁の断面は左 x=100..157.5・右 x=4042.5..4100（壁厚115の半分が探査範囲の外端で切れる）。
// 傾斜は loX=0..4200 で 2400→2820（1mmあたり0.1）。
function slopeFixture(roomCh = '3000', profile) {
  const graph = makeGraph();
  const room = makeRectRoom(graph, 0, 0, 4000, 3000, 'S');
  room.setOverride('ceilingHeight', roomCh);
  const cut = {
    seqNo: 'slope', line: { isVertical: false, axisValue: 1500, lo: -100, hi: 4100 },
    viewSign: 1, dirSign: 1, layers: [{ graph, floorZMm: 0, role: 'self' }],
    zRange: { loZ: 0, hiZ: 3000 }, baseFloorZ: 0,
    ceilProfile: profile ?? [{ loX: 0, hiX: 4200, ceilZ: 2400, ceilZHi: 2820 }],
  };
  return { cut, probeCtx: makeProbeContext(cut.layers) };
}

test('【傾斜の ceilProfile で壁の帯の天端が斜線になる】列にceilEdge・切断壁の帯は高い側まで残りceilEdge付き・他の帯は低い側で水平に打ち切る', () => {
  const { cut, probeCtx } = slopeFixture();
  const cols = buildColumns(cut, probeCtx);
  assert.equal(cols.length, 5, '開口(0..100)・左の壁(100..157.5)・見えがかり壁・右の壁・開口');
  const [openL, cutL, mid, cutR, openR] = cols;
  // 列: ceilZ は低い側・ceilEdge は図の x0 側/x1 側の高さ
  near(openL.ceilZ, 2400); near(openL.ceilEdge.zAtX0, 2400); near(openL.ceilEdge.zAtX1, 2410);
  near(cutL.ceilZ, 2410); near(cutL.ceilEdge.zAtX0, 2410); near(cutL.ceilEdge.zAtX1, 2415.75);
  near(mid.ceilZ, 2415.75); near(mid.ceilEdge.zAtX1, 2804.25);
  near(cutR.ceilZ, 2804.25); near(cutR.ceilEdge.zAtX1, 2810);
  near(openR.ceilZ, 2810); near(openR.ceilEdge.zAtX1, 2820);
  // 切断壁の帯: 上端は高い側（3000まで伸びない）・ceilEdge が付く
  const wallL = cutL.bands.find(b => b.kind === 'cut');
  near(wallL.z1, 2415.75, '左の壁の上端は列の高い側'); near(wallL.ceilEdge.zAtX0, 2410); near(wallL.ceilEdge.zAtX1, 2415.75);
  const wallR = cutR.bands.find(b => b.kind === 'cut');
  near(wallR.z1, 2810); near(wallR.ceilEdge.zAtX0, 2804.25); near(wallR.ceilEdge.zAtX1, 2810);
  // 他の帯（open・見えがかりの壁）は低い側で水平に打ち切る（ceilEdge を持たない）
  const openBand = openL.bands.find(b => b.kind === 'open');
  near(openBand.z1, 2400, '開口の帯は低い側で水平'); assert.equal(openBand.ceilEdge, undefined);
  const seen = mid.bands.find(b => b.kind === 'wall');
  near(seen.z1, 2415.75, '見えがかりの壁は低い側で水平'); assert.equal(seen.ceilEdge, undefined);
});

test('【傾斜の ceilProfile】出力: 天端の線は出さず（斜線は体裁が引く）・側縁は端の斜線の高さで止まり・天井の斜線より上に線が出ない', () => {
  const { cut, probeCtx } = slopeFixture();
  const lines = buildSectionFigure(cut, probeCtx).content.filter(p => p.type === 'line' && p.weight === 'thick');
  const has = (x1, y1, x2, y2) => lines.some(p => Math.abs(p.x1 - x1) < 1e-6 && Math.abs(p.y1 - y1) < 1e-6
    && Math.abs(p.x2 - x2) < 1e-6 && Math.abs(p.y2 - y2) < 1e-6);
  assert.ok(lines.every(p => p.y1 === p.y2 ? p.y1 === 0 : p.x1 === p.x2),
    '天端の線は出ない（天井の斜線は体裁が引く）。太線は床の水平線と側縁の縦線だけ');
  assert.ok(!has(100, -2410, 157.5, -2415.75) && !has(4042.5, -2804.25, 4100, -2810), '天端の斜線は出ない');
  assert.ok(has(100, 0, 100, -2410), '左の壁の左側縁は x=100 の斜線の高さ(2410)で止まる');
  assert.ok(has(157.5, 0, 157.5, -2415.75), '左の壁の右側縁は x=157.5 の斜線の高さ(2415.75)で止まる');
  assert.ok(has(4042.5, 0, 4042.5, -2804.25) && has(4100, 0, 4100, -2810), '右の壁の側縁も端の斜線の高さ');
  const ceilAt = x => 2400 + x * 0.1;
  for (const p of lines) {
    assert.ok(-p.y1 <= ceilAt(p.x1) + 1e-6 && -p.y2 <= ceilAt(p.x2) + 1e-6,
      `太線 (${p.x1},${-p.y1})-(${p.x2},${-p.y2}) が天井の斜線より上に出ている`);
  }
});

test('【斜線の高い側に届かない壁は低い側で水平に打ち切る】壁の高さが天井の斜線の途中なら ceilEdge を付けない', () => {
  const { cut, probeCtx } = slopeFixture('2412');
  const cutL = buildColumns(cut, probeCtx)[1];
  const wallL = cutL.bands.find(b => b.kind === 'cut');
  near(wallL.z1, 2410, '壁(2412)は斜線の高い側(2415.75)に届かない＝列の低い側(2410)で水平に打ち切る');
  assert.equal(wallL.ceilEdge, undefined);
});

test('【ceilEdge が違う列は結合しない】同じ ceilZ・同じ bands でも列の ceilEdge／帯の ceilEdge が違えば別の列のまま', () => {
  const band = { kind: 'cut', z0: 0, z1: 2410 };
  const col = (x0, x1, extra = {}, bandExtra = {}) =>
    ({ x0, x1, worldLo: x0, worldHi: x1, ceilZ: 2400, bands: [{ ...band, ...bandExtra }], ...extra });
  const edgeA = { zAtX0: 2400, zAtX1: 2410 }, edgeB = { zAtX0: 2410, zAtX1: 2420 };
  assert.equal(mergeColumns([col(0, 100, { ceilEdge: edgeA }), col(100, 200, { ceilEdge: edgeB })]).length, 2, '列の傾きが違う');
  assert.equal(mergeColumns([col(0, 100), col(100, 200, { ceilEdge: edgeA })]).length, 2, '平面の列と傾いた列');
  assert.equal(mergeColumns([col(0, 100, {}, { ceilEdge: edgeA }), col(100, 200, {}, { ceilEdge: edgeB })]).length, 2, '帯の ceilEdge が違う');
  assert.equal(mergeColumns([col(0, 100, { ceilEdge: edgeA }), col(100, 200, { ceilEdge: edgeA })]).length, 1, '全く同じなら従来どおり統合');
});

test('【失敗系・傾斜の ceilProfile】ceilZHi が ceilZ と同値・非有限なら平面と同じ（ceilEdge なし・列と出力が従来と同一）', () => {
  const flat = slopeFixture('3000', [{ loX: 0, hiX: 4200, ceilZ: 2400 }]);
  const baseCols = buildColumns(flat.cut, flat.probeCtx);
  const baseContent = buildSectionFigure(flat.cut, flat.probeCtx).content;
  for (const hi of [2400, NaN, Infinity, undefined]) {
    const f = { cut: { ...flat.cut, ceilProfile: [{ loX: 0, hiX: 4200, ceilZ: 2400, ceilZHi: hi }] }, probeCtx: flat.probeCtx };
    const cols = buildColumns(f.cut, f.probeCtx);
    assert.deepEqual(cols, baseCols, `ceilZHi=${hi}: 列が平面と同一`);
    assert.ok(cols.every(c => c.ceilEdge === undefined && c.bands.every(b => b.ceilEdge === undefined)), `ceilZHi=${hi}: ceilEdge なし`);
    assert.deepEqual(buildSectionFigure(f.cut, f.probeCtx).content, baseContent, `ceilZHi=${hi}: 出力が平面と同一`);
  }
});

test('【傾斜・通り芯で割れた内壁】共有CLの2室＋急勾配: 割れた両方の列の切断帯に ceilEdge が付き exposedSide は付かず、どの線も斜線より上に出ない', () => {
  const graph = makeGraph();
  const cl = (t, v) => graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const xa = cl(CenterLineType.VERTICAL, 0), xm = cl(CenterLineType.VERTICAL, 2000), xb = cl(CenterLineType.VERTICAL, 4000);
  const ya = cl(CenterLineType.HORIZONTAL, 0), yb = cl(CenterLineType.HORIZONTAL, 3000);
  for (const [l, r, n] of [[xa, xm, 'A'], [xm, xb, 'B']]) {
    const room = graph.addRoom(new Set([`${l.id}:${ya.id}:${r.id}:${yb.id}`]), n);
    generateRoomWallsFromOutline(graph, room);
    room.setOverride('ceilingHeight', '4400');
  }
  // 天井 2400→4400（1mmあたり0.5）。内壁(x=2000±57.5)は共有CLで 1942.5..2000 / 2000..2057.5 の2列に割れる。
  const cut = {
    seqNo: 'split', line: { isVertical: false, axisValue: 1500, lo: 0, hi: 4000 }, viewSign: 1, dirSign: 1,
    layers: [{ graph, floorZMm: 0, role: 'self' }], zRange: { loZ: 0, hiZ: 4400 }, baseFloorZ: 0,
    ceilProfile: [{ loX: 0, hiX: 4000, ceilZ: 2400, ceilZHi: 4400 }],
  };
  const probeCtx = makeProbeContext(cut.layers);
  const cols = buildColumns(cut, probeCtx);
  const cutCols = cols.filter(c => c.bands.some(b => b.kind === 'cut'));
  assert.equal(cutCols.length, 4, '外壁2枚と、内壁が共有CLで割れた2列');
  for (const c of cutCols) {
    const b = c.bands.find(x => x.kind === 'cut');
    assert.ok(b.ceilEdge, `列 ${c.x0}..${c.x1} の切断帯に ceilEdge が付く`);
    assert.equal(b.exposedSide, undefined, `列 ${c.x0}..${c.x1} に exposedSide は付かない`);
  }
  const innerLo = cols.find(c => c.x0 === 1942.5), innerHi = cols.find(c => c.x0 === 2000);
  near(innerLo.bands[0].z1, 3400); near(innerHi.bands[0].z1, 3428.75, '割れた後半の列の上端は後半の高い側');
  const ceilAt = x => 2400 + x * 0.5;
  for (const p of buildSectionFigure(cut, probeCtx).content.filter(q => q.type === 'line')) {
    assert.ok(-p.y1 <= ceilAt(p.x1) + 1e-6 && -p.y2 <= ceilAt(p.x2) + 1e-6,
      `線 (${p.x1},${-p.y1})-(${p.x2},${-p.y2}) が天井の斜線より上に出ている（${p.weight}）`);
  }
});
