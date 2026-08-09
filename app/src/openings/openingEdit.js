// ================================================================
// 建具モードの編集操作・undo。finish/finishUndo.js の API 形状を踏襲するが、
// 対象が graph 全体ではなく Opening 単体のため plain object スナップショットの
// 粒度がフィールド単位（EDITABLE のみ）になる。
//
// undo/redo クロージャ内で renumberOpenings を呼ぶ理由（.claude/undo-redo.md）:
// 履歴ナビゲーション（switchHistoryContext）はモード境界処理を再実行しない。呼ばないと
// undo後にタグ（project.openingNumberIndex）が実データとズレる。
//
// renumberOpenings（を含む graph/project 変異全般）は必ず runInAction で包むこと:
// project.openingNumberIndex は deep observable.map で、OpeningPanel（observer）が能動的に
// 観測している。runInAction の外から変異すると MobX強制モード違反の警告が出る
// （構造側 structural/memberGroups.test.js:218-224 で踏んだ同型欠陥。本ファイルの
// openingEdit.test.js に同型の回帰テストがある）。
// ================================================================

import { runInAction } from 'mobx';
import { undoManager } from '../undoManager.js';
import { OpeningCategory } from '../core.js';
import { getFittingOptions, WINDOW_CATALOG, defaultFixtureSymbolFor, defaultOpeningHeight, defaultMaterialGlassFor } from './openingCatalog.js';
import { findHostWall, validateOpeningPlacement, wallFaceDir, swingSideTowardPerp, exteriorSideDir } from './openingGeometry.js';
import { renumberOpenings } from './openingNumbering.js';

const EDITABLE = [
  'refOffset', 'width', 'height', 'subType', 'hingeSide', 'swingSide', 'fixtureType', 'sillHeight',
  'finish', 'materialGlass', 'frameDepth', 'hardware', 'note',
];

/** Opening の編集可能フィールドのみを持つ plain object スナップショット（refCL は id で保持）。 */
export function snapshotOpening(o) {
  const snap = { refCLId: o.refCL.id };
  for (const k of EDITABLE) snap[k] = o[k];
  return snap;
}

function restoreOpening(graph, o, snap) {
  o.refCL = graph.shapeMap.get(snap.refCLId) ?? o.refCL;
  for (const k of EDITABLE) o[k] = snap[k];
}

function addOpeningFromSnapshot(graph, o) {
  return graph.addOpening(o.axisCL, o.wallSide, o.isVertical, o.refCL, o.refOffset, o.width, o.category, o.subType,
    {
      hingeSide: o.hingeSide, swingSide: o.swingSide, fixtureType: o.fixtureType, sillHeight: o.sillHeight, height: o.height,
      finish: o.finish, materialGlass: o.materialGlass, frameDepth: o.frameDepth, hardware: o.hardware, note: o.note,
    }, o.id);
}

/** before から現在までの差分を undo エントリとして積む。差分が無ければ積まない。 */
export function pushOpeningUndo(graph, project, o, before) {
  const after = snapshotOpening(o);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  // 前進方向（この確定そのもの）でもタグを即座に反映する。undo/redo クロージャの中だけで
  // 呼ぶと、確定直後（まだ undo/redo していない状態）は signature が変わったのに
  // project.openingNumberIndex が古いままになり、openingTagOf が null を返し続ける
  // （リストが「—」「全体0」のまま固まって見えるバグの直接原因）。
  // renumberOpenings は project.openingNumberIndex（observable.map）を変異するため、
  // OpeningPanel（observer）が能動的に観測している状態で runInAction の外から呼ぶと
  // MobX強制モード違反の警告が出る（構造側 memberGroups.test.js:218-224 で踏んだ同型欠陥）。
  runInAction(() => renumberOpenings(graph, project));
  return undoManager.push(
    () => runInAction(() => { restoreOpening(graph, o, before); renumberOpenings(graph, project); }),
    () => runInAction(() => { restoreOpening(graph, o, after); renumberOpenings(graph, project); }),
  );
}

/** fn を実行し、その前後差分を1つの undo エントリとして積む汎用ラッパー。 */
export function withOpeningUndo(graph, project, o, fn) {
  const before = snapshotOpening(o);
  const result = fn();
  pushOpeningUndo(graph, project, o, before);
  return result;
}

// ---- 自由入力フィールド用（フォーカス〜ブラーの編集を1エントリに集約）----
let fieldUndoPending = null; // { graph, project, opening, before } | null

export function beginOpeningFieldUndo(graph, project, opening) {
  fieldUndoPending = { graph, project, opening, before: snapshotOpening(opening) };
}

export function endOpeningFieldUndo(graph, project, opening) {
  const pending = fieldUndoPending;
  fieldUndoPending = null;
  if (!pending || pending.graph !== graph || pending.opening !== opening) return;
  pushOpeningUndo(graph, project, opening, pending.before);
}

/**
 * 壁の長押しメニュー「建具/窓」から呼ぶ既定値付き仮配置。配置検証NGなら壁中央へ
 * フォールバック（無言で壁外に置かない）。それでもNGなら配置せずエラーを返す。
 * @returns {{ opening: object|null, error: string|null }}
 */
