// buildFaceFigure の描画内容テスト（.claude/elevation-model.md §11 記載項目）。
// graph/room/opening は buildFaceFigure が実際に読むフィールドのみを持つ最小限のフェイクを使う
// （純関数のロジック検証が目的で、graph実体の生成コストを避ける）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeKey, OpeningCategory, CenterLineType } from '@core';
import {
  buildFaceFigure, kneeDropGapsOnFace, parseBaseboardHeightMm, avoidGridCollisionX,
} from './elevationFigure.js';
import { GRID_LINE_ABOVE_CH_MM, CANVAS_BG_COLOR, DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM } from './elevationStyle.js';

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
  // アキの対角線は斜め(x1!==x2)。項目2で追加した壁中心線の落し線(縦線・x1===x2)と区別する。
  const diagonalCenterLines = prims.filter(p =>
    p.type === 'line' && p.dash === 'center' && p.weight === 'thin' && p.x1 !== p.x2);
  assert.equal(diagonalCenterLines.length, 2);
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

// ---- 項目2・6: 水平寸法（壁芯間・通り芯間）に寸法線足(dim.foot)を出さない ----
test('【項目2・6】buildFaceFigure: 水平寸法(壁芯間・通り芯間)はdim.footを持たない', () => {
  const gridCLs = [
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 1000, label: '1' },
    { centerLineType: CenterLineType.VERTICAL, effectiveValue: 3000, label: '2' },
  ];
  const face = makeFace();
  const ctx = baseCtx({ gridCLs });
  const prims = buildFaceFigure(face, ctx);
  const horizontalDims = prims.filter(p => p.type === 'dim' && p.dir === 'h');
  assert.ok(horizontalDims.length >= 2, '壁芯間・通り芯間の両方が出るはず');
  for (const d of horizontalDims) {
    assert.equal(d.foot, undefined, `水平寸法にdim.footが残っている: ${JSON.stringify(d)}`);
    assert.equal(d.dot, true, '足の代わりに交点の塗り丸(dim.dot)が立つはず');
  }
});

// ---- 項目2: 壁芯間寸法の位置に、壁中心線自体（一点鎖線）が床から下りてくる ----
test('【項目2】buildFaceFigure: 壁芯間寸法の位置(boundary.lo/hi)まで壁中心線の一点鎖線が下りる', () => {
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4100 }]]);
  const face = makeFace();
  const ctx = baseCtx({ graph: makeGraph({ shapes }) });
  const prims = buildFaceFigure(face, ctx);
  const wallDim = prims.find(p => p.type === 'dim' && p.dir === 'h' && p.from === -100 && p.to === 4100);
  assert.ok(wallDim, '壁芯間寸法が見つからない');

  const dropLines = prims.filter(p =>
    p.type === 'line' && p.dash === 'center' && p.x1 === p.x2 && p.y1 === 0 && p.y2 === wallDim.at);
  assert.equal(dropLines.length, 2, '両端の壁中心線が寸法線の位置まで下りる縦の一点鎖線が2本出るはず');
  assert.ok(dropLines.some(l => l.x1 === -100));
  assert.ok(dropLines.some(l => l.x1 === 4100));
});

// ---- 項目7・QA F3: 面ラベル(A/B/C/D等)は壁中心線で挟んだ幅の中心（run/2ではない）に出る ----
test('【項目7・QA F3】buildFaceFigure: 面ラベル(face.label)は壁中心線基準の幅中心(boundary.lo/hiの中点)に描かれ、run/2とは一致しない', () => {
  // 壁中心線(x0/x1)をface.lo/hi(0/4000)から非対称にずらし、run/2とboundary中心が
  // 一致しない状況を作る（run/2に固定されていた旧実装ならこのテストで判別できる）。
  const shapes = new Map([['x0', { effectiveValue: -100 }], ['x1', { effectiveValue: 4300 }]]);
  const face = makeFace({ label: 'B1' });
  const ctx = baseCtx({ graph: makeGraph({ shapes }) });
  const prims = buildFaceFigure(face, ctx);
  const label = prims.find(p => p.type === 'text' && p.text === 'B1');
  assert.ok(label, '面ラベルのtextが出ない');
  assert.notEqual(label.x, face.run / 2, '前提: run/2(2000)とboundary中心(2100)がズレているはず');
  assert.equal(label.x, (-100 + 4300) / 2, '壁中心線で挟んだ幅の中心に配置されるはず');
  assert.equal(label.anchor, 'middle');
});

