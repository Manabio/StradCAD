// buildFaceFigure の描画内容テスト（.claude/elevation-model.md §11 記載項目）。
// graph/room/opening は buildFaceFigure が実際に読むフィールドのみを持つ最小限のフェイクを使う
// （純関数のロジック検証が目的で、graph実体の生成コストを避ける）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, OpeningCategory, CenterLineType } from '@core';
import { buildFaceFigure, kneeDropGapsOnFace, parseBaseboardHeightMm } from './elevationFigure.js';

function makeFace(overrides = {}) {
  return {
    axisCL: { id: 'axisY0' }, isVertical: false, inward: 1, faceValue: 0,
    lo: 0, hi: 4000, run: 4000, dirSign: 1, originWorld: 0,
    startCLId: 'x0', endCLId: 'x1',
    ...overrides,
  };
}

function makeGraph({ openings = [], kneeDropWalls = new Map(), shapes = new Map() } = {}) {
  return { openings, kneeDropWalls, shapeMap: shapes };
}

function makeRoom(finishInfo = {}, finish = null) {
  return { getFinishInfo: () => finishInfo, finish };
}

function baseCtx(overrides = {}) {
  return {
    graph: makeGraph(), project: { openingNumberIndex: new Map() }, room: makeRoom(),
    ceilingHeight: 2400, materialMap: new Map(), gridCLs: [],
    ...overrides,
  };
}

// ---- CUT本数（床1天井1端2） ----
test('buildFaceFigure: 床線1・天井線1・両端縦線2の計4本のCUT(太)線が出る', () => {
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx());
  const cutLines = prims.filter(p => p.type === 'line' && p.weight === 'thick');
  assert.equal(cutLines.length, 4);
});

// ---- 開口 y=-(sill+h) ----
test('buildFaceFigure: 窓の開口矩形はy=-(sillHeight+height)から始まる', () => {
  const opening = {
    id: 'op1', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 900, height: 1100, sillHeight: 800,
    category: OpeningCategory.WINDOW, subType: 'singleSliding', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 900);
  assert.ok(rect, '開口矩形が見つからない');
  assert.equal(rect.y, -(800 + 1100));
  assert.equal(rect.h, 1100);
});

test('buildFaceFigure: 建具（窓以外）はsill=0扱いでy=-heightから始まる', () => {
  const opening = {
    id: 'op2', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 800, height: 2000, sillHeight: 500, // sillHeightは窓専用のため無視される
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ openings: [opening] }) });
  const prims = buildFaceFigure(face, ctx);
  const rect = prims.find(p => p.type === 'rect' && p.w === 800);
  assert.equal(rect.y, -2000);
});

// ---- アキ矩形高さ = CH - drop.bottomHeight - knee.topHeight ----
test('kneeDropGapsOnFace: アキの矩形高さはCH-drop.bottomHeight-knee.topHeight', () => {
  const shapes = new Map([
    ['s', { value: 1000 }],
    ['e', { value: 3000 }],
  ]);
  const key = edgeKey('axisY0', 's', 'e');
  const kneeDropWalls = new Map([[key, { knee: { topHeight: 600 }, drop: { bottomHeight: 400 } }]]);
  const graph = makeGraph({ kneeDropWalls, shapes });
  const face = makeFace();
  const CH = 2400;

  const gaps = kneeDropGapsOnFace(face, graph, CH);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].h, CH - 400 - 600);
  assert.equal(gaps[0].y, -(CH - 400));
  assert.equal(gaps[0].x, 1000);
  assert.equal(gaps[0].w, 2000);
});

