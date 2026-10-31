// カタログ種別「部分詳細図」（detailFigure）の登録と同梱往復（部分詳細図 S2）。
// 登録表・使用中判定・推移展開（建具記号→詳細図→材）・文書ファイルの往復・壊れた同梱 1 件の扱い・
// 重複禁止・walker を、store.js を import せず純モジュールの組合せで検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CatalogKind, KIND_LABELS, kindDef, listKinds,
} from './catalogKinds.js';
import { setOverlay, clearOverlays, overlayFor, composeCatalog } from './catalogRegistry.js';
import {
  emptyBundle, withEntries, bundleEntries, validateBundle, splitBundleByKind,
} from './catalogBundle.js';
import { encodeCatalogBundle, decodeCatalogBundle } from './catalogCodec.js';
import {
  buildDocumentBundle, recoverUnresolvedEntries, collectUsedKeys, collectUsedKeysByKind,
  expandUsedMaterialsTransitively, expandUsedDetailFiguresTransitively,
  reexpandTransitiveMaterials, reexpandTransitiveDetailFigures,
} from './usedEntries.js';
import { loadCatalogOverlaysFromIDB } from './catalogOverlayLoader.js';
import { planIncomingReconcile, applyReconcilePlan } from './incomingReconcile.js';
import { buildResolveRows, defaultResolveDecision } from './resolveQueue.js';
import { formatDetailViewLabel, formatCategoryLabel } from './catalogMaintenance.js';
import { diffEntries } from './catalogMatch.js';
import {
  SNAPSHOT_REF_WALKERS, setDocumentAliases, clearDocumentAliases,
} from './codeNormalization.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../storage/documentFile.js';
import { isSupportedDetailFigure } from '../detail/detailModel.js';
import {
  figureOf, strokeOf, move, vmove, fixedLen, materialLen,
} from '../detail/detailTestFixtures.js';
import {
  PenDir, DetailSlot, DetailMaterialField, DetailCategory, DetailView, DetailSubject,
  FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD,
} from '../core/constants.js';

const DF = CatalogKind.DETAIL_FIGURE;
const FS = CatalogKind.FIXTURE_SYMBOL;
const MAT = CatalogKind.MATERIAL;
const MAT_X = '101000000001';
const MAT_Y = '101000000002';

test.afterEach(() => {
  clearOverlays();
  clearDocumentAliases();
});

function material(code, overrides) {
  return { code, name: `テスト材${code}`, spec: '', x: 0, y: 0, thickness: 12.5, note: '', category: 'panel', ...overrides };
}

/** 2 手の最小図。materialCode を渡すと 2 手目の長さが材の厚み束縛になる。 */
function detailFigure(key, label, materialCode = null, over = {}) {
  const drop = materialCode ? materialLen(materialCode, DetailMaterialField.THICKNESS, 12) : fixedLen(12);
  const stroke = strokeOf('a', [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, drop)]);
  return figureOf([stroke], { key, label, ...over });
}

function symbol(key, over) {
  return { key, label: `記号${key}`, category: 'fitting', mechanism: 'frameOnly', profile: 'solid', ...over };
}

function emptyDocEnvelope(catalogs) {
  return { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs };
}

function roundTripThroughDocument(bundle) {
  return parseDocumentEnvelope(JSON.parse(buildDocumentJson(emptyDocEnvelope(bundle)))).catalogs;
}

// ---- 登録表 ----

test('登録表: detailFigure は 7 種別目で、ラベル「部分詳細図」・json・非空 key を keyOf にする', () => {
  assert.equal(CatalogKind.DETAIL_FIGURE, 'detailFigure');
  assert.equal(KIND_LABELS[DF], '部分詳細図');
  assert.ok(listKinds().includes(DF));
  assert.equal(listKinds().length, 7);
  const def = kindDef(DF);
  assert.equal(def.encoding, 'json');
  assert.equal(def.keyOf({ key: 'df-1' }), 'df-1');
  assert.deepEqual(def.parseKey('df-1'), { key: 'df-1' });
});

test('【失敗系】登録表: keyOf／parseKey は空・欠落の key を例外にする', () => {
  const def = kindDef(DF);
  assert.throws(() => def.keyOf({ label: 'x' }), /keyが不正/);
  assert.throws(() => def.keyOf({ key: '' }), /keyが不正/);
  assert.throws(() => def.parseKey(''), /キーが不正/);
});

