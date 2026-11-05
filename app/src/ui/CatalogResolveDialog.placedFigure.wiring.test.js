// CatalogResolveDialog.jsx の LOCATION_LABELS に姿図の配置（location 'placedFigure'。S10 P4）があること。
// .jsx は node:test から単体 import できないため、ソーステキスト検査（トリム後の 1 行まるごと一致）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const text = fs.readFileSync(path.resolve(import.meta.dirname, 'CatalogResolveDialog.jsx'), 'utf8');
const lines = text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
  .filter(line => !line.trim().startsWith('//'))
  .map(l => l.replace(/\s\/\/.*$/, '').trim());

test('【配線】LOCATION_LABELS は placedFigure を DETAIL_TARGET_PLACED_FIGURE（error.js の既存文言）で持つ', () => {
  assert.ok(lines.includes('placedFigure: DETAIL_TARGET_PLACED_FIGURE,'));
  assert.ok(lines.includes("import { DETAIL_TARGET_PLACED_FIGURE } from '../error.js';"));
  const start = lines.indexOf('const LOCATION_LABELS = Object.freeze({');
  const end = lines.indexOf('});', start);
  assert.ok(start >= 0 && lines.slice(start, end).includes('placedFigure: DETAIL_TARGET_PLACED_FIGURE,'), 'LOCATION_LABELS の中にある');
});