// ---- 調整項目2: 通り芯丸(circle)とA/B/C/D面ラベルは同じ高さ(y)に揃う ----
test('【調整項目2】buildFaceFigure: 通り芯丸(circle)と面ラベル(face.label)は同じyに描かれる', () => {
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 1500, label: '1' }];
  const face = makeFace({ label: 'A' });
  const prims = buildFaceFigure(face, baseCtx({ gridCLs }));

  const circle = prims.find(p => p.type === 'circle');
  const label  = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.ok(circle && label, '通り芯丸・面ラベルの両方が出るはず');
  assert.equal(circle.cy, label.y, '通り芯丸と面ラベルは同じ段(同じy)に揃うはず');
  // 水平位置は従来通り別（通り芯丸=通り芯位置、面ラベル=壁芯間中心）で一致しないことも確認する。
  assert.notEqual(circle.cx, label.x, '水平位置は従来どおり別のまま（通り芯位置と壁芯間中心）のはず');
});

// ---- 調整項目3: 通り芯の一点鎖線は天井線(-CH)より上へ少し突き出す ----
test('【調整項目3】buildFaceFigure: 通り芯の一点鎖線はy1=-CH-GRID_LINE_ABOVE_CH_MMまで天井線より上に伸びる', () => {
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 1500, label: '1' }];
  const CH = 2400;
  const face = makeFace();
  const prims = buildFaceFigure(face, baseCtx({ gridCLs, ceilingHeight: CH }));

  const gridLine = prims.find(p => p.type === 'line' && p.dash === 'center' && p.x1 === 1500 && p.x1 === p.x2);
  assert.ok(gridLine, '通り芯の一点鎖線が見つからない');
  assert.equal(gridLine.y1, -CH - GRID_LINE_ABOVE_CH_MM,
    `通り芯線の上端は-CH-GRID_LINE_ABOVE_CH_MM(${-CH - GRID_LINE_ABOVE_CH_MM})のはず（実際:${gridLine.y1}）`);
  assert.ok(gridLine.y1 < -CH, '天井線(-CH)より上（より負のy）まで突き出しているはず');
});

// ---- 調整項目5: 通り芯丸(circle)は背景色で塗り、通り芯線より後（配列順で手前）に描く ----
test('【調整項目5】buildFaceFigure: 通り芯丸(circle)はCANVAS_BG_COLORで塗りつぶされ、通り芯線より後に積まれる', () => {
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 1500, label: '1' }];
  const prims = buildFaceFigure(makeFace(), baseCtx({ gridCLs }));

  const lineIdx   = prims.findIndex(p => p.type === 'line' && p.dash === 'center' && p.x1 === 1500 && p.x1 === p.x2);
  const circleIdx = prims.findIndex(p => p.type === 'circle');
  assert.ok(lineIdx >= 0 && circleIdx >= 0);
  const circle = prims[circleIdx];
  assert.equal(circle.fill, CANVAS_BG_COLOR, '通り芯丸のfillは背景色(CANVAS_BG_COLOR)のはず（線を隠すため塗りつぶす）');
  assert.ok(circleIdx > lineIdx, '通り芯丸は通り芯線より後（Konvaの描画順で手前）に積まれるはず');
});

// ---- 失敗系: 通り芯が無い面は丸・面ラベルの段が空でも例外を投げない（面ラベル自体は出る） ----
test('【失敗系・調整項目2】buildFaceFigure: 通り芯が無い面でも面ラベルは出て例外にならない', () => {
  const face = makeFace({ label: 'C' });
  const prims = buildFaceFigure(face, baseCtx({ gridCLs: [] }));
  assert.equal(prims.filter(p => p.type === 'circle').length, 0);
  assert.ok(prims.some(p => p.type === 'text' && p.text === 'C'));
});

// ---- QA A1: 通り芯が面の壁芯間中心付近にあると、面ラベルと通り芯丸(同じ段=項目2)が重なる
// ため、面ラベルを横へ退避させる ----
test('【QA A1】buildFaceFigure: 通り芯が面中心にあるとき、面ラベルは同じ段のまま通り芯丸から閾値を超えて離れる', () => {
  // QA実測の再現: CL 0/2000/4000・run=4000（壁芯間中心=2000）に通り芯も2000で衝突させる。
  const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 4000 }]]);
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 2000, label: '1' }];
  const face = makeFace({ label: 'A' });
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ shapes }), gridCLs }));

  const circle = prims.find(p => p.type === 'circle');
  const label  = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.ok(circle && label, '通り芯丸・面ラベルの両方が出るはず');
  assert.equal(label.y, circle.cy, '面ラベルは通り芯丸と同じ段(y)のまま（項目2の統合は維持する）');
  assert.ok(Math.abs(label.x - circle.cx) > DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
    `面ラベルは通り芯丸からDEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM(${DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM})を超えて` +
    `離れるはず（実際差: ${Math.abs(label.x - circle.cx)}）`);
});

