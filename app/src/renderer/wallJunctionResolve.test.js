// resolveWallTJunctions（壁をまたぐ端の解決）のテスト。
//
// 2026-09 領域方式への移行で、旧パス1（T字の切り欠き・下地延長）・パス2（内側線の端点合わせ）・
// パス3（fin線の下地貫通防止）・パス5（妻線抑止）と resolveWallFinSegments / isCapSuppressed は撤去した。
// それらが守っていた確定仕様は renderer/planWallRegion.test.js（領域の帰結・矩形の正規化）と
// renderer/wallDrawPlan.test.js（実グラフ経由）が同じ数値で固定する（対応表は `.claude/plan-wall-region.md`）。
// ここに残るのはパス0（高さが違う壁の取り合い）とパス6（通り抜けた端の詰め）。
//
// 数値は wallGeneration.js の既定生成（wallBase=100・wallFinish=12.5 → axisOffset=±75、
// オーナー下地帯は軸±62.5）に合わせる。座標系は実アプリ同様 y軸下向き正・単位mm。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Plane, PlanGraph, CenterLineType, Discipline } from '@core';
import { resolveWallTJunctions } from './wallJunctionResolve.js';

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

// ==================================================================
// 前提の固定: core/wall.js の materialRange は、対称/薄壁/下地オーナー・偏芯の
// どの分岐でも、faceDir方向の遠位端が常にfaceValue（axisValue）と一致する。
// 領域方式の端の正規化（planWallRegion.js の endSpansFor）は「端が相手の材の中／面上にあるか」を
// materialRange で判定し、closeConvexCorners は出隅の端を「材の遠位面」へ伸ばす——両者が同じ面を
// 指す前提。この前提が将来のcore/wall.js変更で破れたら気づけるよう、実Wallインスタンスで6型固定する。
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

// 実機データ・1階（垂直壁CL x=2500 が 水平壁CL y=-5000 へ北側から突き当たる隅。2026-09 実測）。
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

// ==================================================================
// パス0: 高さが違う壁の取り合い（ユーザー確定2026-09「高い方の壁が優先」「低い壁と高い壁が
// 端部でL字に取り合う場合、高い方の壁仕上げ材が端部を覆い、2本線が端部を取り巻く」）。
// 高さの供給源は finish/kneeDropWall.js の planWallHeight（overlaysのmode/topHeight）。
// ==================================================================

// 腰壁として渡すオーバーレイ（resolveKneeDropOverlays の戻り値と同じ形。capLo/capHiは
// 平面の天板幅で、ここでは高さ比較にしか使わないため0でよい）。
const kneeOverlay = (topHeight = 900) => ({ mode: 'knee', capLo: 0, capHi: 0, topHeight });

test('resolveWallTJunctions【パス0】: 高い壁の端は腰壁の帯全体の遠位面まで伸び、端部を取り巻く', () => {
  // 腰壁V-ownerの材は[2455,2557.5]、相棒の薄壁V-thinは[2442.5,2455]——帯全体は[2442.5,2557.5]。
  // H-thin-rightのlo端は2557.5に止まっており、帯の遠位面2442.5まで伸ばすと角を覆い切る。
  const overlays = new Map([['V-owner', kneeOverlay()], ['V-thin', kneeOverlay()]]);
  const result = resolveWallTJunctions([realVOwner(), realVThin(), realHThinRight()], overlays);

  assert.equal(result.get('H-thin-right')?.endExtend.lo, 2442.5,
    '1枚ぶん(2455)ではなく帯全体の遠位面(2442.5)まで伸ばすはず（オーナーと薄壁で端が段違いにならない）');
  assert.equal(result.get('H-thin-right')?.endWrap.lo, true, '実際の端部なので仕上げ材で取り巻く');
  assert.equal(result.get('H-thin-right')?.endExtend.hi, undefined, '相手のいない自由端は伸ばさない');
  assert.deepEqual(result.get('V-owner')?.spanCuts, [[-5057.5, -5045]],
    '腰壁側は高い壁の帯に覆われる区間を天板輪郭から落とすはず');
});

