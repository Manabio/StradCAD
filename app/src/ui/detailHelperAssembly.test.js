// ui/detailHelperFitting.js の C8（一式の全体プレビュー fittingAssemblyPrimitives・DXF／PDF の写し先 importIntoPart）のテスト。
// 期待値は C4 の手計算例（A＝0。W 1550・DW 800・穴 750／W 1750・DW 900・穴 850。壁厚 100）。プレビュー値と違う寸法（W 1750）でも確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DetailCategory, DetailView, DetailSubject, FittingPartRole, FITTING_PART_TARGETS, DETAIL_BUILTIN_FITTING_SLIDING_KEY,
  DETAIL_BUILTIN_DOOR_JAMB_KEY, DXF_PREVIEW_STYLE,
} from '../core/constants.js';
import { detailBuiltinFigures } from '../detail/detailPlacement.js';
import { fittingPartFigure } from '../detail/detailModel.js';
import { FITTING_PART_ROLE_TEXT } from '../catalog/catalogMaintenance.js';
import { DETAIL_HELPER_MESSAGES, DETAIL_HELPER_TEXT, formFromEntry, tryFit, newDraft, entryFromForm, setDashRole } from './detailHelperForm.js';
import {
  fittingDocFromEntry, selectFittingPart, removeFittingPart, newFittingDoc, importIntoPart, fittingEntryOf, isDocDirty,
  fittingAssemblyPrimitives, assemblyFitDims, ASSEMBLY_VIEW, ASSEMBLY_FIT_FORM, setFittingProvenanceField,
} from './detailHelperFitting.js';
import { buildDxfProvenance } from '../detail/dxf/dxfProvenance.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay, clearOverlays, composeCatalog } from '../catalog/catalogRegistry.js';
import { expandUsedDetailFiguresTransitively, reexpandTransitiveDetailFigures } from '../catalog/usedEntries.js';
import { emptyBundle, withEntries, bundleEntries } from '../catalog/catalogBundle.js';
import { DetailProvenanceSource, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD } from '../core/constants.js';

const R = FittingPartRole;
const SET = detailBuiltinFigures.find(e => e.key === DETAIL_BUILTIN_FITTING_SLIDING_KEY);
const DIMS_1550 = { wallThickness: '100', faceWidth: '30', projection: '12', width: '1550', doorWidth: '800', clearWidth: '750' };
const DIMS_1750 = { wallThickness: '100', faceWidth: '30', projection: '12', width: '1750', doorWidth: '900', clearWidth: '850' };
const lines = r => r.primitives.filter(p => !p.guide);
const guides = r => r.primitives.filter(p => p.guide);
const strokeOf = (r, color) => lines(r).filter(p => p.stroke === color).map(p => p.points);
const xs = pts => [Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0]))];

test('全体プレビュー（平面・W 1550）: 戸先側は 0・短い縦枠は穴の幅 750・端材は建具幅 1550 に並ぶ（C4 の手計算例）', () => {
  const r = fittingAssemblyPrimitives(fittingDocFromEntry(SET), DIMS_1550, { view: ASSEMBLY_VIEW.PLAN });
  assert.deepEqual(r.failures, []);
  const all = lines(r).map(p => p.points);
  assert.deepEqual(all, [
    [[750, 50], [750, 38], [780, 38], [780, 50], [780, 100], [780, 112], [750, 112]], // 短い縦枠（A+穴 750）
    [[1550, 0], [1550, -12], [1580, -12], [1580, 0], [1580, 50], [1550, 50]],          // 端材（A+W）
    [[1550, 5], [750, 5], [750, 35], [1550, 35]],                                       // 開けた扉
    [[0, -12], [-30, -12], [-30, 0], [-30, 100], [-30, 112], [0, 112]],                 // 戸先枠（A＝0）
    [[0, 5], [800, 5], [800, 35], [0, 35]],                                             // 閉じた扉
  ]);
});

