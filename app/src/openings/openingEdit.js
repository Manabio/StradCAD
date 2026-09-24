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
import {
  getFittingOptions, openingSubTypeList, defaultFixtureSymbolFor, defaultOpeningHeight, defaultMaterialGlassFor, defaultNoteFor,
  getFixtureSymbols, findFixtureSymbol, OpeningMechanism, DEFAULT_FRAME_FACE_MM, DEFAULT_FRAME_PROJECTION_MM,
} from './openingCatalog.js';
import { findHostWall, validateOpeningPlacement, maxOpeningWidthAt, findOpeningsOnWall, swingSideTowardPerp, exteriorSideDir } from './openingGeometry.js';
import { renumberOpenings } from './openingNumbering.js';
import { openingRefOffsetRange, clampRefOffset } from './openingMove.js';
import { ERR_OPENING_OUT_OF_WALL, ERR_OPENING_OVERLAP } from '../error.js';

// 内開き系機構（室内側へ開く特性を持つ）。placeOpeningWithDefaults の swingSide 既定計算で、
// 外壁の「常に室外側へ開く」既定より機構特性を優先するために参照する。
const INWARD_OPEN_MECHANISMS = new Set([OpeningMechanism.SWING_IN, OpeningMechanism.DREH_KIPP]);

/** mechanism が内開き系（SWING_IN/DREH_KIPP）なら開き方向(openDir)を反転する。それ以外はそのまま。 */
export function openDirForMechanism(openDir, mechanism) {
  return INWARD_OPEN_MECHANISMS.has(mechanism) ? -openDir : openDir;
}

/**
 * swingSide既定値の唯一の定義箇所（placeOpeningWithDefaults・OpeningEditor.jsx onSubTypeChange
 * の両方がこれを呼ぶ。二重定義しない）。壁が面する側（faceDir）へ開くのが既定だが、外壁境界
 * （wallまたは境界の反対側の壁がisExteriorWall）は常に外開き（exteriorSideDir）、さらに
 * mechanismが内開き系（SWING_IN/DREH_KIPP）ならopenDirForMechanismで室内側へ反転する。
 * @param {object} wall ホスト壁
 * @param {object} graph
 * @param {number} centerCoord 実際に開口が置かれる位置（境界のsegmented判定に使う。.claude/opening-model.md参照）
 * @param {number} hingeSide ±1
 * @param {string|undefined} mechanism openingCatalog.js OpeningMechanism
 * @returns {number} swingSide ±1
 */
export function defaultSwingSideFor(wall, graph, centerCoord, hingeSide, mechanism) {
  const openDir = openDirForMechanism(exteriorSideDir(wall, graph, centerCoord) ?? wall.faceDir, mechanism);
  return swingSideTowardPerp(wall.isVertical, hingeSide, openDir);
}

/**
 * 「吊元反転」ボタンの確定値（唯一の定義箇所。{hingeSide, swingSide} を返す）。
 * 吊元だけを反対の枠端へ移し、扉が開く物理側（壁のどちらの面へ開くか）は維持する。
 *
 * 開く物理側は perpDir = (isVertical?1:-1) * swingSide * hingeSide（openingGeometry.js
 * swingSideTowardPerp の順方向）で決まるため、hingeSide だけを反転すると積の符号が変わり
 * 「吊元と一緒に開く面まで裏返る」——これが修正前の不具合。swingSide も同時に反転して
 * 積（＝perpDir）を保つ。
 *
 * 両開き系（hingeSideMatters が false）は吊元自体が意味を持たず、swingSide だけが開く面を
 * 決めるため、この反転を掛けると開く面だけが裏返る。呼び出し側（OpeningEditor.jsx）は
 * hingeSideMatters が false のときボタン自体を出さない。
 */
export function flippedHingeSides(opening) {
  return { hingeSide: -opening.hingeSide, swingSide: -opening.swingSide };
}

