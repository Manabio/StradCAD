// roofDrainReference.js（下屋の屋根面の参照実装＝前線の行進と、不変条件 (a) の検査。テスト専用）の単体テスト。
// 期待値はどれも手計算（水下までの距離）。製品の関数は使わない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainReference, wallDescentViolations } from './roofDrainReference.js';

const R = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const D = (isVertical, coord, lo, hi, outward) => ({ isVertical, coord, lo, hi, outward });
const G = 10;

test('片流れ（矩形）: T は水下までの距離・水下は1本・valid', () => {
  const ref = drainReference({ rects: [R(0, 0, 9100, 3640)], drains: [D(false, 3640, 0, 9100, 1)], gMm: G });
  assert.equal(ref.valid, true);
  assert.ok(Math.abs(ref.tAt(4550, 1000) - 2640) <= G, `T=${ref.tAt(4550, 1000)}`);
  assert.ok(Math.abs(ref.tAt(100, 3600) - 40) <= G, `T=${ref.tAt(100, 3600)}`);
  assert.equal(ref.ownerAt(4550, 1000), 0);
  assert.ok(Number.isNaN(ref.tAt(-100, 1000)), '屋根範囲の外は NaN');
});

test('切妻（矩形）: T＝2本の水下への距離の小さい方・棟（x=4550）で owner が切り替わる', () => {
  const ref = drainReference({ rects: [R(0, 0, 9100, 3640)], drains: [D(true, 0, 0, 3640, -1), D(true, 9100, 0, 3640, 1)], gMm: G });
  assert.equal(ref.valid, true);
  assert.ok(Math.abs(ref.tAt(1000, 500) - 1000) <= G);
  assert.ok(Math.abs(ref.tAt(8000, 500) - 1100) <= G);
  assert.equal(ref.ownerAt(1000, 500), 0);
  assert.equal(ref.ownerAt(8000, 500), 1);
});

test('寄棟（矩形）: T＝4辺への距離の最小・隅（45°）で owner が切り替わる', () => {
  const rects = [R(0, 0, 9100, 5460)];
  const drains = [D(false, 0, 0, 9100, -1), D(false, 5460, 0, 9100, 1), D(true, 0, 0, 5460, -1), D(true, 9100, 0, 5460, 1)];
  const ref = drainReference({ rects, drains, gMm: G });
  assert.equal(ref.valid, true);
  assert.ok(Math.abs(ref.tAt(1000, 2000) - 1000) <= G);
  assert.ok(Math.abs(ref.tAt(4000, 800) - 800) <= G);
  assert.equal(ref.ownerAt(300, 1500), 2, '左の辺の面');
  assert.equal(ref.ownerAt(1500, 300), 0, '上の辺の面');
  assert.ok(Math.abs(ref.tAt(4550, 2730) - 2730) <= G, '棟の端（短手の半分）');
});

test('L字の寄棟（谷あり）: 入隅の谷で T＝入隅の角までの L∞ 距離（水下の端が谷なら前線が45°で外へ伸びる）', () => {
  // 横棒 x0..9100×y0..1820、縦棒 x0..1820×y1820..5460。入隅 (1820,1820)
  const rects = [R(0, 0, 9100, 1820), R(0, 1820, 1820, 5460)];
  const drains = [
    D(false, 0, 0, 9100, -1), D(true, 9100, 0, 1820, 1), D(false, 1820, 1820, 9100, 1),
    D(true, 1820, 1820, 5460, 1), D(false, 5460, 0, 1820, 1), D(true, 0, 0, 5460, -1),
  ];
  const ref = drainReference({ rects, drains, gMm: G });
  assert.equal(ref.valid, true);
  assert.ok(Math.abs(ref.tAt(1000, 1000) - 820) <= G, `入隅の外側: T=${ref.tAt(1000, 1000)}`);
  assert.ok(Math.abs(ref.tAt(1700, 1700) - 120) <= G, `入隅の近く: T=${ref.tAt(1700, 1700)}`);
  assert.ok(Math.abs(ref.tAt(5000, 900) - 900) <= G, '横棒の中');
});

test('水下が辺の途中で終わり、その先が壁: 壁の前の点は前線が届かず valid=false（崖・届かない）', () => {
  // 下辺の右半分だけが水下（左半分は壁）の片流れ
  const ref = drainReference({ rects: [R(0, 0, 9100, 3640)], drains: [D(false, 3640, 4550, 9100, 1)], gMm: G });
  assert.equal(ref.valid, false);
  assert.ok(ref.unreached > 0, `届かないセル=${ref.unreached}`);
  assert.ok(ref.tAt(2000, 1000) === Infinity);
});

test('壁へ下らない (a): 壁から離れるほど T が小さい面は違反なし・壁へ向かって T が下がる面は違反を検出', () => {
  const walls = [D(false, 0, 0, 9100, -1)]; // 上の壁（内向き＝+y）
  const depthsMm = [100, 400, 800, 1600, 3000];
  const down = { walls, tAt: (x, y) => (y >= 0 && y <= 3640 && x >= 0 && x <= 9100 ? 3640 - y : NaN), stepMm: 910, depthsMm, tolMm: 20 };
  const ok = wallDescentViolations(down);
  assert.ok(ok.chains > 0, '前提: 列を検査している');
  assert.deepEqual(ok.violations, []);
  const up = wallDescentViolations({ ...down, tAt: (x, y) => (y >= 0 && y <= 3640 && x >= 0 && x <= 9100 ? y : NaN) });
  assert.ok(up.violations.length > 0, '壁へ向かって下がる面（T が壁から離れるほど増える）は違反');
  assert.equal(up.chains, 10);
});
