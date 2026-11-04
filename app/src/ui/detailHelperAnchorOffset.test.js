// Anchor.offsetMm（S7d-3）の ui 側: draftFromDxf が位置関係を保つ・setAnchor が位置を保つ・fittedDatums の差し引き・往復。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  loadDxf, toggleDxfComponent, draftFromDxf, previewPrimitivesOf, setAnchor, entryFromForm, formFromEntry, validation,
} from './detailHelperForm.js';
import { sha256HexWith } from '../detail/dxf/dxfProvenance.js';
import { SvgFigurePrimitiveType, DetailDatumKind } from '../core/constants.js';
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
const loadBody = async body => {
  const r = await loadDxf({ bytes: bytesOf(body), fileName: 'o.dxf', digest });
  assert.equal(r.ok, true, r.message);
  return r.dxf;
};
const pick = (dxf, ...idx) => idx.reduce((d, i) => toggleDxfComponent(d, i), dxf);
// 位置の違う矩形 2 つ（左下 (0,0) 100×50 と 左下 (300,100) 60×40）
const TWO = [...rect(0, 0, 100, 50), ...rect(300, 100, 60, 40)];

const polylines = prims => prims.filter(p => p.type === SvgFigurePrimitiveType.POLYLINE && p.strokeId);
const vertex0Of = (form, strokeId) => polylines(previewPrimitivesOf(form)).find(p => p.strokeId === strokeId).points[0];

test('draftFromDxf: 複数成分でもプレビューの頂点 0 は start − P に厳密一致。P は bbox 合併の左下で basePoint として返る', async () => {
  const dxf = pick(await loadBody(TWO), 0, 1);
  const comps = dxf.scene.components;
  assert.equal(comps.length, 2);
  const { form, basePoint, error } = draftFromDxf({ dxf, idFactory: ids });
  assert.equal(error, undefined);
  const P = {
    s: Math.min(...comps.map(c => c.bbox.minS)),
    t: Math.max(...comps.map(c => c.bbox.maxT)),
  };
  assert.deepEqual(basePoint, P);
  const drawn = comps.flatMap(c => c.strokes);
  assert.equal(form.strokes.length, drawn.length);
  form.strokes.forEach((st, i) => {
    assert.deepEqual(vertex0Of(form, st.id), [drawn[i].start.s - P.s, drawn[i].start.t - P.t], st.id);
  });
  // 2 つの成分は離れている＝頂点 0 が同じ点に重ならない
  assert.notDeepEqual(vertex0Of(form, 's1'), vertex0Of(form, 's2'));
  assert.equal(validation(form).ok, true);
  // 全 Anchor が offsetMm（0 でも）を数値で持つ
  assert.ok(form.anchors.every(a => typeof a.offsetMm === 'number' && Number.isFinite(a.offsetMm)));
});

test('draftFromDxf: 成分 1 つなら offsetMm は s で 0 以上・t で 0 以下（P が左下なので）。左下が頂点 0 の成分では 0', async () => {
  const dxf = pick(await loadBody(TWO), 1);
  const { form, basePoint } = draftFromDxf({ dxf, idFactory: ids });
  const c = dxf.scene.components[1];
  assert.deepEqual(basePoint, { s: c.bbox.minS, t: c.bbox.maxT });
  const byDatum = Object.fromEntries(form.datums.filter(d => d.kind === DetailDatumKind.ORIGIN).map(d => [d.axis, d.id]));
  const off = axis => form.anchors.find(a => a.datumId === byDatum[axis]).offsetMm;
  assert.ok(off('s') >= 0);
  assert.ok(off('t') <= 0);
  const start = c.strokes[0].start;
  assert.equal(off('s'), start.s - basePoint.s);
  assert.equal(off('t'), start.t - basePoint.t);
});

