import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgFigurePrimitiveType, PenDir, DetailDash } from '../core/constants.js';
import { previewPrimitives, datumGuidePrimitives, PREVIEW_DIM_GAP_MM } from './detailPreview.js';
import { stretchFigure, rectFigure, figureOf, strokeOf, move, vmove, fixedLen, anchorOf } from './detailTestFixtures.js';


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
  assert.deepEqual(prims.filter(p => p.type === SvgFigurePrimitiveType.TEXT && !p.guide).map(p => p.text), ['0', '1', '2', '3']);
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
  assert.deepEqual(prims.filter(p => p.type === SvgFigurePrimitiveType.POLYLINE && !p.guide).length, 1);
  assert.deepEqual(previewPrimitives(null), []);
});

const dOrigin = (id, role, axis, offsetMm) => ({ id, role, axis, kind: 'origin', offsetMm });

test('基準線: origin の Datum ごとに bbox ± gap の破線＋役割名 text（s は縦線・t は横線）。labelOf を使う。editable／editKey は持たない', () => {
  const pts = [{ s: 0, t: 0 }, { s: 100, t: 50 }];
  const g = datumGuidePrimitives([dOrigin('a', 'stepEdge', 's', 30), dOrigin('b', 'ceilingFace', 't', 10)], pts, { gap: 7, labelOf: r => `L:${r}` });
  const lines = g.filter(p => p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.deepEqual(lines.map(p => p.points), [[[30, -7], [30, 57]], [[-7, 10], [107, 10]]]);
  for (const p of lines) assert.equal(p.dash, DetailDash.DASHED);
  assert.deepEqual(g.filter(p => p.type === SvgFigurePrimitiveType.TEXT).map(p => p.text), ['L:stepEdge', 'L:ceilingFace']);
  for (const p of g) { assert.equal(p.guide, true); assert.equal(p.editable, undefined); assert.equal(p.editKey, undefined); }
  assert.equal(datumGuidePrimitives([dOrigin('a', 'stepEdge', 's', 0)], pts, { gap: 7 }).at(-1).text, 'stepEdge');
});

test('基準線【失敗系】: datum なし・頂点なし・end・非有限 offset・s/t 以外の軸は出さない', () => {
  const pts = [{ s: 0, t: 0 }, { s: 10, t: 10 }];
  assert.deepEqual(datumGuidePrimitives([], pts), []);
  assert.deepEqual(datumGuidePrimitives(undefined, pts), []);
  assert.deepEqual(datumGuidePrimitives([dOrigin('a', 'fl', 's', 0)], []), []);
  assert.deepEqual(datumGuidePrimitives([{ ...dOrigin('a', 'fl', 't', 0), kind: 'end' }], pts), []);
  assert.deepEqual(datumGuidePrimitives([dOrigin('a', 'fl', 's', NaN), dOrigin('b', 'fl', 't', Infinity)], pts), []);
  assert.deepEqual(datumGuidePrimitives([dOrigin('a', 'fl', 'x', 0)], pts), []);
});

test('基準線: previewPrimitives は origin の Datum の位置（offset 反映後）に出し、既定の gap は PREVIEW_DIM_GAP_MM。end は出さない', () => {
  const fig = stretchFigure(); // datums: ds0(s origin)・dt0(t origin)・dt1(t end)
  const guides = previewPrimitives(fig).filter(p => p.guide);
  assert.equal(guides.length, 4, 'origin 2 本ぶんの線＋text（end の dt1 は出ない）');
  const v = guides.find(p => p.type === SvgFigurePrimitiveType.POLYLINE && p.points[0][0] === p.points[1][0]);
  // 下書きの高さは 10+50+10=70（stretch は mm のまま歩く）
  assert.deepEqual(v.points, [[0, -PREVIEW_DIM_GAP_MM], [0, 70 + PREVIEW_DIM_GAP_MM]]);
});