test('登録表: 照合・比較・重複禁止の項目', () => {
  const def = kindDef(DF);
  assert.deepEqual(def.knownFields, ['key', 'version', 'label', 'category', 'view', 'subject', 'strokes', 'datums', 'anchors', 'provenance', 'note']);
  assert.deepEqual(def.requiredFields, ['key', 'label', 'category', 'view', 'strokes']);
  assert.deepEqual(def.compareFields, ['version', 'category', 'view', 'subject', 'strokes', 'datums', 'anchors', 'provenance', 'note']);
  assert.deepEqual(def.silentDiffFields, ['label']);
  assert.deepEqual(def.matchFields, ['strokes', 'category', 'view', 'subject', 'label']);
  assert.equal(def.minMatchFields, 2);
  assert.deepEqual(def.dedupeFields, ['strokes', 'label', 'category', 'view', 'subject']);
  assert.deepEqual(def.keyBoundFields, ['key']);
  assert.deepEqual(def.overrideLockedFields, []);
});

test('登録表: loadBuiltin は空配列（本体に標準の詳細図は無い）', async () => {
  assert.deepEqual(await kindDef(DF).loadBuiltin(), []);
});

test('validate: 有効な図は通る。浅い型検査の違反（必須欠落・型違い）は例外', () => {
  const def = kindDef(DF);
  const good = detailFigure('df-1', '見込み');
  assert.doesNotThrow(() => def.validate(good));
  for (const f of ['key', 'label', 'category', 'view', 'strokes']) {
    const broken = { ...good };
    delete broken[f];
    assert.throws(() => def.validate(broken), new RegExp(`必須項目が欠落しています: ${f}`), `${f} 欠落`);
  }
  assert.throws(() => def.validate({ ...good, key: '' }), /keyが不正/);
  assert.throws(() => def.validate({ ...good, label: 1 }), /labelが不正/);
  assert.throws(() => def.validate({ ...good, view: null }), /viewが不正/);
  assert.throws(() => def.validate({ ...good, subject: 3 }), /subjectが不正/);
  assert.throws(() => def.validate({ ...good, version: 'x' }), /versionが不正/);
  assert.throws(() => def.validate({ ...good, strokes: 'x' }), /strokesが不正/);
  assert.throws(() => def.validate({ ...good, datums: {} }), /datumsが不正/);
  assert.throws(() => def.validate({ ...good, anchors: 'x' }), /anchorsが不正/);
});

test('validate: datums／anchors／version の null は省略と同値で例外にならない（isSupported に任せる）', () => {
  const def = kindDef(DF);
  const good = detailFigure('df-1', '見込み');
  assert.doesNotThrow(() => def.validate({ ...good, datums: null }));
  assert.doesNotThrow(() => def.validate({ ...good, anchors: null }));
  assert.doesNotThrow(() => def.validate({ ...good, version: null }));
  assert.equal(def.isSupported({ ...good, datums: null, anchors: null }), true);
  assert.equal(def.isSupported({ ...good, version: null }), false);
  assert.throws(() => def.validate({ ...good, strokes: null }), /strokesが不正/, 'strokes の null は必須項目なので弾く');
});

test('validate は深い検査をしない: 未知 dir・mm が null の図も例外にならない（unsupported 側で扱う）', () => {
  const def = kindDef(DF);
  const badDir = detailFigure('df-1', 'a', null, { strokes: [strokeOf('a', [move('Z', fixedLen(10))])] });
  const badMm = detailFigure('df-2', 'b', null, { strokes: [strokeOf('a', [move(PenDir.RIGHT, { mm: null, mode: 'fixed' })])] });
  assert.doesNotThrow(() => def.validate(badDir));
  assert.doesNotThrow(() => def.validate(badMm));
});

