// 基準点を指す（S7d-4）: rebaseOrigin（form 側）・nearestPointWithin／previewVertexPoints／draftViewOfImport（pick 側）・パネルの配線。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import {
  loadDxf, toggleDxfComponent, draftFromDxf, previewPrimitivesOf, rebaseOrigin, entryFromForm, formFromEntry, validation,
  pushHistory, undoDraft, DETAIL_HELPER_TEXT, dxfPreviewPrimitives, rebaseDelta,
} from './detailHelperForm.js';
import {
  previewVertexPoints, nearestPointWithin, draftViewOfImport, DETAIL_BASE_SNAP_PX, bindView, activeView,
} from './detailHelperPick.js';
import { sha256HexWith } from '../detail/dxf/dxfProvenance.js';
import { SvgFigurePrimitiveType } from '../core/constants.js';
import { fitDetailFigure } from '../detail/detailFit.js';
import { stretchFigure } from '../detail/detailTestFixtures.js';

const text = arr => `${arr.map(([c, v]) => `${c}\n${v}`).join('\n')}\n`;
const line = (x1, y1, x2, y2) => [[0, 'LINE'], [8, '0'], [10, x1], [20, y1], [11, x2], [21, y2]];
const rect = (x, y, w, h) => [...line(x, y, x + w, y), ...line(x + w, y, x + w, y + h), ...line(x + w, y + h, x, y + h), ...line(x, y + h, x, y)];
const bytesOf = body => new TextEncoder().encode(text([
  [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'], ...body, [0, 'ENDSEC'], [0, 'EOF'],
]));
const digest = sha256HexWith(webcrypto.subtle);
const ids = () => 'fixed-id';
async function twoRectForm() {
  // 1 つ目の矩形を原点から離す（P.s・P.t が 0 でない）＝draftViewOfImport の両軸の符号をテストが検出できるように
  const r = await loadDxf({ bytes: bytesOf([...rect(20, 10, 100, 50), ...rect(300, 100, 60, 40)]), fileName: 'o.dxf', digest });
  assert.equal(r.ok, true, r.message);
  const dxf = [0, 1].reduce((d, i) => toggleDxfComponent(d, i), r.dxf);
  return { ...draftFromDxf({ dxf, idFactory: ids }), dxf };
}
const strokePts = form => previewPrimitivesOf(form)
  .filter(p => p.type === SvgFigurePrimitiveType.POLYLINE && p.strokeId).map(p => p.points);
const minus = (pts, d) => pts.map(ps => ps.map(([x, y]) => [x - d.x, y - d.y]));

test('rebaseOrigin: offsetMm 持ちの図は P が基準線（0,0）に来るよう全頂点が一定量だけ平行移動する', async () => {
  const { form } = await twoRectForm();
  const before = strokePts(form);
  const P = { s: before[1][2][0], t: before[1][2][1] }; // 2 本目の頂点 2
  const moved = rebaseOrigin(form, P);
  assert.deepEqual(strokePts(moved), minus(before, { x: P.s, y: P.t }));
  assert.deepEqual(strokePts(moved)[1][2], [0, 0], 'P が基準線の位置に来る');
  assert.equal(validation(moved).ok, true);
  assert.notEqual(moved.anchors, form.anchors, '新しい配列');
  assert.deepEqual(form.anchors, (await twoRectForm()).form.anchors, '元の form は不変');
});

test('rebaseOrigin: 2 回の rebase は合成（2 回目の P は 1 回目の後の座標。最終的に最後に指した点が基準線）', async () => {
  const { form } = await twoRectForm();
  const p1 = { s: strokePts(form)[0][1][0], t: strokePts(form)[0][1][1] };
  const once = rebaseOrigin(form, p1);
  const p2 = { s: strokePts(once)[1][0][0], t: strokePts(once)[1][0][1] };
  const twice = rebaseOrigin(once, p2);
  assert.deepEqual(strokePts(twice)[1][0], [0, 0]);
  assert.deepEqual(strokePts(twice), minus(strokePts(once), { x: p2.s, y: p2.t }));
});

test('rebaseOrigin: offsetMm を持たない Anchor にもキーが付き、値は 基準の offset − P', async () => {
  const { form } = await twoRectForm();
  const plain = { ...form, anchors: form.anchors.map(a => ({ datumId: a.datumId, strokeId: a.strokeId, vertexIndex: a.vertexIndex })) };
  const moved = rebaseOrigin(plain, { s: 30, t: -12 });
  for (const a of moved.anchors) {
    const axis = plain.datums.find(d => d.id === a.datumId).axis;
    assert.equal(a.offsetMm, 0 - (axis === 's' ? 30 : -12), axis);
  }
});

test('rebaseOrigin: end の Anchor と stretch を持つ図でも fit の形（伸縮の長さ）は不変で、全点が一定量だけ平行移動する（origin と end の両方をずらす）', () => {
  const form = formFromEntry(stretchFigure());
  const T = { datums: { ds0: 0, dt0: 0, dt1: 70 } };
  const fit = f => fitDetailFigure(entryFromForm(f), T);
  const before = fit(form);
  assert.equal(before.error, undefined);
  const P = { s: 7, t: 9 };
  const moved = rebaseOrigin(form, P);
  const after = fit(moved);
  assert.equal(after.error, undefined);
  const len = r => r.strokes[0].points[3].t - r.strokes[0].points[2].t;
  assert.equal(len(after), len(before), '伸縮長が不変');
  const d0 = { s: after.strokes[0].points[0].s - before.strokes[0].points[0].s, t: after.strokes[0].points[0].t - before.strokes[0].points[0].t };
  after.strokes[0].points.forEach((p, i) => {
    assert.equal(p.s - before.strokes[0].points[i].s, d0.s, `s ${i}`);
    assert.equal(p.t - before.strokes[0].points[i].t, d0.t, `t ${i}`);
  });
  // 対: origin だけずらす（end を除く）と伸縮長が変わる
  const originOnly = { ...moved, anchors: moved.anchors.map((a, i) => (a.datumId === 'dt1' ? form.anchors[i] : a)) };
  assert.notEqual(len(fit(originOnly)), len(before));
  // end の Anchor に origin と同じ量が足されている
  const off = id => moved.anchors.find(a => a.datumId === id).offsetMm;
  assert.equal(off('dt1'), off('dt0'));
});

test('rebaseOrigin: 基準の見つからない Anchor・origin の無い軸は触らない（同じオブジェクトのまま）', async () => {
  const { form } = await twoRectForm();
  const orphan = { datumId: 'nothing', strokeId: 's1', vertexIndex: 0 };
  const moved = rebaseOrigin({ ...form, anchors: [...form.anchors, orphan] }, { s: 1, t: 2 });
  assert.equal(moved.anchors[moved.anchors.length - 1], orphan);
  const noT = { ...form, datums: form.datums.filter(d => d.axis !== 't'), anchors: form.anchors.filter(a => form.datums.find(d => d.id === a.datumId).axis !== 't') };
  const movedNoT = rebaseOrigin(noT, { s: 1, t: 2 });
  assert.deepEqual(movedNoT.anchors.map(a => a.offsetMm), noT.anchors.map(a => a.offsetMm - 1));
});

test('【失敗系】rebaseOrigin: P が有限でなければ RangeError（form は触らない）', async () => {
  const { form } = await twoRectForm();
  const snapshot = JSON.stringify(form);
  for (const bad of [{ s: NaN, t: 0 }, { s: 0, t: Infinity }, { s: 0 }, null, undefined, { s: '1', t: 2 }]) {
    assert.throws(() => rebaseOrigin(form, bad), RangeError, JSON.stringify(bad));
  }
  assert.equal(JSON.stringify(form), snapshot);
});

test('rebaseOrigin の結果を履歴に積むと、1 手戻すで anchors が元の値に戻る', async () => {
  const { form } = await twoRectForm();
  const original = JSON.parse(JSON.stringify(form.anchors));
  const next = rebaseOrigin(form, { s: 10, t: -5 });
  assert.notDeepEqual(next.anchors, original);
  const r = undoDraft(pushHistory([], form));
  assert.deepEqual(r.form.anchors, original);
  assert.notDeepEqual(next.anchors, r.form.anchors);
});

// origin の Datum.offsetMm が 0 でない図: ds0=25・dt0=10・（end）dt1=40
const offsetFigureForm = () => {
  const fig = stretchFigure();
  const off = { ds0: 25, dt0: 10, dt1: 40 };
  return formFromEntry({ ...fig, datums: fig.datums.map(d => ({ ...d, offsetMm: off[d.id] })) });
};

test('rebaseOrigin: origin の Datum.offsetMm が 0 でない図では P がその基準線に来る', () => {
  const form = offsetFigureForm();
  const before = strokePts(form);
  assert.deepEqual(before[0][2], [45, 20]);
  const moved = rebaseOrigin(form, { s: 45, t: 20 });
  assert.deepEqual(strokePts(moved)[0][2], [25, 10]);
  assert.deepEqual(strokePts(moved), minus(before, { x: 20, y: 10 }));
  // 対: 基準の offset を無視した Δ＝−P では別の場所へ行く（この判定が偽になる）
  const ignoring = { ...form, anchors: form.anchors.map(a => ({ ...a, offsetMm: -(form.datums.find(d => d.id === a.datumId).axis === 's' ? 45 : 20) })) };
  assert.notDeepEqual(strokePts(ignoring)[0][2], [25, 10]);
});

test('rebaseOrigin: origin と end の Datum offset が違っても伸縮長は不変（end には origin の Δ）', () => {
  const form = offsetFigureForm();
  const T = { datums: { ds0: 0, dt0: 0, dt1: 70 } };
  const fit = f => fitDetailFigure(entryFromForm(f), T);
  const len = r => r.strokes[0].points[3].t - r.strokes[0].points[2].t;
  const before = fit(form);
  assert.equal(before.error, undefined);
  assert.equal(len(before), 80);
  const moved = rebaseOrigin(form, { s: 45, t: 20 });
  assert.equal(len(fit(moved)), 80);
  const off = id => moved.anchors.find(a => a.datumId === id).offsetMm;
  assert.equal(off('dt0'), -10);
  assert.equal(off('dt1'), -10);
  // 対: end に「自分の offset − P」（40 − 20 = 20）を入れると伸縮長が変わる
  const own = { ...moved, anchors: moved.anchors.map(a => (a.datumId === 'dt1' ? { ...a, offsetMm: 20 } : a)) };
  assert.notEqual(len(fit(own)), 80);
});

test('rebaseOrigin: origin の offset 欄が数でない（入力途中の空欄）なら 0 として扱う＝Δ は −P', () => {
  const form = offsetFigureForm();
  const blank = { ...form, datums: form.datums.map(d => (d.id === 'dt0' ? { ...d, offset: '' } : d)) };
  assert.equal(rebaseDelta(blank, { s: 45, t: 20 }).t, -20);
  assert.equal(rebaseDelta(blank, { s: 45, t: 20 }).s, 25 - 45);
});

test('rebaseOrigin: どの Anchor も変わらないなら同じ form（参照）を返す＝edit が無効な履歴を積まない', async () => {
  const { form } = await twoRectForm();
  const noOrigin = { ...form, datums: form.datums.filter(d => d.kind !== 'origin'), anchors: [] };
  assert.equal(rebaseOrigin(noOrigin, { s: 1, t: 2 }), noOrigin);
  assert.deepEqual(rebaseDelta(noOrigin, { s: 1, t: 2 }), {});
  assert.notEqual(rebaseOrigin(form, { s: 1, t: 2 }), form);
});

// ---- 純関数（pick）----
test('previewVertexPoints: guide でない polyline の頂点だけ（text・dim・基準線は除く）', async () => {
  const { form } = await twoRectForm();
  const prims = previewPrimitivesOf(form);
  assert.ok(prims.some(p => p.guide), '基準線が出ている前提');
  const pts = previewVertexPoints(prims);
  const expected = strokePts(form).flat().length;
  assert.equal(pts.length, expected);
  assert.deepEqual(pts[0], { x: strokePts(form)[0][0][0], y: strokePts(form)[0][0][1] });
  assert.equal(pts.length < prims.reduce((n, p) => n + (p.points?.length ?? 0), 0), true, '基準線の頂点は含まない');
});

test('【失敗系】previewVertexPoints: 空・未指定は []', () => {
  assert.deepEqual(previewVertexPoints([]), []);
  assert.deepEqual(previewVertexPoints(undefined), []);
  assert.deepEqual(previewVertexPoints([{ type: SvgFigurePrimitiveType.TEXT, x: 0, y: 0, text: 'a' }]), []);
});

test('nearestPointWithin: 最も近い点・同距離は先勝ち・境界を含む', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 2, y: 0 }];
  assert.deepEqual(nearestPointWithin(pts, { x: 3, y: 0 }, 5), { x: 2, y: 0 });
  assert.deepEqual(nearestPointWithin(pts, { x: 5, y: 0 }, 5), { x: 2, y: 0 }, '0 と 10 は距離 5、2 は距離 3');
  assert.deepEqual(nearestPointWithin([{ x: -1, y: 0 }, { x: 1, y: 0 }], { x: 0, y: 0 }, 1), { x: -1, y: 0 }, '同距離は先勝ち');
  assert.deepEqual(nearestPointWithin(pts, { x: 0, y: 4 }, 4), { x: 0, y: 0 }, '半径ちょうどは含む');
});

