// planWallRegion（壁仕上げ材の線を材の領域の合併境界として解く）のテスト。
//
// 数値は実機（11.stq 1階）と wallJunctionResolve.test.js のフィクスチャに合わせる。
// 出隅の期待値「内側線が角の交点で1本ずつ合流し、仕上げ厚(12.5mm)ぶんの断片が残らない」は
// 境界計算の帰結ではなく、下地矩形の端を相手の内側線に置く正規化（条件A）で成り立つ——
// 短縮分岐を外すと本ファイルの出隅テストが赤になる（変異テストで確認済み）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShapeType } from '@core';
import { resolveWallRegionLines } from './planWallRegion.js';
import { resolveWallTJunctions } from './wallJunctionResolve.js';

// 最小スタブ壁（resolveWallRegionLines が読むフィールドのみ）。
function stubWall({ id, isVertical, axis, face, coord1, coord2, backingRange, materialRange,
  wallFinish = 12.5, faceDir = null, backingDepth = 90, isExteriorWall = false }) {
  return {
    id, type: ShapeType.WALL, isVertical, wallFinish, coord1, coord2, isExteriorWall,
    axisValue: face,
    axisCL: { effectiveValue: axis, extentLo: null, extentHi: null },
    faceDir: faceDir ?? (Math.sign(face - axis) || 1),
    backingDepth, backingRange, materialRange,
    color: '#000', lineWeight: 'medium', lineType: 'solid',
  };
}

// 同じ直線上（向き・位置）の線分を [lo,hi] の昇順配列で取り出す。
const at = (lines, vertical, v) => lines
  .filter(l => l.vertical === vertical && Math.abs(l.at - v) < 1e-6)
  .map(l => [l.lo, l.hi]).sort((a, b) => a[0] - b[0]);
const allLines = (result) => [...result.lines.values()].flat();
// 位置 v の直線上に、区間 (lo,hi) と重なる**妻線・木口線**（壁に直交する線）が在るか。
// 同じ位置に面線・内側線（帯の境目の継ぎ目線など）が通っていても、それは妻線ではない。
const hasCapAt = (lines, vertical, v, lo, hi) => lines
  .filter(l => l.kind === 'cap' || l.kind === 'ecap' || l.kind === 'kdcap')
  .some(l => l.vertical === vertical && Math.abs(l.at - v) < 1e-6 && l.lo < hi && l.hi > lo);

// ---- 条件Aの出隅フィクスチャ（実機 1階 CL x=-3000 × y=-2000。wallJunctionResolve.test.js と同じ数値）----
// H壁: 材 y∈[-2045,-1942.5]・下地 y∈[-2045,-1955]・x∈[-6142.5,-2942.5]（faceDir=+1・内側線 y=-1955）
// V壁: 材 x∈[-3045,-2942.5]・下地 x∈[-3045,-2955]・y∈[-3500,-1942.5]（faceDir=+1・内側線 x=-2955）
// 壁生成（closeConvexCorners）が両方の端を相手の材の遠位面まで伸ばしているため、下地矩形を
// そのまま入れると相手の仕上げ帯へ12.5mm食い込み、合併境界に12.5mmの断片が4本残る。
function realH7763d6(props = {}) {
  return stubWall({
    id: 'H-7763d6', isVertical: false, axis: -2000, face: -1942.5, faceDir: 1,
    coord1: -6142.5, coord2: -2942.5,
    backingRange: { lo: -2045, hi: -1955 }, materialRange: { lo: -2045, hi: -1942.5 }, ...props,
  });
}
function realVd288b5(props = {}) {
  return stubWall({
    id: 'V-d288b5', isVertical: true, axis: -3000, face: -2942.5, faceDir: 1,
    coord1: -3500, coord2: -1942.5,
    backingRange: { lo: -3045, hi: -2955 }, materialRange: { lo: -3045, hi: -2942.5 }, ...props,
  });
}

test('【条件A】出隅: 内側線が交点(-2955,-1955)で1本ずつ合流し、12.5mmの断片は0本', () => {
  const result = resolveWallRegionLines([realH7763d6(), realVd288b5()]);
  const lines = allLines(result);

  assert.deepEqual(at(lines, false, -1955), [[-6142.5, -2955]], 'H壁の内側線はV壁の内側線(x=-2955)で止まる');
  assert.deepEqual(at(lines, true, -2955), [[-3500, -1955]], 'V壁の内側線はH壁の内側線(y=-1955)で止まる');
  // 外側線（面線）は相手の仕上げ面まで届いて角を閉じる（妻線は面線に畳まれて別線にならない）。
  assert.deepEqual(at(lines, false, -1942.5), [[-6142.5, -2942.5]]);
  assert.deepEqual(at(lines, true, -2942.5), [[-3500, -1942.5]]);
  const fragments = lines.filter(l => l.hi - l.lo <= 12.5 + 1e-6);
  assert.deepEqual(fragments, [], '仕上げ厚ぶんの断片が残ってはいけない');
  // 下地スタッドの範囲も相手の内側線まで（伸ばすだけでなく縮める）。
  assert.deepEqual(result.backingSpans.get('H-7763d6'), [-6142.5, -2955]);
  assert.deepEqual(result.backingSpans.get('V-d288b5'), [-3500, -1955]);
});

