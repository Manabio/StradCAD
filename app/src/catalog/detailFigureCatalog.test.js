// カタログ種別「部分詳細図」（detailFigure）の登録と同梱往復（部分詳細図 S2）。
// 登録表・使用中判定・推移展開（建具記号→詳細図→材）・文書ファイルの往復・壊れた同梱 1 件の扱い・
// 重複禁止・walker を、store.js を import せず純モジュールの組合せで検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CatalogKind, KIND_LABELS, kindDef, listKinds,
} from './catalogKinds.js';
import { setOverlay, clearOverlays, overlayFor, composeCatalog, overlayGeneration } from './catalogRegistry.js';
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
import fs from 'node:fs';
import path from 'node:path';
import { planIncomingReconcile, applyReconcilePlan, rewriteDocSymbolDetailFigures } from './incomingReconcile.js';
import { buildResolveRows, defaultResolveDecision } from './resolveQueue.js';
import { formatDetailViewLabel, formatCategoryLabel, formatDetailViews, DETAIL_PLACEMENT_VIEW_LABELS } from './catalogMaintenance.js';
import { diffEntries } from './catalogMatch.js';
import {
  SNAPSHOT_REF_WALKERS, setDocumentAliases, clearDocumentAliases, applyDocumentCodeNormalization,
} from './codeNormalization.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../storage/documentFile.js';
import { isSupportedDetailFigure } from '../detail/detailModel.js';
import {
  figureOf, strokeOf, move, vmove, fixedLen, materialLen,
} from '../detail/detailTestFixtures.js';
import {
  PenDir, DetailSlot, DetailMaterialField, DetailCategory, DetailView, DetailSubject,
  FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD, DetailPlacementView,
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
  assert.deepEqual(def.knownFields, ['key', 'version', 'label', 'category', 'view', 'subject', 'strokes', 'datums', 'anchors', 'provenance', 'note', 'views', 'parts']);
  assert.deepEqual(def.requiredFields, ['key', 'label', 'category', 'view', 'strokes']);
  assert.deepEqual(def.compareFields, ['version', 'category', 'view', 'subject', 'strokes', 'datums', 'anchors', 'provenance', 'note', 'views', 'parts']);
  assert.deepEqual(def.silentDiffFields, ['label']);
  assert.deepEqual(def.matchFields, ['strokes', 'category', 'view', 'subject', 'label', 'parts']);
  assert.equal(def.minMatchFields, 2);
  assert.deepEqual(def.dedupeFields, ['parts', 'strokes', 'label', 'category', 'view', 'subject']);
  assert.deepEqual(def.keyBoundFields, ['key']);
  assert.deepEqual(def.overrideLockedFields, []);
});

