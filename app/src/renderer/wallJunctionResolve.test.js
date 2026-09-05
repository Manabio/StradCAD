// resolveWallTJunctions（壁のT字取り合いの描画解決）のテスト。
// 問題: 1部屋が複数部屋に面する通し壁で、向かい側の部屋同士を区切る壁が軸CLへ
// 突き当たると、通し壁の「反対側」の仕上げ面線までカットされ分断されて見えた
// （仕様は「A側の仕上げのみカット・反対側は連続」——モジュール冒頭コメント参照）。
//
// 数値は wallGeneration.js の既定生成（wallBase=100・wallFinish=12.5 → axisOffset=±75、
// オーナー下地帯は軸±62.5）に合わせる。座標系は実アプリ同様 y軸下向き正・単位mm。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { resolveWallTJunctions, resolveWallFinSegments, isCapSuppressed } from './wallJunctionResolve.js';

// 最小スタブ壁（resolveWallTJunctions が参照するフィールドのみ）。
// faceDir は既定では axisOffset の符号から導出するが、CL偏芯壁（finishSide 明示で
// sign(axisOffset) と食い違う。core/wall.js faceDirOr 参照）は明示指定する。
function stubWall({ id, isVertical, axis, face, coord1, coord2, backingRange, materialRange, wallFinish = 12.5, faceDir = null, isExteriorWall = false }) {
  return {
    id, isVertical, wallFinish, coord1, coord2,
    axisValue: face,
    axisCL: { effectiveValue: axis },
    faceDir: faceDir ?? (Math.sign(face - axis) || 1),
    backingRange, materialRange, isExteriorWall,
  };
}

// 通し壁B: 水平・軸y=2000（中心1相当）・仕上げ面が下側(y=2075)＝下の部屋dのオーナー壁。
// 下地帯は軸を跨いで対称（1937.5..2062.5）、材範囲は下地〜下側仕上げ面（1937.5..2075）。
function throughWallFacingDown() {
  return stubWall({
    id: 'B-down', isVertical: false, axis: 2000, face: 2075,
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 },
    materialRange: { lo: 1937.5, hi: 2075 },
  });
}

// 突き当たり壁A: 垂直・軸x=2500（中心8相当）・上の部屋i|jを区切るオーナー壁。
// 上（y=0）から下りてきて、下端は南側の壁の面位置 y=1925（=2000-75）で終端する。
function abuttingWallFromAbove() {
  return stubWall({
    id: 'A-vert', isVertical: true, axis: 2500, face: 2575,
    coord1: 0, coord2: 1925,
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });
}

test('resolveWallTJunctions: 反対側（軸〜下地側）から突き当たる壁は、通し壁の仕上げ面をカットしない', () => {
  const b = throughWallFacingDown(); // 仕上げ面は下側（dの側）
  const a = abuttingWallFromAbove(); // 上側から突き当たる（dと反対側）

  const result = resolveWallTJunctions([a, b]);

  const cuts = result.get('B-down')?.finCuts ?? [];
  assert.deepEqual(cuts, [], 'd側の仕上げ面線は突き当たり位置（@）で分断されず連続のまま描かれるはず');
  // A側の下地延長（Bの下地近位面 1937.5 まで）は従来どおり生きる（下地の連続は両側で成立）
  assert.equal(result.get('A-vert')?.baseExtend.hi, 1937.5);
});

test('resolveWallTJunctions: 仕上げ面側から突き当たる壁は従来どおり下地幅でカットする', () => {
  // 通し壁B2: 軸y=2000・仕上げ面が上側(y=1925)＝上の部屋側のオーナー壁
  const b = stubWall({
    id: 'B-up', isVertical: false, axis: 2000, face: 1925,
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 },
    materialRange: { lo: 1925, hi: 2062.5 },
  });
  const a = abuttingWallFromAbove(); // 上側から突き当たる＝仕上げ面と同じ側

  const result = resolveWallTJunctions([a, b]);

  assert.deepEqual(result.get('B-up')?.finCuts, [[2437.5, 2562.5]],
    '仕上げ面側からの突き当たりはAの下地幅でカットされるはず');
});

// ---- CL偏芯壁: 材全体が軸CLの片側へ寄り finishSide が sign(axisOffset) と食い違う壁
// （clEccentricity.js の e=-100, side=+1 相当）。ゲートは axisOffset の符号ではなく
// faceDir を見るため、この壁でも「仕上げ面側からだけカット」が成立することを固定する ----
test('resolveWallTJunctions: 偏芯で材が軸CLの片側に寄った通し壁でも、仕上げ面側からの突き当たりだけをカットする', () => {
  const makeB = () => stubWall({
    id: 'B-ecc', isVertical: false, axis: 2000, face: 1962.5, faceDir: 1, // axisOffset=-37.5 だが finishSide=+1
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1850, hi: 1950 },
    materialRange: { lo: 1850, hi: 1962.5 },
  });
  // A1: 仕上げ面側（+側・下）から上がってきて面 1962.5 で終端 → カットされる
  const a1 = stubWall({
    id: 'A-plus', isVertical: true, axis: 2500, face: 2575,
    coord1: 1962.5, coord2: 4000,
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });
  const r1 = resolveWallTJunctions([a1, makeB()]);
  assert.deepEqual(r1.get('B-ecc')?.finCuts, [[2437.5, 2562.5]],
    '仕上げ面側（faceDir側）からの突き当たりはカットされるはず');

  // A2: 反対側（−側・上）から下りてきて下地遠位面 1850 で終端 → カットされない
  const a2 = stubWall({
    id: 'A-minus', isVertical: true, axis: 2500, face: 2575,
    coord1: 0, coord2: 1850,
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });
  const r2 = resolveWallTJunctions([a2, makeB()]);
  assert.deepEqual(r2.get('B-ecc')?.finCuts ?? [], [],
    '反対側（下地側）からの突き当たりはカットされないはず');
});

// ---- 失敗系: Aの遠端がBの軸CL上に乗る退化ケース（bodySide===0＝側を判定できない）は
// 従来どおりカットする（安全側） ----
test('【失敗系】resolveWallTJunctions: Aの遠端がBの軸CL上に乗る退化ケースは従来どおりカットする', () => {
  const b = throughWallFacingDown(); // 軸 y=2000
  const a = stubWall({
    id: 'A-degen', isVertical: true, axis: 2500, face: 2575,
    coord1: 1925, coord2: 2000, // 遠端(anchor)がちょうどBの軸上
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });

  const result = resolveWallTJunctions([a, b]);

  // lo端(1925)から見た anchor=2000 が軸上 → bodySide===0 → 判定不能としてカット維持
  assert.deepEqual(result.get('B-down')?.finCuts, [[2437.5, 2562.5]]);
});

// ---- 失敗系: 薄壁（下地なし）は貫通先の下地が無いため従来どおり対象外 ----
test('【失敗系】resolveWallTJunctions: 通し壁が薄壁（backingRange なし）なら何も起きない', () => {
  const b = stubWall({
    id: 'B-thin', isVertical: false, axis: 2000, face: 1925,
    coord1: 0, coord2: 7000,
    backingRange: null, // backingDepth===0 相当
    materialRange: { lo: 1925, hi: 1937.5 },
  });
  const a = abuttingWallFromAbove();

  const result = resolveWallTJunctions([a, b]);

  assert.equal(result.get('B-thin'), undefined, '薄壁はT字解決の対象外のはず');
});

// ---- 失敗系: X字（素通り）はどちらの端点もBの材に触れないため対象外 ----
// 2026-09追記: このテストはパス3（fin線の直交壁下地貫通防止）の「Vの端点からfbが
// TOUCH_TOLERANCE以内」ガードも同時に固定する——Aの端点(0,5000)はBのfin位置(2062.5)から
// 2062.5mm/2937.5mm離れており、このガードが無いと「fbがAの範囲に含まれる」だけでパス3が
// 誤発火する（実際に検出したリグレッション）。
test('【失敗系】resolveWallTJunctions: 素通りする壁（X字）は仕上げをカットしない', () => {
  const b = throughWallFacingDown();
  const a = stubWall({
    id: 'A-cross', isVertical: true, axis: 2500, face: 2575,
    coord1: 0, coord2: 5000, // Bをまたいで通過（端点はBの材から遠い）
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });

  const result = resolveWallTJunctions([a, b]);

  assert.deepEqual(result.get('B-down')?.finCuts ?? [], []);
});

