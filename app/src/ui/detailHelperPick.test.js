// 図面読込みのプレビュー上の矩形で成分を絞る純ロジック（ui/detailHelperPick.js。S7c-1）のテスト。
// 窓選択（bbox の完全な包含）・選択の置き換え・矩形の scene への結び付き・ドラッグの換算。期待値は手計算の定数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  componentsInRect, activePickRect, setPickRect, clearPickRect, pickedComponentRows, pickSummaryOf,
  figurePointToMm, pickRectFromDrag, pickOverlayStyle, dragKindOf, bindView, activeView,
  reconcileView, panDeltaPx, pinchArgsOf, wheelZoomedView,
} from './detailHelperPick.js';
import { transformOfView, panView, pinchView, viewLimitsOf } from '../structural/sectionFigure/figureView.js';
import { loadDxf, setDxfUnit, toggleDxfComponent, dxfComponentRows, DETAIL_HELPER_TEXT } from './detailHelperForm.js';
import { loadPdf, setPdfScale, setPdfClip, setPdfPageView, extractPdf } from './detailHelperPdf.js';
import { makeTransform } from '../structural/sectionFigure/sectionGeometry.js';
import { PdfDrawOp } from '../core/constants.js';
import { dxfDigest as digest, dxfLine as line, dxfBytesOf } from './detailHelperDxfTestFixtures.js';

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const comp = (index, minS, minT, maxS, maxT) => ({ index, bbox: { minS, minT, maxS, maxT }, vertexCount: 4, closed: true, warnings: [] });
// 0: (0,0)-(100,50)  1: (200,0)-(260,40)  2: (10,10)-(30,20)  3: (90,40)-(110,60)（0 とまたがる）  4: bbox なし
const SCENE = { components: [comp(0, 0, 0, 100, 50), comp(1, 200, 0, 260, 40), comp(2, 10, 10, 30, 20), comp(3, 90, 40, 110, 60), { index: 4 }] };
const state0 = () => ({ scene: SCENE, selected: [1], pick: null });
const RECT = { x: 0, y: 0, w: 100, h: 50 };

test('componentsInRect: 境界上は含める（0 は矩形と同じ辺）。一部がはみ出す成分（3）・遠い成分（1）は除く。index は昇順', () => {
  assert.deepEqual(componentsInRect(SCENE.components, RECT), [0, 2]);
});

test('componentsInRect: 1 辺だけ 0.1 はみ出すと除く（交差ではなく包含）', () => {
  assert.deepEqual(componentsInRect(SCENE.components, { x: 0, y: 0, w: 99.9, h: 50 }), [2]);
  assert.deepEqual(componentsInRect(SCENE.components, { x: 0, y: 0.1, w: 100, h: 49.9 }), [2]);
});