test('buildFaceFigure: アキは矩形＋対角2本(一点鎖線)＋「ア キ」テキストを出す', () => {
  const shapes = new Map([['s', { value: 1000 }], ['e', { value: 3000 }]]);
  const key = edgeKey('axisY0', 's', 'e');
  const kneeDropWalls = new Map([[key, { knee: { topHeight: 600 }, drop: { bottomHeight: 400 } }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ kneeDropWalls, shapes }) });
  const prims = buildFaceFigure(face, ctx);

  assert.equal(prims.filter(p => p.type === 'rect').length, 1);
  assert.equal(prims.filter(p => p.type === 'line' && p.dash === 'center' && p.weight === 'thin').length, 2);
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'ア キ'));
});

// ---- 失敗系: knee/dropのどちらか片方だけの指定はアキにならない ----
test('【失敗系】kneeDropGapsOnFace: 腰壁のみ・垂れ壁のみの片側指定はアキを作らない', () => {
  const shapes = new Map([['s', { value: 1000 }], ['e', { value: 3000 }]]);
  const graph1 = makeGraph({ shapes, kneeDropWalls: new Map([[edgeKey('axisY0', 's', 'e'), { knee: { topHeight: 600 }, drop: null }]]) });
  const graph2 = makeGraph({ shapes, kneeDropWalls: new Map([[edgeKey('axisY0', 's', 'e'), { knee: null, drop: { bottomHeight: 400 } }]]) });
  const face = makeFace();
  assert.deepEqual(kneeDropGapsOnFace(face, graph1, 2400), []);
  assert.deepEqual(kneeDropGapsOnFace(face, graph2, 2400), []);
});

// ---- QA F6: labeled STRUCT RADIAL CL（角度がface.lo..hi内）は通り芯として描かれない ----
test('【QA F6】buildFaceFigure: RADIAL CL（放射CL。value=角度deg）は通り芯として描かれない', () => {
  // isVertical=trueの面（B/D相当）。旧実装は `(cl.centerLineType==='X')===wantVertical` の
  // 真偽値比較でRADIAL('R')がwantVertical=false側にマッチしてしまっていた。
  const face = makeFace({ isVertical: true, axisCL: { id: 'axisX0' }, faceValue: 0, lo: 0, hi: 4000 });
  const radialCL = { centerLineType: CenterLineType.RADIAL, effectiveValue: 45, label: 'R1' };
  const ctx = baseCtx({ gridCLs: [radialCL] });

  const prims = buildFaceFigure(face, ctx);
  assert.ok(!prims.some(p => p.type === 'text' && p.text === 'R1'), 'RADIAL CLのラベルが描かれてはいけない');
  assert.ok(!prims.some(p => p.type === 'circle'), '通り芯丸番号(circle)が描かれてはいけない');
});

// ---- 失敗系: faceの範囲外の区間は無視する ----
test('【失敗系】kneeDropGapsOnFace: faceのlo..hi範囲外の区間は無視する', () => {
  const shapes = new Map([['s', { value: 5000 }], ['e', { value: 6000 }]]);
  const kneeDropWalls = new Map([[edgeKey('axisY0', 's', 'e'), { knee: { topHeight: 600 }, drop: { bottomHeight: 400 } }]]);
  const graph = makeGraph({ shapes, kneeDropWalls });
  const face = makeFace({ lo: 0, hi: 4000 });
  assert.deepEqual(kneeDropGapsOnFace(face, graph, 2400), []);
});

// ---- parseBaseboardHeightMm: "h=<数値>" 表記のみ解釈する ----
test('parseBaseboardHeightMm: "h=60"/"H=60mm"は60を返す', () => {
  assert.equal(parseBaseboardHeightMm('h=60'), 60);
  assert.equal(parseBaseboardHeightMm('H=60mm'), 60);
  assert.equal(parseBaseboardHeightMm('木製出幅木 h=60'), 60);
});

// ---- 失敗系: 解釈できない巾木文字列はnull（非描画） ----
test('【失敗系】parseBaseboardHeightMm: "h="を含まない・非文字列は解釈できずnullを返す', () => {
  assert.equal(parseBaseboardHeightMm('60'), null, '"h="が無い素の数値は対象外');
  assert.equal(parseBaseboardHeightMm(''), null);
  assert.equal(parseBaseboardHeightMm(null), null);
  assert.equal(parseBaseboardHeightMm(undefined), null);
});

