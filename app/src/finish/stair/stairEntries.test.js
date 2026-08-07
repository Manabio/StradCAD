import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anyCellBoundsOverlap } from './stairEntries.js';

// ---- anyCellBoundsOverlap（下階階段の見下げ upper エントリが自階 install エントリと同一
//      footprint かどうかの判定。cellBounds 同士の総当たり。RECT_OVERLAP_EPS=1mm未満は無視） ----

test('anyCellBoundsOverlap: 空配列・undefined は false', () => {
  const rect = { x1: 0, x2: 10, y1: 0, y2: 10 };
  assert.equal(anyCellBoundsOverlap([], [rect]), false);
  assert.equal(anyCellBoundsOverlap([rect], []), false);
  assert.equal(anyCellBoundsOverlap(undefined, [rect]), false);
  assert.equal(anyCellBoundsOverlap([rect], undefined), false);
});

test('anyCellBoundsOverlap: ちょうど接触（0mm）は false', () => {
  const a = { x1: 0, x2: 10, y1: 0, y2: 10 };
  const b = { x1: 10, x2: 20, y1: 0, y2: 10 }; // aの右端とbの左端が一致
  assert.equal(anyCellBoundsOverlap([a], [b]), false);
});

test('anyCellBoundsOverlap: EPS(1mm)未満の重なりは false', () => {
  const a = { x1: 0, x2: 10, y1: 0, y2: 10 };
  const b = { x1: 9.5, x2: 19.5, y1: 0, y2: 10 }; // x方向に0.5mmだけ重なる
  assert.equal(anyCellBoundsOverlap([a], [b]), false);
});

test('anyCellBoundsOverlap: EPS(1mm)を超える重なりは true', () => {
  const a = { x1: 0, x2: 10, y1: 0, y2: 10 };
  const b = { x1: 5, x2: 15, y1: 0, y2: 10 }; // x方向に5mm重なる
  assert.equal(anyCellBoundsOverlap([a], [b]), true);
});

test('anyCellBoundsOverlap: listA・listBのいずれかの組み合わせで重なれば true（総当たり）', () => {
  const farA  = { x1: 0,   x2: 10,  y1: 0, y2: 10 };
  const nearA = { x1: 100, x2: 110, y1: 0, y2: 10 };
  const b     = { x1: 105, x2: 115, y1: 0, y2: 10 }; // nearA とだけ重なる
  assert.equal(anyCellBoundsOverlap([farA, nearA], [b]), true);
});
