// 給排水モード（図面モードのテンプレートの最初の例。S9）: メーカー配布の DXF 2 製品を、部分詳細図ヘルパーの画面操作に配線された関数だけで
// 詳細図として登録し（便器＝平面・正面・左側面の 3 図／手洗器＝平面・正面・側面の 3 図）、1 階の便所に配置した試験用 .stq を書く probe。
// 製品コードは変えない。サンプルの DXF はリポジトリへ置かない（引数のパスから読む。信頼できないデータとして扱い、読むだけ）。
//
// 画面操作との対応（ui/DetailHelperPanel.jsx が呼ぶ関数をそのまま通す。画面に無い近道は使わない）:
//   DXF／PDF を開く＝loadDxf／単位＝setDxfUnit／レイヤ on/off＝toggleDxfLayer／プレビューの矩形ドラッグ＝setPickRect／メーカー・シリーズ＝setDxfProvenanceField／
//   ［下書きへ写す］＝draftFromDxf（便器は「図面の原点を基準点にする」＝atDrawingOrigin:true）→ 下書きの履歴・差し替え＝draftDocOf／
//   呼称・分類・向き・主題＝label 入力・setClassification／［90° 回転］＝rotateDraft90（canRotateDraft のときだけ）／［基準点を指す］＝previewVertexPoints→nearestPointWithin→rebaseOrigin／
//   製品情報＝setProductField／図の束＝placementViewOptions（選択肢に出るか）→setPlacementView／保存＝validation→saveBlockers→entryFromForm→planSave→saveDecision→applyCatalogEditPlan。
//   配置（図面モードのパネル）＝placeFigure（平面タップ）→updatePlacedFigureWithUndo（X・Y・高さ・［90° 回転］と同じ patch）。
// 省いた前処理: (1) 画面のタップ・ドラッグ座標→図座標の換算（figurePointToMm・pickRectFromDrag）は通さず、図座標の矩形・点を直接渡す。
//   (2) 保存の saveFn は IndexedDB の代わりにバイト数を数えるだけ（applyCatalogEditPlan→commitUserEntries→encodeCatalogBundle までは通る）。
//   (3) 文書の同梱は、保存ボタンの先にある文書保存（store.js saveCatalogDocument）と同じ部品（collectUsedKeysByKind・expandUsedDetailFiguresTransitively・
//   buildDocumentBundle）を、詳細図の 1 種別だけに絞って通す（store.js は Node から引けない）。
//   (4) 文書保存との違い: 使った図は 1 階だけから集める（保存は全階）・元の文書の同梱の詳細図は残して足す（保存は使った分で置き換える）・aliases は渡さない。
//   結果は保存の上位集合で、配置した 2 製品の見え方は変わらない。
//   (5) 配置の備考・回転は updatePlacedFigureWithUndo の patch で入れる（画面は setPlacedFigureNote・rotatePlacedFigureWithUndo。最終の状態は同じ）。
//
// 使い方: cd app && node --import ./scripts/testSetup.mjs scripts/probe/makePlumbingSampleDoc.mjs --toilet-dir <便器 DXF のフォルダ> --handwash <手洗器 DXF> [--src D:/tatsuya/Download/moku4.stq] [--out D:/tatsuya/Download/plumbing-sample-test.stq]
//   便器のフォルダに G310869-C1.dxf（平面）・-C2.dxf（正面）・-C4.dxf（左側面）がある前提。既存ファイルは上書きしない（再生成は先に削除する）。
import fs from 'node:fs';
import crypto, { webcrypto } from 'node:crypto';
import path from 'node:path';
import { serializeGraph, decodeFloorSnapshot } from '../../src/graphSnapshot.js';
import { buildDocumentJson } from '../../src/storage/documentFile.js';
import { emptyBundle, withEntries, bundleEntries } from '../../src/catalog/catalogBundle.js';
import { CatalogKind } from '../../src/catalog/catalogKinds.js';
import { setOverlay, clearOverlays, overlayFor, docDiffMap, composeCatalog } from '../../src/catalog/catalogRegistry.js';
import { applyCatalogEditPlan } from '../../src/catalog/catalogMaintenance.js';
import { collectUsedKeysByKind, expandUsedDetailFiguresTransitively, buildDocumentBundle } from '../../src/catalog/usedEntries.js';
import { detailFigureCatalog, detailFigureEntry } from '../../src/openings/openingCatalog.js';
import { detailBuiltinFigures, fitLocal } from '../../src/detail/detailPlacement.js';
import { sha256HexWith } from '../../src/detail/dxf/dxfProvenance.js';
import {
  loadDxf, setDxfUnit, toggleDxfLayer, dxfLayerRows, setDxfProvenanceField, draftFromDxf, draftDocOf, dxfWarningTexts,
  setClassification, canRotateDraft, rotateDraft90, previewPrimitivesOf, rebaseOrigin, setProductField, setPlacementView,
  placementViewOptions, validation, saveBlockers, entryFromForm, planSave, saveDecision, docContextFor,
  DETAIL_PLACEMENT_VIEW_LABELS,
} from '../../src/ui/detailHelperForm.js';
import { setPickRect, pickSummaryOf, previewVertexPoints, nearestPointWithin } from '../../src/ui/detailHelperPick.js';
import { placedFigureTargets, placedFigureBelongsTo } from '../../src/finish/placedFigure/placedFigureTargets.js';
import { collectPlacedFigureFailures } from '../../src/finish/placedFigure/placedFigureFitCheck.js';
import { placeFigure, updatePlacedFigureWithUndo, roundPlacedFigurePoint } from '../../src/finish/placedFigure/placedFigureCommands.js';
import { placedFigureRows } from '../../src/finish/placedFigure/placedFigureModePanelRows.js';
import { placedFigureRoomNameLookup } from '../../src/finish/placedFigure/placedFigureRooms.js';
import { PLACED_FIGURE_MODE_REGISTRY } from '../../src/core/placedFigureModes.js';
import { placedFigureDrawPlan } from '../../src/renderer/placedFigureDrawPlan.js';
import { buildRoomFaces } from '../../src/elevation/elevationFaces.js';
import { appendPlacedFigures } from '../../src/elevation/elevationPlacedFigures.js';
import {
  DetailCategory, DetailView, DetailSubject, DetailPlacementView, DetailProductField, DETAIL_VIEWS_FIELD,
} from '../../src/core/constants.js';
import { DETAIL_PRODUCT_TEXT } from '../../src/error.js';
import { loadDocument } from './loadDoc.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const toiletDir = argOf('--toilet-dir', null);
const handwashPath = argOf('--handwash', null);
const srcPath = argOf('--src', 'D:/tatsuya/Download/moku4.stq');
const outPath = argOf('--out', 'D:/tatsuya/Download/plumbing-sample-test.stq');
if (!toiletDir || !handwashPath) { console.error('--toilet-dir と --handwash を指定してください'); process.exit(1); }
if (fs.existsSync(outPath)) { console.error(`既存ファイルを上書きしません: ${outPath}`); process.exit(1); }