test('isSupported は detail/detailModel.js の isSupportedDetailFigure と同じ判定（複製しない）', () => {
  const def = kindDef(DF);
  const good = detailFigure('df-1', 'a');
  const cases = [
    good,
    { ...good, version: 2 },
    { ...good, subject: 'unknownSubject' },
    detailFigure('df-2', 'b', null, { strokes: [strokeOf('a', [move('Z', fixedLen(10))])] }),
    detailFigure('df-3', 'c', null, { strokes: [strokeOf('a', [move(PenDir.RIGHT, { mm: null, mode: 'fixed' })])] }),
    detailFigure('df-4', 'd', null, { strokes: [strokeOf('a', [move(PenDir.RIGHT, fixedLen(0))])] }),
  ];
  assert.deepEqual(cases.map(c => def.isSupported(c)), [true, false, false, false, false, false]);
  for (const c of cases) assert.equal(def.isSupported(c), isSupportedDetailFigure(c));
});

// ---- 建具記号の任意項目 detailFigures（R4） ----

test('建具記号: detailFigures は knownFields・compareFields に入り matchFields には入らない', () => {
  const def = kindDef(FS);
  assert.equal(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD, 'detailFigures');
  assert.ok(def.knownFields.includes(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD));
  assert.ok(def.compareFields.includes(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD));
  assert.ok(!def.matchFields.includes(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD));
});

test('建具記号: detailFigures の差は diffEntries に出る（入れ子は厳密比較）', () => {
  const a = symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-1' } });
  const b = symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-2' } });
  assert.deepEqual(diffEntries(FS, a, b), [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]);
  assert.deepEqual(diffEntries(FS, a, a), []);
});

test('建具記号 validate: detailFigures は省略・null・オブジェクトのみ許す。isSupported は見ない', () => {
  const def = kindDef(FS);
  assert.doesNotThrow(() => def.validate(symbol('WF')));
  assert.doesNotThrow(() => def.validate(symbol('WF', { detailFigures: null })));
  assert.doesNotThrow(() => def.validate(symbol('WF', { detailFigures: { [DetailSlot.HEAD]: 'df-9' } })));
  assert.throws(() => def.validate(symbol('WF', { detailFigures: ['df-1'] })), /detailFiguresが不正/);
  assert.throws(() => def.validate(symbol('WF', { detailFigures: 'df-1' })), /detailFiguresが不正/);
  assert.equal(def.isSupported(symbol('WF', { detailFigures: { [DetailSlot.JAMB]: 'df-no-such' } })), true);
});

// ---- 使用中判定・推移展開 ----

function setupLibrary() {
  const df1 = detailFigure('df-1', '三方枠 縦枠', MAT_X);
  const df2 = detailFigure('df-2', '三方枠 鴨居', MAT_Y);
  const wf = symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-1' } });
  const matX = material(MAT_X);
  const matY = material(MAT_Y);
  setOverlay(DF, { user: [df1, df2] });
  setOverlay(FS, { user: [wf] });
  setOverlay(MAT, { user: [matX, matY] });
  return { df1, df2, wf, matX, matY };
}

function resolvedAll(kinds) {
  return new Map(kinds.map(kind => [kind, composeCatalog(kind, [])]));
}

function rawUsed(kinds, fixtureKeys) {
  const m = new Map(kinds.map(kind => [kind, new Set()]));
  for (const k of fixtureKeys) m.get(FS).add(k);
  return m;
}

test('推移展開: 使用中の建具記号 WF の detailFigures.jamb=df-1 と、df-1 が参照する材 X だけが入り、未使用の df-2・材 Y は入らない', () => {
  setupLibrary();
  const kinds = [MAT, FS, DF];
  const used = expandUsedMaterialsTransitively(
    expandUsedDetailFiguresTransitively(rawUsed(kinds, ['WF']), resolvedAll(kinds)), resolvedAll(kinds),
  );
  assert.deepEqual([...used.get(DF)], ['df-1']);
  assert.deepEqual([...used.get(MAT)], [MAT_X]);
  assert.deepEqual([...used.get(FS)], ['WF']);
});

test('推移展開: 使用中の建具記号が無ければ詳細図も材も増えない', () => {
  setupLibrary();
  const kinds = [MAT, FS, DF];
  const used = expandUsedDetailFiguresTransitively(rawUsed(kinds, []), resolvedAll(kinds));
  assert.deepEqual([...used.get(DF)], []);
  assert.deepEqual([...used.get(MAT)], []);
});