// ==================================================================
// 前提の固定: core/wall.js の materialRange は、対称/薄壁/下地オーナー・偏芯の
// どの分岐でも、faceDir方向の遠位端が常にfaceValue（axisValue）と一致する。
// パス2が「入隅=faceValueに一致」「出隅=materialRangeの遠位面に一致」という2つの述語に
// 分かれているのは値が違うからではなく（値は常に一致する）、closeConvexCornersと同じ語彙で
// 意図を明示するため（モジュールヘッダ参照）。この前提が将来のcore/wall.js変更で破れたら
// 気づけるよう、実Wallインスタンス（スタブではなく）で6型固定する。
// ==================================================================
test('core/wall.js: materialRangeの遠位面(faceDir方向)はowner±/thin±/対称/偏芯の6型すべてでfaceValueと一致する', () => {
  const g = new PlanGraph(new Plane('p', 0, '1階', 1, 1));
  const axisCL = g.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clA = g.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clB = g.addCenterLine(CenterLineType.HORIZONTAL, 1000, { labeled: false, discipline: Discipline.ARCH });

  // [名前, axisOffset, props]。偏芯型のみ finishSide が axisOffset の符号と食い違う
  // （clEccentricity.js が実際に生成する組み合わせ。core/wall.js のコメント参照）。
  const types = [
    ['対称(backingDepth未指定)', 57.5, { wallFinish: 12.5 }],
    ['owner+(backingOffset0)', 57.5, { wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: 1 }],
    ['owner-(backingOffset0)', -57.5, { wallFinish: 12.5, backingOffset: 0, backingDepth: 90, finishSide: -1 }],
    ['thin+(backingDepth0)', 57.5, { wallFinish: 12.5, backingDepth: 0, finishSide: 1 }],
    ['thin-(backingDepth0)', -57.5, { wallFinish: 12.5, backingDepth: 0, finishSide: -1 }],
    ['偏芯(CL-eccentric・finishSideがaxisOffset符号と食い違う)', -37.5,
      { wallFinish: 12.5, backingOffset: -100, backingDepth: 100, finishSide: 1 }],
  ];

  for (const [name, axisOffset, props] of types) {
    const w = g.addWall(axisCL, axisOffset, true, clA, 0, clB, 0, { isRoomWall: true, ...props });
    const dir = w.faceDir;
    const farBound = dir > 0 ? w.materialRange.hi : w.materialRange.lo;
    assert.equal(farBound, w.axisValue, `${name}: 材の遠位面はfaceValueと一致するはず`);
  }
});

// ==================================================================
// コーナー取り合い（出隅・入隅・十字。パス2: finEnd/capSuppress）のテスト。
// ユーザー確定仕様「壁同士がT字・十字に取り合う時、内側同士・外側同士の線が取り合う」。
// 数値は実機データ・1階（垂直壁CL x=2500 が 水平壁CL y=-5000 へ北側から突き当たる隅。
// 2026-09 実測）をそのまま使う。
// ==================================================================

// 垂直thin: 軸x=2500・仕上げ面(西側)=2442.5・faceDir=-1。北側から降りてきて
// 水平thin壁の面(y=-5057.5)で終端する。
function realVThin() {
  return stubWall({
    id: 'V-thin', isVertical: true, axis: 2500, face: 2442.5, faceDir: -1,
    coord1: -6942.5, coord2: -5057.5,
    backingRange: null, materialRange: { lo: 2442.5, hi: 2455 },
  });
}
// 垂直owner: 同じ軸・仕上げ面(東側)=2557.5・faceDir=+1・下地帯[2455,2545]。
function realVOwner() {
  return stubWall({
    id: 'V-owner', isVertical: true, axis: 2500, face: 2557.5, faceDir: 1,
    coord1: -6942.5, coord2: -5057.5,
    backingRange: { lo: 2455, hi: 2545 }, materialRange: { lo: 2455, hi: 2557.5 },
  });
}
// 水平thin(左): 軸y=-5000・仕上げ面(北側)=-5057.5・faceDir=-1。Vthinの西側で止まる。
function realHThinLeft() {
  return stubWall({
    id: 'H-thin-left', isVertical: false, axis: -5000, face: -5057.5, faceDir: -1,
    coord1: 57.5, coord2: 2442.5,
    backingRange: null, materialRange: { lo: -5057.5, hi: -5045 },
  });
}
// 水平thin(右): 同じ軸・Vownerの東側で始まる。
function realHThinRight() {
  return stubWall({
    id: 'H-thin-right', isVertical: false, axis: -5000, face: -5057.5, faceDir: -1,
    coord1: 2557.5, coord2: 4442.5,
    backingRange: null, materialRange: { lo: -5057.5, hi: -5045 },
  });
}

test('resolveWallTJunctions: T字（実測4枚）の左右の隅でfinEnd/capSuppressが解決される', () => {
  const result = resolveWallTJunctions([realVThin(), realVOwner(), realHThinLeft(), realHThinRight()]);

  // 左の隅: 水平thin左の内側線をVthinの内側線(2455)まで延長・その端のcapを抑止
  assert.equal(result.get('H-thin-left')?.finEnd.hi, 2455);
  assert.equal(result.get('H-thin-left')?.capSuppress.hi, true);
  // 左の隅（対称側）: Vthinの内側線をH-thin-leftの内側線(-5045)まで延長
  assert.equal(result.get('V-thin')?.finEnd.hi, -5045);
  assert.equal(result.get('V-thin')?.capSuppress.hi, true);

  // 右の隅: 水平thin右の内側線をVownerの内側線(2545)まで延長
  assert.equal(result.get('H-thin-right')?.finEnd.lo, 2545);
  assert.equal(result.get('H-thin-right')?.capSuppress.lo, true);
  // 右の隅（対称側）: Vownerの内側線をH-thin-rightの内側線(-5045)まで延長
  assert.equal(result.get('V-owner')?.finEnd.hi, -5045);
  assert.equal(result.get('V-owner')?.capSuppress.hi, true);
});

test('resolveWallTJunctions: 入隅L字コーナー（直交2枚だけが端点を共有）でも同じ結果になる', () => {
  const result = resolveWallTJunctions([realVThin(), realHThinLeft()]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, 2455);
  assert.equal(result.get('V-thin')?.finEnd.hi, -5045);
  assert.equal(result.get('H-thin-left')?.capSuppress.hi, true);
  assert.equal(result.get('V-thin')?.capSuppress.hi, true);
});

// ---- ユーザー確定仕様の可視化: 通し壁が左右分割されたT字で、下地オーナー壁(V-owner)の
// 端はパス1(T字貫通)のbaseExtendを持たない（この隅のB候補=水平thinが薄壁でパス1のBに
// なれないため）。それでもキャップは消える——パス2(コーナー)のcapSuppressだけで
// 「角のキャップ線は消す」という仕様が成立することを記録する ----
test('resolveWallTJunctions: 通し壁が左右分割されたT字（下地オーナー壁側）はbaseExtendを持たずcapSuppressだけでキャップを消す', () => {
  const result = resolveWallTJunctions([realVThin(), realVOwner(), realHThinLeft(), realHThinRight()]);

  assert.equal(result.get('V-owner')?.baseExtend.hi, undefined,
    'この隅のB候補（水平thin）は薄壁のためパス1のBになれず、baseExtendは立たないはず');
  assert.equal(result.get('V-owner')?.capSuppress.hi, true,
    'baseExtendが無くてもパス2のcapSuppressだけでキャップは消えるはず');
});

// ---- 失敗系: wallFinish===0（materialThicknessが0/nullの材で到達しうる）の壁は
// fin線自体が描かれないため、コーナー解決の対象外（自壁・相手壁の両方）----
test('【失敗系】resolveWallTJunctions: wallFinish===0の壁（自壁）はコーナー解決の対象外', () => {
  const vThinZeroFinish = { ...realVThin(), wallFinish: 0 };
  const result = resolveWallTJunctions([vThinZeroFinish, realHThinLeft()]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined,
    '相手(V-thin)のwallFinishが0だと相手のfin線が描かれないため延長先として無意味で対象外のはず');
  assert.equal(result.has('V-thin'), false,
    '自身のwallFinishが0の壁はfin線が描かれずcapSuppressだけ立つと端に線が無くなるため候補外のはず');
});