test('端の正規化は物理端に接する区間だけ: 壁端に接する開口があれば材・下地は開口の縁で終わる', () => {
  // H壁の hi 端（x=-2942.5）に接する開口。生き残る区間 [-6142.5,-3742.5] は物理端に触れないので、
  // 相手の内側線（x=-2955）へ寄せる正規化は効かず、材も下地も開口の縁で終わる。
  const H = realH7763d6(), V = realVd288b5();
  const openingsByWall = new Map([[H.id, [{ coord1: -3742.5, coord2: -2942.5 }]]]);
  const result = resolveWallRegionLines([H, V], { openingsByWall });
  const lines = allLines(result);
  // y=-1942.5 の2本目 [-3045,-2942.5] と y=-1955 の2本目 [-3045,-2955] は、H壁の材が無くなって露出した
  // V壁の端の妻線と下地の木口（V壁の端はH壁の内側線へ寄せたまま）。
  assert.deepEqual(at(lines, false, -1942.5), [[-6142.5, -3742.5], [-3045, -2942.5]], 'H壁の面線は開口の縁で終わる');
  assert.deepEqual(at(lines, false, -1955), [[-6142.5, -3742.5], [-3045, -2955]], 'H壁の内側線も開口の縁で終わる（相手の内側線へ寄らない）');
  assert.deepEqual(at(lines, true, -3742.5), [[-2045, -1942.5]], '開口の縁に妻線が立つ');
  assert.deepEqual(at(lines, true, -2955), [[-3500, -1955]], 'V壁の内側線はH壁の内側線の位置まで届く（V壁の端は物理端）');
});

test('【失敗系】開口が壁の途中なら両端の正規化は従来どおりで、内側の端は開口の縁のまま', () => {
  const H = realH7763d6(), V = realVd288b5();
  const openingsByWall = new Map([[H.id, [{ coord1: -5000, coord2: -4200 }]]]);
  const lines = allLines(resolveWallRegionLines([H, V], { openingsByWall }));
  assert.deepEqual(at(lines, false, -1942.5), [[-6142.5, -5000], [-4200, -2942.5]]);
  assert.deepEqual(at(lines, false, -1955), [[-6142.5, -5000], [-4200, -2955]], '物理端側だけ相手の内側線で止まる');
  assert.deepEqual(at(lines, true, -5000), [[-2045, -1942.5]]);
  assert.deepEqual(at(lines, true, -4200), [[-2045, -1942.5]]);
});

test('【失敗系】内側線が描かれない壁（wallFinish不明）とは取り合わず、下地は物理端のまま', () => {
  // V壁の仕上げ厚が不明＝finishJoinBoundary が null。H壁の下地はV壁の内側線へ寄らない。
  const result = resolveWallRegionLines([realH7763d6(), realVd288b5({ wallFinish: null })]);
  assert.deepEqual(result.backingSpans.get('H-7763d6'), [-6142.5, -2942.5]);
  assert.deepEqual(at(allLines(result), false, -1955), [[-6142.5, -2942.5]]);
});

test('【失敗系】直交していても長さ方向で材に触れていない壁とは取り合わない', () => {
  // V壁をH壁の材（y∈[-2045,-1942.5]）に届かない位置で終わらせる。
  const result = resolveWallRegionLines([realH7763d6(), realVd288b5({ coord1: -3500, coord2: -2100 })]);
  assert.deepEqual(result.backingSpans.get('H-7763d6'), [-6142.5, -2942.5]);
  assert.deepEqual(result.backingSpans.get('V-d288b5'), [-3500, -2100]);
});

// ---- 対称壁（外壁）の帯。実機 1階 x=6955×y=-3600 の配置（座標はそのまま）:
//   外壁E: 対称（backingDepth=null）。材 x∈[7000,7057.5] に対し下地 x∈[6955,7045] が軸CLの内側へ45mm出る。
//   室内側の薄壁I: x∈[6942.5,6955]（ペアの対称壁ではなく12.5mmの薄壁）。
//   間仕切りH: 下地オーナー。材 y∈[-3645,-3542.5]・x∈[6257.5,7057.5]（外壁の外面まで通っている）。
//   薄壁V: x∈[6942.5,6955]・y∈[-3542.5,-57.5]。Hの面で終わる。
function exteriorBand() {
  const symmetric = (id, c1, c2) => stubWall({
    id, isVertical: true, axis: 7000, face: 7057.5, faceDir: 1, coord1: c1, coord2: c2,
    backingDepth: null, backingRange: { lo: 6955, hi: 7045 }, materialRange: { lo: 7000, hi: 7057.5 },
    isExteriorWall: true,
  });
  const thinV = (id, c1, c2) => stubWall({
    id, isVertical: true, axis: 7000, face: 6942.5, faceDir: -1, coord1: c1, coord2: c2,
    backingDepth: 0, backingRange: null, materialRange: { lo: 6942.5, hi: 6955 },
  });
  return {
    E1: symmetric('E1', -5057.5, -3542.5), E2: symmetric('E2', -4000, 57.5),
    I: thinV('I', -4942.5, -3657.5), V: thinV('V', -3542.5, -57.5),
    H: stubWall({
      id: 'H', isVertical: false, axis: -3600, face: -3542.5, faceDir: 1, coord1: 6257.5, coord2: 7057.5,
      backingRange: { lo: -3645, hi: -3555 }, materialRange: { lo: -3645, hi: -3542.5 },
    }),
  };
}

test('【条件B】対称壁の材は下地の遠位面まで広げる: 薄壁の面線が直交壁の材を素通りしない（実機 1階 x=6955）', () => {
  const w = exteriorBand();
  const lines = allLines(resolveWallRegionLines(Object.values(w)));
  // 薄壁Vの内側の面（x=6955）はHの材 y∈[-3645,-3542.5] で覆われて途切れる。
  // 下地を材で切ると x∈[6955,7000] が穴になり、Hの材がそこを覆えず x=6955 の線が素通りしていた。
  // 残るのは外壁の下地の内側辺（薄壁との継ぎ目）で、Hの下地幅 y∈[-3645,-3555] で切れ、Hの内側線
  // （y=-3555）から南へ続く（旧描画と同じ）。
  const seam = at(lines, true, 6955);
  assert.equal(seam.some(([lo, hi]) => lo < -3555 && hi > -3645), false, 'x=6955 の線はHの下地を貫かない');
  assert.ok(seam.some(([lo, hi]) => lo === -3555 && hi >= -57.5 - 1e-6), 'Hの内側線の位置から南へ薄壁Vの内側線が続く');
  // 広げた側の面（x=6955）は材の面ではないので、薄壁の無い区間（y∈[-3657.5,-3645]の駒の位置など）では出ない。
  assert.deepEqual(at(lines, true, 7000), [], '軸CL上に線は出ない');
  assert.deepEqual(at(lines, true, 7045), [[-5057.5, 57.5]], '外壁の内側線（下地／仕上げの境界）は全長で1本');
  assert.deepEqual(at(lines, true, 7057.5), [[-5057.5, 57.5]], '外壁の面線');
});