test('【失敗系】nearestPointWithin: 空配列・範囲外・半径 0（一致しない）・非有限は null', () => {
  assert.equal(nearestPointWithin([], { x: 0, y: 0 }, 10), null);
  assert.equal(nearestPointWithin(undefined, { x: 0, y: 0 }, 10), null);
  assert.equal(nearestPointWithin([{ x: 100, y: 0 }], { x: 0, y: 0 }, 10), null);
  assert.equal(nearestPointWithin([{ x: 1, y: 0 }], { x: 0, y: 0 }, 0), null);
  assert.deepEqual(nearestPointWithin([{ x: 0, y: 0 }], { x: 0, y: 0 }, 0), { x: 0, y: 0 }, '半径 0 でも一致点は拾う');
  assert.equal(nearestPointWithin([{ x: 0, y: 0 }], { x: NaN, y: 0 }, 10), null);
  assert.equal(nearestPointWithin([{ x: 0, y: 0 }], { x: 0, y: 0 }, NaN), null);
  assert.equal(nearestPointWithin([{ x: 0, y: 0 }], null, 10), null);
});

test('DETAIL_BASE_SNAP_PX は snap.js の SNAP_THRESHOLD_PX と同値（snap.js は import せずソースを読む）', () => {
  const m = /export const SNAP_THRESHOLD_PX = (\d+);/.exec(fs.readFileSync(path.join(import.meta.dirname, '..', 'snap.js'), 'utf8'));
  assert.ok(m, 'snap.js に SNAP_THRESHOLD_PX が見つからない');
  assert.equal(DETAIL_BASE_SNAP_PX, Number(m[1]));
});

