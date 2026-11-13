// placedFigureSubjectOf（placedFigureTargets.js）: 配置の分類を図から引く。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailCategory, DetailView, DetailSubject, PLACED_FIGURE_SUBJECTS } from '../../core/constants.js';
import { PlacedFigure } from '../../core/placedFigure.js';
import { placedFigureSubjectOf } from './placedFigureTargets.js';

const fig = (over = {}) => ({ key: 'k', category: DetailCategory.FIGURE, view: DetailView.PLAN, subject: DetailSubject.SANITARY, ...over });
const placed = (figureKey = 'k') => new PlacedFigure({ id: 'a', figureKey, x: 0, y: 0 });
const lookup = figs => key => figs[key];

test('配置図（衛生・家具・空調・電気の平面の姿図）はその subject を返す', () => {
  for (const subject of PLACED_FIGURE_SUBJECTS) {
    assert.equal(placedFigureSubjectOf(placed('k'), lookup({ k: fig({ subject }) })), subject);
  }
});

test('【失敗系】立面の姿図・建具の図・part の図は null（配置図でない）', () => {
  for (const over of [
    { view: DetailView.ELEVATION },
    { subject: DetailSubject.OPENING },
    { category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL },
  ]) {
    assert.equal(placedFigureSubjectOf(placed('k'), lookup({ k: fig(over) })), null, JSON.stringify(over));
  }
});

test('【失敗系】参照切れ（figureOf が undefined／null）・figureKey 無し・placedFigure が null は null', () => {
  assert.equal(placedFigureSubjectOf(placed('gone'), lookup({})), null);
  assert.equal(placedFigureSubjectOf(placed('k'), () => null), null);
  assert.equal(placedFigureSubjectOf({ id: 'a' }, lookup({})), null);
  assert.equal(placedFigureSubjectOf(null, lookup({})), null);
});
