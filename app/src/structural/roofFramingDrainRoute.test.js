// 下屋の水下の振り分け（roofFramingGeometry.js leanToDrainRoute。2026-10-05 裁定「下屋は壁へ下る面を作らない」）の単体テスト。
// 一般則: 水下＝形状が決める軒の辺（片流れ＝高い側の反対／切妻＝棟と平行な2辺・L字は gableArmDrainsOf の軒／寄棟＝全辺）から、
// 屋内に接する部分（zeroZones＝壁）を除いたもの。期待値は手計算（y は下向き正）。不変条件 I1・I3・I4・I5・I7 を寸法を振って固定する。
//   I1: 全 region で、水下と壁（屋内に接する区間）の重なりが tol 以下
//   I3: 壁に接する寄棟の水下＝屋内に接しない全外周
//   I4: 片流れに読み替えた切妻と、同じ矩形の片流れ（高い側＝壁）が同じ（振り分け・母屋・棟木）
//   I5: 両腕の内側が壁の L字の切妻と、同じ範囲の L字の片流れで、斜め線・棟木が一致（r が等しいので母屋も一致）
//   I7: 壁に接しない矩形の切妻・寄棟を場の経路に通したとき、母屋・棟木が矩形の経路（棟木側から 455/910）と一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  leanToDrainRoute, leanToDrainFraming, leanToWingsOf, gableArmDrainsOf, orthogonalBoundaryLoops, purlinLayoutFromRidge, roofFramingLines,
  roofHipDiagonals,
} from './roofFramingGeometry.js';
import { RoofShape } from '../core/constants.js';

const TOL = 0.5;
const rc = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const Z = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const DR = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const route = (args) => leanToDrainRoute({ tolMm: TOL, zeroZones: [], ...args });
const layout = { pitchMm: 910, startOffsetsMm: [455, 910], tolMm: TOL };
const dkey = d => `${d.isVertical ? 'x' : 'y'}=${d.coord}:${d.lo}..${d.hi}:${d.outward}`;
const lkey = l => `${l.isVertical ? 'x' : 'y'}=${Math.round(l.coord * 100) / 100}:${Math.round(l.lo * 100) / 100}..${Math.round(l.hi * 100) / 100}`;
const lkeys = ls => ls.map(lkey).sort();

// 矩形 8000×3000（x0..8000 × y0..3000）の4辺の壁（全体）。外向き: 上 -y・下 +y・左 -x・右 +x
const R = rc(0, 0, 8000, 3000);
const WALL = {
  top: Z(false, 0, 0, 8000, -1), bottom: Z(false, 3000, 0, 8000, 1), left: Z(true, 0, 0, 3000, -1), right: Z(true, 8000, 0, 3000, 1),
};

// ---- 振り分けの表（全行） ----

test('矩形の片流れ: 低い側（高い側の反対）が壁に接さなければ rect（高い側は入力のまま）', () => {
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'top' }), { kind: 'rect', shape: 'mono', highSide: 'top' });
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'right', autoHighSide: 'top', zeroZones: [WALL.top] }), { kind: 'rect', shape: 'mono', highSide: 'right' }, '壁が高い側でも低い側でもない辺（上）だけなら変わらない');
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'top', zeroZones: [WALL.top] }), { kind: 'rect', shape: 'mono', highSide: 'top' }, '壁が高い側なら今までどおり');
});

test('矩形の片流れ: 明示の高い側で低い側が全部壁なら、自動の高い側（壁の側）へ読み替える（入力は変えない）。自動も低い側が全部壁（向かい合う壁）なら none', () => {
  // 低い側＝下（壁）。明示の高い側 top。自動の高い側 bottom（壁の側）
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'bottom', zeroZones: [WALL.bottom] }), { kind: 'rect', shape: 'mono', highSide: 'bottom' });
  // 左の壁・明示の高い側 right（低い側＝左＝壁）→ 自動 left
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'right', autoHighSide: 'left', zeroZones: [WALL.left] }), { kind: 'rect', shape: 'mono', highSide: 'left' });
  // 向かい合う壁（上下）: 明示 top → 低い側 bottom は壁 → 自動 bottom へ → 低い側 top も壁 → none
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'bottom', zeroZones: [WALL.top, WALL.bottom] }), { kind: 'none' });
  // 自動と明示が同じで低い側が全部壁（自動が壁の側でない入力）: 読み替え先が無いので none
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'top', zeroZones: [WALL.bottom] }), { kind: 'none' });
});