test('resolveWallTJunctions【パス0】: 既に帯を越えて終端している壁も「覆っている端」として取り巻く', () => {
  // 実機2026-09 X3通り: 下地オーナー壁は壁生成の出隅処理で既に腰壁の帯を越えて終端しており、
  // 伸長は不要。伸長の有無で分けると同じ端の2枚で木口線の有無が食い違う。
  const already = stubWall({
    id: 'H-past', isVertical: false, axis: -5000, face: -5057.5, faceDir: -1,
    coord1: 2442.5, coord2: 4442.5, // lo端は帯[2442.5,2557.5]の遠位面に既に到達
    backingRange: null, materialRange: { lo: -5057.5, hi: -5045 },
  });
  const overlays = new Map([['V-owner', kneeOverlay()], ['V-thin', kneeOverlay()]]);
  const result = resolveWallTJunctions([realVOwner(), realVThin(), already], overlays);
  assert.equal(result.get('H-past')?.endExtend.lo, undefined, '伸ばす必要はない');
  assert.equal(result.get('H-past')?.endWrap.lo, true, 'それでも端部は仕上げ材で取り巻くはず');
});

test('【失敗系】resolveWallTJunctions【パス0】: 通り過ぎる相手（T字・X字）は端部ではないので伸ばさない', () => {
  const b = stubWall({
    id: 'B-through', isVertical: false, axis: 2000, face: 1925,
    coord1: 0, coord2: 7000,
    backingRange: { lo: 1937.5, hi: 2062.5 }, materialRange: { lo: 1925, hi: 2062.5 },
  });
  const overlays = new Map([['B-through', kneeOverlay()]]);
  const result = resolveWallTJunctions([abuttingWallFromAbove(), b], overlays);
  assert.equal(result.get('A-vert')?.endExtend?.hi, undefined,
    'Bが通り過ぎるT字では覆うべき角が無い（伸ばすとBの中で妻線が浮く）');
  assert.deepEqual(result.get('B-through')?.spanCuts ?? [], [], '天板輪郭も落とさない');
});

test('【失敗系】resolveWallTJunctions【パス0】: 高さが同じなら何も起きない（取り合いは領域が解く）', () => {
  const result = resolveWallTJunctions([realVOwner(), realVThin(), realHThinRight()]);
  assert.equal(result.get('H-thin-right')?.endExtend.lo, undefined);
  assert.equal(result.get('H-thin-right')?.endWrap.lo, undefined);
  assert.deepEqual(result.get('V-owner')?.spanCuts ?? [], []);
});

test('【失敗系】resolveWallTJunctions【パス0】: 垂れ壁（mode=drop）・オーバーレイ省略は全高と同じ高さ＝何も起きない', () => {
  // 確定した規則は腰壁のみ——垂れ壁は切断面より上に在り、平面では全高の壁と同じ高さとして扱う。
  const drop = new Map([['V-thin', { mode: 'drop', capLo: 0, capHi: 0 }]]);
  for (const overlays of [drop, null]) {
    const r = resolveWallTJunctions([realVThin(), realHThinLeft()], overlays);
    assert.equal(r.get('H-thin-left')?.endExtend.hi, undefined);
    assert.equal(r.get('H-thin-left')?.endWrap.hi, undefined);
    assert.deepEqual(r.get('V-thin')?.spanCuts ?? [], []);
  }
});

