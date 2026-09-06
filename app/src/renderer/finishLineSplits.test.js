import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFinishLineMerges } from './finishLineSplits.js';

// 既定の線分。mergeLo/mergeHi は lo/hi と同じ（木口線だけ呼び出し側が切り詰めて渡す）。
const seg = (key, at, lo, hi, opts = {}) => ({
  key, at, lo, hi,
  vertical: opts.vertical ?? true,
  mergeLo: opts.mergeLo ?? lo,
  mergeHi: opts.mergeHi ?? hi,
  fillerMax: opts.fillerMax ?? 115,
  styleKey: opts.styleKey ?? 'k',
});

test('resolveFinishLineMerges: 単独の線分は手を触れない', () => {
  assert.equal(resolveFinishLineMerges([seg('a', 100, 0, 1000)]).size, 0);
});

test('resolveFinishLineMerges: 埋め線を吸収して本体が連なり全体を引く', () => {
  const r = resolveFinishLineMerges([seg('body', 100, 0, 1000), seg('fill', 100, 1000, 1115)]);
  assert.deepEqual(r.get('body'), [0, 1115]);
  assert.equal(r.get('fill'), null);
});

test('resolveFinishLineMerges: 埋め線を含まない連なり（長い壁どうしの接続）はまとめない', () => {
  assert.equal(resolveFinishLineMerges([seg('a', 100, 0, 1000), seg('b', 100, 1000, 3000)]).size, 0);
});

test('resolveFinishLineMerges: 埋め線だけの連なりは主体が無いのでまとめない', () => {
  const r = resolveFinishLineMerges([seg('a', 100, 0, 100), seg('b', 100, 100, 200)]);
  assert.equal(r.size, 0);
});

test('resolveFinishLineMerges: 位置が0.5mm以内なら同一直線として扱う（浮動小数の微差）', () => {
  const r = resolveFinishLineMerges([seg('a', 100, 0, 1000), seg('b', 100.3, 1000, 1115)]);
  assert.deepEqual(r.get('a'), [0, 1115]);
});

test('resolveFinishLineMerges: 位置が離れた平行線はまとめない', () => {
  assert.equal(resolveFinishLineMerges([seg('a', 100, 0, 1000), seg('b', 112.5, 1000, 1115)]).size, 0);
});

test('resolveFinishLineMerges: 開口で分かれた線分（隙間あり）はまとめない', () => {
  assert.equal(resolveFinishLineMerges([seg('a', 100, 0, 1000), seg('b', 100, 1800, 3000)]).size, 0);
});

test('resolveFinishLineMerges: 縦線と横線は位置が同値でもまとめない', () => {
  const r = resolveFinishLineMerges([
    seg('v', 100, 0, 1000, { vertical: true }),
    seg('h', 100, 1000, 1115, { vertical: false }),
  ]);
  assert.equal(r.size, 0);
});

test('resolveFinishLineMerges: 線種が違う線分はまとめない', () => {
  const r = resolveFinishLineMerges([
    seg('a', 100, 0, 1000, { styleKey: 'black|thin|solid' }),
    seg('b', 100, 1000, 1115, { styleKey: 'black|thin|dashed' }),
  ]);
  assert.equal(r.size, 0);
});

// 実機2026-09（2階X2×Y1+2000の出隅）。外側（面線 y=-2057.5）は妻線まで含めて
// 相手の仕上げ面(-2942.5)まで、内側（内側線 y=-2045）は木口線を自壁の内側線(-2955)で
// 切り詰めた区間までを1本にする（ユーザー確定「案A」）。
test('resolveFinishLineMerges: 出隅の外側線は相手の仕上げ面まで1本になる', () => {
  const r = resolveFinishLineMerges([
    seg('faceA', -2057.5, -5542.5, -3057.5, { vertical: false, fillerMax: 102.5 }),
    seg('koma',  -2057.5, -3057.5, -3045,   { vertical: false, fillerMax: 102.5 }),
    seg('cap',   -2057.5, -3045,   -2942.5, { vertical: false, fillerMax: 102.5 }),
  ]);
  assert.deepEqual(r.get('faceA'), [-5542.5, -2942.5]);
  assert.equal(r.get('koma'), null);
  assert.equal(r.get('cap'), null);
});

test('resolveFinishLineMerges: 出隅の内側線は木口線を自壁の内側線で切り詰めて1本になる', () => {
  const r = resolveFinishLineMerges([
    seg('finA', -2045, -5542.5, -3057.5, { vertical: false, fillerMax: 102.5 }),
    seg('koma', -2045, -3057.5, -3045,   { vertical: false, fillerMax: 102.5 }),
    // 木口線は材幅いっぱい(-3045〜-2942.5)に描かれるが、まとめる区間は内側線(-2955)まで
    seg('ecap', -2045, -3045, -2942.5,   { vertical: false, fillerMax: 102.5, mergeHi: -2955 }),
  ]);
  assert.deepEqual(r.get('finA'), [-5542.5, -2955]);
  assert.equal(r.get('koma'), null);
  assert.equal(r.get('ecap'), null);
});