test('全体プレビュー（平面・W 1750・プレビュー値と違う寸法）: 世界座標＝戸先枠 −30〜0・閉じた扉 0〜900・短い縦枠 850〜880・端材 1750〜1780・開けた扉 850〜1750', () => {
  const r = fittingAssemblyPrimitives(fittingDocFromEntry(SET), DIMS_1750, { view: ASSEMBLY_VIEW.PLAN });
  const [inner, tail, openDoor, latch, closedDoor] = lines(r).map(p => xs(p.points));
  assert.deepEqual(latch, [-30, 0]);
  assert.deepEqual(closedDoor, [0, 900]);
  assert.deepEqual(inner, [850, 880]);
  assert.deepEqual(tail, [1750, 1780]);
  assert.deepEqual(openDoor, [850, 1750]);
});

test('全体プレビュー: 開けた扉の破線は dash、他は実線。頂点番号（text）・寸法は出さない', () => {
  const r = fittingAssemblyPrimitives(fittingDocFromEntry(SET), DIMS_1550);
  assert.deepEqual(lines(r).map(p => p.dash ?? null), [null, null, 'dashed', null, null]);
  assert.equal(r.primitives.some(p => p.type === 'dim'), false);
  assert.deepEqual(r.primitives.filter(p => p.type === 'text').map(p => p.text), ['壁の仕上げ面', '壁の仕上げ面']); // 文脈 guide の名前だけ
  assert.ok(r.primitives.filter(p => p.type === 'text').every(p => p.guide === true));
});

test('全体プレビュー: 文脈 guide＝壁の面 t 0・壁厚 100 と欠き込みの底 t 50（s＝穴 750+見付 30 〜 建具幅 1550+見付 30）', () => {
  const g = guides(fittingAssemblyPrimitives(fittingDocFromEntry(SET), DIMS_1550)).filter(p => p.type === 'polyline').map(p => p.points);
  assert.deepEqual(g.map(p => p[0][1]), [0, 100, 50]);
  assert.deepEqual(g[2], [[780, 50], [1580, 50]]);
  const g2 = guides(fittingAssemblyPrimitives(fittingDocFromEntry(SET), DIMS_1750)).filter(p => p.type === 'polyline').map(p => p.points);
  assert.deepEqual(g2[2], [[880, 50], [1780, 50]]);
});

test('全体プレビュー: 選んでいる部品は強調・他は細線（部品を切り替えると強調が移る）', () => {
  const doc = fittingDocFromEntry(SET); // 先頭＝slideLatch
  const r0 = fittingAssemblyPrimitives(doc, DIMS_1550);
  assert.equal(strokeOf(r0, DXF_PREVIEW_STYLE.selected.stroke).length, 2, '戸先枠＋閉じた扉');
  assert.equal(strokeOf(r0, DXF_PREVIEW_STYLE.faint.stroke).length, 3);
  assert.ok(lines(r0).filter(p => p.stroke === DXF_PREVIEW_STYLE.selected.stroke).every(p => p.width === DXF_PREVIEW_STYLE.selected.width));
  const r2 = fittingAssemblyPrimitives(selectFittingPart(doc, 2), DIMS_1550); // slideTail
  assert.deepEqual(strokeOf(r2, DXF_PREVIEW_STYLE.selected.stroke).map(p => xs(p)), [[1550, 1580], [750, 1550]]);
  assert.equal(strokeOf(r2, DXF_PREVIEW_STYLE.faint.stroke).length, 3);
  // 強調は後から描く（他の線の上に重なる）
  assert.equal(lines(r2).at(-1).stroke, DXF_PREVIEW_STYLE.selected.stroke);
});

test('全体プレビュー（見上げ）: *Up の部品を先に使う（上レール t −12 が建具幅 W まで走る）。平面は *Up を描かない', () => {
  const doc = fittingDocFromEntry(SET);
  const up = fittingAssemblyPrimitives(doc, DIMS_1750, { view: ASSEMBLY_VIEW.UP });
  assert.deepEqual(up.failures, []);
  assert.ok(lines(up).some(p => p.points.length === 2 && p.points[0][1] === -12 && p.points[1][0] === 1750 && p.points[1][1] === -12), '上レール');
  const plan = fittingAssemblyPrimitives(doc, DIMS_1750, { view: ASSEMBLY_VIEW.PLAN });
  assert.equal(lines(plan).some(p => p.points.length === 2 && p.points[1][0] === 1750 && p.points[1][1] === -12), false);
  assert.notDeepEqual(lines(up).map(p => p.points), lines(plan).map(p => p.points));
});

