// 建具一式（category FITTING・parts）のカタログ側（C2）。登録表の項目・重複禁止・浅い検査・材コードの収集・
// 使用中判定（種別／建具個別の fitting）・往復・FBS 不変・差分見出しを、純モジュールの組合せで検証する。
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { CatalogKind, kindDef } from './catalogKinds.js';
import { setOverlay, clearOverlays, composeCatalog } from './catalogRegistry.js';
import { emptyBundle, withEntries, bundleEntries, validateBundle, splitBundleByKind } from './catalogBundle.js';
import { encodeCatalogBundle, decodeCatalogBundle } from './catalogCodec.js';
import {
  buildDocumentBundle, collectUsedKeys, expandUsedMaterialsTransitively, expandUsedDetailFiguresTransitively,
} from './usedEntries.js';
import { diffEntries } from './catalogMatch.js';
import { planIncomingReconcile } from './incomingReconcile.js';
import { fieldLabel } from './catalogDiffView.js';
import { normalizeDetailFigure, isSupportedDetailFigure } from '../detail/detailModel.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../storage/documentFile.js';
import { Plane, PlanGraph, CenterLineType, Discipline, OpeningCategory } from '../core.js';
import { serializeGraph, restoreGraph } from '../graphSnapshot.js';
import {
  figureOf, strokeOf, move, fixedLen, materialLen,
} from '../detail/detailTestFixtures.js';
import {
  PenDir, DetailSlot, DetailCategory, DetailView, DetailSubject, DetailMaterialField, FittingPartRole,
  FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD,
} from '../core/constants.js';

const DF = CatalogKind.DETAIL_FIGURE;
const ST = CatalogKind.OPENING_SUB_TYPE;
const MAT = CatalogKind.MATERIAL;
const MAT_X = '101000000001';

test.afterEach(() => clearOverlays());

/** 部品の本体（分類・strokes・datums・anchors）。code があれば 2 手目が材の厚み束縛。 */
function partBody(code = null, over = {}) {
  const drop = code ? materialLen(code, DetailMaterialField.THICKNESS, 12) : fixedLen(12);
  const f = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, drop)])], over);
  return { category: f.category, view: f.view, subject: f.subject, strokes: f.strokes, datums: f.datums, anchors: f.anchors };
}

/** 一式。最上位の strokes は空。parts の中身だけで識別する。 */
function fittingSet(key, label = '一式', parts = null, over = {}) {
  return {
    key, version: 1, label, category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING,
    strokes: [], datums: [], anchors: [], provenance: null, note: null,
    parts: parts ?? [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody() }],
    ...over,
  };
}

function material(code) {
  return { code, name: `テスト材${code}`, spec: '', x: 0, y: 0, thickness: 12.5, note: '', category: 'panel' };
}

function resolvedAll(kinds) {
  return new Map(kinds.map(kind => [kind, composeCatalog(kind, [])]));
}

function subType(key, over) {
  return { category: 'fitting', key, label: `種別${key}`, mechanism: 'swing', defaultWidth: 800, defaultHeight: 2000, ...over };
}

test('登録表: parts は knownFields・compareFields に入り、dedupeFields の先頭・matchFields の末尾', () => {
  const def = kindDef(DF);
  assert.ok(def.knownFields.includes('parts'));
  assert.ok(def.compareFields.includes('parts'));
  assert.equal(def.dedupeFields[0], 'parts');
  assert.equal(def.matchFields.at(-1), 'parts', 'parts は末尾（先頭だと一式の無い図の閾値が下がる）');
});

function reconcilePlan(doc, app) {
  return planIncomingReconcile({ kind: DF, docEntries: doc, appEntries: app, origins: new Map() });
}

test('Q-C2 (a): 呼称が同じで部品だけ違う一式は alias にならず propose になる', () => {
  const app = fittingSet('df-app', '同じ', [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody() }]);
  const doc = fittingSet('df-doc', '同じ', [{ id: 'p1', role: FittingPartRole.HEAD, figure: partBody(null, { subject: DetailSubject.HEAD, view: DetailView.SECTION }) }]);
  const plan = reconcilePlan([doc], [app]);
  assert.equal(plan.aliases.length, 0);
  assert.equal(plan.proposals.length, 1);
});

