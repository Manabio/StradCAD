// 姿図の配置のヒット判定（renderer/placedFigureHit.js）の単体テスト。
// 20 角の正方形は配置点 (x,y) から [x,x+20]×[y,y+20]。回転 90° は [x-20,x]×[y,y+20]。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PenDir, DetailSubject, PLACED_FIGURE_MISSING_MARK_PX } from '../core/constants.js';
import { PlacedFigure } from '../core/placedFigure.js';
import { fixedLen, move } from '../finish/roomDetailTestFixtures.js';
import { square } from '../finish/placedFigure/placedFigureTestFixtures.js';
import { placedFigureHitAt, placedFigureTapOptions } from './placedFigureHit.js';

const rectOf = (key, w, h, opts) => {
  const base = square(key, opts);
  return { ...base, strokes: [{ ...base.strokes[0], moves: [move(PenDir.RIGHT, fixedLen(w)), move(PenDir.DOWN, fixedLen(h)), move(PenDir.LEFT, fixedLen(w))] }] };
};
const FIGS = [
  square('sq'),
  rectOf('rect', 40, 10),
  rectOf('big', 60, 60),
  square('fur', { subject: DetailSubject.FURNITURE }),
];
const figureOf = key => FIGS.find(f => f.key === key) ?? null;
const P = (id, figureKey, x, y, over = {}) => new PlacedFigure({ id, figureKey, x, y, ...over });
const hit = (placed, x, y, over = {}) => placedFigureHitAt(placed, figureOf, { x, y, tolMm: 0, mmPerPx: 1, ...over });

test('外接の内外と tolMm の境界（境界上は当たり。tol で広がる）', () => {
  const placed = [P('a', 'sq', 100, 50)];
  assert.equal(hit(placed, 110, 60), 'a');
  assert.equal(hit(placed, 120, 70), 'a');
  assert.equal(hit(placed, 120.5, 60), null);
  assert.equal(hit(placed, 120.5, 60, { tolMm: 1 }), 'a');
  assert.equal(hit(placed, 121.5, 60, { tolMm: 1 }), null);
  assert.equal(hit(placed, 110, 49, { tolMm: 1 }), 'a');
  assert.equal(hit(placed, 110, 48.5, { tolMm: 1 }), null);
  assert.equal(hit(placed, 99.5, 60, { tolMm: 1 }), 'a');
  assert.equal(hit(placed, 98.5, 60, { tolMm: 1 }), null);
  assert.equal(hit(placed, 110, 70.5, { tolMm: 1 }), 'a');
  assert.equal(hit(placed, 110, 71.5, { tolMm: 1 }), null);
});

test('回転・鏡像した配置（PlacedFigure インスタンス）は回転後の外接に当たりが追従する', () => {
  const placed = [P('r', 'rect', 200, 200, { rotationDeg: 90 }), P('m', 'rect', 500, 200, { mirror: true })];
  assert.equal(hit(placed, 195, 230), 'r');
  assert.equal(hit(placed, 220, 205), null);
  assert.equal(hit(placed, 470, 205), 'm');
  assert.equal(hit(placed, 520, 205), null);
});

test('重なりは外接の面積が小さい方（並び順によらない）', () => {
  const small = P('small', 'sq', 110, 60);
  const big = P('big', 'big', 100, 50);
  assert.equal(hit([small, big], 115, 65), 'small');
  assert.equal(hit([big, small], 115, 65), 'small');
  assert.equal(hit([small, big], 150, 100), 'big');
});

test('同じ面積は placedFigures の並びで後ろ（後から置いた方）', () => {
  const a = P('a', 'sq', 100, 50);
  const b = P('b', 'sq', 105, 55);
  assert.equal(hit([a, b], 112, 62), 'b');
  assert.equal(hit([b, a], 112, 62), 'a');
});