test('全体プレビュー（見上げ）: *Up の無い部品は平面の部品へ落ちる（Up を全部消すと見上げ＝平面と同じ線）', () => {
  let doc = fittingDocFromEntry(SET);
  for (const role of [R.SLIDE_LATCH_UP, R.SLIDE_INNER_UP, R.SLIDE_TAIL_UP]) {
    doc = removeFittingPart(doc, doc.set.parts.findIndex(p => p.role === role));
  }
  const up = fittingAssemblyPrimitives(doc, DIMS_1750, { view: ASSEMBLY_VIEW.UP });
  const plan = fittingAssemblyPrimitives(doc, DIMS_1750, { view: ASSEMBLY_VIEW.PLAN });
  assert.equal(lines(up).length, 5);
  assert.deepEqual(lines(up).map(p => p.points), lines(plan).map(p => p.points));
});

test('全体プレビュー（失敗側）: fit できない部品はその部品だけ描かず文言を返す（壁厚 50 は slideInner が fit 不能）', () => {
  const r = fittingAssemblyPrimitives(fittingDocFromEntry(SET), { ...DIMS_1550, wallThickness: '50' });
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].role, R.SLIDE_INNER);
  assert.ok(r.failures[0].text.startsWith(`${FITTING_PART_ROLE_TEXT[R.SLIDE_INNER]}: `), r.failures[0].text);
  assert.ok(r.failures[0].text.endsWith('（全体では描きません）'));
  assert.equal(lines(r).length, 4, '他の 4 本は描く（縦枠の 1 本だけが消える）');
  assert.equal(lines(r).some(p => p.points.some(q => q[0] === 750 && q[1] === 38)), false, '縦枠の点は無い');
});

test('全体プレビュー（失敗側）: 寸法が読めないと全部品が失敗して線は 0 本・guide も出さない', () => {
  const r = fittingAssemblyPrimitives(fittingDocFromEntry(SET), { ...DIMS_1550, doorWidth: '' });
  assert.equal(lines(r).length, 0);
  assert.equal(r.primitives.length, 0);
  assert.equal(r.failures.length, 3);
  assert.deepEqual(r.failures.map(f => f.role), [R.SLIDE_LATCH, R.SLIDE_INNER, R.SLIDE_TAIL]);
});

test('全体プレビュー: 部品 0 個・一式でない doc は空（描くものが無い。例外にしない）', () => {
  const empty = fittingAssemblyPrimitives(newFittingDoc({ idFactory: () => 'a' }), DIMS_1550);
  assert.deepEqual(empty, { primitives: [], failures: [] });
  const single = { form: newDraft({ idFactory: () => 'a' }), history: [], baseline: null, prevEntry: null };
  assert.deepEqual(fittingAssemblyPrimitives(single, DIMS_1550), { primitives: [], failures: [] });
});

test('全体プレビュー: 未保存の編集（form）も反映される（部品を書き戻してから並べる）', () => {
  const doc = fittingDocFromEntry(SET);
  const edited = { ...doc, form: setDashRole(doc.form, doc.form.strokes[0].id, 'dashed') }; // 戸先枠を破線に変えた未保存の編集
  assert.equal(lines(fittingAssemblyPrimitives(doc, DIMS_1550)).filter(p => p.dash === 'dashed').length, 1, '編集前は開けた扉だけ破線');
  const r = fittingAssemblyPrimitives(edited, DIMS_1550);
  assert.equal(lines(r).filter(p => p.dash === 'dashed').length, 2);
});

// ---- 方立（jamb 系）の置き場 ----

const jambOf = key => ({ ...detailBuiltinFigures.find(e => e.key === key) });
const bodyOf = e => Object.fromEntries(Object.entries(e).filter(([k]) => !['key', 'version', 'label', 'provenance', 'note'].includes(k)));
function jambSetDoc(roles) {
  const base = newFittingDoc({ idFactory: () => 'j' });
  const set = { ...base.set, parts: roles.map(role => ({ id: role, role, figure: bodyOf(jambOf(DETAIL_BUILTIN_DOOR_JAMB_KEY)) })) };
  return fittingDocFromEntry(set);
}

