import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SvgFigurePrimitiveType, PenDir, DetailDash } from '../core/constants.js';
import { previewPrimitives, datumGuidePrimitives, assignDimRows, previewDimGap, PREVIEW_DIM_GAP_MM, PREVIEW_DIM_GAP_RATIO } from './detailPreview.js';
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

test('preview: 寸法線は足（foot＝材側の座標）を持ち、既定 gap は PREVIEW_DIM_GAP_MM（80）。足の長さは gap/2 を空けた footLen', () => {
  assert.equal(PREVIEW_DIM_GAP_MM, 80);
  const fig = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(20))])]);
  const [h, v] = previewPrimitives(fig).filter(p => p.type === SvgFigurePrimitiveType.DIM);
  // 点列 (0,0)→(10,0)→(10,20)。bbox の中心 (5,10)。h は t=0 が中心より上＝−側（R5）、v は s=10 が中心より右＝+側
  assert.equal(h.foot, 0); assert.equal(h.at, 0 - PREVIEW_DIM_GAP_MM);
  assert.equal(v.foot, 10); assert.equal(v.at, 10 + PREVIEW_DIM_GAP_MM);
  // P5/R8: 足は材側に gap/2 を空けて寸法線まで（footLen＝|at−foot|−gap/2）
  assert.equal(h.footLen, PREVIEW_DIM_GAP_MM / 2); assert.equal(v.footLen, PREVIEW_DIM_GAP_MM / 2);
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
  // 等価: foot・footLen・labelVertical・labelSide を除けば従来の dim と同じ
  const strip = d => Object.fromEntries(Object.entries(d).filter(([k]) => !['foot', 'footLen', 'labelVertical', 'labelSide'].includes(k)));
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

test('preview【P5 R6】: gap＝max(下限, 0.2 × 図全体の bbox の長辺)。小さい図は 80・長辺 1,700 は 340・dimGapMm 25 でも 340（下限扱い）', () => {
  assert.equal(PREVIEW_DIM_GAP_RATIO, 0.2);
  assert.equal(previewDimGap(80, [{ s: 0, t: 0 }, { s: 100, t: 20 }]), 80);
  assert.equal(previewDimGap(80, [{ s: 0, t: 0 }, { s: 1700, t: 20 }]), 340);
  assert.equal(previewDimGap(80, []), 80); // 頂点なしは下限
  const big = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(1700))])]);
  const small = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(100))])]);
  assert.equal(dimsOf(small)[0].at, 80);
  assert.equal(dimsOf(big)[0].at, 340);
  assert.equal(previewPrimitives(big, { dimGapMm: 25 }).find(p => p.type === SvgFigurePrimitiveType.DIM).at, 340);
  assert.equal(previewPrimitives(small, { dimGapMm: 25 }).find(p => p.type === SvgFigurePrimitiveType.DIM).at, 25);
  // 基準線も同じ gap（bbox ± gap）
  const g = previewPrimitives({ ...big, datums: [dOrigin('a', 'fl', 's', 0)] }).find(p => p.guide && p.type === SvgFigurePrimitiveType.POLYLINE);
  assert.deepEqual(g.points, [[0, -340], [0, 340]]);
});

test('assignDimRows: 重なる区間は別の行・端点一致も重なり・離れた区間は同じ行・空は []・1 件は 0', () => {
  assert.deepEqual(assignDimRows([], 80), []);
  assert.deepEqual(assignDimRows([{ from: 0, to: 100 }], 80), [0]);
  assert.deepEqual(assignDimRows([{ from: 0, to: 100 }, { from: 40, to: 100 }], 80), [0, 1]);
  assert.deepEqual(assignDimRows([{ from: 0, to: 100 }, { from: 100, to: 150 }], 80), [0, 1]);
  assert.deepEqual(assignDimRows([{ from: 0, to: 100 }, { from: 300, to: 400 }], 80), [0, 0]);
});

test('assignDimRows: 区間が離れていても中心間が gap 未満なら別の行（値の重なり）。ちょうど gap なら同じ行', () => {
  assert.deepEqual(assignDimRows([{ from: 0, to: 30 }, { from: 40, to: 70 }], 80), [0, 1]); // 中心 15 と 55
  assert.deepEqual(assignDimRows([{ from: 0, to: 30 }, { from: 95, to: 125 }], 80), [0, 0]); // 中心 15 と 110
  assert.deepEqual(assignDimRows([{ from: 0, to: 30 }, { from: 80, to: 110 }], 80), [0, 0]); // 中心 15 と 95＝差 80（gap 未満でない）
  assert.deepEqual(assignDimRows([{ from: 0, to: 30 }, { from: 79, to: 109 }], 80), [0, 1]); // 差 79 < 80
  assert.deepEqual(assignDimRows([{ from: 0, to: 30 }, { from: 65, to: 95 }], 80), [0, 1]); // 中心 15 と 80＝差 65 < 80
});