test('【条件C】柱壁は領域の覆い判定に参加する: 外形が面線を、内側境界が継ぎ目の内側線を、柱壁の区間で消す', () => {
  // 薄壁V（面 x=6942.5）の手前に立つ柱の包み。xHi 側は壁の仕上げ面へ揃えてトリム済み（外形 xHi=6942.5、
  // 仕上げ厚は相手の内側線＝x=6955 まで外へ出る負値 -12.5）。x=6955 の線は外壁E2の下地の辺として
  // E2のidで出るが、柱壁の内側境界（x∈[…,6955]）に覆われて柱壁の区間で途切れる（旧 columnWallCuts の
  // `fin` 区間と同じ）。
  const w = exteriorBand();
  const columnWraps = [{ id: 'C', outer: { xLo: 6540, xHi: 6942.5, yLo: -2000, yHi: -1500 },
    finishes: { xLo: 12.5, xHi: -12.5, yLo: 12.5, yHi: 12.5 } }];
  const result = resolveWallRegionLines(Object.values(w), { columnWraps });
  const lines = allLines(result);
  const seam = at(lines, true, 6955);
  assert.ok(seam.some(([, hi]) => hi === -1987.5) && seam.some(([lo]) => lo === -1512.5),
    'x=6955 の線は柱壁の内側境界の区間 [-1987.5,-1512.5] で切れる');
  assert.equal(seam.some(([lo, hi]) => lo < -1512.5 && hi > -1987.5), false, '柱壁の区間に線を残さない');
  const face = at(lines, true, 6942.5);
  assert.ok(face.some(([, hi]) => hi === -2000) && face.some(([lo]) => lo === -1500), '薄壁の面線は柱壁の外形の区間で切れる');
  assert.equal(face.some(([lo, hi]) => lo < -1500 && hi > -2000), false);
  assert.equal(lines.some(l => l.ids.includes('col:C')), false, '柱壁の辺は領域から出ない（StructuralLayer が描く）');
});

test('【失敗系】どの壁にも触れない柱壁は壁の線を変えない', () => {
  const w = exteriorBand();
  const base = allLines(resolveWallRegionLines(Object.values(w)));
  const withCol = allLines(resolveWallRegionLines(Object.values(w), {
    columnWraps: [{ id: 'C', outer: { xLo: 3000, xHi: 3400, yLo: -3000, yHi: -2600 }, finishes: {} }],
  }));
  assert.deepEqual(withCol, base);
});

// ---- 入隅（正面から当たるT字）: 偏芯壁どうし（実機 1階 X=-1600×Y=-6000 の座標そのまま）。
//   H: 材 y∈[-6000,-5897.5]・下地 y∈[-6000,-5910]・faceDir=+1、x∈[-2942.5,-1665]（Vの面で終わる）
//   V: 材 x∈[-1665,-1562.5]・下地 x∈[-1652.5,-1562.5]・faceDir=-1、y∈[-5897.5,-3602.5]（Hの面で終わる）
function concaveEccentric() {
  return [
    stubWall({ id: 'H', isVertical: false, axis: -6000, face: -5897.5, faceDir: 1, coord1: -2942.5, coord2: -1665,
      backingRange: { lo: -6000, hi: -5910 }, materialRange: { lo: -6000, hi: -5897.5 } }),
    stubWall({ id: 'V', isVertical: true, axis: -1500, face: -1665, faceDir: -1, coord1: -5897.5, coord2: -3602.5,
      backingRange: { lo: -1652.5, hi: -1562.5 }, materialRange: { lo: -1665, hi: -1562.5 } }),
  ];
}

test('入隅・正面からのT字は相手の下地の背面まで通す: 内側線に挟まれた下地の角の矩形が輪郭線にならない', () => {
  const lines = allLines(resolveWallRegionLines(concaveEccentric()));
  // 内側線どうしは (-1652.5,-5910) で合流する。
  assert.deepEqual(at(lines, false, -5910), [[-2942.5, -1652.5]], 'Hの内側線はVの内側線で止まる');
  assert.deepEqual(at(lines, true, -1652.5), [[-5910, -3602.5]], 'Vの内側線はHの内側線で止まる');
  // 角の矩形 x∈[-1652.5,-1562.5]×y∈[-6000,-5910] は両方の下地が通り抜けて材になり、その辺は線にならない。
  assert.equal(at(lines, false, -5910).some(([lo, hi]) => lo < -1562.5 && hi > -1652.5), false);
  assert.equal(at(lines, true, -1652.5).some(([lo, hi]) => lo < -5910 && hi > -6000), false);
  // 外側は材の境界として連続する（Hの背面 y=-6000 と Vの背面 x=-1562.5 が角で出会う）。
  assert.deepEqual(at(lines, false, -6000), [[-2942.5, -1562.5]]);
  assert.deepEqual(at(lines, true, -1562.5), [[-6000, -3602.5]]);
  // 下地スタッドの範囲は相手の内側線まで（相手の下地の中へ間柱を描かない）。
  const { backingSpans } = resolveWallRegionLines(concaveEccentric());
  assert.deepEqual(backingSpans.get('H'), [-2942.5, -1652.5]);
  assert.deepEqual(backingSpans.get('V'), [-5910, -3602.5]);
});