test('【失敗系】resolveWallTJunctions: wallFinish===0の壁（相手壁）はコーナー解決の対象外', () => {
  const hThinLeftZeroFinish = { ...realHThinLeft(), wallFinish: 0 };
  const result = resolveWallTJunctions([realVThin(), hThinLeftZeroFinish]);

  assert.equal(result.get('V-thin')?.finEnd.hi, undefined,
    '相手のwallFinishが0だと延長先(相手の内側線位置)が意味を持たないため対象外のはず');
});

// ---- 失敗系（実バグ再現・2026-09 QA指摘）: |axisOffset|===wallFinish の薄壁は
// finBoundary(=axisValue-faceDir*wallFinish)が軸CL上に潰れる（finVisible=false）。
// この形状はfinish/stair/stairUnderWalls.jsのルール2（階段下部屋の外側仕上げ薄壁。
// axisOffset:-sign*outerFinish, wallFinish:outerFinish, backingDepth:0, finishSideは
// 渡さないためfaceDir=sign(axisOffset)で厳密に成立）が実際に生成する。旧コードは
// wallFinish>0だけを見ていたため、この壁がcapSuppressを立てるのにfin線自体は
// （ShapesLayer側のfinVisibleガードにより）描かれず、端にcap・fin線がともに無くなる
// 回帰があった。finVisible化により自壁・相手壁の両方の役割で対象外になるはず ----
test('【失敗系】resolveWallTJunctions: 内側線が軸CL上に潰れる薄壁（|axisOffset|===wallFinish）はコーナー解決の対象外', () => {
  // axisCLValue=2500, axisOffset=-57.5, wallFinish=57.5 → finBoundary
  // = axisValue(2442.5) - faceDir(-1)*wallFinish(57.5) = 2500 = axisCLValue（潰れる）。
  const collapsedV = stubWall({
    id: 'V-collapsed', isVertical: true, axis: 2500, face: 2442.5, faceDir: -1, wallFinish: 57.5,
    coord1: -6942.5, coord2: -5057.5,
    backingRange: null, materialRange: { lo: 2442.5, hi: 2500 },
  });
  const hLeft = realHThinLeft(); // 通常の薄壁（finVisible=true）。V-collapsedの面で終端する

  const result = resolveWallTJunctions([collapsedV, hLeft]);

  assert.equal(result.has('V-collapsed'), false,
    '内側線が潰れた壁は自壁としてもコーナー解決の候補にならない（finEnd/capSuppressを持たない）はず');
  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined,
    '相手側（H-thin-left）も、内側線が潰れた壁を延長先として採らないはず');
  assert.equal(result.get('H-thin-left')?.capSuppress.hi, undefined);
});

test('resolveWallTJunctions: 十字（4枚が1点に集まる）で各象限の隅が独立に解決される', () => {
  // 北側（実測どおり）+ 南側（同じ通り芯を対称に鏡映した合成フィクスチャ）で計8枚。
  const vThinSouth = stubWall({
    id: 'V-thin-south', isVertical: true, axis: 2500, face: 2442.5, faceDir: -1,
    coord1: -4942.5, coord2: -3000,
    backingRange: null, materialRange: { lo: 2442.5, hi: 2455 },
  });
  const vOwnerSouth = stubWall({
    id: 'V-owner-south', isVertical: true, axis: 2500, face: 2557.5, faceDir: 1,
    coord1: -4942.5, coord2: -3000,
    backingRange: { lo: 2455, hi: 2545 }, materialRange: { lo: 2455, hi: 2557.5 },
  });
  const hThinSouthLeft = stubWall({
    id: 'H-thin-south-left', isVertical: false, axis: -5000, face: -4942.5, faceDir: 1,
    coord1: 57.5, coord2: 2442.5,
    backingRange: null, materialRange: { lo: -4955, hi: -4942.5 },
  });
  const hThinSouthRight = stubWall({
    id: 'H-thin-south-right', isVertical: false, axis: -5000, face: -4942.5, faceDir: 1,
    coord1: 2557.5, coord2: 4442.5,
    backingRange: null, materialRange: { lo: -4955, hi: -4942.5 },
  });

  const result = resolveWallTJunctions([
    realVThin(), realVOwner(), realHThinLeft(), realHThinRight(),
    vThinSouth, vOwnerSouth, hThinSouthLeft, hThinSouthRight,
  ]);

  // 北側2象限（実測どおり。8枚同時でも南側との混線がないことを確認）
  assert.equal(result.get('H-thin-left')?.finEnd.hi, 2455);
  assert.equal(result.get('V-thin')?.finEnd.hi, -5045);
  assert.equal(result.get('H-thin-right')?.finEnd.lo, 2545);
  assert.equal(result.get('V-owner')?.finEnd.hi, -5045);

  // 南側2象限（独立に解決される）
  assert.equal(result.get('H-thin-south-left')?.finEnd.hi, 2455);
  assert.equal(result.get('V-thin-south')?.finEnd.lo, -4955);
  assert.equal(result.get('H-thin-south-right')?.finEnd.lo, 2545);
  assert.equal(result.get('V-owner-south')?.finEnd.lo, -4955);
});

// ---- 失敗系: 自由端（相手のいない端）はキャップを描く・finEndを持たない ----
test('【失敗系】resolveWallTJunctions: 自由端（相手のいない壁）はfinEnd/capSuppressを持たない', () => {
  const free = stubWall({
    id: 'Free', isVertical: true, axis: 1000, face: 985, faceDir: -1,
    coord1: 0, coord2: 500,
    backingRange: null, materialRange: { lo: 970, hi: 985 },
  });

  const result = resolveWallTJunctions([free]);

  assert.equal(result.has('Free'), false, '相手がいない壁はマップに登録されないはず');
});

// ---- 失敗系: 仕上げ厚がnullの壁（自壁・相手壁いずれも）は対象外 ----
test('【失敗系】resolveWallTJunctions: 仕上げ厚(wallFinish)がnullの壁はコーナー解決の対象外', () => {
  const vThinNoFinish = { ...realVThin(), wallFinish: null };
  const result = resolveWallTJunctions([vThinNoFinish, realHThinLeft()]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined,
    '相手(V-thin)の仕上げ厚が不明なため延長先を計算できないはず');
  assert.equal(result.has('V-thin'), false, '自身の仕上げ厚が不明な壁は候補にすら入らないはず');
});

// ---- 失敗系: 直交壁のスパンがこの壁の内側線の位置を含まない（すれ違い）ときは対象外 ----
test('【失敗系】resolveWallTJunctions: 直交壁の面値がたまたま一致してもスパンが届かない（すれ違い）は対象外', () => {
  const farVThin = stubWall({
    id: 'V-thin-far', isVertical: true, axis: 2500, face: 2442.5, faceDir: -1,
    coord1: -9000, coord2: -6000, // H-thin-left の軸位置(-5057.5)まで全く届かない
    backingRange: null, materialRange: { lo: 2442.5, hi: 2455 },
  });

  const result = resolveWallTJunctions([farVThin, realHThinLeft()]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined);
  assert.equal(result.has('V-thin-far'), false);
});

// ---- 失敗系（実バグ再現・2026-09 QA指摘）: TOUCH_TOLERANCE(30mm)はwallFinish(12.5mm)より
// 大きいため、touchチェックだけでは「flushか、相手の面を行き過ぎ/手前で終端しているだけか」を
// 区別できない。方向ガード（入隅はdir*(target-coord)>0のみ・出隅は<0のみ）が無いと、
// 行き過ぎた入隅が誤って短縮され、手前で終わった出隅が誤って延長されてしまう ----
test('【失敗系】resolveWallTJunctions: 相手の面を27.5mm行き過ぎて終端する壁は内側線を短縮せずキャップも残す', () => {
  // H-thin-leftがV-thinの面(2442.5)を27.5mm行き過ぎて2470で終端する（本来は入隅touchの
  // 範囲=coord<=faceValue+30だが、方向ガード無しでは逆向き=短縮の値が計算されてしまう）。
  const overshootHLeft = { ...realHThinLeft(), coord2: 2442.5 + 27.5 };
  const result = resolveWallTJunctions([realVThin(), overshootHLeft]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined,
    '方向ガード（入隅はdir*(target-coord)>0のときだけ）で誤った短縮が弾かれるはず');
  assert.equal(result.get('H-thin-left')?.capSuppress.hi, undefined,
    'finEndが立たない以上capSuppressも立たず、キャップは描かれ続けるはず');
});

