import { createContext, useContext } from 'react';
import { runInAction, reaction } from 'mobx';
import {
  Project, CenterLineType, Discipline,
  HDimensionLine, VDimensionLine, DimensionKind, DimensionSide,
} from '@core';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import {
  deleteFloor as dbDeleteFloor, clearAllStores, loadFloor, saveFloor, savePlanesMeta, loadPlanesMeta,
  saveSiteData, loadSiteData, saveProject, loadProject, saveProjectInfo, loadProjectInfo,
  seedFloorsFromDocument, commitFloorsToDocument, loadAllSavedFloors, saveSavedFloor,
  saveDocumentCatalog, saveDocumentCatalogs, loadDocumentCatalogs, loadUserCatalogs, saveUserCatalog,
} from './storage/db.js';
import { buildDocumentJson, parseDocumentEnvelope } from './storage/documentFile.js';
import { encodeProjectInfo, decodeProjectInfo } from './storage/projectInfo.js';
import { clearDirty, markDirty } from './dirtyState.js';
import { acquireSessionLock } from './storage/sessionLock.js';
import { SpatialIndex } from './transform/SpatialIndex.js';
import {
  serializePlanes, decodePlanes, serializeSite, decodeSite, restoreSite, decodeFloorSnapshot,
  serializeGraph, restoreGraph,
} from './graphSnapshot.js';
import { reconcilePlanes } from './floorOps.js';
import { clearLocalAutosave } from './storage/localSnapshot.js';
import { refreshWallsAllFloors } from './wallRefresh.js';
import { ERR_CATALOG_DUPLICATE } from './error.js';
import { CatalogKind, kindDef, KIND_LABELS } from './catalog/catalogKinds.js';
import { composeCatalog, clearOverlays, overlayFor, removeDocEntry } from './catalog/catalogRegistry.js';
import { decodeCatalogBundle, encodeCatalogBundle } from './catalog/catalogCodec.js';
import { mergeBundles, splitBundleByKind, resolveCatalog, resolveOrigins, detectLibraryConflicts } from './catalog/catalogBundle.js';
import {
  collectUsedKeysByKind, expandUsedMaterialsTransitively, buildDocumentBundle,
  recoverUnresolvedEntries, reexpandTransitiveMaterials,
} from './catalog/usedEntries.js';
import {
  clearDocumentAliases, currentDocumentAliases, takeUnresolvedCodes, addDocumentAliases,
} from './catalog/codeNormalization.js';
import { loadCatalogOverlaysFromIDB as applyCatalogOverlays } from './catalog/catalogOverlayLoader.js';
import { planIncomingReconcile, formatReconcileNotice, applyReconcilePlan } from './catalog/incomingReconcile.js';
import { commitUserEntries, upsertUserCatalogEntry } from './catalog/catalogMaintenance.js';
import { buildResolveRows, applyResolveDecisions, replaceRowsByScenario } from './catalog/resolveQueue.js';
import { REMOVED_MATERIALS } from './catalog/legacyMaterialCodes.js';

// ----------------------------------------------------------------
// ID の永続化
//
// planeId / projectId はセッションをまたいで同じ IDB キーを使うため
// localStorage に保存して再利用する。
// ----------------------------------------------------------------
const PROJECT_ID_KEY = 'strad-project-id';
const PLANE_ID_KEY   = 'strad-plane-0-id';
const SAVED_FLAG_KEY = 'strad-saved';

let savedProjectId = localStorage.getItem(PROJECT_ID_KEY);
if (!savedProjectId) {
  savedProjectId = crypto.randomUUID();
  localStorage.setItem(PROJECT_ID_KEY, savedProjectId);
}

let activePlaneId = localStorage.getItem(PLANE_ID_KEY);
if (!activePlaneId) {
  activePlaneId = crypto.randomUUID();
  localStorage.setItem(PLANE_ID_KEY, activePlaneId);
}

// ----------------------------------------------------------------
// プロジェクト・プレーン・グラフの初期化
// ----------------------------------------------------------------
export const project = new Project(savedProjectId, '新規プロジェクト');
const { plane, graph } = project.addPlane(0, '1階', activePlaneId, 1, 1);

// ----------------------------------------------------------------
// デフォルト初期状態
//
// 通り芯 → project.structGraph（全階共通）
// 寸法線 → フロアグラフ（階固有）
// setupStructGraph / activate が IndexedDB に保存済みデータがあれば上書きする
// ----------------------------------------------------------------
const clProps = { discipline: Discipline.STRUCT };
project.structGraph.addCenterLine(CenterLineType.VERTICAL,   0, clProps);
project.structGraph.addCenterLine(CenterLineType.HORIZONTAL, 0, clProps);

graph.addBackingMaterial('木下地', 60, 90);

/**
 * 新規フロアの既定寸法線（GRID/CENTER × 4周）を追加する。
 * addFloor/addAlternativeFloor（ユーザー操作による新規フロア）と restorePlanesFromIDB
 * （floors ストアに保存データを持たない復元後の plane）の双方から呼ばれる。
 */
function addDefaultDimensionLines(graph) {
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.TOP    });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.LEFT   });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.GRID, side: DimensionSide.RIGHT  });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.TOP    });
  graph.addDimensionLine(HDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.BOTTOM });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.LEFT   });
  graph.addDimensionLine(VDimensionLine, { dimensionKind: DimensionKind.CENTER, side: DimensionSide.RIGHT  });
}

addDefaultDimensionLines(graph);

// ----------------------------------------------------------------
// 空間インデックス（R-Tree）— 頂点の高速検索
//
// CL.value 変化時（bake 後）に自動再構築される。
// ドラッグ中は pendingDelta が変化するが cl.value は不変なため、再構築は起きない。
// project.activeGraph（アクティブ階）を追従する — フロア切替後もスナップ用インデックスが
// アクティブ階を指すようにするため、ブート時の graph に静的束縛してはならない。
// ----------------------------------------------------------------
export const spatialIndex = new SpatialIndex();

reaction(
  () => project.activeGraph?.centerLines.map(cl => cl.value) ?? null,
  () => {
    const activeGraph = project.activeGraph;
    if (!activeGraph) return; // フロア切替の遷移中など、瞬間的に未定義になり得るための防御
    spatialIndex.rebuild(activeGraph.intersections);
  },
  { fireImmediately: true },
);

