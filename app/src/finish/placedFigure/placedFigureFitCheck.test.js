// 姿図の配置の通知の集計（finish/placedFigure/placedFigureFitCheck.js。部分詳細図 S10 P4）の単体テスト。
// 図は entryOf の差し替え口で渡す（カタログ・overlay を触らない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PenDir, DetailCategory, DetailView, DetailSubject, DetailSlot, DetailParam, DetailPlacementView, DETAIL_VIEWS_FIELD } from '../../core/constants.js';
import { fitLocal } from '../../detail/detailPlacement.js';
import { move, paramLen } from '../roomDetailTestFixtures.js';
import { placedFigureTargets } from './placedFigureTargets.js';
import { PlacedFigure } from '../../core/placedFigure.js';
import { ERR_DETAIL_FIT_FAILED, ERR_DETAIL_FIGURE_NOT_FOUND, ERR_DETAIL_NOT_PLACED_FIGURE, DETAIL_TARGET_PLACED_FIGURE } from '../../error.js';
import { collectPlacedFigureFailures } from './placedFigureFitCheck.js';
import { square, wallFaceDatums } from './placedFigureTestFixtures.js';

const pf = (id, figureKey) => new PlacedFigure({ id, figureKey, x: 100, y: 200 });
const catalogOf = (...figs) => { const m = new Map(figs.map(f => [f.key, f])); return key => m.get(key) ?? null; };
const run = (placed, figs, seen) => collectPlacedFigureFailures(placed, seen, { entryOf: catalogOf(...figs) });

test('正常な配置図は行なし。参照切れ（カタログに無い）も行を出さない（unresolved-code 側の役目）', () => {
  assert.deepEqual(run([pf('p1', 'ok')], [square('ok')]), []);
  assert.deepEqual(run([pf('p1', 'gone')], [square('ok')]), []);
});

test('【失敗系】配置図でない分類（建具の図）は 1 行・reason は ERR_DETAIL_NOT_PLACED_FIGURE・message は ERR_DETAIL_FIT_FAILED', () => {
  const opening = square('op', { subject: DetailSubject.OPENING, label: '建具図' });
  const rows = run([pf('p1', 'op')], [opening]);
  assert.equal(rows.length, 1);
  const reason = ERR_DETAIL_NOT_PLACED_FIGURE(`${DetailCategory.FIGURE}・${DetailView.PLAN}・${DetailSubject.OPENING}`);
  assert.deepEqual(rows[0], {
    key: 'placedFigure|op', symbolKey: DETAIL_TARGET_PLACED_FIGURE, slot: DetailSlot.FIGURE, label: '建具図', reason,
    message: ERR_DETAIL_FIT_FAILED('建具図', DETAIL_TARGET_PLACED_FIGURE, reason, DetailSlot.FIGURE), placedFigureId: 'p1',
  });
  // 立面側の姿図も主の配置先は平面の配置図だけ
  assert.equal(run([pf('p1', 'el')], [square('el', { view: DetailView.ELEVATION })]).length, 1);
});

test('【失敗系】WALL_FINISH_FACE の基準を持つ図は基準の供給失敗で 1 行（reason は targets のメッセージ）', () => {
  const rows = run([pf('p1', 'bad')], [square('bad', { datums: wallFaceDatums() })]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /姿図の配置では使えません/);
  assert.equal(rows[0].message, ERR_DETAIL_FIT_FAILED(rows[0].label, DETAIL_TARGET_PLACED_FIGURE, rows[0].reason, DetailSlot.FIGURE));
});

test('同じ図を複数か所に置いても 1 行（鍵は図のキー。placedFigureId は最初の配置）。seen を共有すると 2 回目は 0 行', () => {
  const figs = [square('bad', { datums: wallFaceDatums() })];
  const seen = new Set();
  const rows = run([pf('p1', 'bad'), pf('p2', 'bad')], figs, seen);
  assert.deepEqual(rows.map(r => r.placedFigureId), ['p1']);
  assert.deepEqual(run([pf('p3', 'bad')], figs, seen), []);
  assert.equal(run([pf('p1', 'bad')], figs).length, 1, 'seen を渡さなければ毎回新しい鍵');
});

test('views.ceiling: 空調の図の見上げ図が fit 不能なら 1 行（鍵に ceiling）。参照切れ・分類違いも行にする', () => {
  const ceilBad = square('cbad', { subject: DetailSubject.HVAC, datums: wallFaceDatums(), label: '見上げ不良' });
  const main = key => square('hv', { subject: DetailSubject.HVAC, views: { [DetailPlacementView.CEILING]: key } });
  const rows = run([pf('p1', 'hv')], [main('cbad'), ceilBad]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, `placedFigure|${DetailPlacementView.CEILING}|cbad`);
  assert.equal(rows[0].label, '見上げ不良');
  assert.match(rows[0].reason, /姿図の配置では使えません/);

  const gone = run([pf('p1', 'hv')], [main('cgone')]);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].reason, ERR_DETAIL_FIGURE_NOT_FOUND(DETAIL_TARGET_PLACED_FIGURE, DetailSlot.FIGURE));
  assert.equal(gone[0].label, 'cgone');

  // 見上げに置けない分類（家具は天伏に出ない主題）
  const wrongClass = run([pf('p1', 'hv')], [main('cfur'), square('cfur', { subject: DetailSubject.FURNITURE })]);
  assert.equal(wrongClass.length, 1);
  assert.match(wrongClass[0].reason, /対象ではありません/);

  // 正常な見上げ図は行なし
  assert.deepEqual(run([pf('p1', 'hv')], [main('cok'), square('cok', { subject: DetailSubject.HVAC })]), []);
});

