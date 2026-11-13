// 図面モードへの所属の判定（placedFigureTargets.js placedFigureBelongsTo）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailSubject, DetailView } from '../../core/constants.js';
import { placedFigureBelongsTo } from './placedFigureTargets.js';
import { square } from './placedFigureTestFixtures.js';

const figs = (...list) => key => list.find(f => f.key === key) ?? null;
const figureOf = figs(
  square('san', { subject: DetailSubject.SANITARY }),
  square('fur', { subject: DetailSubject.FURNITURE }),
  square('elev', { view: DetailView.ELEVATION }),
);
const pf = figureKey => ({ figureKey });

test('subjects が null／undefined は絞らない（true）', () => {
  assert.equal(placedFigureBelongsTo(pf('san'), figureOf, null), true);
  assert.equal(placedFigureBelongsTo(pf('fur'), figureOf, undefined), true);
});

test('分類が subjects に含まれれば true・含まれなければ false', () => {
  const subjects = [DetailSubject.SANITARY];
  assert.equal(placedFigureBelongsTo(pf('san'), figureOf, subjects), true);
  assert.equal(placedFigureBelongsTo(pf('fur'), figureOf, subjects), false);
});

test('【失敗系】分類不明（参照切れ・配置図でない・配置が無い）はどのモードにも所属する', () => {
  const subjects = [DetailSubject.SANITARY];
  assert.equal(placedFigureBelongsTo(pf('gone'), figureOf, subjects), true);
  assert.equal(placedFigureBelongsTo(pf('elev'), figureOf, subjects), true);
  assert.equal(placedFigureBelongsTo(null, figureOf, subjects), true);
  assert.equal(placedFigureBelongsTo(pf('gone'), figureOf, []), true);
});