// ----------------------------------------------------------------
// IndexedDB 起動時初期化 + auto-save 開始
//
// floors ストアは「セッション作業領域」——階切替のスワップアウト（deactivate）が
// 明示保存の有無に関わらず無条件に書き込む。起動のたびに、明示保存済みプロジェクトなら
// 保存ドキュメント（savedFloors）の内容で floors を必ず作り直す（seedFloorsFromDocument）。
// 前回セッションの「未保存のままスワップアウトされた編集」はここで消える——
// 「明示保存した内容だけが次回起動で復元される」一貫した意味論にするため
// （設計意図は .claude/persistence-idb.md 参照）。
// 明示保存が一度も行われていない場合のみ、起動時に全ストア（全階のフロアデータ・
// 通り芯・構造情報など）を削除して白紙から開始する。
// ----------------------------------------------------------------
/**
 * plane 一覧（全階・検討・屋根平面のメタデータ）を IndexedDB から復元し、project.planeMap /
 * project.graphMap / project.activePlaneId へ反映する。
 * 保存文書が無ければ（未保存の新規プロジェクト等）何もせず、起動時の初期1階のままにする。
 * 通り芯（structGraph）の復元完了後・フロアの activate 前に呼ぶこと（下記IIFE参照）。
 */
async function restorePlanesFromIDB() {
  const bytes = await loadPlanesMeta(savedProjectId);
  const metas = bytes ? decodePlanes(bytes) : null;
  const existingIds = [...project.planeMap.keys()];
  const result = reconcilePlanes(metas, existingIds, plane.id);
  if (!result) return; // 文書なし

  // floors ストアに bytes を持たない（＝一度も保存されなかった）復元plane は
  // addFloor/addAlternativeFloor と同様に既定寸法線を補う必要があるため、
  // runInAction の外で先に判定しておく（IDB 読み取りは非同期）。
  const toAddWithBytes = await Promise.all(
    result.toAdd.map(async m => ({ meta: m, hasBytes: (await loadFloor(m.id)) != null })),
  );

  runInAction(() => {
    for (const { meta: m, hasBytes } of toAddWithBytes) {
      const { graph: newGraph } = project.addPlane(
        m.elevation, m.name, m.id, m.startFloor, m.stories,
        m.isAlternative, m.referenceId, m.altIndex, m.isRoofPlane, m.roofForPlaneId,
      );
      if (!hasBytes) addDefaultDimensionLines(newGraph);
    }
    for (const m of result.toUpdate) {
      const p = project.planeMap.get(m.id);
      if (!p) continue;
      p.elevation      = m.elevation;
      p.name           = m.name;
      p.startFloor     = m.startFloor;
      p.stories        = m.stories;
      p.isAlternative  = m.isAlternative;
      p.referenceId    = m.referenceId;
      p.altIndex       = m.altIndex;
      p.isRoofPlane    = m.isRoofPlane;
      p.roofForPlaneId = m.roofForPlaneId;
    }
    for (const id of result.toRemove) project.removePlane(id);
    if (result.activePlaneId) project.activePlaneId = result.activePlaneId;
  });
}

/**
 * 敷地（project.site）を IndexedDB から復元する。
 * 保存文書が無ければ何もせず、起動時の初期状態（空の Site）のままにする。
 * 不変条件: bootReady 以外から呼んではならない（restoreSite 参照）。
 */
async function restoreSiteFromIDB() {
  const bytes = await loadSiteData(savedProjectId);
  if (!bytes) return; // 文書なし
  restoreSite(project.site, decodeSite(bytes));
}

/**
 * 調査・計画情報（project.projectInfo = 敷地情報／建築情報ダイアログの入力値）を
 * IndexedDB から復元する。保存文書が無ければ何もせず、初期状態（null=未入力）のままにする。
 */
async function restoreProjectInfoFromIDB() {
  const bytes = await loadProjectInfo(savedProjectId);
  if (!bytes) return; // 文書なし
  const info = decodeProjectInfo(bytes);
  runInAction(() => {
    project.setSiteInfo(info.siteInfo);
    project.setBuildingInfo(info.buildingInfo);
  });
}

/**
 * IndexedDB からカタログ束（文書同梱・ステップ7cで material のみから BUNDLED_KINDS 全種別へ
 * 拡張／ユーザーライブラリ）を読み、
 * catalog/catalogRegistry.js の overlay として設定する薄いラッパー。実体（decode/validate・
 * 未知種別の除外・部分適用防止・setOverlay失敗時の全clear）は catalog/catalogOverlayLoader.js
 * （葉。store.js を import しない）に持つ——store.js は起動時副作用が大きく単体テストに向かないため、
 * その本体だけ切り出して import なしで検証できるようにしてある（catalogOverlayLoader.test.js）。
 * ここでは db.js の関数と project.setCatalogError を注入するだけ。
 *
 * 壊れたレコードがあっても bootReady 自体は失敗させない——materialError と同じ経路で
 * project.catalogError にメッセージを載せてトースト通知し、overlay は一切立てない。
 * 加えて project.catalogOverlayUntrusted を true にする（2026-09-22 再QA指摘Major-D）——
 * こちらは保存ガード専用の boolean で、store.js saveCatalogDocument はこれだけを見て
 * 文書同梱の保存をスキップする（catalogError はメッセージ通知専用にし、両者を兼用しない）。
 *
 * floorSwapManager.setupStructGraph（の呼び出し）・最初の restoreGraph
 * （floorSwapManager.activate 内）より前に呼ぶこと——composeCatalog は overlay が立って
 * いない状態では builtin のみで解決するため、ここより後に呼ぶと文書同梱・ユーザーライブラリの
 * 材が読込み直後の壁生成・照合に反映されない。
 *
 * @param {{ loadDocumentCatalogsFn?: () => Promise<Array<{kind,bytes}>>,
 *           loadUserCatalogsFn?: () => Promise<Array<{kind,bytes}>> }} [overrides]
 *        db.js の関数を差し替えるための注入口（省略時は本物）。
 */
export async function loadCatalogOverlaysFromIDB({
  loadDocumentCatalogsFn = () => loadDocumentCatalogs(savedProjectId),
  loadUserCatalogsFn = loadUserCatalogs,
} = {}) {
  await applyCatalogOverlays({
    loadDocumentCatalogs: loadDocumentCatalogsFn,
    loadUserCatalogs: loadUserCatalogsFn,
    onError: (msg) => {
      project.setCatalogOverlayUntrusted(true);
      project.setCatalogError(msg);
    },
  });
}

/**
 * 起動時の同梱カタログ照合の対象種別（ステップ6-1は material 単独だったが、ステップ7dで
 * 内装マスター・境界マスターへ、ステップ8fで断面（section）へ、ステップ10dで建具種別
 * （openingSubType）へ一般化した——BUNDLED_KINDS（同梱の一般化。ステップ7c→8f→10d）と
 * 同じ5種別）。
 */
const RECONCILE_KINDS = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER, CatalogKind.SECTION, CatalogKind.OPENING_SUB_TYPE];