test('draftFromDxf: 左下（minS, maxT）から始まる成分では両軸とも offsetMm が 0', async () => {
  // どの矩形が左下始まりかは取り込みの向きで決まる＝成分の頂点 0 が左下のものを探す（無ければ失敗させる）
  const dxf = await loadBody([...rect(0, 0, 100, 50), ...rect(300, 100, 60, 40)]);
  const idx = dxf.scene.components.findIndex(c => c.strokes[0].start.s === c.bbox.minS && c.strokes[0].start.t === c.bbox.maxT);
  assert.ok(idx >= 0, '左下から始まる成分が見つからない');
  const { form } = draftFromDxf({ dxf: pick(dxf, idx), idFactory: ids });
  assert.deepEqual(form.anchors.map(a => a.offsetMm), [0, 0]);
  // 対: 離れた 2 成分を一緒に選ぶと、P から離れた側の成分の offset は 0 でない（0 固定の実装では偽）
  const both = draftFromDxf({ dxf: pick(dxf, 0, 1), idFactory: ids }).form;
  assert.ok(both.anchors.some(a => a.offsetMm !== 0));
});

test('【失敗系】draftFromDxf: 何も選ばなければ error（basePoint なし）', async () => {
  const r = draftFromDxf({ dxf: await loadBody(TWO), idFactory: ids });
  assert.ok(r.error);
  assert.equal(r.basePoint, undefined);
});

test('往復: entryFromForm→formFromEntry で Anchor.offsetMm が残る', async () => {
  const { form } = draftFromDxf({ dxf: pick(await loadBody(TWO), 0, 1), idFactory: ids });
  const entry = entryFromForm(form);
  assert.deepEqual(entry.anchors, form.anchors);
  assert.deepEqual(formFromEntry(entry).anchors, form.anchors);
});

// ---- setAnchor ----
async function rectForm() {
  const { form } = draftFromDxf({ dxf: pick(await loadBody(rect(10, 20, 100, 50)), 0), idFactory: ids });
  return form;
}
const datumIdOf = (form, axis) => form.datums.find(d => d.kind === DetailDatumKind.ORIGIN && d.axis === axis).id;
const allPts = form => polylines(previewPrimitivesOf(form)).map(p => p.points);

test('setAnchor: offsetMm 持ちで頂点を変えても図の位置が保たれる（両軸）', async () => {
  const form = await rectForm();
  const before = allPts(form);
  const ds = datumIdOf(form, 's');
  const dt = datumIdOf(form, 't');
  const moved = setAnchor(setAnchor(form, 's1', ds, 1), 's1', dt, 2);
  assert.equal(moved.anchors.find(a => a.datumId === ds).vertexIndex, 1);
  assert.deepEqual(allPts(moved), before);
  assert.notEqual(moved.anchors.find(a => a.datumId === ds).offsetMm, form.anchors.find(a => a.datumId === ds).offsetMm);
  // 戻しても元と同じ
  assert.deepEqual(allPts(setAnchor(moved, 's1', ds, 0)), before);
});

test('setAnchor: offsetMm を持たない Anchor は従来どおり（キーを足さない・頂点だけ変わる）', async () => {
  const form = await rectForm();
  const plain = { ...form, anchors: form.anchors.map(a => ({ datumId: a.datumId, strokeId: a.strokeId, vertexIndex: a.vertexIndex })) };
  const ds = datumIdOf(plain, 's');
  const next = setAnchor(plain, 's1', ds, 1);
  const a = next.anchors.find(x => x.datumId === ds);
  assert.deepEqual(a, { datumId: ds, strokeId: 's1', vertexIndex: 1 });
  assert.equal(Object.hasOwn(a, 'offsetMm'), false);
});