// 旧（〜2026-10-05）: 低い側の一部だけ壁なら field（水下は壁を除いた部分）。新: 水下の端が辺の途中で壁に変わる形は、水下だけが進む
// 屋根面の到達時刻が崖になる（壁の前の点は水下に届かない）ので規則で作れない形＝ none（reason:'invalidField'。軒先の線だけ）
test('矩形の片流れ: 低い側の一部だけ壁（辺の途中で壁になる水下）は規則で作れない形＝ none（invalidField）', () => {
  const r = route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'top', zeroZones: [Z(false, 3000, 0, 3000, 1)] });
  assert.deepEqual(r, { kind: 'none', reason: 'invalidField' });
  // 壁が水下の端に沿う（壁と水下の境が屋根範囲の角）なら作れる: 低い側が全部壁なら読み替え（rect）・壁なしなら rect
  assert.equal(route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide: 'top', autoHighSide: 'top', zeroZones: [WALL.left] }).kind, 'rect');
});

test('矩形の切妻: 棟と平行な2辺が壁に接さなければ rect の切妻。壁が棟木と直交する端（けらば）だけでも rect の切妻', () => {
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false }), { kind: 'rect', shape: 'gable', highSide: null });
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false, zeroZones: [WALL.left, WALL.right] }), { kind: 'rect', shape: 'gable', highSide: null }, '壁がけらばの端');
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: true }), { kind: 'rect', shape: 'gable', highSide: null }, '棟が縦（軒は左右）');
  assert.equal(route({ shape: RoofShape.GABLE, rect: R, rects: [R] }).shape, 'gable', 'ridgeIsVertical 省略は長手（横長＝棟は横）');
});

test('矩形の切妻: 棟と平行な辺の片方が全部壁で他方が壁に接さなければ、壁を水上にした片流れ（高い側＝壁の側）。両方全部壁なら none', () => {
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false, zeroZones: [WALL.top] }), { kind: 'rect', shape: 'mono', highSide: 'top' });
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false, zeroZones: [WALL.bottom] }), { kind: 'rect', shape: 'mono', highSide: 'bottom' });
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: true, zeroZones: [WALL.left] }), { kind: 'rect', shape: 'mono', highSide: 'left' });
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: true, zeroZones: [WALL.right] }), { kind: 'rect', shape: 'mono', highSide: 'right' });
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false, zeroZones: [WALL.top, WALL.bottom] }), { kind: 'none' }, '向かい合う壁の間');
});

// 旧: 一部だけ壁なら field（GABLE。水下は壁を除いた部分）。新: 辺の途中で壁になる水下は規則で作れない形＝ none（invalidField）
test('矩形の切妻: 一部だけ壁（辺の途中で壁になる水下）は規則で作れない形＝ none（invalidField）。上が全部壁・下が一部壁（片流れに読み替えても同じ）も', () => {
  const part = route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false, zeroZones: [Z(false, 0, 0, 3000, -1)] });
  assert.deepEqual(part, { kind: 'none', reason: 'invalidField' });
  const mixed = route({ shape: RoofShape.GABLE, rect: R, rects: [R], ridgeIsVertical: false, zeroZones: [WALL.top, Z(false, 3000, 0, 3000, 1)] });
  assert.deepEqual(mixed, { kind: 'none', reason: 'invalidField' }, '上が全部壁・下が一部壁');
});

// 旧: 片流れと route・母屋が完全一致（どちらも field）。新: どちらも辺の途中で壁になる水下＝規則で作れない形（none・invalidField）で一致
test('T3: 棟と平行な辺の片方が全部壁で他方が一部だけ壁の切妻は、同じ壁配置で高い側＝壁を指定した片流れと route が完全一致（どちらも規則で作れない形＝ none・invalidField。寸法 5×5×2向き×2形。455 の倍数でない値を含む）', () => {
  const S = [1820, 2275, 3003, 3640, 4550];
  let n = 0;
  for (const w of S) {
    for (const h of S) {
      const rect = rc(0, 0, w, h);
      const cases = [
        // 棟が横（軒は上下）: 上が全部壁・下の左半分が壁
        { ridgeIsVertical: false, zones: [Z(false, 0, 0, w, -1), Z(false, h, 0, w / 2, 1)], highSide: 'top' },
        { ridgeIsVertical: false, zones: [Z(false, h, 0, w, 1), Z(false, 0, w / 2, w, -1)], highSide: 'bottom' },
        // 棟が縦（軒は左右）
        { ridgeIsVertical: true, zones: [Z(true, 0, 0, h, -1), Z(true, w, 0, h / 2, 1)], highSide: 'left' },
        { ridgeIsVertical: true, zones: [Z(true, w, 0, h, 1), Z(true, 0, h / 2, h, -1)], highSide: 'right' },
      ];
      for (const c of cases) {
        const g = route({ shape: RoofShape.GABLE, rect, rects: [rect], ridgeIsVertical: c.ridgeIsVertical, zeroZones: c.zones });
        const m = route({ shape: RoofShape.MONO, rect, rects: [rect], highSide: c.highSide, autoHighSide: c.highSide, zeroZones: c.zones });
        assert.deepEqual(m, { kind: 'none', reason: 'invalidField' }, `片流れ ${w}×${h} ${c.highSide}: 低い側の一部だけ壁`);
        assert.deepEqual(g, m, `route ${w}×${h} ${c.highSide}`);
        n++;
      }
    }
  }
  assert.equal(n, 100);
  // 壁の側の辺が全部壁で、もう片方に壁が無ければ（同じ寸法）片流れの rect で一致する（作れる形との対比）
  const rect = rc(0, 0, 1820, 3003);
  const ok = route({ shape: RoofShape.GABLE, rect, rects: [rect], ridgeIsVertical: false, zeroZones: [Z(false, 0, 0, 1820, -1)] });
  assert.deepEqual(ok, { kind: 'rect', shape: 'mono', highSide: 'top' });
});