// ---- 覆われた角に隠れる壁（壁生成が交差部に作る短い駒）----
// 高い壁の端が覆う角の矩形（高い壁の帯 × 低い壁の帯）に**丸ごと収まる**壁だけを隠す。
// 半分だけ掛かる駒（角の外側では全高の壁が続く）は隠さない——隠すと全高どうしの取り合いが
// 壊れる（実機2026-09で4本の取り合いが失われた回帰）。
function coveredCornerCase(fillerSpan) {
  // 高い壁（垂直・帯[2442.5,2557.5]）が、腰壁（水平・帯[-5057.5,-4942.5]）の端部を覆う。
  const vOwner = stubWall({ id: 'V-hi-owner', isVertical: true, axis: 2500, face: 2557.5,
    coord1: -4000, coord2: -5057.5, backingRange: { lo: 2455, hi: 2545 }, materialRange: { lo: 2455, hi: 2557.5 } });
  const vThin = stubWall({ id: 'V-hi-thin', isVertical: true, axis: 2500, face: 2442.5, faceDir: -1,
    coord1: -4000, coord2: -5057.5, backingRange: null, materialRange: { lo: 2442.5, hi: 2455 } });
  const kneeOwner = stubWall({ id: 'H-knee', isVertical: false, axis: -5000, face: -4942.5,
    coord1: -2000, coord2: 2442.5, backingRange: { lo: -5045, hi: -4955 }, materialRange: { lo: -5045, hi: -4942.5 } });
  const kneeThin = stubWall({ id: 'H-knee-thin', isVertical: false, axis: -5000, face: -5057.5, faceDir: -1,
    coord1: -2000, coord2: 2442.5, backingRange: null, materialRange: { lo: -5057.5, hi: -5045 } });
  const filler = stubWall({ id: 'H-filler', isVertical: false, axis: -5000, face: -5057.5, faceDir: -1,
    coord1: fillerSpan[0], coord2: fillerSpan[1],
    backingRange: { lo: -5045, hi: -4955 }, materialRange: { lo: -5057.5, hi: -4955 } });
  const overlays = new Map([['H-knee', kneeOverlay()], ['H-knee-thin', kneeOverlay()]]);
  return resolveWallTJunctions([vOwner, vThin, kneeOwner, kneeThin, filler], overlays);
}

test('resolveWallTJunctions【パス0】: 覆われた角に丸ごと収まる駒は描かない（全区間をspanCuts）', () => {
  const r = coveredCornerCase([2442.5, 2557.5]); // 高い壁の帯にぴったり収まる駒
  // 覆うのは半分ごと（オーナー壁の材＋薄壁の材）。両方が覆うので、和集合が駒の全長を覆う。
  const cuts = [...(r.get('H-filler')?.spanCuts ?? [])].sort((a, b) => a[0] - b[0]);
  assert.ok(cuts.length > 0, '角の矩形の中にあり切断面では見えない＝描かない');
  let reach = 2442.5;
  for (const [lo, hi] of cuts) { if (lo > reach + 0.5) break; reach = Math.max(reach, hi); }
  assert.equal(reach >= 2557.5, true, `spanCutsの和集合が全長を覆うはず: ${JSON.stringify(cuts)}`);
});

test('【実機回帰2026-09】resolveWallTJunctions【パス0】: 半分だけ掛かる駒は隠さず取り合いも保つ', () => {
  const r = coveredCornerCase([2385, 2500]); // 高い壁の帯から外側へはみ出す駒
  assert.deepEqual(r.get('H-filler')?.spanCuts ?? [], [],
    '角の外側では全高の壁が続くため、駒は全高のまま描く');
});

