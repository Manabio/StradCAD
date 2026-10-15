// 開放スパン（面の平面に壁が無い抜け）の2規則（ユーザー裁定2026-10-14「ホール C」）:
//   S1: 抜けの先が階段室（Room.feature===STAIR）ならアキではない＝バツも「ア キ」も標記しない（farStair）。
//   S2: 開放スパンの中に、面に端を接して奥へ延びる直交壁（隔て板）が見えるなら、両面の縦線を中線で描く。
// フィクスチャ: ホール(x0..4000, y0..4000)の南辺 y=4000 の面を、室内側（y=3930）の切断線で見る。
// 南辺に壁は無く、向こう（y4000..8000）は部屋 FAR。隔て板は x=2000 の直交壁（y4000.. へ延びる）。
//   S4: 階段室の開口は最初の壁まで見通し（800 の深度上限を掛けない）、開口越しに階段の見えがかりを描く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline, RoomFeature, StairType } from '@core';
import { buildBandLayers } from './sectionBandLayers.js';
import { buildSectionFromLine } from './sectionContent.js';
import { emitOpenSpanEdgeOnWalls } from './sectionEmit.js';
import { makeProbeContext } from './sectionProbe.js';
import { stairContribution } from './sectionStair.js';
import { generateStairUnderReturnWalls } from '../../finish/stair/stairPartitionWalls.js';
import { TRADITIONAL_WOOD_STRUCTURE } from '../../structural/structureRules.js';
import { ElevationLineRole, weightForRole } from '../elevationStyle.js';

const CH = 2400;
const OFFSET = 70; // 切断線は面の軸CL(y=4000)から室内側へ下がっている

function makeScene({ farFeature = null, partition = null, frontWall = false, farLayout = null, faceWallTo = null, thinAt = null, farWallYs = [] } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  const cl = (t, v) => graph.centerLines.find(c => c.centerLineType === t && c.value === v)
    ?? graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const V = v => cl(CenterLineType.VERTICAL, v), H = v => cl(CenterLineType.HORIZONTAL, v);
  const rect = (x0, y0, x1, y1) => new Set([`${V(x0).id}:${H(y0).id}:${V(x1).id}:${H(y1).id}`]);
  graph.addRoom(rect(0, 0, 4000, 4000), 'ホール');
  // farLayout: [[x0, x1, feature|null], ...]＝向こう側を複数の部屋に分ける（隙間は部屋なし）。省略は全幅1室。
  for (const [x0, x1, feature] of farLayout ?? [[0, 4000, farFeature]]) {
    const room = graph.addRoom(rect(x0, 4000, x1, 8000), x0 === 0 && x1 === 4000 ? '向こう' : `向こう${x0}`);
    if (feature) room.setFeature(feature);
  }
  const walls = [];
  if (faceWallTo != null) {
    // 面自身の壁（面の線上。x0..faceWallTo）。その先が開放スパン。
    graph.addWall(H(4000), 0, false, V(0), 0, V(faceWallTo), 0, { isRoomWall: false, backingDepth: 100, backingOffset: 0, wallFinish: 0 });
  }
  if (thinAt != null) {
    // 開口の脇に立つ薄い直交壁（仕上げ12.5のみ。面の仕上げ面から奥へ）＝面の壁の端壁。
    walls.push(graph.addWall(V(thinAt), 12.5, true, H(4000), -57.5, H(8000), 0, { backingDepth: 0, wallFinish: 12.5 }));
  }
  if (partition) {
    // 隔て板＝同じ軸CL(x=2000)の下地壁＋仕上げ薄壁。start は面の軸CLからの食い込み量（既定 -57.5＝面の仕上げ面）。
    const { startCL = 4000, startOffset = -57.5 } = partition;
    walls.push(
      graph.addWall(V(2000), 0, true, H(startCL), startOffset, H(8000), 0, { backingDepth: 100, backingOffset: 0, wallFinish: 0 }),
      graph.addWall(V(2000), -56.25, true, H(startCL), startOffset, H(8000), 0, { backingDepth: 0, wallFinish: 12.5 }),
    );
  }
  if (frontWall) {
    // 面の手前に立つ見えがかりの壁（x1500..2500 に水平。隔て板の両面より広い）。
    graph.addWall(H(4000), 0, false, V(1500), 0, V(2500), 0, { isRoomWall: false, backingDepth: 100, backingOffset: 0, wallFinish: 0 });
  }
  // 向こう側の部屋の中に立つ全幅の水平壁（farWallYs の各 y）。
  const farWalls = farWallYs.map(y => graph.addWall(H(y), 0, false, V(0), 0, V(4000), 0, { isRoomWall: false, backingDepth: 100, backingOffset: 0, wallFinish: 0 }));
  return { graph, walls, farWalls };
}

