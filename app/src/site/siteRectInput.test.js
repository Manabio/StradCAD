import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRectTableRows, rectInputRowDefs, rectFocusedValue, rectNumpadLabel, rectEnterAction,
  rectAnchorLabel, computeRectPreview, evalRectLen,
} from './siteRectInput.js';

const R = (id, x, y, w, h) => ({ id, x, y, w, h });
const mapOf = (...rs) => new Map(rs.map(r => [r.id, r]));

const first = (o = {}) => ({ kind: 'first', origin: { x: 10, y: 20 }, focusedCell: 'w', wValue: '', hValue: '', ...o });
const attach = (o = {}) => ({ kind: 'attach', focusedCell: 'along', alongValue: '', depthValue: '', ...o });

// ---- 表 ----

test('buildRectTableRows: 番号は rects の順（1始まり）、面積は㎡、合計は和集合（重なりは数えない）', () => {
  const rects = [R('a', 0, 0, 4000, 3000), R('b', 2000, 0, 4000, 3000)];
  const { rows, totalAreaM2 } = buildRectTableRows(rects);
  assert.deepEqual(rows.map(r => [r.id, r.num, r.w, r.h, r.areaM2]), [['a', 1, 4000, 3000, 12], ['b', 2, 4000, 3000, 12]]);
  assert.equal(totalAreaM2, 18, '重なり 2000×3000 を二重に数えない');
});

test('【失敗系】buildRectTableRows: 長方形が無ければ行なし・合計 0', () => {
  assert.deepEqual(buildRectTableRows([]), { rows: [], totalAreaM2: 0 });
});

// ---- 入力行・Enter・NumPad ----

test('rectInputRowDefs: first は よこ/たて、attach は 辺長/奥行、入力なしは空', () => {
  assert.deepEqual(rectInputRowDefs(first({ wValue: '3000' })).map(d => [d.cell, d.label, d.value]), [['w', 'よこ', '3000'], ['h', 'たて', '']]);
  assert.deepEqual(rectInputRowDefs(attach({ depthValue: '900' })).map(d => [d.cell, d.label, d.value]), [['along', '辺長', ''], ['depth', '奥行', '900']]);
  assert.deepEqual(rectInputRowDefs(null), []);
});

test('rectFocusedValue / rectNumpadLabel: フォーカス中のセルの値と見出し', () => {
  assert.equal(rectFocusedValue(first({ focusedCell: 'h', hValue: '55' })), '55');
  assert.equal(rectNumpadLabel(first({ focusedCell: 'h' })), 'たて');
  assert.equal(rectFocusedValue(attach({ alongValue: '1200' })), '1200');
  assert.equal(rectNumpadLabel(attach({ focusedCell: 'depth' })), '奥行');
  assert.equal(rectFocusedValue(null), '');
});

test('rectEnterAction: w→h・along→depth へ移り、2つ目で確定。入力なしは null', () => {
  assert.deepEqual(rectEnterAction(first()), { type: 'focus', cell: 'h' });
  assert.deepEqual(rectEnterAction(first({ focusedCell: 'h' })), { type: 'confirm' });
  assert.deepEqual(rectEnterAction(attach()), { type: 'focus', cell: 'depth' });
  assert.deepEqual(rectEnterAction(attach({ focusedCell: 'depth' })), { type: 'confirm' });
  assert.equal(rectEnterAction(null), null);
});

test('rectAnchorLabel: 横の辺は左端/右端、縦の辺は上端/下端', () => {
  assert.equal(rectAnchorLabel('n', 'a'), '左端');
  assert.equal(rectAnchorLabel('s', 'b'), '右端');
  assert.equal(rectAnchorLabel('w', 'a'), '上端');
  assert.equal(rectAnchorLabel('e', 'b'), '下端');
});

test('evalRectLen: 式を評価し、0以下・不正は NaN', () => {
  assert.equal(evalRectLen('1000+500'), 1500);
  assert.ok(Number.isNaN(evalRectLen('0')));
  assert.ok(Number.isNaN(evalRectLen('')));
  assert.ok(Number.isNaN(evalRectLen('12+')));
});

// ---- プレビュー ----

test('computeRectPreview: first は origin＋w,h（式も評価）', () => {
  assert.deepEqual(computeRectPreview(mapOf(), null, 'a', first({ wValue: '3000', hValue: '1000+1000' })),
    { x: 10, y: 20, w: 3000, h: 2000 });
});

test('【失敗系】computeRectPreview: first は片方だけ・0・不正式なら null', () => {
  assert.equal(computeRectPreview(mapOf(), null, 'a', first({ wValue: '3000' })), null);
  assert.equal(computeRectPreview(mapOf(), null, 'a', first({ hValue: '3000' })), null);
  assert.equal(computeRectPreview(mapOf(), null, 'a', first({ wValue: '0', hValue: '10' })), null);
  assert.equal(computeRectPreview(mapOf(), null, 'a', first({ wValue: '1+', hValue: '10' })), null);
  assert.equal(computeRectPreview(mapOf(), null, 'a', null), null);
});

test('computeRectPreview: attach は computeAttachedRect の結果（北辺・基点 a の外側＝上へ）', () => {
  const base = R('r', 0, 0, 4000, 3000);
  const p = computeRectPreview(mapOf(base), { rectId: 'r', side: 'n' }, 'a', attach({ alongValue: '2000', depthValue: '1000' }));
  assert.deepEqual(p, { x: 0, y: -1000, w: 2000, h: 1000 });
});

test('【失敗系】computeRectPreview: attach は片方だけ・共有辺なし・基の長方形が無いなら null', () => {
  const base = R('r', 0, 0, 4000, 3000);
  const edge = { rectId: 'r', side: 'n' };
  assert.equal(computeRectPreview(mapOf(base), edge, 'a', attach({ alongValue: '2000' })), null);
  assert.equal(computeRectPreview(mapOf(base), edge, 'a', attach({ depthValue: '1000' })), null);
  assert.equal(computeRectPreview(mapOf(base), null, 'a', attach({ alongValue: '2000', depthValue: '1000' })), null);
  assert.equal(computeRectPreview(mapOf(), edge, 'a', attach({ alongValue: '2000', depthValue: '1000' })), null);
});
