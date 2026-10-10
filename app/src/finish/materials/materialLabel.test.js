// 材名の表示用言い換え（純モジュール）。展開図の壁2段書きと天伏パネルが共有する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMaterialLabel } from './materialLabel.js';
import { formatMaterialLabel as reexported } from '../../elevation/elevationFigure.js';

test('formatMaterialLabel: 「せっこうボード t=9.5」→「PB ア)9.5」', () => {
  assert.equal(formatMaterialLabel('せっこうボード t=9.5'), 'PB ア)9.5');
  assert.equal(formatMaterialLabel('せっこうボード t=12.5'), 'PB ア)12.5');
});

test('formatMaterialLabel: 「ビニールクロス」は不変（t=表記もせっこうボードも含まない）', () => {
  assert.equal(formatMaterialLabel('ビニールクロス'), 'ビニールクロス');
});

test('【失敗系】formatMaterialLabel: 文字列でない入力はそのまま返す（null／undefined／数値）', () => {
  assert.equal(formatMaterialLabel(null), null);
  assert.equal(formatMaterialLabel(undefined), undefined);
  assert.equal(formatMaterialLabel(9.5), 9.5);
});

test('elevationFigure.js の formatMaterialLabel は同じ関数の re-export（既存の import 先を壊さない）', () => {
  assert.equal(reexported, formatMaterialLabel);
});