/**
 * 起動時の同梱カタログ照合（ステップ6-1→ステップ7d: 種別ループへ一般化）。loadCatalogOverlaysFromIDB
 * が立てた overlay（catalog/catalogRegistry.js の overlayFor(kind)）の doc（文書同梱）を、
 * アプリ側（user＋builtin。doc は含まない）と catalog/incomingReconcile.js の
 * planIncomingReconcile/applyReconcilePlan で種別ごとに照合する。内装マスター・境界マスターは
 * compareFields=matchFields（段を外さない）のため classifyIncoming が 'propose' を返すことは
 * 構造的に無い（完全一致のみ。incomingReconcile.test.js で固定）。
 *
 * RECONCILE_KINDS を1種別ずつ処理する。種別ごとに doc・userとも空なら照合するものも
 * 場面(a)library-conflictの検出対象も無いためスキップする（不変条件7-1の一般化: builtin の
 * 動的import＝kindDef(kind).loadBuiltin() は新規文書の起動では読まない。6-1 QA Minor1の維持）。
 * 種別ごとの失敗（builtinの動的import失敗・commitUserFnのreject等）はその種別だけ握り、他の
 * 種別の処理は継続する——bootReady 自体は失敗させない（materialError と同じ割り切り）。
 * 通知文は種別ごとの formatReconcileNotice(plan, { kind, addedCount, skippedCount }) を集め、
 * 全種別ぶんを「。」で連結して project.setCatalogError を最後に1回だけ呼ぶ（null は集めない
 * ——通知するものが無いのに空メッセージでトーストを出さないため）。
 *
 * ステップ6-3: 指示UI（catalog/resolveQueue.js）の行のうち、場面(a)library-conflict・
 * (c)unsupported・proposeはdoc単独の有無ではなく（(a)はuser⇔builtinの衝突検出でdocと無関係の
 * ため）ここで種別ごとに組み立てる。project.setCatalogResolveRows への反映は全種別の行を集めてから
 * ループの外で replaceRowsByScenario を1回だけ呼ぶ（他検出元の行・保留中の行を種別またぎで
 * 消さないため）。場面(b)unresolved-codeはここでは分からない（floor未読込みのため）——
 * modes/FinishModeState.js init が担当し、catalog/resolveQueue.js replaceRowsByScenario で
 * 自分の場面の行だけを置き換える。
 */
export async function reconcileIncomingCatalogs() {
  // 通知は「成功時の内容通知」と「種別ごとの失敗」を分けて集め、最後に失敗分を先頭に寄せて
  // 1本の文へ連結する（Minor-3・2026-09-23 QA指摘: 利用者が先に失敗を目にできるようにする）。
  const successNotices = [];
  const failureNotices = [];
  const rowsByKind = [];

  for (const kind of RECONCILE_KINDS) {
    const { doc, user } = overlayFor(kind);
    // 種別ごとにdoc・userとも空なら照合するものも場面(a)library-conflictの検出対象も無い
    // （不変条件7-1: 本体標準マスタは新規文書の起動では読まない。6-1 QA Minor1の退行防止）。
    if (doc.length === 0 && user.length === 0) continue;

    let plan = { proposals: [], unsupported: [] };
    try {
      const builtinList = await kindDef(kind).loadBuiltin();
      let currentUser = user;

      if (doc.length > 0) {
        // appEntries/origins は doc を含めない（user+builtinのみ）——docは「今回照合する側」なので、
        // 既に合成済みのアプリ側と比べないと同一キー扱いで自明にsameになってしまうため。
        const appEntries = [...resolveCatalog(kind, { user, builtin: builtinList }).values()];
        const origins = resolveOrigins(kind, { user, builtin: builtinList });

        plan = planIncomingReconcile({ kind, docEntries: doc, appEntries, origins });
        const result = await applyReconcilePlan(plan, {
          kind,
          currentUser: user,
          commitUserFn: (nextUser) => commitUserEntries(kind, nextUser, user, { saveFn: saveUserCatalog }),
          onSkipped: (entry, e) => console.warn(`カタログ照合: 追加候補がR17で弾かれたためスキップしました: ${entry?.code ?? entry}`, e),
        });
        if (result.aliasPairs.length > 0) markDirty();
        if (result.addedKeys.length > 0) currentUser = overlayFor(kind).user; // commitUserFn後のuserを引き直す

        const notice = formatReconcileNotice(plan, {
          kind,
          addedCount: result.addedKeys.length,
          skippedCount: result.skipped.length,
        });
        if (notice) successNotices.push(notice);
      }

      const libraryConflicts = detectLibraryConflicts(kind, { user: currentUser, builtin: builtinList });
      const appEntriesForRows = [...resolveCatalog(kind, { user: currentUser, builtin: builtinList }).values()];
      const originsForRows = resolveOrigins(kind, { user: currentUser, builtin: builtinList });
      rowsByKind.push(...buildResolveRows({
        kind,
        proposals: plan.proposals,
        libraryConflicts,
        unsupported: plan.unsupported,
        appEntries: appEntriesForRows,
        userEntries: currentUser,
        builtinEntries: builtinList,
        origins: originsForRows,
        removedMaterials: kind === CatalogKind.MATERIAL ? REMOVED_MATERIALS : [],
      }));
    } catch (e) {
      failureNotices.push(`${KIND_LABELS[kind] ?? kind}の照合に失敗しました: ${e.message}`);
    }
  }

  project.setCatalogResolveRows(
    replaceRowsByScenario(project.catalogResolveRows, rowsByKind, ['library-conflict', 'unsupported', 'propose']),
  );
  const notices = [...failureNotices, ...successNotices];
  if (notices.length > 0) project.setCatalogError(notices.join('。'));
}