test('【失敗系】resolveWallTJunctions: 相手の面の27.5mm手前で終端する壁は内側線を延長しない', () => {
  // dir===b.faceDirとなる出隅シグネチャ（realHThinLeftを再利用した合成フィクスチャ）を
  // 使い、H-thin-leftがVの材の遠位面(2442.5)の27.5mm手前(2415)で終端するケース。
  const outCornerVThin = { ...realVThin(), faceDir: 1, materialRange: { lo: 2430, hi: 2442.5 } };
  const undershootHLeft = { ...realHThinLeft(), coord2: 2442.5 - 27.5 };
  const result = resolveWallTJunctions([outCornerVThin, undershootHLeft]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined,
    '方向ガード（出隅はdir*(target-coord)<0のときだけ）で誤った延長が弾かれるはず');
});

// ---- 失敗系: 方向ガードの境界 delta===0（内側線が既に目標位置にあり動かす必要が無い）は
// 入隅・出隅のどちらの式でも不採用とする（安全側。キャップだけ残る自由端相当として扱う）----
test('【失敗系】resolveWallTJunctions: 境界delta===0（target===coord）は入隅としても不採用', () => {
  // target(=2430+12.5=2442.5)がcoord(2442.5)とちょうど一致する退化ケース。
  const zeroDeltaVThin = stubWall({
    id: 'V-zero-delta', isVertical: true, axis: 2500, face: 2430, faceDir: -1,
    coord1: -6942.5, coord2: -5057.5,
    backingRange: null, materialRange: { lo: 2430, hi: 2442.5 },
  });
  const result = resolveWallTJunctions([zeroDeltaVThin, realHThinLeft()]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, undefined,
    'delta===0（target===coord）は入隅としても不採用のはず');
});

// ---- 設計変更により意味が変わったテスト（2026-09 出隅対応で更新）----
// 旧仕様: 「相手の仕上げが逆を向いている（dir===faceDir）端は対象外」——出隅未対応だった頃は
// dir===faceDirを一律「向きが合わない」として弾いていた。
// 新仕様: dir===faceDirは「出隅（この壁が相手を貫通済み）」の正当なシグネチャになった
// （モジュールヘッダ参照）。この組み合わせ自体は除外対象ではなく、出隅として短縮先
// （相手の内側線の位置）が計算されるのが正しい——ただしcapSuppressは立てない
// （出隅ではキャップの扱いを変えない、というユーザー確定仕様）。
test('resolveWallTJunctions: dir===faceDirの組は出隅（短縮）として扱われ、capSuppressは立たない（旧“逆向きは対象外”からの設計変更）', () => {
  // H-thin-leftから見て「相手(V-thin)の仕上げが逆を向いている」状態は、実は出隅の
  // シグネチャそのもの——V-thinの材が[2430,2442.5]（面2442.5から見て逆向きに12.5mm）に
  // なる自己無矛盾な構成で表す。
  const outCornerVThin = { ...realVThin(), faceDir: 1, materialRange: { lo: 2430, hi: 2442.5 } };
  const result = resolveWallTJunctions([outCornerVThin, realHThinLeft()]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, 2430,
    '出隅として、相手(V-thin)の内側線の位置(2430)まで短縮されるはず');
  // 2026-09 item3の修正でcapSuppressは「設定のみ」から「常に上書き」に変わったため、
  // 出隅勝利時は undefined ではなく明示的な false になる（isCapSuppressedは!!で見るため
  // 消費側の挙動はundefined/falseどちらでも同じ＝falsy）。
  assert.equal(result.get('H-thin-left')?.capSuppress.hi, false,
    '出隅ではcapSuppressは立たない（キャップの扱いは現状維持。値は明示的なfalse）');
});

// ==================================================================
// 出隅（convex corner）のテスト。数値は wallCorner.test.js の
// 【実機指摘】closeConvexCorners テストの closeConvexCorners 適用後の状態と同じ
// （wallBase=90・wallFinish=12.5 → axisOffset=57.5・軸x=0/y=0・closeConvexCorners後は
// 双方 coord2=57.5 まで相手の材の外面（この単純な対称壁ではmaterialRange.hi=faceValueと
// 一致）まで伸びている）。backingRangeを持たない単純な薄壁のためパス1（T字貫通）は
// 発火しない。
// ==================================================================
function convexV() {
  return stubWall({
    id: 'V-convex', isVertical: true, axis: 0, face: 57.5, faceDir: 1,
    coord1: -6000, coord2: 57.5, // closeConvexCorners適用後
    backingRange: null, materialRange: { lo: 0, hi: 57.5 },
  });
}
function convexH() {
  return stubWall({
    id: 'H-convex', isVertical: false, axis: 0, face: 57.5, faceDir: 1,
    coord1: -6000, coord2: 57.5,
    backingRange: null, materialRange: { lo: 0, hi: 57.5 },
  });
}

test('resolveWallTJunctions: 出隅（closeConvexCorners適用後の2枚）は両壁の内側線の端点が交点（相手のfin平面）になる', () => {
  const result = resolveWallTJunctions([convexV(), convexH()]);

  // 相手の内側線の位置（fin線）= faceValue - faceDir*wallFinish = 57.5-12.5 = 45。
  // 双方とも同じ値45に短縮され、(45,45)という同一の交点で内側線が合流する。
  assert.equal(result.get('V-convex')?.finEnd.hi, 45);
  assert.equal(result.get('H-convex')?.finEnd.hi, 45);
  // 出隅ではキャップ線の扱いを変えない（capSuppressは立たない。2026-09 item3の修正で
  // 常に上書きするようになったため値は明示的なfalse——isCapSuppressedは!!で見るため
  // 消費側の挙動はundefined/falseどちらでも同じ）。
  assert.equal(result.get('V-convex')?.capSuppress.hi, false);
  assert.equal(result.get('H-convex')?.capSuppress.hi, false);
  // 外側線（face）は不変——backingRangeを持たない薄壁のためパス1は対象外、
  // faceCuts/baseExtendともに立たないはず（=顔線・cap線ともに現状の描画のまま）。
  assert.deepEqual(result.get('V-convex')?.faceCuts ?? [], []);
  assert.deepEqual(result.get('H-convex')?.faceCuts ?? [], []);
  assert.equal(result.get('V-convex')?.baseExtend.hi, undefined);
  assert.equal(result.get('H-convex')?.baseExtend.hi, undefined);
});

test('【失敗系】resolveWallTJunctions: 出隅でも自由端（相手のいない側の端）は変化しない', () => {
  const result = resolveWallTJunctions([convexV(), convexH()]);
  // 双方ともlo端（-6000側）には相手がいないため変化しないはず
  assert.equal(result.get('V-convex')?.finEnd.lo, undefined);
  assert.equal(result.get('H-convex')?.finEnd.lo, undefined);
});

// ---- capSuppressは勝者が変わるたびに必ず再設定する（`if(!isConvex) rec.capSuppress=true`
// という「設定のみ」ではなく`rec.capSuppress=!isConvex`という「常に上書き」に変更。
// 同一端で複数の候補が競合し勝者が入れ替わっても、capSuppressの値が古い勝者のまま
// 残らないことを固定する。REASONED: 入隅は必ずcoordの外側・出隅は必ずcoordの内側に
// targetを持つ（方向ガードの定義上）ため、同一端で入隅が一度でも成立すればタイブレークで
// 出隅に負けることは無い——この「入隅→出隅の上書き」自体は現行の述語では起こり得ないが、
// 「出隅同士で勝者が入れ替わってもcapSuppressが常にfalseへ再設定される」ことは
// このテストで直接検証できる（設定のみの実装なら初回のconvex勝利時に一度も
// capSuppressへ触れず、常にundefinedのまま——本テストのassertは新旧どちらでも
// falsyだが、値そのものの一貫性を固定する） ----
test('resolveWallTJunctions: 出隅の勝者が入れ替わってもcapSuppressは常にfalseへ再設定される', () => {
  const hLeft = realHThinLeft(); // hi端 coord=2442.5, anchor=57.5, dir=+1
  // B1: 弱い出隅候補（短縮量小・target=2437.5）
  const weakConvex = stubWall({
    id: 'B-weak', isVertical: true, axis: 2500, face: 2442.5, faceDir: 1, wallFinish: 5,
    coord1: -6942.5, coord2: -5057.5,
    backingRange: null, materialRange: { lo: 2437.5, hi: 2442.5 },
  });
  // B2: より強い出隅候補（target=2441.5 > 2437.5 なのでタイブレークでB1を上書きする）
  const strongerConvex = stubWall({
    id: 'B-stronger', isVertical: true, axis: 2500, face: 2462.5, faceDir: 1, wallFinish: 21,
    coord1: -6942.5, coord2: -5057.5,
    backingRange: null, materialRange: { lo: 2441.5, hi: 2462.5 },
  });

  const result = resolveWallTJunctions([hLeft, weakConvex, strongerConvex]);

  assert.equal(result.get('H-thin-left')?.finEnd.hi, 2441.5,
    'より外側(dir方向)へ進んだB-strongerが最終的な勝者になるはず');
  assert.equal(result.get('H-thin-left')?.capSuppress.hi, false,
    '出隅が勝者である限りcapSuppressは常にfalseへ再設定されるはず');
});

