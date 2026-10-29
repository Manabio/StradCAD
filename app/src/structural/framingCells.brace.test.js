// framingCells.js のブレースのベイの分割数（divideBayByMaxDiagonal・braceDiagonalExceeded。S7・2026-10-29）の単体テスト。
// 規則: 小区画の対角線長 √(短辺²+(長辺/n)²) が上限 D 以下になる最小の n = ceil(長辺/√(D²−短辺²))。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divideBayByMaxDiagonal, braceDiagonalExceeded } from './framingCells.js';
import { STEEL_BRACE_MAX_DIAGONAL_MM } from '../core/constants.js';

const ROUND = STEEL_BRACE_MAX_DIAGONAL_MM.roundBar; // 7000
const ANGLE = STEEL_BRACE_MAX_DIAGONAL_MM.angle;    // 12000
const bay5000x12000 = { x1: 0, y1: 0, x2: 5000, y2: 12000 };

test('丸鋼 5000×12000 → n=3（√(5000²+4000²)=6403≤7000。n=2 は √(5000²+6000²)=7810>7000）。内部2本・短辺は x 方向', () => {
  const r = divideBayByMaxDiagonal(bay5000x12000, ROUND);
  assert.equal(r.coords.length + 1, 3);
  assert.deepEqual(r.coords, [4000, 8000]);
  assert.equal(r.isVertical, false);
  assert.deepEqual([r.shortLo, r.shortHi, r.longLo, r.longHi], [0, 5000, 0, 12000]);
  assert.equal(braceDiagonalExceeded(bay5000x12000, 3, ROUND), false);
  assert.equal(braceDiagonalExceeded(bay5000x12000, 2, ROUND), true);
});

test('L型鋼 5000×12000 → n=2（√(5000²+6000²)=7810≤12000。n=1 は 13000>12000）', () => {
  const r = divideBayByMaxDiagonal(bay5000x12000, ANGLE);
  assert.deepEqual(r.coords, [6000]);
});

test('幅が長辺のベイは縦梁（12000×5000 → x を 3 等分、短辺は y 方向）', () => {
  const r = divideBayByMaxDiagonal({ x1: 0, y1: 0, x2: 12000, y2: 5000 }, ROUND);
  assert.equal(r.isVertical, true);
  assert.deepEqual(r.coords, [4000, 8000]);
  assert.deepEqual([r.shortLo, r.shortHi], [0, 5000]);
});

test('【境界】対角線長がちょうど上限になる分割は許す（短辺3000・D=5000 → 長辺ピッチ4000: 12000 は n=3）', () => {
  const cell = { x1: 0, y1: 0, x2: 3000, y2: 12000 };
  assert.equal(divideBayByMaxDiagonal(cell, 5000).coords.length + 1, 3);
  assert.equal(braceDiagonalExceeded(cell, 3, 5000), false);
});

test('【失敗系】短辺が上限以上なら成立しない → { fallback: true }（ちょうど上限も。呼び出し側が 2500 ピッチ規則へ戻す）', () => {
  assert.deepEqual(divideBayByMaxDiagonal({ x1: 0, y1: 0, x2: 7200, y2: 20000 }, ROUND), { fallback: true });
  assert.deepEqual(divideBayByMaxDiagonal({ x1: 0, y1: 0, x2: 7000, y2: 20000 }, ROUND), { fallback: true });
  assert.ok(divideBayByMaxDiagonal({ x1: 0, y1: 0, x2: 6999, y2: 20000 }, ROUND).coords, '6999 は成立する');
});

test('【失敗系】割らなくても対角線長が上限以内（n=1）は null（子梁不要）', () => {
  assert.equal(divideBayByMaxDiagonal({ x1: 0, y1: 0, x2: 5000, y2: 4000 }, ROUND), null); // √(4000²+5000²)=6403
});
