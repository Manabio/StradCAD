// ブレースの×（S8）の配線テスト。.jsx は node:test から import できないため、ソーステキストを走査して固定する
// （前例: steelSlabPickWiring.test.js）。コメント文への誤一致を避けるためコメントを除いてから照合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const read = rel => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));

test('【配線】StructuralLayer: braceCrossSegments の結果をスラブ塗りの後ろの listening={false} の Group で細線に描く', () => {
  const code = read('../renderer/StructuralLayer.jsx');
  assert.ok(/braceCrossSegments\(slab\.graph, project\)/.test(code), '導出は braceCrossSegments');
  assert.ok(/graphComputed\(slab\.graph, 'braceCross', /.test(code), 'graphComputed で 1 回だけ導く');
  const fillAt = code.indexOf('fill={colorOf(s.materialType)}');
  const braceAt = code.indexOf('braceCrossList.map(');
  const pickAt = code.indexOf('{bayPick && (');
  assert.ok(fillAt >= 0 && braceAt > fillAt && pickAt > braceAt, 'スラブ塗り → ブレースの× → ベイ選択の順');
  const block = code.slice(braceAt, pickAt);
  assert.ok(/stroke=\{BRACE_LINE_COLOR\}/.test(block));
  assert.ok(/strokeWidth=\{thin\}/.test(block));
  assert.ok(/listening=\{false\}/.test(block));
  assert.ok(/import \{ braceCrossSegments \} from '\.\.\/structural\/braceFigure\.js'/.test(code));
});
