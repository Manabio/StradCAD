// 姿図の配置の展開図への配線（elevationFigure.js のソース文字列検査。elevationBand.wiring.test.js と同じ流儀）。
// buildFaceFigure は実 graph・実 room が要る巨大関数なので、「appendOpenings の直後に appendPlacedFigures を 1 行で呼ぶ」ことを本体の文字列で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, 'elevationFigure.js'), 'utf8');
const lines = src.split(/\r?\n/);
const countOf = needle => lines.filter(l => l.includes(needle)).length;

const CALL = '  appendPlacedFigures(prims, { face, room, graph, figureOf: detailFigureEntry, floorDyAt });';

test('【配線】buildFaceFigure: appendPlacedFigures の呼出しは 1 行まるごと固定・1 回だけ', () => {
  assert.equal(lines.filter(l => l === CALL).length, 1, CALL);
  assert.equal(countOf('appendPlacedFigures('), 1, '呼出しが 1 回でない');
});

test('【配線】appendPlacedFigures は appendOpenings の呼出しの後・appendCornerSections の呼出しの前', () => {
  const at = needle => lines.findIndex(l => l.includes(needle));
  const openings = at('appendOpenings(prims, {');
  const placed = at('appendPlacedFigures(prims, {');
  const corner = at('appendCornerSections(prims, {');
  assert.ok(openings >= 0 && placed >= 0 && corner >= 0, `見つからない: ${[openings, placed, corner]}`);
  assert.ok(openings < placed, 'appendOpenings より前にある');
  assert.ok(placed < corner, 'appendCornerSections より後にある');
});

test('【配線】elevationFigure.js が appendPlacedFigures と detailFigureEntry を import している', () => {
  assert.ok(src.includes("import { appendPlacedFigures } from './elevationPlacedFigures.js';"));
  assert.ok(/import \{[^}]*\bdetailFigureEntry\b[^}]*\} from '\.\.\/openings\/openingCatalog\.js';/.test(src));
});
