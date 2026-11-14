// 「図面の原点を基準点にして写す」（H1）: draftFromDxf の atDrawingOrigin（純関数）と、チェック欄の配線（ソース走査）。
// scene の座標は s = x·単位係数・t = −y·単位係数 で平行移動が無い＝図面の原点は常に scene の (0,0)（detail/dxf/dxfEntities.js toFig）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  draftFromDxf, previewPrimitivesOf, setClassification, tryFit, validation, entryFromForm,
  setDxfUnit, DETAIL_HELPER_TEXT, DETAIL_HELPER_MESSAGES, dxfLayerRows, toggleDxfLayer,
} from './detailHelperForm.js';
import { loadPdf, setPdfPageView, setPdfClip, setPdfScale, extractPdf } from './detailHelperPdf.js';
import {
  dxfRect as rect, dxfDigest as digest, fixedId as ids, loadDxfBody as loadBody, pickDxfComponents as pick,
} from './detailHelperDxfTestFixtures.js';
import { validateDetailFigure } from '../detail/detailModel.js';
import { fitLocal } from '../detail/detailPlacement.js';
import { placedFigureTargets } from '../finish/placedFigure/placedFigureTargets.js';
import { SvgFigurePrimitiveType, DetailCategory, DetailView, DetailSubject, PdfDrawOp } from '../core/constants.js';
import { stripCommentsKeepStrings as stripComments, extractBodyAfterParams, topLevelBlock } from '../uiBusySourceScan.js';

const polylines = prims => prims.filter(p => p.type === SvgFigurePrimitiveType.POLYLINE && p.strokeId);
const vertex0Of = (form, strokeId) => polylines(previewPrimitivesOf(form)).find(p => p.strokeId === strokeId).points[0];
// 原点から離した 2 つの矩形（原点に頂点なし。第 1 象限寄りと第 4 象限寄り）
const FAR = [...rect(100, 200, 100, 50), ...rect(400, -90, 60, 40)];
const originAnchors = form => form.anchors.map(a => a.offsetMm);

test('atDrawingOrigin: 各 Anchor の offsetMm＝ストロークの start・basePoint＝(0,0)・プレビューの頂点 0 は scene の座標に一致', async () => {
  const dxf = pick(await loadBody(FAR), 0, 1);
  const { form, basePoint, error } = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: true });
  assert.equal(error, undefined);
  assert.deepEqual(basePoint, { s: 0, t: 0 });
  const drawn = dxf.scene.components.flatMap(c => c.strokes);
  assert.equal(form.strokes.length, drawn.length);
  form.strokes.forEach((st, i) => {
    assert.deepEqual(vertex0Of(form, st.id), [drawn[i].start.s, drawn[i].start.t], st.id);
  });
  // 基準ごと（s→start.s・t→start.t）の offsetMm
  const sets = form.strokes.map(st => form.anchors.filter(a => a.strokeId === st.id).map(a => a.offsetMm).sort((a, b) => a - b));
  const want = drawn.map(d => [d.start.s, d.start.t].sort((a, b) => a - b));
  assert.deepEqual(sets, want);
  assert.equal(validation(form).ok, true);
  // 左下基準の既定とは別の値になっている（検出力: 原点に頂点が無い図面）
  const off = draftFromDxf({ dxf, idFactory: ids });
  assert.notDeepEqual(originAnchors(off.form), originAnchors(form));
});

test('atDrawingOrigin: false・省略は従来どおり外接の左下', async () => {
  const dxf = pick(await loadBody(FAR), 0, 1);
  const comps = dxf.scene.components;
  const P = { s: Math.min(...comps.map(c => c.bbox.minS)), t: Math.max(...comps.map(c => c.bbox.maxT)) };
  const omitted = draftFromDxf({ dxf, idFactory: ids });
  const explicit = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: false });
  assert.deepEqual(omitted.basePoint, P);
  assert.deepEqual(explicit.basePoint, P);
  assert.equal(JSON.stringify(explicit.form), JSON.stringify(omitted.form));
});

