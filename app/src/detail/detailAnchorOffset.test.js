// Anchor.offsetMm（S7d-3。頂点の位置＝基準の目標＋Datum.offsetMm＋Anchor.offsetMm）のモデル・fit・プレビューのテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgFigurePrimitiveType, DetailParam, DetailMaterialField } from '../core/constants.js';
import { fitDetailFigure, DetailFitError as F } from './detailFit.js';
import { previewPrimitives } from './detailPreview.js';
import { normalizeDetailFigure, validateDetailFigure, DetailValidationError as E } from './detailModel.js';
import builtins from './detailBuiltins.js';
import { dxfToComponents } from './dxf/dxfToStrokes.js';
import { stretchFigure, rectFigure } from './detailTestFixtures.js';

const withOffsets = (fig, offsets) => ({
  ...fig,
  anchors: fig.anchors.map(a => (a.datumId in offsets ? { ...a, offsetMm: offsets[a.datumId] } : a)),
});
const zeroed = fig => ({ ...fig, anchors: fig.anchors.map(a => ({ ...a, offsetMm: 0 })) });
const fitPts = (fig, targets) => fitDetailFigure(fig, targets).strokes[0].points.map(p => [p.s, p.t]);
const previewPts = fig => previewPrimitives(fig).find(p => p.type === SvgFigurePrimitiveType.POLYLINE && p.strokeId).points;
const ZERO = { datums: { ds0: 0, dt0: 0 } };

test('offsetMm: fit の頂点 0 は 目標＋Datum.offsetMm＋Anchor.offsetMm（Datum.offsetMm 5 と合わせて足される）', () => {
  const fig = withOffsets(rectFigure(100, 50), { ds0: 30, dt0: -20 });
  fig.datums = fig.datums.map(d => (d.id === 'ds0' ? { ...d, offsetMm: 5 } : d));
  assert.deepEqual(fitPts(fig, { datums: { ds0: 100, dt0: 200 } })[0], [135, 180]);
  assert.deepEqual(fitPts(fig, ZERO)[0], [35, -20]);
});

test('offsetMm: プレビューと fit の頂点が同じ（同じ図・target 0）', () => {
  const fig = withOffsets(rectFigure(100, 50), { ds0: 30, dt0: -20 });
  fig.datums = fig.datums.map(d => (d.id === 'dt0' ? { ...d, offsetMm: 7 } : d));
  assert.deepEqual(previewPts(fig), fitPts(fig, ZERO));
  assert.deepEqual(previewPts(fig)[0], [30, -13]);
  const st = withOffsets(stretchFigure(), { ds0: 3, dt0: 4 });
  // 頂点 0 は stretch を含む図でも origin の位置（3, 4）
  assert.deepEqual(previewPts(st)[0], [3, 4]);
});

test('offsetMm: end の Anchor の wanted に origin・end 双方の offsetMm が効く', () => {
  const base = fitDetailFigure(stretchFigure(), { datums: { ds0: 0, dt0: 0, dt1: 70 } });
  assert.deepEqual(base.strokes[0].points.map(p => p.t), [0, 0, 10, 60, 70, 70], '従来: 伸縮 50');
  const fig = withOffsets(stretchFigure(), { dt0: 5, dt1: 10 });
  const r = fitDetailFigure(fig, { datums: { ds0: 0, dt0: 0, dt1: 70 } });
  assert.equal(r.error, undefined);
  const t = r.strokes[0].points.map(p => p.t);
  assert.equal(t[0], 5, '頂点 0 = 目標 0 + origin offset 5');
  assert.equal(t[4], 80, '頂点 4 = 目標 70 + end offset 10');
  assert.equal(t[3] - t[2], 55, '伸縮 = (70+10) − (0+5) − 固定 20');
});

test('等価: offsetMm を 0 に明示しても fit・プレビューは offsetMm 無しと deepEqual（組込みの全図と fixture）', () => {
  const mats = new Proxy({}, { get: () => ({ [DetailMaterialField.THICKNESS]: 9, x: 9, y: 9 }) });
  const params = Object.fromEntries(Object.values(DetailParam).map(p => [p, 12]));
  for (const fig of [...builtins, rectFigure(), stretchFigure()]) {
    const targets = {
      datums: Object.fromEntries(fig.datums.map(d => [d.id, 40])), params, materials: mats,
    };
    assert.deepEqual(fitDetailFigure(zeroed(fig), targets), fitDetailFigure(fig, targets), fig.key);
    assert.deepEqual(previewPrimitives(zeroed(fig)), previewPrimitives(fig), fig.key);
  }
});