test('推移展開: 材の Map が無い usedKeysByKind（収集対象に material が無い）でも例外にならず、詳細図だけ展開する', () => {
  setupLibrary();
  const kinds = [FS, DF];
  const used = expandUsedDetailFiguresTransitively(rawUsed(kinds, ['WF']), resolvedAll(kinds));
  assert.deepEqual([...used.get(DF)], ['df-1']);
  assert.equal(used.has(MAT), false, 'Map に無い材は作らない');
});

test('推移展開: DETAIL_FIGURE が収集対象に無ければ入力をそのまま返す。入力の Map は書き換えない', () => {
  setupLibrary();
  const noDf = new Map([[FS, new Set(['WF'])]]);
  assert.equal(expandUsedDetailFiguresTransitively(noDf, resolvedAll([FS])), noDf);
  const kinds = [MAT, FS, DF];
  const input = rawUsed(kinds, ['WF']);
  const out = expandUsedDetailFiguresTransitively(input, resolvedAll(kinds));
  assert.notEqual(out, input);
  assert.deepEqual([...input.get(DF)], [], '入力の詳細図 Set は空のまま');
  assert.deepEqual([...input.get(MAT)], [], '入力の材 Set は空のまま');
});

test('【失敗系】推移展開: 割当て先の詳細図が解決できなくても例外にならず、キーは使用中に入り buildDocumentBundle が未解決として返す', () => {
  const wf = symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-gone' } });
  setOverlay(FS, { user: [wf] });
  const kinds = [MAT, FS, DF];
  const resolved = resolvedAll(kinds);
  const used = expandUsedDetailFiguresTransitively(rawUsed(kinds, ['WF']), resolved);
  assert.deepEqual([...used.get(DF)], ['df-gone']);
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved });
  assert.deepEqual(bundleEntries(bundle, DF), []);
  assert.deepEqual([...unresolvedKeys.get(DF)], ['df-gone']);
});

test('旧形の建具記号（detailFigures 無し）と detailFigures が壊れた値の建具記号は、詳細図を展開しない（例外にしない）', () => {
  // 配列は validate が弾く（overlay に載らない）ので、解決済み Map を直接組んで防御的に扱えることを見る
  const resolved = new Map([
    [FS, new Map([
      ['SF', symbol('SF')],
      ['SSF', { ...symbol('SSF'), detailFigures: ['df-1'] }],
      ['XX', { ...symbol('XX'), detailFigures: { jamb: '', head: 3 } }],
    ])],
    [DF, new Map()],
  ]);
  const used = expandUsedDetailFiguresTransitively(rawUsed([FS, DF], ['SF', 'SSF', 'XX']), resolved);
  assert.deepEqual([...used.get(DF)], []);
});

test('回復後の再展開: 回収した建具記号の詳細図を足し、その詳細図の材も reexpandTransitiveMaterials が足す。無いものは未解決で返る', () => {
  const { df1, matX } = setupLibrary();
  const recovered = withEntries(emptyBundle(), FS, [
    symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-1', [DetailSlot.HEAD]: 'df-gone' } }),
  ]);
  const resolved = resolvedAll([MAT, FS, DF]);
  const figures = reexpandTransitiveDetailFigures(recovered, resolved.get(DF));
  assert.deepEqual(bundleEntries(figures.bundle, DF), [df1]);
  assert.deepEqual([...figures.unresolvedDetailFigureKeys], ['df-gone']);
  const materials = reexpandTransitiveMaterials(figures.bundle, resolved.get(MAT));
  assert.deepEqual(bundleEntries(materials.bundle, MAT), [matX]);
  assert.deepEqual([...materials.unresolvedMaterialKeys], []);
});

test('回復後の再展開: 既にある詳細図は重複追加せず、追加が無ければ同一参照の束を返す。Map 無しは全て未解決', () => {
  const { df1 } = setupLibrary();
  const bundle = withEntries(withEntries(emptyBundle(), FS, [
    symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-1' } }),
  ]), DF, [df1]);
  const same = reexpandTransitiveDetailFigures(bundle, composeCatalog(DF, []));
  assert.equal(same.bundle, bundle);
  assert.equal(same.unresolvedDetailFigureKeys.size, 0);
  const noMap = reexpandTransitiveDetailFigures(withEntries(emptyBundle(), FS, bundle.catalogs[FS]), undefined);
  assert.deepEqual([...noMap.unresolvedDetailFigureKeys], ['df-1']);
});

