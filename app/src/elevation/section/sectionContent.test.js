// 展開図一般化Phase 8: 面非依存の入口`buildSectionFromLine`の単体テスト。
// 帯（部屋帯・吹抜け帯）と階段cut表が共有する薄いラッパ自体を、面を経由せず直接検証する。
// フィクスチャの作法は`sectionCutPlaneExtraction.test.js`の`makeGraph`/`makeRectRoom`に倣う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { generateRoomWallsFromOutline } from '../../finish/wallGeneration.js';
import { roomBounds } from '../../finish/gridCells.js';
import { composeRoomFaces } from '../elevationFaceList.js';
import { buildBandLayers } from './sectionBandLayers.js';
import { buildSectionFromLine } from './sectionContent.js';
import { cutPlaneOffsetMm, faceCutLine, faceViewSign } from './sectionCutPlane.js';
import { wallLessEndAt } from '../elevationFaces.js';

const CH = 2400;

function makeGraph() {
  return new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
}
function makeRectRoom(graph, x0v, y0v, x1v, y1v, name) {
  // 同じ値の通り芯は使い回す（隣接する部屋の境界が別々のCLに載った別の壁にならないよう）。
  const cl = (t, v) => graph.centerLines.find(c => c.centerLineType === t && c.value === v)
    ?? graph.addCenterLine(t, v, { labeled: false, discipline: Discipline.ARCH });
  const x0 = cl(CenterLineType.VERTICAL, x0v), x1 = cl(CenterLineType.VERTICAL, x1v);
  const y0 = cl(CenterLineType.HORIZONTAL, y0v), y1 = cl(CenterLineType.HORIZONTAL, y1v);
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), name);
  generateRoomWallsFromOutline(graph, room);
  return room;
}

test('【Phase 8】buildSectionFromLine: 部屋(4000×6000)の中央を横切る切断は、両端の壁がcut帯として抽出され、ceilProfile省略で天井高まで打ち切られない', () => {
  const g = makeGraph();
  makeRectRoom(g, 0, 0, 4000, 6000, 'LDK');
  const layers = buildBandLayers(g);
  const line = { isVertical: false, axisValue: 3000, lo: 0, hi: 4000 };
  const { columns, content } = buildSectionFromLine(line, layers, {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
  });
  const first = columns[0], last = columns[columns.length - 1];
  assert.equal(first.bands[0].kind, 'cut', '西側の壁(x=0近傍)はcut帯のはず');
  assert.equal(first.bands[0].z1, CH, 'ceilProfileを渡していないので天井高までそのまま(打ち切りなし)のはず');
  assert.equal(last.bands[0].kind, 'cut', '東側の壁(x=4000近傍)もcut帯のはず');
  assert.equal(last.bands[0].z1, CH, '東側もceilProfile省略で打ち切られないはず');
  assert.ok(content.length > 0, '壁の断面プリミティブが出るはず');
});

test('【Phase 8】buildSectionFromLine: 壁で仕切られた2室(x方向に隣接)を貫く切断は、中間の仕切り壁がcut帯として列に現れ、bandRoomBounds未指定でも例外にならない', () => {
  const g = makeGraph();
  makeRectRoom(g, 0, 0, 4000, 4000, 'A');
  makeRectRoom(g, 4000, 0, 8000, 4000, 'B');
  const layers = buildBandLayers(g);
  const line = { isVertical: false, axisValue: 2000, lo: 0, hi: 8000 };
  // bandRoomBoundsを渡さない（省略時はnull＝深度上限のみで見えがかりを絞る。face-lessの既定）。
  const { columns, content } = buildSectionFromLine(line, layers, {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
  });
  const partitionCol = columns.find(c => Math.abs(c.x0 - 4000) < 1);
  assert.ok(partitionCol, '仕切り壁(x=4000)の位置に列があるはず');
  assert.equal(partitionCol.bands[0].kind, 'cut', '仕切り壁はcut帯として抽出されるはず');
  assert.ok(content.length > 0, '両室ぶんの断面プリミティブが出るはず（例外にならない）');
});

test('【失敗系・Phase 8】buildSectionFromLine: layers=[]（候補ゼロ）でも例外を投げず、全域アキの列が1本返る', () => {
  const line = { isVertical: false, axisValue: 0, lo: 0, hi: 4000 };
  const { content, columns } = buildSectionFromLine(line, [], {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH },
  });
  assert.ok(Array.isArray(columns) && columns.length > 0, '列そのものは（空層でも）1本返るはず');
  assert.equal(columns[0].bands[0].kind, 'open', '候補が無い＝床から天井まで全域アキのはず');
  assert.ok(Array.isArray(content), 'contentは常に配列で返る（例外を投げない）');
  assert.ok(content.some(p => p.type === 'text'), '全域アキなのでアキ標記(text)が出るはず');
});

test('【失敗系・Phase 8】buildSectionFromLine: zRangeが退化(loZ===hiZ)でも例外を投げずcontentが空で返る', () => {
  const g = makeGraph();
  makeRectRoom(g, 0, 0, 4000, 4000, 'A');
  const layers = buildBandLayers(g);
  const line = { isVertical: false, axisValue: 2000, lo: 0, hi: 4000 };
  const { content } = buildSectionFromLine(line, layers, {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: 0 },
  });
  assert.deepEqual(content, []);
});