test('normalize: offsetMm のキーを足さない（持たない図の JSON は不変）。明示した 0 は残す', () => {
  const fig = stretchFigure();
  assert.ok(normalizeDetailFigure(fig).anchors.every(a => !Object.hasOwn(a, 'offsetMm')));
  assert.equal(JSON.stringify(normalizeDetailFigure(fig).anchors), JSON.stringify(fig.anchors));
  assert.ok(normalizeDetailFigure(zeroed(fig)).anchors.every(a => a.offsetMm === 0));
});

test('【失敗系】offsetMm が NaN・文字列・Infinity なら BAD_OFFSET（path 付き）。fit は INVALID。キー無しは通る', () => {
  for (const bad of [NaN, '5', Infinity, -Infinity, null]) {
    const fig = rectFigure();
    fig.anchors = fig.anchors.map((a, i) => (i === 1 ? { ...a, offsetMm: bad } : a));
    const v = validateDetailFigure(normalizeDetailFigure(fig));
    assert.equal(v.ok, false, String(bad));
    const e = v.errors.find(x => x.code === E.BAD_OFFSET);
    assert.equal(e.path, 'anchors[1].offsetMm', String(bad));
    const r = fitDetailFigure(fig, ZERO);
    assert.equal(r.error.code, F.INVALID, String(bad));
  }
  // 明示した undefined は「キーが無い」と同じ（通る）
  const und = rectFigure();
  und.anchors = und.anchors.map(a => ({ ...a, offsetMm: undefined }));
  assert.equal(validateDetailFigure(normalizeDetailFigure(und)).ok, true);
  assert.equal(fitDetailFigure(und, ZERO).error, undefined);
  assert.equal(validateDetailFigure(normalizeDetailFigure(rectFigure())).ok, true);
  assert.equal(fitDetailFigure(rectFigure(), ZERO).error, undefined);
});

const seg = (s1, t1, s2, t2) => ({ a: { s: s1, t: t1 }, b: { s: s2, t: t2 } });

test('dxfToComponents: 各ストロークの start は trail の points[0]（矩形は左上の頂点）', () => {
  const { components } = dxfToComponents([seg(5, 7, 105, 7), seg(105, 7, 105, 57), seg(105, 57, 5, 57), seg(5, 57, 5, 7)]);
  const c = components[0];
  assert.deepEqual(c.strokes.map(s => s.start), c.trails.map(tr => tr.points[0]));
  assert.deepEqual(c.strokes[0].start, { s: 5, t: 7 });
});

test('dxfToComponents: 手が 0 本の trail が filter で落ちても start は対応するストロークの頂点 0 のまま（番号がずれる例）', () => {
  // 中心 O から短い脚（1 mm。axisTol 2 で手にならない）と長い脚 2 本。最初の trail（O→短い脚）は落ち、2 本目（長い脚どうし）が stroke 0 になる
  const opts = { snapTol: 0.1, axisTol: 2 };
  const { components } = dxfToComponents([seg(0, 0, 1, 0), seg(0, 0, 100, 0), seg(0, 0, 0, 100)], opts);
  const c = components[0];
  assert.equal(c.trails.length, 2);
  assert.equal(c.strokes.length, 1, '短い脚だけの trail は落ちる');
  assert.notDeepEqual(c.strokes[0].start, c.trails[0].points[0], '番号どおり trails[0] を引くと誤り');
  assert.deepEqual(c.strokes[0].start, c.trails[1].points[0]);
  assert.deepEqual(c.strokes[0].start, { s: 100, t: 0 });
});

test('プレビュー: 非有限の offsetMm は 0 として歩く（落ちない。検証が別に出す）', () => {
  const fig = rectFigure();
  fig.anchors = fig.anchors.map(a => ({ ...a, offsetMm: NaN }));
  assert.deepEqual(previewPts(fig), previewPts(rectFigure()));
});