// ---- 角を全高の壁と共有する端は覆わない（ユーザー確定2026-09。実機X2通り）----
// 「壁---+---腰壁 / 壁」の交点では、西が全高の壁・東が腰壁。角は**全高どうしの入隅・出隅**として
// 取り合い、そこへ腰壁の天板が出幅ぶん食い込むのが正しい——高い壁はそこで終わっていないので、
// 端部を覆う・取り巻く・相手の天板を切る、のいずれもしない。
test('【実機修正2026-09】resolveWallTJunctions【パス0】: 角に全高の壁が続く端は覆わない', () => {
  // 高い壁（垂直・帯[2442.5,2557.5]）の端が、東の腰壁の帯[-5057.5,-4942.5]に触れる。
  // ただし同じ帯の**西側**には全高の壁が続いている（高い壁の帯の外へ伸びる）。
  const vOwner = stubWall({ id: 'V-hi-owner', isVertical: true, axis: 2500, face: 2557.5,
    coord1: -4000, coord2: -4942.5, backingRange: { lo: 2455, hi: 2545 }, materialRange: { lo: 2455, hi: 2557.5 } });
  const vThin = stubWall({ id: 'V-hi-thin', isVertical: true, axis: 2500, face: 2442.5, faceDir: -1,
    coord1: -4000, coord2: -4942.5, backingRange: null, materialRange: { lo: 2442.5, hi: 2455 } });
  const kneeOwner = stubWall({ id: 'H-knee', isVertical: false, axis: -5000, face: -4942.5,
    coord1: 2557.5, coord2: 6000, backingRange: { lo: -5045, hi: -4955 }, materialRange: { lo: -5045, hi: -4942.5 } });
  const tallWest = stubWall({ id: 'H-tall-west', isVertical: false, axis: -5000, face: -4942.5,
    coord1: -2000, coord2: 2442.5, backingRange: { lo: -5045, hi: -4955 }, materialRange: { lo: -5045, hi: -4942.5 } });
  const overlays = new Map([['H-knee', kneeOverlay()]]);
  const r = resolveWallTJunctions([vOwner, vThin, kneeOwner, tallWest], overlays);

  // 判定は**帯の半分ごと**（実機2026-09 2階X2通り）: 全高の壁が接しているのは薄壁側だけなので、
  // 薄壁は覆わず、反対側のオーナー壁は出隅の角を閉じるために覆う。
  assert.equal(r.get('V-hi-thin')?.endExtend.lo, undefined, '全高の壁が接する側は覆わない');
  assert.equal(r.get('V-hi-thin')?.endWrap.lo, undefined, '端部ではないので取り巻かない');
  assert.equal(r.get('V-hi-owner')?.endExtend.lo, -5045, '反対側の半分は角を閉じるまで伸びる');
  assert.deepEqual(r.get('H-knee')?.spanCuts ?? [], [[2442.5, 2557.5]],
    '腰壁の天板は高い壁の帯ぶんだけ落ちる（出幅ぶんの食い込みは残る）');

  // 同じ帯に全高の壁が居なければ、薄壁側も従来どおり覆って取り巻く（実機X3通りの形）。
  const r2 = resolveWallTJunctions([vOwner, vThin, kneeOwner], overlays);
  assert.equal(r2.get('V-hi-thin')?.endWrap.lo, true, '角を共有する全高の壁が無ければ端部として扱う');
  assert.equal(r2.get('V-hi-thin')?.endExtend.lo, -5045, '腰壁の帯の遠位面まで覆うはず');
});

// ---- 腰壁どうしの角に残る駒（実機2026-09「10」2階 X3×Y1-2000）----
// 交差する両方の通りが腰壁だと、交差部の駒だけが全高のまま残り、パス0では**駒が「高い方」に
// なって**角を取り巻き、腰壁の天板を自分の材の幅で切っていた（交差部に壁厚2本線のL字が出て、
// 縦の天板が駒の面で切れる）。駒は角の矩形に丸ごと埋まっている＝切断面に見えるのは両側の
// 天板だけなので描かず、角は天板どうしの取り合い（planWallRegion.js の天板の領域）に任せる。
function kneeCornerWithFiller({ crossIsKnee = true, tallOnFillerRun = false } = {}) {
  // 縦の腰壁（通りx=0・帯[-57.5,57.5]）と横の腰壁（通りy=-2000・帯[-2057.5,-1942.5]）のL字。
  const vOwner = stubWall({ id: 'V-owner', isVertical: true, axis: 0, face: 57.5,
    coord1: -2057.5, coord2: -57.5, backingRange: { lo: -45, hi: 45 }, materialRange: { lo: -45, hi: 57.5 } });
  const vThin = stubWall({ id: 'V-thin', isVertical: true, axis: 0, face: -57.5, faceDir: -1,
    coord1: -1942.5, coord2: -57.5, backingRange: null, materialRange: { lo: -57.5, hi: -45 } });
  const hOwner = stubWall({ id: 'H-owner', isVertical: false, axis: -2000, face: -1942.5,
    coord1: -2942.5, coord2: -57.5, backingRange: { lo: -2045, hi: -1955 }, materialRange: { lo: -2045, hi: -1942.5 } });
  const hThin = stubWall({ id: 'H-thin', isVertical: false, axis: -2000, face: -2057.5, faceDir: -1,
    coord1: -2942.5, coord2: -57.5, backingRange: null, materialRange: { lo: -2057.5, hi: -2045 } });
  // 交差部の駒（腰壁の指定は乗らない＝全高のまま）
  const filler = stubWall({ id: 'H-filler', isVertical: false, axis: -2000, face: -2057.5, faceDir: -1,
    coord1: -57.5, coord2: 57.5, backingRange: { lo: -2045, hi: -1955 }, materialRange: { lo: -2057.5, hi: -1955 } });
  const walls = [vOwner, vThin, hOwner, hThin, filler];
  // 駒と同じ通りの反対側に全高の壁が続くケース（駒は全高の連なりの一部＝隠さない）
  if (tallOnFillerRun) {
    walls.push(stubWall({ id: 'H-tall-east', isVertical: false, axis: -2000, face: -1942.5,
      coord1: 57.5, coord2: 2000, backingRange: { lo: -2045, hi: -1955 }, materialRange: { lo: -2045, hi: -1942.5 } }));
  }
  const overlays = new Map([['H-owner', kneeOverlay(800)], ['H-thin', kneeOverlay(800)]]);
  if (crossIsKnee) {
    overlays.set('V-owner', kneeOverlay(800));
    overlays.set('V-thin', kneeOverlay(800));
  }
  return resolveWallTJunctions(walls, overlays);
}

