import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgFigurePrimitiveType, PenDir, DetailDash } from '../core/constants.js';
import { previewPrimitives } from './detailPreview.js';
import { stretchFigure, rectFigure, figureOf, strokeOf, move, vmove, fixedLen, anchorOf } from './detailTestFixtures.js';

const types = prims => prims.map(p => p.type);

test('preview: 出力の type は SvgFigurePrimitiveType の値だけ', () => {
  const known = new Set(Object.values(SvgFigurePrimitiveType));
  for (const fig of [stretchFigure(), rectFigure()]) {
    const prims = previewPrimitives(fig);
    assert.ok(prims.length > 0);
    for (const p of prims) assert.ok(known.has(p.type), p.type);
  }
});

test('preview: dim は editable:true と editKey を持ち、手の数と同数（V は除く）', () => {
  const fig = figureOf([strokeOf('a', [
    move(PenDir.RIGHT, fixedLen(10)), vmove(fixedLen(3), fixedLen(4)), move(PenDir.DOWN, fixedLen(20)),
  ])]);
  const dims = previewPrimitives(fig).filter(p => p.type === SvgFigurePrimitiveType.DIM);
  assert.equal(dims.length, 2);
  assert.deepEqual(dims.map(d => d.editKey), [{ strokeId: 'a', moveIndex: 0 }, { strokeId: 'a', moveIndex: 2 }]);
  for (const d of dims) assert.equal(d.editable, true);
  assert.deepEqual(dims.map(d => d.dir), ['h', 'v']);
  assert.deepEqual(dims.map(d => d.label), [10, 20]);
  const all = previewPrimitives(stretchFigure()).filter(p => p.type === SvgFigurePrimitiveType.DIM);
  assert.equal(all.length, 5);
});

test('preview: origin の Datum の offsetMm 分だけ平行移動する', () => {
  const fig = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(10))])]);
  fig.datums = [{ ...fig.datums[0], offsetMm: 30 }, { ...fig.datums[1], offsetMm: -5 }];
  const poly = previewPrimitives(fig).find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.deepEqual(poly.points, [[30, -5], [40, -5]]);
});

test('preview: polyline は [x,y] タプル列・頂点番号 text は頂点数ぶん・閉は closed:true', () => {
  const prims = previewPrimitives(rectFigure(100, 50));
  const poly = prims.find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.deepEqual(poly.points, [[0, 0], [100, 0], [100, 50], [0, 50]]);
  assert.equal(poly.closed, true);
  assert.deepEqual(prims.filter(p => p.type === SvgFigurePrimitiveType.TEXT).map(p => p.text), ['0', '1', '2', '3']);
  const open = previewPrimitives(stretchFigure()).find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.equal(open.closed, undefined);
});

test('preview: 点線のストロークは dash を持つ／origin の Anchor の頂点が Datum の位置に載る', () => {
  const s = strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(20))], false, { weightRole: 'thin', dashRole: DetailDash.DASHED });
  const fig = figureOf([s], { anchors: [anchorOf('ds0', 'a', 1), anchorOf('dt0', 'a', 1)] });
  const poly = previewPrimitives(fig).find(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.equal(poly.dash, DetailDash.DASHED);
  assert.deepEqual(poly.points, [[-10, 0], [0, 0], [0, 20]]);
});

test('preview: 歩けないストローク（未知の dir）は飛ばし、例外にしない', () => {
  const fig = figureOf([strokeOf('a', [{ dir: 'Z', len: fixedLen(5) }]), strokeOf('b', [move(PenDir.RIGHT, fixedLen(5))])]);
  const prims = previewPrimitives(fig);
  assert.deepEqual(types(prims).filter(t => t === SvgFigurePrimitiveType.POLYLINE).length, 1);
  assert.deepEqual(previewPrimitives(null), []);
});