function buildHallFaceC(graph) {
  const line = { isVertical: false, axisValue: 4000 - OFFSET, lo: 0, hi: 4000 };
  return buildSectionFromLine(line, buildBandLayers(graph), {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
    face: { axisCL: { effectiveValue: 4000 } },
    ends: { openLo: false, openHi: false, wallLessLo: false, wallLessHi: false },
  });
}

const medium = weightForRole(ElevationLineRole.SILHOUETTE);
const isVertLine = p => p.type === 'line' && p.x1 === p.x2 && p.weight === medium;
const yRange = p => [p.y1, p.y2].map(v => v + 0).sort((a, b) => a - b); // -0 を 0 に正規化

// ---- S1 ----
test('【S1】抜けの先が階段室（feature===STAIR）: open 帯に farStair が付き、バツも「ア キ」も出ない', () => {
  const { graph } = makeScene({ farFeature: RoomFeature.STAIR });
  const { columns, gapMarks, content } = buildHallFaceC(graph);
  const opens = columns.flatMap(c => c.bands).filter(b => b.kind === 'open');
  assert.ok(opens.length > 0 && opens.every(b => b.farStair === true), 'open 帯は全て farStair');
  assert.deepEqual(gapMarks, []);
  assert.equal(content.some(p => p.type === 'text'), false, '「ア キ」なし');
  assert.equal(content.some(p => p.dash === 'center'), false, 'バツ（一点鎖線）なし');
});

test('【失敗系・S1】抜けの先が普通の部屋: farStair は付かず、バツと「ア キ」は従来どおり出る', () => {
  const { graph } = makeScene();
  const { columns, gapMarks } = buildHallFaceC(graph);
  assert.equal(columns.flatMap(c => c.bands).some(b => b.farStair), false);
  assert.equal(gapMarks.filter(p => p.type === 'text' && p.text === 'ア キ').length, 1);
  assert.equal(gapMarks.filter(p => p.dash === 'center').length, 2);
});

test('【失敗系・S1】部屋名は見ない: 名前が「階段」でも feature が無ければアキのまま／feature があれば名前が何でも標記しない', () => {
  const named = makeScene();
  [...named.graph.rooms.values()].find(r => r.name === '向こう').name = '階段';
  assert.equal(buildHallFaceC(named.graph).gapMarks.some(p => p.type === 'text'), true);
  const featured = makeScene({ farFeature: RoomFeature.STAIR });
  [...featured.graph.rooms.values()].find(r => r.name === '向こう').name = 'ホールB';
  assert.equal(buildHallFaceC(featured.graph).gapMarks.length, 0);
});

test('【失敗系・S1】face が無い切断（手組み・階段帯）は向こう側を引けず従来どおり標記する', () => {
  const { graph } = makeScene({ farFeature: RoomFeature.STAIR });
  const line = { isVertical: false, axisValue: 4000 - OFFSET, lo: 0, hi: 4000 };
  const { gapMarks } = buildSectionFromLine(line, buildBandLayers(graph), {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
  });
  assert.equal(gapMarks.some(p => p.type === 'text'), true);
});

// ---- S2 ----
const lineXs = prims => prims.filter(isVertLine).map(p => p.x1).sort((a, b) => a - b);

test('【S2】面に端を接する隔て板（下地壁＋薄壁）: 両面（外面2本）の縦線を中線で z0..CH に描く（4本ではない）', () => {
  const { graph, walls } = makeScene({ partition: {} });
  const lo = Math.min(...walls.map(w => w.materialRange.lo)), hi = Math.max(...walls.map(w => w.materialRange.hi));
  assert.ok(hi - lo > 100, `前提: 下地壁と薄壁で材の範囲が広がる（${lo}..${hi}）`);
  const { content } = buildHallFaceC(graph);
  const edges = content.filter(isVertLine);
  assert.deepEqual(lineXs(content), [lo, hi], '2本だけ（組の最小〜最大の外面）');
  for (const p of edges) assert.deepEqual(yRange(p), [-CH, 0]);
});

