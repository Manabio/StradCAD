import { createContext, useContext } from 'react';
import { runInAction, reaction } from 'mobx';
import {
  Project, CenterLineType, Discipline,
  HDimensionLine, VDimensionLine, DimensionKind, DimensionSide,
} from '@core';
import { floorSwapManager } from './storage/FloorSwapManager.js';
import {
  deleteFloor as dbDeleteFloor, clearAllStores, loadFloor, savePlanesMeta, loadPlanesMeta,
  saveSiteData, loadSiteData, saveProject, loadProject, saveProjectInfo, loadProjectInfo,
  seedFloorsFromDocument, commitFloorsToDocument, loadAllSavedFloors, saveSavedFloor,
} from './storage/db.js';
import { buildDocumentJson, parseDocumentEnvelope } from './storage/documentFile.js';
import { encodeProjectInfo, decodeProjectInfo } from './storage/projectInfo.js';
import { clearDirty } from './dirtyState.js';
import { acquireSessionLock } from './storage/sessionLock.js';
import { SpatialIndex } from './transform/SpatialIndex.js';
import { serializePlanes, decodePlanes, serializeSite, decodeSite, restoreSite } from './graphSnapshot.js';
import { reconcilePlanes } from './floorOps.js';
import { clearLocalAutosave } from './storage/localSnapshot.js';

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
    spatialIndex.rebuild(activeGraph.intersections, activeGraph.points);
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
  // ⑤ 次回起動時のブートplane（PLANE_ID_KEY）を最下階の採用planeへ揃える。保存文書の実在planeと
  // 同一IDになり、起動時 reconcilePlanes での無駄な削除・再生成（toRemove→toAdd往復）を防ぐ。
  // project.planes[0] が無い（採用フロアが1件も無い）ことは通常起きないが、undefined を
  // そのまま setItem すると文字列 "undefined" が書かれ次回起動を汚染するためガードする。
  if (project.planes[0]) localStorage.setItem(PLANE_ID_KEY, project.planes[0].id);
  localStorage.setItem(SAVED_FLAG_KEY, '1');
  clearDirty();
}

/**
 * 文書全体（全階・plane一覧・通り芯/構造情報/採番台帳・敷地・調査/計画情報）を .stq 文書ファイル用の
 * JSON文字列（エンベロープ）にして返す。まず saveToIDB で保存ドキュメントを確定してから
 * その確定内容（savedFloors/projects）を読み戻して包む——「ファイルの中身＝次回起動で
 * 復元される内容」を常に一致させるため。
 */
export async function exportDocument() {
  await saveToIDB();
  const [floors, struct, planes, site, infoBytes] = await Promise.all([
    loadAllSavedFloors(),
    loadProject(savedProjectId),
    loadPlanesMeta(savedProjectId),
    loadSiteData(savedProjectId),
    loadProjectInfo(savedProjectId),
  ]);
  // 調査・計画情報はプレーンJSONなので base64 にせずオブジェクトのまま包む（ファイルの可読性優先）
  const info = infoBytes ? decodeProjectInfo(infoBytes) : null;
  return buildDocumentJson({ floors, struct, planes, site, info, bootPlaneId: project.planes[0]?.id ?? null });
}

/**
 * .stq 文書ファイル（パース済みJSONエンベロープ）の内容で保存ドキュメントを丸ごと置き換える。
 * 検証（parseDocumentEnvelope）を通してから全ストアを消去する——不正ファイルで既存文書を
 * 消さないため。in-memory への反映は行わない（呼び出し側が location.reload() で再起動し、
 * 通常のブート復元経路をそのまま使うこと。module singleton・undoスタック等の取り残しを
 * 避ける resetAll と同じ理由）。projectId は現行タブのものを使い続ける（ファイルへは保存しない）。
 */
export async function importDocument(envelope) {
  const doc = parseDocumentEnvelope(envelope);
  await clearAllStores();
  for (const { planeId, bytes } of doc.floors) await saveSavedFloor(planeId, bytes);
  if (doc.struct) await saveProject(savedProjectId, doc.struct);
  if (doc.planes) await savePlanesMeta(savedProjectId, doc.planes);
  if (doc.site)   await saveSiteData(savedProjectId, doc.site);
  if (doc.info)   await saveProjectInfo(savedProjectId, encodeProjectInfo(doc.info));
  // ブートplaneを文書の最下階採用planeへ。reconcilePlanes での無駄な削除・再生成を防ぐ
  // （saveToIDB の⑤と同じ理由）。
  if (doc.bootPlaneId) localStorage.setItem(PLANE_ID_KEY, doc.bootPlaneId);
  localStorage.setItem(SAVED_FLAG_KEY, '1');
  clearDirty();
}

/**
 * すべてのIndexedDBストア（floors/projects/savedFloors）と、文書系のlocalStorageキー
 * （保存フラグ・ブートplaneId・projectId）、および「書出し」（自動保存）データを消去する。
 * 「新規（全消去）」メニュー専用。
 * 画面校正（strad_pxPerMmX/Y 等、viewport.js）は端末設定のため対象外——文書ではなく端末に紐づく。
 * in-memory再初期化は行わない（呼び出し側が location.reload() で再起動すること。module singleton・
 * undoスタック・モード動的ロード等の取り残し面積が大きいため reload が正しい）。
 */
export async function resetAll() {
  await clearAllStores();
  localStorage.removeItem(SAVED_FLAG_KEY);
  localStorage.removeItem(PLANE_ID_KEY);
  localStorage.removeItem(PROJECT_ID_KEY);
  clearLocalAutosave();
  clearDirty();
}

export const StoreContext = createContext(project);
export function useStore() { return useContext(StoreContext); }