/** 「開く方向反転」ボタンの確定値。吊元（hingeSide）は動かさず、開く面だけを裏返す。 */
export function flippedSwingSide(opening) {
  return -opening.swingSide;
}

const EDITABLE = [
  'refOffset', 'width', 'height', 'subType', 'hingeSide', 'swingSide', 'fixtureType', 'sillHeight',
  'finish', 'materialGlass', 'frameDepth', 'hardware', 'note', 'handleHeight',
  'frameFaceWidth', 'frameProjection',
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

/**
 * 建具の変更が構造（柱の自動生成・袖柱）に影響しうるか。snapshotOpening の結果同士を比較する。
 * 袖柱・重なり判定が読むのは開口の coord1/coord2・axisCL・isVertical のみ（.claude/structural-model.md
 * 「建具の袖柱」参照）。coord1/coord2 は centerCoord(=refCL.effectiveValue+refOffset) と width から
 * 導出されるため、refCLId・refOffset・width のいずれかが変われば true。axisCL・isVertical は配置後
 * 不変なので比較しない。EDITABLE と同じファイルに置き、フィールドの増減時に一緒に見直せるようにする
 * （構造側 structural/openingStructuralSync.js は本ファイルを import しない。逆向きの依存も持たず、
 * 起動は geometryListener の依存注入だけで結ぶ）。
 */
export function openingGeometryChanged(before, after) {
  return before.refCLId !== after.refCLId
    || before.refOffset !== after.refOffset
    || before.width !== after.width;
}

// 建具の確定・undo/redo直後に自階の構造を再計算するための依存注入フック（App.jsxが
// undoManager.contextProviderと同じ作法で設定する）。未設定（構造モジュール未配線のテスト等）
// では何もしない。
let geometryListener = null;
export function setOpeningGeometryListener(fn) { geometryListener = fn; }

function addOpeningFromSnapshot(graph, o) {
  return graph.addOpening(o.axisCL, o.wallSide, o.isVertical, o.refCL, o.refOffset, o.width, o.category, o.subType,
    {
      hingeSide: o.hingeSide, swingSide: o.swingSide, fixtureType: o.fixtureType, sillHeight: o.sillHeight, height: o.height,
      finish: o.finish, materialGlass: o.materialGlass, frameDepth: o.frameDepth, hardware: o.hardware, note: o.note,
      handleHeight: o.handleHeight,
      frameFaceWidth: o.frameFaceWidth, frameProjection: o.frameProjection,
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
  // 構造（袖柱・自動柱）に影響しうる変更かどうかは積むとき1回だけ判定し、undo/redo両クロージャで
  // 使い回す（毎回同じboolになるはずだが、判定を1箇所に固定して再計算のたびに揺れないようにする）。
  const geometryChanged = openingGeometryChanged(before, after);
  if (geometryChanged) geometryListener?.(graph, project);
  return undoManager.push(
    () => {
      runInAction(() => { restoreOpening(graph, o, before); renumberOpenings(graph, project); });
      if (geometryChanged) geometryListener?.(graph, project);
    },
    () => {
      runInAction(() => { restoreOpening(graph, o, after); renumberOpenings(graph, project); });
      if (geometryChanged) geometryListener?.(graph, project);
    },
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
 * 壁の長押しメニュー「建具/窓」から呼ぶ既定値付き仮配置。既定間口が壁長・隣接開口に収まらない
 * 場合は壁中央フォールバック時に maxOpeningWidthAt の上限へクランプしてから配置する——壁長不足
 * だけを理由に配置失敗させない。それでも幅が0以下（スパン0の縮退壁等）・重なり等でNGなら
 * 配置せずエラーを返す。
 * @param {string|null} [subType] 明示的な種別キー（openingCatalog.js のキー）。指定時は該当カタログ
 *   エントリを使う（見つからなければ catalog[0] へフォールバック）。省略時は従来どおり catalog[0]
 *   （＝建具ラジアルの既定＝singleSwing、窓ラジアルの既定＝引き違い窓）。
 * @returns {{ opening: object|null, error: string|null }}
 */
export function placeOpeningWithDefaults(graph, project, wall, worldPos, category, subType = null) {
  const wallKind = wall.isExteriorWall ? 'exterior' : 'interior';
  const catalog = category === OpeningCategory.WINDOW ? openingSubTypeList('window') : getFittingOptions(wallKind);
  const entry = (subType && catalog.find(e => e.key === subType)) ?? catalog[0];
  if (!entry) return { opening: null, error: 'この壁に配置できる建具がありません' };

  const resolvedSubType = entry.key;
  let width = entry.defaultWidth;
  const height = defaultOpeningHeight(category, resolvedSubType);
  const sillHeight = category === OpeningCategory.WINDOW ? 800 : null;
  const fixtureType = defaultFixtureSymbolFor(category, wallKind, entry.mechanism);
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
    // 壁中央へフォールバックしても既定幅(width)がそのまま収まるとは限らない（壁長不足・
    // 隣接開口との重なり）ため、中心確定後に maxOpeningWidthAt の上限へクランプして再検証する。
    // 幅を先に壁長だけでクランプしない——Math.round による中心座標の丸め（奇数スパン等）で
    // 中心と幅を別々に決めると依然 coord2>hi になり得るため、中心確定後に実際の上限で合わせる。
    const wallLo = Math.min(wall.coord1, wall.coord2), wallHi = Math.max(wall.coord1, wall.coord2);
    refOffset = Math.round((wallLo + wallHi) / 2 - refCL.effectiveValue);
    centerCoord = refCL.effectiveValue + refOffset;
    width = Math.min(width, maxOpeningWidthAt(wall, centerCoord, graph, null));
    err = validateOpeningPlacement(wall, centerCoord - width / 2, centerCoord + width / 2, graph, null);
  }
  if (err) return { opening: null, error: err };
  // 0幅は coord1===coord2 のため validateOpeningPlacement の範囲外／重なり判定を素通りしてしまう
  // （境界チェックでは検知できない。例: 壁中央でちょうど接する2開口に埋まった壁は、幅0の点が
  // どちらの開口とも厳密比較で重ならず判定を通過する）——クランプ後も幅が残らない場合は別途弾く。
  // 壁上に既存開口が1つでもあれば「開口で埋まっている」のが真因なのでERR_OPENING_OVERLAPを返し、
  // 既存開口が無ければ壁自体の範囲不足（スパン0の縮退壁等）なのでERR_OPENING_OUT_OF_WALLを返す。
  if (width <= 0) {
    const error = findOpeningsOnWall(wall, graph).length > 0 ? ERR_OPENING_OVERLAP : ERR_OPENING_OUT_OF_WALL;
    return { opening: null, error };
  }

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
  const swingSide = defaultSwingSideFor(wall, graph, centerCoord, hingeSide, entry.mechanism);
  // 備考欄の初期値は defaultNoteFor が唯一の定義箇所（materialGlassと同じ規約）。
  const note = defaultNoteFor(category, entry.mechanism);
  // 三方枠は見付・出幅の初期値（20/12）を配置時に明示保存する（materialGlassと同じ「配置時に設定」
  // 規約。建具モードの欄に初期値が見える）。それ以外の機構では意味を持たないため null のまま。
  const frameOnly = entry.mechanism === OpeningMechanism.FRAME_ONLY;
  const frameFaceWidth  = frameOnly ? DEFAULT_FRAME_FACE_MM : null;
  const frameProjection = frameOnly ? DEFAULT_FRAME_PROJECTION_MM : null;
  const opening = graph.addOpening(wall.axisCL, wallSide, wall.isVertical, refCL, refOffset, width, category, resolvedSubType,
    { hingeSide, swingSide, fixtureType, sillHeight, height, materialGlass, note, frameFaceWidth, frameProjection });
  undoManager.push(
    () => {
      runInAction(() => { graph.removeShape(opening.id); renumberOpenings(graph, project); });
      geometryListener?.(graph, project);
    },
    () => {
      runInAction(() => { addOpeningFromSnapshot(graph, opening); renumberOpenings(graph, project); });
      geometryListener?.(graph, project);
    },
  );
  runInAction(() => renumberOpenings(graph, project));
  // 新規配置は常に構造へ影響しうる（幅0はすでに弾いている＝必ず何らかの範囲を占める）ため、
  // pushOpeningUndoのopeningGeometryChanged判定を経ずに常に通知する。
  geometryListener?.(graph, project);
  return { opening, error: null };
}

/** 開口削除（旧 'opening-del' の実装を移設）。 */
export function removeOpeningWithUndo(graph, project, o) {
  graph.removeShape(o.id);
  undoManager.push(
    () => {
      runInAction(() => { addOpeningFromSnapshot(graph, o); renumberOpenings(graph, project); });
      geometryListener?.(graph, project);
    },
    () => {
      runInAction(() => { graph.removeShape(o.id); renumberOpenings(graph, project); });
      geometryListener?.(graph, project);
    },
  );
  runInAction(() => renumberOpenings(graph, project));
  // 削除も配置と同じく常に構造へ影響しうる（占めていた範囲が空くため）ため無条件で通知する。
  geometryListener?.(graph, project);
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
 * 「位置」欄（refOffset）の確定規則（ユーザー裁定 2026-09-14「範囲端へクランプ＋トースト」）:
 * 可動範囲（openingMove.js openingRefOffsetRange＝ドラッグと同じ範囲）が引けるならその端へクランプし、
 * 値が変わったときだけメッセージを返す。範囲が引けない（ホスト壁なし＝制約なし／収まる余地なし）
 * ときは従来どおり validateOpeningEdit で判定し、NGなら value:null（呼び出し側が前値へ戻す）。
 * 幅編集（onEditDim）の「丸められるときは丸める／置けないときは弾く」二段構えと同じ思想。
 * @returns {{ value:number|null, message:string|null }}
 */
export function resolveRefOffsetEdit(o, graph, refOffset) {
  // 有限でない値（NaN/Infinity）は前値へ戻す——clampRefOffset は NaN を素通しする規約のため、ここで
  // 止めないと opening.refOffset に NaN が書かれる（QA指摘 2026-09-14。numField は絶対値化するので通常は来ない）。
  if (!Number.isFinite(refOffset)) return { value: null, message: null };
  const range = openingRefOffsetRange(o, graph);
  if (range) {
    const value = clampRefOffset(refOffset, range);
    const message = value !== refOffset ? `位置を可動範囲 ${range.min}〜${range.max}mm に丸めました` : null;
    return { value, message };
  }
  const err = validateOpeningEdit(o, graph, { width: o.width, refOffset });
  return err ? { value: null, message: err } : { value: refOffset, message: null };
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

/**
 * 種別（機構）を変更したときの建具記号の差し替え規則: 現在の記号がライブラリに無い（未知。
 * ユーザーがカタログ記号以外を保存しただけの状態。10g）ならそのまま保持し、種別変更で黙って
 * 既定記号へ差し替えない（10g QA指摘Minor-3・ステップ12e）。現在の記号が既知なら、新機構の
 * 記号スコープ（getFixtureSymbols(category, newMechanism)）に含まれていればそのまま維持し、
 * 含まれていなければ新機構の既定記号（defaultFixtureSymbolFor）へ差し替える。三方枠(FRAME_ONLY)
 * ⇔それ以外の種別変更で記号が自動的に WF/SF/SSF ⇔ WD/AD 等へ切り替わる唯一の判定ロジック。
 * currentSymbolが未設定(null等)のときはfindFixtureSymbolがnullを返すため未知扱いにはせず、
 * 従来どおりスコープ判定（該当なし）を経て既定記号へ差し替える。
 */
export function fixtureTypeAfterSubTypeChange(currentSymbol, category, wallKind, newMechanism) {
  if (typeof currentSymbol === 'string' && currentSymbol !== '' && !findFixtureSymbol(currentSymbol)) return currentSymbol;
  const scoped = getFixtureSymbols(category, newMechanism);
  if (scoped.some(f => f.key === currentSymbol)) return currentSymbol;
  return defaultFixtureSymbolFor(category, wallKind, newMechanism);
}

/**
 * 記号selectの選択肢一覧（唯一の定義箇所。ステップ12e）。OpeningEditor.jsx はこの結果を
 * そのまま並べるだけにする（getFixtureSymbolsを直接optionに使わない）。
 * getFixtureSymbols(category, mechanism)の絞り込み結果に、現在の記号(currentSymbol)が
 * その絞り込みに含まれていなければ先頭に1件足す:
 *   - ライブラリに無い記号（findFixtureSymbolがnull）→ unknown:true・label:'（不明）'+記号
 *     （10g QA指摘Minor-3。種別変更で黙って既定値へ差し替えず、editorのselectにも残す）。
 *   - ライブラリにはあるが別カテゴリ/別機構（スコープ外。例: 三方枠専用記号を通常機構で表示）
 *     → outOfScope:true・そのエントリのlabel。
 * currentSymbolが絞り込みに含まれていれば（または未設定）先頭追加は行わず、絞り込み結果を
 * そのまま返す。
 * @param {string} category OpeningCategory ('fitting'|'window')
 * @param {string|undefined} mechanism OpeningMechanism（未指定はスコープ無し記号のみ）
 * @param {string|null|undefined} currentSymbol 現在保存されている記号
 * @returns {{key:string, label:string, unknown?:boolean, outOfScope?:boolean}[]}
 */
export function fixtureSymbolOptions(category, mechanism, currentSymbol) {
  const scoped = getFixtureSymbols(category, mechanism);
  if (!currentSymbol || scoped.some(f => f.key === currentSymbol)) return scoped;
  const entry = findFixtureSymbol(currentSymbol);
  const extra = entry
    ? { key: currentSymbol, label: entry.label, outOfScope: true }
    : { key: currentSymbol, label: `（不明）${currentSymbol}`, unknown: true };
  return [extra, ...scoped];
}

/**
 * 種別（機構）を変更したときの「備考」欄の差し替え規則: materialGlassAfterFixtureChange と同じ規則
 * （現在値が未入力(null)、または旧機構の初期値のままなら新機構の初期値へ差し替える。ユーザーが
 * 編集済みの値は上書きしない）。初期値は category も加味する defaultNoteFor から引く——窓
 * カテゴリはSWING機構（開き窓等）でも常にnullのため、窓のFIX→開き窓のような変更では
 * 新旧とも初期値がnullのまま＝現在値null以外は「編集済み」として保持され、誤って
 * 'レバーハンドル' が入ることはない。
 */
export function noteAfterSubTypeChange(currentNote, category, oldMechanism, newMechanism) {
  const isUnedited = currentNote == null || currentNote === defaultNoteFor(category, oldMechanism);
  return isUnedited ? defaultNoteFor(category, newMechanism) : currentNote;
}

/**
 * 種別（機構）を変更したときの swingSide 差し替え規則: materialGlassAfterFixtureChange・
 * noteAfterSubTypeChange と同じ規則（現在値が旧機構の既定値(defaultSwingSideFor)と一致する
 * ＝未編集の場合のみ新機構の既定値へ差し替える。ユーザーが「開く方向反転」ボタン等で
 * 手動編集した値＝旧既定と異なる値は種別変更後も維持する）。
 */
export function swingSideAfterSubTypeChange(currentSwingSide, wall, graph, centerCoord, hingeSide, oldMechanism, newMechanism) {
  const oldDefault = defaultSwingSideFor(wall, graph, centerCoord, hingeSide, oldMechanism);
  const isUnedited = currentSwingSide === oldDefault;
  return isUnedited ? defaultSwingSideFor(wall, graph, centerCoord, hingeSide, newMechanism) : currentSwingSide;
}
