// 姿図の配置を描く計画の subjects 絞り（図面モード用）の単体テスト。既定（省略）の出力は placedFigureDrawPlan.test.js が守る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSubject, DetailView } from '../core/constants.js';
import { PlacedFigure } from '../core/placedFigure.js';
import { RoomDetailError } from '../finish/roomDetailTargets.js';
import { square, wallFaceDatums } from '../finish/placedFigure/placedFigureTestFixtures.js';
import { placedFigureDrawPlan } from './placedFigureDrawPlan.js';

const figureOf = key => ({
  san: square('san', { subject: DetailSubject.SANITARY }),
  fur: square('fur', { subject: DetailSubject.FURNITURE }),
  hvac: square('hvac', { subject: DetailSubject.HVAC }),
  sanBad: square('sanBad', { subject: DetailSubject.SANITARY, datums: wallFaceDatums() }),
  furBad: square('furBad', { subject: DetailSubject.FURNITURE, datums: wallFaceDatums() }),
  elev: square('elev', { view: DetailView.ELEVATION }),
}[key] ?? null);
const P = (id, figureKey, x = 100) => new PlacedFigure({ id, figureKey, x, y: 50 });
const ids = list => list.map(o => o.figureId);
const uniq = list => [...new Set(list)];
const SAN = [DetailSubject.SANITARY];

test('subjects を渡すと所属しない分類は lines・marks・boxes のどれにも出ない', () => {
  const placed = [P('a', 'san'), P('b', 'fur')];
  const plan = placedFigureDrawPlan(placed, figureOf, { subjects: SAN });
  assert.deepEqual(uniq(ids(plan.lines)), ['a']);
  assert.deepEqual(ids(plan.boxes), ['a']);
  assert.deepEqual(plan.marks, []);
});

test('分類不明（参照切れ・配置図でない分類）は絞っても×に出る', () => {
  const placed = [P('a', 'gone'), P('b', 'elev'), P('c', 'fur')];
  const plan = placedFigureDrawPlan(placed, figureOf, { subjects: SAN });
  assert.deepEqual(plan.marks.map(m => [m.figureId, m.code]), [['a', null], ['b', RoomDetailError.UNSUPPORTED_SLOT]]);
  assert.deepEqual(plan.lines, []);
  assert.deepEqual(plan.boxes, []);
});

test('分類は分かるが fit に失敗した配置は、所属するときだけ×', () => {
  const placed = [P('a', 'sanBad'), P('b', 'furBad')];
  const plan = placedFigureDrawPlan(placed, figureOf, { subjects: SAN });
  assert.deepEqual(ids(plan.marks), ['a']);
  assert.equal(plan.lines.length, 0);
});

test('subjects 省略・null は絞り無しと同じ出力（JSON 一致）', () => {
  const placed = [P('a', 'san'), P('b', 'fur'), P('c', 'gone'), P('d', 'furBad'), P('e', 'hvac')];
  const base = JSON.stringify(placedFigureDrawPlan(placed, figureOf));
  assert.equal(JSON.stringify(placedFigureDrawPlan(placed, figureOf, { subjects: null })), base);
  assert.equal(JSON.stringify(placedFigureDrawPlan(placed, figureOf, { subjects: undefined })), base);
  assert.equal(JSON.stringify(placedFigureDrawPlan(placed, figureOf, { direction: 'down' })), base);
});

test('見上げは天伏の絞り（空調・電気）と subjects の両方が掛かる', () => {
  const placed = [P('s', 'san'), P('h', 'hvac')];
  const hvacOnly = placedFigureDrawPlan(placed, figureOf, { direction: 'up', subjects: [DetailSubject.HVAC, DetailSubject.SANITARY] });
  assert.deepEqual(uniq(ids(hvacOnly.lines)), ['h']);
  const none = placedFigureDrawPlan(placed, figureOf, { direction: 'up', subjects: SAN });
  assert.deepEqual([none.lines.length, none.marks.length, none.boxes.length], [0, 0, 0]);
  const hvac = placedFigureDrawPlan(placed, figureOf, { direction: 'up', subjects: [DetailSubject.HVAC] });
  assert.deepEqual(ids(hvac.boxes), ['h']);
});