test('登録表: loadBuiltin は組込み 10 件（巾木 出 10・床と壁／天板 厚 20・腰壁の天端／片開き戸の方立・上枠／窓の方立 3 種／窓の上枠・下枠／引き戸の建具一式）で、validate と isSupported を通る', async () => {
  const def = kindDef(DF);
  const list = await def.loadBuiltin();
  assert.deepEqual(list.map(e => [e.key, e.category, e.subject]), [
    ['df-builtin-baseboard-10', 'junction', 'floorWall'], ['df-builtin-kneecap-20', 'part', 'wall'],
    ['df-builtin-door-jamb-30', 'paired', 'jamb'], ['df-builtin-door-head-30', 'paired', 'head'],
    ['df-builtin-window-jamb-notched-25', 'paired', 'jamb'], ['df-builtin-window-jamb-25', 'paired', 'jamb'],
    ['df-builtin-window-jamb-open-25', 'paired', 'jamb'],
    ['df-builtin-window-head-25', 'paired', 'head'], ['df-builtin-window-sill-25', 'paired', 'sill'],
    ['df-builtin-fitting-sliding', 'fitting', 'opening'],
  ]);
  for (const entry of list) {
    assert.doesNotThrow(() => def.validate(entry));
    assert.equal(def.isSupported(entry), true);
  }
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

test('推移展開（S8e-3）: 三方枠専用でない記号（mechanism なし。片開き戸用）の detailFigures も、詳細図とその材を同梱へ展開する', () => {
  const { wf } = setupLibrary();
  setOverlay(FS, { user: [{ key: 'WD', label: '記号WD', category: 'fitting', [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: wf[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD] }] });
  const kinds = [MAT, FS, DF];
  const used = expandUsedMaterialsTransitively(
    expandUsedDetailFiguresTransitively(rawUsed(kinds, ['WD']), resolvedAll(kinds)), resolvedAll(kinds),
  );
  assert.deepEqual([...used.get(DF)], ['df-1']);
  assert.deepEqual([...used.get(MAT)], [MAT_X]);
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

test('walker（S6a）: detailFigure の enumerate は openings[].detailRefs の値を列挙し、rewrite は関数。使用キー収集に合流する', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  assert.ok(walker, 'SNAPSHOT_REF_WALKERS に detailFigure が登録されている');
  assert.equal(typeof walker.rewrite, 'function');
  assert.deepEqual(Object.keys(SNAPSHOT_REF_WALKERS).sort(), listKinds().sort(), 'walker は全種別に 1 つずつ');
  const snapshot = {
    rooms: [],
    openings: [
      { id: 'o1', fixtureType: 'WF', detailRefs: { head: 'df-h', jamb: 'df-j' } },
      { id: 'o2', fixtureType: 'WF', detailRefs: null },
      { id: 'o3', fixtureType: 'WF' },
      { id: 'o4', fixtureType: 'WF', detailRefs: { jamb: 'df-j', sill: '', nageshi: 3 } },
    ],
  };
  assert.deepEqual([...walker.enumerate(snapshot)], [
    { code: 'df-h', location: 'opening', openingId: 'o1', slot: 'head' },
    { code: 'df-j', location: 'opening', openingId: 'o1', slot: 'jamb' },
    { code: 'df-j', location: 'opening', openingId: 'o4', slot: 'jamb' },
  ]);
  assert.deepEqual([...collectUsedKeys(snapshot).detailFigure].sort(), ['df-h', 'df-j']);
  assert.deepEqual([...collectUsedKeysByKind([snapshot, { openings: [{ id: 'o9', detailRefs: { jamb: 'df-z' } }] }], [DF]).get(DF)].sort(), ['df-h', 'df-j', 'df-z']);
  // 参照の無い・空のスナップショットは空 Set（例外にしない）
  assert.equal(collectUsedKeys({}).detailFigure.size, 0);
  assert.equal(collectUsedKeys(null).detailFigure.size, 0);
  assert.deepEqual([...walker.enumerate(null)], []);
  assert.deepEqual([...collectUsedKeysByKind([{ openings: [] }], [DF]).get(DF)], []);
});

test('walker（S6a）: rewrite は alias 表で detailRefs の値だけ書き換える。表に無い値・他の項目・元のスナップショットは変えない', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    openings: [
      { id: 'o1', fixtureType: 'WF', detailRefs: { head: 'df-h', jamb: 'df-old' } },
      { id: 'o2', fixtureType: 'WF', detailRefs: { jamb: 'df-keep' } },
      { id: 'o3', fixtureType: 'WF', detailRefs: null },
    ],
  };
  const before = JSON.stringify(snapshot);
  const { snapshot: next, unresolved } = walker.rewrite(snapshot, new Map([['df-old', 'df-new']]));
  assert.deepEqual(next.openings[0].detailRefs, { head: 'df-h', jamb: 'df-new' });
  assert.equal(next.openings[1], snapshot.openings[1], '表に無い建具は同一参照のまま');
  assert.equal(next.openings[2], snapshot.openings[2]);
  assert.deepEqual(unresolved, []);
  assert.equal(JSON.stringify(snapshot), before, '元のスナップショットを書き換えない');
  // 表に当たりが無ければスナップショットごと同一参照
  assert.equal(walker.rewrite(snapshot, new Map([['df-x', 'df-y']])).snapshot, snapshot);
  // 削除・廃止（to=null）は据え置きで unresolved へ
  const dropped = walker.rewrite(snapshot, new Map([['df-old', null]]));
  assert.deepEqual(dropped.snapshot.openings[0].detailRefs, { head: 'df-h', jamb: 'df-old' });
  assert.deepEqual(dropped.unresolved, [{ code: 'df-old', location: 'opening', openingId: 'o1', slot: 'jamb' }]);
});

test('walker（S8a）: enumerate は rooms[].detailRefs の値を {location:room, roomId, slot} で列挙し、使用キー収集に合流する。空・空文字・非文字列は無視', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    openings: [{ id: 'o1', fixtureType: 'WF', detailRefs: { jamb: 'df-j' } }],
    rooms: [
      { id: 'r1', detailRefs: { wallCeiling: 'df-wc', floorWall: 'df-fw' } },
      { id: 'r2', detailRefs: null },
      { id: 'r3' },
      { id: 'r4', detailRefs: { floorWall: '', wallCeiling: 3 } },
    ],
  };
  assert.deepEqual([...walker.enumerate(snapshot)], [
    { code: 'df-j', location: 'opening', openingId: 'o1', slot: 'jamb' },
    { code: 'df-wc', location: 'room', roomId: 'r1', slot: 'wallCeiling' },
    { code: 'df-fw', location: 'room', roomId: 'r1', slot: 'floorWall' },
  ]);
  assert.deepEqual([...collectUsedKeys(snapshot).detailFigure].sort(), ['df-fw', 'df-j', 'df-wc']);
});