test('Q-C2 (b): キーだけ違い部品が同じ一式は alias（文書側→アプリ側）', () => {
  const app = fittingSet('df-app');
  const doc = fittingSet('df-doc');
  const plan = reconcilePlan([doc], [app]);
  assert.deepEqual(plan.aliases, [{ from: 'df-doc', to: 'df-app' }]);
  assert.equal(plan.proposals.length, 0);
});

test('Q-C2 (c): 一式の無い図は strokes だけ同じで分類・向き・主題・呼称が違えば別物（add）。parts を先頭に足すと閾値が下がり赤になる', () => {
  const app = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(20))])], { key: 'df-app', label: 'あ' });
  const doc = figureOf([strokeOf('a', [move(PenDir.RIGHT, fixedLen(20))])], {
    key: 'df-doc', label: 'い', category: DetailCategory.FIGURE, view: DetailView.ELEVATION, subject: DetailSubject.OPENING,
  });
  assert.notEqual(`${app.category}|${app.view}|${app.subject}`, `${doc.category}|${doc.view}|${doc.subject}`);
  const plan = reconcilePlan([doc], [app]);
  assert.equal(plan.adds.length, 1);
  assert.equal(plan.aliases.length, 0);
  assert.equal(plan.proposals.length, 0);
});

test('重複禁止: 最上位が同じで parts だけ違う一式 2 件は別物（束の検証・三層合成とも通る）。parts も同じなら重複', () => {
  const a = fittingSet('df-a', '同じ', [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody() }]);
  const b = fittingSet('df-b', '同じ', [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody(null, { subject: DetailSubject.JAMB, view: DetailView.PLAN }) }, {
    id: 'p2', role: FittingPartRole.HEAD, figure: partBody(null, { subject: DetailSubject.HEAD, view: DetailView.SECTION }),
  }]);
  assert.doesNotThrow(() => validateBundle(withEntries(emptyBundle(), DF, [a, b])));
  setOverlay(DF, { doc: [a], user: [b] });
  assert.equal(composeCatalog(DF, []).size, 2);
  // 対照: parts が完全に同じなら重複
  const same = fittingSet('df-c', '同じ', a.parts);
  assert.throws(() => validateBundle(withEntries(emptyBundle(), DF, [a, same])), /重複/);
});

test('compare: parts の差は diffEntries に出る。同じなら出ない', () => {
  const a = fittingSet('df-a');
  const b = fittingSet('df-a', '一式', [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody(MAT_X) }]);
  assert.deepEqual(diffEntries(DF, a, b), ['parts']);
  assert.deepEqual(diffEntries(DF, a, fittingSet('df-a')), []);
});

test('浅い validate: parts は省略・null・配列のみ。非配列は例外。strokes: [] の一式は通る', () => {
  const def = kindDef(DF);
  assert.doesNotThrow(() => def.validate(fittingSet('df-a')));
  assert.doesNotThrow(() => def.validate(fittingSet('df-a', '一式', null, { parts: null })));
  assert.doesNotThrow(() => def.validate(fittingSet('df-a', '一式', null, { parts: undefined })));
  assert.throws(() => def.validate(fittingSet('df-a', '一式', null, { parts: 'x' })), /partsが不正/);
  assert.throws(() => def.validate(fittingSet('df-a', '一式', null, { parts: {} })), /partsが不正/);
  assert.throws(() => def.validate({ ...fittingSet('df-a'), strokes: undefined }), /必須項目が欠落しています: strokes/);
});