/**
 * 指示UI（ステップ6-3→ステップ7d: 行が複数種別（material・interiorMaster・boundaryMaster）を
 * 持つようになったため kind でグループ化して一般化）の決定を反映する。
 * 手順: (0) rows に現れる kind ごとに現在のカタログ（builtin+user。kindDef(kind).loadBuiltin()
 *     を動的import）から composeCatalog(kind, builtinList).keys() を組み立て、
 *     validKeysByKind（Map<kind, Set<実在キー>>）へ種別ごとに保持する（ステップ7d QA指摘Major-2:
 *     単一Setへ合流すると、他種別にだけ実在するキーを誤って「実在する」と判定してしまうため、
 *     種別をまたがず kind ごとに検証する）。(1) applyResolveDecisions（validKeysByKind付き）で
 *     行＋決定から aliasPairs/userOps/deferredRowIds/rejected を組み立てる——未知コード・
 *     空白のみ・pick未指定を指定した行は保留へ戻り rejected に積まれる（QA指摘Major-1・
 *     ステップ7d QA指摘Major-1: pick未指定はもう例外にしない。1行の入力漏れが他の行の決定
 *     ごと失敗させないため）。rejectedが非空なら project.setCatalogError で通知する。
 * (2) userOpsがあれば op.kind でグループ化し、種別ごとにユーザーライブラリ
 *     （upsert/remove/renumber。renumberはmaterial専用——library-conflict場面の付け替え先
 *     nextFreeCodeInSameClassがmaterial以外はnullを返し保留へ回る契約のため）へ適用し
 *     commitUserEntries(kind, …) で種別ごとに永続化してから markDirty()（ライブラリの変更は
 *     往復と無関係に dirty 化する）。
 * (3) aliasPairsがあれば p.kind でグループ化し、種別ごとに addDocumentAliases(kind, pairs) で
 *     文書固有の読み替え表へ追記し、続けて各 from が overlay の doc に実在すれば
 *     removeDocEntry(kind, from) で外す（QA指摘Major-1・2026-09-23: alias確定したdocエントリを
 *     残すと、内容完全一致のまま別キーでbuiltin/userと併存し、R17（合成後の重複禁止検査）が
 *     例外を投げる。場面(b)=unresolved-code由来のaliasはfromがグラフ参照の旧コードでdocに
 *     無いため、無いキーの例外を投げさせず何もしない）。
 *     その後アクティブ階だけ restoreGraph(activeGraph, serializeGraph(activeGraph)) で往復させて
 *     新しい読み替えをその場で反映してから markDirty()（graphSnapshot.test.js の仮定確認テストで
 *     安全性を確認済み。restoreGraphが内部でapplyDocumentCodeNormalizationを通すため）。往復は
 *     aliasPairsがある場合のみ——userOps（ユーザーライブラリの変更）はcodeNormalizationの
 *     表を変えないため、往復してもグラフの参照コードは変わらない（QA指摘Minor-2）。
 *     非アクティブ階は次にデコードされたとき（peek/activate）に自然に効く。
 * (4) 承認済み（=deferredRowIdsに無い。rejectedで保留へ戻された行を含む）行を
 *     project.catalogResolveRows から除去する（保留行は残す＝次回の再計算まで再掲され続ける）。
 * @param {Map<string,{action:string,pick?:string}>|Object} decisions
 */
export async function applyCatalogResolutions(decisions) {
  const rows = project.catalogResolveRows;
  const kinds = [...new Set(rows.map(r => r.kind))];

  const validKeysByKind = new Map();
  for (const kind of kinds) {
    const builtinList = await kindDef(kind).loadBuiltin();
    validKeysByKind.set(kind, new Set(composeCatalog(kind, builtinList).keys()));
  }
  const { aliasPairs, userOps, deferredRowIds, rejected } = applyResolveDecisions(rows, decisions, { validKeysByKind });

  if (rejected.length > 0) {
    // QA指摘Minor-2（ステップ10e）: rejected[].reason（例:「建具種別のカテゴリが一致しません」）を
    // 捨てて「見つかりません」に一本化すると、キーが実在するのに弾かれた理由（カテゴリ不一致等）が
    // 利用者に伝わらない——reasonを併記する。
    project.setCatalogError(`指定した代替が見つかりません: ${rejected.map(r => `${r.key}（${r.reason}）`).join(', ')}`);
  }

  if (userOps.length > 0) {
    const opsByKind = new Map();
    for (const op of userOps) {
      if (!opsByKind.has(op.kind)) opsByKind.set(op.kind, []);
      opsByKind.get(op.kind).push(op);
    }
    for (const [opKind, ops] of opsByKind) {
      const def = kindDef(opKind);
      const { user } = overlayFor(opKind);
      let nextUser = user;
      for (const op of ops) {
        if (op.op === 'upsert') nextUser = upsertUserCatalogEntry(opKind, nextUser, op.entry);
        else if (op.op === 'remove') nextUser = nextUser.filter(e => def.keyOf(e) !== op.key);
        else if (op.op === 'renumber') {
          if (opKind !== CatalogKind.MATERIAL) {
            throw new Error(`renumberはmaterial専用です（library-conflictの付け替え先はmaterialのみ解決可能）: ${opKind}`);
          }
          nextUser = nextUser.map(e => (e.code === op.from ? { ...e, code: op.to } : e));
        } else throw new Error(`未知のuserOpsです: ${op.op}`);
      }
      await commitUserEntries(opKind, nextUser, user, { saveFn: saveUserCatalog });
    }
    markDirty();
  }

  if (aliasPairs.length > 0) {
    const pairsByKind = new Map();
    for (const p of aliasPairs) {
      if (!pairsByKind.has(p.kind)) pairsByKind.set(p.kind, []);
      pairsByKind.get(p.kind).push({ from: p.from, to: p.to });
    }
    for (const [pKind, pairs] of pairsByKind) {
      addDocumentAliases(pKind, pairs);
      // QA指摘Major-1: alias確定したdocエントリはoverlayに残さない。場面(b)（unresolved-code）
      // 由来のfromはグラフ参照の旧コードでdocに無いため、無いキーの例外を投げさせず何もしない。
      const def = kindDef(pKind);
      const docKeys = new Set(overlayFor(pKind).doc.map(e => def.keyOf(e)));
      for (const { from } of pairs) {
        if (docKeys.has(from)) removeDocEntry(pKind, from);
      }
    }
    const activeGraph = project.activeGraph;
    if (activeGraph) restoreGraph(activeGraph, serializeGraph(activeGraph));
    markDirty();
  }

  const deferredIds = new Set(deferredRowIds);
  project.setCatalogResolveRows(rows.filter(r => deferredIds.has(r.id)));
}

/**
 * 起動時IDB初期化の完了を表すPromise。App.jsx がマウント時に一度だけ購読し、
 * 完了後の project.activePlaneId（restorePlanesFromIDB が差し替え得る）を
 * React state（activeFloorId）へ反映する（QA Finding 1）。
 * ここでは意図的に .catch を付けず、rejection をそのまま呼び出し側（App.jsx）へ伝播させる
 * ——ただし何も購読しない場合でも黙って消えないよう、直後に単独の .catch(console.error) を
 * 同じ Promise へ別途チェーンしてログする（Promiseは複数箇所から独立して購読できるため、
 * この行があっても bootReady 自体を await/`.then`する側の rejection 伝播は妨げられない）。
 */
