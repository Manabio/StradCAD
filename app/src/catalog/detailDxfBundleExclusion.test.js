// DXF 由来の詳細図（provenance.source==='dxf'）は文書に同梱しない（部分詳細図 S7a・R10）。
// 使用中判定の推移展開・同梱束の組み立て・文書ファイルの往復・回復後の再展開・読み戻しの未解決文言を、
// store.js を import せず純モジュールの組合せで検証する（detailFigureCatalog.test.js と同じ流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind } from './catalogKinds.js';
import { setOverlay, clearOverlays, composeCatalog } from './catalogRegistry.js';
import { emptyBundle, withEntries, bundleEntries } from './catalogBundle.js';
import {
  buildDocumentBundle, expandUsedMaterialsTransitively, expandUsedDetailFiguresTransitively, reexpandTransitiveDetailFigures,
  isImportedFigure,
} from './usedEntries.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../storage/documentFile.js';
import { ERR_DETAIL_FIGURE_NOT_FOUND, MSG_IMPORTED_DELETE_IN_USE } from '../error.js';
import { planRemoveUserEntry } from './catalogMaintenance.js';
import { deleteConfirmMessage } from '../ui/detailHelperForm.js';
import { figureOf, strokeOf, move, fixedLen, materialLen } from '../detail/detailTestFixtures.js';
import { PenDir, DetailSlot, DetailMaterialField, DetailProvenanceSource, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD } from '../core/constants.js';

const DF = CatalogKind.DETAIL_FIGURE;
const FS = CatalogKind.FIXTURE_SYMBOL;
const MAT = CatalogKind.MATERIAL;
const MAT_DXF = '101000000001';
const MAT_PEN = '101000000002';
const DXF_PROVENANCE = Object.freeze({ source: DetailProvenanceSource.DXF, fileName: 'a.dxf', sha256: 'ab', maker: 'M', series: 'S', licenseNote: 'n' });
const PEN_PROVENANCE = Object.freeze({ source: DetailProvenanceSource.MANUAL });
const MAT_PDF = '101000000003';
const PDF_PROVENANCE = Object.freeze({
  source: DetailProvenanceSource.PDF, fileName: 'a.pdf', sha256: 'cd', page: 3, clip: { x: 1, y: 2, w: 3, h: 4 }, scaleDenominator: 6,
  maker: 'M', series: 'S', licenseNote: 'n',
});

const EXCLUDE = { excludeImported: true }; // 同梱（saveCatalogDocument）の指定。使用中の判定では付けない

test.afterEach(() => clearOverlays());

const figure = (key, materialCode, provenance) => figureOf(
  [strokeOf('a', [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, materialLen(materialCode, DetailMaterialField.THICKNESS, 12))])],
  { key, label: `図${key}`, provenance },
);
const material = code => ({ code, name: `材${code}`, spec: '', x: 0, y: 0, thickness: 12.5, note: '', category: 'panel' });
const symbol = (key, figures) => ({ key, label: `記号${key}`, category: 'fitting', mechanism: 'frameOnly', profile: 'solid', [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: figures });
const resolvedAll = () => new Map([MAT, FS, DF].map(k => [k, composeCatalog(k, [])]));
const rawUsed = (figureKeys = []) => new Map([[MAT, new Set()], [FS, new Set(['WF'])], [DF, new Set(figureKeys)]]);

function setup() {
  const dxf = figure('df-dxf', MAT_DXF, DXF_PROVENANCE);
  const pen = figure('df-pen', MAT_PEN, PEN_PROVENANCE);
  setOverlay(DF, { user: [dxf, pen] });
  setOverlay(FS, { user: [symbol('WF', { [DetailSlot.JAMB]: 'df-dxf', [DetailSlot.HEAD]: 'df-pen' })] });
  setOverlay(MAT, { user: [material(MAT_DXF), material(MAT_PEN)] });
  return { dxf, pen };
}

test('isImportedFigure: provenance.source が "dxf" か "pdf" のときだけ真（手描き・null・欠落は偽）', () => {
  assert.equal(isImportedFigure({ provenance: DXF_PROVENANCE }), true);
  assert.equal(isImportedFigure({ provenance: PDF_PROVENANCE }), true);
  assert.equal(isImportedFigure({ provenance: PEN_PROVENANCE }), false);
  assert.equal(isImportedFigure({ provenance: null }), false);
  assert.equal(isImportedFigure({}), false);
  assert.equal(isImportedFigure(undefined), false);
});

test('同梱除外: DXF 由来の図を割り当てた記号の文書を保存しても、同梱束の detailFigure と材に DXF の図は入らず、手描きの図は入る', () => {
  const { pen } = setup();
  const resolved = resolvedAll();
  const used = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(rawUsed(), resolved, EXCLUDE), resolved);
  assert.deepEqual([...used.get(DF)], ['df-pen']);
  assert.deepEqual([...used.get(MAT)], [MAT_PEN], 'DXF の図の材束縛も載せない');
  const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved });
  assert.deepEqual(bundleEntries(bundle, DF), [pen]);
  assert.equal(unresolvedKeys.size, 0, '除外した図は未解決としても数えない（通知が出ない）');
  // 文書ファイルの往復でも DXF の図は戻ってこない
  const env = { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle };
  const back = parseDocumentEnvelope(JSON.parse(buildDocumentJson(env))).catalogs;
  assert.deepEqual(bundleEntries(back, DF).map(e => e.key), ['df-pen']);
  assert.equal(bundleEntries(back, FS)[0][FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD][DetailSlot.JAMB], 'df-dxf', '割当てのキーは文書に残る');
});

