// DXF・PDF から選定した詳細図（provenance.source が 'dxf'／'pdf'）も、手描きと同じく使用中なら文書に同梱する（部分詳細図 S0・R10 の訂正）。
// 同梱しないのは下図に使った元ファイルのバイト列だけ。使用中判定の推移展開・同梱束の組み立て・文書ファイルの往復・回復後の再展開・
// ライブラリから消すときの文書への書き写しを、store.js を import せず純モジュールの組合せで検証する（detailFigureCatalog.test.js と同じ流儀）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogKind } from './catalogKinds.js';
import { setOverlay, clearOverlays, composeCatalog } from './catalogRegistry.js';
import { emptyBundle, withEntries, bundleEntries } from './catalogBundle.js';
import {
  buildDocumentBundle, expandUsedMaterialsTransitively, expandUsedDetailFiguresTransitively, reexpandTransitiveDetailFigures,
} from './usedEntries.js';
import { buildDocumentJson, parseDocumentEnvelope } from '../storage/documentFile.js';
import { ERR_DETAIL_FIGURE_NOT_FOUND } from '../error.js';
import { planRemoveUserEntry } from './catalogMaintenance.js';
import { deleteConfirmMessage } from '../ui/detailHelperForm.js';
import { figureOf, strokeOf, move, fixedLen, materialLen } from '../detail/detailTestFixtures.js';
import {
  PenDir, DetailSlot, DetailMaterialField, DetailProvenanceSource, DetailCategory, DetailView, DetailSubject,
  FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD,
} from '../core/constants.js';

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

test.afterEach(() => clearOverlays());