export const bootReady = (async () => {
  // 排他セッションロック（storage/sessionLock.js）: 取得できなければこのタブは非セッション
  // ——IDB の clearAllStores/seed/setup/restore/activate を一切実行しない。
  if (!(await acquireSessionLock())) return;
  if (!localStorage.getItem(SAVED_FLAG_KEY)) {
    await clearAllStores();
  } else {
    await seedFloorsFromDocument();
  }
  // カタログ束（文書同梱・ユーザーライブラリ）を overlay として設定する。setupStructGraph・
  // 最初の restoreGraph（floorSwapManager.activate）より前——overlayが立ってから壁生成・
  // 材照合が走るようにする（ステップ4）。
  await loadCatalogOverlaysFromIDB();
  // 起動時の同梱カタログ照合（ステップ6-1）: overlayが立った直後・setupStructGraphより前に
  // 1回だけ行う（reconcileIncomingCatalogs自体が失敗を握るため、ここではtry/catchしない）。
  await reconcileIncomingCatalogs();
  // 順序不変条件: 通り芯（structGraph）の復元を完了させてからフロアを復元すること。
  // restoreGraph は壁の軸CL・端点CLを structGraph から解決し、解決できない壁を
  // 無音で捨てるため、並行実行すると通り芯参照の壁・寸法線が失われる。
  await floorSwapManager.setupStructGraph(project.structGraph, project.structuralInfo, savedProjectId, project.memberGroupLedger);
  // 順序不変条件: 通り芯の後・フロアの activate 前に plane 一覧を復元すること。
  // activate は project.activePlane/activeGraph（復元後のアクティブ階）を読む。
  await restorePlanesFromIDB();
  await restoreSiteFromIDB();
  await restoreProjectInfoFromIDB();
  await floorSwapManager.activate(project.activePlane, project.activeGraph);
  floorSwapManager.startSiteDirtyTracking(project.site);
  // 読込み時の全階壁sweep（壁の再生成をFinishModeStateから独立させる計画のステップ5。
  // 裁定2026-09-15）: 文書を開いた時点で主構造・階別構造・下地材コードの入力と壁の鍵が
  // 食い違っている階（他アプリ間での文書共有・旧バージョンの文書等）があれば、仕上げ脱出・
  // 構造脱出と同じ規律で鍵不一致の階だけ壁を作り直す。ensureTopStairVoid・ensureStairRooms
  // と同じ「突入時の自動修復」——undo 対象外（pushUndo:false・pushActiveStructuralUndo:false。
  // undoスタックは空のまま）だが、変更があれば markDirty() して保存を促す（保存すれば鍵も
  // 保存され次回は走らない。鍵一致で何も変わらなければ dirty にしない）。sweep が reject
  // しても bootReady 自体は失敗させない（壁は古いまま＝次の境界で再試行される自己修復性の
  // ため、try/catch で握って続行する）。
  try {
    const { changedPlaneIds } = await refreshWallsAllFloors(project, { pushUndo: false, pushActiveStructuralUndo: false });
    if (changedPlaneIds.length > 0) markDirty();
  } catch (e) {
    // R17（カタログ重複登録禁止）の合成後例外は握りつぶさず利用者に伝える（2026-09-22 QA指摘B
    // 残存）——bootReady自体は失敗させない設計のまま、project.catalogError（観測可能な
    // フィールド。App.jsxがmaterialErrorと同じトースト経路で表示する）に載せる。
    // それ以外（IDB読込失敗等）は従来どおりconsole.errorのみ（catalogErrorは立てない）。
    if (e?.code === ERR_CATALOG_DUPLICATE) {
      project.setCatalogError(e.message);
    } else {
      console.error(e);
    }
  }
})();
bootReady.catch(console.error);

// ----------------------------------------------------------------
// フロア管理
// ----------------------------------------------------------------

/**
 * 新しいフロアを追加する。
 * @param {number} elevation   高さ（例: 3000mm = 3m）
 * @param {string} name        フロア名（例: '2FL'）
 * @param {number} startFloor  開始階番号（デフォルト 1）
 * @param {number} stories     層数（デフォルト 1）
 * @param {string} [planeId]   plane.id（省略時は新規発番。階追加 undo の redo が同一 ID で再作成するために指定する）
 * @returns {{ plane, graph }}
 */
export function addFloor(elevation, name, startFloor = 1, stories = 1, planeId = crypto.randomUUID()) {
  const result = project.addPlane(elevation, name, planeId, startFloor, stories);

  // 新フロアにも寸法線を追加
  addDefaultDimensionLines(result.graph);

  return result;
}

/**
 * 検討フロアを追加する。
 * @param {string} referenceId  親採用の plane.id
 * @param {string} name         検討の名称
 */
export function addAlternativeFloor(referenceId, name) {
  const refPlane = project.planeMap.get(referenceId);
  if (!refPlane) return null;

  const altCount = [...project.planeMap.values()]
    .filter(p => p.isAlternative && p.referenceId === referenceId).length;

  const newPlaneId = crypto.randomUUID();
  const result = project.addPlane(
    refPlane.elevation, name, newPlaneId,
    refPlane.startFloor, refPlane.stories,
    true, referenceId, altCount,
  );

  addDefaultDimensionLines(result.graph);
  return result;
}

/**
 * フロアを IDB から削除し、project からも除去する。
 * 採用の場合はその検討も連鎖削除する。
 * アクティブフロアを削除する前に switchFloor で切り替えること。
 */
export async function removeFloor(planeId) {
  const plane = project.planeMap.get(planeId);
  if (!plane) return;

  const idsToDelete = [planeId];
  if (!plane.isAlternative) {
    for (const [id, p] of project.planeMap) {
      if (p.isAlternative && p.referenceId === planeId) idsToDelete.push(id);
    }
  }
  for (const id of idsToDelete) await dbDeleteFloor(id);

  runInAction(() => {
    project.removePlane(planeId);
    // project.planes が縮むと memberNumberIndex の floorRanks が古い rank（planes配列の範囲外）を
    // 指したままになり得る（floorSpanLabel/assignNumbers は防御済みだが、古い階の情報を表示し続ける
    // のを避けるため即時に捨てる。次のモード境界の反映パスで正しく再収集される）。
    project.clearMemberNumberIndex();
    // openingNumberIndex も counts が planeId キーゆえ同じ理由で捨てる（.claude/opening-model.md）。
    project.clearOpeningNumberIndex();
  });
}

/**
 * アクティブなフロアを切り替える。
 * 現在のフロアを IDB に保存してクリアし、次のフロアを IDB から復元する。
 *
 * @param {string} nextPlaneId  切り替え先の plane.id
 */
export async function switchFloor(nextPlaneId) {
  const currentPlane = project.activePlane;
  const currentGraph = project.activeGraph;
  if (!currentPlane || !currentGraph) return;
  if (currentPlane.id === nextPlaneId) return;

  const nextGraph = project.graphMap.get(nextPlaneId);
  const nextPlane = project.planeMap.get(nextPlaneId);
  if (!nextGraph || !nextPlane) return;

  // 現フロアをスワップアウト
  await floorSwapManager.deactivate(currentPlane, currentGraph);

  // アクティブ切替
  runInAction(() => { project.activePlaneId = nextPlaneId; });

  // 次フロアをスワップイン
  await floorSwapManager.activate(nextPlane, nextGraph);
}

/**
 * 文書同梱する種別の一覧（ステップ7c: 同梱の一般化。それまでは material のみだった。
 * ステップ8fで断面（section）、ステップ10dで建具種別（openingSubType）を追加）。
 * 使用キー収集経路（openingsのsubType）はusedEntries.jsに既にある。
 */