test('setAnchor: 歩けない（長さが読めない）ときは offsetMm をそのまま引き継ぐ。外す（null）と Anchor は消える', async () => {
  const form = await rectForm();
  const ds = datumIdOf(form, 's');
  const broken = { ...form, strokes: form.strokes.map(s => ({ ...s, moves: s.moves.map((m, i) => (i === 0 ? { ...m, len: 'abc' } : m)) })) };
  const old = broken.anchors.find(a => a.datumId === ds).offsetMm;
  const next = setAnchor(broken, 's1', ds, 1);
  assert.equal(next.anchors.find(a => a.datumId === ds).offsetMm, old);
  assert.equal(setAnchor(form, 's1', ds, null).anchors.some(a => a.datumId === ds), false);
});

// ---- end の Anchor を持つ図（stretchFigure）の fit が setAnchor で変わらない ----
const T = { datums: { ds0: 0, dt0: 0, dt1: 70 } };
const stretchForm = offsets => formFromEntry({
  ...stretchFigure(),
  anchors: stretchFigure().anchors.map(a => (a.datumId in offsets ? { ...a, offsetMm: offsets[a.datumId] } : a)),
});
const fitOf = form => fitDetailFigure(entryFromForm(form), T);
const withAnchorOffset = (form, datumId, vertexIndex, offsetMm) => ({
  ...form, anchors: form.anchors.map(a => (a.datumId === datumId ? { ...a, vertexIndex, offsetMm } : a)),
});

test('setAnchor: end の Anchor を持つストロークで origin の頂点を変えても fit の点列が不変', () => {
  const form = stretchForm({ dt0: 5, dt1: 0 });
  const before = fitOf(form);
  assert.equal(before.error, undefined);
  const moved = setAnchor(form, 'a', 'dt0', 2);
  assert.equal(moved.anchors.find(a => a.datumId === 'dt0').offsetMm, 15, '5 + (10 − 0)');
  assert.deepEqual(fitOf(moved), before);
  // 対: 符号を逆にした値（5 − 10）では点列が変わる
  assert.notDeepEqual(fitOf(withAnchorOffset(form, 'dt0', 2, -5)), before);
});

test('setAnchor: offsetMm 持ちの end の Anchor の頂点を変えても伸縮長が不変', () => {
  const form = stretchForm({ dt0: 5, dt1: 10 });
  const stretchLen = r => r.strokes[0].points[3].t - r.strokes[0].points[2].t;
  const before = fitOf(form);
  assert.equal(stretchLen(before), 55);
  const moved = setAnchor(form, 'a', 'dt1', 3);
  assert.equal(moved.anchors.find(a => a.datumId === 'dt1').offsetMm, 0, '10 + (60 − 70)');
  assert.equal(stretchLen(fitOf(moved)), 55);
  assert.deepEqual(fitOf(moved), before);
  // 対: offset を引き継ぐだけ（10 のまま）だと伸縮長が変わる
  assert.notEqual(stretchLen(fitOf(withAnchorOffset(form, 'dt1', 3, 10))), 55);
});

test('fittedDatums: 試し込み後の基準線は 頂点 − Anchor.offsetMm の位置（頂点そのものではない）', async () => {
  const form = await rectForm();
  const ds = datumIdOf(form, 's');
  const off = form.anchors.find(a => a.datumId === ds).offsetMm;
  const withOff = { ...form, anchors: form.anchors.map(a => (a.datumId === ds ? { ...a, offsetMm: 25 } : a)) };
  // 頂点 0 の s が 125 に来た試し込み結果（形は何でもよい。基準線の位置だけを見る）
  const fitted = { strokes: [{ id: 's1', points: [{ s: 125, t: 7 }, { s: 225, t: 7 }, { s: 225, t: 57 }, { s: 125, t: 57 }], closed: true, line: {} }], warnings: [] };
  const guides = previewPrimitivesOf(withOff, fitted).filter(p => p.guide && p.type === SvgFigurePrimitiveType.POLYLINE);
  const vertical = guides.find(g => g.points[0][0] === g.points[1][0]);
  assert.equal(vertical.points[0][0], 100, '125 − 25');
  assert.equal(typeof off, 'number');
});