// ==== 旧 wallJunctionResolve.js パス1・2・3・5 が守っていた確定仕様の受け皿（2026-09 撤去時に移した）====

test('X字（素通り）: 端が相手の材の外にある壁は取り合わず、通し壁の面線も内側線も切れない', () => {
  // 縦壁Aが横壁Bを貫いて両側へ伸びる（どちらの端もBの材から遠い）。旧パス1の「素通りする壁は
  // 仕上げをカットしない」＋パス3の「X字除外」。
  const A = stubWall({ id: 'A', isVertical: true, axis: 2500, face: 2575, faceDir: 1, coord1: -3000, coord2: 7000,
    backingRange: { lo: 2437.5, hi: 2562.5 }, materialRange: { lo: 2437.5, hi: 2575 } });
  const B = stubWall({ id: 'B', isVertical: false, axis: 2000, face: 2075, faceDir: 1, coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 }, materialRange: { lo: 1937.5, hi: 2075 } });
  const result = resolveWallRegionLines([A, B]);
  const lines = allLines(result);
  assert.deepEqual(result.backingSpans.get('A'), [-3000, 7000], 'Aの端は動かない');
  // 十字に交わる材どうしなので、面線は互いの材の幅で途切れる（境界の帰結）。
  assert.deepEqual(at(lines, false, 2075), [[0, 2437.5], [2575, 7000]], 'Bの面線はAの材の幅だけ途切れる');
  assert.deepEqual(at(lines, true, 2575), [[-3000, 1937.5], [2075, 7000]], 'Aの面線はBの材の幅だけ途切れる');
  // y=1937.5 はBの背面（材の境界＝面線）とBの下地の辺が重なる位置: 背面はAの材の幅で途切れ、
  // 下地の辺はAの下地に隠れる区間を除きAの仕上げ帯の中（内側線）に残る。
  assert.deepEqual(at(lines, false, 1937.5), [[0, 2437.5], [2562.5, 2575], [2575, 7000]]);
  assert.deepEqual(at(lines, false, 2062.5), [[0, 2437.5], [2562.5, 7000]], 'Bの内側線はAの下地の幅だけ途切れる');
});

test('背面側から突き当たるT字: 通し壁の仕上げ面線は切らず、突き当たる壁の下地は相手の内側線で止まる', () => {
  // 旧パス1「反対側（軸〜下地側）から突き当たる壁は、通し壁の仕上げ面をカットしない」。
  // 通し壁B（仕上げ面が下側 y=2075）の背面 y=1937.5 へ、上から壁Aが突き当たる。
  const A = stubWall({ id: 'A', isVertical: true, axis: 2500, face: 2575, faceDir: 1, coord1: 0, coord2: 1937.5,
    backingRange: { lo: 2437.5, hi: 2562.5 }, materialRange: { lo: 2437.5, hi: 2575 } });
  const B = stubWall({ id: 'B', isVertical: false, axis: 2000, face: 2075, faceDir: 1, coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 }, materialRange: { lo: 1937.5, hi: 2075 } });
  const result = resolveWallRegionLines([A, B]);
  const lines = allLines(result);
  assert.deepEqual(at(lines, false, 2075), [[0, 7000]], 'Bの仕上げ面線は連続のまま');
  assert.deepEqual(result.backingSpans.get('A'), [0, 2062.5], 'Aの下地はBの下地を通り抜けてBの内側線で止まる');
  assert.deepEqual(at(lines, false, 2062.5), [[0, 7000]], 'Bの内側線（仕上げ／下地の境界）はAが手前で止まるので連続のまま');
  // Bの背面 y=1937.5: 材の境界（面線）はAの材の幅で途切れ、Aの仕上げ帯 [2562.5,2575] にはBの下地の辺が
  // 内側線として残る（Aの下地に隠れる [2437.5,2562.5] だけが空く＝旧パス1の finCuts と同じ幅）。
  assert.deepEqual(at(lines, false, 1937.5), [[0, 2437.5], [2562.5, 2575], [2575, 7000]]);
});

test('十字（4枚が1点に集まる）: 各象限の角が独立に閉じ、中心に妻線は出ない', () => {
  // 旧パス2「十字で各象限の隅が独立に解決される」。x=0・y=0 で4枚の薄壁（材12.5）が出会う。
  const props = { backingDepth: 0, backingRange: null };
  const walls = [
    stubWall({ id: 'N', isVertical: true, axis: 0, face: -12.5, faceDir: -1, coord1: -3000, coord2: 0, materialRange: { lo: -12.5, hi: 0 }, ...props }),
    stubWall({ id: 'S', isVertical: true, axis: 0, face: 12.5, faceDir: 1, coord1: 0, coord2: 3000, materialRange: { lo: 0, hi: 12.5 }, ...props }),
    stubWall({ id: 'W', isVertical: false, axis: 0, face: -12.5, faceDir: -1, coord1: -3000, coord2: 0, materialRange: { lo: -12.5, hi: 0 }, ...props }),
    stubWall({ id: 'E', isVertical: false, axis: 0, face: 12.5, faceDir: 1, coord1: 0, coord2: 3000, materialRange: { lo: 0, hi: 12.5 }, ...props }),
  ];
  const lines = allLines(resolveWallRegionLines(walls));
  assert.equal(lines.some(l => l.kind === 'cap' && (Math.abs(l.at) <= 12.5)), false, '中心に妻線は出ない');
  // 各象限の角は材の境界として閉じる（例: 北西の角は x=-12.5 と y=-12.5 が (-12.5,-12.5) で出会う）。
  assert.ok(at(lines, true, -12.5).some(([lo, hi]) => lo <= -3000 && hi >= -12.5));
  assert.ok(at(lines, false, -12.5).some(([lo, hi]) => lo <= -3000 && hi >= -12.5));
  assert.ok(at(lines, true, 12.5).some(([lo, hi]) => lo <= 12.5 && hi >= 3000));
  assert.ok(at(lines, false, 12.5).some(([lo, hi]) => lo <= 12.5 && hi >= 3000));
});

