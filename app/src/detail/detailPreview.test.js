import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgFigurePrimitiveType, PenDir, DetailDash } from '../core/constants.js';
import { previewPrimitives, datumGuidePrimitives, PREVIEW_DIM_GAP_MM } from './detailPreview.js';
import { stretchFigure, rectFigure, figureOf, strokeOf, move, vmove, fixedLen, paramLen, anchorOf } from './detailTestFixtures.js';


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

test('preview: 寸法線は足（foot＝材側の座標）を持ち、既定 gap は PREVIEW_DIM_GAP_MM（80）。足の長さは指定しない', () => {
  assert.equal(PREVIEW_DIM_GAP_MM, 80);
  const fig = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(20))])]);
  const [h, v] = previewPrimitives(fig).filter(p => p.type === SvgFigurePrimitiveType.DIM);
  // 点列 (0,0)→(10,0)→(10,20)。bbox の中心 (5,10)。h は t=0 が中心より上＝−側（R5）、v は s=10 が中心より右＝+側
  assert.equal(h.foot, 0); assert.equal(h.at, 0 - PREVIEW_DIM_GAP_MM);
  assert.equal(v.foot, 10); assert.equal(v.at, 10 + PREVIEW_DIM_GAP_MM);
  assert.equal(h.footLen, undefined); assert.equal(v.footLen, undefined);
  const g = previewPrimitives(fig, { dimGapMm: 25 }).filter(p => p.type === SvgFigurePrimitiveType.DIM);
  assert.equal(g[0].at, -25); assert.equal(g[1].at, 35);
  assert.equal(g[0].foot, 0); assert.equal(g[1].foot, 10);
});

test('preview: 縦の寸法値は labelVertical・labelSide left、横には付かない。斜め（VECTOR）は寸法を作らない', () => {
  const fig = figureOf([strokeOf('a', [
    move(PenDir.RIGHT, fixedLen(10)), vmove(fixedLen(3), fixedLen(4)), move(PenDir.DOWN, fixedLen(20)),
  ])]);
  const dims = previewPrimitives(fig).filter(p => p.type === SvgFigurePrimitiveType.DIM);
  assert.equal(dims.length, 2);
  const [h, v] = dims;
  assert.equal(v.labelVertical, true); assert.equal(v.labelSide, 'left');
  assert.equal('labelVertical' in h, false); assert.equal('labelSide' in h, false);
  // 等価: foot・labelVertical・labelSide を除けば従来の dim と同じ
  const strip = d => Object.fromEntries(Object.entries(d).filter(([k]) => !['foot', 'labelVertical', 'labelSide'].includes(k)));
  // 点列 (0,0)(10,0)(13,4)(13,24)。h は t=0 が bbox 中心 t=12 より上＝−gap（R5）
  assert.deepEqual(strip(h), { type: 'dim', dir: 'h', from: 0, to: 10, at: -PREVIEW_DIM_GAP_MM, label: 10, editable: true, editKey: { strokeId: 'a', moveIndex: 0 } });
  assert.deepEqual(strip(v), { type: 'dim', dir: 'v', from: 4, to: 24, at: 13 + PREVIEW_DIM_GAP_MM, label: 20, editable: true, editKey: { strokeId: 'a', moveIndex: 2 } });
});

const dimsOf = fig => previewPrimitives(fig).filter(p => p.type === SvgFigurePrimitiveType.DIM);

test('preview【R5】: 寸法線は bbox の外側。上辺は −gap・下辺は +gap・左辺は −gap・右辺は +gap。縦の値は図の側に関わらず常に線の左（左辺も右辺も left）', () => {
  const G = PREVIEW_DIM_GAP_MM;
  // 開いた 4 手の矩形 (0,0)→(100,0)→(100,50)→(0,50)→(0,0)
  const fig = figureOf([strokeOf('r', [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(50)), move(PenDir.LEFT, fixedLen(100)), move(PenDir.UP, fixedLen(50)),
  ])]);
  const [top, right, bottom, left] = dimsOf(fig);
  assert.equal(top.at, 0 - G); assert.equal(top.foot, 0);
  assert.equal(bottom.at, 50 + G); assert.equal(bottom.foot, 50);
  assert.equal(left.at, 0 - G); assert.equal(left.foot, 0); assert.equal(left.labelSide, 'left');
  assert.equal(right.at, 100 + G); assert.equal(right.foot, 100); assert.equal(right.labelSide, 'left');
  for (const d of [left, right]) { assert.equal(d.from, 0); assert.equal(d.to, 50); }
});

test('preview【R5】: 1 本の線（高さ 0）は従来どおり + 側。負の方向の手（LEFT→UP）でも from<to・foot・at＝foot ± gap', () => {
  const G = PREVIEW_DIM_GAP_MM;
  const [one] = dimsOf(figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(30))])]));
  assert.equal(one.at, G); assert.equal(one.foot, 0);
  // (0,0)→(−10,0)→(−10,−20)。bbox 中心 (−5,−10)
  const [h, v] = dimsOf(figureOf([strokeOf('a', [move(PenDir.LEFT, fixedLen(10)), move(PenDir.UP, fixedLen(20))])]));
  assert.equal(h.from, -10); assert.equal(h.to, 0); assert.equal(h.foot, 0); assert.equal(h.at, G); // t=0 ≥ −10＝+側
  assert.equal(v.from, -20); assert.equal(v.to, 0); assert.equal(v.foot, -10); assert.equal(v.at, -10 - G); // s=−10 < −5＝−側
  assert.equal(v.labelSide, 'left');
});

test('preview【失敗系】: 長さ未解決（param で mm 無し）の手は例外にならず、歩けないストロークとして寸法も出さない', () => {
  const fig = figureOf([strokeOf('a', [move(PenDir.RIGHT, paramLen('p', undefined)), move(PenDir.DOWN, paramLen('q', undefined))])]);
  let dims;
  assert.doesNotThrow(() => { dims = dimsOf(fig); });
  assert.deepEqual(dims, []);
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