// ---- 失敗系: 通り芯が面中心から十分離れていれば面ラベルは退避しない（既定の壁芯間中心のまま） ----
test('【失敗系・QA A1】buildFaceFigure: 通り芯が面中心から十分離れていれば面ラベルは退避しない', () => {
  const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 4000 }]]);
  const gridCLs = [{ centerLineType: CenterLineType.VERTICAL, effectiveValue: 3900, label: '1' }];
  const face = makeFace({ label: 'A' });
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ shapes }), gridCLs }));
  const label = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.equal(label.x, 2000, '衝突しなければ既定の壁芯間中心(2000)のまま退避しないはず');
});

// ---- QA B1: 910mm等間隔グリッド（住宅の標準モジュール。2間の部屋＝最頻ケース）で、旧「一段だけ
// 固定シフト」実装は退避後の位置が別の通り芯丸に再度重なっていた。最広ギャップ中点方式なら、
// 退避後のxが**全ての**通り芯丸から閾値以上離れることを確認する（1回の走査で決定的に解消）。----
test('【QA B1】buildFaceFigure: 910グリッド(CLs=0/910/1820/2730/3640・run=3640)で面ラベルは全ての通り芯丸から閾値以上離れる', () => {
  const shapes = new Map([['x0', { effectiveValue: 0 }], ['x1', { effectiveValue: 3640 }]]);
  const gridCLs = [0, 910, 1820, 2730, 3640].map((v, i) =>
    ({ centerLineType: CenterLineType.VERTICAL, effectiveValue: v, label: String(i + 1) }));
  const face = makeFace({ label: 'A', lo: 0, hi: 3640, run: 3640 });
  const prims = buildFaceFigure(face, baseCtx({ graph: makeGraph({ shapes }), gridCLs }));

  const circles = prims.filter(p => p.type === 'circle');
  const label   = prims.find(p => p.type === 'text' && p.text === 'A');
  assert.equal(circles.length, 5, '通り芯丸は5個出るはず');
  for (const c of circles) {
    assert.ok(Math.abs(label.x - c.cx) >= DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
      `面ラベル(x=${label.x})は通り芯丸(cx=${c.cx})から閾値(${DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM})以上` +
      `離れるはず（実際差: ${Math.abs(label.x - c.cx)}）`);
  }
});

// ---- avoidGridCollisionX 単体（QA B1）: 衝突時は最広ギャップの中点、非衝突時は元のxのまま ----
test('avoidGridCollisionX: 衝突時（境界含む）は最広ギャップの中点へ、超えていれば退避しない', () => {
  const boundary = { lo: 0, hi: 4000 };
  // 通り芯2400のみ・衝突（距離400=閾値ちょうど）。区間は[0,2400](幅2400)と[2400,4000](幅1600)。
  // より広い[0,2400]の中点=1200へ。
  assert.equal(avoidGridCollisionX(2000, [{ x: 2400 }], boundary, 400), 1200, '距離=閾値ちょうどでも退避し、最も広い区間の中点になる');
  // 通り芯2401のみ・非衝突（距離401>閾値400）→ 動かさない。
  assert.equal(avoidGridCollisionX(2000, [{ x: 2401 }], boundary, 400), 2000, '距離が閾値を超えていれば退避しない');
  // 通り芯2000のみ（面中心と同座標）・衝突。区間は[0,2000]と[2000,4000]で幅が等しい→先に見つかる側([0,2000])の中点=1000。
  assert.equal(avoidGridCollisionX(2000, [{ x: 2000 }], boundary, 400), 1000, '幅が同点なら先に見つかった区間の中点になる');
});

// ---- 失敗系: gridPointsが空なら常に退避しない ----
test('【失敗系】avoidGridCollisionX: gridPointsが空なら常に元のxを返す', () => {
  assert.equal(avoidGridCollisionX(2000, [], { lo: 0, hi: 4000 }, 400), 2000);
});