test('外壁どうしの出隅（実機 1階 北西）: 内側線が交点(-8045,-7045)まで届く', () => {
  // 旧パス3の例外「外壁どうしの出隅は下地帯で切り欠かず、内側線が角の交点で取り合う」。
  const north = stubWall({ id: 'N', isVertical: false, axis: -7000, face: -7057.5, faceDir: -1, coord1: -8057.5, coord2: 7057.5,
    backingDepth: null, backingRange: { lo: -7045, hi: -6955 }, materialRange: { lo: -7057.5, hi: -7000 }, isExteriorWall: true });
  const west = stubWall({ id: 'W', isVertical: true, axis: -8000, face: -8057.5, faceDir: -1, coord1: -7057.5, coord2: 7057.5,
    backingDepth: null, backingRange: { lo: -8045, hi: -7955 }, materialRange: { lo: -8057.5, hi: -8000 }, isExteriorWall: true });
  const lines = allLines(resolveWallRegionLines([north, west]));
  assert.deepEqual(at(lines, false, -7045), [[-8045, 7057.5]], '北の外壁の内側線は西の外壁の内側線 x=-8045 から');
  assert.deepEqual(at(lines, true, -8045), [[-7045, 7057.5]], '西の外壁の内側線は北の外壁の内側線 y=-7045 から');
  assert.deepEqual(at(lines, false, -7057.5), [[-8057.5, 7057.5]], '面線は角まで1本');
  assert.deepEqual(at(lines, true, -8057.5), [[-7057.5, 7057.5]]);
});

test('【失敗系】短縮先が反対側の端を越える退化配置でも例外にならず、下地の線を出さない', () => {
  // 旧 resolveWallFinSegments「反転するなら安全側に倒す」。相手の内側線が自壁の全長より奥にある
  // （壁が相手の材の中に丸ごと入っている）と、下地の端の正規化で lo>hi になる。
  const H = stubWall({ id: 'H', isVertical: false, axis: -2000, face: -1942.5, faceDir: 1, coord1: -2960, coord2: -2942.5,
    backingRange: { lo: -2045, hi: -1955 }, materialRange: { lo: -2045, hi: -1942.5 } });
  const result = resolveWallRegionLines([H, realVd288b5()]);
  assert.equal(result.backingSpans.get('H'), null, '下地の範囲は成立しない');
  assert.deepEqual(at(allLines(result), false, -1955).filter(([lo, hi]) => lo >= -2960 && hi <= -2942.5), [], 'Hの内側線は出ない');
});

test('相手の面を行き過ぎて材の中で終わる端も取り合う（端が相手の材の中にあれば内側線へ寄せる）', () => {
  // 旧パス2は「面から27.5mm行き過ぎ／手前の端」を誤検出として捨てていた（許容差30mmの都合）。
  // 領域方式は端が相手の材の中／面上にあるかだけで見るので、行き過ぎた端は相手の内側線へ短縮し、
  // 手前で止まる端（材の外）は取り合わない。
  const inside = resolveWallRegionLines([realH7763d6({ coord2: -2970 }), realVd288b5()]);
  assert.deepEqual(inside.backingSpans.get('H-7763d6'), [-6142.5, -2955], '材の中で終わる端は内側線へ');
  const outside = resolveWallRegionLines([realH7763d6({ coord2: -3060 }), realVd288b5()]);
  assert.deepEqual(outside.backingSpans.get('H-7763d6'), [-6142.5, -3060], '材の外（15mm手前）で終わる端は取り合わない');
});

test('【失敗系】薄壁だけの通し壁へ突き当たる壁は、薄壁の背面（内側線）まで材を占め、薄壁の面線をその幅で切る', () => {
  // 旧パス1は「通し壁が薄壁（下地なし）なら何もしない」（A は面で止まり、薄壁の面線は連続）だった。
  // 領域方式では薄壁も取り合いの相手（条件A）——薄壁は帯の面側の仕上げ層であり、突き当たる壁の材は
  // 相手の内側線（薄壁の背面）まで占めるので、薄壁の面線はAの材幅で途切れ、背面の線は連続する。
  // 実データでは薄壁の背後に必ずオーナー壁（下地）が在り、そこでAの下地がオーナー壁の内側線まで通る
  // （通し壁テスト参照）ため図は同じになる。単独の薄壁はフィクスチャ上の配置で、挙動をここで固定する。
  const A = stubWall({ id: 'A', isVertical: true, axis: 2500, face: 2575, faceDir: 1, coord1: 0, coord2: 1925,
    backingRange: { lo: 2437.5, hi: 2562.5 }, materialRange: { lo: 2437.5, hi: 2575 } });
  const thin = stubWall({ id: 'B', isVertical: false, axis: 2000, face: 1925, faceDir: -1, coord1: 0, coord2: 7000,
    backingDepth: 0, backingRange: null, materialRange: { lo: 1925, hi: 1937.5 } });
  const result = resolveWallRegionLines([A, thin]);
  const lines = allLines(result);
  assert.deepEqual(at(lines, false, 1925), [[0, 2437.5], [2575, 7000]], '薄壁の面線はAの材幅で途切れる');
  assert.deepEqual(at(lines, false, 1937.5), [[0, 7000]], '薄壁の背面（＝Aの端）は連続する');
  assert.deepEqual(result.backingSpans.get('A'), [0, 1937.5], 'Aの下地は薄壁の内側線まで');
  assert.deepEqual(at(lines, true, 2562.5), [[0, 1937.5]], 'Aの内側線は薄壁の背面まで届く');
});

