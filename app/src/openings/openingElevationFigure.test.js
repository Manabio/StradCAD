import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpeningCategory } from '../core.js';
import { findCatalogEntry } from './openingCatalog.js';
import { buildOpeningElevation } from './openingElevationFigure.js';

// buildOpeningElevation は effectiveHeight(opening) 経由でしか height を読まないため、
// core.js の Opening インスタンスは不要——プリミティブ生成が読む最小限のプロパティを
// 持つダックタイピングの代役で足りる（openingNumbering.test.js と同じ方針）。
function makeOpening(overrides = {}) {
  return {
    width: 1690, height: 1170, sillHeight: 800, category: OpeningCategory.WINDOW, subType: 'doubleSliding',
    hingeSide: -1, swingSide: 1,
    ...overrides,
  };
}

// ---- Finding B 回帰: height に負値が混入しても姿図のrect高さは負にならない ----
test('buildOpeningElevation: height=-500（負値）でも枠のrect(h)は正値になる', () => {
  const opening = makeOpening({ height: -500 });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const outerRect = primitives.find(p => p.type === 'rect');
  assert.ok(outerRect, '枠外形のrectが存在する');
  assert.ok(outerRect.h > 0, `rectのhは正値のはず（実際: ${outerRect.h}）`);
});

test('buildOpeningElevation: 通常値では枠のrect(h)がeffectiveHeightと一致する', () => {
  const opening = makeOpening({ height: 1170 });
  const entry = findCatalogEntry(opening.category, opening.subType);
  const primitives = buildOpeningElevation(opening, { tag: null, entry });

  const outerRect = primitives.find(p => p.type === 'rect');
  assert.equal(outerRect.h, 1170);
});