test('【失敗系・S2】隔て板が無い: 縦線は出ない', () => {
  const { graph } = makeScene();
  assert.deepEqual(lineXs(buildHallFaceC(graph).content), []);
});

test('【失敗系・S2】隔て板が面の線に届かない（300mm 奥から始まる）: 縦線は出ない', () => {
  const { graph } = makeScene({ partition: { startOffset: 300 } });
  assert.deepEqual(lineXs(buildHallFaceC(graph).content), []);
});

test('【失敗系・S2】面の手前に壁の帯がある位置は open でない: その位置の縦線は出ない', () => {
  const { graph, walls } = makeScene({ partition: {}, frontWall: true });
  const xs = lineXs(buildHallFaceC(graph).content);
  // 手前の壁自身の凹み側面線（1500・2500）は出るが、隔て板の外面（材の範囲の両端）は出ない。
  for (const x of [Math.min(...walls.map(w => w.materialRange.lo)), Math.max(...walls.map(w => w.materialRange.hi))]) {
    assert.equal(xs.includes(x), false, `x=${x} の縦線は出ない`);
  }
  assert.deepEqual(xs, [1500, 2500], '前提: 手前の壁の側面線は出ている');
});

test('【失敗系・S2】切断線を横切る壁（手前の室内側へ延びる壁）の組は対象外（切断壁として別経路）', () => {
  const { graph } = makeScene({ partition: { startCL: 0, startOffset: 0 } }); // y0..8000: 面を貫く壁
  assert.deepEqual(lineXs(buildHallFaceC(graph).content), []);
});

test('【S2】階段帯（cut.stairCut あり）では呼ばれない: 同じ構成で stairCut を載せると縦線が出ない', () => {
  const { graph } = makeScene({ partition: {} });
  const line = { isVertical: false, axisValue: 4000 - OFFSET, lo: 0, hi: 4000 };
  const run = stairCut => buildSectionFromLine(line, buildBandLayers(graph), {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH }, stairCut,
    face: { axisCL: { effectiveValue: 4000 } },
    ends: { openLo: false, openHi: false, wallLessLo: false, wallLessHi: false },
  }).content;
  assert.equal(lineXs(run(null)).length, 2, '前提: stairCut なしなら出る');
  assert.deepEqual(lineXs(run({ type: 'dummy' })), []);
});

test('【S2】emitOpenSpanEdgeOnWalls: wallZRangesOf が壁の高さを決める（壁が 1500 までなら縦線は 0..1500、壁の高さの外には引かない）', () => {
  const { graph } = makeScene({ partition: {} });
  const { cut, columns } = buildHallFaceC(graph);
  const prims = emitOpenSpanEdgeOnWalls(columns, cut, () => [{ z0: 0, z1: 1500 }], CH);
  assert.equal(prims.length, 2);
  for (const p of prims) assert.deepEqual(yRange(p), [-1500, 0]);
  assert.deepEqual(emitOpenSpanEdgeOnWalls(columns, cut, () => [], CH), [], '壁の高さが空なら何も引かない');
  assert.deepEqual(emitOpenSpanEdgeOnWalls(columns, cut, () => [{ z0: 2400, z1: 3000 }], CH), [], 'open 帯の外の高さには引かない');
});

test('【失敗系・S2】面の壁の途切れ目（開口の脇）に立つ薄い直交壁＝面の壁の端壁は対象外: 縦線を引かない', () => {
  const { graph, walls } = makeScene({ faceWallTo: 1000, thinAt: 1000 });
  const mr = walls[0].materialRange;
  assert.ok(mr.hi - mr.lo < 20, `前提: 薄壁（${mr.lo}..${mr.hi}）`);
  const { cut } = buildHallFaceC(graph);
  // 列は手組み: 面の壁(0..1000)の端のすぐ先（1000..）が開口。薄壁(1000..1012.5)は開口側の列に立つ。
  const columns = [
    { x0: 0, x1: 1000, worldLo: 0, worldHi: 1000, bands: [{ kind: 'wall', z0: 0, z1: CH }] },
    { x0: 1000, x1: 4000, worldLo: 1000, worldHi: 4000, bands: [{ kind: 'open', z0: 0, z1: CH }] },
  ];
  assert.deepEqual([mr.lo, mr.hi], [1000, 1012.5]);
  assert.deepEqual(emitOpenSpanEdgeOnWalls(columns, cut, null, CH), [], '端壁の面（開口の脇）には縦線を引かない');
});