let failed = false;
const check = (ok, msg) => { if (ok) console.log(`OK: ${msg}`); else { console.error(`NG: ${msg}`); failed = true; } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
// DXF の円・円弧は頂点列へ分割されるので、図ごとの外形（頂点の外接）は DXF の解析上の外接や別の図の外形と 0.02 mm 前後ずれる。比較は 0.05 mm の許容で行い、最大の差を最後に出す。
const TOL_ARC = 0.05;
let maxArcDiff = 0;
const nearArc = (a, b) => { maxArcDiff = Math.max(maxArcDiff, Math.abs(a - b)); return Math.abs(a - b) <= TOL_ARC; };
const r1 = v => Math.round(v * 100) / 100;
const KIND = CatalogKind.DETAIL_FIGURE;
const digest = sha256HexWith(webcrypto.subtle);

// ================================================================
// 取込み: 図 1 枚ぶんを「画面で押す順」に通す
// ================================================================
const trace = []; // 通した関数の列（報告用）
const t = (name, detail = '') => trace.push(`${name}${detail ? `（${detail}）` : ''}`);

/** 成分の外接（選択した成分の合併。scene の座標＝s は右・t は下向き正）。DXF の実測。 */
function selectionBox(dxf) {
  const comps = dxf.scene.components.filter(c => dxf.selected.includes(c.index));
  return {
    n: comps.length, strokes: comps.reduce((a, c) => a + c.strokes.length, 0),
    minS: Math.min(...comps.map(c => c.bbox.minS)), maxS: Math.max(...comps.map(c => c.bbox.maxS)),
    minT: Math.min(...comps.map(c => c.bbox.minT)), maxT: Math.max(...comps.map(c => c.bbox.maxT)),
  };
}

/** fit 済みの図の s・t の範囲と頂点数（配置の fit と同じ placedFigureTargets→fitLocal）。 */
function fittedRange(entry) {
  const tg = placedFigureTargets(entry);
  if (tg.error) throw new Error(`placedFigureTargets: ${tg.error.message}`);
  const f = fitLocal(entry, tg.targets);
  if (f.error) throw new Error(`fitLocal: ${f.error.message}`);
  const pts = f.strokes.flatMap(s => s.points);
  return {
    minS: Math.min(...pts.map(p => p.s)), maxS: Math.max(...pts.map(p => p.s)),
    minT: Math.min(...pts.map(p => p.t)), maxT: Math.max(...pts.map(p => p.t)), strokes: f.strokes.length, points: pts.length,
  };
}

async function openDxf(file, { unit = null, hideLayers = [] }) {
  const r = await loadDxf({ bytes: new Uint8Array(fs.readFileSync(file)), fileName: path.basename(file), digest });
  if (!r.ok) throw new Error(`loadDxf: ${r.message}`);
  let dxf = r.dxf;
  t('loadDxf', path.basename(file));
  if (unit !== null) { const u = setDxfUnit(dxf, unit); if (u.error) throw new Error(u.error); dxf = u.dxf; t('setDxfUnit', unit); }
  for (const name of hideLayers) {
    if (!dxfLayerRows(dxf).some(row => row.name === name)) throw new Error(`レイヤ ${name} がありません`);
    const l = toggleDxfLayer(dxf, name);
    if (l.error) throw new Error(l.error);
    dxf = l.dxf;
    t('toggleDxfLayer', `${name} を off`);
  }
  return dxf;
}

/**
 * 1 図を作って保存する。spec:
 *   dxf（読込み状態）・rect（図座標の矩形。省略は全成分を囲む）・atDrawingOrigin・label・view（PLAN|ELEVATION）・rotate（［90° 回転］を押すか）・
 *   baseAt（［基準点を指す］で指す頂点の DXF 座標 {s,t}。省略は指さない）・product（{name,maker,modelNumber}）・views（{front,right} の保存済みキー）・keyPart。
 */
async function makeFigure(spec) {
  const log = [];
  let dxf = spec.dxf;
  let rect = spec.rect;
  if (!rect) {
    const all = dxf.scene.components;
    const m = 1;
    const minS = Math.min(...all.map(c => c.bbox.minS)) - m, maxS = Math.max(...all.map(c => c.bbox.maxS)) + m;
    const minT = Math.min(...all.map(c => c.bbox.minT)) - m, maxT = Math.max(...all.map(c => c.bbox.maxT)) + m;
    rect = { x: minS, y: minT, w: maxS - minS, h: maxT - minT };
  }
  dxf = setPickRect(dxf, rect);
  t('setPickRect', `x=${r1(rect.x)} y=${r1(rect.y)} w=${r1(rect.w)} h=${r1(rect.h)}`);
  const summary = pickSummaryOf(dxf);
  const box = selectionBox(dxf);
  if (box.n === 0) throw new Error(`${spec.label}: 矩形に成分が入りません`);
  dxf = setDxfProvenanceField(dxf, 'maker', spec.maker ?? '');
  if (spec.series) dxf = setDxfProvenanceField(dxf, 'series', spec.series);
  t('setDxfProvenanceField', 'maker/series');
  const warnings = dxfWarningTexts(dxf);

  const drafted = draftFromDxf({ dxf, idFactory: () => spec.keyPart, atDrawingOrigin: spec.atDrawingOrigin === true });
  if (drafted.error) throw new Error(`${spec.label}: ${drafted.error}`);
  t('draftFromDxf', `atDrawingOrigin:${spec.atDrawingOrigin === true}`);
  let doc = draftDocOf(drafted.form); // replaceDoc(draftDocOf(r.form))
  const edit = fn => { doc = { ...doc, form: fn(doc.form) }; };
  edit(f => ({ ...f, label: spec.label })); t('label 入力');
  edit(f => setClassification(f, 'category', DetailCategory.FIGURE)); t('setClassification', '分類=姿図');
  edit(f => setClassification(f, 'view', spec.view)); t('setClassification', `向き=${spec.view}`);
  edit(f => setClassification(f, 'subject', DetailSubject.SANITARY)); t('setClassification', '主題=衛生器具');
  if (spec.rotate) {
    if (!canRotateDraft(doc.form)) throw new Error(`${spec.label}: 回せない図です`);
    edit(f => rotateDraft90(f)); t('rotateDraft90', '［90° 回転］1 回');
  }
  let basePicked = null;
  if (spec.baseAt) {
    // 画面では頂点をタップする。タップ点は図座標（下書きは基準点 P が原点＝DXF 座標 − P）。スナップ半径は拡大中の 1 mm 相当を使う。
    const P = drafted.basePoint;
    const pts = previewVertexPoints(previewPrimitivesOf(doc.form));
    const hit = nearestPointWithin(pts, { x: spec.baseAt.s - P.s, y: spec.baseAt.t - P.t }, 1);
    if (!hit) throw new Error(`${spec.label}: 基準点にする頂点 (${spec.baseAt.s},${spec.baseAt.t}) が見つかりません`);
    basePicked = { s: hit.x + P.s, t: hit.y + P.t };
    // 狙った頂点の最寄りの別の頂点までの距離（タップで取り違えないために要る拡大の目安。距離の 1/2 より内側をタップする必要がある）
    const nearestOther = Math.min(...pts.filter(q => q.x !== hit.x || q.y !== hit.y).map(q => Math.hypot(q.x - hit.x, q.y - hit.y)));
    console.log(`基準点 ${spec.label}: 頂点 (${r1(basePicked.s)},${r1(basePicked.t)}) の最寄りの別の頂点まで ${r1(nearestOther)} mm（プレビューの頂点 ${pts.length} 個）`);
    edit(f => rebaseOrigin(f, { s: hit.x, t: hit.y }));
    t('rebaseOrigin', `頂点 (${r1(basePicked.s)},${r1(basePicked.t)})`);
  }
  if (spec.product) {
    for (const [field, value] of Object.entries(spec.product)) edit(f => setProductField(f, field, value));
    t('setProductField', Object.keys(spec.product).join('/'));
  }
  if (spec.views) {
    const catalog = [...detailFigureCatalog().values()];
    for (const [view, key] of Object.entries(spec.views)) {
      const opts = placementViewOptions(doc.form, catalog, view);
      if (!opts.some(o => o.value === key)) throw new Error(`${spec.label}: 図の束 ${view} の選択肢に ${key} が出ません`);
      edit(f => setPlacementView(f, view, key));
    }
    t('placementViewOptions→setPlacementView', Object.keys(spec.views).join('/'));
  }
  // 保存
  const form = doc.form;
  const result = validation(form); t('validation');
  const blockers = saveBlockers(form, result); t('saveBlockers');
  if (!result.ok || blockers.length > 0) throw new Error(`${spec.label}: 保存できません: ${blockers.join(' / ')}`);
  const entry = entryFromForm(form); t('entryFromForm');
  const plan = planSave(entry, null, docContextFor(KIND, { overlayFor, docDiffMap, builtinList: detailBuiltinFigures })); t('planSave');
  const decision = saveDecision(plan); t('saveDecision');
  if (!decision.apply || decision.confirmMessage) throw new Error(`${spec.label}: 保存の判定: ${decision.message}`);
  let savedBytes = 0;
  await applyCatalogEditPlan(KIND, plan, { saveFn: async (_k, bytes) => { savedBytes = bytes.length; }, markDirty: () => {} });
  t('applyCatalogEditPlan', `${savedBytes} bytes`);
  const range = fittedRange(entry);
  return { entry, form, box, summary, warnings, range, basePicked, drafted: drafted.basePoint, log };
}

const rangeText = r => `s ${r1(r.minS)}..${r1(r.maxS)}・t ${r1(r.minT)}..${r1(r.maxT)}`;
const table = [];
function record(name, spec, made) {
  const e = made.entry;
  const views = e[DETAIL_VIEWS_FIELD] ? Object.entries(e[DETAIL_VIEWS_FIELD]).map(([k, v]) => `${k}=${v}`).join(',') : '-';
  const line = `${name} | 元=${spec.source} | 絞り=${spec.how} | 基準点=${spec.base} | 回転=${spec.rotate ? '時計回り90°' : 'なし'} | 外形 ${rangeText(made.range)} | 成分=${made.box.n} ストローク=${made.range.strokes} 頂点=${made.range.points} | 欄=${spec.slot}${views !== '-' ? ` views[${views}]` : ''}`;
  table.push(line);
  console.log(`図: ${line}`);
  console.log(`   key=${e.key} label=${e.label} category=${e.category} view=${e.view} subject=${e.subject} 警告=[${made.warnings.join(' / ')}]`);
}

// ---- 前準備: 入力文書と overlay ----
const { project, doc } = loadDocument(srcPath);
const plane = project.planes.find(p => p.name === '1階') ?? project.planes[0];
const graph = project.graphMap.get(plane.id);
check(graph.placedFigures.length === 0, `${plane.name} の placedFigures は空から始まる`);
const existing = doc.catalogs ?? emptyBundle();
const existingDetail = bundleEntries(existing, KIND);
clearOverlays();
setOverlay(KIND, { doc: existingDetail, user: [] });

// 往復を先に確かめる: 読み→（何も足さず）書き→読みで、階の数・部屋の数・文書のバイト列の解釈が一致すること
{
  const tmp = `${outPath}.roundtrip.tmp`;
  try {
    const floors0 = doc.floors.map(f => ({ planeId: f.planeId, bytes: serializeGraph(project.graphMap.get(f.planeId)) }));
    fs.writeFileSync(tmp, buildDocumentJson({ floors: floors0, struct: doc.struct, planes: doc.planes, site: doc.site, info: doc.info, bootPlaneId: doc.bootPlaneId ?? plane.id, catalogs: existing }));
    const rt = loadDocument(tmp);
    check(rt.project.planes.length === project.planes.length, `往復: 階の数が一致（${project.planes.length}）`);
    const same = project.planes.every(p => rt.project.graphMap.get(p.id).rooms.length === project.graphMap.get(p.id).rooms.length);
    check(same, `往復: 全階の部屋の数が一致（${project.planes.map(p => project.graphMap.get(p.id).rooms.length).join(',')}）`);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

// ================================================================
// 便器（TOTO 腰掛式便器 G310869）: 図面の原点（壁の面の中心・床。3 図に共通）を基準点にする。C1＝平面・C2＝正面・C4＝左側面（＝キー right）。
// ================================================================
const TOILET = { name: '腰掛式便器', maker: 'TOTO', modelNumber: 'G310869' };
const toiletFile = n => path.join(toiletDir, `G310869-${n}.dxf`);
const KEY = {
  toiletFront: 'sample-g310869-front', toiletRight: 'sample-g310869-leftside',
  toiletPlan: 'sample-g310869-plan', hwFront: 'sample-uld26-front', hwSide: 'sample-uld26-side', hwPlan: 'sample-uld26-plan',
};
// 保存した図のキー（keyPart は newDraft が 'df-' を付ける）
const FIG = Object.fromEntries(Object.entries(KEY).map(([k, v]) => [k, `df-${v}`]));
const toiletBase = { atDrawingOrigin: true, maker: 'TOTO', series: 'ネオレスト' };
const toiletViewOf = async (file, hideLayers) => openDxf(file, { hideLayers });

const toiletFrontDxf = await toiletViewOf(toiletFile('C2'), ['A']);
const toiletFrontSpec = { ...toiletBase, dxf: toiletFrontDxf, label: '便器 G310869 正面', view: DetailView.ELEVATION, keyPart: KEY.toiletFront };
const toiletFront = await makeFigure(toiletFrontSpec);
record('便器 正面(C2)', { source: 'G310869-C2.dxf', how: 'レイヤ A off・全成分を矩形で囲む', base: '図面の原点(0,0)', rotate: false, slot: `${DETAIL_PLACEMENT_VIEW_LABELS.front}（key front）の図` }, toiletFront);

const toiletSideDxf = await toiletViewOf(toiletFile('C4'), ['A']);
const toiletSide = await makeFigure({ ...toiletBase, dxf: toiletSideDxf, label: '便器 G310869 左側面', view: DetailView.ELEVATION, keyPart: KEY.toiletRight });
record('便器 左側面(C4)', { source: 'G310869-C4.dxf', how: 'レイヤ A off・全成分を矩形で囲む', base: '図面の原点(0,0)', rotate: false, slot: `${DETAIL_PLACEMENT_VIEW_LABELS.right}（key right）の図` }, toiletSide);

const toiletPlanDxf = await toiletViewOf(toiletFile('C1'), ['A']);
const toiletPlan = await makeFigure({
  ...toiletBase, dxf: toiletPlanDxf, label: '便器 G310869 平面', view: DetailView.PLAN, keyPart: KEY.toiletPlan, rotate: true,
  product: { [DetailProductField.NAME]: TOILET.name, [DetailProductField.MAKER]: TOILET.maker, [DetailProductField.MODEL_NUMBER]: TOILET.modelNumber },
  views: { [DetailPlacementView.FRONT]: FIG.toiletFront, [DetailPlacementView.RIGHT]: FIG.toiletRight },
});
record('便器 平面(C1)', { source: 'G310869-C1.dxf', how: 'レイヤ A off・全成分を矩形で囲む', base: '図面の原点(0,0)', rotate: true, slot: `平面の配置図（製品情報 名称/メーカー/型番）` }, toiletPlan);

// ================================================================
// 手洗器（TOTO 壁埋込型手洗器 ULD26）: 1 枚に 3 面図（第三角法: 正面の上に平面・左に側面）＋図枠・表題欄・部屋の輪郭。矩形で 1 面ずつ絞る。
//   絞りの根拠（実測）: 部屋の輪郭（幅 1220×高 2050 の正面・幅 1220×奥 750 の平面・奥 750×高 2050 の側面）は外接が矩形より大きいので窓選択で外れ、
//   器具（幅 310・正面高 1045・壁から前へ 100＋壁の中へ 90）だけが入る。平面の円（外径 約 200・壁から 約 380）は視点マーク（ブロック 1_SYS_VIEWMARK_LKATTE_DISP。図の向きの記号で製品の形ではない）なので含めない。
//   基準点（頂点を指す。壁の面×左端×床の 1 点は 3 図で別の頂点になるため、s は 3 図で同じ s=3235、t は壁の面か床の最寄りの頂点）:
//     平面 (3235,-4150)＝器具の左端(+5)の壁の面／正面 (3235,-705)＝同じ s の床より 5 上の下端／側面 (500,-705)＝壁の面の下端（床より 5 上）。
// ================================================================
const HW = { name: '壁埋込型手洗器', maker: 'TOTO', modelNumber: 'ULD26' };
const hwDxf0 = await openDxf(handwashPath, { unit: '1' });
const hwBase = { dxf: hwDxf0, atDrawingOrigin: false, maker: 'TOTO' };
const hwFront = await makeFigure({
  ...hwBase, label: '手洗器 ULD26 正面', view: DetailView.ELEVATION, keyPart: KEY.hwFront,
  rect: { x: 3225, y: -1755, w: 320, h: 1060 }, baseAt: { s: 3235, t: -705 },
});
record('手洗器 正面', { source: 'HR03US630_ZU11.dxf', how: '矩形 x3225 y-1755 w320 h1060', base: '頂点 (3235,-705)', rotate: false, slot: `${DETAIL_PLACEMENT_VIEW_LABELS.front}（key front）の図` }, hwFront);
const hwSide = await makeFigure({
  ...hwBase, label: '手洗器 ULD26 左側面', view: DetailView.ELEVATION, keyPart: KEY.hwSide,
  rect: { x: 400, y: -1755, w: 210, h: 1060 }, baseAt: { s: 500, t: -705 },
});
record('手洗器 側面', { source: 'HR03US630_ZU11.dxf', how: '矩形 x400 y-1755 w210 h1060', base: '頂点 (500,-705)', rotate: false, slot: `${DETAIL_PLACEMENT_VIEW_LABELS.right}（key right）の図` }, hwSide);
const hwPlan = await makeFigure({
  ...hwBase, label: '手洗器 ULD26 平面', view: DetailView.PLAN, keyPart: KEY.hwPlan,
  rect: { x: 3225, y: -4245, w: 320, h: 200 }, baseAt: { s: 3235, t: -4150 },
  product: { [DetailProductField.NAME]: HW.name, [DetailProductField.MAKER]: HW.maker, [DetailProductField.MODEL_NUMBER]: HW.modelNumber },
  views: { [DetailPlacementView.FRONT]: FIG.hwFront, [DetailPlacementView.RIGHT]: FIG.hwSide },
});
record('手洗器 平面', { source: 'HR03US630_ZU11.dxf', how: '矩形 x3225 y-4245 w320 h200', base: '頂点 (3235,-4150)', rotate: false, slot: '平面の配置図（製品情報 名称/メーカー/型番）' }, hwPlan);

// 取込みの形の確認（DXF の実測から手で計算した外形と、取込み後の fit の外形を突き合わせる）
// 便器 C1 は時計回り 90°: s' = −t・t' = s（基準点が原点＝(0,0)）。C2・C4 は回さない。
check(toiletFront.box.n > 0 && nearArc(toiletFront.range.minS, toiletFront.box.minS) && nearArc(toiletFront.range.maxS, toiletFront.box.maxS)
  && nearArc(toiletFront.range.minT, toiletFront.box.minT) && nearArc(toiletFront.range.maxT, toiletFront.box.maxT), '便器 正面: 取込み後の外形＝DXF の外形（原点基準・回転なし）');
check(nearArc(toiletSide.range.minS, toiletSide.box.minS) && nearArc(toiletSide.range.maxS, toiletSide.box.maxS)
  && nearArc(toiletSide.range.minT, toiletSide.box.minT) && nearArc(toiletSide.range.maxT, toiletSide.box.maxT), '便器 左側面: 取込み後の外形＝DXF の外形');
check(nearArc(toiletPlan.range.minS, -toiletPlan.box.maxT) && nearArc(toiletPlan.range.maxS, -toiletPlan.box.minT)
  && nearArc(toiletPlan.range.minT, toiletPlan.box.minS) && nearArc(toiletPlan.range.maxT, toiletPlan.box.maxS), '便器 平面: 取込み後の外形＝DXF の外形を時計回り 90°（s=−t・t=s）');
check(toiletPlan.range.minT > 0 && toiletPlan.range.maxT > 600, `便器 平面: 正面（先端）が +t（図の下）を向く（t ${r1(toiletPlan.range.minT)}..${r1(toiletPlan.range.maxT)}）`);
const hwShift = (made, base) => nearArc(made.range.minS, made.box.minS - base.s) && nearArc(made.range.maxS, made.box.maxS - base.s)
  && nearArc(made.range.minT, made.box.minT - base.t) && nearArc(made.range.maxT, made.box.maxT - base.t);
check(hwShift(hwFront, { s: 3235, t: -705 }), '手洗器 正面: 取込み後の外形＝DXF の外形−基準点(3235,-705)');
check(hwShift(hwSide, { s: 500, t: -705 }), '手洗器 側面: 取込み後の外形＝DXF の外形−基準点(500,-705)');
check(hwShift(hwPlan, { s: 3235, t: -4150 }), '手洗器 平面: 取込み後の外形＝DXF の外形−基準点(3235,-4150)');
check(hwFront.box.n === 31 && hwSide.box.n === 16 && hwPlan.box.n === 10, `手洗器の絞り込みの成分数（正面 ${hwFront.box.n}・側面 ${hwSide.box.n}・平面 ${hwPlan.box.n}）＝実測の 31・16・10`);
check(hwFront.drafted.s === 3230 && hwPlan.drafted.s === 3230, '手洗器: 下書きへ写した基準点 P は外接の左下（s=3230）。そのあと基準点を指して付け替えた');

// ================================================================
// 配置: 1 階の便所（moku4 の 1 階。壁の面は buildRoomFaces の faceValue＝内側の壁の面）
// ================================================================
const toiletRoom = graph.rooms.find(r => r.name === '便所');
const faceRows = buildRoomFaces(toiletRoom, graph);
const faceOf = (faces, letter) => faces.find(f => f.letter === letter);
for (const f of faceRows) console.log(`便所の面 ${f.letter}: faceValue=${f.faceValue} lo=${f.lo} hi=${f.hi} hasRealWall=${f.hasRealWall} inward=${f.inward}`);
const fA = faceOf(faceRows, 'A'), fB = faceOf(faceRows, 'B'), fC = faceOf(faceRows, 'C'), fD = faceOf(faceRows, 'D');
check(faceRows.length === 4 && [fA, fB, fC, fD].every(f => f && f.hasRealWall), '便所の 4 面に実壁がある（壁の面の座標が使える）');
// 便器: 背中を北の壁（A）へ。回転 0＝正面が +y（南）。基準点は壁の面の中心＝y は A の壁の面そのもの。
//   x は、取込み後の平面の外形（s −378.3..193＝DXF の t −193..378.3 から手計算）の中央が部屋の幅の中央に来るよう置く。
const planBodyMidS = (-toiletPlan.box.maxT + -toiletPlan.box.minT) / 2; // 時計回り 90°: s' = −t
const roomMidX = (fB.faceValue + fD.faceValue) / 2;
//   配置点は画面と同じ 1 mm 丸め（roundPlacedFigurePoint）を通す。moku4 の壁の面は x.5 なので、丸めで 0.5 mm 壁からずれる（期待値は丸めた後の点で計算する）。
const TOILET_AT = roundPlacedFigurePoint(roomMidX - planBodyMidS, fA.faceValue);
// 手洗器: 東の壁（B）に背中を向ける。回転 90＝正面が −x（西）・図の s が +y（南）へ伸びる。基準点＝左端の壁の面（局所 s=0）。
//   置く y は、便器（A の壁の面から 700.7 まで）と重ならない A の壁の面 + 900。z は基準点（床より 5 上の頂点）を指したので 5。
const HW_AT = { ...roundPlacedFigurePoint(fB.faceValue, fA.faceValue + 900), z: 5 };
check(fC.faceValue - fA.faceValue > 1200, `便所の奥行き（${fC.faceValue - fA.faceValue}）が便器の奥行き 700.7＋手洗器の置き場より大きい`);

placeFigure(graph, { id: 'pf-toilet', figureKey: FIG.toiletPlan, x: TOILET_AT.x, y: TOILET_AT.y });
updatePlacedFigureWithUndo(graph, 'pf-toilet', { note: '便器 G310869 北壁・正面＝南' });
placeFigure(graph, { id: 'pf-handwash', figureKey: FIG.hwPlan, x: HW_AT.x, y: HW_AT.y });
updatePlacedFigureWithUndo(graph, 'pf-handwash', { rotationDeg: 90, zMm: HW_AT.z, note: '手洗器 ULD26 東壁・正面＝西' });
console.log(`配置: 便器 (${TOILET_AT.x},${TOILET_AT.y}) 回転0 z0／手洗器 (${HW_AT.x},${HW_AT.y}) 回転90 z${HW_AT.z}`);
check(graph.placedFigures.length === 2, '1 階の配置 2 件（placeFigure・updatePlacedFigureWithUndo）');

// ---- 保存（文書の同梱は保存ボタンの先と同じ部品を詳細図 1 種別に絞って通す）----
const snapshot = decodeFloorSnapshot(serializeGraph(graph));
const resolvedByKind = new Map([[KIND, composeCatalog(KIND, detailBuiltinFigures)]]);
const usedByKind = expandUsedDetailFiguresTransitively(collectUsedKeysByKind([snapshot], [KIND]), resolvedByKind);
const { bundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind: usedByKind, resolvedByKind });
check(unresolvedKeys.size === 0, '同梱: 使用中の詳細図がすべて解決できる');
const bundled = bundleEntries(bundle, KIND);
const bundledKeys = bundled.map(e => e.key).sort();
console.log(`同梱の詳細図 ${bundled.length} 図: ${bundledKeys.join(',')}`);
check(Object.values(FIG).every(k => bundledKeys.includes(k)), '同梱に 6 図（平面 2＋views が引く正面・側面 4）が入る（推移展開）');
const detailEntries = [...existingDetail.filter(f => !bundled.some(n => n.key === f.key)), ...bundled];
const catalogs = withEntries(existing, KIND, detailEntries);
const floors = doc.floors.map(f => (f.planeId === plane.id ? { planeId: f.planeId, bytes: serializeGraph(graph) } : f));
const json = buildDocumentJson({ floors, struct: doc.struct, planes: doc.planes, site: doc.site, info: doc.info, bootPlaneId: doc.bootPlaneId ?? plane.id, catalogs });
fs.writeFileSync(outPath, json);
const buf = fs.readFileSync(outPath);
console.log('wrote', outPath, buf.length, 'bytes sha256', crypto.createHash('sha256').update(buf).digest('hex'));

// ================================================================
// 読み戻して検証（往復・平面・展開・パネルの行）。overlay は文書の同梱だけにして（user 空）、ファイルの中身だけで解決できることを見る。
// ================================================================
const { project: P, doc: D } = loadDocument(outPath);
const G = P.graphMap.get(plane.id);
check(G.placedFigures.length === 2, `読み戻した 1 階の placedFigures 2 件（${G.placedFigures.length}）`);
check(G.placedFigures.every((p, i) => JSON.stringify(p.toData()) === JSON.stringify(graph.placedFigures[i].toData())), '配置の全項目が往復で一致する');
check(P.planes.every(p => p.id === plane.id || P.graphMap.get(p.id).placedFigures.length === 0), '他の階の placedFigures は 0 件のまま');
const figs = D.catalogs?.catalogs?.[KIND] ?? [];
check(Object.values(FIG).every(k => figs.some(f => f.key === k)), '読み戻した同梱の詳細図に 6 図が入っている');
check(P.planes.length === project.planes.length && P.planes.every(p => P.graphMap.get(p.id).rooms.length === project.graphMap.get(p.id).rooms.length), '読み戻した階の数・部屋の数が元と一致');
clearOverlays();
setOverlay(KIND, { doc: figs, user: [] });
check(collectPlacedFigureFailures(G.placedFigures).length === 0, '図を配置先に合わせられない通知（placedFigureFitCheck）が 0 件');

// ---- 平面（給排水モードと同じ subjects＝衛生だけを渡す。この文書に衛生以外の配置は無いので、絞りそのものの検証は単体テスト renderer/placedFigureDrawPlan.subjects.test.js）----
const plumbingSubjects = PLACED_FIGURE_MODE_REGISTRY.defOf('plumbing').subjects;
check(plumbingSubjects.length === 1 && plumbingSubjects[0] === DetailSubject.SANITARY, `給排水モードの分類は衛生だけ（${plumbingSubjects.join(',')}）`);
const down = placedFigureDrawPlan(G.placedFigures, detailFigureEntry, { direction: 'down', subjects: plumbingSubjects });
const linesOf = id => down.lines.filter(l => l.figureId === id);
const boxOf = id => down.boxes.find(b => b.figureId === id);
console.log(`見下げ: lines=${down.lines.length} marks=${down.marks.length} boxes=${down.boxes.length}`);
for (const b of down.boxes) console.log(`見下げの外接 ${b.figureId}: x ${r1(b.minX)}..${r1(b.maxX)} y ${r1(b.minY)}..${r1(b.maxY)}`);
check(down.marks.length === 0, '解決できない配置（印）が無い');
check(linesOf('pf-toilet').length > 0 && linesOf('pf-handwash').length > 0, `見下げは 2 件とも線がある（便器 ${linesOf('pf-toilet').length}・手洗器 ${linesOf('pf-handwash').length}）`);
check(linesOf('pf-toilet').length === toiletPlan.range.strokes && linesOf('pf-handwash').length === hwPlan.range.strokes, '見下げの線数＝取込んだストローク数');
// 期待値は DXF の外形と配置の点・回転から手計算: 便器（回転 0）＝(X+s', Y+t')・s'=−t_dxf・t'=s_dxf／手洗器（回転 90）＝(X−t', Y+s')・s'=s_dxf−3235・t'=t_dxf+4150
const tb = toiletPlan.box;
const wantToilet = { minX: TOILET_AT.x - tb.maxT, maxX: TOILET_AT.x - tb.minT, minY: TOILET_AT.y + tb.minS, maxY: TOILET_AT.y + tb.maxS };
const hb = hwPlan.box;
const wantHw = { minX: HW_AT.x - (hb.maxT + 4150), maxX: HW_AT.x - (hb.minT + 4150), minY: HW_AT.y + (hb.minS - 3235), maxY: HW_AT.y + (hb.maxS - 3235) };
const sameBox = (a, w) => nearArc(a.minX, w.minX) && nearArc(a.maxX, w.maxX) && nearArc(a.minY, w.minY) && nearArc(a.maxY, w.maxY);
check(boxOf('pf-toilet') && sameBox(boxOf('pf-toilet'), wantToilet), `便器の外接＝手計算 x ${r1(wantToilet.minX)}..${r1(wantToilet.maxX)} y ${r1(wantToilet.minY)}..${r1(wantToilet.maxY)}`);
check(boxOf('pf-handwash') && sameBox(boxOf('pf-handwash'), wantHw), `手洗器の外接＝手計算 x ${r1(wantHw.minX)}..${r1(wantHw.maxX)} y ${r1(wantHw.minY)}..${r1(wantHw.maxY)}`);
// 物理: 壁の面に対して正しい側
const bT = boxOf('pf-toilet'), bH = boxOf('pf-handwash');
check(bT.minY - fA.faceValue >= 0 && bT.minY - fA.faceValue <= 10, `便器の壁側の端は北の壁の面に接する（壁の面 ${fA.faceValue} から ${r1(bT.minY - fA.faceValue)} mm 室内側）`);
check(bT.maxY < fC.faceValue && bT.maxY - fA.faceValue > 650, `便器の先端（y ${r1(bT.maxY)}）は部屋の内側（南の壁の面 ${fC.faceValue} より手前）で、壁から 650 mm 超出ている`);
check(bT.minX > fD.faceValue && bT.maxX < fB.faceValue, `便器は東西の壁の面の間に収まる（x ${r1(bT.minX)}..${r1(bT.maxX)} ／ 壁の面 ${fD.faceValue}..${fB.faceValue}）`);
const wallThicknessB = Math.abs(fB.axisCL.effectiveValue - fB.faceValue) * 2; // 壁芯から壁の面までの 2 倍（芯振り分けの壁厚）
check(nearArc(fB.faceValue - bH.minX, 100 - (HW_AT.x - fB.faceValue)) && nearArc(bH.maxX - HW_AT.x, 90),
  `手洗器は東の壁の面から室内へ 約100（${r1(fB.faceValue - bH.minX)}）・壁の中へ 約90（${r1(bH.maxX - fB.faceValue)}。壁厚 ${wallThicknessB} の内側）`);
check(bH.maxX - fB.faceValue > 0 && bH.maxX - fB.faceValue < wallThicknessB, '手洗器の壁の中へ入る部分（背面側）は壁厚の中に収まる（壁芯振り分けの壁厚で見積もり）');
check(bH.minY > bT.maxY && bH.maxY < fC.faceValue, `手洗器は便器の先端（y ${r1(bT.maxY)}）より南・南の壁の面より北に収まる（y ${r1(bH.minY)}..${r1(bH.maxY)}）`);

// ---- 展開（便所の 4 面）----
// 面の左右の向き（手計算）: A 北の壁＝東が右（x−lo）／B 東の壁＝南が右（y−lo）／C 南の壁＝西が右（hi−x）／D 西の壁＝北が右（hi−y）。
const localOf = (f, pt) => ({ A: pt.x - f.lo, B: pt.y - f.lo, C: f.hi - pt.x, D: f.hi - pt.y })[f.letter];
const worldAlong = (f, xl) => ({ A: f.lo + xl, B: f.lo + xl, C: f.hi - xl, D: f.hi - xl })[f.letter];
// 図ごとの外形（取込み後の fit。DXF から手で出した値と上で一致確認済み）
const fig = { front: toiletFront.range, right: toiletSide.range, hwFront: hwFront.range, hwRight: hwSide.range };
// 期待: 便器（正面＝南）A=正面・B=right の図（左側面図）・C=背面（図なし→0）・D=left（図なし→right の図の鏡像）／手洗器（正面＝西）A=left（right の図の鏡像）・B=正面・C=right の図・D=背面（0）
const expectFace = {
  'pf-toilet': { A: { r: fig.front, flip: false }, B: { r: fig.right, flip: false }, C: null, D: { r: fig.right, flip: true } },
  'pf-handwash': { A: { r: fig.hwRight, flip: true }, B: { r: fig.hwFront, flip: false }, C: { r: fig.hwRight, flip: false }, D: null },
};
const placedAt = { 'pf-toilet': { x: TOILET_AT.x, y: TOILET_AT.y, z: 0 }, 'pf-handwash': { x: HW_AT.x, y: HW_AT.y, z: HW_AT.z } };
const roomG = G.rooms.find(r => r.name === '便所');
const facesG = buildRoomFaces(roomG, G);
const allPlaced = [...G.placedFigures];
const elevRows = [];
for (const id of Object.keys(expectFace)) {
  G.setPlacedFigures(allPlaced.filter(p => p.id === id)); // 1 件ずつ出して図ごとに照合する（読み戻した graph のメモリ上だけ）
  for (const face of facesG) {
    const prims = [];
    appendPlacedFigures(prims, { face, room: roomG, graph: G, figureOf: detailFigureEntry, floorDyAt: () => 0 });
    const xs = prims.flatMap(p => (p.type === 'polyline' ? p.points.map(q => q[0]) : [p.x1, p.x2]));
    const ys = prims.flatMap(p => (p.type === 'polyline' ? p.points.map(q => q[1]) : [p.y1, p.y2]));
    const exp = expectFace[id][face.letter];
    const row = { id, letter: face.letter, n: prims.length, xMin: Math.min(...xs), xMax: Math.max(...xs), yMin: Math.min(...ys), yMax: Math.max(...ys) };
    elevRows.push(row);
    console.log(`展開 ${id} 面${face.letter}: 線数=${row.n} 面x=${row.n ? `${r1(row.xMin)}..${r1(row.xMax)}` : '-'} y=${row.n ? `${r1(row.yMin)}..${r1(row.yMax)}` : '-'} 世界${face.isVertical ? 'y' : 'x'}=${row.n ? `${r1(Math.min(worldAlong(face, row.xMin), worldAlong(face, row.xMax)))}..${r1(Math.max(worldAlong(face, row.xMin), worldAlong(face, row.xMax)))}` : '-'}`);
    if (exp === null) { check(row.n === 0, `展開 ${id} 面${face.letter}: 背面（図なし）は出ない`); continue; }
    const pt = placedAt[id];
    const x0 = localOf(face, pt);
    const lo = x0 + (exp.flip ? -exp.r.maxS : exp.r.minS);
    const hi = x0 + (exp.flip ? -exp.r.minS : exp.r.maxS);
    const yLo = -pt.z + exp.r.minT, yHi = -pt.z + exp.r.maxT; // 展開は FL が y=0・上が負。floorDyAt=0
    check(row.n > 0 && near(row.xMin, lo) && near(row.xMax, hi), `展開 ${id} 面${face.letter}: x の範囲＝手計算 ${r1(lo)}..${r1(hi)}（${exp.flip ? 'right の図の鏡像で代用' : '図そのまま'}）`);
    check(near(row.yMin, yLo) && near(row.yMax, yHi), `展開 ${id} 面${face.letter}: 高さの範囲＝手計算 ${r1(yLo)}..${r1(yHi)}（z=${pt.z}・図の t ${r1(exp.r.minT)}..${r1(exp.r.maxT)}）`);
  }
}
G.setPlacedFigures(allPlaced);
// 平面の外接と展開の世界座標を突き合わせる（幅・奥行きを見せる面）
const worldRange = (row, face) => { const a = worldAlong(face, row.xMin), b = worldAlong(face, row.xMax); return { lo: Math.min(a, b), hi: Math.max(a, b) }; };
const rowOf = (id, letter) => elevRows.find(r => r.id === id && r.letter === letter);
const faceG = letter => faceOf(facesG, letter);
{
  const wc = worldRange(rowOf('pf-toilet', 'A'), faceG('A'));
  console.log(`突合 便器 面A（正面図・幅）: 展開の世界 x ${r1(wc.lo)}..${r1(wc.hi)} ／ 平面の外接 x ${r1(bT.minX)}..${r1(bT.maxX)}（左端の差 ${r1(bT.minX - wc.lo)}）`);
  // 左端の差は DXF の実測から手計算: 平面の左端＝−（C1 の t の最大）・正面図の左端＝C2 の s の最小。正面図にだけ、止水栓の本体より外へ出る形がある
  const wantLeftGap = (-toiletPlan.box.maxT) - toiletFront.box.minS;
  check(nearArc(wc.hi, bT.maxX) && nearArc(bT.minX - wc.lo, wantLeftGap), `便器 面A: 正面図の世界 x の右端＝平面の外接の右端・左端は正面図のほうが ${r1(wantLeftGap)} mm 広い（DXF の実測どおり）`);
  const wb = worldRange(rowOf('pf-toilet', 'B'), faceG('B'));
  console.log(`突合 便器 面B（左側面図・奥行き）: 展開の世界 y ${r1(wb.lo)}..${r1(wb.hi)} ／ 平面の外接 y ${r1(bT.minY)}..${r1(bT.maxY)}（先端の差 ${r1(wb.hi - bT.maxY)}）`);
  check(nearArc(wb.lo, bT.minY) && Math.abs(wb.hi - bT.maxY) <= 1.0,'便器 面B: 左側面図の世界 y＝平面の外接（先端の差は 1 mm 以内）');
  const wd = worldRange(rowOf('pf-toilet', 'D'), faceG('D'));
  check(near(wd.lo, wb.lo) && near(wd.hi, wb.hi), '便器 面D: 鏡像で代用した側面の世界 y＝面B と同じ（左右対称の代用でも前後は壁→先端のまま）');
  const hb2 = worldRange(rowOf('pf-handwash', 'B'), faceG('B'));
  check(nearArc(hb2.lo, bH.minY) && nearArc(hb2.hi, bH.maxY), `手洗器 面B: 正面図の世界 y ${r1(hb2.lo)}..${r1(hb2.hi)}＝平面の外接 y ${r1(bH.minY)}..${r1(bH.maxY)}`);
  const ha = worldRange(rowOf('pf-handwash', 'A'), faceG('A'));
  const hc = worldRange(rowOf('pf-handwash', 'C'), faceG('C'));
  check(nearArc(ha.lo, bH.minX) && nearArc(ha.hi, bH.maxX) && nearArc(hc.lo, bH.minX) && nearArc(hc.hi, bH.maxX),`手洗器 面A・面C: 側面図の世界 x（${r1(ha.lo)}..${r1(ha.hi)}）＝平面の外接 x ${r1(bH.minX)}..${r1(bH.maxX)}`);
}

// ---- 図面モードのパネルの行 ----
const placedInMode = G.placedFigures.filter(p => placedFigureBelongsTo(p, detailFigureEntry, plumbingSubjects));
const rows = placedFigureRows(placedInMode, detailFigureEntry, placedFigureRoomNameLookup(G));
for (const r of rows) console.log(`パネルの行 ${r.id}: title=${r.title} 項目=${r.productLines.map(l => `${l.label}:${l.value}`).join('／')} 部屋=${r.roomName} x=${r.x} y=${r.y} z=${r.zMm} 回転=${r.rotationDeg}`);
check(rows.length === 2, 'パネルの行が 2 件');
const labelsWant = [DETAIL_PRODUCT_TEXT[DetailProductField.NAME], DETAIL_PRODUCT_TEXT[DetailProductField.MAKER], DETAIL_PRODUCT_TEXT[DetailProductField.MODEL_NUMBER]];
check(rows.every(r => r.productLines.map(l => l.label).join() === labelsWant.join()), `各行に 名称・メーカー・型番 の 3 項目（色は入れていないので出ない）`);
const rowT = rows.find(r => r.id === 'pf-toilet'), rowH = rows.find(r => r.id === 'pf-handwash');
check(rowT.productLines.map(l => l.value).join() === [TOILET.name, TOILET.maker, TOILET.modelNumber].join() && rowH.productLines.map(l => l.value).join() === [HW.name, HW.maker, HW.modelNumber].join(), '行の項目の値が入れた製品情報どおり');
check(rows.every(r => r.roomName === '便所'), `どちらの行も部屋名は「便所」（${rows.map(r => r.roomName).join(',')}）`);
check(rowH.zMm === 5 && rowH.rotationDeg === 90 && rowT.rotationDeg === 0 && rowT.zMm === 0, '行の 高さ・向き が配置どおり（手洗器 z5・90°／便器 z0・0°）');
clearOverlays();
console.log(`許容 ${TOL_ARC} mm の比較（円弧の分割による差）での最大の差: ${maxArcDiff.toFixed(4)} mm`);

console.log('--- 通した関数の列（図ごとに順に）---');
console.log(trace.join(' → '));
if (failed) process.exit(1);
console.log('ALL OK');