test('全体プレビュー（方立）: jamb は吊元側 s＝0 と戸先側 s＝W の両方へ（戸先側は s が反転）', () => {
  const doc = jambSetDoc([R.JAMB]);
  const dims = { wallThickness: '100', faceWidth: '30', projection: '12', width: '1000' };
  const r = fittingAssemblyPrimitives(doc, dims);
  assert.deepEqual(r.failures, []);
  const local = tryFit(formFromEntry(fittingPartFigure(fittingEntryOf(doc), R.JAMB)), dims).strokes.map(s => s.points.map(p => [p.s, p.t]));
  const drawn = lines(r).map(p => p.points);
  assert.equal(drawn.length, local.length * 2);
  assert.deepEqual(drawn.slice(0, local.length), local, '吊元側（s＝0）');
  assert.deepEqual(drawn.slice(local.length), local.map(st => st.map(([s, t]) => [1000 - s, t])), '戸先側（s＝W・反転）');
});

test('全体プレビュー（方立）: jambHinge だけなら吊元側のみ・jambLatch だけなら戸先側のみ・jamb＋jambLatch は吊元側が jamb', () => {
  const dims = { wallThickness: '100', faceWidth: '30', projection: '12', width: '1000' };
  const n = roles => lines(fittingAssemblyPrimitives(jambSetDoc(roles), dims)).length;
  const one = n([R.JAMB_HINGE]);
  assert.ok(one > 0);
  assert.equal(n([R.JAMB_LATCH]), one);
  assert.equal(n([R.JAMB]), one * 2);
  assert.equal(n([R.JAMB, R.JAMB_LATCH]), one * 2);
  const hingeOnly = lines(fittingAssemblyPrimitives(jambSetDoc([R.JAMB_HINGE]), dims)).flatMap(p => p.points.map(q => q[0]));
  assert.ok(Math.max(...hingeOnly) <= 100, '吊元側は s＝0 付近だけ');
  const latchOnly = lines(fittingAssemblyPrimitives(jambSetDoc([R.JAMB_LATCH]), dims)).flatMap(p => p.points.map(q => q[0]));
  assert.ok(Math.min(...latchOnly) >= 900, '戸先側は s＝W 付近だけ');
});

test('全体プレビュー（方立・失敗側）: 幅が読めないと方立は描かず文言（幅は正の数で入力してください）', () => {
  const r = fittingAssemblyPrimitives(jambSetDoc([R.JAMB]), { wallThickness: '100', faceWidth: '30', projection: '12', width: '' });
  assert.equal(lines(r).length, 0);
  assert.equal(r.failures.length, 1);
  assert.ok(r.failures[0].text.includes(DETAIL_HELPER_MESSAGES.fittingAssemblyBadWidth));
});

test('全体プレビュー: 上枠・下枠・姿図は平面の全体図に出さない', () => {
  const base = newFittingDoc({ idFactory: () => 'h' });
  const head = detailBuiltinFigures.find(e => e.category === DetailCategory.PAIRED && e.view === DetailView.SECTION && e.subject === DetailSubject.HEAD);
  const set = { ...base.set, parts: [{ id: R.HEAD, role: R.HEAD, figure: bodyOf(head) }] };
  const r = fittingAssemblyPrimitives(fittingDocFromEntry(set), DIMS_1550);
  assert.deepEqual(r, { primitives: [], failures: [] });
});

test('試し込みの既定（全体）は引き戸の部品と同じ（W 1550・DW 800・穴 750）で、分類は引き戸の部品', () => {
  assert.deepEqual(assemblyFitDims(100), DIMS_1550);
  assert.deepEqual(ASSEMBLY_FIT_FORM, { ...FITTING_PART_TARGETS[R.SLIDE_LATCH] });
});

// ---- DXF／PDF の写し先 ----