test('同梱除外: 建具個別の指定（detailRefs）から集めた使用キーに DXF の図があっても外す', () => {
  setup();
  const used = expandUsedDetailFiguresTransitively(rawUsed(['df-dxf']), resolvedAll(), EXCLUDE);
  assert.deepEqual([...used.get(DF)], ['df-pen']);
});

test('使用中の判定は除かない: 既定（excludeImported なし）では DXF の図も使用中に入り、材の推移展開にも載る（削除確認・使用中バッジ用）', () => {
  setup();
  const resolved = resolvedAll();
  const used = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(rawUsed(['df-dxf']), resolved), resolved);
  assert.deepEqual([...used.get(DF)].sort(), ['df-dxf', 'df-pen']);
  assert.deepEqual([...used.get(MAT)].sort(), [MAT_DXF, MAT_PEN]);
});

test('削除確認: 使用中の DXF 由来の図を削除しても文書へ写さず（docAppend なし）、確認文は DXF 専用。手描きの使用中は従来どおり写す', () => {
  const { dxf, pen } = setup();
  const used = new Set(['df-dxf', 'df-pen']);
  assert.equal(planRemoveUserEntry(DF, 'df-dxf', { usedKeys: used }).docAppend, null);
  assert.equal(planRemoveUserEntry(DF, 'df-pen', { usedKeys: used }).docAppend.key, 'df-pen');
  const msg = deleteConfirmMessage({ label: 'x', used: true, dirty: false, entry: dxf });
  assert.ok(msg.includes(MSG_IMPORTED_DELETE_IN_USE));
  assert.ok(!msg.includes('同梱へ写します'));
  assert.ok(deleteConfirmMessage({ label: 'x', used: true, dirty: false, entry: pen }).includes('同梱へ写します'));
});

test('PDF 由来の図も同じ（R10）: 同梱は除外し、使用中の判定は除かず、削除は文書へ写さず確認文で告げる', () => {
  const pdf = figure('df-pdf', MAT_PDF, PDF_PROVENANCE);
  const pen = figure('df-pen', MAT_PEN, PEN_PROVENANCE);
  setOverlay(DF, { user: [pdf, pen] });
  setOverlay(FS, { user: [symbol('WF', { [DetailSlot.JAMB]: 'df-pdf', [DetailSlot.HEAD]: 'df-pen' })] });
  setOverlay(MAT, { user: [material(MAT_PDF), material(MAT_PEN)] });
  const resolved = resolvedAll();
  const excluded = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(rawUsed(), resolved, EXCLUDE), resolved);
  assert.deepEqual([...excluded.get(DF)], ['df-pen']);
  assert.deepEqual([...excluded.get(MAT)], [MAT_PEN], 'PDF の図の材束縛も載せない');
  const inUse = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(rawUsed(), resolved), resolved);
  assert.deepEqual([...inUse.get(DF)].sort(), ['df-pdf', 'df-pen'], '使用中の判定は除かない');
  const used = new Set(['df-pdf', 'df-pen']);
  assert.equal(planRemoveUserEntry(DF, 'df-pdf', { usedKeys: used }).docAppend, null);
  const msg = deleteConfirmMessage({ label: 'x', used: true, dirty: false, entry: pdf });
  assert.ok(msg.includes(MSG_IMPORTED_DELETE_IN_USE));
  assert.ok(!msg.includes('同梱へ写します'));
  const recovered = withEntries(emptyBundle(), FS, [symbol('WF', { [DetailSlot.JAMB]: 'df-pdf' })]);
  assert.deepEqual(bundleEntries(reexpandTransitiveDetailFigures(recovered, resolved.get(DF)).bundle, DF), [], '回復後の再展開でも足さない');
});

test('回復後の再展開: 回収した記号が DXF の図を指しても、同梱へ足さず未解決にも数えない', () => {
  setup();
  const recovered = withEntries(emptyBundle(), FS, [symbol('WF', { [DetailSlot.JAMB]: 'df-dxf', [DetailSlot.HEAD]: 'df-gone' })]);
  const r = reexpandTransitiveDetailFigures(recovered, resolvedAll().get(DF));
  assert.deepEqual(bundleEntries(r.bundle, DF), []);
  assert.deepEqual([...r.unresolvedDetailFigureKeys], ['df-gone'], '本当に無いキーだけが未解決');
});

test('読み戻し: ライブラリに DXF の図が無い環境では参照先が見つからず、未解決の行の文言が DXF 由来の図は保存ファイルに入らないと伝える', () => {
  setup();
  const resolved = resolvedAll();
  const used = expandUsedDetailFiguresTransitively(rawUsed(), resolved, EXCLUDE);
  const { bundle } =buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved });
  const env = { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle };
  const back = parseDocumentEnvelope(JSON.parse(buildDocumentJson(env))).catalogs;
  // 別の環境（ライブラリが空）で開く
  clearOverlays();
  setOverlay(FS, { doc: bundleEntries(back, FS) });
  setOverlay(DF, { doc: bundleEntries(back, DF) });
  const df = composeCatalog(DF, []);
  assert.equal(df.has('df-dxf'), false);
  assert.equal(df.has('df-pen'), true);
  const msg = ERR_DETAIL_FIGURE_NOT_FOUND('WF', DetailSlot.JAMB);
  assert.match(msg, /WF の方立（縦枠）の詳細図がカタログに見つかりません/);
  assert.match(msg, /DXF・PDF 由来の図は保存ファイルに入らないため、別の端末では見つかりません/);
});