test('矩形の寄棟: 壁に接さなければ rect。壁に接すれば field（水下＝壁を除く外周）。全周が壁なら none', () => {
  assert.deepEqual(route({ shape: RoofShape.HIP, rect: R, rects: [R] }), { kind: 'rect', shape: 'hip', highSide: null });
  const r = route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [WALL.top] });
  assert.equal(r.kind, 'field');
  assert.equal(r.shape, 'hip');
  assert.deepEqual(r.drains.map(dkey).sort(), [DR(true, 8000, 0, 3000, 1), DR(false, 3000, 0, 8000, 1), DR(true, 0, 0, 3000, -1)].map(dkey).sort(), '右・下・左');
  assert.equal(r.purlinDepthMm, 3000, '水下の場の T の最大値＝min(左右の間隔の半分 4000, 壁から下までの 3000)');
  assert.equal(r.kindZones.every(z => z.kind === 'eave'), true, '寄棟は全辺が軒');
  // 旧: 上辺の一部だけ壁なら上辺の残り＋他の3辺の field。新: 辺の途中で壁になる水下は規則で作れない形
  assert.deepEqual(route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [Z(false, 0, 0, 4000, -1)] }), { kind: 'none', reason: 'invalidField' }, '上辺の一部だけ壁');
  assert.deepEqual(route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: Object.values(WALL) }), { kind: 'none' }, '全周が壁');
});

// roof-test8・9・1 型（屋内 x3640..7280 × y-9884..-3640 の下・右を回る L字。壁は y=-3640 の x3640..7280 と x=7280 の y-9884..-3640）
const L = [rc(3640, -3640, 7280, 0), rc(7280, -3640, 9100, 0), rc(7280, -7280, 9100, -3640), rc(7280, -9884, 9100, -9100), rc(7280, -9100, 9100, -7280)];
const L_WALLS = [Z(false, -3640, 3640, 7280, -1), Z(true, 7280, -9884, -3640, -1)];

test('L字の片流れ（roof-test1 型）: leanToWingsOf の水下から壁を除く（壁へ流れる水下は無いので同じ）。母屋の段の基準＝longDepthMm。翼と取り残しを持つ。翼が作れなければ none', () => {
  const r = route({ shape: RoofShape.MONO, rect: null, rects: L, zeroZones: L_WALLS });
  const w = leanToWingsOf({ rects: L, contacts: L_WALLS, tolMm: TOL });
  assert.equal(r.kind, 'field');
  assert.deepEqual(r.drains, w.drains);
  assert.equal(r.purlinDepthMm, w.longDepthMm);
  assert.deepEqual(r.wings, w.wings);
  assert.deepEqual(r.unassigned, w.unassigned);
  assert.deepEqual(r.kindZones, w.kindZones);
  assert.deepEqual(r.drains.map(dkey), [DR(true, 9100, -9884, 0, 1), DR(false, 0, 3640, 9100, 1)].map(dkey), '右辺・下辺');
  assert.deepEqual(route({ shape: RoofShape.MONO, rect: null, rects: [] }), { kind: 'none' }, '範囲が空');
});