export function placeOpeningWithDefaults(graph, project, wall, worldPos, category) {
  const wallKind = wall.isExteriorWall ? 'exterior' : 'interior';
  const catalog = category === OpeningCategory.WINDOW ? WINDOW_CATALOG : getFittingOptions(wallKind);
  const entry = catalog[0];
  if (!entry) return { opening: null, error: 'この壁に配置できる建具がありません' };

  const subType = entry.key;
  const width = entry.defaultWidth;
  const height = defaultOpeningHeight(category, subType);
  const sillHeight = category === OpeningCategory.WINDOW ? 800 : null;
  const fixtureType = defaultFixtureSymbolFor(category, wallKind);
  const materialGlass = defaultMaterialGlassFor(fixtureType);
  const refCL = wall.clStart;

  // refOffset は refCL.effectiveValue（CL偏芯ドラッグ中の pendingDelta を含む実効座標）基準——
  // Opening.centerCoord が effectiveValue + refOffset で定義される（core.js）ため、.value 基準で
  // 計算すると CL偏芯中は長押し位置からズレて配置される。
  const along = wall.isVertical ? worldPos.y : worldPos.x;
  let refOffset = Math.round(along - refCL.effectiveValue);
  let centerCoord = refCL.effectiveValue + refOffset;
  let err = validateOpeningPlacement(wall, centerCoord - width / 2, centerCoord + width / 2, graph, null);

  if (err) {
    const wallLo = Math.min(wall.coord1, wall.coord2), wallHi = Math.max(wall.coord1, wall.coord2);
    refOffset = Math.round((wallLo + wallHi) / 2 - refCL.effectiveValue);
    centerCoord = refCL.effectiveValue + refOffset;
    err = validateOpeningPlacement(wall, centerCoord - width / 2, centerCoord + width / 2, graph, null);
  }
  if (err) return { opening: null, error: err };

  const wallSide = Math.sign(wall.axisOffset) || 1;
  // swingSideの既定値: 壁が面する側（faceDir）へ開く。壁ラジアルのヒット域には材側への
  // わずかな許容があり（isWallRadialHit・WALL_LINE_INWARD_PX）、その範囲では押下点の直交成分の
  // 符号が faceDir と逆になり得る——押下点(worldPos)の符号ではなく、ヒットした壁自身が
  // 面する向き（faceDir）で開き方向を決めることで、材側許容を押しても逆に開かないようにする
  // （前回QA指摘「材の中を触ると逆に開く」の再発防止。perpOf/touchDirは使わない）。
  // ただし外壁境界（wallまたは境界の反対側の壁がisExteriorWall）は常に外開き——境界の反対側
  // まで見るのは、室内向き壁（isExteriorWall:false）をホストに触れても外壁境界だと判定できる
  // ようにするため（exteriorSideDir）。反対側の壁は実際に開口が置かれる位置(centerCoord)で
  // 特定する——境界が長さ方向で外壁区間／隣室区間に分かれる（segmented）平面では、worldPos
  // ではなく実配置位置で判定しないと誤った区間の相手を拾う。.claude/opening-model.md 参照。
  const hingeSide = -1;
  const faceDir = wallFaceDir(wall);
  const openDir = exteriorSideDir(wall, graph, centerCoord) ?? faceDir;
  const swingSide = swingSideTowardPerp(wall.isVertical, hingeSide, openDir);
  const opening = graph.addOpening(wall.axisCL, wallSide, wall.isVertical, refCL, refOffset, width, category, subType,
    { hingeSide, swingSide, fixtureType, sillHeight, height, materialGlass });
  undoManager.push(
    () => runInAction(() => { graph.removeShape(opening.id); renumberOpenings(graph, project); }),
    () => runInAction(() => { addOpeningFromSnapshot(graph, opening); renumberOpenings(graph, project); }),
  );
  runInAction(() => renumberOpenings(graph, project));
  return { opening, error: null };
}

/** 開口削除（旧 'opening-del' の実装を移設）。 */
export function removeOpeningWithUndo(graph, project, o) {
  graph.removeShape(o.id);
  undoManager.push(
    () => runInAction(() => { addOpeningFromSnapshot(graph, o); renumberOpenings(graph, project); }),
    () => runInAction(() => { graph.removeShape(o.id); renumberOpenings(graph, project); }),
  );
  runInAction(() => renumberOpenings(graph, project));
}

/**
 * 幅・位置編集の検証。ホスト壁が引けないとき（findHostWallがnull）は幾何検証をスキップする
 * （旧 OpeningDialog と同じ割り切り）。
 * @returns {string|null} エラーメッセージ | null（OK）
 */
export function validateOpeningEdit(o, graph, { width, refOffset }) {
  const wall = findHostWall(o, graph);
  if (!wall) return null;
  const centerCoord = o.refCL.effectiveValue + refOffset;
  return validateOpeningPlacement(wall, centerCoord - width / 2, centerCoord + width / 2, graph, o.id);
}

/**
 * 建具記号を変更したときの「材料・ガラス」欄の差し替え規則: 現在値が未入力(null)、または
 * 旧記号の初期値のままなら新記号の初期値へ差し替える。ユーザーが編集済み（未入力でなく、かつ
 * 初期値と異なる値を入力済み）の値は上書きしない。
 */
export function materialGlassAfterFixtureChange(currentValue, oldSymbol, newSymbol) {
  const isUnedited = currentValue == null || currentValue === defaultMaterialGlassFor(oldSymbol);
  return isUnedited ? defaultMaterialGlassFor(newSymbol) : currentValue;
}