// ==================================================================
// 通し壁の切り欠き（faceCuts / finCuts の区間の違い）の合成フィクスチャ。
// 実機データでは、この隅（north側T字）を構成する壁が薄壁同士のためbackingRangeを
// 要求する旧finishCuts経路は発火しない（検証: 上記コーナーテスト群はすべて
// backingRangeなしの薄壁で解決されている）。この経路を固定するため合成フィクスチャで検証する。
// Aの下地オーナー壁(A-owner)に、反対側のペア壁(A-thin、backingRangeなし)を追加し、
// faceCutsがA-owner単独のmaterialRangeより広い「ペア込みの全材幅」になることを確認する。
// ==================================================================
test('resolveWallTJunctions: faceCutsはAの全材幅（所有権ペアのthin側を含む）・finCutsはAの下地幅になる', () => {
  const b = stubWall({
    id: 'B-up', isVertical: false, axis: 2000, face: 1925,
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 },
    materialRange: { lo: 1925, hi: 2062.5 },
  });
  const aOwner = abuttingWallFromAbove(); // id: A-vert, materialRange[2437.5,2575]
  // A側の所有権ペア（反対側のthin壁）: 同じ軸・同じ長さ方向スパンで反対faceDir。
  const aThin = stubWall({
    id: 'A-vert-thin', isVertical: true, axis: 2500, face: 2425, faceDir: -1,
    coord1: 0, coord2: 1925,
    backingRange: null, materialRange: { lo: 2425, hi: 2437.5 },
  });

  const result = resolveWallTJunctions([aOwner, aThin, b]);

  assert.deepEqual(result.get('B-up')?.finCuts, [[2437.5, 2562.5]],
    'finCutsはAの下地幅（従来どおり）のはず');
  assert.deepEqual(result.get('B-up')?.faceCuts, [[2425, 2575]],
    'faceCutsはAownerとAthinを合わせた全材幅（面から面まで）のはず');
});

// ==================================================================
// resolveWallFinSegments（fin線セグメントの延長・切り欠き）のテスト。
// ShapesLayer.jsx（写像するだけ）が下していた「延長するか・どこを切り欠くか」の判断を
// ここへ集約したもの。以前はレンダラ内にインラインで書かれ無テストだった
// （QA指摘: capSuppressの写像を無視する変異・finEndのMath.min/max写像を削除する変異の
// どちらでも全緑だった）。
// ==================================================================

test('resolveWallFinSegments: finEndがあれば物理端(lo/hi)から始まる/終わるセグメントを延長する', () => {
  const result = resolveWallFinSegments({
    segments: [[0, 800], [1200, 3000]], lo: 0, hi: 3000,
    finEnd: { lo: -12.5, hi: 3012.5 }, finCuts: [], columnFinCuts: [],
  });
  assert.deepEqual(result, [[-12.5, 800], [1200, 3012.5]]);
});

// ---- 出隅対応（2026-09）: finEndは延長とは限らず短縮もありうる。物理端の内側（壁の
// スパン内）を指す値でも、Math.min/maxではなく端点そのものを置き換える ----
test('resolveWallFinSegments: finEndが物理端より内側なら短縮する（出隅）', () => {
  const result = resolveWallFinSegments({
    segments: [[0, 3000]], lo: 0, hi: 3000,
    finEnd: { hi: 2955 }, finCuts: [], columnFinCuts: [],
  });
  assert.deepEqual(result, [[0, 2955]]);
});

// ---- 失敗系: 相手のfin平面が自分のスパンの外にある退化配置で線が反転しない ----
test('【失敗系】resolveWallFinSegments: 短縮先が反対側の端を越える退化配置ではlo>hiに反転せず元のまま', () => {
  // hi端をfinEnd.hi=-5（もう一方の端lo=0より内側/外側）へ動かそうとすると反転する
  const result = resolveWallFinSegments({
    segments: [[0, 10]], lo: 0, hi: 10,
    finEnd: { hi: -5 }, finCuts: [], columnFinCuts: [],
  });
  assert.deepEqual(result, [[0, 10]], '反転するくらいなら変更せず元のセグメントのままのはず');
});

test('【失敗系】resolveWallFinSegments: 両端の置き換えが組み合わさって反転する退化配置でも元のまま', () => {
  const result = resolveWallFinSegments({
    segments: [[0, 10]], lo: 0, hi: 10,
    finEnd: { lo: 8, hi: 2 }, finCuts: [], columnFinCuts: [],
  });
  assert.deepEqual(result, [[0, 10]]);
});

// ---- 実バグ（QA実行確認）: 壁端とツライチの開口があると、開口で分割された最初/最後の
// セグメントは物理端(lo/hi)から始まらない。インデックス（i===0/i===segCount-1）だけで
// 延長すると、この生き残りセグメントまで延長してしまい、fin線が開口を横断して描かれる
// （例: 開口[0,800]がある壁でfinEnd.lo=-12.5だと、修正前は[800,3000]が
// [-12.5,3000]になり開口を丸ごと横切っていた）----
test('【失敗系】resolveWallFinSegments: 壁端とツライチの開口があるとfinEndは適用されない（開口を横断しない）', () => {
  // 開口[0,800]により、生き残るセグメントは[800,3000]のみ（lo=0からは始まらない）
  const result = resolveWallFinSegments({
    segments: [[800, 3000]], lo: 0, hi: 3000,
    finEnd: { lo: -12.5 }, finCuts: [], columnFinCuts: [],
  });
  assert.deepEqual(result, [[800, 3000]],
    '最初のセグメントが物理端(lo=0)から始まっていないため延長されないはず');
});

// ---- 実バグ（QA実行確認）: 柱壁カットが壁の物理端に接する区間を含む場合、先に延長してから
// カットすると、延長分だけが柱の仕上げ包みの外側に孤立した切れ端として残る
// （例: columnFinCuts=[[0,50]]でlo端に接する場合、延長後[-12.5,3000]を[0,50]で切ると
// [-12.5,0]という12.5mmの孤立断片が残ってしまう）----
test('【失敗系】resolveWallFinSegments: 柱壁カットが物理端に接する場合はその端を延長しない（孤立断片を残さない）', () => {
  const result = resolveWallFinSegments({
    segments: [[0, 3000]], lo: 0, hi: 3000,
    finEnd: { lo: -12.5 }, finCuts: [], columnFinCuts: [[0, 50]],
  });
  assert.deepEqual(result, [[50, 3000]],
    'lo端は柱カットに接するため延長せず、[-12.5,0]の孤立断片が残らないはず');
});

test('resolveWallFinSegments: 柱壁カットが物理端に接しない場合は通常どおり延長してから切り欠く', () => {
  const result = resolveWallFinSegments({
    segments: [[0, 3000]], lo: 0, hi: 3000,
    finEnd: { lo: -12.5 }, finCuts: [], columnFinCuts: [[1000, 1050]],
  });
  assert.deepEqual(result, [[-12.5, 1000], [1050, 3000]]);
});

test('resolveWallFinSegments: finCuts（T字通し壁側の下地幅カット）も従来どおり切り欠く', () => {
  const result = resolveWallFinSegments({
    segments: [[0, 3000]], lo: 0, hi: 3000,
    finEnd: {}, finCuts: [[1000, 1050]], columnFinCuts: [],
  });
  assert.deepEqual(result, [[0, 1000], [1050, 3000]]);
});

// ==================================================================
// isCapSuppressed（cap線を抑止するかの判定）のテスト。
// ==================================================================

test('isCapSuppressed: baseExtendが立つ物理端（i===0のlo・末尾segのhi）は抑止する', () => {
  assert.equal(isCapSuppressed('lo', 0, 3, { baseExtend: { lo: 100 }, capSuppress: {} }), true);
  assert.equal(isCapSuppressed('hi', 2, 3, { baseExtend: { hi: 100 }, capSuppress: {} }), true);
});