test('回復後の再展開: 未解決の詳細図は前回の同梱から recoverUnresolvedEntries で拾い直せる', () => {
  const gone = detailFigure('df-gone', '前回の同梱にだけある');
  const existing = withEntries(emptyBundle(), DF, [gone]);
  const draft = withEntries(emptyBundle(), FS, [
    symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-gone' } }),
  ]);
  const { unresolvedDetailFigureKeys } = reexpandTransitiveDetailFigures(draft, new Map());
  const { bundle, stillUnresolvedByKind } = recoverUnresolvedEntries(
    draft, new Map([[DF, unresolvedDetailFigureKeys]]), new Map([[DF, existing]]),
  );
  assert.deepEqual(bundleEntries(bundle, DF), [gone]);
  assert.equal(stillUnresolvedByKind.size, 0);
});

// ---- 往復（ライブラリ → 使用中判定 → 同梱 → 文書ファイル → 三層合成） ----

test('往復: 使用中の図だけが同梱され、buildDocumentJson→parseDocumentEnvelope→三層合成で同じエントリに戻る', () => {
  const { df1, wf, matX } = setupLibrary();
  const kinds = [MAT, FS, DF];
  const resolved = resolvedAll(kinds);
  const used = expandUsedMaterialsTransitively(
    expandUsedDetailFiguresTransitively(rawUsed(kinds, ['WF']), resolved), resolved,
  );
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved });
  assert.equal(unresolvedKeys.size, 0);
  assert.deepEqual(bundleEntries(bundle, DF), [df1]);
  assert.deepEqual(bundle.encodings[DF], 'json');

  // 保存側: 種別ごとのレコードへ分割してバイト化し、読み戻しても同じ
  const sub = splitBundleByKind(bundle).get(DF);
  assert.deepEqual(decodeCatalogBundle(encodeCatalogBundle(sub)), sub);

  // 文書ファイル
  const parsed = roundTripThroughDocument(bundle);
  assert.deepEqual(parsed, bundle);
  assert.doesNotThrow(() => validateBundle(parsed));

  // 読込み側: ライブラリを外した環境で、同梱だけから三層合成して同じエントリになる
  clearOverlays();
  for (const kind of kinds) setOverlay(kind, { doc: bundleEntries(parsed, kind) });
  const mergedDf = composeCatalog(DF, []);
  assert.deepEqual(mergedDf.get('df-1'), df1);
  assert.equal(mergedDf.has('df-2'), false, '未使用の図は同梱されない');
  assert.deepEqual(composeCatalog(FS, []).get('WF'), wf);
  assert.deepEqual([...composeCatalog(MAT, []).values()], [matX]);
});

test('未知項目の保持: detailFigures を知らない旧形の建具記号と、未知キーを持つ詳細図が往復で保たれる', () => {
  const oldSymbol = symbol('SF'); // detailFigures 項目なし
  const future = detailFigure('df-1', '未来の図', null, { futureField: { nested: [1, 2, { a: 'b' }] } });
  const bundle = withEntries(withEntries(emptyBundle(), FS, [oldSymbol]), DF, [future]);
  const parsed = roundTripThroughDocument(bundle);
  assert.deepEqual(parsed.catalogs[FS], [oldSymbol]);
  assert.deepEqual(parsed.catalogs[DF], [future]);
  assert.ok(!Object.hasOwn(parsed.catalogs[FS][0], FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD), '旧形に項目を足さない');
  assert.doesNotThrow(() => validateBundle(parsed));
  setOverlay(DF, { doc: parsed.catalogs[DF] });
  assert.deepEqual(composeCatalog(DF, []).get('df-1').futureField, { nested: [1, 2, { a: 'b' }] });
  assert.ok(!kindDef(DF).knownFields.includes('futureField'));
});

test('未知の種別を含む束でも detailFigure は検証され、未知の種別は保持される', () => {
  const bundle = withEntries(withEntries(emptyBundle(), DF, [detailFigure('df-1', 'a')]), 'someFutureKind', [{ x: 1 }]);
  const parsed = roundTripThroughDocument(bundle);
  assert.doesNotThrow(() => validateBundle(parsed));
  assert.deepEqual(parsed.catalogs.someFutureKind, [{ x: 1 }]);
});

