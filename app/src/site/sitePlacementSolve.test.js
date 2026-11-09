// 敷地の配置を解く純関数（site/sitePlacementSolve.js）のテスト。期待値は手計算の具体数値（関数の式を写さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CenterLineType } from '../core/constants.js';
import { computeSitePlacement, normalizeAngle180, normalizeLineAngle90 } from './sitePlacementSolve.js';
import { applySiteTransform } from './siteTransform.js';

const EPS = 1e-6;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, `${msg ?? ''} ${a} vs ${b}`);
const ID = { rotationDeg: 0, tx: 0, ty: 0 };
const V = (value) => ({ centerLineType: CenterLineType.VERTICAL, value });
const H = (value) => ({ centerLineType: CenterLineType.HORIZONTAL, value });
const base = { rotationFlipped: false, sideFlipped: false, buildingCenter: null, prevTransform: ID };

// ---- 角度の正規化 ----

test('normalizeAngle180: (−180,180] へ寄せる（180 は残り −180 は 180 へ）', () => {
  const cases = [[0, 0], [180, 180], [-180, 180], [190, -170], [-170, -170], [360, 0], [540, 180], [-190, 170]];
  for (const [input, expected] of cases) close(normalizeAngle180(input), expected, `入力 ${input}`);
});

test('normalizeLineAngle90: (−90,90] へ寄せる（90 は残り −90 は 90 へ・180 違いは同じ直線）', () => {
  const cases = [[0, 0], [90, 90], [-90, 90], [100, -80], [-100, 80], [180, 0], [270, 90], [-45, -45]];
  for (const [input, expected] of cases) close(normalizeLineAngle90(input), expected, `入力 ${input}`);
});

// ---- 回転 ----

test('縦の通り芯（x=10000）: 縦の線分は回転 0（建物図芯が東にあるので像は西 3000 の x=7000。tx=7000, ty=0）', () => {
  const r = computeSitePlacement({ ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000, buildingCenter: { x: 20000, y: 0 } });
  close(r.rotationDeg, 0); close(r.tx, 7000); close(r.ty, 0);
});

test('縦の通り芯: 横の線分は 90 度回して平行にする（v1=(1000,2000) → 像 (13000,2700)。t=(15000,1700)）。v2 の像の x も 13000', () => {
  const r = computeSitePlacement({
    ...base, v1: { x: 1000, y: 2000 }, v2: { x: 6000, y: 2000 }, centerLine: V(10000), distance: 3000,
    buildingCenter: { x: 0, y: 0 }, prevTransform: { rotationDeg: 0, tx: 500, ty: 700 },
  });
  close(r.rotationDeg, 90); close(r.tx, 15000); close(r.ty, 1700);
  const t = { rotationDeg: r.rotationDeg, tx: r.tx, ty: r.ty };
  const p1 = applySiteTransform({ x: 1000, y: 2000 }, t), p2 = applySiteTransform({ x: 6000, y: 2000 }, t);
  close(p1.x, 13000, 'v1'); close(p2.x, 13000, 'v2'); close(p1.y, 2700, '沿い座標は前回の像のまま');
});

test('横の通り芯（y=4000）: 縦の線分は 90 度（−90 は境界で除かれ 90）。v1=(100,50) → 像 (150,3000)（沿い座標は前回像の x）。t=(200,2900)', () => {
  const r = computeSitePlacement({
    ...base, v1: { x: 100, y: 50 }, v2: { x: 100, y: 5050 }, centerLine: H(4000), distance: 1000,
    buildingCenter: { x: 0, y: 10000 }, prevTransform: { rotationDeg: 90, tx: 200, ty: 300 },
  });
  close(r.rotationDeg, 90); close(r.tx, 200); close(r.ty, 2900);
  const t = { rotationDeg: r.rotationDeg, tx: r.tx, ty: r.ty };
  const p1 = applySiteTransform({ x: 100, y: 50 }, t), p2 = applySiteTransform({ x: 100, y: 5050 }, t);
  close(p1.y, 3000, 'v1'); close(p2.y, 3000, 'v2'); close(p1.x, 150, '沿い座標（前回の像の x）');
});