// ---- 巾木線: room.finish.baseboardHeightが解釈できる場合のみ、床上その高さに引かれる ----
test('buildFaceFigure: 巾木(h=60)は床上60mmに引かれ、床まで達する開口の区間は途切れる', () => {
  const doorOpening = {
    id: 'op1', isVertical: false, axisCL: { id: 'axisY0' }, wallSide: 1,
    centerCoord: 2000, width: 800, height: 2000, sillHeight: 0,
    category: OpeningCategory.FITTING, subType: 'singleSwing', fixtureType: null,
  };
  const face = makeFace();
  const ctx = baseCtx({
    graph: makeGraph({ openings: [doorOpening] }),
    room: makeRoom({}, { baseboardHeight: 'h=60' }),
  });
  const prims = buildFaceFigure(face, ctx);
  const baseboardLines = prims.filter(p => p.type === 'line' && p.weight === 'thin' && p.y1 === -60 && p.y2 === -60);
  // 開口(1600..2400)の左右2区間に分かれるはず（[0,1600], [2400,4000]）。
  assert.equal(baseboardLines.length, 2, `巾木線は開口区間で途切れて2本になるはず（実際:${baseboardLines.length}）`);
  assert.ok(baseboardLines.some(p => p.x1 === 0 && p.x2 === 1600));
  assert.ok(baseboardLines.some(p => p.x1 === 2400 && p.x2 === 4000));
});

// ---- 失敗系: 巾木文字列が解釈できない場合は非描画 ----
test('【失敗系】buildFaceFigure: baseboardHeightが解釈不能な文字列なら巾木線を描かない', () => {
  const face = makeFace();
  const ctx = baseCtx({ room: makeRoom({}, { baseboardHeight: '既製品' }) });
  const prims = buildFaceFigure(face, ctx);
  assert.ok(!prims.some(p => p.type === 'line' && p.weight === 'thin' && p.y1 === p.y2 && p.y1 < 0 && p.y1 > -100),
    '解釈不能な巾木文字列では巾木線を描いてはいけない');
});

// ---- 壁芯間寸法（ROW1）: 面の両端＝壁中心線(faceBoundaryLocalX)で1本出る ----
test('buildFaceFigure: 壁芯間寸法(横dim)がface.lo/hiではなく壁中心線(CL)基準で1本出る', () => {
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4100 }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ shapes }) });
  const prims = buildFaceFigure(face, ctx);
  const wallDims = prims.filter(p => p.type === 'dim' && p.dir === 'h');
  assert.equal(wallDims.length, 1);
  assert.equal(wallDims[0].from, -100);
  assert.equal(wallDims[0].to, 4100);
  assert.equal(wallDims[0].label, 4200);
});

// ---- QA G4: 通り芯間寸法(ROW2)と通り芯丸番号は別の段（同じyに同居させない） ----
test('【QA G4】buildFaceFigure: 通り芯丸(circle)は通り芯間寸法(ROW2のdim)より、さらに下の段に分離される', () => {
  const gridCLs = [
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 1000, label: '1' },
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 3000, label: '2' },
  ];
  const face = makeFace();
  const ctx = baseCtx({ gridCLs });
  const prims = buildFaceFigure(face, ctx);

  const gridDim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === 1000 && p.to === 3000);
  assert.ok(gridDim, '通り芯間寸法(1000→3000)が出るはず');
  const circles = prims.filter(p => p.type === 'circle');
  assert.equal(circles.length, 2);
  for (const c of circles) {
    assert.notEqual(c.cy, gridDim.at, '通り芯丸のyは通り芯間寸法の行(at)と同じであってはいけない（別段。QA G4）');
    assert.ok(c.cy > gridDim.at, '通り芯丸は寸法行よりさらに下（yが大きい）はず');
  }
});