// ---- 壊れた同梱 1 件 ----

test('壊れた同梱 1 件（未知 dir・mm が null）: validateBundle は通り、他の種別の overlay が立ち、その 1 件は unsupported として通知される', async () => {
  const good = detailFigure('df-1', '正常な図');
  const broken = detailFigure('df-bad', '壊れた図', null, {
    strokes: [strokeOf('a', [move('Z', fixedLen(10)), move(PenDir.RIGHT, { mm: null, mode: 'fixed' })])],
  });
  const mat = material(MAT_X);
  const matBundle = withEntries(emptyBundle(), MAT, [mat]);
  const dfBundle = withEntries(emptyBundle(), DF, [good, broken]);
  assert.doesNotThrow(() => validateBundle(dfBundle), '浅い検査だけなので壊れた 1 件で束全体が落ちない');

  const errors = [];
  await loadCatalogOverlaysFromIDB({
    loadDocumentCatalogs: async () => [
      { kind: MAT, bytes: encodeCatalogBundle(matBundle) },
      { kind: DF, bytes: encodeCatalogBundle(dfBundle) },
    ],
    loadUserCatalogs: async () => [],
    onError: msg => errors.push(msg),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(overlayFor(MAT).doc, [mat], '他の種別（材料）の overlay が立つ');
  assert.deepEqual(overlayFor(DF).doc, [good, broken]);

  const plan = planIncomingReconcile({ kind: DF, docEntries: overlayFor(DF).doc, appEntries: [], origins: new Map() });
  assert.deepEqual(plan.unsupported, [broken]);
  assert.deepEqual(plan.adds, [good], '壊れていない図は通常どおり照合される');
  const rows = buildResolveRows({ kind: DF, unsupported: plan.unsupported });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scenario, 'unsupported');
  assert.ok(rows[0].id.includes('df-bad'));
});

test('【失敗系】浅い検査に落ちる同梱（strokes が配列でない）は種別とキーを前置した例外になり、overlay は一切立たない', async () => {
  const shallowBroken = { ...detailFigure('df-x', '壊れ'), strokes: 'oops' };
  const dfBundle = withEntries(emptyBundle(), DF, [shallowBroken]);
  assert.throws(() => validateBundle(dfBundle), /detailFigure df-x: .*strokesが不正/);
  const errors = [];
  await loadCatalogOverlaysFromIDB({
    loadDocumentCatalogs: async () => [
      { kind: MAT, bytes: encodeCatalogBundle(withEntries(emptyBundle(), MAT, [material(MAT_X)])) },
      { kind: DF, bytes: encodeCatalogBundle(dfBundle) },
    ],
    loadUserCatalogs: async () => [],
    onError: msg => errors.push(msg),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /detailFigure df-x/);
  assert.deepEqual(overlayFor(MAT).doc, [], '部分適用を残さない');
});

// ---- 重複禁止 ----

test('重複禁止: label/category/view/subject が同じ 2 件は、束の検証でも三層合成後でも弾かれる', () => {
  const a = detailFigure('df-a', '同じ呼称');
  const b = detailFigure('df-b', '同じ呼称');
  assert.throws(() => validateBundle(withEntries(emptyBundle(), DF, [a, b])), /重複/);
  setOverlay(DF, { doc: [a], user: [b] });
  assert.throws(() => composeCatalog(DF, []), /重複禁止.*df-/);
});

test('重複禁止: 呼称・分類・向き・主題のどれかが違えば別物として通る', () => {
  const base = detailFigure('df-a', '同じ呼称');
  const otherView = detailFigure('df-b', '同じ呼称', null, { view: DetailView.SECTION });
  const otherSubject = detailFigure('df-c', '同じ呼称', null, { subject: DetailSubject.HEAD, view: DetailView.SECTION, category: DetailCategory.PAIRED });
  const otherLabel = detailFigure('df-d', '別の呼称');
  setOverlay(DF, { user: [base, otherView, otherSubject, otherLabel] });
  assert.equal(composeCatalog(DF, []).size, 4);
});

// ---- walker・使用キー収集 ----

test('walker: detailFigure は enumerate が空で rewrite が null。collectUsedKeys／collectUsedKeysByKind は空 Set を返す', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  assert.ok(walker, 'SNAPSHOT_REF_WALKERS に detailFigure が登録されている');
  assert.deepEqual([...walker.enumerate({ rooms: [], openings: [{ fixtureType: 'WF' }] })], []);
  assert.equal(walker.rewrite, null);
  assert.deepEqual(Object.keys(SNAPSHOT_REF_WALKERS).sort(), listKinds().sort(), 'walker は全種別に 1 つずつ');
  assert.ok(collectUsedKeys({}).detailFigure instanceof Set);
  assert.equal(collectUsedKeys({}).detailFigure.size, 0);
  assert.equal(collectUsedKeys(null).detailFigure.size, 0);
  const byKind = collectUsedKeysByKind([{ openings: [] }], [DF]);
  assert.deepEqual([...byKind.get(DF)], []);
});

test('【失敗系】walker: rewrite が無い detailFigure に非空の alias を積むと例外（黙って効かない読み替えを作らない）。空なら通る', () => {
  assert.throws(() => setDocumentAliases(DF, { 'df-1': 'df-2' }), /alias.*対応していません/);
  assert.doesNotThrow(() => setDocumentAliases(DF, null));
  assert.doesNotThrow(() => setDocumentAliases(DF, {}));
});

// ---- 起動時照合（rewrite:null の種別は alias／propose を作らない。案A） ----

function otherStrokes() {
  return [strokeOf('a', [move(PenDir.RIGHT, fixedLen(30)), move(PenDir.DOWN, fixedLen(8))])];
}

async function reconcile(user, doc) {
  setOverlay(DF, { user, doc });
  const plan = planIncomingReconcile({ kind: DF, docEntries: doc, appEntries: user, origins: new Map() });
  const commits = [];
  const result = await applyReconcilePlan(plan, { kind: DF, currentUser: user, commitUserFn: async next => { commits.push(next); } });
  return { plan, result, commits };
}

test('照合①a: ライブラリ df-A・同梱 df-B（呼称等は同じで線だけ違う）は alias にならず、plan→apply が例外にならず両方残る', async () => {
  const a = detailFigure('df-A', '同じ呼称');
  const b = detailFigure('df-B', '同じ呼称', null, { strokes: otherStrokes() });
  const { plan, result, commits } = await reconcile([a], [b]);
  assert.deepEqual(plan.aliases, []);
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.adds, [b]);
  assert.deepEqual(result.addedKeys, ['df-B']);
  assert.equal(commits.length, 1);
  assert.deepEqual([...composeCatalog(DF, []).keys()].sort(), ['df-A', 'df-B']);
});