test('atDrawingOrigin: 単位係数を変えると座標は倍になり、原点は (0,0) のまま', async () => {
  const dxf = pick(await loadBody(FAR), 0, 1);
  const doubled = setDxfUnit(dxf, '2');
  assert.equal(doubled.error, null);
  const d2 = pick(doubled.dxf, 0, 1);
  const r1 = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: true });
  const r2 = draftFromDxf({ dxf: d2, idFactory: ids, atDrawingOrigin: true });
  assert.deepEqual(r2.basePoint, { s: 0, t: 0 });
  const factor = d2.scene.unitFactor / dxf.scene.unitFactor;
  assert.notEqual(factor, 1);
  const a1 = r1.form.strokes.map(st => vertex0Of(r1.form, st.id));
  const a2 = r2.form.strokes.map(st => vertex0Of(r2.form, st.id));
  assert.deepEqual(a2, a1.map(([s, t]) => [s * factor, t * factor]));
});

test('atDrawingOrigin: レイヤを off にしても残る成分の座標と原点はずれない', async () => {
  const dxf = await loadBody([...rect(100, 200, 100, 50, 'A'), ...rect(400, -90, 60, 40, 'B')]);
  const before = pick(dxf, 0, 1);
  const layerB = dxfLayerRows(dxf).find(r => r.name === 'B');
  assert.ok(layerB);
  const r = toggleDxfLayer(dxf, 'B');
  assert.equal(r.error, null);
  assert.equal(r.dxf.scene.components.length, 1);
  const after = pick(r.dxf, 0);
  const aBefore = draftFromDxf({ dxf: before, idFactory: ids, atDrawingOrigin: true });
  const aAfter = draftFromDxf({ dxf: after, idFactory: ids, atDrawingOrigin: true });
  assert.deepEqual(aAfter.basePoint, { s: 0, t: 0 });
  const start = after.scene.components[0].strokes[0].start;
  assert.deepEqual(vertex0Of(aAfter.form, 's1'), [start.s, start.t]);
  const drawnBefore = before.scene.components.flatMap(c => c.strokes);
  const idx = drawnBefore.findIndex(s => s.start.s === start.s && s.start.t === start.t);
  assert.ok(idx >= 0);
  assert.deepEqual(vertex0Of(aBefore.form, `s${idx + 1}`), [start.s, start.t]);
});

test('【失敗系】atDrawingOrigin: PDF 由来の状態に true が来ても外接の左下のまま／選択 0 件は従来のエラー', async () => {
  const OPS = { constructPath: 91, stroke: 20 };
  const { MOVE_TO: M, LINE_TO: L, CLOSE: Z } = PdfDrawOp;
  const page = {
    opList: { fnArray: [OPS.constructPath], argsArray: [[OPS.stroke, [[M, 30, 20, L, 130, 20, L, 130, 70, L, 30, 70, Z]], null]] },
    ops: OPS, view: [0, 0, 200, 100],
  };
  const loaded = await loadPdf({ bytes: new TextEncoder().encode('%PDF-1.7\nx'), fileName: 'a.pdf', digest, open: async () => ({ ok: true, doc: {}, pageCount: 1 }) });
  assert.equal(loaded.ok, true);
  const ready = setPdfScale(setPdfClip(setPdfPageView(loaded.pdf, page.view), { x: 0, y: 0, w: 200, h: 100 }), '6');
  const pdf = pick(extractPdf(ready, page).pdf, 0);
  const c = pdf.scene.components[0];
  const P = { s: c.bbox.minS, t: c.bbox.maxT };
  assert.notDeepEqual(P, { s: 0, t: 0 });
  assert.deepEqual(draftFromDxf({ dxf: pdf, idFactory: ids, atDrawingOrigin: true }).basePoint, P);
  assert.deepEqual(draftFromDxf({ dxf: pdf, idFactory: ids }).basePoint, P);
  // 選択 0 件
  const none = draftFromDxf({ dxf: await loadBody(FAR), idFactory: ids, atDrawingOrigin: true });
  assert.equal(none.error, DETAIL_HELPER_MESSAGES.dxfNothingSelected);
  assert.equal(none.basePoint, undefined);
});

test('【失敗系】atDrawingOrigin: true 以外（"yes"・1・null・undefined・"true"）は原点にしない（厳密に === true のときだけ）', async () => {
  const dxf = pick(await loadBody(FAR), 0, 1);
  const base = draftFromDxf({ dxf, idFactory: ids }).basePoint;
  for (const v of ['yes', 'true', 1, null, undefined, {}]) {
    assert.deepEqual(draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: v }).basePoint, base, String(v));
  }
});