function importedForm() {
  // draftFromDxf が返す形に近い下書き: 別キー・別呼称・既定の分類（図の分類は部品と違う）
  return { ...newDraft({ idFactory: () => 'dxf' }), label: 'sample', extra: { version: 1, provenance: { source: 'dxf' }, note: null } };
}

test('importIntoPart: 選んでいる部品の分類（役割の分類）で上書きし、キー・呼称は部品のまま', () => {
  const doc = selectFittingPart(fittingDocFromEntry(SET), 1); // slideInner
  const r = importIntoPart(doc, importedForm());
  assert.equal(r.error, undefined);
  const t = FITTING_PART_TARGETS[R.SLIDE_INNER];
  assert.deepEqual([r.doc.form.category, r.doc.form.view, r.doc.form.subject], [t.category, t.view, t.subject]);
  assert.equal(r.doc.form.key, doc.form.key);
  assert.equal(r.doc.form.key, `${DETAIL_BUILTIN_FITTING_SLIDING_KEY}#${R.SLIDE_INNER}`);
  assert.equal(r.doc.form.label, doc.form.label);
  assert.equal(r.doc.partIndex, 1);
  assert.equal(r.doc.history.at(-1), doc.form, '手戻しは写す前の form');
  // 写した結果は保存の本体（部品の figure）へ入り、一式の分類のまま・他の部品は不変
  const saved = fittingEntryOf(r.doc);
  assert.equal(saved.parts[1].figure.category, t.category);
  assert.equal(saved.parts.length, SET.parts.length);
  assert.deepEqual(saved.parts[0], SET.parts[0]);
  assert.equal(isDocDirty(r.doc), true, '未保存の編集になる');
});

test('importIntoPart: 方立の部品（paired/plan/jamb）へ写すと、図の分類も方立の分類になる', () => {
  const doc = jambSetDoc([R.JAMB_LATCH]);
  const r = importIntoPart(doc, importedForm());
  const t = FITTING_PART_TARGETS[R.JAMB_LATCH];
  assert.deepEqual([r.doc.form.category, r.doc.form.view, r.doc.form.subject], [t.category, t.view, t.subject]);
  assert.equal(entryFromForm(r.doc.form).category, DetailCategory.PAIRED);
});

test('importIntoPart（失敗側）: 部品が未選択（部品 0 個）は error「部品を選んでください」・読み取り専用は error・一式でない doc も error', () => {
  const empty = importIntoPart(newFittingDoc({ idFactory: () => 'a' }), importedForm());
  assert.equal(empty.error, DETAIL_HELPER_MESSAGES.fittingSelectPart);
  assert.equal(empty.error, '部品を選んでください');
  assert.equal(empty.doc, undefined);
  const ro = importIntoPart(fittingDocFromEntry(SET, { readOnly: true }), importedForm());
  assert.equal(ro.error, DETAIL_HELPER_TEXT.builtinReadOnly);
  const single = { form: newDraft({ idFactory: () => 'a' }), history: [], baseline: null, prevEntry: null };
  assert.equal(importIntoPart(single, importedForm()).error, DETAIL_HELPER_MESSAGES.fittingSelectPart);
});

// ---- 出所（R10。DXF／PDF 由来の線を持つ一式の出所は最上位へ。同梱の可否は出所によらない） ----