test('照合①b: ライブラリ df-A と中身が完全に同じ同梱 df-B（キー違い）は alias を作らず、例外なく同梱側を外して合成も通る', async () => {
  const a = detailFigure('df-A', '同じ呼称');
  const b = detailFigure('df-B', '同じ呼称');
  const { plan, result, commits } = await reconcile([a], [b]);
  assert.deepEqual(plan.aliases, [], 'alias を積むと addDocumentAliases が例外になる');
  assert.deepEqual(result.aliasPairs, []);
  assert.equal(result.skipped.length, 1, '重複で追加は弾かれる');
  assert.equal(commits.length, 0);
  assert.deepEqual(overlayFor(DF).doc, [], '重複した同梱は overlay から外す（残すと合成後の重複禁止で保存が止まる）');
  assert.deepEqual([...composeCatalog(DF, []).keys()], ['df-A']);
});

test('照合②: 部分一致（線は同じで呼称だけ違う）でも propose 行は作られず、別物として追加される', async () => {
  const a = detailFigure('df-A', '呼称A');
  const b = detailFigure('df-B', '呼称B');
  const { plan, result } = await reconcile([a], [b]);
  assert.deepEqual(plan.proposals, []);
  assert.deepEqual(plan.aliases, []);
  assert.deepEqual(result.addedKeys, ['df-B']);
  assert.equal(composeCatalog(DF, []).size, 2);
  assert.deepEqual(buildResolveRows({ kind: DF, proposals: plan.proposals, unsupported: plan.unsupported }), []);
});