const BUNDLED_KINDS = [CatalogKind.MATERIAL, CatalogKind.INTERIOR_MASTER, CatalogKind.BOUNDARY_MASTER, CatalogKind.SECTION, CatalogKind.OPENING_SUB_TYPE];

/**
 * 全階のバイト列を decode し、BUNDLED_KINDS の使用キーを種別ごとに集めて返す（4.3・
 * ステップ7c QA指摘Major-1）。floorRecords は commitFloorsToDocument で確定した savedFloors
 * から読む（loadAllSavedFloors。削除済みの階は commitFloorsToDocument が savedFloors からも
 * 消しているため含まれない）——非アクティブ階を含む全階バイト列を1箇所で decode する唯一の
 * 場所。収集の純ロジック（使用0件の種別も空Setで必ず持つ・全階を回して埋める）は
 * catalog/usedEntries.js の collectUsedKeysByKind へ抽出済み——store.js は decode してそれに
 * 渡すだけ（単体テストは usedEntries.test.js 側で行う）。
 * export はテスト・saveCatalogDocument以外からの直接呼び出しのため（floorRecordsは
 * storage/db.js loadAllSavedFloors() が返す形をそのまま渡す想定）。
 * QA指摘M1（2026-09-24再報告）: ただし「最後に明示保存した内容」しか見ない——保存前の
 * 未保存編集を含む現在の使用状況が要る場合（材料タブの削除確認等）は下の
 * collectCurrentCatalogUsage を使うこと（このままloadAllSavedFloorsに渡すと未保存の使用を
 * 見落とし、使用中の材の参照が宙に浮く）。
 * @returns {Map<string, Set<string>>} kind → 使用キーのSet
 */
export async function collectCatalogUsageAcrossFloors(floorRecords) {
  const snapshots = floorRecords.map(({ bytes }) => decodeFloorSnapshot(bytes));
  return collectUsedKeysByKind(snapshots, BUNDLED_KINDS);
}

/**
 * ステップ12b QA指摘M1（2026-09-24再報告）: 未保存の作業中の編集を含む「現在の」使用キーを返す。
 * collectCatalogUsageAcrossFloors（loadAllSavedFloors由来）は最後に明示保存（saveToIDB）した
 * 内容しか見ないため、保存前にui/CatalogMaintenancePanel.jsx（材料タブ）で材を削除すると、
 * 実際には使用中なのに「未使用」と誤判定され、docAppendされず文書同梱への書き写しが行われない
 * まま削除されて参照が宙に浮く（Q9違反）。
 * 手順:
 * (1) floorSwapManager.flushEditablePeek() で構造モードの編集可能peek（1つ下の階を伏図から
 *     直接編集する経路）の保留中デバウンス保存を確定する（saveToIDBの①と同じ）。
 * (2) アクティブ階の現在のグラフを floors（作業領域store）へ明示的に書き出す——saveNowが行う
 *     階部分の保存（saveFloor(plane.id, serializeGraph(graph))）と同じ書込みを、明示保存前に
 *     前倒しで行うだけ（非アクティブ階は switchFloor のたびに floorSwapManager.deactivate が
 *     同じstoreへ既に書いているため、ここではアクティブ階だけを追い書きすればよい）。
 *     savedFloors（文書）・projects等は一切書かない——使用キー収集に不要な副作用を増やさない。
 * (3) project.planeMap の全階ぶん floors（loadFloor）から decode し、collectUsedKeysByKind→
 *     expandUsedMaterialsTransitively で内装・境界マスター経由の推移参照までmaterialへ展開する
 *     （saveCatalogDocumentと同じ判定式を共有——二重実装しない。QA指摘m3もこれで解消: 削除確認の
 *     使用中判定が推移参照を見落とす穴が無くなる）。
 * @returns {Promise<Map<string, Set<string>>>} kind → 使用キーのSet（BUNDLED_KINDS）
 */
export async function collectCurrentCatalogUsage() {
  await floorSwapManager.flushEditablePeek();

  const activePlane = project.activePlane;
  const activeGraph = project.activeGraph;
  if (activePlane && activeGraph) {
    await saveFloor(activePlane.id, serializeGraph(activeGraph));
  }

  const floorBytesList = await Promise.all([...project.planeMap.keys()].map(id => loadFloor(id)));
  const snapshots = floorBytesList.filter(Boolean).map(bytes => decodeFloorSnapshot(bytes));
  const rawUsedKeysByKind = collectUsedKeysByKind(snapshots, BUNDLED_KINDS);

  const builtinLists = await Promise.all(BUNDLED_KINDS.map(kind => kindDef(kind).loadBuiltin()));
  const resolvedByKind = new Map(BUNDLED_KINDS.map((kind, i) => [kind, composeCatalog(kind, builtinLists[i])]));

  return expandUsedMaterialsTransitively(rawUsedKeysByKind, resolvedByKind);
}

/**
 * 使用キーをBUNDLED_KINDSの各種別ぶん全階から収集し、解決済み実体を文書同梱として保存する
 * （4.3・ステップ4→7c: material のみだった同梱を interiorMaster・boundaryMaster にも一般化）。
 * 内装マスター・境界マスターが内部で参照する材コードも推移的に material 側へ含める。
 * builtin の取得は kindDef(kind).loadBuiltin()（動的import thunk）に寄せる——store.js が
 * 本体標準マスタ（materialData.js/interiorMasters.js/boundaryMasters.js）を直接importしない。
 * 不変条件7-1（materialData.js は仕上げモード突入時のみ動的 import）は、保存時にも動的
 * import が必要になる形で適用範囲が広がる（wallRegeneration.js と同じ注記。npm run build で
 * 独立チャンクのままであることを確認すること）。
 *
 * 2026-09-22 QA指摘A→再QA指摘Major-D: overlay 未読込み（project.catalogOverlayUntrusted が
 * true）状態で保存すると、overlay に乗っていないユーザー材の使用キーが composeCatalog で
 * 解決できず buildDocumentBundle が黙って落とし、そのまま保存すると既存の同梱レコード
 * （前回保存分にはユーザー材が入っていたかもしれない）を上書きしてしまう。これを防ぐため:
 * (1) catalogOverlayUntrusted が立っている間は保存自体をせず、既存レコードをそのまま温存する
 *     （早期return。catalogError は「メッセージ内容」の通知専用フィールドのため保存可否の
 *     判定には使わない——通知文言を変えると保存ガードの意味まで変わる結合を避ける。
 *     project.catalogOverlayUntrustedだけを見る）。
 * (2) catalogOverlayUntrusted が立っていなくても unresolvedKeys が非空なら、既存の同梱レコード
 *     （loadDocumentCatalogs で読める）から回収して温存する（recoverUnresolvedEntries）。回収
 *     された interiorMaster/boundaryMaster が参照する材コードは、最初の expandTransitiveMaterials
 *     の時点ではまだ material 束に無いため、reexpandTransitiveMaterials で推移展開をやり直し、
 *     不足する材を resolvedByKind(material) で解決して追記する（QA指摘Minor-2）。それでも
 *     解決できない材コードは既存の material 束からの回収を1回だけ試みる。
 * (3) それでも残る未解決キーは黙って落とさず project.catalogError に種別名込みで件数とキー/
 *     コードを載せて通知する（保存自体は行う——回収できた分は保存し、既存レコードにも無い
 *     ＝本当に実体が無い分だけを通知する）。
 * 保存は IDB の規約（${projectId}:catalogs:<kind>）どおり種別ごとのレコードだが、
 * saveDocumentCatalogs（storage/db.js）で単一トランザクションにまとめて atomic に書く
 * （QA指摘Major-1: 種別ごとに別々の保存呼び出しをループすると、途中の失敗で一部の種別だけ
 * 新しい内容・残りは古い内容という部分保存が起きるため）。使用0件の種別も空配列で必ず書く。
 */