test('×（図が引けない配置）は mmPerPx に比例して当たる。tol も加わる', () => {
  const placed = [P('x', 'gone', 300, 300)];
  assert.equal(PLACED_FIGURE_MISSING_MARK_PX, 6);
  assert.equal(hit(placed, 311, 311, { mmPerPx: 2 }), 'x');
  assert.equal(hit(placed, 313, 300, { mmPerPx: 2 }), null);
  assert.equal(hit(placed, 313, 300, { mmPerPx: 2, tolMm: 2 }), 'x');
  assert.equal(hit(placed, 320, 300, { mmPerPx: 4 }), 'x');
  assert.equal(hit(placed, 320, 300, { mmPerPx: 2 }), null);
});

test('×と図の重なりも面積で決まる（×の正方形の方が小さければ×）', () => {
  const placed = [P('s', 'sq', 100, 50), P('m', 'gone', 110, 60)];
  assert.equal(hit(placed, 112, 62, { mmPerPx: 1 }), 'm');
  assert.equal(hit(placed, 112, 62, { mmPerPx: 10 }), 's');
});

test('subjects 外の配置は当たらない。分類不明の×は当たる', () => {
  const placed = [P('f', 'fur', 100, 50), P('g', 'gone', 300, 300)];
  assert.equal(hit(placed, 110, 60, { subjects: [DetailSubject.SANITARY] }), null);
  assert.equal(hit(placed, 110, 60, { subjects: [DetailSubject.FURNITURE] }), 'f');
  assert.equal(hit(placed, 300, 300, { subjects: [DetailSubject.SANITARY] }), 'g');
  assert.equal(hit(placed, 110, 60), 'f');
});

test('【失敗系】配列でない・座標が有限数でない → null。不正な tol・mmPerPx は 0 扱いで例外なし', () => {
  const placed = [P('a', 'sq', 100, 50), P('x', 'gone', 300, 300)];
  assert.equal(placedFigureHitAt(null, figureOf, { x: 110, y: 60 }), null);
  assert.equal(placedFigureHitAt({}, figureOf, { x: 110, y: 60 }), null);
  assert.equal(hit(placed, NaN, 60), null);
  assert.equal(hit(placed, 110, Infinity), null);
  assert.equal(hit(placed, 110, undefined), null);
  assert.equal(hit(placed, '110', 60), null);
  assert.equal(hit(placed, 120.5, 60, { tolMm: -5 }), null);
  assert.equal(hit(placed, 120.5, 60, { tolMm: NaN }), null);
  assert.equal(hit(placed, 101, 60, { tolMm: -5 }), 'a', '負の tol は 0 扱い＝外接を縮めない');
  assert.equal(hit(placed, 301, 300, { mmPerPx: -3 }), null);
  assert.equal(hit(placed, 300, 300, { mmPerPx: NaN }), 'x');
  assert.equal(hit([], 110, 60), null);
  assert.equal(placedFigureHitAt(placed, figureOf, { x: 110, y: 60 }), 'a');
});

test('placedFigureTapOptions: tolMm＝thresholdPx÷scaleX・mmPerPx＝1÷scaleX（割り算）', () => {
  assert.deepEqual(placedFigureTapOptions(0.5, 8), { tolMm: 16, mmPerPx: 2 });
  assert.deepEqual(placedFigureTapOptions(4, 8), { tolMm: 2, mmPerPx: 0.25 });
  assert.deepEqual(placedFigureTapOptions(2, 0), { tolMm: 0, mmPerPx: 0.5 }, 'thresholdPx 0 は許容なし（mmPerPx は有効）');
});

test('placedFigureTapOptions 失敗系: scaleX が有限の正でない・thresholdPx が有限の 0 以上でないときは両方 0', () => {
  const zero = { tolMm: 0, mmPerPx: 0 };
  for (const s of [0, -1, NaN, Infinity, undefined, null, '2']) assert.deepEqual(placedFigureTapOptions(s, 8), zero, `scaleX=${String(s)}`);
  for (const t of [-1, NaN, Infinity, undefined, null, '8']) assert.deepEqual(placedFigureTapOptions(2, t), zero, `thresholdPx=${String(t)}`);
});