test('重複禁止③: 線・呼称・分類・向き・主題がすべて同じ（キー違い）は三層合成後に重複。線だけ・呼称だけ違えば別物', () => {
  const a = detailFigure('df-A', '呼称');
  setOverlay(DF, { user: [a], doc: [detailFigure('df-B', '呼称')] });
  assert.throws(() => composeCatalog(DF, []), /重複禁止/);
  setOverlay(DF, { user: [a], doc: [detailFigure('df-B', '呼称', null, { strokes: otherStrokes() })] });
  assert.equal(composeCatalog(DF, []).size, 2, '線が違えば別物');
  setOverlay(DF, { user: [a], doc: [detailFigure('df-B', '別の呼称')] });
  assert.equal(composeCatalog(DF, []).size, 2, '呼称が違えば別物');
});

test('指示UI④: rewrite:null の種別の行は全場面で許可操作が「保留」だけ（aliasPairs を生む操作を出さない）。他の種別は従来どおり', () => {
  const broken = detailFigure('df-bad', '壊れ', null, { strokes: [strokeOf('a', [move('Z', fixedLen(10))])] });
  const rows = buildResolveRows({
    kind: DF,
    unsupported: [broken],
    libraryConflicts: [{ key: 'df-A', diffFields: ['strokes'] }],
    unresolved: [{ code: 'df-x', location: 'symbol' }],
    proposals: [{ from: 'df-B', candidates: [], entry: broken }],
    userEntries: [detailFigure('df-A', 'A')],
  });
  assert.deepEqual(rows.map(r => r.scenario).sort(), ['library-conflict', 'propose', 'unresolved-code', 'unsupported']);
  for (const row of rows) {
    assert.deepEqual(row.allowedActions, ['defer'], `${row.scenario}`);
    assert.deepEqual(defaultResolveDecision(row), { action: 'defer', pick: null });
  }
  const fsRows = buildResolveRows({ kind: FS, unsupported: [symbol('ZZ', { mechanism: 'swing' })] });
  assert.deepEqual(fsRows[0].allowedActions, ['approve', 'pick', 'defer']);
});

// ---- 推移展開の不足分・表示ラベル ----

test('推移展開: V（斜め）の dx が材 X の厚みに束縛された図でも、同梱に材 X が入る', () => {
  const stroke = strokeOf('a', [move(PenDir.RIGHT, fixedLen(20)), vmove(materialLen(MAT_X, DetailMaterialField.THICKNESS, 12), fixedLen(5))]);
  const df = figureOf([stroke], { key: 'df-v', label: '斜め' });
  assert.equal(isSupportedDetailFigure(df), true);
  setOverlay(DF, { user: [df] });
  setOverlay(FS, { user: [symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.HEAD]: 'df-v' } })] });
  setOverlay(MAT, { user: [material(MAT_X)] });
  const kinds = [MAT, FS, DF];
  const used = expandUsedDetailFiguresTransitively(rawUsed(kinds, ['WF']), resolvedAll(kinds));
  assert.deepEqual([...used.get(MAT)], [MAT_X]);
});

test('formatDetailViewLabel: plan→平面・section→断面・elevation→立面。未知値・非文字列はフォールバック（投げない）', () => {
  assert.equal(formatDetailViewLabel(DetailView.PLAN), '平面');
  assert.equal(formatDetailViewLabel(DetailView.SECTION), '断面');
  assert.equal(formatDetailViewLabel(DetailView.ELEVATION), '立面');
  assert.equal(formatDetailViewLabel('oblique'), 'oblique');
  assert.equal(formatDetailViewLabel('constructor'), 'constructor', 'プロトタイプのメンバーを拾わない');
  assert.equal(formatDetailViewLabel(null), '（未設定）');
});

test('formatCategoryLabel(DETAIL_FIGURE): 5 分類の表示名', () => {
  assert.deepEqual(
    [DetailCategory.PART, DetailCategory.JUNCTION, DetailCategory.FREE_PART, DetailCategory.PAIRED, DetailCategory.FIGURE]
      .map(c => formatCategoryLabel(DF, c)),
    ['部位', '取り合い', '自由部位', '対の部位', '姿図'],
  );
  assert.equal(formatCategoryLabel(DF, 'other'), 'other');
});