// ---- S1 の伝播（向こう側に部屋が無い隙間列） ----
const STAIR = RoomFeature.STAIR;
const farFlags = columns => columns.map(c => [c.x0, c.bands.filter(b => b.kind === 'open').map(b => !!b.farStair)]);

test('【S1】向こう側に部屋が無い隙間の列（階段室の脇）は、階段室とつながる空気なので farStair を引き継ぎ、単独のアキ標記を出さない', () => {
  const { graph } = makeScene({ farLayout: [[1000, 4000, STAIR]] });
  const { columns, gapMarks } = buildHallFaceC(graph);
  const opens = columns.flatMap(c => c.bands).filter(b => b.kind === 'open');
  // 伝播すると同じ内容の隣接列は1列に併合される（伝播しないなら 0..1000 と 1000..4000 の2列で後者だけタグ）。
  assert.ok(opens.length >= 1 && opens.every(b => b.farStair === true), `全 open 帯が farStair: ${JSON.stringify(farFlags(columns))}`);
  assert.deepEqual(gapMarks, []);
});

test('【失敗系・S1】隙間の向こう側が普通の部屋なら伝播しない: その列だけバツと「ア キ」が残り、階段室の列は出ない', () => {
  const { graph } = makeScene({ farLayout: [[0, 1000, null], [1000, 4000, STAIR]] });
  const { columns, gapMarks } = buildHallFaceC(graph);
  const first = columns[0];
  assert.ok(first.x1 <= 1000 + 1e-6 && first.bands.some(b => b.kind === 'open' && !b.farStair), '前提: x0..1000 は普通の部屋の向こう＝未タグ');
  assert.equal(gapMarks.filter(p => p.type === 'text').length, 1, '「ア キ」は普通の部屋の列の1つだけ');
  const t = gapMarks.find(p => p.type === 'text');
  assert.ok(t.x <= 1000, `文字は x0..1000 の列: ${t.x}`);
});

test('【失敗系・S1】階段室とつながらない隙間（向こう側に部屋なし・隣も階段室でない）は従来どおりアキ', () => {
  const { graph } = makeScene({ farLayout: [[1000, 4000, null]] });
  const { columns, gapMarks } = buildHallFaceC(graph);
  assert.equal(columns.flatMap(c => c.bands).some(b => b.farStair), false);
  assert.equal(gapMarks.some(p => p.type === 'text'), true);
});

// ---- S4: 階段室の開口越しに見通す（ユーザー指示2026-10-14「ホール C」） ----
const thin = weightForRole(ElevationLineRole.DETAIL);
const HALL_BOUNDS = { x1: 0, y1: 0, x2: 4000, y2: 4000 }; // 帯の部屋＝ホールの包絡矩形（向こうの階段室は含まない）
// 壁の天端プロファイルの差し替え（wallTopProfileFor は壁 id → {zAt, crossings, junction?} の Map を返す）。
const withWallTops = (probeCtx, byWall) => ({
  ...probeCtx,
  wallTopProfileFor: () => ({ get: id => byWall.get(id) ?? undefined }),
});

function buildHallS4(graph, { wallTops = null, bandRoomBounds = HALL_BOUNDS, baseboardMm = 0 } = {}) {
  const line = { isVertical: false, axisValue: 4000 - OFFSET, lo: 0, hi: 4000 };
  const layers = buildBandLayers(graph);
  const base = makeProbeContext(layers);
  return buildSectionFromLine(line, layers, {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
    face: { axisCL: { effectiveValue: 4000 } },
    ends: { openLo: false, openHi: false, wallLessLo: false, wallLessHi: false },
    bandRoomBounds, probeCtx: wallTops ? withWallTops(base, wallTops) : base, baseboardMm,
  });
}
const wallBandsOf = columns => columns.flatMap(c => c.bands).filter(b => b.kind === 'wall');