async function saveCatalogDocument(floorRecords) {
  if (project.catalogOverlayUntrusted) {
    console.warn('カタログoverlayが未読込み（信頼できない）ため、文書同梱の保存をスキップしました。既存レコードを温存します。');
    return;
  }

  const rawUsedKeysByKind = await collectCatalogUsageAcrossFloors(floorRecords);

  const builtinLists = await Promise.all(BUNDLED_KINDS.map(kind => kindDef(kind).loadBuiltin()));
  const resolvedByKind = new Map(BUNDLED_KINDS.map((kind, i) => [kind, composeCatalog(kind, builtinLists[i])]));

  // ステップ12b QA指摘M1/m3（2026-09-24再報告）: 内装・境界マスター経由の材コードの推移展開は
  // catalog/usedEntries.js の expandUsedMaterialsTransitively へ集約する——store.js
  // collectCurrentCatalogUsage（削除確認の「現在の使用キー」収集）と同じ判定式を共有し、
  // 二重実装しない（片方だけ内装・境界マスター経路を外す退行を1箇所の修正で防ぐ）。
  const usedKeysByKind = expandUsedMaterialsTransitively(rawUsedKeysByKind, resolvedByKind);

  // QA指摘Minor-4: 空の種別を手元でふるい落とさなくても、splitBundleByKindのbundleAliases側が
  // 「非空のときだけ添える」判定を持つため設計上は同値——フィルタの唯一の判定箇所をそちらに寄せる。
  const aliases = Object.fromEntries(BUNDLED_KINDS.map(kind => [kind, currentDocumentAliases(kind)]));

  const { bundle: draftBundle, unresolvedKeys } = buildDocumentBundle({ usedKeysByKind, resolvedByKind, aliases });

  let finalBundle = draftBundle;
  if ([...unresolvedKeys.values()].some(keys => keys.size > 0)) {
    const existingRecords = await loadDocumentCatalogs(savedProjectId);
    const existingBundlesByKind = new Map(existingRecords.map(r => [r.kind, decodeCatalogBundle(r.bytes)]));
    const { bundle: recoveredBundle, stillUnresolvedByKind } = recoverUnresolvedEntries(
      draftBundle, unresolvedKeys, existingBundlesByKind,
    );
    finalBundle = recoveredBundle;

    // QA指摘Minor-2: 回収分の内装・境界マスターから推移展開をやり直し、不足する材を追記する。
    const { bundle: reexpandedBundle, unresolvedMaterialKeys } = reexpandTransitiveMaterials(
      finalBundle, resolvedByKind.get(CatalogKind.MATERIAL),
    );
    finalBundle = reexpandedBundle;
    if (unresolvedMaterialKeys.size > 0) {
      const { bundle: recoveredAgain, stillUnresolvedByKind: stillMaterial } = recoverUnresolvedEntries(
        finalBundle, new Map([[CatalogKind.MATERIAL, unresolvedMaterialKeys]]), existingBundlesByKind,
      );
      finalBundle = recoveredAgain;
      for (const [kind, keys] of stillMaterial) {
        stillUnresolvedByKind.set(kind, new Set([...(stillUnresolvedByKind.get(kind) ?? []), ...keys]));
      }
    }

    if (stillUnresolvedByKind.size > 0) {
      // QA指摘Minor-5: material=「コード」、内装/境界マスター=「キー」で出し分ける。
      const messages = [...stillUnresolvedByKind].map(([kind, keys]) => {
        const noun = kind === CatalogKind.MATERIAL ? 'コード' : 'キー';
        return `同梱できない${KIND_LABELS[kind] ?? kind}${noun}が${keys.size}件あります: ${[...keys].join(', ')}`;
      });
      project.setCatalogError(messages.join('。'));
    }
  }

  const bytesByKind = new Map(
    [...splitBundleByKind(finalBundle)].map(([kind, subBundle]) => [kind, encodeCatalogBundle(subBundle)]),
  );
  await saveDocumentCatalogs(savedProjectId, bytesByKind);
}

/**
 * アクティブなフロアと通り芯を IndexedDB に明示的に保存し、dirty をリセットする。
 * 非アクティブ階はスワップアウト時（deactivate）に明示保存の有無に関わらず floors
 * （セッション作業領域）へ無条件保存されるため、floors 上はこれで全階が揃う。
 * それを保存ドキュメント（savedFloors）へ確定コピーし（commitFloorsToDocument）、
 * 明示保存フラグを立てて、次回起動時の白紙化をスキップして復元対象にする。
 */
export async function saveToIDB() {
  const activePlane = project.activePlane;
  const activeGraph = project.activeGraph;
  if (!activePlane || !activeGraph) throw new Error('アクティブなフロアがありません');
  // ① 構造モードの下階編集（編集可能peek）の保留中デバウンス保存を確定する
  await floorSwapManager.flushEditablePeek();
  // ② アクティブ階を floors へ＋通り芯・構造情報を projects へ
  await floorSwapManager.saveNow(activePlane, activeGraph, project.structGraph, project.structuralInfo, savedProjectId, project.memberGroupLedger);
  // ③ plane一覧のメタデータ
  await savePlanesMeta(savedProjectId, serializePlanes(project));
  // ③.5 敷地（project.site）
  await saveSiteData(savedProjectId, serializeSite(project.site));
  // ③.6 調査・計画情報（敷地情報／建築情報ダイアログの入力値）
  await saveProjectInfo(savedProjectId, encodeProjectInfo(project.projectInfo));
  // ④ floors（作業領域）の現在値を保存ドキュメント（savedFloors）へ確定コピー。
  //    project.planeMap に無い（削除済みの）階は savedFloors からも消える。
  await commitFloorsToDocument([...project.planeMap.keys()]);
  // ④.5 使用キーを、commitFloorsToDocument で確定した savedFloors から（削除済み階を
  // 含まないため）全階ぶん収集し、文書同梱（BUNDLED_KINDS＝material・interiorMaster・
  // boundaryMaster・section・openingSubTypeの5種別）として保存する（4.3・ステップ4→7c→8f→10d）。
  const floorRecords = await loadAllSavedFloors();
  await saveCatalogDocument(floorRecords);
  // ⑤ 次回起動時のブートplane（PLANE_ID_KEY）を最下階の採用planeへ揃える。保存文書の実在planeと
  // 同一IDになり、起動時 reconcilePlanes での無駄な削除・再生成（toRemove→toAdd往復）を防ぐ。
  // project.planes[0] が無い（採用フロアが1件も無い）ことは通常起きないが、undefined を
  // そのまま setItem すると文字列 "undefined" が書かれ次回起動を汚染するためガードする。
  if (project.planes[0]) localStorage.setItem(PLANE_ID_KEY, project.planes[0].id);
  localStorage.setItem(SAVED_FLAG_KEY, '1');
  clearDirty();
}