test('L字の切妻（roof-test8 型）: gableArmDrainsOf の軒から壁を除く＝右辺・下辺だけ。壁を除いたときの母屋の段の基準＝長手方向の腕の矩形の中の D の最大値（1820）', () => {
  const r = route({ shape: RoofShape.GABLE, rect: null, rects: L, zeroZones: L_WALLS });
  assert.equal(r.kind, 'field');
  assert.equal(r.shape, 'gable');
  assert.deepEqual(r.drains.map(dkey), [DR(true, 9100, -9884, 0, 1), DR(false, 0, 3640, 9100, 1)].map(dkey));
  assert.equal(r.purlinDepthMm, 1820);
  // 壁が無ければ今までの基準（長手方向の腕の半スパン 910）と軒4辺
  const bare = route({ shape: RoofShape.GABLE, rect: null, rects: L });
  assert.equal(bare.drains.length, 4);
  assert.equal(bare.purlinDepthMm, 910);
  assert.deepEqual(bare.drains, gableArmDrainsOf({ rects: L, tolMm: TOL }).drains, '壁に接しない形は今までの水下そのもの');
  assert.deepEqual(bare.kindZones, gableArmDrainsOf({ rects: L, tolMm: TOL }).kindZones);
});

// 旧: 片側だけ壁なら壁の側の軒だけ除いた field（壁でない x=7280 は軒のまま）。新: 入隅の片方の辺だけが壁だと、もう片方の入隅の辺
// （水下）が壁の向こう（屋外）を回って壁の前の面を引くことになり、壁へ下る面か水下に届かない点ができる＝規則で作れない形
test('L字の切妻: 入隅の片方の辺だけが壁なら規則で作れない形（none・invalidField）。けらばが無い形・水下が全部壁の形は none', () => {
  // 横の腕の壁だけ（y=-3640。x=7280 側は屋内でない）
  const one = route({ shape: RoofShape.GABLE, rect: null, rects: L, zeroZones: [L_WALLS[0]] });
  assert.deepEqual(one, { kind: 'none', reason: 'invalidField' });
  const ring = [rc(0, 0, 9000, 3000), rc(0, 3000, 3000, 6000), rc(6000, 3000, 9000, 6000), rc(0, 6000, 9000, 9000)];
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: null, rects: ring }), { kind: 'none' }, 'けらばの無い形（環）');
  const edges = orthogonalBoundaryLoops({ rects: L, tolMm: TOL }).flat();
  const all = edges.map(e => Z(e.isVertical, e.coord, e.lo, e.hi, e.outward));
  assert.deepEqual(route({ shape: RoofShape.GABLE, rect: null, rects: L, zeroZones: all }), { kind: 'none' }, '外周が全部壁');
});

test('L字の寄棟（明示）: 全辺から壁を除いた外周が水下（roof-test9 型は上・右・下・左の4本）。壁が無ければ全辺・基準＝切妻と同じ半スパン。外周が全部壁なら none', () => {
  const r = route({ shape: RoofShape.HIP, rect: null, rects: L, zeroZones: L_WALLS });
  assert.equal(r.kind, 'field');
  assert.equal(r.shape, 'hip');
  assert.deepEqual(r.drains.map(dkey).sort(), [DR(false, -9884, 7280, 9100, -1), DR(true, 9100, -9884, 0, 1), DR(false, 0, 3640, 9100, 1), DR(true, 3640, -3640, 0, -1)].map(dkey).sort());
  assert.equal(r.purlinDepthMm, 1820);
  assert.equal(r.kindZones.every(z => z.kind === 'eave'), true);
  const bare = route({ shape: RoofShape.HIP, rect: null, rects: L });
  assert.equal(bare.drains.length, 6, '壁が無ければ外周6辺');
  assert.equal(bare.purlinDepthMm, 910, '切妻と同じ基準（長手方向の腕の半スパン）');
  const edges = orthogonalBoundaryLoops({ rects: L, tolMm: TOL }).flat();
  assert.deepEqual(route({ shape: RoofShape.HIP, rect: null, rects: L, zeroZones: edges.map(e => Z(e.isVertical, e.coord, e.lo, e.hi, e.outward)) }), { kind: 'none' });
});

test('陸屋根・棟違い・未知の形状・使える矩形が無い範囲は none（外形線だけ）', () => {
  for (const shape of [RoofShape.FLAT, RoofShape.STAGGERED, 'unknown', undefined, null]) {
    assert.deepEqual(route({ shape, rect: R, rects: [R] }), { kind: 'none' }, String(shape));
    assert.deepEqual(route({ shape, rect: null, rects: L }), { kind: 'none' }, `${shape}（L字）`);
  }
  assert.deepEqual(route({ shape: RoofShape.HIP, rect: null, rects: [rc(0, 0, 0, 3000), rc(0, 0, 3000, 0.3)] }), { kind: 'none' }, '幅か高さが tol 以下だけ');
});