// 復路下の壁相当（天端が階段の裏面との取り合い＝junction）の天端プロファイル。
const underReturnTop = (z = CH) => ({ zAt: () => z, crossings: () => [], junction: true });
const topsOf = (walls, make = underReturnTop) => new Map(walls.map(w => [w.id, make()]));

test('【S4】抜けの先が階段室: 部屋の外・奥行き上限（800）の先でも、復路下の壁（junction）を壁の帯（viaStair）として見通す', () => {
  // x0..1000 は面の壁（距離 70＝上限の基準）。x1000.. は開放スパンで、y=5000 の壁は距離 1070（基準から 1000 ≧ 800）。
  const { graph, farWalls } = makeScene({ farFeature: RoomFeature.STAIR, faceWallTo: 1000, farWallYs: [5000] });
  const far = wallBandsOf(buildHallS4(graph, { wallTops: topsOf(farWalls) }).columns).filter(b => b.viaStair);
  assert.ok(far.length > 0, '向こうの壁が壁の帯になる');
  assert.ok(far.every(b => b.z0 === 0 && b.z1 === CH && Math.abs(b.distMm - 1070) < 1e-6), JSON.stringify(far.map(b => [b.z0, b.z1, b.distMm])));
});

test('【失敗系・S4】抜けの先が普通の部屋: 同じ壁・同じ天端プロファイルでも従来どおり見通さずアキのまま', () => {
  const { graph, farWalls } = makeScene({ farFeature: null, faceWallTo: 1000, farWallYs: [5000] });
  const { columns } = buildHallS4(graph, { wallTops: topsOf(farWalls) });
  assert.equal(columns.flatMap(c => c.bands).some(b => b.viaStair), false);
  assert.equal(wallBandsOf(columns).some(b => b.distMm > 1000), false, '奥の壁は壁の帯にならない');
});

test('【失敗系・S4】階段室でも、天端が取り合い（junction）でない壁（階段の向こうの壁等）は従来どおり見通さない', () => {
  const { graph, farWalls } = makeScene({ farFeature: RoomFeature.STAIR, faceWallTo: 1000, farWallYs: [5000] });
  const plain = buildHallS4(graph).columns; // プロファイル無し（全高の壁）
  const slope = buildHallS4(graph, { wallTops: topsOf(farWalls, () => ({ zAt: () => 1500, crossings: () => [] })) }).columns; // 斜め天端等
  for (const columns of [plain, slope]) {
    assert.equal(columns.flatMap(c => c.bands).some(b => b.viaStair), false);
    assert.equal(wallBandsOf(columns).some(b => b.distMm > 1000), false);
  }
});

test('【失敗系・S4】階段室でも面の手前（ホール側）の壁は viaStair にしない: 面の壁は従来どおりの壁の帯', () => {
  const { graph } = makeScene({ farFeature: RoomFeature.STAIR, faceWallTo: 1000 });
  const bands = wallBandsOf(buildHallS4(graph).columns);
  assert.ok(bands.length > 0 && bands.every(b => !b.viaStair));
});

test('【S4】最初の壁だけ残す: 天端が低い手前の壁の上は、奥の壁（距離 3070・同じく junction）が見えずアキ', () => {
  const { graph, farWalls } = makeScene({ farFeature: RoomFeature.STAIR, faceWallTo: 1000, farWallYs: [5000, 7000] });
  const tops = new Map([[farWalls[0].id, underReturnTop(1500)], [farWalls[1].id, underReturnTop(CH)]]);
  const col = buildHallS4(graph, { wallTops: tops }).columns.find(c => c.x0 <= 2500 && c.x1 >= 2500);
  const bands = col.bands.filter(b => b.kind === 'wall' || b.kind === 'open');
  assert.deepEqual(bands.map(b => [b.kind, b.z0, b.z1]), [['wall', 0, 1500], ['open', 1500, CH]]);
  assert.equal(bands[0].viaStair, true);
  assert.equal(bands[1].farStair, true, '上は階段室へ続くアキ（奥の壁は帯にしない）');
});