test('draftViewOfImport: 中心から P を引き、縮尺は引き継ぐ。全体（null）は null', () => {
  assert.deepEqual(draftViewOfImport({ scale: 4, cx: 150, cy: 80 }, { s: 100, t: 30 }), { scale: 4, cx: 50, cy: 50 });
  assert.equal(draftViewOfImport(null, { s: 1, t: 1 }), null);
});

test('draftViewOfImport: 図読込みのプレビューの実座標が、写した下書きの同じ頂点に対応する', async () => {
  const { form, basePoint, dxf } = await twoRectForm();
  // 図読込みのプレビュー（選択成分）の 2 本目の先頭点 Q ＝ 下書きの 2 本目のストロークの頂点 0
  const importPolys = dxfPreviewPrimitives(dxf).filter(p => p.points);
  assert.equal(importPolys.length, 2);
  const Q = { s: importPolys[1].points[0][0], t: importPolys[1].points[0][1] };
  const v = draftViewOfImport({ scale: 2, cx: Q.s, cy: Q.t }, basePoint);
  assert.deepEqual([v.cx, v.cy], strokePts(form)[1][0]);
  assert.equal(bindView(form.key, v).owner, form.key);
  assert.deepEqual(activeView(bindView(form.key, v), form.key), v);
  assert.equal(activeView(bindView(form.key, v), 'other'), null);
});