test('【失敗系】leanToDrainRoute: tolMm・rects・zeroZones・片流れの highSide の不正は RangeError。壁の区間の長さが tol 以下の接触は壁と見なさない', () => {
  for (const tolMm of [-1, NaN, undefined, '0.5']) assert.throws(() => leanToDrainRoute({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [], tolMm }), RangeError, `tolMm=${tolMm}`);
  for (const rects of [null, undefined, 'x', {}]) assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects }), RangeError, `rects=${JSON.stringify(rects)}`);
  assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects: [rc(0, 0, NaN, 3000)] }), RangeError, '座標が非有限');
  assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects: [rc(3000, 0, 0, 3000)] }), RangeError, '座標が逆順');
  assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: 'x' }), RangeError, 'zeroZones が配列でない');
  assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [{ isVertical: 'x', coord: 0, lo: 0, hi: 1, outward: 1 }] }), RangeError, 'isVertical が boolean でない');
  assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [Z(true, NaN, 0, 1, 1)] }), RangeError, 'coord が非有限');
  assert.throws(() => route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [Z(true, 0, 0, 1, 2)] }), RangeError, 'outward が ±1 でない');
  for (const highSide of [null, undefined, 'up', 3]) assert.throws(() => route({ shape: RoofShape.MONO, rect: R, rects: [R], highSide }), RangeError, `highSide=${highSide}`);
  // tol 以下の接触（0.3mm の壁）は壁でない＝rect のまま
  assert.deepEqual(route({ shape: RoofShape.HIP, rect: R, rects: [R], zeroZones: [Z(false, 0, 0, 0.3, -1)] }), { kind: 'rect', shape: 'hip', highSide: null });
});

// ---- 不変条件 ----

/** 形状ごとの自然の水下（独立の導出）: 矩形の rect について。 */
function naturalDrains(rect, shape, ridgeIsVertical, highSide) {
  const edges = orthogonalBoundaryLoops({ rects: [rect], tolMm: TOL }).flat().map(e => DR(e.isVertical, e.coord, e.lo, e.hi, e.outward));
  if (shape === 'hip') return edges;
  if (shape === 'gable') return edges.filter(e => e.isVertical === ridgeIsVertical);
  const vertical = highSide === 'left' || highSide === 'right';
  return edges.filter(e => e.isVertical === vertical && e.outward === (highSide === 'top' || highSide === 'left' ? 1 : -1));
}
const overlapMm = (d, z) => (d.isVertical === z.isVertical && d.outward === z.outward && Math.abs(d.coord - z.coord) <= TOL
  ? Math.max(0, Math.min(d.hi, z.hi) - Math.max(d.lo, z.lo)) : 0);

/** 矩形 w×h・壁の組合せ（辺の全体・半分・なし）を全部振る。 */
function* rectForms() {
  const sizes = [[3640, 3640], [8000, 3000], [3000, 8000], [9100, 5460], [4550, 1820], [7280, 7280]];
  const wallOptions = (sideSpec) => [null, 'full', 'half'].map(kind => (kind ? sideSpec(kind) : null));
  for (const [w, h] of sizes) {
    const rect = rc(1000, 2000, 1000 + w, 2000 + h);
    const sides = {
      top: kind => Z(false, rect.y1, rect.x1, kind === 'full' ? rect.x2 : rect.x1 + w / 2, -1),
      bottom: kind => Z(false, rect.y2, rect.x1, kind === 'full' ? rect.x2 : rect.x1 + w / 2, 1),
      left: kind => Z(true, rect.x1, rect.y1, kind === 'full' ? rect.y2 : rect.y1 + h / 2, -1),
      right: kind => Z(true, rect.x2, rect.y1, kind === 'full' ? rect.y2 : rect.y1 + h / 2, 1),
    };
    for (const t of wallOptions(sides.top)) {
      for (const b of wallOptions(sides.bottom)) {
        for (const l of wallOptions(sides.left)) {
          for (const r of wallOptions(sides.right)) yield { rect, zones: [t, b, l, r].filter(Boolean) };
        }
      }
    }
  }
}