test('【S4】取り合いの天端（junction）の線は細線: 直近の壁でも中線にしない。junction の無い天端プロファイルは中線のまま', () => {
  const run = junction => {
    const { graph } = makeScene({ faceWallTo: 4000 });
    const tops = { get: () => ({ zAt: () => 1500, crossings: () => [], ...(junction ? { junction: true } : {}) }) };
    return buildHallS4(graph, { wallTops: tops }).content
      .filter(p => p.type === 'line' && p.y1 === p.y2 && p.y1 === -1500);
  };
  const withJunction = run(true), without = run(false);
  assert.equal(withJunction.length, 1);
  assert.equal(withJunction[0].weight, thin, 'junction あり: 細線');
  assert.equal(without.length, 1);
  assert.equal(without[0].weight, medium, 'junction なし（隔て壁の斜め天端等）: 直近の壁の天端は中線');
});

test('【S4】隔て板の端面の背後（両面の間）には階段室の壁の天端線を引かない。両面の中線は従来どおり', () => {
  const { graph, walls, farWalls } = makeScene({ farFeature: STAIR, partition: {}, faceWallTo: 1000, farWallYs: [5000] });
  const lo = Math.min(...walls.map(w => w.materialRange.lo)), hi = Math.max(...walls.map(w => w.materialRange.hi));
  const tops = new Map([[farWalls[0].id, { zAt: () => 1500, crossings: () => [], junction: true }]]);
  const { content } = buildHallS4(graph, { wallTops: tops });
  const xs = lineXs(content);
  assert.ok(xs.includes(lo) && xs.includes(hi), `両面の縦線は従来どおり: ${JSON.stringify(xs)}`);
  for (const p of content.filter(q => isVertLine(q) && (q.x1 === lo || q.x1 === hi))) assert.deepEqual(yRange(p), [-CH, 0], '両面は z0..CH');
  const tops1500 = content.filter(p => p.type === 'line' && p.y1 === p.y2 && p.y1 === -1500 && p.weight === thin);
  assert.ok(tops1500.length >= 2, `天端線は端面で分かれる: ${JSON.stringify(tops1500)}`);
  for (const p of tops1500) {
    const [a, b] = [p.x1, p.x2].sort((m, n) => m - n);
    assert.ok(b <= lo + 1e-6 || a >= hi - 1e-6, `端面（${lo}..${hi}）の内側に線が無い: ${a}..${b}`);
  }
});

// ---- 巾木（ユーザー指示 2026-10-15「階段下スペースは『ホール』なので巾木が見える」「X2+910に立つ壁小口にも巾木が見える」）----
// 帯の部屋（ホール）の巾木高さ baseboardMm を、階段室越しの壁（viaStair）の足元と、その手前に見える隔て板の小口の足元へ細線で引く。
const baseboardAt = (content, z) => content.filter(p => p.type === 'line' && p.y1 === p.y2 && Math.abs(p.y1 + z) < 1e-6 && p.weight === thin);
// 水平線の x 区間の和（隙間なく覆う区間へ併合）
const coveredRanges = lines => lines.map(p => [Math.min(p.x1, p.x2), Math.max(p.x1, p.x2)]).sort((a, b) => a[0] - b[0])
  .reduce((acc, r) => { const l = acc[acc.length - 1]; if (l && r[0] <= l[1] + 1e-6) l[1] = Math.max(l[1], r[1]); else acc.push([...r]); return acc; }, []);

test('【巾木】階段室越しの壁（viaStair）: 足元から巾木の高さに細線を壁の帯の全幅に引く', () => {
  const { graph, farWalls } = makeScene({ farFeature: STAIR, farWallYs: [5000] });
  const { content, columns } = buildHallS4(graph, { wallTops: topsOf(farWalls), baseboardMm: 60 });
  assert.ok(wallBandsOf(columns).some(b => b.viaStair), '前提: viaStair の壁の帯がある');
  assert.deepEqual(coveredRanges(baseboardAt(content, 60)), [[0, 4000]]);
});

test('【失敗系・巾木】巾木が無い（0）・天端より高い・viaStair でない壁は引かない', () => {
  const scene = makeScene({ farFeature: STAIR, farWallYs: [5000] });
  const tops = topsOf(scene.farWalls);
  assert.equal(baseboardAt(buildHallS4(scene.graph, { wallTops: tops, baseboardMm: 0 }).content, 60).length, 0, '巾木なし（0）');
  assert.equal(baseboardAt(buildHallS4(scene.graph, { wallTops: tops, baseboardMm: CH }).content, CH).length, 0, '天端以上の高さ');
  // 階段室でない向こう側の壁（普通の部屋）は viaStair にならない＝巾木も無い
  const plain = makeScene({ farWallYs: [5000] });
  assert.equal(baseboardAt(buildHallS4(plain.graph, { wallTops: topsOf(plain.farWalls), baseboardMm: 60 }).content, 60).length, 0);
});