test('【失敗系】componentsInRect: 矩形が無効（null・幅 0・負・NaN）なら []。bbox の無い成分（4）は広い矩形でも対象外', () => {
  for (const bad of [null, undefined, { x: 0, y: 0, w: 0, h: 50 }, { x: 0, y: 0, w: 100, h: -1 }, { x: NaN, y: 0, w: 100, h: 50 }]) {
    assert.deepEqual(componentsInRect(SCENE.components, bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(componentsInRect(SCENE.components, { x: -1000, y: -1000, w: 5000, h: 5000 }), [0, 1, 2, 3]);
});

test('setPickRect: 選択を矩形内の成分で置き換える（元の選択 1 は消える）。矩形は scene に結び付き、渡した矩形のコピーを持つ', () => {
  const rect = { ...RECT };
  const s = setPickRect(state0(), rect);
  assert.deepEqual(s.selected, [0, 2]);
  assert.equal(s.pick.scene, SCENE);
  assert.deepEqual(activePickRect(s), RECT);
  rect.w = 1;
  assert.deepEqual(activePickRect(s), RECT, '渡した矩形を後で書き換えても影響しない');
});

test('clearPickRect: 矩形だけを外し、選択は残る。一覧は全件に戻る', () => {
  const s = clearPickRect(setPickRect(state0(), RECT));
  assert.equal(activePickRect(s), null);
  assert.deepEqual(s.selected, [0, 2]);
  const rows = SCENE.components.map(c => ({ index: c.index }));
  assert.equal(pickedComponentRows(s, rows), rows);
});

test('【失敗系】setPickRect: 矩形が無効（幅 0・NaN・null）なら state を変えない（同一参照）。scene の無い state でも同じ', () => {
  const s = state0();
  for (const bad of [{ x: 0, y: 0, w: 0, h: 50 }, { x: 0, y: 0, w: NaN, h: 50 }, null]) assert.equal(setPickRect(s, bad), s);
  const noScene = { scene: null, selected: [], pick: null };
  assert.equal(setPickRect(noScene, RECT), noScene);
});

test('【失敗系】activePickRect: scene の無い state・undefined・別の scene に引いた矩形は null', () => {
  assert.equal(activePickRect(undefined), null);
  assert.equal(activePickRect({ scene: null, selected: [], pick: null }), null);
  assert.equal(activePickRect({ scene: undefined, pick: { scene: undefined, rect: RECT } }), null);
  const other = { components: SCENE.components };
  assert.equal(activePickRect({ ...setPickRect(state0(), RECT), scene: other }), null, 'scene が作り直されたら無効');
});

test('pickedComponentRows: 矩形があれば矩形内（0・2）の行だけ。矩形が無い・scene が無い state では rows をそのまま返す', () => {
  const rows = SCENE.components.map(c => ({ index: c.index }));
  assert.deepEqual(pickedComponentRows(setPickRect(state0(), RECT), rows).map(r => r.index), [0, 2]);
  assert.equal(pickedComponentRows(state0(), rows), rows);
  assert.equal(pickedComponentRows({ scene: null, selected: [], pick: null }, rows), rows);
});

test('pickSummaryOf: 矩形内 2・全 5・選択 2。矩形が無ければ null。選択を 1 つ外すと選択だけ減る', () => {
  const s = setPickRect(state0(), RECT);
  assert.deepEqual(pickSummaryOf(s), { inRect: 2, total: 5, selected: 2 });
  assert.deepEqual(pickSummaryOf(toggleDxfComponent(s, 0)), { inRect: 2, total: 5, selected: 1 });
  assert.equal(pickSummaryOf(state0()), null);
  assert.equal(DETAIL_HELPER_TEXT.pickSummary(2, 5, 1), '矩形内 2 ／ 全 5 成分・選択 1');
});

// ---- ドラッグ → 矩形 ----
const T = makeTransform({ minX: -100, minY: -50, width: 1000, height: 500 }, 1 / 2); // pxWidth 564・pxHeight 314
const BOX = { left: 10, top: 20, width: T.pxWidth, height: T.pxHeight };

test('figurePointToMm: 要素の左上は bounds の左上より余白ぶん手前（-164 mm）。tx(v) の位置は v に戻る', () => {
  const p = figurePointToMm({ clientX: BOX.left, clientY: BOX.top }, BOX, T);
  approx(p.x, -164);
  approx(p.y, -114);
  const q = figurePointToMm({ clientX: BOX.left + T.tx(300), clientY: BOX.top + T.ty(100) }, BOX, T);
  approx(q.x, 300);
  approx(q.y, 100);
});

test('figurePointToMm: CSS で 2 倍に拡大した要素でも同じ点に戻る（クライアント座標を拡大率で割る）', () => {
  const big = { left: 10, top: 20, width: T.pxWidth * 2, height: T.pxHeight * 2 };
  const q = figurePointToMm({ clientX: big.left + T.tx(300) * 2, clientY: big.top + T.ty(100) * 2 }, big, T);
  approx(q.x, 300);
  approx(q.y, 100);
});

test('figurePointToMm: 縦横で拡大率が違う要素（横 2 倍・縦 3 倍）でも x・y それぞれの比で同じ点に戻る', () => {
  const skew = { left: 10, top: 20, width: T.pxWidth * 2, height: T.pxHeight * 3 };
  const q = figurePointToMm({ clientX: skew.left + T.tx(300) * 2, clientY: skew.top + T.ty(100) * 3 }, skew, T);
  approx(q.x, 300);
  approx(q.y, 100);
});

const pt = (clientX, clientY, mm) => ({ clientX, clientY, mm });
test('pickRectFromDrag: 7px の移動はタップ（null）・8px は矩形。向きに依らず左上と幅・高さ（小数 1 桁へ丸め）', () => {
  const a = pt(100, 100, { x: 10.04, y: 20 });
  assert.equal(pickRectFromDrag(a, pt(107, 100, { x: 80, y: 90 })), null);
  assert.deepEqual(pickRectFromDrag(a, pt(108, 100, { x: 80, y: 90 })), { x: 10, y: 20, w: 70, h: 70 });
  assert.deepEqual(pickRectFromDrag(pt(108, 100, { x: 80, y: 90 }), a), { x: 10, y: 20, w: 70, h: 70 });
});

test('【失敗系】pickRectFromDrag: 距離が NaN（座標欠落）はタップ扱いにせず矩形にする。縦横とも 8px 未満でも斜めで 8px 以上なら矩形', () => {
  assert.ok(pickRectFromDrag(pt(NaN, 0, { x: 0, y: 0 }), pt(0, 0, { x: 10, y: 10 })));
  assert.ok(pickRectFromDrag(pt(0, 0, { x: 0, y: 0 }), pt(6, 6, { x: 10, y: 10 })), '距離 8.49');
  assert.equal(pickRectFromDrag(pt(0, 0, { x: 0, y: 0 }), pt(5, 5, { x: 10, y: 10 })), null, '距離 7.07');
});

test('【失敗系】幅 0 の矩形（同じ mm 座標へのドラッグ）は setPickRect が受け付けない', () => {
  const r = pickRectFromDrag(pt(0, 0, { x: 5, y: 5 }), pt(50, 0, { x: 5, y: 80 }));
  assert.deepEqual(r, { x: 5, y: 5, w: 0, h: 75 });
  const s = state0();
  assert.equal(setPickRect(s, r), s);
});

test('pickOverlayStyle: 矩形 (0,0,100,50) は縮尺 1/2 で left 82・top 57・幅 50・高さ 25。無効な矩形は null', () => {
  const st = pickOverlayStyle({ x: 0, y: 0, w: 100, h: 50 }, T);
  assert.deepEqual(st, { left: T.tx(0), top: T.ty(0), width: 50, height: 25 });
  approx(st.left, 82);
  approx(st.top, 57);
  assert.equal(pickOverlayStyle(null, T), null);
  assert.equal(pickOverlayStyle({ x: 0, y: 0, w: 0, h: 5 }, T), null);
});

// ---- 本番の状態（DXF・PDF）で通す ----
const dxfBytes = () => dxfBytesOf([
  ...line(0, 0, 100, 0), ...line(100, 0, 100, 50), ...line(100, 50, 0, 50), ...line(0, 50, 0, 0),
  ...line(200, 0, 260, 0), ...line(260, 0, 230, 40),
]);
// 全成分を含む広い矩形（bbox の合併から導く）
const hull = comps => {
  const b = comps.map(c => c.bbox);
  const x = Math.min(...b.map(v => v.minS));
  const y = Math.min(...b.map(v => v.minT));
  return { x, y, w: Math.max(...b.map(v => v.maxS)) - x, h: Math.max(...b.map(v => v.maxT)) - y };
};

test('DXF: 全範囲の矩形は全成分を拾う（件数＝成分数）。成分 0 だけを囲む矩形で一覧が 1 件に絞られ、選択は置き換わる', async () => {
  const r = await loadDxf({ bytes: dxfBytes(), fileName: 's.dxf', digest });
  assert.equal(r.ok, true, r.message);
  let dxf = toggleDxfComponent(r.dxf, 1);
  const comps = dxf.scene.components;
  assert.equal(comps.length, 2);
  assert.ok(comps.every(c => c.bbox), '全成分に bbox が付く');
  assert.equal(componentsInRect(comps, hull(comps)).length, comps.length);
  const b0 = comps[0].bbox;
  const only0 = { x: b0.minS, y: b0.minT, w: b0.maxS - b0.minS, h: b0.maxT - b0.minT };
  dxf = setPickRect(dxf, only0);
  assert.deepEqual(dxf.selected, [0]);
  assert.deepEqual(pickedComponentRows(dxf, dxfComponentRows(dxf)).map(x => x.index), [0]);
});

test('【失敗系】DXF: 単位を変えると scene が作り直され、矩形は無効・一覧は全件に戻る（setDxfUnit は矩形の処理を持たない）', async () => {
  const r = await loadDxf({ bytes: dxfBytes(), fileName: 's.dxf', digest });
  const picked = setPickRect(r.dxf, hull(r.dxf.scene.components));
  assert.ok(activePickRect(picked));
  const { dxf, error } = setDxfUnit(picked, '2');
  assert.equal(error, null);
  assert.notEqual(dxf.scene, picked.scene);
  assert.equal(activePickRect(dxf), null);
  assert.equal(pickSummaryOf(dxf), null);
  assert.equal(pickedComponentRows(dxf, dxfComponentRows(dxf)).length, 2);
  assert.ok(dxf.pick, '矩形のデータ自体は残るが scene が違うので使われない');
});

const FRAME = { width: 560, height: 480 };
const BIG = { minX: -1000, minY: -1000, maxX: 2000, maxY: 2000, width: 3000, height: 3000 };

test('panDeltaPx: 指を +10px 動かすと図の px も +10（rect が t の半分の大きさなら 2 倍）。panView に渡すと cx は base.cx − 10/scale', () => {
  const base = { scale: 4, cx: 400, cy: 250 };
  const t = transformOfView(base, FRAME);
  const from = { clientX: 100, clientY: 100 };
  const same = { t, rect: { left: 0, top: 0, width: t.pxWidth, height: t.pxHeight }, from };
  assert.deepEqual(panDeltaPx(same, { clientX: 110, clientY: 100 }), { dx: 10, dy: 0 });
  const half = { ...same, rect: { left: 0, top: 0, width: t.pxWidth / 2, height: t.pxHeight / 2 } };
  assert.deepEqual(panDeltaPx(half, { clientX: 110, clientY: 90 }), { dx: 20, dy: -20 });
  const { dx, dy } = panDeltaPx(same, { clientX: 110, clientY: 100 });
  const moved = panView(base, dx, dy, BIG);
  approx(moved.cx, base.cx - 10 / base.scale);
  approx(moved.cy, base.cy);
});

test('pinchArgsOf: 2 指を開くと scale が増え、閉じると減る。開始と現在を入れ替えると逆。中点が動かなければ中心は不変', () => {
  const base = { scale: 1, cx: 400, cy: 250 };
  const limits = viewLimitsOf(0.5);
  const g = { base, startT: transformOfView(base, FRAME), p0a: { x: 230, y: 240 }, p0b: { x: 330, y: 240 }, limits, contentBounds: BIG }; // 中点＝枠の中央 (280, 240)
  const open = { p1a: { x: 205, y: 240 }, p1b: { x: 355, y: 240 } };
  const closed = { p1a: { x: 240, y: 240 }, p1b: { x: 320, y: 240 } };
  const opened = pinchView(...pinchArgsOf(g, open));
  const shut = pinchView(...pinchArgsOf(g, closed));
  approx(opened.scale, 1.5);
  approx(shut.scale, 0.8);
  assert.equal(pinchView(...pinchArgsOf(g, { p1a: { x: 255, y: 240 }, p1b: { x: 305, y: 240 } })), null, '全体の縮尺以下まで閉じたら全体');
  approx(opened.cx, 400);
  approx(opened.cy, 250);
  // 入れ替え: 現在を開始・開始を現在にすると逆向きの比
  const swapped = pinchView(...pinchArgsOf({ ...g, p0a: open.p1a, p0b: open.p1b }, { p1a: g.p0a, p1b: g.p0b }));
  approx(swapped.scale, 1 / 1.5);
  assert.ok(opened.scale > base.scale && swapped.scale < base.scale);
  // 失敗系: 指の座標が非有限なら RangeError（呼び出し側のバグ）
  assert.throws(() => pinchView(...pinchArgsOf(g, { p1a: { x: NaN, y: 0 }, p1b: open.p1b })), RangeError);
});

test('wheelZoomedView: 全体からは枠つきの基準で、カーソル下の図の点の画面位置を保つ。全体の縮尺以下は null。範囲外へはみ出さない', () => {
  const content = { minX: 0, minY: 0, maxX: 800, maxY: 500, width: 800, height: 500 };
  const t = makeTransform(content, 0.5);
  const rect = { left: 10, top: 20, width: t.pxWidth, height: t.pxHeight };
  const client = { clientX: 10 + 100, clientY: 20 + 80 };
  const args = { view: null, t, frame: FRAME, client, rect, factor: 2, autoScale: 0.5, contentBounds: content };
  const next = wheelZoomedView(args);
  approx(next.scale, 1);
  const after = transformOfView(next, FRAME);
  approx(after.tx(t.mmX(100)), 100); // 中心の mm が t.mmX と一致し、その画面位置が変わらない
  approx(after.ty(t.mmY(80)), 80);
  assert.equal(wheelZoomedView({ ...args, factor: 0.9 }), null, '全体より縮めたら全体へ');
  const far = wheelZoomedView({ ...args, client: { clientX: 10 + t.pxWidth, clientY: 20 + t.pxHeight }, factor: 40 });
  assert.ok(far.cx <= content.maxX && far.cy <= content.maxY, '中心は図の範囲の中');
  assert.equal(far.scale, 20, '最大で頭打ち');
  // 失敗系: 倍率 0 は RangeError
  assert.throws(() => wheelZoomedView({ ...args, factor: 0 }), RangeError);
});

test('reconcileView: レイヤ切替で図が変わったあとの view。新しい全体の縮尺以下なら null、それ以外は中心を新しい範囲へ寄せる。view が無ければ null', () => {
  const bounds = { minX: 0, minY: 0, maxX: 800, maxY: 500, width: 800, height: 500 };
  const view = { scale: 2, cx: 1000, cy: -50 };
  assert.deepEqual(reconcileView(view, 0.5, bounds), { scale: 2, cx: 800, cy: 0 });
  assert.equal(reconcileView(view, 2, bounds), null, '新しい全体の縮尺と同じなら全体');
  assert.equal(reconcileView(view, 3, bounds), null, '図が小さくなって全体の縮尺が上がったら全体');
  assert.equal(reconcileView(null, 0.5, bounds), null);
  assert.throws(() => reconcileView(view, 0.5, { minX: NaN, maxX: 1, minY: 0, maxY: 1 }), RangeError);
});

test('dragKindOf: 長押しが成立して矩形を引ける図のときだけ矩形。それ以外（長押し前に動かした・矩形を引けない）は移動', () => {
  assert.equal(dragKindOf({ fired: true, canPick: true }), 'rect');
  assert.equal(dragKindOf({ fired: false, canPick: true }), 'pan');
  assert.equal(dragKindOf({ fired: true, canPick: false }), 'pan');
  assert.equal(dragKindOf({ fired: false, canPick: false }), 'pan');
});

test('bindView／activeView: オーナー（scene・下書きの key）が同じ間だけ view が有効。変わる（単位変更・再抽出・別の下書き）か無いと全体（null）', () => {
  const sceneA = { id: 'a' };
  const sceneB = { id: 'b' };
  const view = { scale: 4, cx: 10, cy: 20 };
  const bound = bindView(sceneA, view);
  assert.equal(activeView(bound, sceneA), view);
  assert.equal(activeView(bound, sceneB), null, 'scene が作り直されたら全体');
  assert.equal(activeView(bound, { ...sceneA }), null, '同じ中身でも別のオブジェクトは別の scene');
  assert.equal(activeView(bindView('draft:1', view), 'draft:1'), view);
  assert.equal(activeView(bindView('draft:1', view), 'draft:2'), null);
  assert.equal(activeView(bindView(sceneA, null), sceneA), null, '全体を結び付けても全体');
  // 失敗系: 結び付けが無い・オーナーが無い（PDF の抽出前など）は全体
  assert.equal(activeView(null, sceneA), null);
  assert.equal(activeView(bound, undefined), null);
  assert.equal(activeView(bindView(undefined, view), undefined), null, 'オーナー未定同士は一致させない');
});

const { MOVE_TO: M, LINE_TO: L, CLOSE: Z } = PdfDrawOp;
const OPS = { constructPath: 91, stroke: 20 };
const PAGE = {
  opList: { fnArray: [OPS.constructPath, OPS.constructPath], argsArray: [[OPS.stroke, [[M, 0, 0, L, 100, 0, L, 100, 50, L, 0, 50, Z]], null], [OPS.stroke, [[M, 150, 80, L, 190, 80]], null]] },
  ops: OPS, view: [0, 0, 200, 100],
};

test('PDF: 抽出結果にも効く。再抽出すると scene が変わり、矩形は無効になる。ページ・縮尺の変更（scene を捨てる）でも無効', async () => {
  const loaded = await loadPdf({ bytes: new TextEncoder().encode('%PDF-1.7\nsample'), fileName: 'a.pdf', digest, open: async () => ({ ok: true, doc: {}, pageCount: 2 }) });
  assert.equal(loaded.ok, true, loaded.message);
  const ready = setPdfScale(setPdfClip(setPdfPageView(loaded.pdf, PAGE.view), { x: 0, y: 0, w: 120, h: 100 }), '6');
  const { pdf, error } = extractPdf(ready, PAGE);
  assert.equal(error, null);
  assert.ok(pdf.scene.components.every(c => c.bbox), 'PDF の成分にも bbox が付く');
  const picked = setPickRect(pdf, hull(pdf.scene.components));
  assert.deepEqual(picked.selected, pdf.scene.components.map(c => c.index));
  assert.ok(activePickRect(picked));
  const again = extractPdf(picked, PAGE).pdf;
  assert.notEqual(again.scene, picked.scene);
  assert.equal(activePickRect(again), null);
  assert.equal(activePickRect(setPdfScale(picked, '12')), null, '縮尺を変えて scene を捨てた後');
  assert.equal(pickedComponentRows(again, dxfComponentRows(again)).length, again.scene.components.length);
});