test('walker（S8a）: rewrite は rooms[].detailRefs の値も alias 表で書き換える。表に無い部屋は同一参照・元は変えず、to=null は据え置きで unresolved へ。openings の書換えと両立する', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    openings: [{ id: 'o1', fixtureType: 'WF', detailRefs: { jamb: 'df-old' } }],
    rooms: [
      { id: 'r1', detailRefs: { floorWall: 'df-old', wallCeiling: 'df-keep' } },
      { id: 'r2', detailRefs: { floorWall: 'df-keep' } },
      { id: 'r3', detailRefs: null },
    ],
  };
  const before = JSON.stringify(snapshot);
  const { snapshot: next, unresolved } = walker.rewrite(snapshot, new Map([['df-old', 'df-new']]));
  assert.deepEqual(next.rooms[0].detailRefs, { floorWall: 'df-new', wallCeiling: 'df-keep' });
  assert.deepEqual(next.openings[0].detailRefs, { jamb: 'df-new' });
  assert.equal(next.rooms[1], snapshot.rooms[1], '表に無い部屋は同一参照のまま');
  assert.equal(next.rooms[2], snapshot.rooms[2]);
  assert.deepEqual(unresolved, []);
  assert.equal(JSON.stringify(snapshot), before, '元のスナップショットを書き換えない');
  // 部屋だけに当たる表: openings は同一参照のまま、rooms キーの無い snapshot に rooms キーを足さない
  const roomsOnly = walker.rewrite(snapshot, new Map([['df-keep', 'df-k2']]));
  assert.equal(roomsOnly.snapshot.openings, snapshot.openings);
  assert.deepEqual(roomsOnly.snapshot.rooms[1].detailRefs, { floorWall: 'df-k2' });
  const noRooms = walker.rewrite({ openings: snapshot.openings }, new Map([['df-old', 'df-new']]));
  assert.equal(Object.hasOwn(noRooms.snapshot, 'rooms'), false);
  assert.equal(walker.rewrite(snapshot, new Map([['df-x', 'df-y']])).snapshot, snapshot);
  const dropped = walker.rewrite({ rooms: snapshot.rooms }, new Map([['df-old', null]]));
  assert.deepEqual(dropped.snapshot.rooms[0].detailRefs, { floorWall: 'df-old', wallCeiling: 'df-keep' });
  assert.deepEqual(dropped.unresolved, [{ code: 'df-old', location: 'room', roomId: 'r1', slot: 'floorWall' }]);
});

test('walker（S8b-1）: enumerate は kneeDropWalls[].detailRefs の値を {location:kneeDrop, key, slot} で列挙し、使用キー収集に合流する。空・空文字・非文字列は無視', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    rooms: [{ id: 'r1', detailRefs: { floorWall: 'df-fw' } }],
    kneeDropWalls: [
      { key: 'a:s:e', detailRefs: { kneeTop: 'df-kt', dropBottom: 'df-db' } },
      { key: 'b:s:e', detailRefs: null },
      { key: 'c:s:e' },
      { key: 'd:s:e', detailRefs: { kneeTop: '', dropBottom: 3 } },
    ],
  };
  assert.deepEqual([...walker.enumerate(snapshot)], [
    { code: 'df-fw', location: 'room', roomId: 'r1', slot: 'floorWall' },
    { code: 'df-kt', location: 'kneeDrop', key: 'a:s:e', slot: 'kneeTop' },
    { code: 'df-db', location: 'kneeDrop', key: 'a:s:e', slot: 'dropBottom' },
  ]);
  assert.deepEqual([...collectUsedKeys(snapshot).detailFigure].sort(), ['df-db', 'df-fw', 'df-kt']);
  assert.deepEqual([...walker.enumerate({ kneeDropWalls: [] })], []);
});