test('【巾木】階段室越しの隔て板の小口: 両面の間（小口の幅）に巾木の細線を引く。背後の壁の巾木は小口の内側で切れる', () => {
  const { graph, walls, farWalls } = makeScene({ farFeature: STAIR, partition: {}, faceWallTo: 1000, farWallYs: [5000] });
  const lo = Math.min(...walls.map(w => w.materialRange.lo)), hi = Math.max(...walls.map(w => w.materialRange.hi));
  const { content } = buildHallS4(graph, { wallTops: topsOf(farWalls), baseboardMm: 60 });
  const koguchi = baseboardAt(content, 60).filter(p => Math.abs(Math.min(p.x1, p.x2) - lo) < 1e-6 && Math.abs(Math.max(p.x1, p.x2) - hi) < 1e-6);
  assert.equal(koguchi.length, 1, `小口の巾木は 1 本（${lo}..${hi}）`);
  // 背後の壁の巾木は小口の厳密内部には残らない（小口の巾木 1 本だけ）
  const inside = baseboardAt(content, 60).filter(p => !koguchi.includes(p)
    && Math.max(p.x1, p.x2) > lo + 1e-6 && Math.min(p.x1, p.x2) < hi - 1e-6);
  assert.deepEqual(inside, []);
});

test('【失敗系・巾木】隔て板の小口: 巾木なし（0）・背後が階段室の壁でない（viaStair 無し）なら引かない', () => {
  const noBoard = makeScene({ farFeature: STAIR, partition: {}, faceWallTo: 1000, farWallYs: [5000] });
  const lo = Math.min(...noBoard.walls.map(w => w.materialRange.lo)), hi = Math.max(...noBoard.walls.map(w => w.materialRange.hi));
  const spanOf = content => baseboardAt(content, 60).filter(p => Math.abs(Math.min(p.x1, p.x2) - lo) < 1e-6 && Math.abs(Math.max(p.x1, p.x2) - hi) < 1e-6);
  assert.equal(spanOf(buildHallS4(noBoard.graph, { wallTops: topsOf(noBoard.farWalls), baseboardMm: 0 }).content).length, 0, '巾木なし');
  // 階段室の先に壁が無い（viaStair の帯が無い）隔て板の小口: 従来どおり縦線だけ
  const noFarWall = makeScene({ farFeature: STAIR, partition: {}, faceWallTo: 1000 });
  const { content, columns } = buildHallS4(noFarWall.graph, { baseboardMm: 60 });
  assert.equal(wallBandsOf(columns).some(b => b.viaStair), false, '前提: viaStair の壁が無い');
  assert.ok(lineXs(content).includes(lo), '前提: 小口の縦線は出ている');
  assert.equal(spanOf(content).length, 0);
});

