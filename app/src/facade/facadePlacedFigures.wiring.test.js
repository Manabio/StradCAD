// 姿図の配置の立面への配線（facadeFigure.js のソース文字列検査。elevation/elevationPlacedFigures.wiring.test.js と同じ流儀）。
// buildFacadeModel の本体で「建具の push の直後に姿図の配置の push を 1 行で呼ぶ」ことを固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, 'facadeFigure.js'), 'utf8');
const lines = src.split(/\r?\n/);

const CALL = '    primitives.push(...buildFacadePlacedFigures(inputs, view, { uMin, profiles, figureOf }));';
const OPENINGS_PUSH = '    primitives.push(...openings.primitives);';

test('【配線】buildFacadeModel: buildFacadePlacedFigures の呼出しは 1 行まるごと固定・1 回だけ', () => {
  assert.equal(lines.filter(l => l === CALL).length, 1, CALL);
  assert.equal(lines.filter(l => l.includes('buildFacadePlacedFigures(')).length, 1, '呼出しが 1 回でない');
});

test('【配線】姿図の配置の push は建具の push の直後・▽GL の push の前', () => {
  const openings = lines.indexOf(OPENINGS_PUSH);
  const placed = lines.indexOf(CALL);
  const gl = lines.findIndex(l => l.includes('primitives.push(...glPrimitives('));
  assert.ok(openings >= 0 && placed >= 0 && gl >= 0, `見つからない: ${[openings, placed, gl]}`);
  assert.equal(placed, openings + 1, '建具の push の直後でない');
  assert.ok(placed < gl, '▽GL の push より後にある');
});

test('【配線】facadeFigure.js が buildFacadePlacedFigures を import している', () => {
  assert.ok(src.includes("import { buildFacadePlacedFigures, facadePlacedFiguresExtent } from './facadePlacedFigures.js';"));
});