test('I1: 全 region で、水下と屋内に接する区間（壁）の重なりが tol 以下（矩形の片流れ・切妻・寄棟 × 壁の組合せ 6寸法×81通り。L字も）', () => {
  let field = 0;
  let rectKind = 0;
  let invalid = 0;
  for (const { rect, zones } of rectForms()) {
    const wh = (rect.x2 - rect.x1 > rect.y2 - rect.y1);
    for (const [shape, extra] of [
      [RoofShape.MONO, { highSide: wh ? 'top' : 'left', autoHighSide: zones.length > 0 ? 'bottom' : 'top' }],
      [RoofShape.MONO, { highSide: 'right', autoHighSide: 'left' }],
      [RoofShape.GABLE, { ridgeIsVertical: !wh }],
      [RoofShape.GABLE, { ridgeIsVertical: wh }],
      [RoofShape.HIP, {}],
    ]) {
      const r = route({ shape, rect, rects: [rect], zeroZones: zones, ...extra });
      const label = `${shape} ${JSON.stringify(rect)} ${JSON.stringify(zones)}`;
      if (r.kind === 'field') {
        field++;
        for (const d of r.drains) for (const z of zones) assert.ok(overlapMm(d, z) <= TOL, `I1 ${label}: 水下 ${dkey(d)} と壁 ${dkey(z)} が重なる`);
        assert.ok(r.drains.length > 0, `${label}: field は水下を持つ`);
        assert.ok(r.purlinDepthMm > 0, `${label}: 母屋の段の基準が正`);
      } else if (r.kind === 'rect') {
        rectKind++;
        const drains = naturalDrains(rect, r.shape, extra.ridgeIsVertical ?? (rect.y2 - rect.y1 > rect.x2 - rect.x1), r.highSide);
        assert.ok(drains.length > 0);
        for (const d of drains) for (const z of zones) assert.ok(overlapMm(d, z) <= TOL, `I1(rect) ${label}: 水下 ${dkey(d)} と壁 ${dkey(z)} が重なる`);
      } else if (r.reason === 'invalidField') {
        // 規則で作れない形（辺の途中で壁になる水下）は、一部だけの壁（辺の全体でない壁）があるときだけ
        invalid++;
        const w = rect.x2 - rect.x1;
        const h = rect.y2 - rect.y1;
        assert.ok(zones.some(z => z.hi - z.lo < (z.isVertical ? h : w) - TOL), `invalidField は一部だけの壁があるとき ${label}`);
      }
    }
  }
  assert.ok(field >= 80 && rectKind > 100 && invalid > 100, `検査が空振りしない（field=${field}, rect=${rectKind}, invalid=${invalid}）`);
  // L字。作れる形（field）は水下と壁が重ならない。入隅の片方だけが壁の切妻・寄棟は規則で作れない形（none・invalidField）
  const expectKind = { mono: ['field', 'field', 'field', 'field'], gable: ['field', 'none', 'none', 'field'], hip: ['field', 'none', 'none', 'field'] };
  let lField = 0;
  for (const shape of [RoofShape.MONO, RoofShape.GABLE, RoofShape.HIP]) {
    [[], [L_WALLS[0]], [L_WALLS[1]], L_WALLS].forEach((zones, k) => {
      const r = route({ shape, rect: null, rects: L, zeroZones: zones });
      assert.equal(r.kind, expectKind[shape][k], `${shape} L字 壁${k}`);
      if (r.kind === 'none') assert.equal(r.reason, 'invalidField');
      if (r.kind === 'field') lField++;
      for (const d of r.drains ?? []) for (const z of zones) assert.ok(overlapMm(d, z) <= TOL, `I1 L字 ${shape}: 水下 ${dkey(d)} と壁 ${dkey(z)}`);
    });
  }
  assert.equal(lField, 8, '検査が空振りしない（field の route は 4+2+2 通り）');
});

test('I3: 壁に接する寄棟の水下は、屋内に接しない全外周と一致（長さの合計＝周長−壁の長さ・どの水下も壁の外）。寸法・壁の位置を振る', () => {
  let n = 0;
  for (const { rect, zones } of rectForms()) {
    const r = route({ shape: RoofShape.HIP, rect, rects: [rect], zeroZones: zones });
    if (r.kind !== 'field') continue;
    n++;
    const perimeter = 2 * ((rect.x2 - rect.x1) + (rect.y2 - rect.y1));
    const edges = orthogonalBoundaryLoops({ rects: [rect], tolMm: TOL }).flat();
    const wallLen = edges.reduce((sum, e) => sum + zones.reduce((s, z) => s + overlapMm(e, z), 0), 0);
    const drainLen = r.drains.reduce((s, d) => s + (d.hi - d.lo), 0);
    assert.ok(Math.abs(drainLen - (perimeter - wallLen)) <= TOL * 8, `水下の長さ ${drainLen} ＝ 周長 ${perimeter} − 壁 ${wallLen}（${JSON.stringify(rect)} ${JSON.stringify(zones)}）`);
  }
  assert.ok(n >= 80, `空振りしない（${n}。辺の一部だけ壁の形は規則で作れない形で field にならない）`);
});