// 実物の回り階段（WINDING・木造）。ホールは y4000..7000、階段室は y0..4000（EQUAL_UP の配置）。ホール面 y=4000 から -y 向きに見る。
// 往路 x0..1000 は視点から遠ざかって上り、復路下の壁（y=1000・x1000..2000）が階段室の最初の壁になる。
function makeStairScene({ feature = RoomFeature.STAIR } = {}) {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const vs = new Map(), hs = new Map();
  const V = v => vs.get(v) ?? vs.set(v, graph.addCenterLine(CenterLineType.VERTICAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const H = v => hs.get(v) ?? hs.set(v, graph.addCenterLine(CenterLineType.HORIZONTAL, v, { labeled: false, discipline: Discipline.ARCH })).get(v);
  const key = ([x1, y1, x2, y2]) => `${V(x1).id}:${H(y1).id}:${V(x2).id}:${H(y2).id}`;
  graph.addRoom(new Set([key([0, 4000, 2000, 7000])]), 'ホール');
  const cells = new Set([[0, 0, 2000, 1000], [0, 1000, 1000, 4000], [1000, 1000, 2000, 4000]].map(key));
  const room = graph.addRoom(new Set(cells), '階段');
  if (feature) room.setFeature(feature);
  const stair = graph.addStair({ type: StairType.WINDING, cells, roomId: room.id, sections: [6, 3, 6], flip: false, upDirection: 'up' });
  const walls = generateStairUnderReturnWalls(graph, { structure: TRADITIONAL_WOOD_STRUCTURE });
  return { graph, stair, walls };
}
function buildStairHall(graph) {
  const line = { isVertical: false, axisValue: 4000 + OFFSET, lo: 0, hi: 2000 };
  const layers = buildBandLayers(graph);
  return buildSectionFromLine(line, layers, {
    viewSign: -1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
    face: { axisCL: { effectiveValue: 4000 } },
    ends: { openLo: false, openHi: false, wallLessLo: false, wallLessHi: false },
    bandRoomBounds: { x1: 0, y1: 4000, x2: 2000, y2: 7000 },
    probeCtx: makeProbeContext(layers, { floorHeightMm: CH }),
  });
}
const horizontalsAt = (content, z) => content.filter(p => p.type === 'line' && p.y1 === p.y2 && Math.abs(p.y1 + z) < 1e-6 && p.weight === thin);

test('【S4】階段室の開口越し: 往路の段鼻（段板の幅）と、復路下の壁が最初の壁（天端は裏面との取り合いの細線）', () => {
  const { graph, stair } = makeStairScene();
  const { columns, content } = buildStairHall(graph);
  const f = stairContribution(stair, graph, CH).flights[0];
  assert.equal(f.travelSign * -1 > 0, true, '前提: 往路は視点から遠ざかって上る');
  for (let k = 0; k < f.steps; k++) {
    const z = f.baseZ + (k + 1) * f.riserMm;
    const hit = horizontalsAt(content, z).find(p => Math.abs(Math.min(p.x1, p.x2) - (f.treadAcrossLo ?? f.acrossLo)) < 1e-6
      && Math.abs(Math.max(p.x1, p.x2) - (f.treadAcrossHi ?? f.acrossHi)) < 1e-6);
    assert.ok(hit, `段鼻 z=${z}`);
  }
  const under = wallBandsOf(columns).filter(b => b.viaStair);
  assert.ok(under.length > 0 && under.every(b => b.profiledTop && b.junctionTop && b.z1 > 0 && b.z1 < CH - 1), JSON.stringify(under.map(b => [b.z1, b.junctionTop])));
  const top = under[0].z1;
  assert.equal(horizontalsAt(content, top).length >= 1, true, '壁の天端の線は細線');
  assert.equal(content.some(p => p.type === 'line' && p.y1 === p.y2 && Math.abs(p.y1 + top) < 1e-6 && p.weight === medium), false, '天端に中線は無い');
});

test('【失敗系・S4】抜けの先が階段室でない: 階段の見えがかりも壁の帯も出ない', () => {
  const { graph, stair } = makeStairScene({ feature: null });
  const { columns, content } = buildStairHall(graph);
  const f = stairContribution(stair, graph, CH).flights[0];
  assert.equal(columns.flatMap(c => c.bands).some(b => b.viaStair), false);
  assert.equal(horizontalsAt(content, f.baseZ + f.riserMm).length, 0);
});

test('【失敗系・巾木】隔て板の小口: 足元が床に無い端面（垂れ壁など）には巾木を引かない。床に届く端面には引く（対照）', () => {
  const { graph, walls, farWalls } = makeScene({ farFeature: STAIR, partition: {}, faceWallTo: 1000, farWallYs: [5000] });
  const lo = Math.min(...walls.map(w => w.materialRange.lo)), hi = Math.max(...walls.map(w => w.materialRange.hi));
  const { cut, columns } = buildHallS4(graph, { wallTops: topsOf(farWalls) });
  const baseboards = ranges => emitOpenSpanEdgeOnWalls(columns, cut, () => ranges, CH, null, 60)
    .filter(p => p.y1 === p.y2 && Math.abs(Math.min(p.x1, p.x2) - lo) < 1e-6 && Math.abs(Math.max(p.x1, p.x2) - hi) < 1e-6);
  assert.equal(baseboards([{ z0: 0, z1: 1500 }]).length, 1, '対照: 床に届く端面');
  assert.equal(baseboards([{ z0: 1000, z1: 1500 }]).length, 0, '足元が床に無い端面');
});