test('fit まで通す: 原点で写した下書きを姿図・平面・衛生器具にすると検証と試し込みが通り、置いた線は 配置点＋scene の座標', async () => {
  const dxf = pick(await loadBody(FAR), 0, 1);
  const { form } = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: true });
  let f = setClassification(form, 'category', DetailCategory.FIGURE);
  f = setClassification(f, 'view', DetailView.PLAN);
  f = setClassification(f, 'subject', DetailSubject.SANITARY);
  const entry = entryFromForm(f);
  const v = validateDetailFigure(entry);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const t = placedFigureTargets(entry);
  assert.equal(t.error, undefined);
  const r = fitLocal(entry, t.targets);
  assert.equal(r.error, undefined);
  const viaForm = tryFit(f, {});
  assert.equal(viaForm.error, undefined);
  const drawn = dxf.scene.components.flatMap(c => c.strokes);
  r.strokes.forEach((st, i) => {
    assert.deepEqual([st.points[0].s, st.points[0].t], [drawn[i].start.s, drawn[i].start.t], `s${i + 1}`);
  });
  assert.equal(JSON.stringify(viaForm.strokes.map(s => s.points)), JSON.stringify(r.strokes.map(s => s.points)));
});

test('既知の限界: 原点が成分から遠いと、基準線を含むプレビューの範囲（図の外接）が原点を含むまで広がる', async () => {
  const dxf = pick(await loadBody(rect(5000, 5000, 100, 50)), 0);
  const prim = form => polylines(previewPrimitivesOf(form)).flatMap(p => p.points);
  const spanS = form => { const s = prim(form).map(p => p[0]); return Math.max(...s) - Math.min(...s); };
  // 図そのものの広がりは同じ（100）。原点基準では座標が原点から遠く離れる（描画の全体表示は基準線＝原点を含めて枠を決める）
  const { form: at } = draftFromDxf({ dxf, idFactory: ids, atDrawingOrigin: true });
  const { form: lb } = draftFromDxf({ dxf, idFactory: ids });
  assert.equal(spanS(at), 100);
  assert.equal(spanS(lb), 100);
  const first = form => prim(form)[0];
  assert.ok(Math.abs(first(at)[0]) >= 5000, '原点基準の頂点は原点から 5000 以上離れる');
  assert.ok(Math.abs(first(lb)[0]) <= 100, '左下基準では近い');
  // 基準線（guide）まで含めた範囲: 原点基準では基準線が原点に立つので範囲が 5000 超へ広がる（左下基準は図の近く）
  const extentS = form => {
    const s = previewPrimitivesOf(form).filter(p => p.type === SvgFigurePrimitiveType.POLYLINE).flatMap(p => p.points.map(q => q[0]));
    return Math.max(...s) - Math.min(...s);
  };
  assert.ok(extentS(at) >= 5000, `原点基準の範囲 ${extentS(at)}`);
  assert.ok(extentS(lb) < 1000, `左下基準の範囲 ${extentS(lb)}`);
});

// ---- 配線（ソース走査。コメントは除くが文字列リテラルは残す）----
const appSrc = path.resolve(import.meta.dirname, '..');
const readSrc = rel => fs.readFileSync(path.join(appSrc, rel), 'utf8');
const panel = () => stripComments(readSrc('ui/DetailHelperPanel.jsx'));
const count = (s, re) => (s.match(re) ?? []).length;

const checkboxGuarded = body => !!body
  && /\{onAtDrawingOrigin && \(\s*<label className="dthlp-layer-row">\s*<input type="checkbox" checked=\{atDrawingOrigin\} disabled=\{busy\} onChange=\{\(\) => onAtDrawingOrigin\(!atDrawingOrigin\)\} \/>\s*<span>\{DETAIL_HELPER_TEXT\.copyAtDrawingOrigin\}<\/span>\s*<\/label>\s*\)\}/.test(body);
const paneForwards = body => !!body
  && /atDrawingOrigin=\{atDrawingOrigin\} onAtDrawingOrigin=\{onAtDrawingOrigin\}/.test(body);
// 宣言の 1 行まるごと（行頭から行末）で照合する——文字列リテラルやコメントに残した呼び出しでは通らない
const copyPassesFlag = body => !!body
  && /^\s*const r = draftFromDxf\(\{ dxf: imported, idFactory: newKeyPart, atDrawingOrigin \}\);\s*$/m.test(body);