test('斜めの線分: 45 度と 225 度の差は (−90,90] へ寄せる（v2 が北東 → 縦なら 45、南西 → 45）。北西 → −45', () => {
  const mk = (x, y) => computeSitePlacement({ ...base, v1: { x: 0, y: 0 }, v2: { x, y }, centerLine: V(0), distance: 100 });
  close(mk(1000, 1000).rotationDeg, 45);
  close(mk(-1000, -1000).rotationDeg, 45);
  close(mk(-1000, 1000).rotationDeg, -45);
  close(mk(1000, -1000).rotationDeg, -45);
});

test('どの向きの線分でも |回転| は 90 以下で、像の線分は通り芯と平行（縦: 両端の x が一致。横: y が一致）', () => {
  for (let deg = -170; deg <= 180; deg += 10) {
    const rad = deg * Math.PI / 180;
    const v1 = { x: 300, y: -200 }, v2 = { x: 300 + 4000 * Math.cos(rad), y: -200 + 4000 * Math.sin(rad) };
    for (const [cl, key] of [[V(5000), 'x'], [H(5000), 'y']]) {
      const r = computeSitePlacement({ ...base, v1, v2, centerLine: cl, distance: 700 });
      assert.ok(Math.abs(r.rotationDeg) <= 90, `${deg}° → ${r.rotationDeg}`);
      const a = applySiteTransform(v1, r), b = applySiteTransform(v2, r);
      close(a[key], b[key], `${deg}° ${key}`);
    }
  }
});

test('rotationFlipped: 回転が半周（180 度）違いになり、像は依然として通り芯と平行', () => {
  const args = { ...base, v1: { x: 0, y: 0 }, v2: { x: 5000, y: 0 }, centerLine: V(10000), distance: 3000 };
  const a = computeSitePlacement(args);
  const b = computeSitePlacement({ ...args, rotationFlipped: true });
  close(a.rotationDeg, 90); close(b.rotationDeg, -90);
  const v1b = applySiteTransform(args.v1, b), v2b = applySiteTransform(args.v2, b);
  close(v2b.x, v1b.x);
  close(v2b.y - v1b.y, -5000, '反転すると線分は反対向き（上）に伸びる');
  // 0 度の例では 0 → 180（(−180,180] の端は 180）
  const c = computeSitePlacement({ ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000, rotationFlipped: true });
  close(c.rotationDeg, 180);
});

// ---- 距離と側 ----

test('距離: 像の直交座標と通り芯の差の絶対値が distance（縦・横とも）', () => {
  const v1 = { x: 1200, y: 800 }, v2 = { x: 4200, y: 800 };
  const rv = computeSitePlacement({ ...base, v1, v2, centerLine: V(10000), distance: 2500 });
  close(Math.abs(applySiteTransform(v1, rv).x - 10000), 2500);
  const rh = computeSitePlacement({ ...base, v1, v2, centerLine: H(-3000), distance: 1800 });
  close(Math.abs(applySiteTransform(v1, rh).y - (-3000)), 1800);
});

test('側: 建物図芯の反対側（図芯が通り芯より大きい側なら像は小さい側）。sideFlipped で反転', () => {
  const args = { ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 1000 }, centerLine: V(10000), distance: 3000 };
  const east = computeSitePlacement({ ...args, buildingCenter: { x: 12000, y: 0 } });
  const west = computeSitePlacement({ ...args, buildingCenter: { x: 8000, y: 0 } });
  close(applySiteTransform(args.v1, east).x, 7000);
  close(applySiteTransform(args.v1, west).x, 13000);
  const flipped = computeSitePlacement({ ...args, buildingCenter: { x: 12000, y: 0 }, sideFlipped: true });
  close(applySiteTransform(args.v1, flipped).x, 13000);
  // 横の通り芯（y=4000）。図芯が下（y が大きい）なら像は上
  const h = computeSitePlacement({ ...args, v2: { x: 1000, y: 0 }, centerLine: H(4000), buildingCenter: { x: 0, y: 9000 } });
  close(applySiteTransform(args.v1, h).y, 1000);
});