test('往復: 一式はライブラリ JSON 保存→読込みと文書ファイルで deepEqual。normalize は冪等', () => {
  const set = fittingSet('df-a', '一式', [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody(MAT_X) }]);
  const norm = normalizeDetailFigure(set);
  assert.deepEqual(normalizeDetailFigure(norm), norm);
  assert.equal(isSupportedDetailFigure(norm), true);
  const bundle = withEntries(emptyBundle(), DF, [norm]);
  const sub = splitBundleByKind(bundle).get(DF);
  assert.deepEqual(decodeCatalogBundle(encodeCatalogBundle(sub)), sub);
  const doc = parseDocumentEnvelope(JSON.parse(buildDocumentJson({
    floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle,
  }))).catalogs;
  assert.deepEqual(bundleEntries(doc, DF), [norm]);
});

test('材コード収集: 部品の strokes の材 LenSpec が同梱の材に入る。一式が使用中でなければ入らない', () => {
  const set = fittingSet('df-fit', '一式', [{ id: 'p1', role: FittingPartRole.JAMB, figure: partBody(MAT_X) }]);
  setOverlay(DF, { user: [set] });
  setOverlay(MAT, { user: [material(MAT_X)] });
  setOverlay(ST, { user: [subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FITTING]: 'df-fit' } })] });
  const kinds = [MAT, ST, DF];
  const raw = new Map(kinds.map(k => [k, new Set()]));
  raw.get(ST).add('fitting:u1');
  const used = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(raw, resolvedAll(kinds)), resolvedAll(kinds));
  assert.deepEqual([...used.get(MAT)], [MAT_X]);
  const none = expandUsedMaterialsTransitively(
    expandUsedDetailFiguresTransitively(new Map(kinds.map(k => [k, new Set()])), resolvedAll(kinds)), resolvedAll(kinds),
  );
  assert.deepEqual([...none.get(MAT)], []);
});

test('材コード収集【失敗系】: 壊れた部品（null・figure 無し・strokes 非配列）でも例外にならず材は 0 件', () => {
  const kinds = [MAT, ST, DF];
  for (const parts of [[null], [{ id: 'p', role: 'jamb' }], [{ id: 'p', role: 'jamb', figure: { strokes: 'x' } }]]) {
    clearOverlays();
    setOverlay(DF, { user: [fittingSet('df-fit', '一式', null, { parts })] });
    setOverlay(ST, { user: [subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FITTING]: 'df-fit' } })] });
    setOverlay(MAT, { user: [material(MAT_X)] });
    const raw = new Map(kinds.map(k => [k, new Set()]));
    raw.get(ST).add('fitting:u1');
    const used = expandUsedDetailFiguresTransitively(raw, resolvedAll(kinds));
    assert.deepEqual([...used.get(DF)], ['df-fit']);
    assert.deepEqual([...used.get(MAT)], []);
  }
});

test('使用中: 建具種別の detailFigures.fitting から一式が 1 件（部品ごとでない）だけ同梱される', () => {
  const set = fittingSet('df-fit', '一式', [
    { id: 'p1', role: FittingPartRole.JAMB, figure: partBody(MAT_X) },
    { id: 'p2', role: FittingPartRole.HEAD, figure: partBody(null, { subject: DetailSubject.HEAD, view: DetailView.SECTION }) },
  ]);
  const other = fittingSet('df-other', '別の一式');
  setOverlay(DF, { user: [set, other] });
  setOverlay(MAT, { user: [material(MAT_X)] });
  setOverlay(ST, { user: [subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FITTING]: 'df-fit' } })] });
  const kinds = [MAT, ST, DF];
  const raw = new Map(kinds.map(k => [k, new Set()]));
  raw.get(ST).add('fitting:u1');
  const resolved = resolvedAll(kinds);
  const used = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(raw, resolved), resolved);
  assert.deepEqual([...used.get(DF)], ['df-fit']);
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved });
  assert.equal(unresolvedKeys.size, 0);
  assert.deepEqual(bundleEntries(bundle, DF), [set]);
  assert.deepEqual(bundleEntries(bundle, MAT).map(m => m.code), [MAT_X]);
});