// ---- 配線（detailHelperGestureWiring.test.js と同型）----
const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');
const panelSrc = () => readSrc('ui/DetailHelperPanel.jsx').replace(/\r\n/g, '\n').replace(/^\s*\/\/.*$/gm, '');

const baseButton = src => /\{!showDxf && \(\s*<button className=\{`dthlp-btn\$\{basePointMode \? ' dthlp-btn--active' : ''\}`\} aria-pressed=\{basePointMode\} disabled=\{!basePointMode && !canBasePoint\}/.test(src)
  && /\{DETAIL_HELPER_TEXT\.basePoint\}/.test(src);
const canBasePointCond = src => /const canBasePoint = !showDxf && !fitOn && !doc\.readOnly && !busy && shownPrims\.length > 0;/.test(src)
  && /const basePointMode = basePointFor === form\.key && canBasePoint;/.test(src);
const tapHandlerViaEdit = src => /function handleBasePoint\(p\) \{\s*if \(!p\) \{ setBasePointMiss\(true\); return; \}\s*const point = \{ s: p\.x, t: p\.y \};\s*edit\(f => rebaseOrigin\(f, point\)\);/.test(src)
  && /const delta = rebaseDelta\(form, point\);\s*setShownView\(\{ \.\.\.shownView, cx: shownView\.cx \+ \(delta\.s \?\? 0\), cy: shownView\.cy \+ \(delta\.t \?\? 0\) \}\);/.test(src);
const layerArmedByMode = src => /\$\{basePointMode \? ' dthlp-pick-layer--armed' : ''\}/.test(src);
const fitOnClearsMode = src => /onClick=\{\(\) => \{ setFitOn\(true\); setBasePointFor\(null\); \}\}/.test(src);
const layerTap = src => /g\.kind === 'press' && basePointMode && isTapDistance\(Math\.hypot\(e\.clientX - g\.from\.clientX, e\.clientY - g\.from\.clientY\)\)/.test(src)
  && /onBasePoint\(nearestPointWithin\(vertexPoints, figurePointToMm\(e, g\.rect, g\.t\), DETAIL_BASE_SNAP_PX \/ g\.t\.scale\)\)/.test(src);
const copyKeepsView = src => /setDraftView\(bindView\(r\.form\.key, draftViewOfImport\(shownView, r\.basePoint\)\)\);/.test(src);
const layerGetsProps = src => /basePointMode=\{basePointMode\} vertexPoints=\{vertexPoints\} onBasePoint=\{handleBasePoint\}/.test(src);

test('【配線】［基準点を指す］はペン入力タブだけ・disabled は試し込み中／読み取り専用／busy／図なし・文言は文言表', () => {
  const src = panelSrc();
  assert.ok(baseButton(src));
  assert.ok(canBasePointCond(src));
  assert.ok(layerGetsProps(src));
  for (const key of ['basePoint', 'basePointHint', 'basePointMiss']) {
    assert.ok(DETAIL_HELPER_TEXT[key].length > 0, key);
    assert.equal(src.includes(DETAIL_HELPER_TEXT[key]), false, `${key} を直書きしない`);
  }
});

test('【配線】タップ: basePointMode のタップで onBasePoint（スナップ半径は px/縮尺）→ 見つかれば rebaseOrigin を edit 経由（undo に乗る）・範囲外は文言でモード維持', () => {
  const src = panelSrc();
  assert.ok(layerTap(src));
  assert.ok(tapHandlerViaEdit(src));
  assert.ok(layerArmedByMode(src));
  assert.ok(fitOnClearsMode(src));
  assert.match(src, /\{basePointMode && <span className="dthlp-hint">\{basePointMiss \? DETAIL_HELPER_TEXT\.basePointMiss : DETAIL_HELPER_TEXT\.basePointHint\}<\/span>\}/);
});

test('【配線】下書きへ写す直後の draftView は importView（shownView）から P を引いた値で下書きの key に結び付く', () => {
  assert.ok(copyKeepsView(panelSrc()));
});

test('【検出力】配線の判定は壊した文字列で偽になる', () => {
  const src = panelSrc();
  assert.equal(baseButton(src.replace('{!showDxf && (\n              <button className={`dthlp-btn${basePointMode', '{(\n              <button className={`dthlp-btn${basePointMode')), false);
  assert.equal(canBasePointCond(src.replace('!fitOn && ', '')), false);
  assert.equal(canBasePointCond(src.replace('!doc.readOnly && ', '')), false);
  assert.equal(canBasePointCond(src.replace('basePointFor === form.key && canBasePoint', 'basePointFor === form.key')), false);
  assert.equal(tapHandlerViaEdit(src.replace('edit(f => rebaseOrigin(', 'setDoc(f => rebaseOrigin(')), false);
  assert.equal(tapHandlerViaEdit(src.replace('if (!p) { setBasePointMiss(true); return; }', '')), false);
  assert.equal(tapHandlerViaEdit(src.replace('cx: shownView.cx + (delta.s ?? 0)', 'cx: shownView.cx')), false);
  assert.equal(layerArmedByMode(src.replace("${basePointMode ? ' dthlp-pick-layer--armed' : ''}", '')), false);
  assert.equal(fitOnClearsMode(src.replace('setBasePointFor(null); ', '')), false);
  assert.equal(layerTap(src.replace('DETAIL_BASE_SNAP_PX / g.t.scale', '0')), false);
  assert.equal(layerTap(src.replace('g.kind === \'press\' && basePointMode', 'g.kind === \'press\'')), false);
  assert.equal(copyKeepsView(src.replace('draftViewOfImport(shownView, r.basePoint)', 'shownView')), false);
});