test('【失敗系・Phase 8】buildSectionFromLine: zRange未指定はTypeErrorで即座に失敗する（必須。導出しない）', () => {
  const line = { isVertical: false, axisValue: 0, lo: 0, hi: 4000 };
  assert.throws(() => buildSectionFromLine(line, [], { viewSign: 1, dirSign: 1 }), TypeError);
});

test('【Phase 8】buildSectionFromLine: baseFloorZは省略時のみzRange.loZで、指定時はその値がcutへ載る', () => {
  const line = { isVertical: false, axisValue: 0, lo: 0, hi: 4000 };
  const omitted = buildSectionFromLine(line, [], { viewSign: 1, dirSign: 1, zRange: { loZ: -500, hiZ: 2400 } });
  assert.equal(omitted.cut.baseFloorZ, -500, '省略時はzRange.loZがそのまま載るはず');
  const given = buildSectionFromLine(line, [], {
    viewSign: 1, dirSign: 1, zRange: { loZ: -500, hiZ: 2400 }, baseFloorZ: 0,
  });
  assert.equal(given.cut.baseFloorZ, 0, '指定時はzRange.loZではなくopts.baseFloorZがそのまま載るはず');
});

test('【Phase 8】buildSectionFromLine: endsの導出は1箇所（opts.faceから導出した場合と、同じ内容をopts.endsで直接渡した場合で結果が同一）', () => {
  const g = makeGraph();
  const room = makeRectRoom(g, 0, 0, 4000, 6000, 'LDK');
  const layers = buildBandLayers(g);
  const faceA = composeRoomFaces(room, g).filter(f => f.kind !== 'step').find(f => f.letter === 'A');
  const bandRoomBounds = roomBounds(room.cells, g);
  const line = faceCutLine(faceA, cutPlaneOffsetMm(faceA, layers));
  const zRange = { loZ: 0, hiZ: CH };
  // endExtendMmを与える（0のままだとopenLo/Hiが探査延長の分岐を通らず、ends導出の誤りを検出できない）。
  const common = {
    viewSign: faceViewSign(faceA), dirSign: faceA.dirSign, zRange, bandRoomBounds, endExtendMm: 150,
  };

  const viaFace = buildSectionFromLine(line, layers, { ...common, face: faceA });
  const ends = {
    openLo: faceA.hasWallAtLocal0 === false,
    openHi: faceA.hasWallAtLocalRun === false,
    wallLessLo: wallLessEndAt(faceA, '0'),
    wallLessHi: wallLessEndAt(faceA, 'Run'),
  };
  const viaEnds = buildSectionFromLine(line, layers, { ...common, ends });

  assert.deepEqual(viaFace.content, viaEnds.content,
    'face経由の導出とends直接指定は同じ内容になるはず（導出はbuildSectionFromLine内の1箇所だけ）');
});

test('【Phase 8】buildSectionFromLine: face-lessではupperPlaneOverhang:trueでも層ごとの窓を作らない（正しい縮退）', () => {
  const g1 = makeGraph();
  makeRectRoom(g1, 0, 0, 4000, 6000, 'LDK');
  const g2 = makeGraph();
  makeRectRoom(g2, 0, 0, 4000, 6000, 'LDK2');
  const layers = [
    { graph: g1, floorZMm: 0, role: 'self' },
    { graph: g2, floorZMm: 3000, role: 'above' },
  ];
  const line = { isVertical: false, axisValue: 3000, lo: 0, hi: 4000 };
  const ends = { openLo: false, openHi: false, wallLessLo: false, wallLessHi: false };
  const common = { viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: CH }, ends };
  const withOverhang = buildSectionFromLine(line, layers, { ...common, upperPlaneOverhang: true });
  const without = buildSectionFromLine(line, layers, { ...common, upperPlaneOverhang: false });
  assert.equal(withOverhang.cut.layerRunWindows, undefined,
    'face-lessでは(cut.face必須の)layerRunWindowsOfがnullを返すため、layerRunWindowsは載らないはず');
  assert.deepEqual(withOverhang.content, without.content,
    'upperPlaneOverhangの有無で出力が変わらないはず（face-lessでは正しく縮退する）');
});

// ---- 変異確認用の対照（このテストファイル自体は変異させないが、上記アサーションが
// 実際に効いていることの手掛かりとして、cut帯のz1がCHちょうどであることを明示する） ----
test('【対照】buildSectionFromLine: zRange.hiZを実際の壁高より低く絞ると、cut帯のz1もそこで打ち切られる（アサーションが実値を見ていることの確認）', () => {
  const g = makeGraph();
  makeRectRoom(g, 0, 0, 4000, 6000, 'LDK');
  const layers = buildBandLayers(g);
  const line = { isVertical: false, axisValue: 3000, lo: 0, hi: 4000 };
  const { columns } = buildSectionFromLine(line, layers, {
    viewSign: 1, dirSign: 1, zRange: { loZ: 0, hiZ: 1000 },
  });
  assert.equal(columns[0].bands[0].z1, 1000, 'zRange.hiZ(1000)が実際の壁高(2400)より低いので、そこで打ち切られるはず');
});