test('建物図芯が無い: 前回の変換で写した頂点1と同じ側に置く（sideFlipped で反対側）', () => {
  const args = { ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 1000 }, centerLine: V(10000), distance: 3000 };
  const left = computeSitePlacement({ ...args, prevTransform: { rotationDeg: 0, tx: 8000, ty: 0 } });
  const right = computeSitePlacement({ ...args, prevTransform: { rotationDeg: 0, tx: 12000, ty: 0 } });
  close(applySiteTransform(args.v1, left).x, 7000);
  close(applySiteTransform(args.v1, right).x, 13000);
  const flipped = computeSitePlacement({ ...args, prevTransform: { rotationDeg: 0, tx: 8000, ty: 0 }, sideFlipped: true });
  close(applySiteTransform(args.v1, flipped).x, 13000);
});

test('沿い座標: 前回の変換（回転あり）で写した頂点1の通り芯沿いの座標を保つ', () => {
  // 前回 R(90)・t=(200,300): v1=(100,50) → (−50+200, 100+300)=(150,400)。縦の通り芯なら沿い座標は y=400（今回の回転は 0）
  const r = computeSitePlacement({
    ...base, v1: { x: 100, y: 50 }, v2: { x: 100, y: 1050 }, centerLine: V(10000), distance: 1000,
    buildingCenter: { x: 0, y: 0 }, prevTransform: { rotationDeg: 90, tx: 200, ty: 300 },
  });
  const p = applySiteTransform({ x: 100, y: 50 }, r);
  close(p.y, 400); close(p.x, 11000);
});

// ---- 2 段目「位置」（along） ----

const near = (p, x, y, msg) => { close(p.x, x, `${msg ?? ''} x`); close(p.y, y, `${msg ?? ''} y`); };
const along = (vertex, centerLine, distance, sideFlipped = false) => ({ vertex, centerLine, distance, sideFlipped });

test('along 縦A×横B・共有点=頂点1: v1=(0,0)・v2=(0,5000)・A=x10000 距離3000・B=y2000 離れ500・図芯(20000,0) → v1 の像 (7000,2500)・v2 の像 (7000,7500)。t=(7000,2500)', () => {
  const r = computeSitePlacement({
    ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000,
    buildingCenter: { x: 20000, y: 0 }, along: along(1, H(2000), 500),
  });
  close(r.rotationDeg, 0); close(r.tx, 7000); close(r.ty, 2500);
  near(applySiteTransform({ x: 0, y: 0 }, r), 7000, 2500, 'v1（共有点 y=B+500）');
  near(applySiteTransform({ x: 0, y: 5000 }, r), 7000, 7500, 'v2（1 段目の拘束 x=7000 は保たれる）');
});

test('along 縦A×横B・共有点=頂点2: 同じ入力で共有点が v2 → v2 の像が (7000,2500)・v1 の像が (7000,−2500)。t=(7000,−2500)', () => {
  const r = computeSitePlacement({
    ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000,
    buildingCenter: { x: 20000, y: 0 }, along: along(2, H(2000), 500),
  });
  close(r.rotationDeg, 0); close(r.tx, 7000); close(r.ty, -2500);
  near(applySiteTransform({ x: 0, y: 5000 }, r), 7000, 2500, 'v2（共有点）');
  near(applySiteTransform({ x: 0, y: 0 }, r), 7000, -2500, 'v1');
});

test('along 横A×縦B・共有点=頂点1（回転 90 度）: v1=(100,50)・v2=(100,5050)・A=y4000 距離1000・B=x9000 離れ800・図芯(0,10000) → v1 の像 (9800,3000)・v2 の像 (4800,3000)。t=(9850,2900)', () => {
  const r = computeSitePlacement({
    ...base, v1: { x: 100, y: 50 }, v2: { x: 100, y: 5050 }, centerLine: H(4000), distance: 1000,
    buildingCenter: { x: 0, y: 10000 }, along: along(1, V(9000), 800),
  });
  close(r.rotationDeg, 90); close(r.tx, 9850); close(r.ty, 2900);
  near(applySiteTransform({ x: 100, y: 50 }, r), 9800, 3000, 'v1（共有点 x=B+800）');
  near(applySiteTransform({ x: 100, y: 5050 }, r), 4800, 3000, 'v2（1 段目の拘束 y=3000 は保たれる）');
});