test('I4: 棟が壁と平行な切妻は、同じ矩形の片流れ（高い側＝壁）と、振り分け・棟木・母屋が完全に一致する（寸法を振る）', () => {
  let n = 0;
  for (const [w, h] of [[8000, 3000], [3000, 8000], [9100, 5460], [4550, 1820], [7280, 7280], [6000, 4321]]) {
    const rect = rc(0, 0, w, h);
    for (const ridgeIsVertical of [false, true]) {
      // 棟と平行な辺（軒）の壁側を全部壁にする
      const wallSides = ridgeIsVertical ? [Z(true, 0, 0, h, -1), Z(true, w, 0, h, 1)] : [Z(false, 0, 0, w, -1), Z(false, h, 0, w, 1)];
      for (const wall of wallSides) {
        const g = route({ shape: RoofShape.GABLE, rect, rects: [rect], ridgeIsVertical, zeroZones: [wall] });
        const highSide = wall.isVertical ? (wall.outward < 0 ? 'left' : 'right') : (wall.outward < 0 ? 'top' : 'bottom');
        const m = route({ shape: RoofShape.MONO, rect, rects: [rect], highSide, autoHighSide: highSide, zeroZones: [wall] });
        assert.deepEqual(g, m, `振り分けが一致 ${JSON.stringify(rect)} ridgeV=${ridgeIsVertical} ${highSide}`);
        assert.deepEqual(g, { kind: 'rect', shape: 'mono', highSide });
        const gl = roofFramingLines({ rect, shape: g.shape, highSide: g.highSide, ...layout, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910] });
        const ml = roofFramingLines({ rect, shape: m.shape, highSide: m.highSide, ...layout, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910] });
        assert.deepEqual(gl, ml);
        n += 1;
      }
    }
  }
  assert.equal(n, 24);
});

test('I5: 両腕の内側が壁の L字の切妻と、同じ範囲の L字の片流れで、斜め線・棟木・母屋が一致（roof-test8 と roof-test1）。壁の位置・腕の幅を振る', () => {
  const forms = [
    L,
    // 横の腕の幅 2730・縦の腕の幅 1820
    [rc(3640, -2730, 7280, 0), rc(7280, -2730, 9100, 0), rc(7280, -9884, 9100, -2730)],
    // 縦の腕の幅 2730・横の腕の幅 1820
    [rc(3640, -1820, 7280, 0), rc(7280, -1820, 10010, 0), rc(7280, -9100, 10010, -1820)],
  ];
  for (const rects of forms) {
    // 壁＝L字の内側の2辺（屋内は左上）。辺は外周から求める（左の腕の上辺・縦の腕の左辺）
    const xs = rects.flatMap(r => [r.x1, r.x2]);
    const ys = rects.flatMap(r => [r.y1, r.y2]);
    const innerX = Math.max(Math.min(...xs), rects[0].x2); // 横の腕と縦の腕の境の x（縦の腕の左辺）
    const topY = rects[0].y1; // 横の腕の上辺
    const walls = [Z(false, topY, rects[0].x1, rects[0].x2, -1), Z(true, innerX, Math.min(...ys), topY, -1)];
    const g = route({ shape: RoofShape.GABLE, rect: null, rects, zeroZones: walls });
    const m = route({ shape: RoofShape.MONO, rect: null, rects, zeroZones: walls });
    assert.equal(g.kind, 'field');
    assert.equal(m.kind, 'field');
    assert.deepEqual(g.drains.map(dkey).sort(), m.drains.map(dkey).sort(), '水下が同じ');
    const fr = r => {
      const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: r.purlinDepthMm, ...layout });
      return { eaveGapMm, field: leanToDrainFraming({ rects, drains: r.drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL }) };
    };
    const a = fr(g);
    const b = fr(m);
    assert.deepEqual(lkeys(a.field.ridges), lkeys(b.field.ridges), '棟木が一致（無し）');
    assert.equal(a.field.ridges.length, 0, '棟木は出ない');
    assert.deepEqual(a.field.diagonals.map(d => `${d.kind}:${d.x1},${d.y1}→${d.x2},${d.y2}`).sort(), b.field.diagonals.map(d => `${d.kind}:${d.x1},${d.y1}→${d.x2},${d.y2}`).sort(), '斜め線が一致');
    assert.ok(a.field.diagonals.length > 0, '斜め線がある（検査が空振りしない）');
    if (Math.abs(a.eaveGapMm - b.eaveGapMm) <= TOL) assert.deepEqual(lkeys(a.field.purlins), lkeys(b.field.purlins), 'r が等しいので母屋も一致');
    else assert.fail(`r が違う: 切妻 ${a.eaveGapMm} 片流れ ${b.eaveGapMm}（${JSON.stringify(rects)}）`);
  }
});