test('walker（S8b-1）: rewrite は kneeDropWalls[].detailRefs の値も alias 表で書き換える。表に無い記録は同一参照・元は変えず、to=null は据え置きで unresolved へ。キーの無い snapshot に足さない', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    rooms: [{ id: 'r1', detailRefs: { floorWall: 'df-old' } }],
    kneeDropWalls: [
      { key: 'a:s:e', hasKnee: true, detailRefs: { kneeTop: 'df-old' } },
      { key: 'b:s:e', hasKnee: true, detailRefs: { kneeTop: 'df-keep' } },
      { key: 'c:s:e', hasKnee: true, detailRefs: null },
    ],
  };
  const before = JSON.stringify(snapshot);
  const { snapshot: next, unresolved } = walker.rewrite(snapshot, new Map([['df-old', 'df-new']]));
  assert.deepEqual(next.kneeDropWalls[0], { key: 'a:s:e', hasKnee: true, detailRefs: { kneeTop: 'df-new' } }, '他の項目を保つ');
  assert.deepEqual(next.rooms[0].detailRefs, { floorWall: 'df-new' }, 'rooms の書換えと両立する');
  assert.equal(next.kneeDropWalls[1], snapshot.kneeDropWalls[1], '表に無い記録は同一参照のまま');
  assert.equal(next.kneeDropWalls[2], snapshot.kneeDropWalls[2]);
  assert.deepEqual(unresolved, []);
  assert.equal(JSON.stringify(snapshot), before, '元のスナップショットを書き換えない');
  assert.equal(walker.rewrite(snapshot, new Map([['df-x', 'df-y']])).snapshot, snapshot);
  const noKnee = walker.rewrite({ rooms: snapshot.rooms }, new Map([['df-old', 'df-new']]));
  assert.equal(Object.hasOwn(noKnee.snapshot, 'kneeDropWalls'), false);
  const dropped = walker.rewrite({ kneeDropWalls: snapshot.kneeDropWalls }, new Map([['df-old', null]]));
  assert.deepEqual(dropped.snapshot.kneeDropWalls[0].detailRefs, { kneeTop: 'df-old' });
  assert.deepEqual(dropped.unresolved, [{ code: 'df-old', location: 'kneeDrop', key: 'a:s:e', slot: 'kneeTop' }]);
});

test('walker（S8b-4a）: enumerate は rooms[].ceilingZones[].detailRefs の値も {location:ceilingZone, roomId, zoneId, slot} で列挙し、使用キー収集に合流する。部屋に detailRefs が無くても区画は拾う。空・空文字・非文字列は無視', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    rooms: [
      { id: 'r1', detailRefs: { floorWall: 'df-fw' }, ceilingZones: [{ id: 'z1', detailRefs: { ceilingStep: 'df-cs' } }, { id: 'z2', detailRefs: null }, { id: 'z3' }] },
      { id: 'r2', detailRefs: null, ceilingZones: [{ id: 'z4', detailRefs: { ceilingStep: 'df-cs2' } }, { id: 'z5', detailRefs: { ceilingStep: '', other: 3 } }] },
      { id: 'r3', ceilingZones: 'x' },
    ],
  };
  assert.deepEqual([...walker.enumerate(snapshot)], [
    { code: 'df-fw', location: 'room', roomId: 'r1', slot: 'floorWall' },
    { code: 'df-cs', location: 'ceilingZone', roomId: 'r1', zoneId: 'z1', slot: 'ceilingStep' },
    { code: 'df-cs2', location: 'ceilingZone', roomId: 'r2', zoneId: 'z4', slot: 'ceilingStep' },
  ]);
  assert.deepEqual([...collectUsedKeys(snapshot).detailFigure].sort(), ['df-cs', 'df-cs2', 'df-fw']);
});

test('walker（S8b-4a）: rewrite は区画の detailRefs も alias 表で書き換える。表に無い部屋・区画は同一参照・元は変えず、他の項目を保つ。to=null は据え置きで unresolved（location ceilingZone）へ', () => {
  const walker = SNAPSHOT_REF_WALKERS[DF];
  const snapshot = {
    rooms: [
      { id: 'r1', name: 'LDK', detailRefs: { floorWall: 'df-old' }, ceilingZones: [
        { id: 'z1', heightMm: 2100, detailRefs: { ceilingStep: 'df-old' } },
        { id: 'z2', heightMm: 2200, detailRefs: { ceilingStep: 'df-keep' } },
      ] },
      { id: 'r2', name: '寝室', detailRefs: null, ceilingZones: [{ id: 'z3', detailRefs: { ceilingStep: 'df-old' } }] },
      { id: 'r3', name: '納戸', detailRefs: null, ceilingZones: [{ id: 'z4', detailRefs: { ceilingStep: 'df-keep' } }] },
    ],
  };
  const before = JSON.stringify(snapshot);
  const { snapshot: next, unresolved } = walker.rewrite(snapshot, new Map([['df-old', 'df-new']]));
  assert.deepEqual(next.rooms[0].ceilingZones[0], { id: 'z1', heightMm: 2100, detailRefs: { ceilingStep: 'df-new' } }, '他の項目を保つ');
  assert.equal(next.rooms[0].ceilingZones[1], snapshot.rooms[0].ceilingZones[1], '表に無い区画は同一参照');
  assert.equal(next.rooms[0].name, 'LDK');
  assert.deepEqual(next.rooms[0].detailRefs, { floorWall: 'df-new' }, '部屋の割当てと両立する');
  assert.deepEqual(next.rooms[1].ceilingZones[0].detailRefs, { ceilingStep: 'df-new' }, '部屋に detailRefs が無くても区画は書き換わる');
  assert.equal(next.rooms[2], snapshot.rooms[2], '表に無い部屋は同一参照');
  assert.deepEqual(unresolved, []);
  assert.equal(JSON.stringify(snapshot), before, '元のスナップショットを書き換えない');
  assert.equal(walker.rewrite(snapshot, new Map([['df-x', 'df-y']])).snapshot, snapshot);
  const dropped = walker.rewrite({ rooms: snapshot.rooms }, new Map([['df-old', null]]));
  assert.deepEqual(dropped.snapshot.rooms[1].ceilingZones[0].detailRefs, { ceilingStep: 'df-old' });
  assert.deepEqual(dropped.unresolved, [
    { code: 'df-old', location: 'room', roomId: 'r1', slot: 'floorWall' },
    { code: 'df-old', location: 'ceilingZone', roomId: 'r1', zoneId: 'z1', slot: 'ceilingStep' },
    { code: 'df-old', location: 'ceilingZone', roomId: 'r2', zoneId: 'z3', slot: 'ceilingStep' },
  ]);
});