test('isCapSuppressed: capSuppressが立つ物理端も抑止する（baseExtendが無くても）', () => {
  assert.equal(isCapSuppressed('lo', 0, 3, { baseExtend: {}, capSuppress: { lo: true } }), true);
  assert.equal(isCapSuppressed('hi', 2, 3, { baseExtend: {}, capSuppress: { hi: true } }), true);
});

test('【失敗系】isCapSuppressed: 開口で分割された中間セグメント境界（物理端でない）は抑止しない', () => {
  // segCount=3のうちi===1（中間）はどちらのフラグが立っていても対象外
  assert.equal(isCapSuppressed('lo', 1, 3, { baseExtend: { lo: 100 }, capSuppress: { lo: true } }), false);
  assert.equal(isCapSuppressed('hi', 1, 3, { baseExtend: { hi: 100 }, capSuppress: { hi: true } }), false);
});

test('【失敗系】isCapSuppressed: どちらのフラグも立たない物理端は抑止しない', () => {
  assert.equal(isCapSuppressed('lo', 0, 3, { baseExtend: {}, capSuppress: {} }), false);
  assert.equal(isCapSuppressed('hi', 2, 3, { baseExtend: {}, capSuppress: {} }), false);
});

// ==================================================================
// パス3（fin線の直交壁下地貫通防止）のテスト。
// ユーザー確定仕様「fin線は、直交する壁の下地を横切る区間を描かない」。判定はT字の分類
// （コーナー除外・突き当たり判定等）に依存せず、幾何のみ——「Wのfin線位置(finBoundary)に、
// 直交壁Vの物理長さ（baseExtendで延長済み）が実際に届いているか」。
// ==================================================================

// ---- 出隅フィクスチャ（実機指摘の代表例そのもの。1階 CL x=-3000 × CL y=-2000）----
// 7763d6（水平オーナー壁・faceDir=+1・fin y=-1955）とd288b5（垂直オーナー壁・
// backingRange x=[-3045,-2955]）が出隅で取り合う。パス1はCORNER_EXCLUSION（150mm）で
// 両方向とも対象外になる（aAxisPosが相手の端から150mm以内）ため、finCutsはパス3由来のみ。
function realH7763d6() {
  return stubWall({
    id: 'H-7763d6', isVertical: false, axis: -2000, face: -1942.5, faceDir: 1,
    coord1: -6142.5, coord2: -2942.5,
    backingRange: { lo: -2045, hi: -1955 }, materialRange: { lo: -2045, hi: -1942.5 },
  });
}
function realVd288b5() {
  return stubWall({
    id: 'V-d288b5', isVertical: true, axis: -3000, face: -2942.5, faceDir: 1,
    coord1: -3500, coord2: -1942.5,
    backingRange: { lo: -3045, hi: -2955 }, materialRange: { lo: -3045, hi: -2942.5 },
  });
}

test('resolveWallTJunctions【パス3】: 出隅（実機指摘の代表例）は両壁のfinCutsに相手の下地帯が入る', () => {
  const result = resolveWallTJunctions([realH7763d6(), realVd288b5()]);

  // パス1（T字）はCORNER_EXCLUSIONでこの隅を対象外にする（対角なので双方向とも
  // aAxisPosが相手壁の端から150mm以内）——finCutsはパス3由来のみのはず。
  assert.deepEqual(result.get('H-7763d6')?.finCuts, [[-3045, -2955]],
    '7763d6のfin線からd288b5の下地帯[-3045,-2955]が差し引かれるはず');
  assert.deepEqual(result.get('V-d288b5')?.finCuts, [[-2045, -1955]],
    'd288b5のfin線から7763d6の下地帯[-2045,-1955]が差し引かれるはず');
  // パス3はfaceCutsを一切変更しない（ユーザーが対象外とした型を動かさない）。
  assert.deepEqual(result.get('H-7763d6')?.faceCuts ?? [], []);
  assert.deepEqual(result.get('V-d288b5')?.faceCuts ?? [], []);
});