const initialFalse = src => /const \[atDrawingOrigin, setAtDrawingOrigin\] = useState\(false\);/.test(src);
const dxfPaneUse = src => src.slice(src.indexOf('<DxfPane'));
const pdfPaneUse = src => src.slice(src.indexOf('<PdfPane'), src.indexOf('<DxfPane'));

test('【配線】チェック欄は ImportResult の onAtDrawingOrigin があるときだけ・DxfPane が通し・パネルが DXF にだけ渡す・初期値 false・文言は表', () => {
  const src = panel();
  assert.ok(checkboxGuarded(topLevelBlock(src, 'function ImportResult(')));
  assert.ok(paneForwards(topLevelBlock(src, 'function DxfPane(')));
  assert.ok(/atDrawingOrigin=\{atDrawingOrigin\} onAtDrawingOrigin=\{setAtDrawingOrigin\}/.test(dxfPaneUse(src)));
  assert.ok(copyPassesFlag(extractBodyAfterParams(src, 'function handleDxfCopy(')));
  assert.ok(initialFalse(src));
  assert.equal(DETAIL_HELPER_TEXT.copyAtDrawingOrigin, '図面の原点を基準点にする');
});

test('【配線】PDF の経路には欄を出さない・渡さない（PdfPane の関数と呼び出しに atDrawingOrigin が出ない）', () => {
  const src = panel();
  assert.equal(count(topLevelBlock(src, 'function PdfPane('), /[aA]tDrawingOrigin/g), 0);
  assert.equal(count(pdfPaneUse(src), /[aA]tDrawingOrigin/g), 0);
  // ImportResult の PDF 側呼び出し（PdfPane 内）にも渡さない
  assert.equal(count(topLevelBlock(src, 'function PdfPane('), /<ImportResult[^>]*AtDrawingOrigin/g), 0);
});

test('【検出力】配線の判定は壊れた実装を落とし、コメント・文字列には反応しない', () => {
  const ok = '{onAtDrawingOrigin && (\n<label className="dthlp-layer-row">\n<input type="checkbox" checked={atDrawingOrigin} disabled={busy} onChange={() => onAtDrawingOrigin(!atDrawingOrigin)} />\n<span>{DETAIL_HELPER_TEXT.copyAtDrawingOrigin}</span>\n</label>\n)}';
  assert.equal(checkboxGuarded(ok), true);
  assert.equal(checkboxGuarded(ok.replace('onAtDrawingOrigin && (', 'true && (')), false);
  assert.equal(checkboxGuarded(ok.replace('{DETAIL_HELPER_TEXT.copyAtDrawingOrigin}', '図面の原点')), false);
  const call = '    const r = draftFromDxf({ dxf: imported, idFactory: newKeyPart, atDrawingOrigin });';
  const bare = '    const r = draftFromDxf({ dxf: imported, idFactory: newKeyPart });';
  assert.equal(copyPassesFlag(call), true);
  assert.equal(copyPassesFlag(`function handleDxfCopy() {\n${call}\n    if (r.error) return;\n}`), true);
  assert.equal(copyPassesFlag(bare), false);
  // 渡しをコメントへ退避した変異は、コメント除去後に落ちる
  assert.equal(copyPassesFlag(stripComments(`${bare} // const r = draftFromDxf({ dxf: imported, idFactory: newKeyPart, atDrawingOrigin });`)), false);
  assert.equal(copyPassesFlag(stripComments(`${bare} /* const r = draftFromDxf({ dxf: imported, idFactory: newKeyPart, atDrawingOrigin }); */`)), false);
  // 渡しを文字列リテラルへ退避した変異（同じ行・別の行とも）も落ちる
  assert.equal(copyPassesFlag(`${bare} const unusedWire = "draftFromDxf({ dxf: imported, idFactory: newKeyPart, atDrawingOrigin })";`), false);
  assert.equal(copyPassesFlag(`${bare}\n    const unusedWire = "const r = draftFromDxf({ dxf: imported, idFactory: newKeyPart, atDrawingOrigin });";`), false);
  assert.equal(initialFalse('const [atDrawingOrigin, setAtDrawingOrigin] = useState(false);'), true);
  assert.equal(initialFalse('const [atDrawingOrigin, setAtDrawingOrigin] = useState(true);'), false);
  assert.equal(paneForwards('atDrawingOrigin={atDrawingOrigin} onAtDrawingOrigin={onAtDrawingOrigin}'), true);
  assert.equal(paneForwards('atDrawingOrigin={atDrawingOrigin}'), false);
});