const DXF_PROV = buildDxfProvenance({ fileName: 'a.dxf', sha256: 'ab', maker: 'M', series: 'S', licenseNote: 'n' }).provenance;
const userSetDoc = () => fittingDocFromEntry({ ...SET, key: 'df-user-set', label: '自作一式', provenance: { source: DetailProvenanceSource.MANUAL } });
const dxfForm = () => ({ ...newDraft({ idFactory: () => 'dxf' }), extra: { version: 1, provenance: DXF_PROV, note: null } });
const bundledKeys = entry => {
  const DF = CatalogKind.DETAIL_FIGURE;
  const FS = CatalogKind.FIXTURE_SYMBOL;
  setOverlay(DF, { user: [entry] });
  setOverlay(FS, { user: [{ key: 'WF', label: '記号', category: 'fitting', mechanism: 'frameOnly', profile: 'solid', [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { fitting: entry.key } }] });
  const resolved = new Map([DF, FS].map(k => [k, composeCatalog(k, [])]));
  const raw = new Map([[DF, new Set([entry.key])], [FS, new Set(['WF'])]]);
  const out = [...expandUsedDetailFiguresTransitively(raw, resolved).get(DF)];
  clearOverlays();
  return out;
};

test('R10: DXF 由来の form を部品へ写すと一式の最上位 provenance が読み込んだ出所になり、手描きの一式と同じく同梱される', () => {
  const doc = userSetDoc();
  const r = importIntoPart(doc, dxfForm());
  const saved = fittingEntryOf(r.doc);
  assert.deepEqual(saved.provenance, DXF_PROV);
  assert.deepEqual(bundledKeys(saved), ['df-user-set'], 'DXF 由来の部品を持つ一式も使用中なら同梱する');
  // 対: 手描きの部品だけの一式も同梱される
  assert.deepEqual(bundledKeys(fittingEntryOf(doc)), ['df-user-set']);
});

test('R10: 読み込み由来の一式は、回収経路（旧束の記号が指す一式）でも同梱へ足される', () => {
  const saved = fittingEntryOf(importIntoPart(userSetDoc(), dxfForm()).doc);
  const DF = CatalogKind.DETAIL_FIGURE;
  const FS = CatalogKind.FIXTURE_SYMBOL;
  setOverlay(DF, { user: [saved] });
  const sym = { key: 'WF', label: '記号', category: 'fitting', mechanism: 'frameOnly', profile: 'solid', [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { fitting: saved.key } };
  const recovered = withEntries(emptyBundle(), FS, [sym]);
  const r = reexpandTransitiveDetailFigures(recovered, composeCatalog(DF, []));
  const keys = bundleEntries(r.bundle, DF).map(e => e.key);
  const unresolved = r.unresolvedDetailFigureKeys.size;
  clearOverlays();
  assert.deepEqual(keys, ['df-user-set']);
  assert.equal(unresolved, 0);
});

test('R10: 一式が既に読み込み由来なら、別の読み込みで出所を上書きしない（保持）。部品の切替でも出所は残る', () => {
  const first = importIntoPart(userSetDoc(), dxfForm()).doc;
  const other = buildDxfProvenance({ fileName: 'b.dxf', sha256: 'cd', maker: 'X', series: 'Y', licenseNote: 'z' }).provenance;
  const second = importIntoPart(selectFittingPart(first, 1), { ...dxfForm(), extra: { version: 1, provenance: other, note: null } }).doc;
  assert.deepEqual(fittingEntryOf(second).provenance, DXF_PROV);
});

test('R10: 手描きの form（出所が manual）を写しても一式の出所は変わらない', () => {
  const r = importIntoPart(userSetDoc(), newDraft({ idFactory: () => 'x' }));
  assert.equal(fittingEntryOf(r.doc).provenance.source, DetailProvenanceSource.MANUAL);
});

test('出所欄の編集は一式の最上位 provenance に乗る（trim して保存形）。手描きの一式・未知の項目は変わらない', () => {
  const imported = importIntoPart(userSetDoc(), dxfForm()).doc;
  const edited = setFittingProvenanceField(imported, 'maker', '  新メーカー ');
  assert.equal(edited.set.provenance.maker, '  新メーカー '); // 入力中は生
  assert.equal(fittingEntryOf(edited).provenance.maker, '新メーカー'); // 保存形は trim 済み
  assert.equal(setFittingProvenanceField(imported, 'unknown', 'x'), imported);
  const manual = userSetDoc();
  assert.equal(setFittingProvenanceField(manual, 'maker', 'x'), manual);
});

test('文言: 全体プレビューの切替ラベル', () => {
  assert.deepEqual(
    [DETAIL_HELPER_TEXT.assemblyPart, DETAIL_HELPER_TEXT.assemblyWhole, DETAIL_HELPER_TEXT.assemblyPlan, DETAIL_HELPER_TEXT.assemblyUp],
    ['部品', '全体', '平面', '見上げ'],
  );
});
