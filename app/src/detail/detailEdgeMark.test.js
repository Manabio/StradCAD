// 手の辺の印（Move.edge='air'。部分詳細図 S8a）: 検証・正規化・fit の edgeMarks・プレビューの重ね線のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PenDir, DetailEdgeMark } from '../core/constants.js';
import { validateDetailFigure, normalizeDetailFigure, isSupportedDetailFigure, DetailValidationError } from './detailModel.js';
import { fitDetailFigure } from './detailFit.js';
import { previewPrimitives, PREVIEW_AIR_EDGE_WIDTH_PX } from './detailPreview.js';
import { rectFigure, figureOf, strokeOf, move, vmove, fixedLen } from './detailTestFixtures.js';

const ZERO = { datums: { ds0: 0, dt0: 0 } };
const withMarks = (marks, w = 100, h = 50) => {
  const fig = rectFigure(w, h);
  fig.strokes[0].moves = fig.strokes[0].moves.map((m, i) => (marks[i] ? { ...m, edge: marks[i] } : m));
  return fig;
};

test('検証: 既知の印は通り、未知の印は UNKNOWN_EDGE_MARK（読めない図＝SUPPORT_BLOCKING）。印なしはキーを持たない', () => {
  assert.equal(validateDetailFigure(withMarks([DetailEdgeMark.AIR])).ok, true);
  const bad = withMarks(['wet']);
  const v = validateDetailFigure(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e => e.code === DetailValidationError.UNKNOWN_EDGE_MARK && e.path === 'strokes[0].moves[0].edge'));
  assert.equal(isSupportedDetailFigure(bad), false);
  assert.equal(isSupportedDetailFigure(withMarks([DetailEdgeMark.AIR])), true);
  // キーはあるが値が undefined／null も未知（印を外すときはキー自体を消す）
  const nullMark = rectFigure();
  nullMark.strokes[0].moves[0] = { ...nullMark.strokes[0].moves[0], edge: null };
  assert.equal(validateDetailFigure(nullMark).ok, false, 'キーがあって null は未知の印');
});

test('正規化: 印のない手に edge の既定値を足さない（V の ss/st とは違う）。印は保たれる', () => {
  const n = normalizeDetailFigure(withMarks([DetailEdgeMark.AIR]));
  assert.equal(Object.hasOwn(n.strokes[0].moves[1], 'edge'), false);
  assert.equal(n.strokes[0].moves[0].edge, DetailEdgeMark.AIR);
  const v = normalizeDetailFigure(figureOf([strokeOf('a', [vmove(fixedLen(5), fixedLen(5))])]));
  assert.equal(Object.hasOwn(v.strokes[0].moves[0], 'edge'), false);
});

test('fit: 印が 1 つでもあるストロークだけ edgeMarks（手の番号対応・無い手は null）を持つ。印が無ければキー自体を付けない', () => {
  const marked = fitDetailFigure(withMarks([null, DetailEdgeMark.AIR, null]), ZERO);
  assert.deepEqual(marked.strokes[0].edgeMarks, [null, DetailEdgeMark.AIR, null]);
  const plain = fitDetailFigure(rectFigure(), ZERO);
  assert.equal(Object.hasOwn(plain.strokes[0], 'edgeMarks'), false, '印なしの既存出力は byte 不変');
  assert.deepEqual(Object.keys(plain.strokes[0]), ['id', 'points', 'closed', 'line']);
  // 斜め（V）の手の印も手の番号に対応する
  const vee = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), { ...vmove(fixedLen(5), fixedLen(5)), edge: DetailEdgeMark.AIR }])]);
  assert.deepEqual(fitDetailFigure(vee, ZERO).strokes[0].edgeMarks, [null, DetailEdgeMark.AIR]);
});

test('プレビュー: 印の辺に PREVIEW_AIR_EDGE_WIDTH_PX の線を重ねる。印が無ければプリミティブの数は従来どおり', () => {
  assert.equal(PREVIEW_AIR_EDGE_WIDTH_PX, 2.5);
  const base = previewPrimitives(rectFigure());
  const marked = previewPrimitives(withMarks([DetailEdgeMark.AIR]));
  assert.equal(marked.length, base.length + 1);
  const overlay = marked.filter(p => p.type === 'polyline' && p.width === PREVIEW_AIR_EDGE_WIDTH_PX);
  assert.equal(overlay.length, 1);
  assert.deepEqual(overlay[0].points, [[0, 0], [100, 0]], '手 0（頂点 0→1）の辺');
  assert.equal(base.some(p => p.width === PREVIEW_AIR_EDGE_WIDTH_PX), false);
});