// ==== 偏芯壁の帯との取り合い（旧 wallJunctionResolve.test.js のフィクスチャをそのまま移した）====
// 実機・1階 Y1+3500×X2: 階段下部屋の偏芯壁 y軸CL=-3500 が通り芯X2 x軸CL=-3000 の帯へ西からT字で取り合う隅。
// 帯はどちらも非対称: X2 [-3057.5,-2942.5]（薄壁＋オーナー）、階段下部屋側 [-3602.5,-3487.5]（偏芯オーナー＋薄壁）。
// 生成側のトリムが相手を1枚ずつ見るため、双方の端が**帯の境目**（-3045 / -3500）で止まっている。
// パス6（wallJunctionResolve.js）の詰めは `junctions` で渡すが、領域は外へ伸ばす分しか使わない。
const eccJunctionWalls = () => [
  stubWall({ id: 'X2-thin', isVertical: true, axis: -3000, face: -3057.5, faceDir: -1, coord1: -6942.5, coord2: -2057.5,
    backingDepth: 0, backingRange: null, materialRange: { lo: -3057.5, hi: -3045 } }),
  stubWall({ id: 'X2-owner-n', isVertical: true, axis: -3000, face: -2942.5, faceDir: 1, coord1: -6942.5, coord2: -3487.5,
    backingRange: { lo: -3045, hi: -2955 }, materialRange: { lo: -3045, hi: -2942.5 } }),
  stubWall({ id: 'X2-owner-s', isVertical: true, axis: -3000, face: -2942.5, faceDir: 1, coord1: -3500, coord2: -1942.5,
    backingRange: { lo: -3045, hi: -2955 }, materialRange: { lo: -3045, hi: -2942.5 } }),
  stubWall({ id: 'ecc-owner', isVertical: false, axis: -3500, face: -3602.5, faceDir: -1, coord1: -3045, coord2: -1665,
    backingRange: { lo: -3590, hi: -3500 }, materialRange: { lo: -3602.5, hi: -3500 } }),
  stubWall({ id: 'ecc-thin', isVertical: false, axis: -3500, face: -3487.5, faceDir: 1, coord1: -3045, coord2: -1562.5,
    backingDepth: 0, backingRange: null, materialRange: { lo: -3500, hi: -3487.5 } }),
];

test('偏芯壁の帯どうしの隅（実機1階 Y1+3500×X2）: 面線は帯幅115・内側線は下地幅90だけ空き、帯の境目に妻線は無い', () => {
  const walls = eccJunctionWalls();
  const lines = allLines(resolveWallRegionLines(walls, { junctions: resolveWallTJunctions(walls) }));
  assert.deepEqual(at(lines, true, -2942.5), [[-6942.5, -3602.5], [-3487.5, -1942.5]], 'X2の面線は帯幅115だけ空く');
  assert.deepEqual(at(lines, true, -2955), [[-6942.5, -3590], [-3500, -1942.5]], 'X2の内側線は下地幅90だけ空く');
  assert.deepEqual(at(lines, false, -3590), [[-2955, -1665]], '偏芯壁の内側線はX2の内側線から');
  assert.equal(hasCapAt(lines, true, -3045, -3602.5, -3487.5), false, '帯の境目 x=-3045 に妻線は無い');
  // 帯の境目（X2の薄壁とオーナー壁の継ぎ目）の線は、オーナー壁の下地の辺（内側線）として薄壁の全長で
  // 1本——偏芯壁の下地は手前の内側線 x=-2955 で止まるので、境目の線はここでは切れない。薄壁が終わる
  // -2057.5 から先はオーナー壁の背面（材の境界）が面線として続く。
  assert.deepEqual(lines.filter(l => l.vertical && l.at === -3045).map(l => [l.kind, l.lo, l.hi]),
    [['fin', -6942.5, -2057.5], ['face', -2057.5, -1942.5]]);
});

// 実機・1階 Y1-3500×X2+1500: 偏芯壁の帯どうしの**出隅**。帯の外側半分どうし（どちらも仕上げのみの薄壁）が
// 角を作る。「内側同士・外側同士が取り合う」。
const eccConvexCornerWalls = () => [
  stubWall({ id: 'ecc-outer', isVertical: false, axis: -3500, face: -3487.5, faceDir: 1, coord1: -2942.5, coord2: -1562.5,
    backingDepth: 0, backingRange: null, materialRange: { lo: -3500, hi: -3487.5 } }),
  stubWall({ id: 'lane-outer', isVertical: true, axis: -1500, face: -1550, faceDir: 1, coord1: -6012.5, coord2: -3487.5,
    backingDepth: 0, backingRange: null, materialRange: { lo: -1562.5, hi: -1550 } }),
];

test('偏芯壁の帯どうしの出隅（実機1階 Y1-3500×X2+1500）: 内側線同士・外側線同士で取り合う', () => {
  const walls = eccConvexCornerWalls();
  const lines = allLines(resolveWallRegionLines(walls, { junctions: resolveWallTJunctions(walls) }));
  assert.deepEqual(at(lines, true, -1562.5), [[-6012.5, -3500]], '内側線(x=-1562.5)は相手の内側線(y=-3500)で止まる');
  assert.deepEqual(at(lines, false, -3500), [[-2942.5, -1562.5]], '内側線(y=-3500)は相手の内側線(x=-1562.5)まで');
  assert.equal(hasCapAt(lines, true, -1562.5, -3500, -3487.5), false, 'x=-1562.5 の [-3500,-3487.5] に線は無い');
  assert.deepEqual(at(lines, true, -1550), [[-6012.5, -3487.5]], '外側線は相手の外側線まで');
  assert.deepEqual(at(lines, false, -3487.5), [[-2942.5, -1550]]);
});

