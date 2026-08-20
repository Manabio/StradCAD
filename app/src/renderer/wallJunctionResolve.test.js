// resolveWallTJunctions（壁のT字取り合いの描画解決）のテスト。
// 問題: 1部屋が複数部屋に面する通し壁で、向かい側の部屋同士を区切る壁が軸CLへ
// 突き当たると、通し壁の「反対側」の仕上げ面線までカットされ分断されて見えた
// （仕様は「A側の仕上げのみカット・反対側は連続」——モジュール冒頭コメント参照）。
//
// 数値は wallGeneration.js の既定生成（wallBase=100・wallFinish=12.5 → axisOffset=±75、
// オーナー下地帯は軸±62.5）に合わせる。座標系は実アプリ同様 y軸下向き正・単位mm。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWallTJunctions } from './wallJunctionResolve.js';

// 最小スタブ壁（resolveWallTJunctions が参照するフィールドのみ）。
// faceDir は既定では axisOffset の符号から導出するが、CL偏芯壁（finishSide 明示で
// sign(axisOffset) と食い違う。core/wall.js faceDirOr 参照）は明示指定する。
function stubWall({ id, isVertical, axis, face, coord1, coord2, backingRange, materialRange, wallFinish = 12.5, faceDir = null }) {
  return {
    id, isVertical, wallFinish, coord1, coord2,
    axisValue: face,
    axisCL: { effectiveValue: axis },
    faceDir: faceDir ?? (Math.sign(face - axis) || 1),
    backingRange, materialRange,
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

  const cuts = result.get('B-down')?.finishCuts ?? [];
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

  assert.deepEqual(result.get('B-up')?.finishCuts, [[2437.5, 2562.5]],
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
  assert.deepEqual(r1.get('B-ecc')?.finishCuts, [[2437.5, 2562.5]],
    '仕上げ面側（faceDir側）からの突き当たりはカットされるはず');

  // A2: 反対側（−側・上）から下りてきて下地遠位面 1850 で終端 → カットされない
  const a2 = stubWall({
    id: 'A-minus', isVertical: true, axis: 2500, face: 2575,
    coord1: 0, coord2: 1850,
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });
  const r2 = resolveWallTJunctions([a2, makeB()]);
  assert.deepEqual(r2.get('B-ecc')?.finishCuts ?? [], [],
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
  assert.deepEqual(result.get('B-down')?.finishCuts, [[2437.5, 2562.5]]);
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
test('【失敗系】resolveWallTJunctions: 素通りする壁（X字）は仕上げをカットしない', () => {
  const b = throughWallFacingDown();
  const a = stubWall({
    id: 'A-cross', isVertical: true, axis: 2500, face: 2575,
    coord1: 0, coord2: 5000, // Bをまたいで通過（端点はBの材から遠い）
    backingRange: { lo: 2437.5, hi: 2562.5 },
    materialRange: { lo: 2437.5, hi: 2575 },
  });

  const result = resolveWallTJunctions([a, b]);

  assert.deepEqual(result.get('B-down')?.finishCuts ?? [], []);
});