test('使用中: opening.detailRefs.fitting の値も使用中の詳細図に数える（空・非文字列は数えない）', () => {
  const used = collectUsedKeys({ openings: [
    { id: 'o1', detailRefs: { [DetailSlot.FITTING]: 'df-fit' } },
    { id: 'o2', detailRefs: { [DetailSlot.FITTING]: '' } },
    { id: 'o3', detailRefs: { [DetailSlot.FITTING]: 3 } },
  ] });
  assert.deepEqual([...used.detailFigure], ['df-fit']);
});

test('使用中【失敗系】: 一式の参照が解決できなくても例外にならず、キーは使用中に入り buildDocumentBundle が未解決として返す', () => {
  const kinds = [ST, DF];
  setOverlay(ST, { user: [subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FITTING]: 'df-missing' } })] });
  const raw = new Map(kinds.map(k => [k, new Set()]));
  raw.get(ST).add('fitting:u1');
  const resolved = resolvedAll(kinds);
  const used = expandUsedDetailFiguresTransitively(raw, resolved);
  assert.deepEqual([...used.get(DF)], ['df-missing']);
  const { unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved });
  assert.deepEqual([...unresolvedKeys.get(DF)], ['df-missing']);
});

test('FBS 不変: detailRefs.fitting を持つ建具のフロアのバイト列は、一式を同梱した文書でも同梱しない文書でも同じ。往復で値が戻る', () => {
  const graph = new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
  const axisCL = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clStart = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: false, discipline: Discipline.ARCH });
  const clEnd = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: false, discipline: Discipline.ARCH });
  graph.addWall(axisCL, 75, false, clStart, 0, clEnd, 0, { isExteriorWall: true });
  graph.addOpening(axisCL, 1, false, clStart, 800, 800, OpeningCategory.FITTING, 'threeSidedFrame',
    { fixtureType: 'WF', detailRefs: { [DetailSlot.FITTING]: 'df-fit' } }, 'op0');
  // 一式が overlay にある状態とない状態で、フロアのバイト列は同じ（FBS は一式を知らない）
  setOverlay(DF, { user: [fittingSet('df-fit')] });
  const withOverlay = Buffer.from(serializeGraph(graph));
  clearOverlays();
  const bytes = serializeGraph(graph);
  assert.deepEqual(withOverlay, Buffer.from(bytes));
  // 往復（serialize→restore→serialize）は 1 世代目でバイト長が変わる（detailRefs の無い建具でも同じ＝既存の挙動）ので、2 世代目以降の不動点で固定する
  const again = new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
  restoreGraph(again, bytes);
  const second = serializeGraph(again);
  const third = new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
  restoreGraph(third, second);
  // 注: 最初の往復はバイト列が正規形でない（復元で付く項目があり 1 世代目は元より大きい）ので、2 世代目以降の不動点で固定する
  assert.deepEqual(Buffer.from(serializeGraph(third)), Buffer.from(second));
  assert.deepEqual({ ...again.openings.find(o => o.id === 'op0').detailRefs }, { fitting: 'df-fit' });
  const withSet = withEntries(emptyBundle(), DF, [fittingSet('df-fit')]);
  const docOf = catalogs => parseDocumentEnvelope(JSON.parse(buildDocumentJson({
    floors: [{ planeId: 'p1', bytes }], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs,
  })));
  const a = docOf(withSet);
  const b = docOf(emptyBundle());
  assert.deepEqual(Buffer.from(a.floors[0].bytes), Buffer.from(b.floors[0].bytes));
  assert.deepEqual(Buffer.from(a.floors[0].bytes), Buffer.from(bytes));
  assert.deepEqual(bundleEntries(a.catalogs, DF), [fittingSet('df-fit')]);
  const restored = new PlanGraph(new Plane('p1', 0, 'p1階', 1, 1));
  restoreGraph(restored, a.floors[0].bytes);
  assert.deepEqual({ ...restored.openings.find(o => o.id === 'op0').detailRefs }, { fitting: 'df-fit' });
});

test('差分見出し: detailFigure の parts は「部品」', () => {
  assert.equal(fieldLabel('detailFigure', 'parts'), '部品');
});