test('【失敗系】walker（S6a）: detailFigure への alias は積める（rewrite がある）。循環は従来どおり例外。applyDocumentCodeNormalization が detailRefs を書き換える', () => {
  assert.doesNotThrow(() => setDocumentAliases(DF, { 'df-1': 'df-2' }));
  const snap = { openings: [{ id: 'o1', fixtureType: 'WF', detailRefs: { jamb: 'df-1' } }] };
  assert.deepEqual(applyDocumentCodeNormalization(snap).openings[0].detailRefs, { jamb: 'df-2' });
  assert.throws(() => setDocumentAliases(DF, { 'df-1': 'df-2', 'df-2': 'df-1' }), /循環/);
  assert.doesNotThrow(() => setDocumentAliases(DF, null));
  assert.doesNotThrow(() => setDocumentAliases(DF, {}));
});

// ---- 起動時照合（S6a で rewrite を得た: 他の種別と同じく alias／propose を作る。S2 の案A は仕様変更で外れた） ----

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

test('照合①b（S6a）: ライブラリ df-A と中身が完全に同じ同梱 df-B（キー違い）は alias になり、同梱側を外して合成も通り、スナップショットの参照も df-A へ読み替わる', async () => {
  const a = detailFigure('df-A', '同じ呼称');
  const b = detailFigure('df-B', '同じ呼称');
  const { plan, result, commits } = await reconcile([a], [b]);
  assert.deepEqual(plan.aliases, [{ from: 'df-B', to: 'df-A' }]);
  assert.deepEqual(result.aliasPairs, [{ from: 'df-B', to: 'df-A' }]);
  assert.equal(result.skipped.length, 0);
  assert.equal(commits.length, 0);
  assert.deepEqual(overlayFor(DF).doc, [], '読み替えた同梱は overlay から外す（残すと合成後の重複禁止で保存が止まる）');
  assert.deepEqual([...composeCatalog(DF, []).keys()], ['df-A']);
  const snap = applyDocumentCodeNormalization({ openings: [{ id: 'o1', detailRefs: { jamb: 'df-B', head: 'df-A' } }] });
  assert.deepEqual(snap.openings[0].detailRefs, { jamb: 'df-A', head: 'df-A' });
});

test('照合①b-2（S6a）: 外した同梱 df-B を指していた同梱側の建具記号の detailFigures も df-A へ読み替わる。ライブラリ層の記号・無関係の割当ては触らない', async () => {
  const a = detailFigure('df-A', '同じ呼称');
  const b = detailFigure('df-B', '同じ呼称');
  const docWf = symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-B', [DetailSlot.HEAD]: 'df-other' } });
  const docSf = symbol('SF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-other' } });
  const docNone = symbol('SSF');
  const userWf = symbol('USR', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-B' } });
  setOverlay(FS, { doc: [docWf, docSf, docNone], user: [userWf] });
  await reconcile([a], [b]);
  const { doc, user } = overlayFor(FS);
  assert.deepEqual(doc.find(e => e.key === 'WF')[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD], { [DetailSlot.JAMB]: 'df-A', [DetailSlot.HEAD]: 'df-other' });
  assert.equal(doc.find(e => e.key === 'SF'), docSf, '当たりの無い記号は同一参照のまま');
  assert.equal(doc.find(e => e.key === 'SSF'), docNone);
  assert.deepEqual(user, [userWf], 'ライブラリ層は触らない');
});

