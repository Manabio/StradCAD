// renderer/chevron.js（StairLayer.jsx から移した矢じりの純関数）の値固定。移す前の式と同じ値であること（挙動0変化）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chevronPoints, CHEVRON_ANGLE } from './chevron.js';

const COS = 0.9009688679024191; // cos(π/7)
const SIN = 0.4338837391175581; // sin(π/7)

const near = (actual, expected, msg) => {
  assert.equal(actual.length, expected.length, msg);
  expected.forEach((v, i) => assert.ok(Math.abs(actual[i] - v) < 1e-9, `${msg} [${i}] ${actual[i]} != ${v}`));
};

test('chevronPoints: 開き角は π/7。先端が点列の中央、左右の点は先端から進行方向の逆へ len だけ開く（4方向）', () => {
  assert.equal(CHEVRON_ANGLE, Math.PI / 7);
  const len = 100;
  const c = COS * len, s = SIN * len;
  near(chevronPoints([-10, 0, 0, 0], len), [-c, -s, 0, 0, -c, s], '右向き');
  near(chevronPoints([10, 0, 0, 0], len), [c, s, 0, 0, c, -s], '左向き');
  near(chevronPoints([0, -10, 0, 0], len), [s, -c, 0, 0, -s, -c], '下向き（y 下向き正）');
  near(chevronPoints([0, 10, 0, 0], len), [-s, c, 0, 0, s, c], '上向き');
});

test('chevronPoints: 点列の最後の2点の向きで決まる（複数点でも終点側）。先端の座標を引き継ぎ、長さ0の線分でも例外にしない', () => {
  const pts = chevronPoints([0, 0, 50, 0, 100, 100], 10);
  assert.deepEqual(pts.slice(2, 4), [100, 100]);
  assert.equal(chevronPoints([5, 5, 5, 5], 10).length, 6, '長さ0（方向不定）でも6要素');
  assert.ok(chevronPoints([5, 5, 5, 5], 10).every(Number.isFinite));
});

test('【不変条件】chevron.js は何も import しない（純モジュール）', () => {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, 'chevron.js'), 'utf8');
  assert.ok(!/^\s*import\b/m.test(text));
});