test('resolveWallLines相当（resolveWallFinSegments経由）: 出隅の最終finSegmentsが実機指摘どおりに短縮される', () => {
  const result = resolveWallTJunctions([realH7763d6(), realVd288b5()]);

  const hSeg = resolveWallFinSegments({
    segments: [[-6142.5, -2942.5]], lo: -6142.5, hi: -2942.5,
    finEnd: result.get('H-7763d6').finEnd, finCuts: result.get('H-7763d6').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(hSeg, [[-6142.5, -3045]],
    '7763d6のfin線はx=-3045で終わるはず（従来はfinEndのみでx=-2955までだった）');

  const vSeg = resolveWallFinSegments({
    segments: [[-3500, -1942.5]], lo: -3500, hi: -1942.5,
    finEnd: result.get('V-d288b5').finEnd, finCuts: result.get('V-d288b5').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(vSeg, [[-3500, -2045]],
    'd288b5のfin線はy=-2045で終わるはず（従来はfinEndのみでy=-1955までだった）');
});

// ---- 2026-09 実機指摘（回帰）: 外壁出隅（isExteriorWall:true同士）はパス3の除外対象。
// 1階の実座標そのもの（北の外壁011027・西の外壁e5a22a）。backingDepthが既定式由来で
// CL中心の90mm帯になり、材は外側半分だけという実データの形をそのまま再現する。
// パス1はCORNER_EXCLUSIONで対象外（上のH-7763d6/V-d288b5と同じ理由）、パス2は出隅として
// 両者のfinEndを互いのfinBoundary（角の交点）へ合わせる——ここまでは室内壁の出隅と同じだが、
// パス3の下地貫通カットだけは外壁どうしなので発火してはならない。 ----
function realExteriorH011027() {
  return stubWall({
    id: '011027', isVertical: false, axis: -7000, face: -7057.5, faceDir: -1,
    coord1: -8057.5, coord2: 7057.5,
    backingRange: { lo: -7045, hi: -6955 }, materialRange: { lo: -7057.5, hi: -7000 },
    isExteriorWall: true,
  });
}
function realExteriorVe5a22a() {
  return stubWall({
    id: 'e5a22a', isVertical: true, axis: -8000, face: -8057.5, faceDir: -1,
    coord1: -7057.5, coord2: 57.5,
    backingRange: { lo: -8045, hi: -7955 }, materialRange: { lo: -8057.5, hi: -8000 },
    isExteriorWall: true,
  });
}

test('resolveWallTJunctions【パス3の例外】: 外壁どうしの出隅（実機指摘の代表例）はfinCutsに相手の下地帯を積まない', () => {
  const result = resolveWallTJunctions([realExteriorH011027(), realExteriorVe5a22a()]);

  // 室内壁どうし（上のH-7763d6/V-d288b5）と幾何構造は同型だが、両方isExteriorWall:trueの
  // ためパス3は発火しないはず——finCutsは空。
  assert.deepEqual(result.get('011027')?.finCuts ?? [], [],
    '外壁どうしの出隅ではfinCutsを積まないはず（外壁の仕上げは角で回り込んで取り合うため）');
  assert.deepEqual(result.get('e5a22a')?.finCuts ?? [], [],
    '外壁どうしの出隅ではfinCutsを積まないはず（外壁の仕上げは角で回り込んで取り合うため）');
  // パス2（出隅）は室内壁と同じく機能し、互いのfin線の端点を相手のfinBoundary（角の交点）へ合わせる。
  assert.equal(result.get('011027')?.finEnd.lo, -8045, '011027のfin線端点はe5a22aのfinBoundary(-8045)に合うはず');
  assert.equal(result.get('e5a22a')?.finEnd.lo, -7045, 'e5a22aのfin線端点は011027のfinBoundary(-7045)に合うはず');
});

test('resolveWallFinSegments経由: 外壁出隅の最終finSegmentsが角の交点(-8045,-7045)まで届く', () => {
  const result = resolveWallTJunctions([realExteriorH011027(), realExteriorVe5a22a()]);

  const hSeg = resolveWallFinSegments({
    segments: [[-8057.5, 7057.5]], lo: -8057.5, hi: 7057.5,
    finEnd: result.get('011027').finEnd, finCuts: result.get('011027').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(hSeg, [[-8045, 7057.5]],
    '011027のfin線はx=-8045まで届くはず（パス3で切り欠かれ-7955止まりになる回帰が無いこと）');

  const vSeg = resolveWallFinSegments({
    segments: [[-7057.5, 57.5]], lo: -7057.5, hi: 57.5,
    finEnd: result.get('e5a22a').finEnd, finCuts: result.get('e5a22a').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(vSeg, [[-7045, 57.5]],
    'e5a22aのfin線はy=-7045まで届くはず（パス3で切り欠かれ-6955止まりになる回帰が無いこと）');
});

// ---- 失敗系: 片方だけ外壁（外壁と室内壁が取り合う一般的な出隅）は従来どおり切り欠く ----
// 除外条件は`&&`（両方とも外壁の組だけを除外）——`||`に広げると本ケースまで誤って
// 除外してしまう（変異テストで固定）。
test('【失敗系】resolveWallTJunctions【パス3】: 外壁と室内壁が取り合う出隅は片方だけ外壁でも従来どおり切り欠く', () => {
  const exterior = { ...realExteriorH011027(), isExteriorWall: true };
  const interior = { ...realExteriorVe5a22a(), isExteriorWall: false };

  const result = resolveWallTJunctions([exterior, interior]);

  assert.deepEqual(result.get('011027')?.finCuts, [[-8045, -7955]],
    '片方だけ外壁（相手は室内壁扱い）なら除外せず従来どおりVの下地帯を積むはず');
  assert.deepEqual(result.get('e5a22a')?.finCuts, [[-7045, -6955]],
    '片方だけ外壁（自分は室内壁扱い）なら除外せず従来どおりWの下地帯を積むはず');
});

// ---- 2026-09 QA指摘（ブロッカー修正）: X字除外ガードは「fbからVの端までの距離」ではなく
// パス1と同じ語彙「Vの端点がWの材(materialRange)に触れているか」で判定する。前者は出隅の
// 代表例で常にW自身のwallFinishと一致してしまい、実質「Wの仕上げ厚が30mm以下」というガードに
// なる——fin線が下地を横切る量(backingDepth)は仕上げ厚と無関係に一定のため、仕上げ厚が
// TOUCH_TOLERANCE(30mm)を超える壁（せっこうボード+外壁石材等）でガードが誤って沈黙し、
// 修正前のバグがそのまま再発する。以下はwallFinishをテーブル化してこれを固定する。 ----
function convexAtWallFinish(wallFinish) {
  const half = 45; // backingDepth=90の半分。仕上げ厚に関わらず一定
  const face = half + wallFinish; // 出隅はcloseConvexCornersで端点がfaceへスナップされる
  const v = stubWall({
    id: 'V-thick', isVertical: true, axis: 0, face, faceDir: 1, wallFinish,
    coord1: -6000, coord2: face,
    backingRange: { lo: -half, hi: half }, materialRange: { lo: -half, hi: face },
  });
  const h = stubWall({
    id: 'H-thick', isVertical: false, axis: 0, face, faceDir: 1, wallFinish,
    coord1: -6000, coord2: face,
    backingRange: { lo: -half, hi: half }, materialRange: { lo: -half, hi: face },
  });
  return { v, h };
}

test('resolveWallTJunctions【パス3】: 仕上げ厚が30mmを超える出隅でもfin線が相手の下地を横切らない（テーブル駆動）', () => {
  for (const wallFinish of [12.5, 42.5]) {
    const { v, h } = convexAtWallFinish(wallFinish);
    const result = resolveWallTJunctions([v, h]);

    const vSeg = resolveWallFinSegments({
      segments: [[-6000, v.coord2]], lo: -6000, hi: v.coord2,
      finEnd: result.get('V-thick')?.finEnd ?? {}, finCuts: result.get('V-thick')?.finCuts ?? [], columnFinCuts: [],
    });
    assert.deepEqual(vSeg, [[-6000, -45]],
      `wallFinish=${wallFinish}: fin線は相手(h)の下地帯[-45,45]を横切らず-45で終わるはず`);

    const hSeg = resolveWallFinSegments({
      segments: [[-6000, h.coord2]], lo: -6000, hi: h.coord2,
      finEnd: result.get('H-thick')?.finEnd ?? {}, finCuts: result.get('H-thick')?.finCuts ?? [], columnFinCuts: [],
    });
    assert.deepEqual(hSeg, [[-6000, -45]],
      `wallFinish=${wallFinish}: fin線は相手(v)の下地帯[-45,45]を横切らず-45で終わるはず`);
  }
});

// fin線が描かれない壁（finVisible===false）はパス3の対象外——切るべき線が無いのに finCuts を
// 積むと、意図が読めない死んだ区間が残る。パス2側には同趣旨のテストがあるが、パス3側は
// 無検証だった（QA指摘2026-09）。相手側（V）のカットは従来どおり発火することも同時に確認し、
// ガードがW側にだけ効いていることを示す。
test('【失敗系】resolveWallTJunctions【パス3】: fin線が描かれない壁（finVisible===false）はfinCutsを持たない', () => {
  const { v } = convexAtWallFinish(12.5);
  // W側だけ wallFinish=0（fin線が描かれない壁）に差し替える。材は下地のみで面は下地端に一致するが、
  // 長さ方向の端(coord2)は出隅の相手(V)の面=57.5のまま——長さは自分の厚みとは独立に決まるため。
  const hNoFin = stubWall({
    id: 'H-thick', isVertical: false, axis: 0, face: 45, faceDir: 1, wallFinish: 0,
    coord1: -6000, coord2: 57.5,
    backingRange: { lo: -45, hi: 45 }, materialRange: { lo: -45, hi: 45 },
  });
  const result = resolveWallTJunctions([v, hNoFin]);
  assert.deepEqual(result.get('H-thick')?.finCuts ?? [], [],
    'fin線を持たないWにはパス3のfinCutsを積まないはず');
  assert.deepEqual(result.get('V-thick')?.finCuts ?? [], [[-45, 45]],
    '相手(V)側のカットは従来どおり発火するはず（ガードはW側にだけ効く）');
});

// ---- 2026-09 QA指摘: パス1のbodySide除外（反対側からの突き当たりはface/finともにカットしない）
// は「Aがどちら側から来たか」で判定するため、Aが実際にBの遠位面まで貫通していてもface/finとも
// カットしない。パス3は幾何のみで判定するため、この場合fin線は切られる（face線はパス3が
// 一切変更しないため引き続き連続のまま）——現在の意図（bodySide除外はfaceの分断防止が目的で、
// fin線の直交壁下地貫通防止という別のユーザー確定仕様には及ばない）を明文化して固定する ----
test('【失敗系】resolveWallTJunctions: 反対側から通し壁の遠位面まで貫通する壁は、fin線は切るがface線は切らない', () => {
  const b = throughWallFacingDown(); // 仕上げ面は下側（dの側）
  // 上側（dと反対側）から来て、Bの遠位面(2075=仕上げ面)まで貫通する（本来のabuttingWallFromAboveは
  // 手前の1925で止まるが、ここでは実際に貫通しているケースを作る）。
  const a = { ...abuttingWallFromAbove(), coord2: 2075 };

  const result = resolveWallTJunctions([a, b]);

  assert.deepEqual(result.get('B-down')?.finCuts, [[2437.5, 2562.5]],
    'パス1のbodySide除外は反対側からの突き当たりを除外するが、パス3は幾何のみで判定するため'
    + 'Aが実際にBの遠位面まで貫通していればfin線は切られるはず');
  assert.deepEqual(result.get('B-down')?.faceCuts ?? [], [],
    'face線はパス1のbodySide除外の対象のまま——パス3はfaceCutsを一切変更しないため連続を保つはず');
});

// ---- 2026-09 QA指摘: パス1とパス3が同じ端で重複してfinCutsを積んでも、subtractIntervalsの
// 冪等性によりfinSegmentsは単一カット時と同じになることを明示的に固定する ----
test('resolveWallTJunctions: パス1とパス3が同じ端で重複して積んでもfinSegmentsは単一カット時と同じ', () => {
  const b = stubWall({
    id: 'B-dup', isVertical: false, axis: 2000, face: 1925, faceDir: -1,
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 }, materialRange: { lo: 1925, hi: 2062.5 },
  });
  // aは仕上げ面側から突き当たる（パス1発火）上に、Bのfin境界(1937.5)をわずかに
  // (2.5mm)越えて止まっているためパス3も同一区間[2437.5,2562.5]を独立に積む
  // →finCutsに重複が生じる（このずれはX字除外ガードの閾値30mmより十分小さく、
  // ガードの実装差とは無関係に重複が起きることを固定する）。
  const a = { ...abuttingWallFromAbove(), coord2: 1940 };

  const result = resolveWallTJunctions([a, b]);

  assert.deepEqual(result.get('B-dup')?.finCuts, [[2437.5, 2562.5], [2437.5, 2562.5]],
    '前提: パス1・パス3の双方が同一区間を積むため重複するはず');

  const seg = resolveWallFinSegments({
    segments: [[0, 7000]], lo: 0, hi: 7000,
    finEnd: result.get('B-dup').finEnd, finCuts: result.get('B-dup').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(seg, [[0, 2437.5], [2562.5, 7000]],
    '重複したカットでもfinSegmentsは単一カット時と同じ結果になるはず（subtractIntervalsの冪等性）');
});

// ---- 回帰ゲート: T字（実測4枚。CL x=2500×CL y=-5000）はパス3で一切変化しない ----
test('resolveWallTJunctions【回帰】: T字（実測4枚）はパス3が発火せずfinCuts・finSegmentsとも無変更', () => {
  const result = resolveWallTJunctions([realVThin(), realVOwner(), realHThinLeft(), realHThinRight()]);

  for (const id of ['V-thin', 'V-owner', 'H-thin-left', 'H-thin-right']) {
    assert.deepEqual(result.get(id)?.finCuts ?? [], [], `${id}: パス3のfinCutsは空のはず`);
  }

  const hLeftSeg = resolveWallFinSegments({
    segments: [[57.5, 2442.5]], lo: 57.5, hi: 2442.5,
    finEnd: result.get('H-thin-left').finEnd, finCuts: result.get('H-thin-left').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(hLeftSeg, [[57.5, 2455]]);

  const vThinSeg = resolveWallFinSegments({
    segments: [[-6942.5, -5057.5]], lo: -6942.5, hi: -5057.5,
    finEnd: result.get('V-thin').finEnd, finCuts: result.get('V-thin').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(vThinSeg, [[-6942.5, -5045]]);

  const hRightSeg = resolveWallFinSegments({
    segments: [[2557.5, 4442.5]], lo: 2557.5, hi: 4442.5,
    finEnd: result.get('H-thin-right').finEnd, finCuts: result.get('H-thin-right').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(hRightSeg, [[2545, 4442.5]]);

  const vOwnerSeg = resolveWallFinSegments({
    segments: [[-6942.5, -5057.5]], lo: -6942.5, hi: -5057.5,
    finEnd: result.get('V-owner').finEnd, finCuts: result.get('V-owner').finCuts, columnFinCuts: [],
  });
  assert.deepEqual(vOwnerSeg, [[-6942.5, -5045]]);
});

// ---- 回帰ゲート: 入隅（薄壁どうし）は下地を持つ壁が無いためパス3が対象にならず、
// 12.5mmの延長（入隅のfinEnd）がそのまま保たれる ----
test('resolveWallTJunctions【回帰】: 入隅（薄壁どうし）はパス3が対象外で12.5mm延長が保たれる', () => {
  const result = resolveWallTJunctions([realVThin(), realHThinLeft()]);

  assert.deepEqual(result.get('H-thin-left')?.finCuts ?? [], []);
  assert.deepEqual(result.get('V-thin')?.finCuts ?? [], []);
  assert.equal(result.get('H-thin-left')?.finEnd.hi, 2455);
  assert.equal(result.get('V-thin')?.finEnd.hi, -5045);
});

// ---- 失敗系: 直交壁の下地範囲がfin線の位置を含まない（すれ違い）は対象外 ----
test('【失敗系】resolveWallTJunctions【パス3】: 直交壁の長さ方向スパンがfin線の位置に届かない（すれ違い）は対象外', () => {
  const w = stubWall({
    id: 'W-far', isVertical: false, axis: 0, face: 57.5, faceDir: 1,
    coord1: 0, coord2: 7000,
    backingRange: { lo: -45, hi: 45 }, materialRange: { lo: -45, hi: 57.5 },
  }); // finBoundary = 57.5-12.5 = 45
  const v = stubWall({
    id: 'V-far', isVertical: true, axis: 5500, face: 5557.5, faceDir: 1,
    coord1: 5000, coord2: 6000, // wのfinBoundary(45)から遠く離れた長さ方向スパン
    backingRange: { lo: 5455, hi: 5545 }, materialRange: { lo: 5455, hi: 5557.5 },
  });

  const result = resolveWallTJunctions([w, v]);

  assert.deepEqual(result.get('W-far')?.finCuts ?? [], []);
});

// ---- 失敗系: Vが薄壁（backingRangeなし）なら貫通先の下地が無いため対象外 ----
test('【失敗系】resolveWallTJunctions【パス3】: 直交壁が薄壁（backingRangeなし）なら対象外', () => {
  const w = stubWall({
    id: 'W-thin-guard', isVertical: false, axis: 0, face: 57.5, faceDir: 1,
    coord1: -6000, coord2: 57.5,
    backingRange: { lo: -45, hi: 45 }, materialRange: { lo: -45, hi: 57.5 },
  });
  const vThinCandidate = stubWall({
    id: 'V-thin-candidate', isVertical: true, axis: 0, face: 57.5, faceDir: 1,
    coord1: -6000, coord2: 57.5, // wのfinBoundary(45)を含む長さ方向スパン・端点も近い
    backingRange: null, materialRange: { lo: 0, hi: 57.5 },
  });

  const result = resolveWallTJunctions([w, vThinCandidate]);

  assert.deepEqual(result.get('W-thin-guard')?.finCuts ?? [], [],
    '薄壁（backingRangeなし）は貫通先の下地が無いため対象外のはず');
});

// ---- 失敗系: baseExtendで延長した下地だけがfin線に掛かる場合に切り欠きが起きる
// （生のcoordだけでは掛からない）----
test('【失敗系】resolveWallTJunctions【パス3】: 生のcoordではなくbaseExtendで延長した下地だけがfin線に掛かる場合に切り欠きが起きる', () => {
  // x: 通し壁（軸y=2000・仕上げ面が上側y=1925）。vはこれに仕上げ面側から突き当たり、
  // パス1でbaseExtend.hi=1937.5（xの下地近位面）まで延長される（既存テストと同じ数値）。
  const x = stubWall({
    id: 'X-through', isVertical: false, axis: 2000, face: 1925, faceDir: -1,
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 }, materialRange: { lo: 1925, hi: 2062.5 },
  });
  const v = abuttingWallFromAbove(); // id: A-vert, coord2=1925で終端 → xとのT字でbaseExtend.hi=1937.5

  // wGap: vの生のcoord(0..1925)には届かないが、延長後(0..1937.5)には届く位置に
  // finBoundary(1930)を持つ、xとは別の水平壁（下地あり）。
  const wGap = stubWall({
    id: 'W-gap', isVertical: false, axis: 1900, face: 1942.5, faceDir: 1,
    coord1: 0, coord2: 7000,
    // 薄壁（backingRangeなし）にする——backingRangeを持たせるとパス1の「b」候補に
    // 混入し、vのbaseExtend.hiがxではなくwGap自身の値で上書きされてしまう
    // （パス1は同一端に複数のb候補があると無条件で上書きするため。実際に検出した混線）。
    // wGapはパス3で「W（切られる側）」の役にしか使わないため、backingは不要。
    backingRange: null, materialRange: { lo: 1930, hi: 1942.5 },
  });

  const result = resolveWallTJunctions([x, v, wGap]);

  assert.equal(result.get('A-vert')?.baseExtend.hi, 1937.5, '前提: vはxとのT字でbaseExtend.hi=1937.5を持つはず');
  assert.deepEqual(result.get('W-gap')?.finCuts, [[2437.5, 2562.5]],
    'vの生のcoord(1925)はwGapのfinBoundary(1930)に届かないが、延長後(1937.5)は届くため切り欠かれるはず');
  assert.deepEqual(result.get('W-gap')?.faceCuts ?? [], [], 'パス3はfaceCutsを一切変更しないはず');
});

// ---- 失敗系: 自壁の下地では自分のfin線を切らない（相手がいなければ発火しようがない）----
test('【失敗系】resolveWallTJunctions【パス3】: 相手のいない壁単体は自分の下地で自分のfin線を切らない', () => {
  const solo = stubWall({
    id: 'Solo-owner', isVertical: false, axis: 0, face: 57.5, faceDir: 1,
    coord1: -6000, coord2: 57.5,
    backingRange: { lo: -45, hi: 45 }, materialRange: { lo: -45, hi: 57.5 },
  });

  const result = resolveWallTJunctions([solo]);

  assert.deepEqual(result.get('Solo-owner')?.finCuts ?? [], []);
});