/**
 * store.js reconcileIncomingCatalogs の種別ループ（順序は store.js の RECONCILE_KINDS を読む）を純モジュールで再現する。
 * commit はライブラリ（overlay の user）へ書く。本体（builtin）は空として扱う。
 */
async function reconcileAllInStoreOrder() {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'store.js'), 'utf8');
  const m = /const RECONCILE_KINDS = \[([^\]]*)\];/.exec(src);
  const kinds = m[1].split(',').map(s => CatalogKind[s.trim().replace('CatalogKind.', '')]);
  const plans = {};
  for (const kind of kinds) {
    const { doc, user } = overlayFor(kind);
    if (doc.length === 0 && user.length === 0) continue;
    const plan = planIncomingReconcile({ kind, docEntries: doc, appEntries: user, origins: new Map() });
    plans[kind] = plan;
    await applyReconcilePlan(plan, {
      kind, currentUser: user,
      commitUserFn: async next => { setOverlay(kind, { doc: overlayFor(kind).doc, user: next }); },
    });
  }
  return plans;
}

test('照合の順序（S6a）: 同梱の記号 WQ{jamb:df-B} がライブラリへ写される前に df-B→df-A が読み替えられ、ライブラリの WQ は df-A を指す', async () => {
  setOverlay(DF, { user: [detailFigure('df-A', '同じ呼称')], doc: [detailFigure('df-B', '同じ呼称')] });
  setOverlay(FS, { doc: [symbol('WQ', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-B' } })], user: [] });
  await reconcileAllInStoreOrder();
  const libWq = overlayFor(FS).user.find(e => e.key === 'WQ');
  assert.ok(libWq, '前提: 記号はライブラリへ写される');
  assert.deepEqual(libWq[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD], { [DetailSlot.JAMB]: 'df-A' });
});

test('照合の順序（S6a）: ライブラリに WQ{jamb:df-A} があり同梱が WQ{jamb:df-B} なら、読み替え後の記号の照合は same（通知・差分なし）', async () => {
  setOverlay(DF, { user: [detailFigure('df-A', '同じ呼称')], doc: [detailFigure('df-B', '同じ呼称')] });
  setOverlay(FS, {
    doc: [symbol('WQ', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-B' } })],
    user: [symbol('WQ', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-A' } })],
  });
  const plans = await reconcileAllInStoreOrder();
  assert.deepEqual(plans[FS].same, ['WQ']);
  assert.deepEqual(plans[FS].adoptDoc, []);
});

test('指示UI（S6a）: detailFigure の propose を承認した読み替えの組は、同梱の記号の detailFigures にも反映される（store.js applyCatalogResolutions と同じ呼び出し）', () => {
  setOverlay(FS, { doc: [symbol('WQ', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-B' } })], user: [] });
  rewriteDocSymbolDetailFigures([{ from: 'df-B', to: 'df-A' }]);
  assert.deepEqual(overlayFor(FS).doc[0][FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD], { [DetailSlot.JAMB]: 'df-A' });
});

test('【不変条件】指示UI（S6a）: store.js applyCatalogResolutions は detailFigure の alias 確定で rewriteDocSymbolDetailFigures を呼ぶ', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'store.js'), 'utf8')
    .split(/\r?\n/).filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(/pKind === CatalogKind\.DETAIL_FIGURE\)\s*rewriteDocSymbolDetailFigures\(pairs\)/.test(src));
});

test('【失敗系】照合①b-3（S6a）: alias が無い照合（呼称だけ違う等）は記号の overlay に触れない（世代も進めない）', async () => {
  const docWf = symbol('WF', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.JAMB]: 'df-B' } });
  setOverlay(FS, { doc: [docWf], user: [] });
  const gen = overlayGeneration();
  await reconcile([detailFigure('df-A', '呼称A')], [detailFigure('df-B', '呼称B')]);
  assert.equal(overlayFor(FS).doc[0], docWf);
  assert.equal(overlayGeneration(), gen + 1, 'setOverlay(DF) の 1 回だけ。記号の overlay は書き換えない');
});

test('照合②（S6a）: 部分一致（線は同じで呼称だけ違う）は propose 行になり、同梱は残る（自動では置き換えない）', async () => {
  const a = detailFigure('df-A', '呼称A');
  const b = detailFigure('df-B', '呼称B');
  const { plan, result } = await reconcile([a], [b]);
  assert.equal(plan.proposals.length, 1);
  assert.equal(plan.proposals[0].from, 'df-B');
  assert.deepEqual(plan.aliases, []);
  assert.deepEqual(plan.adds, []);
  assert.deepEqual(result.addedKeys, []);
  assert.equal(composeCatalog(DF, []).size, 2);
  const rows = buildResolveRows({ kind: DF, proposals: plan.proposals, unsupported: plan.unsupported, userEntries: [a] });
  assert.deepEqual(rows.map(r => r.scenario), ['propose']);
  assert.deepEqual(rows[0].allowedActions, ['approve', 'pick', 'addToLibrary', 'defer']);
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

test('指示UI④（S6a）: detailFigure の行の許可操作は他の種別と同じ（場面ごとの従来どおり。保留だけに絞らない）', () => {
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
  const EXPECTED = {
    'library-conflict': ['approve', 'pick', 'markOverride', 'defer'],
    'unresolved-code': ['approve', 'pick', 'defer'],
    unsupported: ['approve', 'pick', 'defer'],
    propose: ['approve', 'pick', 'addToLibrary', 'defer'],
  };
  for (const row of rows) {
    assert.deepEqual(row.allowedActions, EXPECTED[row.scenario], `${row.scenario}`);
    assert.equal(defaultResolveDecision(row).action, 'defer', `${row.scenario}: 既定の決定は保留`);
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

test('formatDetailViews（P2-3）: DetailPlacementView の順に「ラベル: 図キー」。未知キーは後ろに生で・views 無し／空はフォールバック', () => {
  assert.equal(formatDetailViews({ ceiling: 'c', front: 'a', left: 'l' }), '正面図: a・左側面図: l・見上げ図: c');
  assert.equal(formatDetailViews({ front: 'a', oblique: 'x' }), '正面図: a・oblique: x');
  assert.equal(formatDetailViews(undefined), '（未設定）');
  assert.equal(formatDetailViews({}), '（なし）');
  assert.equal(formatDetailViews(['a']), 'a');
  assert.deepEqual(Object.keys(DETAIL_PLACEMENT_VIEW_LABELS), Object.values(DetailPlacementView), '全 5 値を網羅');
});

test('formatCategoryLabel(DETAIL_FIGURE): 全 6 分類（DetailCategory の網羅）の表示名', () => {
  assert.equal(Object.values(DetailCategory).length, 6);
  assert.deepEqual(
    Object.values(DetailCategory).map(c => formatCategoryLabel(DF, c)),
    ['部位', '取り合い', '自由部位', '対の部位', '姿図', '建具一式'],
  );
  assert.equal(formatCategoryLabel(DF, DetailCategory.FITTING), '建具一式');
  assert.equal(formatCategoryLabel(DF, 'other'), 'other');
});

// ---- 建具種別（openingSubType）の任意項目 detailFigures（S6b・姿図の差し替え）----
const ST = CatalogKind.OPENING_SUB_TYPE;

function subType(key, over) {
  return { category: 'fitting', key, label: `種別${key}`, mechanism: 'swing', defaultWidth: 800, defaultHeight: 2000, ...over };
}

test('S6b 建具種別: detailFigures は knownFields・compareFields に入り matchFields には入らない。差は diffEntries に出る', () => {
  const def = kindDef(ST);
  assert.ok(def.knownFields.includes(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD));
  assert.ok(def.compareFields.includes(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD));
  assert.ok(!def.matchFields.includes(FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD));
  const a = subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-1' } });
  const b = subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-2' } });
  assert.deepEqual(diffEntries(ST, a, b), [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]);
  assert.deepEqual(diffEntries(ST, a, a), []);
  assert.deepEqual(diffEntries(ST, subType('u1'), subType('u1')), [], '割当て無しの旧形は差が出ない');
});

test('S6b 建具種別 validate: detailFigures は省略・null・オブジェクトのみ許す。参照先の有無は見ない', () => {
  const def = kindDef(ST);
  assert.doesNotThrow(() => def.validate(subType('u1')));
  assert.doesNotThrow(() => def.validate(subType('u1', { detailFigures: null })));
  assert.doesNotThrow(() => def.validate(subType('u1', { detailFigures: { [DetailSlot.FIGURE]: 'df-no-such' } })));
  assert.throws(() => def.validate(subType('u1', { detailFigures: ['df-1'] })), /建具種別エントリのdetailFiguresが不正/);
  assert.throws(() => def.validate(subType('u1', { detailFigures: 'df-1' })), /建具種別エントリのdetailFiguresが不正/);
  assert.equal(def.isSupported(subType('u1', { detailFigures: { [DetailSlot.FIGURE]: 'df-no-such' } })), true);
});

test('S6b 推移展開: 使用中の建具種別の detailFigures.figure と、その図が参照する材だけが入り、未使用の図・材は入らない', () => {
  const df1 = detailFigure('df-1', '姿図1', MAT_X);
  const df2 = detailFigure('df-2', '姿図2', MAT_Y);
  setOverlay(DF, { user: [df1, df2] });
  setOverlay(ST, { user: [subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-1' } })] });
  setOverlay(MAT, { user: [material(MAT_X), material(MAT_Y)] });
  const kinds = [MAT, ST, DF];
  const raw = new Map(kinds.map(kind => [kind, new Set()]));
  raw.get(ST).add('fitting:u1');
  const used = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(raw, resolvedAll(kinds)), resolvedAll(kinds));
  assert.deepEqual([...used.get(DF)], ['df-1']);
  assert.deepEqual([...used.get(MAT)], [MAT_X]);
  // 対照: 建具種別が使用中でなければ増えない
  const none = expandUsedDetailFiguresTransitively(new Map(kinds.map(kind => [kind, new Set()])), resolvedAll(kinds));
  assert.deepEqual([...none.get(DF)], []);
});

test('【失敗系】S6b 推移展開: 割当て先の図が解決できなくても例外にならず、キーは使用中に入る。detailFigures が壊れた建具種別は展開しない', () => {
  setOverlay(ST, { user: [
    subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-gone' } }),
    subType('u2'),
  ] });
  const kinds = [MAT, ST, DF];
  const raw = new Map(kinds.map(kind => [kind, new Set()]));
  raw.get(ST).add('fitting:u1').add('fitting:u2');
  const used = expandUsedDetailFiguresTransitively(raw, resolvedAll(kinds));
  assert.deepEqual([...used.get(DF)], ['df-gone']);
  const broken = new Map(kinds.map(kind => [kind, new Set()]));
  broken.get(ST).add('fitting:u3');
  const resolved = resolvedAll(kinds);
  resolved.get(ST).set('fitting:u3', { ...subType('u3'), detailFigures: 'df-1' });
  assert.deepEqual([...expandUsedDetailFiguresTransitively(broken, resolved).get(DF)], []);
});

test('S6b 回復後の再展開: 回収した建具種別の姿図も足し、無いものは未解決で返る', () => {
  const { df1 } = setupLibrary();
  const recovered = withEntries(emptyBundle(), ST, [
    subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-1' } }),
    subType('u2', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-gone' } }),
  ]);
  const figures = reexpandTransitiveDetailFigures(recovered, composeCatalog(DF, []));
  assert.deepEqual(bundleEntries(figures.bundle, DF), [df1]);
  assert.deepEqual([...figures.unresolvedDetailFigureKeys], ['df-gone']);
});

test('S6b 往復: 建具種別の detailFigures は文書ファイルを通って保たれる（未知項目として落ちない）', () => {
  const st = subType('u1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-1' } });
  const back = roundTripThroughDocument(withEntries(emptyBundle(), ST, [st]));
  assert.deepEqual(bundleEntries(back, ST), [st]);
});

test('S6b 照合①b-2: 外した同梱 df-B を指していた同梱側の建具種別の detailFigures.figure も df-A へ読み替わる。ライブラリ層は触らない', async () => {
  const a = detailFigure('df-A', '同じ呼称');
  const b = detailFigure('df-B', '同じ呼称');
  const docSt = subType('d1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-B' } });
  const docOther = subType('d2', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-other' } });
  const userSt = subType('l1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-B' } });
  setOverlay(ST, { doc: [docSt, docOther], user: [userSt] });
  await reconcile([a], [b]);
  const { doc, user } = overlayFor(ST);
  assert.deepEqual(doc.find(e => e.key === 'd1')[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD], { [DetailSlot.FIGURE]: 'df-A' });
  assert.equal(doc.find(e => e.key === 'd2'), docOther, '当たりの無い種別は同一参照のまま');
  assert.deepEqual(user, [userSt], 'ライブラリ層は触らない');
  // rewriteDocSymbolDetailFigures は空の表では overlay に触れない（世代も進めない）
  const gen = overlayGeneration();
  rewriteDocSymbolDetailFigures([]);
  assert.equal(overlayGeneration(), gen);
});

test('S6b 照合の順序: 同梱の建具種別 d1{figure:df-B} がライブラリへ写される前に df-B→df-A が読み替えられ、ライブラリの d1 は df-A を指す', async () => {
  setOverlay(DF, { user: [detailFigure('df-A', '同じ呼称')], doc: [detailFigure('df-B', '同じ呼称')] });
  setOverlay(ST, { doc: [subType('d1', { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: { [DetailSlot.FIGURE]: 'df-B' } })], user: [] });
  await reconcileAllInStoreOrder();
  const lib = overlayFor(ST).user.find(e => e.key === 'd1');
  assert.ok(lib, '前提: 建具種別はライブラリへ写される');
  assert.deepEqual(lib[FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD], { [DetailSlot.FIGURE]: 'df-A' });
});