test('【実機2026-09「10」】resolveWallTJunctions【パス0】: 腰壁どうしの角に残る駒は描かず、天板も切らない', () => {
  const r = kneeCornerWithFiller();
  const cuts = [...(r.get('H-filler')?.spanCuts ?? [])].sort((a, b) => a[0] - b[0]);
  let reach = -57.5;
  for (const [lo, hi] of cuts) { if (lo > reach + 0.5) break; reach = Math.max(reach, hi); }
  assert.equal(reach >= 57.5, true, `駒の全長がspanCutsで覆われるはず: ${JSON.stringify(cuts)}`);
  assert.deepEqual(r.get('H-filler')?.endWrap ?? {}, {}, '駒は端部を取り巻かない（壁厚2本線のL字を出さない）');
  for (const id of ['V-owner', 'V-thin']) {
    assert.deepEqual(r.get(id)?.spanCuts ?? [], [],
      `${id}: 天板は駒の材の幅で切られず、端まで描かれるはず`);
  }
});

test('【失敗系】resolveWallTJunctions【パス0】: 交差する通りが全高なら、その壁が従来どおり角を覆って取り巻く', () => {
  const r = kneeCornerWithFiller({ crossIsKnee: false });
  // 駒は全高の縦壁が覆う角の矩形に収まるので、既存の「覆われた角に隠れる壁」の規則で消える
  // ——新しい規則（腰壁どうしの角の駒）に横取りさせない。
  assert.equal(r.get('V-owner')?.endWrap.lo, true, '全高の壁は端部を仕上げ材で取り巻くはず');
  assert.equal(r.get('V-thin')?.endExtend.lo, -2057.5, '腰壁の帯の遠位面まで伸びるはず');
  assert.deepEqual(r.get('H-owner')?.spanCuts ?? [], [[-57.5, 57.5], [-57.5, 57.5]],
    '腰壁の天板は全高の壁の帯ぶん落ちる');
});

test('【失敗系】resolveWallTJunctions【パス0】: 駒と同じ通りに全高の壁が続くなら隠さない', () => {
  const r = kneeCornerWithFiller({ tallOnFillerRun: true });
  assert.deepEqual(r.get('H-filler')?.spanCuts ?? [], [], '駒ではなく全高の連なりの一部');
});