const figure = (key, materialCode, provenance) => figureOf(
  [strokeOf('a', [move(PenDir.RIGHT, fixedLen(20)), move(PenDir.DOWN, materialLen(materialCode, DetailMaterialField.THICKNESS, 12))])],
  { key, label: `図${key}`, provenance },
);
const material = code => ({ code, name: `材${code}`, spec: '', x: 0, y: 0, thickness: 12.5, note: '', category: 'panel' });
const symbol = (key, figures) => ({ key, label: `記号${key}`, category: 'fitting', mechanism: 'frameOnly', profile: 'solid', [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: figures });
const resolvedAll = () => new Map([MAT, FS, DF].map(k => [k, composeCatalog(k, [])]));
const rawUsed = (figureKeys = []) => new Map([[MAT, new Set()], [FS, new Set(['WF'])], [DF, new Set(figureKeys)]]);
const keysOf = bundle => bundleEntries(bundle, DF).map(e => e.key).sort();
// 平面の姿図（配置図）。views の先に正面図を持つ
const planFig = (key, views, provenance) => ({
  key, label: `図${key}`, category: DetailCategory.FIGURE, view: DetailView.PLAN, subject: DetailSubject.SANITARY, strokes: [], provenance, views,
});
const elevFig = (key, provenance) => ({
  key, label: `図${key}`, category: DetailCategory.FIGURE, view: DetailView.ELEVATION, subject: DetailSubject.SANITARY, strokes: [], provenance,
});

// store.js の saveCatalogDocument が呼ぶのと同じ関数列（詳細図の推移展開 → 材の推移展開 → 束の組み立て）
function saveBundle(resolved, raw) {
  const used = expandUsedMaterialsTransitively(expandUsedDetailFiguresTransitively(raw, resolved), resolved);
  return { used, ...buildDocumentBundle({ usedKeysByKind: used, resolvedByKind: resolved }) };
}

function setup() {
  const dxf = figure('df-dxf', MAT_DXF, DXF_PROVENANCE);
  const pen = figure('df-pen', MAT_PEN, PEN_PROVENANCE);
  setOverlay(DF, { user: [dxf, pen] });
  setOverlay(FS, { user: [symbol('WF', { [DetailSlot.JAMB]: 'df-dxf', [DetailSlot.HEAD]: 'df-pen' })] });
  setOverlay(MAT, { user: [material(MAT_DXF), material(MAT_PEN)] });
  return { dxf, pen };
}

test('同梱（保存の関数列）: DXF 由来の図を割り当てた記号の文書を保存すると、同梱束の detailFigure と材に DXF の図も手描きの図も入る。文書ファイルの往復でも戻る', () => {
  setup();
  const { used, bundle, unresolvedKeys } = saveBundle(resolvedAll(), rawUsed());
  assert.deepEqual([...used.get(DF)].sort(), ['df-dxf', 'df-pen']);
  assert.deepEqual([...used.get(MAT)].sort(), [MAT_DXF, MAT_PEN], 'DXF の図の材束縛も載る');
  assert.deepEqual(keysOf(bundle), ['df-dxf', 'df-pen']);
  assert.deepEqual(bundleEntries(bundle, DF).find(e => e.key === 'df-dxf').provenance, DXF_PROVENANCE, '出所は図に付いたまま同梱される');
  assert.equal(unresolvedKeys.size, 0);
  const env = { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle };
  const back = parseDocumentEnvelope(JSON.parse(buildDocumentJson(env))).catalogs;
  assert.deepEqual(keysOf(back), ['df-dxf', 'df-pen']);
  assert.equal(bundleEntries(back, FS)[0][FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD][DetailSlot.JAMB], 'df-dxf');
});

test('同梱: 建具個別の指定（detailRefs）から集めた使用キーの DXF の図も入る', () => {
  setup();
  const used = expandUsedDetailFiguresTransitively(rawUsed(['df-dxf']), resolvedAll());
  assert.deepEqual([...used.get(DF)].sort(), ['df-dxf', 'df-pen']);
});

test('同梱: 使用中の平面の姿図 A（DXF 由来）の views の先 B（DXF 由来の正面図）も入る', () => {
  const resolved = new Map([[DF, new Map([
    ['A', planFig('A', { front: 'B' }, DXF_PROVENANCE)], ['B', elevFig('B', DXF_PROVENANCE)],
  ])]]);
  const used = expandUsedDetailFiguresTransitively(new Map([[DF, new Set(['A'])]]), resolved);
  assert.deepEqual([...used.get(DF)].sort(), ['A', 'B']);
});

test('回収経路: 旧束にだけある DXF 由来の平面の配置図 A を回収したとき、A の views の先 B（DXF 由来の正面図）も入る', () => {
  setOverlay(DF, { user: [planFig('A', { front: 'B' }, DXF_PROVENANCE), elevFig('B', DXF_PROVENANCE)] });
  const lib = composeCatalog(DF, []);
  const recovered = withEntries(emptyBundle(), DF, [planFig('A', { front: 'B' }, DXF_PROVENANCE)]);
  const r = reexpandTransitiveDetailFigures(recovered, lib, { viewOrigins: ['A'] });
  assert.deepEqual(keysOf(r.bundle), ['A', 'B']);
  assert.equal(r.unresolvedDetailFigureKeys.size, 0);
});

test('回収経路: 回収した記号が DXF の図を指すと、ライブラリにあれば同梱へ足し、本当に無いキーだけが未解決', () => {
  setup();
  const recovered = withEntries(emptyBundle(), FS, [symbol('WF', { [DetailSlot.JAMB]: 'df-dxf', [DetailSlot.HEAD]: 'df-gone' })]);
  const r = reexpandTransitiveDetailFigures(recovered, resolvedAll().get(DF));
  assert.deepEqual(keysOf(r.bundle), ['df-dxf']);
  assert.deepEqual([...r.unresolvedDetailFigureKeys], ['df-gone']);
});

test('削除: 使用中の DXF 由来の図をライブラリから消す計画は、手描きと同じく文書へ書き写す（docAppend あり）。使用中でなければ null。確認文は共通', () => {
  setup();
  const used = new Set(['df-dxf', 'df-pen']);
  assert.equal(planRemoveUserEntry(DF, 'df-dxf', { usedKeys: used }).docAppend.key, 'df-dxf');
  assert.equal(planRemoveUserEntry(DF, 'df-dxf', { usedKeys: used }).docAppend.provenance.source, DetailProvenanceSource.DXF);
  assert.equal(planRemoveUserEntry(DF, 'df-pen', { usedKeys: used }).docAppend.key, 'df-pen');
  assert.equal(planRemoveUserEntry(DF, 'df-dxf', { usedKeys: new Set() }).docAppend, null, '使用中でなければ書き写さない');
  const msg = deleteConfirmMessage({ label: 'x', used: true, dirty: false });
  assert.ok(msg.includes('同梱へ写します'));
});

test('PDF 由来の図も同じ: 使用中なら同梱束に入り、材束縛も載り、ライブラリから消すときは文書へ書き写す', () => {
  const pdf = figure('df-pdf', MAT_PDF, PDF_PROVENANCE);
  const pen = figure('df-pen', MAT_PEN, PEN_PROVENANCE);
  setOverlay(DF, { user: [pdf, pen] });
  setOverlay(FS, { user: [symbol('WF', { [DetailSlot.JAMB]: 'df-pdf', [DetailSlot.HEAD]: 'df-pen' })] });
  setOverlay(MAT, { user: [material(MAT_PDF), material(MAT_PEN)] });
  const { used, bundle } = saveBundle(resolvedAll(), rawUsed());
  assert.deepEqual(keysOf(bundle), ['df-pdf', 'df-pen']);
  assert.deepEqual([...used.get(MAT)].sort(), [MAT_PEN, MAT_PDF]);
  assert.equal(planRemoveUserEntry(DF, 'df-pdf', { usedKeys: new Set(['df-pdf']) }).docAppend.key, 'df-pdf');
  // 回収経路（旧束の記号が PDF 由来の図を指す）でも同梱へ足される
  const recovered = withEntries(emptyBundle(), FS, [symbol('WF', { [DetailSlot.JAMB]: 'df-pdf' })]);
  const r = reexpandTransitiveDetailFigures(recovered, resolvedAll().get(DF));
  assert.deepEqual(keysOf(r.bundle), ['df-pdf']);
  assert.equal(r.unresolvedDetailFigureKeys.size, 0);
});

test('【失敗系】参照切れ: どの層にも無いキーは DXF 由来だからと黙って飛ばさず、従来どおり未解決に数える', () => {
  setup();
  const resolved = resolvedAll();
  const { bundle, unresolvedKeys } = saveBundle(resolved, rawUsed(['df-dxf', 'df-gone']));
  assert.deepEqual(keysOf(bundle), ['df-dxf', 'df-pen']);
  assert.deepEqual([...unresolvedKeys.get(DF)], ['df-gone']);
});

test('【失敗系】読み戻し: ライブラリが空の環境でも同梱から図が解決され、同梱に無いキーは図が入っていない旨の文言になる', () => {
  setup();
  const { bundle } = saveBundle(resolvedAll(), rawUsed());
  const env = { floors: [], struct: null, planes: null, site: null, info: null, bootPlaneId: null, catalogs: bundle };
  const back = parseDocumentEnvelope(JSON.parse(buildDocumentJson(env))).catalogs;
  // 別の環境（ライブラリが空）で開く
  clearOverlays();
  setOverlay(FS, { doc: bundleEntries(back, FS) });
  setOverlay(DF, { doc: bundleEntries(back, DF) });
  const df = composeCatalog(DF, []);
  assert.equal(df.has('df-dxf'), true, 'DXF 由来の図も文書の同梱から解決される');
  assert.equal(df.has('df-pen'), true);
  assert.equal(df.has('df-gone'), false);
  const msg = ERR_DETAIL_FIGURE_NOT_FOUND('WF', DetailSlot.JAMB);
  assert.match(msg, /WF の方立（縦枠）の詳細図がカタログに見つかりません/);
  assert.match(msg, /保存ファイルに図が入っていません。以前の保存か、ライブラリから削除された図です/);
});