test('assignDimRows: 最小の行を再利用する（3 件で 0,1,0）・入力順に対応・同じ始点は入力順（安定）', () => {
  // A[0,100] B[50,60] C[300,400]: B は A と重なり行 1、C はどれとも離れ行 0
  assert.deepEqual(assignDimRows([{ from: 0, to: 100 }, { from: 50, to: 60 }, { from: 300, to: 400 }], 80), [0, 1, 0]);
  // 入力順が始点順でなくても結果は入力順の添字
  assert.deepEqual(assignDimRows([{ from: 300, to: 400 }, { from: 50, to: 60 }, { from: 0, to: 100 }], 80), [0, 1, 0]);
  // 同じ始点は入力順に先勝ち
  assert.deepEqual(assignDimRows([{ from: 0, to: 10 }, { from: 0, to: 10 }], 80), [0, 1]);
});

test('assignDimRows【失敗系】: 非有限の from/to・gap が 0 以下／非有限は RangeError', () => {
  assert.throws(() => assignDimRows([{ from: NaN, to: 1 }], 80), RangeError);
  assert.throws(() => assignDimRows([{ from: 0, to: Infinity }], 80), RangeError);
  assert.throws(() => assignDimRows([null], 80), RangeError);
  assert.throws(() => assignDimRows([{ from: 0, to: 1 }], 0), RangeError);
  assert.throws(() => assignDimRows([{ from: 0, to: 1 }], -5), RangeError);
  assert.throws(() => assignDimRows([{ from: 0, to: 1 }], NaN), RangeError);
});

test('preview【P5 R7・R8】: 閉じた矩形は各側 1 行で at＝辺 ± gap・足は材から gap/2 空けて寸法線まで', () => {
  const G = PREVIEW_DIM_GAP_MM;
  const fig = figureOf([strokeOf('r', [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(50)), move(PenDir.LEFT, fixedLen(100)), move(PenDir.UP, fixedLen(50)),
  ])]);
  const ds = dimsOf(fig);
  assert.deepEqual(ds.map(d => d.at), [-G, 100 + G, 50 + G, -G]);
  for (const d of ds) assert.equal(d.footLen, G / 2);
});

test('preview【P5 R7】: 段付き形は上側の 2 寸法が重なるので行 0・行 1（at が gap/2 違い、内側の足は長い）', () => {
  // (0,0)(100,0)(100,20)(40,20)(40,220)。上辺 [0,100] と段 [40,100]（a.t=20）はどちらも上側
  const fig = figureOf([strokeOf('s', [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(20)), move(PenDir.LEFT, fixedLen(60)), move(PenDir.DOWN, fixedLen(200)),
  ])]);
  const G = PREVIEW_DIM_GAP_MM; // 長辺 220 × 0.2 = 44 < 80
  const [top, , step] = dimsOf(fig);
  assert.equal(top.at, -G); assert.equal(step.at, -(G + G / 2));
  assert.equal(step.at - top.at, -G / 2);
  assert.equal(top.footLen, G / 2);
  assert.equal(step.foot, 20); assert.equal(step.footLen, Math.abs(step.at - 20) - G / 2);
});

test('preview【P5 R7】: 離れていても短い隣接 2 区間（中心間 < gap）は別の行。R5 の側の判定は不変', () => {
  // (0,0)(30,0)(30,10)(40,10)(40,0)(70,0)(70,100)。上辺の [0,30] と [40,70] は中心間 40 < 80
  const fig = figureOf([strokeOf('s', [
    move(PenDir.RIGHT, fixedLen(30)), move(PenDir.DOWN, fixedLen(10)), move(PenDir.RIGHT, fixedLen(10)),
    move(PenDir.UP, fixedLen(10)), move(PenDir.RIGHT, fixedLen(30)), move(PenDir.DOWN, fixedLen(100)),
  ])]);
  const ds = dimsOf(fig);
  const a = ds[0], b = ds[4];
  assert.equal(a.from, 0); assert.equal(b.from, 40);
  assert.notEqual(a.at, b.at);
  assert.equal(a.at, -PREVIEW_DIM_GAP_MM); // 先に置かれた方が行 0
  assert.ok(ds.every(d => d.at < 0 || d.at > 0));
});

test('assignDimRows【検出力】: 端点一致だけの衝突（中心間 200 ≥ gap）。1 離れれば同じ行', () => {
  assert.deepEqual(assignDimRows([{ from: 0, to: 200 }, { from: 200, to: 400 }], 80), [0, 1]);
  assert.deepEqual(assignDimRows([{ from: 0, to: 200 }, { from: 201, to: 401 }], 80), [0, 0]);
});

test('assignDimRows【検出力】: 区間の重なりだけの衝突（中心間 425 ≥ gap）', () => {
  assert.deepEqual(assignDimRows([{ from: 0, to: 1000 }, { from: 900, to: 950 }], 80), [0, 1]);
});