// ==================================================================
// パス6: 偏芯壁の帯の境目で止まった端を帯の手前の面まで詰める。
// 数値は実機データ・1階（階段下部屋の偏芯壁 y軸CL=-3500 が、通り芯X2 x軸CL=-3000 の帯へ
// 西からT字で取り合う隅。2026-09 実測）をそのまま使う。
// 帯はどちらも非対称: X2は [-3057.5,-2942.5]（薄壁 -3057.5..-3045 ＋ オーナー -3045..-2942.5）、
// 階段下部屋側は [-3602.5,-3487.5]（偏芯オーナー -3602.5..-3500 ＋ 仕上げ薄壁 -3500..-3487.5）。
// 生成側のトリム（trimStairUnderJunctions）が相手を1枚ずつ見るため、双方の端が
// **帯の境目**（-3045 / -3500）で止まっている。
// 領域方式はこの詰め（内へ縮める endExtend）を使わない（planWallRegion.js の regionSpan）が、
// 略図の単線・下地スタッドの配置（`segments`）と、パス0の判定に効くため規則として残す。
// ==================================================================
const eccJunctionWalls = () => [
  // X2の帯: 西側の部屋の仕上げ薄壁（通し）
  stubWall({
    id: 'X2-thin', isVertical: true, axis: -3000, face: -3057.5, faceDir: -1,
    coord1: -6942.5, coord2: -2057.5,
    backingRange: null, materialRange: { lo: -3057.5, hi: -3045 },
  }),
  // X2の帯: 下地オーナー壁。階段下部屋の壁で南北に分割されている
  stubWall({
    id: 'X2-owner-n', isVertical: true, axis: -3000, face: -2942.5, faceDir: 1,
    coord1: -6942.5, coord2: -3487.5,
    backingRange: { lo: -3045, hi: -2955 }, materialRange: { lo: -3045, hi: -2942.5 },
  }),
  stubWall({
    id: 'X2-owner-s', isVertical: true, axis: -3000, face: -2942.5, faceDir: 1,
    coord1: -3500, coord2: -1942.5,
    backingRange: { lo: -3045, hi: -2955 }, materialRange: { lo: -3045, hi: -2942.5 },
  }),
  // 階段下部屋の偏芯壁（下地を室内側へ全寄せ）とその外側仕上げ薄壁（内側線は軸CL上に来る）
  stubWall({
    id: 'ecc-owner', isVertical: false, axis: -3500, face: -3602.5, faceDir: -1,
    coord1: -3045, coord2: -1665,
    backingRange: { lo: -3590, hi: -3500 }, materialRange: { lo: -3602.5, hi: -3500 },
  }),
  stubWall({
    id: 'ecc-thin', isVertical: false, axis: -3500, face: -3487.5, faceDir: 1,
    coord1: -3045, coord2: -1562.5,
    backingRange: null, materialRange: { lo: -3500, hi: -3487.5 },
  }),
];

test('resolveWallTJunctions: 偏芯壁の帯どうしの隅は、帯の境目で止まった端を帯の手前の面まで詰める', () => {
  const result = resolveWallTJunctions(eccJunctionWalls());

  // 階段下部屋側の2枚: 端 -3045（X2の帯の境目）→ 帯の手前の面 -2942.5
  assert.equal(result.get('ecc-owner')?.endExtend.lo, -2942.5);
  assert.equal(result.get('ecc-thin')?.endExtend.lo, -2942.5);
  // X2の南側オーナー壁: 端 -3500（階段下部屋側の帯の境目）→ 帯の手前の面 -3487.5
  assert.equal(result.get('X2-owner-s')?.endExtend.lo, -3487.5);
  // X2の北側オーナー壁: 端 -3487.5 は帯の面そのもの＝詰めない……のではなく、相手の帯を通り抜けて
  // 遠位面まで届いている（角の延長）ので手前の面 -3602.5 へ詰める
  assert.equal(result.get('X2-owner-n')?.endExtend.hi, -3602.5);
});

test('【失敗系】resolveWallTJunctions: 帯の境目ではない位置で止まった端は詰めない', () => {
  const walls = eccJunctionWalls();
  const ecc = walls.find(w => w.id === 'ecc-owner');
  ecc.coord1 = -3000; // X2オーナー壁の材の中（境目 -3045 でも面 -2942.5 でもない）

  const result = resolveWallTJunctions(walls);

  assert.equal(result.get('ecc-owner')?.endExtend.lo, undefined,
    '境目に乗らない端はT字の突き当たり＝詰める対象ではないはず');
});