// ==== 天板（腰壁・垂れ壁）を高さクラスごとの領域として解く ====
// 旧 finish/kneeDropWall.js の resolveCapJoins（ユーザー確定2026-09「天板の内側・外側どうしでトリムし、
// 端部の線は描かない」）が守っていた規則を、領域の帰結として同じ数値で固定する。
// 天板の壁: 材 [0,57.5]（対称）→ 帯 [-12, 69.5]。
function capWall(id, isVertical, lo, hi, { matLo = 0, matHi = 57.5 } = {}) {
  return stubWall({
    id, isVertical, axis: matLo, face: matHi, faceDir: 1, coord1: lo, coord2: hi,
    backingDepth: null, backingRange: { lo: matLo - 45, hi: matLo + 45 }, materialRange: { lo: matLo, hi: matHi },
  });
}
const kneeOverlay = (capLo = -12, capHi = 69.5, mode = 'knee', topHeight = 900) =>
  ({ mode, capLo, capHi, ...(mode === 'knee' ? { topHeight } : {}) });
const kdLines = (result) => allLines(result).filter(l => l.kind === 'kd' || l.kind === 'kdcap');

test('天板の角: 外側の長辺は相手の帯の遠位面で、内側の長辺は近位面で出会い、端部の線は出ない', () => {
  // 横壁は-x方向へ伸びhi端(x=57.5)が角。縦壁は+y方向へ伸びlo端(y=57.5)が角＝右上(69.5,-12)が外側。
  const h = capWall('h', false, -3000, 57.5), v = capWall('v', true, 57.5, 3000);
  const overlays = new Map([['h', kneeOverlay()], ['v', kneeOverlay()]]);
  const lines = kdLines(resolveWallRegionLines([h, v], { kneeDropOverlays: overlays }));
  assert.deepEqual(at(lines, false, -12), [[-3000, 69.5]], '外側(y=-12)は相手の帯の遠位面 x=69.5 まで');
  assert.deepEqual(at(lines, false, 69.5), [[-3000, -12]], '内側(y=69.5)は相手の帯の近位面 x=-12 で止まる');
  assert.deepEqual(at(lines, true, 69.5), [[-12, 3000]], '縦壁の外側(x=69.5)は遠位面 y=-12 まで');
  assert.deepEqual(at(lines, true, -12), [[69.5, 3000]], '縦壁の内側(x=-12)は近位面 y=69.5 で止まる');
  assert.deepEqual(lines.filter(l => l.kind === 'kdcap' && (l.at === 57.5)), [], '角に端部の線は出ない');
  assert.deepEqual(at(lines, true, -3000), [[-12, 69.5]], '自由端には端部の線が出る');
});

test('天板の角: 向きが変わっても同じ（横壁が+x側へ伸び、縦壁が-y側へ伸びる角）', () => {
  const h = capWall('h', false, 57.5, 3000), v = capWall('v', true, -3000, 57.5);
  const overlays = new Map([['h', kneeOverlay()], ['v', kneeOverlay()]]);
  const lines = kdLines(resolveWallRegionLines([h, v], { kneeDropOverlays: overlays }));
  assert.deepEqual(at(lines, false, 69.5), [[-12, 3000]], '縦壁の本体は-y側＝横壁の y=69.5 が外側');
  assert.deepEqual(at(lines, false, -12), [[69.5, 3000]], 'y=-12 が内側');
  assert.deepEqual(at(lines, true, -12), [[-3000, 69.5]]);
  assert.deepEqual(at(lines, true, 69.5), [[-3000, -12]]);
});

test('天板の角: 偏芯して帯が軸CLに対し非対称でも相手の帯の面で出会う', () => {
  const h = capWall('h', false, 200, 3000), v = capWall('v', true, 69.5, 3000, { matHi: 188 });
  const overlays = new Map([['h', kneeOverlay(-12, 69.5)], ['v', kneeOverlay(-12, 200)]]);
  const lines = kdLines(resolveWallRegionLines([h, v], { kneeDropOverlays: overlays }));
  assert.deepEqual(at(lines, false, -12), [[-12, 3000]]);
  assert.deepEqual(at(lines, false, 69.5), [[200, 3000]], '内側は相手の帯の近位面 x=200');
  assert.deepEqual(at(lines, true, 200), [[69.5, 3000]]);
  assert.deepEqual(at(lines, true, -12), [[-12, 3000]]);
});

test('【失敗系】天板: 素通りするT字は角ではない——貫く側は帯の中へ伸ばさず、貫かれる側の長辺が開く', () => {
  const h = capWall('h', false, -3000, 3000), v = capWall('v', true, 57.5, 3000);
  const overlays = new Map([['h', kneeOverlay()], ['v', kneeOverlay()]]);
  const lines = kdLines(resolveWallRegionLines([h, v], { kneeDropOverlays: overlays }));
  assert.deepEqual(at(lines, false, -12), [[-3000, 3000]], '横壁の外側は通し');
  assert.deepEqual(at(lines, false, 69.5), [[-3000, -12], [69.5, 3000]], '横壁の内側は縦壁の帯の幅で開く（天端がつながる）');
  assert.deepEqual(at(lines, true, -12), [[69.5, 3000]], '縦壁の長辺は横壁の帯の面から');
  assert.equal(lines.some(l => l.kind === 'kdcap' && l.at === 57.5), false, '縦壁の端部の線は横壁の帯の中に隠れる');
});