test('previewDimGap: 長辺が t の図でも比例（340）。不正な下限・頂点は例外にせず既定へ', () => {
  assert.equal(previewDimGap(80, [{ s: 0, t: 0 }, { s: 20, t: 1700 }]), 340);
  assert.equal(previewDimGap(0, [{ s: 0, t: 0 }]), PREVIEW_DIM_GAP_MM);
  assert.equal(previewDimGap(NaN, []), PREVIEW_DIM_GAP_MM);
  assert.equal(previewDimGap(80, [{ s: NaN, t: 0 }, { s: 1, t: 1 }]), 80);
});

test('preview【P5 R7 改】: 行の基準はストロークごとの bbox。複数ストロークで足が別のストロークを貫かない', () => {
  const G = PREVIEW_DIM_GAP_MM;
  const rect = id => strokeOf(id, [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(50)), move(PenDir.LEFT, fixedLen(100)), move(PenDir.UP, fixedLen(50)),
  ]);
  const fig = figureOf([rect('a'), rect('b')], {
    anchors: [anchorOf('ds0', 'a', 0), anchorOf('dt0', 'a', 0), anchorOf('ds0', 'b', 0), { ...anchorOf('dt0', 'b', 0), offsetMm: 300 }],
  });
  const ds = dimsOf(fig);
  const of = (id, i) => ds.find(d => d.editKey.strokeId === id && d.editKey.moveIndex === i);
  assert.equal(of('a', 2).at, 50 + G); // a の下辺は b（t 300〜350）の手前
  assert.equal(of('b', 0).at, 300 - G); // b の上辺は a の下
  assert.equal(of('a', 2).footLen, G / 2); assert.equal(of('b', 0).footLen, G / 2);
  assert.equal(of('a', 0).at, -G); assert.equal(of('b', 2).at, 350 + G);
});

test('preview【P5 R9】: 櫛形（高さ 15 の歯 ×20）の縦の寸法は同じ側で 1 本に畳み、行 0 だけ・図の bbox ± 2·gap 以内。代表は最初の手', () => {
  const moves = [];
  for (let i = 0; i < 20; i++) moves.push(move(PenDir.RIGHT, fixedLen(10)), move(PenDir.UP, fixedLen(15)), move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(15)));
  const ds = dimsOf(figureOf([strokeOf('c', moves)]));
  const vs = ds.filter(d => d.dir === 'v');
  assert.equal(vs.length, 2, '左右の側ごとに 1 本');
  const G = PREVIEW_DIM_GAP_MM; // 長辺 400 × 0.2 = 80
  assert.deepEqual(vs.map(d => d.at).sort((x, y) => x - y), [-G, 400 + G]);
  assert.equal(vs.find(d => d.at < 0).editKey.moveIndex, 1); // 最初の縦の手（左側）
  for (const d of vs) assert.ok(d.at >= -2 * G && d.at <= 400 + 2 * G);
});

test('preview【失敗系】: origin の Datum の offsetMm が NaN でも previewPrimitives は例外を投げない。dimGapMm 0 でも落ちない', () => {
  const fig = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(10))])]);
  const bad = { ...fig, datums: [{ ...fig.datums[0], offsetMm: NaN }, fig.datums[1]] };
  assert.doesNotThrow(() => previewPrimitives(bad));
  assert.doesNotThrow(() => previewPrimitives(fig, { dimGapMm: 0 }));
  assert.equal(previewPrimitives(fig, { dimGapMm: 0 }).find(p => p.type === SvgFigurePrimitiveType.DIM).at, -PREVIEW_DIM_GAP_MM);
});

test('preview【失敗系】: from／to は有限で foot 側の座標（h なら t）だけ NaN の手は、例外を出さず寸法も出ない', () => {
  const fig = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(10)), move(PenDir.DOWN, fixedLen(10))])]);
  const bad = { ...fig, datums: [fig.datums[0], { ...fig.datums[1], offsetMm: NaN }] }; // t が全部 NaN（s は有限）
  let prims;
  assert.doesNotThrow(() => { prims = previewPrimitives(bad); });
  assert.deepEqual(prims.filter(p => p.type === SvgFigurePrimitiveType.DIM), []);
});

test('preview【既知の限界】: 近接する 2 ストローク（間隔 50 < gap 80）は寸法線と足が隣の材を横切る（現状の固定）', () => {
  const G = PREVIEW_DIM_GAP_MM;
  const rect = id => strokeOf(id, [
    move(PenDir.RIGHT, fixedLen(100)), move(PenDir.DOWN, fixedLen(50)), move(PenDir.LEFT, fixedLen(100)), move(PenDir.UP, fixedLen(50)),
  ]);
  const fig = figureOf([rect('a'), rect('b')], {
    anchors: [anchorOf('ds0', 'a', 0), anchorOf('dt0', 'a', 0), anchorOf('ds0', 'b', 0), { ...anchorOf('dt0', 'b', 0), offsetMm: 100 }],
  });
  const ds = dimsOf(fig);
  const of = (id, i) => ds.find(d => d.editKey.strokeId === id && d.editKey.moveIndex === i);
  assert.equal(of('a', 2).at, 50 + G); // 130＝b（t 100〜150）の内側
  assert.equal(of('b', 0).at, 100 - G); // 20＝a（t 0〜50）の内側
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