test('views.ceiling: 電気の図にも検査が掛かる。見上げ図の参照切れ・分類違い・fit 不能は各 1 行、正常は行なし', () => {
  const main = key => square('el', { subject: DetailSubject.ELECTRICAL, views: { [DetailPlacementView.CEILING]: key } });
  const gone = run([pf('p1', 'el')], [main('cgone')]);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].key, `placedFigure|${DetailPlacementView.CEILING}|cgone`);
  assert.equal(gone[0].reason, ERR_DETAIL_FIGURE_NOT_FOUND(DETAIL_TARGET_PLACED_FIGURE, DetailSlot.FIGURE));
  const bad = run([pf('p1', 'el')], [main('cbad'), square('cbad', { subject: DetailSubject.ELECTRICAL, datums: wallFaceDatums(), label: '電気見上げ不良' })]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].label, '電気見上げ不良');
  const wrong = run([pf('p1', 'el')], [main('csan'), square('csan', { subject: DetailSubject.SANITARY })]);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0].reason, /対象ではありません/);
  assert.deepEqual(run([pf('p1', 'el')], [main('cok'), square('cok', { subject: DetailSubject.ELECTRICAL })]), []);
});

test('views.ceiling が不良でも、天伏に出ない主題（衛生器具）の図は行にしない', () => {
  const main = square('sa', { subject: DetailSubject.SANITARY, views: { [DetailPlacementView.CEILING]: 'cgone' } });
  assert.deepEqual(run([pf('p1', 'sa')], [main]), []);
});

test('【失敗系】基準は通るが fit で落ちる配置図（param 束縛）は 1 行・reason は fitLocal の error.message', () => {
  const base = square('par');
  const fig = { ...base, strokes: [{ ...base.strokes[0], moves: [move(PenDir.RIGHT, paramLen(DetailParam.WALL_THICKNESS, 5)), ...base.strokes[0].moves] }] };
  const t = placedFigureTargets(fig);
  assert.equal(t.error, undefined, '基準の供給は通る');
  const expected = fitLocal(fig, t.targets).error.message;
  const rows = run([pf('p1', 'par')], [fig]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, expected);
  assert.equal(rows[0].message, ERR_DETAIL_FIT_FAILED(rows[0].label, DETAIL_TARGET_PLACED_FIGURE, expected, DetailSlot.FIGURE));
});

test('【失敗系】views が null・配列・数値・空文字の空調の図は落ちず、ceiling の行を作らない（null は 0 行・形の不正は図自身の検証失敗の 1 行だけ）', () => {
  const rowsOf = views => run([pf('p1', 'hv')], [{ ...square('hv', { subject: DetailSubject.HVAC }), [DETAIL_VIEWS_FIELD]: views }]);
  assert.deepEqual(rowsOf(null), []);
  for (const views of [[], 5, '', 'x', { [DetailPlacementView.CEILING]: '' }, { [DetailPlacementView.CEILING]: 5 }]) {
    let rows;
    assert.doesNotThrow(() => { rows = rowsOf(views); }, JSON.stringify(views));
    assert.ok(rows.length <= 1 && rows.every(r => r.key === 'placedFigure|hv'), `${JSON.stringify(views)}: ${JSON.stringify(rows.map(r => r.key))}`);
  }
});

test('【失敗系】views.front: 参照切れ・分類違い（平面の図）・fit 不能が行になる（鍵は front。衛生の図でも出る）。正常な立面の姿図は行なし', () => {
  const FRONT = DetailPlacementView.FRONT;
  const main = key => square('sa', { subject: DetailSubject.SANITARY, views: { [FRONT]: key } });
  const elev = (key, over = {}) => square(key, { view: DetailView.ELEVATION, ...over });
  assert.deepEqual(run([pf('p1', 'sa')], [main('fok'), elev('fok')]), []);

  const gone = run([pf('p1', 'sa')], [main('fgone')]);
  assert.equal(gone.length, 1);
  assert.equal(gone[0].key, `placedFigure|${FRONT}|fgone`);
  assert.equal(gone[0].reason, ERR_DETAIL_FIGURE_NOT_FOUND(DETAIL_TARGET_PLACED_FIGURE, DetailSlot.FIGURE));

  const wrongClass = run([pf('p1', 'sa')], [main('fplan'), square('fplan')]);
  assert.equal(wrongClass.length, 1);
  assert.equal(wrongClass[0].key, `placedFigure|${FRONT}|fplan`);
  assert.match(wrongClass[0].reason, /対象ではありません/);

  const bad = run([pf('p1', 'sa')], [main('fbad'), elev('fbad', { datums: wallFaceDatums(), label: '正面不良' })]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].label, '正面不良');
  assert.match(bad[0].reason, /姿図の配置では使えません/);

  // ceiling と同じ鍵の形で view だけが違う
  const both = run([pf('p1', 'hv')], [
    square('hv', { subject: DetailSubject.HVAC, views: { [FRONT]: 'x', [DetailPlacementView.CEILING]: 'x' } }),
  ]);
  assert.deepEqual(both.map(r => r.key), [`placedFigure|${FRONT}|x`, `placedFigure|${DetailPlacementView.CEILING}|x`]);
});

test('【失敗系】配列でない入力・空は行なし（例外にしない）', () => {
  for (const input of [null, undefined, [], {}]) assert.deepEqual(run(input, [square('ok')]), []);
});