test('along 横A×縦B・共有点=頂点2（回転 90 度）: v2 の像が (9800,3000)・v1 の像が (14800,3000)。t=(14850,2900)', () => {
  const r = computeSitePlacement({
    ...base, v1: { x: 100, y: 50 }, v2: { x: 100, y: 5050 }, centerLine: H(4000), distance: 1000,
    buildingCenter: { x: 0, y: 10000 }, along: along(2, V(9000), 800),
  });
  close(r.rotationDeg, 90); close(r.tx, 14850); close(r.ty, 2900);
  near(applySiteTransform({ x: 100, y: 5050 }, r), 9800, 3000, 'v2（共有点）');
  near(applySiteTransform({ x: 100, y: 50 }, r), 14800, 3000, 'v1');
});

test('along: 回転は along が無いときと同じ（位置は平行移動だけを決める）。rotationFlipped でも共有点が B から離れ分の位置にある', () => {
  const args = {
    ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000,
    buildingCenter: { x: 20000, y: 0 }, rotationFlipped: true,
  };
  const without = computeSitePlacement(args);
  const withAlong = computeSitePlacement({ ...args, along: along(2, H(2000), 500) });
  close(withAlong.rotationDeg, without.rotationDeg); close(withAlong.rotationDeg, 180);
  // 回転 180: R·(v2−v1)=(0,−5000) → v1 の沿い座標 = 2500 − (−5000) = 7500。v2 の像は (7000, 2500)
  near(applySiteTransform({ x: 0, y: 0 }, withAlong), 7000, 7500, 'v1');
  near(applySiteTransform({ x: 0, y: 5000 }, withAlong), 7000, 2500, 'v2（共有点）');
});

test('along.sideFlipped: B のどちら側かが反転する（図芯が B の手前 → 通常は B+離れ、反転で B−離れ）。1 段目の側は変わらない', () => {
  const args = {
    ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000, buildingCenter: { x: 20000, y: 0 },
  };
  near(applySiteTransform({ x: 0, y: 0 }, computeSitePlacement({ ...args, along: along(1, H(2000), 500) })), 7000, 2500);
  near(applySiteTransform({ x: 0, y: 0 }, computeSitePlacement({ ...args, along: along(1, H(2000), 500, true) })), 7000, 1500);
  // 図芯が B より大きい側（y=3000）なら通常は B−離れ
  const south = computeSitePlacement({ ...args, buildingCenter: { x: 20000, y: 3000 }, along: along(1, H(2000), 500) });
  near(applySiteTransform({ x: 0, y: 0 }, south), 7000, 1500);
});

test('along・図芯なし: 前回の変換で写した共有点と同じ側に置く（B=y2000: 前回の像 y=1000 → B−500=1500／y=5000 → B+500=2500）。sideFlipped で反対側', () => {
  const args = {
    ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000, along: along(1, H(2000), 500),
  };
  const below = computeSitePlacement({ ...args, prevTransform: { rotationDeg: 0, tx: 8000, ty: 1000 } });
  near(applySiteTransform({ x: 0, y: 0 }, below), 7000, 1500, '前回の像が B の手前');
  const above = computeSitePlacement({ ...args, prevTransform: { rotationDeg: 0, tx: 8000, ty: 5000 } });
  near(applySiteTransform({ x: 0, y: 0 }, above), 7000, 2500, '前回の像が B の向こう');
  const flipped = computeSitePlacement({ ...args, prevTransform: { rotationDeg: 0, tx: 8000, ty: 1000 }, along: along(1, H(2000), 500, true) });
  near(applySiteTransform({ x: 0, y: 0 }, flipped), 7000, 2500, 'sideFlipped');
  // 共有点が v2 のときは v2 の前回の像で側を決める（v2 の前回の像 y=1000+5000=6000 → B の向こう → +）
  const k2 = computeSitePlacement({ ...args, along: along(2, H(2000), 500), prevTransform: { rotationDeg: 0, tx: 8000, ty: 1000 } });
  near(applySiteTransform({ x: 0, y: 5000 }, k2), 7000, 2500, '共有点 v2 の前回の像で判定');
});

test('along が無い（省略・null）: 沿い座標は従来どおり前回の像のまま（R6。v1 の前回の像 y=700）', () => {
  const args = { ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000, prevTransform: { rotationDeg: 0, tx: 8000, ty: 700 } };
  const omitted = computeSitePlacement(args);
  const nulled = computeSitePlacement({ ...args, along: null });
  near(applySiteTransform({ x: 0, y: 0 }, omitted), 7000, 700);
  assert.deepEqual(nulled, omitted);
});