test('【失敗系】天板: 平行・線種が違う（腰壁×垂れ壁）・高さが違う天板は畳まない', () => {
  const h1 = capWall('h1', false, 0, 3000), h2 = capWall('h2', false, 3000, 6000);
  const same = kdLines(resolveWallRegionLines([h1, h2],
    { kneeDropOverlays: new Map([['h1', kneeOverlay()], ['h2', kneeOverlay()]]) }));
  assert.deepEqual(at(same, false, -12), [[0, 6000]], '同じ線種・高さは1本に畳む');
  const style = kdLines(resolveWallRegionLines([h1, h2],
    { kneeDropOverlays: new Map([['h1', kneeOverlay()], ['h2', kneeOverlay(-12, 69.5, 'drop')]]) }));
  assert.deepEqual(at(style, false, -12), [[0, 3000], [3000, 6000]], '実線と破線は畳まない');
  const height = kdLines(resolveWallRegionLines([h1, h2],
    { kneeDropOverlays: new Map([['h1', kneeOverlay()], ['h2', kneeOverlay(-12, 69.5, 'knee', 1000)]]) }));
  assert.deepEqual(at(height, false, -12), [[0, 3000], [3000, 6000]], '高さが違えば畳まない');
});

test('天板は全高の材を差し引く: 高い壁の帯に覆われる区間を描かず、端部の線は出幅ぶんだけ残る', () => {
  // 腰壁（横・帯 y∈[-12,69.5]）を全高の縦壁（材 x∈[1000,1102.5]・y∈[0,3000]）が横切る。
  const h = capWall('h', false, -3000, 3000);
  const tall = stubWall({ id: 'tall', isVertical: true, axis: 1045, face: 1102.5, faceDir: 1, coord1: 0, coord2: 3000,
    backingRange: { lo: 1000, hi: 1090 }, materialRange: { lo: 1000, hi: 1102.5 } });
  const result = resolveWallRegionLines([h, tall], { kneeDropOverlays: new Map([['h', kneeOverlay()]]) });
  const lines = kdLines(result);
  assert.deepEqual(at(lines, false, -12), [[-3000, 1000], [1102.5, 3000]], '天板は全高の壁の材の幅で途切れる');
  assert.deepEqual(at(lines, false, 69.5), [[-3000, 1000], [1102.5, 3000]]);
  assert.deepEqual(at(lines, true, 1000), [[-12, 0]], '端部の線は全高の材の面上には出ず、出幅ぶんの外側だけ残る');
  assert.deepEqual(at(lines, true, 1102.5), [[-12, 0]]);
  assert.deepEqual(at(allLines(result), true, 1102.5), [[-12, 0], [0, 3000]], '面上は全高の壁の面線が描く（重ならない）');
});

test('【失敗系】対称壁が単独で立つ（反対側に材が無い）ときは、広げた側の面も下地の遠位辺も線にならない', () => {
  const lines = allLines(resolveWallRegionLines([exteriorBand().E2]));
  assert.deepEqual(at(lines, true, 6955), [], '継ぎ目の面は持ち出さない');
  assert.deepEqual(at(lines, true, 7000), []);
  assert.deepEqual(at(lines, true, 7045), [[-4000, 57.5]]);
  assert.deepEqual(at(lines, false, 57.5), [[6955, 7057.5]], '妻線は広げた材幅');
});

// ---- 同じ通りの長い壁Aと短い壁B（同じ面・同じ内側線）。境界はAへ畳まれる。----
function collinearPair() {
  const props = { isVertical: false, axis: 0, face: 57.5, faceDir: 1,
    backingRange: { lo: -45, hi: 45 }, materialRange: { lo: -45, hi: 57.5 } };
  return [
    stubWall({ id: 'A', coord1: 0, coord2: 3000, ...props }),
    stubWall({ id: 'B', coord1: 3000, coord2: 3500, ...props }),
  ];
}

test('【条件C】柱壁の覆いは、畳まれた線（短い壁Bの区間）にも効く——層ごとに外形／内側境界で切れる', () => {
  // 壁Bの面（y=57.5）の手前に立つ柱の包み。yLo 側は壁の仕上げ面へ揃えてトリム済み（外形 yLo=57.5、
  // 仕上げ厚は相手の内側線 y=45 まで外へ出る負値 -12.5）。
  const columnWraps = [{ id: 'C', outer: { xLo: 3100, xHi: 3300, yLo: 57.5, yHi: 400 },
    finishes: { xLo: 12.5, xHi: 12.5, yLo: -12.5, yHi: 12.5 } }];
  const result = resolveWallRegionLines(collinearPair(), { columnWraps });
  const lines = allLines(result);
  assert.deepEqual(at(lines, false, 57.5), [[0, 3100], [3300, 3500]], '面線は柱壁の外形幅で切れる');
  assert.deepEqual(at(lines, false, 45), [[0, 3112.5], [3287.5, 3500]], '内側線は柱壁の内側境界の幅で切れる');
  const owner = [...result.lines.entries()].find(([, ls]) => ls.some(l => l.at === 57.5))[0];
  assert.equal(owner, 'A', '線は最も長く寄与した壁が持つ（Bの区間の柱壁がAの線へ効いている）');
  assert.deepEqual(result.lines.get('A').find(l => l.at === 57.5).ids, ['A', 'B'], '寄与した全壁のidを残す');
});

test('【2a壁】描画クリップの単位（clipGroups）が違う壁の線は畳まない', () => {
  const merged = allLines(resolveWallRegionLines(collinearPair()));
  assert.deepEqual(at(merged, false, 57.5), [[0, 3500]], '既定では1本に畳む');

  const clipGroups = new Map([['B', '0']]);
  const result = resolveWallRegionLines(collinearPair(), { clipGroups });
  assert.deepEqual(at(allLines(result), false, 57.5), [[0, 3000], [3000, 3500]], '単位が違えば別々の線');
  assert.deepEqual(at(result.lines.get('B'), false, 57.5), [[3000, 3500]], 'Bの区間はBが持つ＝Bのクリップが掛かる');
});