test('I7: 壁に接しない矩形の切妻・寄棟を水下の場の経路（leanToDrainFraming）に通した母屋・棟木は、矩形の経路（棟木側から 455/910）と一致する。寸法 18×18×3 形（910・455 の倍数でない値を含む）', () => {
  const sizes = [1820, 2000, 2275, 2730, 3000, 3640, 4000, 4550, 5000, 5460, 6000, 6370, 7000, 7280, 8000, 9100, 4321, 3333];
  let compared = 0;
  let nonEmpty = 0;
  for (const w of sizes) {
    for (const h of sizes) {
      const rect = rc(1000, 2000, 1000 + w, 2000 + h);
      for (const shape of ['gable-h', 'gable-v', 'hip']) {
        const ridgeIsVertical = shape === 'gable-v';
        const rectShape = shape === 'hip' ? RoofShape.HIP : RoofShape.GABLE;
        const drains = naturalDrains(rect, shape === 'hip' ? 'hip' : 'gable', ridgeIsVertical, null);
        const half = shape === 'hip' ? Math.min(w, h) / 2 : (ridgeIsVertical ? w : h) / 2;
        const { eaveGapMm } = purlinLayoutFromRidge({ halfSpanMm: half, ...layout });
        const field = leanToDrainFraming({ rects: [rect], drains, pitchMm: 910, firstLevelMm: eaveGapMm, tolMm: TOL });
        const ref = roofFramingLines({ rect, shape: rectShape, ridgeIsVertical, purlinPitchMm: 910, purlinStartOffsetsMm: [455, 910], tolMm: TOL });
        const label = `${shape} ${w}×${h}`;
        assert.deepEqual(lkeys(field.purlins), lkeys(ref.purlins), `母屋 ${label}`);
        assert.deepEqual(lkeys(field.ridges), lkeys(ref.ridges), `棟木 ${label}`);
        // 斜め線は矩形の寄棟の隅木と同じ（ピッチ・割付に依らない）
        const refDiag = roofHipDiagonals({ rect, shape: rectShape === RoofShape.HIP ? RoofShape.HIP : RoofShape.GABLE, tolMm: TOL });
        if (shape === 'hip') assert.deepEqual(field.diagonals.map(d => `${d.kind}:${d.x1},${d.y1}→${d.x2},${d.y2}`).sort(), refDiag.map(d => `${d.kind}:${d.x1},${d.y1}→${d.x2},${d.y2}`).sort(), `斜め線 ${label}`);
        compared++;
        if (field.purlins.length + field.ridges.length > 0) nonEmpty++;
      }
    }
  }
  assert.equal(compared, 18 * 18 * 3);
  assert.ok(nonEmpty > compared * 0.8, `空の比較ばかりではない（${nonEmpty}/${compared}）`);
});

test('壁に接する寄棟の母屋の段の基準（purlinDepthMm）＝水下の場の D の最大値＝min(壁と直交する水下どうしの間隔/2, 壁から向かいの水下まで)（寸法・壁の4方向を振る。独立の閉形式）', () => {
  let n = 0;
  for (const [w, h] of [[8000, 3000], [3000, 8000], [5460, 3640], [3640, 5460], [4550, 4550], [9100, 1820], [7280, 2730], [6000, 4321]]) {
    const rect = rc(0, 0, w, h);
    const cases = [
      [Z(false, 0, 0, w, -1), w, h], // 上が壁: 左右の間隔 w・壁から下まで h
      [Z(false, h, 0, w, 1), w, h],
      [Z(true, 0, 0, h, -1), h, w], // 左が壁: 上下の間隔 h・壁から右まで w
      [Z(true, w, 0, h, 1), h, w],
    ];
    for (const [wall, span, depth] of cases) {
      const r = route({ shape: RoofShape.HIP, rect, rects: [rect], zeroZones: [wall] });
      assert.equal(r.kind, 'field');
      assert.ok(Math.abs(r.purlinDepthMm - Math.min(span / 2, depth)) <= 1e-3, `${w}×${h} 壁 ${dkey(wall)}: ${r.purlinDepthMm} ＝ min(${span / 2}, ${depth})`);
      n++;
    }
  }
  assert.equal(n, 32);
});
