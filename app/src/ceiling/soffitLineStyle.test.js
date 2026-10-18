// soffitLineStyle.js（見上げの直上階の下屋の軒先・けらばの外形線を中線にする）の単体テスト。
// 本番経路（planSolidsLayerPrimitivesUp）を通すテストは plan/planSolidsLayerFilter.test.js 側。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markEaveOutlineLines } from './soffitLineStyle.js';

const roofLine = (key, role, layerFloorZ, extra = {}) => ({
  kind: 'line', key, points: [0, 0, 1000, 0], weight: 'thin', cls: 'below', detailOnly: false,
  source: { kind: 'roof', id: 'r', role, ...(layerFloorZ === undefined ? {} : { layerFloorZ }) }, ...extra,
});

test('上階の層（layerFloorZ > 0）の下屋の outline だけ medium になる', () => {
  const out = markEaveOutlineLines([roofLine('a', 'outline', 2800), roofLine('b', 'outline', 3000)]);
  assert.deepEqual(out.map(p => p.weight), ['medium', 'medium']);
});

test('自階の層の下屋・hip/ridge/valley・他の種別・線以外は変えない', () => {
  const input = [
    roofLine('self0', 'outline', 0),
    roofLine('selfU', 'outline', undefined),
    roofLine('hip', 'hip', 2800),
    roofLine('ridge', 'ridge', 2800),
    roofLine('norole', undefined, 2800),
    { ...roofLine('beam', 'outline', 2800), source: { kind: 'beam', id: 'b', role: 'outline', layerFloorZ: 2800 } },
    { ...roofLine('arrow', 'outline', 2800), kind: 'arrow' },
  ];
  const out = markEaveOutlineLines(input);
  assert.ok(out.every((p, i) => p === input[i]), '対象外は同一オブジェクトのまま');
  assert.ok(out.every(p => p.weight === 'thin'));
});

test('入力の配列・prim を変更しない（変えた prim は新しいオブジェクト）', () => {
  const p = roofLine('a', 'outline', 2800);
  const input = [p];
  const before = JSON.stringify(input);
  const out = markEaveOutlineLines(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(out, input);
  assert.notEqual(out[0], p);
  assert.equal(p.weight, 'thin');
});

test('【失敗系】空配列・配列でない入力・source の無い／null の要素で例外を出さない', () => {
  assert.deepEqual(markEaveOutlineLines([]), []);
  assert.equal(markEaveOutlineLines(undefined), undefined);
  assert.equal(markEaveOutlineLines(null), null);
  const bare = { kind: 'line', key: 'x', points: [0, 0, 1, 0], weight: 'thin' };
  const out = markEaveOutlineLines([bare, null, undefined]);
  assert.deepEqual(out, [bare, null, undefined]);
});