/**
 * 文書全体（全階・plane一覧・通り芯/構造情報/採番台帳・敷地・調査/計画情報・カタログ同梱）を
 * .stq 文書ファイル用の JSON文字列（エンベロープ）にして返す。まず saveToIDB で保存ドキュメントを
 * 確定してから、その確定内容（savedFloors/projects）を読み戻して包む——「ファイルの中身＝次回
 * 起動で復元される内容」を常に一致させるため。カタログ同梱は IDB 上では種別ごとに別レコード
 * （${projectId}:catalogs:<kind>）だが、.stq エンベロープでは単一の catalogs フィールドへ
 * 統合する（mergeBundles。saveToIDB がstoreした内容を読み戻すだけで、ここで再度使用エントリを
 * 走査しない＝二重走査しない）。
 */
export async function exportDocument() {
  await saveToIDB();
  const [floors, struct, planes, site, infoBytes, docCatalogRecords] = await Promise.all([
    loadAllSavedFloors(),
    loadProject(savedProjectId),
    loadPlanesMeta(savedProjectId),
    loadSiteData(savedProjectId),
    loadProjectInfo(savedProjectId),
    loadDocumentCatalogs(savedProjectId),
  ]);
  // 調査・計画情報はプレーンJSONなので base64 にせずオブジェクトのまま包む（ファイルの可読性優先）
  const info = infoBytes ? decodeProjectInfo(infoBytes) : null;
  const catalogs = docCatalogRecords.length > 0
    ? mergeBundles(docCatalogRecords.map(r => decodeCatalogBundle(r.bytes)))
    : null;
  return buildDocumentJson({
    floors, struct, planes, site, info, catalogs, bootPlaneId: project.planes[0]?.id ?? null,
  });
}

/**
 * .stq 文書ファイル（パース済みJSONエンベロープ）の内容で保存ドキュメントを丸ごと置き換える。
 * 検証（parseDocumentEnvelope）を通してから全ストアを消去する——不正ファイルで既存文書を
 * 消さないため。in-memory への反映は行わない（呼び出し側が location.reload() で再起動し、
 * 通常のブート復元経路をそのまま使うこと。module singleton・undoスタック等の取り残しを
 * 避ける resetAll と同じ理由）。projectId は現行タブのものを使い続ける（ファイルへは保存しない）。
 * カタログ同梱（doc.catalogs。parseDocumentEnvelope で既に decode・validate 済み）は種別ごとの
 * 束へ分割（splitBundleByKind。mergeBundlesの逆）し、IDB の規約（${projectId}:catalogs:<kind>）
 * どおり種別ごとに saveDocumentCatalog する。
 */
export async function importDocument(envelope) {
  const doc = parseDocumentEnvelope(envelope);
  await clearAllStores();
  for (const { planeId, bytes } of doc.floors) await saveSavedFloor(planeId, bytes);
  if (doc.struct) await saveProject(savedProjectId, doc.struct);
  if (doc.planes) await savePlanesMeta(savedProjectId, doc.planes);
  if (doc.site)   await saveSiteData(savedProjectId, doc.site);
  if (doc.info)   await saveProjectInfo(savedProjectId, encodeProjectInfo(doc.info));
  if (doc.catalogs) {
    for (const [kind, bundle] of splitBundleByKind(doc.catalogs)) {
      await saveDocumentCatalog(savedProjectId, kind, encodeCatalogBundle(bundle));
    }
  }
  // ブートplaneを文書の最下階採用planeへ。reconcilePlanes での無駄な削除・再生成を防ぐ
  // （saveToIDB の⑤と同じ理由）。
  if (doc.bootPlaneId) localStorage.setItem(PLANE_ID_KEY, doc.bootPlaneId);
  localStorage.setItem(SAVED_FLAG_KEY, '1');
  clearDirty();
}

/**
 * すべてのIndexedDBストア（floors/projects/savedFloors。catalogsストア＝ユーザーカタログ
 * ライブラリは対象外）と、文書系のlocalStorageキー（保存フラグ・ブートplaneId・projectId）、
 * および旧「書出し」（廃止済みlocalStorage自動保存）の残骸を消去する。「新規（全消去）」メニュー専用。
 * 画面校正（strad_pxPerMmX/Y 等、viewport.js）は端末設定のため対象外——文書ではなく端末に紐づく。
 * in-memory再初期化は行わない（呼び出し側が location.reload() で再起動すること。module singleton・
 * undoスタック・モード動的ロード等の取り残し面積が大きいため reload が正しい）。
 * カタログ registry の overlay（catalog/catalogRegistry.js）・文書固有のコード正規化表
 * （codeNormalization.js）・project.catalogError/catalogOverlayUntrusted・
 * project.catalogResolveRows（指示UIの行一覧。ステップ6-3）は、location.reload() で自然に
 * 消えるが（store.js のコメント参照）、in-memory 再初期化へ将来移行した場合に備えて明示的に
 * クリアする（catalogRegistryWiring.test.js が予告していた不変条件）。ユーザーライブラリは消さない。
 */
export async function resetAll() {
  await clearAllStores();
  localStorage.removeItem(SAVED_FLAG_KEY);
  localStorage.removeItem(PLANE_ID_KEY);
  localStorage.removeItem(PROJECT_ID_KEY);
  clearLocalAutosave();
  clearDirty();
  clearOverlays();
  takeUnresolvedCodes(); // 蓄積を捨てる（戻り値は使わない）
  clearDocumentAliases(); // 全種別のalias・正規化表を解除する
  project.setCatalogError(null);
  project.setCatalogOverlayUntrusted(false);
  project.clearCatalogResolveRows();
}

export const StoreContext = createContext(project);
export function useStore() { return useContext(StoreContext); }