test('【失敗系】along: 1 段目と同じ軸の通り芯（過剰拘束）・離れが 0 以下／非有限・共有点が 1/2 以外・種別不明・値が非有限は null', () => {
  const ok = { ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 5000 }, centerLine: V(10000), distance: 3000, along: along(1, H(2000), 500) };
  assert.notEqual(computeSitePlacement(ok), null);
  assert.equal(computeSitePlacement({ ...ok, along: along(1, V(2000), 500) }), null, '1 段目と同じ縦');
  assert.equal(computeSitePlacement({ ...ok, centerLine: H(10000), along: along(1, H(2000), 500) }), null, '1 段目が横で B も横');
  for (const distance of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(computeSitePlacement({ ...ok, along: along(1, H(2000), distance) }), null, `離れ=${distance}`);
  }
  for (const vertex of [0, 3, undefined]) {
    assert.equal(computeSitePlacement({ ...ok, along: along(vertex, H(2000), 500) }), null, `共有点=${vertex}`);
  }
  assert.equal(computeSitePlacement({ ...ok, along: along(1, { centerLineType: CenterLineType.RADIAL, value: 45 }, 500) }), null, '放射');
  assert.equal(computeSitePlacement({ ...ok, along: along(1, null, 500) }), null, '通り芯なし');
  assert.equal(computeSitePlacement({ ...ok, along: along(1, H(NaN), 500) }), null, '通り芯の値が NaN');
});

// ---- 解けない入力 ----

test('【失敗系】解けない入力は null（線分の長さ 0・距離が 0 以下／非有限・通り芯の種別が不明）', () => {
  const ok = { ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 1000 }, centerLine: V(10000), distance: 3000 };
  assert.notEqual(computeSitePlacement(ok), null);
  assert.equal(computeSitePlacement({ ...ok, v2: { x: 0, y: 0 } }), null, '長さ 0');
  for (const distance of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(computeSitePlacement({ ...ok, distance }), null, `distance=${distance}`);
  }
  assert.equal(computeSitePlacement({ ...ok, centerLine: { centerLineType: CenterLineType.RADIAL, value: 45 } }), null, '放射');
  assert.equal(computeSitePlacement({ ...ok, centerLine: null }), null, '通り芯なし');
  assert.equal(computeSitePlacement({ ...ok, v1: { x: NaN, y: 0 } }), null, '頂点1の座標が NaN');
  assert.equal(computeSitePlacement({ ...ok, v2: { x: 0, y: Infinity } }), null, '頂点2の座標が非有限');
  assert.equal(computeSitePlacement({ ...ok, centerLine: V(undefined) }), null, '通り芯の値が無い');
});

// ---- 既定の挙動 ----

test('prevTransform 省略（undefined／null）は恒等変換として扱う（v1=(100,50)・縦 x=10000・距離 1000・図芯 (0,0) → 像 (11000,50)）', () => {
  for (const prevTransform of [undefined, null]) {
    const r = computeSitePlacement({ ...base, v1: { x: 100, y: 50 }, v2: { x: 100, y: 1050 }, centerLine: V(10000), distance: 1000, buildingCenter: { x: 0, y: 0 }, prevTransform });
    const p = applySiteTransform({ x: 100, y: 50 }, r);
    close(p.x, 11000, `prevTransform=${prevTransform}`); close(p.y, 50, `prevTransform=${prevTransform}`);
  }
});

test('【既定】図芯なしで前回の像がちょうど通り芯上なら + 側（像 x=13000。sideFlipped で 7000）。図芯がちょうど通り芯上でも + 側', () => {
  const args = { ...base, v1: { x: 0, y: 0 }, v2: { x: 0, y: 1000 }, centerLine: V(10000), distance: 3000, prevTransform: { rotationDeg: 0, tx: 10000, ty: 0 } };
  close(applySiteTransform(args.v1, computeSitePlacement(args)).x, 13000);
  close(applySiteTransform(args.v1, computeSitePlacement({ ...args, sideFlipped: true })).x, 7000);
  close(applySiteTransform(args.v1, computeSitePlacement({ ...args, buildingCenter: { x: 10000, y: 0 } })).x, 13000);
});
