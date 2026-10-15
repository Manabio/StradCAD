import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { resolveMoveRange } from '../transform/followerGraph.js';
import { runBusy } from '../uiBusy.js';
import { prepareCenterLineMove } from './clMove.js';
import { buildCeilingCellOwners, ceilingCellOwnersOf } from '../ceiling/ceilingOwners.js';
import { beginCeilingDrag, extendCeilingDrag } from '../ceiling/ceilingSelection.js';
import { ceilingGroupsOf, zoneGroupId } from '../ceiling/ceilingGroups.js';
import { stairUnderCeilingKeys } from '../ceiling/ceilingStairUnder.js';
import { createZone } from '../ceiling/ceilingZones.js';
import { nodePathOf } from '../ceiling/ceilingPanelRows.js';
import { roomCeilingShapeOf } from '../ceiling/roomCeilingShape.js';
import { stairCeilingSlopeDefaults } from '../ceiling/ceilingShapeFields.js';
import { CeilingShape } from '../core/constants.js';
import { cellBoundsFromKey } from '../finish/gridCells.js';
import { roomCeilingHeight } from '../finish/roomMetrics.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { withFinishUndo } from '../finish/finishUndo.js';
import { withGraphReadScope } from '../graphReadScope.js';
import { markDirty } from '../dirtyState.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { composeList, composeCatalog, docDiffMap } from '../catalog/catalogRegistry.js';

// 天伏（天井伏図）モードの状態。仕上げモードとは独立。仕上げ表との共有はデータ（Room の天井欄）と
// 純モジュールだけ（ユーザー裁定 2026-10-10）。FinishModeState を継承しない。
// 材データ（天井材・仕上げの表示名・選択肢用）は init() で FinishModeState.init と同じ経路
// （materialData.js の動的 import → composeCatalog）で読む（S3）。天井セルの選択は群（ceiling/ceilingGroups.js。S12b）が単位:
// タップ・ドラッグで群全体を選び、選択中の群の残り（部屋・階段）を再タップ／ドラッグすると、なぞったセルで新しい区画を作る。
// 区画を作る口は commitDrag の 'create' だけで（withFinishUndo＋markDirty。ctx={graph, project} を呼び出しごとに受ける）、他は graph を変えない。
// 選択・dragState は undo に積まない。
// 階切替・モード切替では App.jsx の effect が前のモードを dispose して破棄する（追加配線なし）。

/** 専用パネルのタブ id（内部＝部屋ごとの天井欄／階段＝階段ごとの天井欄）。 */
export const CEILING_TABS = Object.freeze(['interior', 'stair']);

const NO_CELLS = Object.freeze([]);
const NO_KEYS = new Set();

export class CeilingModeState {
  expandedPath   = [];       // パネルで開いているノード id の経路（最上位から。各段1つだけ＝アコーディオン）。ノード id は群 id
  activeTab      = 'interior'; // 'interior' | 'stair'
  selection      = null;     // null | { owner, groupId, cellKeys: Set<string> }（確定した群の選択。cellKeys は選んだ時点の写し）
  dragState      = null;     // null | { owner, visited, lastWorld, owners, intent: 'select'|'create', groupId, group, preview }（ドラッグ中）
  moveState      = null;     // null | { cl, originalValue, range }（天井芯の移動中。S8b。FloorplanModeState.moveState と同形）
  stairUnderContext = null;  // null | { planeId, lowerStairCellBounds, floorHeightMm }（階段下の群の判定材料。App の直下階 peek が渡す。null は分けない）
  _pendingPreload = null;    // { clId, promise } | null — 長押し中の移動範囲の先読み結果（graph は持たず promise だけ）

  // ---- 材データ（突入時ロード。dispose では解放せず、モードのインスタンスごと捨てられる。FinishModeState と同名・同じ意味） ----
  materialsLoaded = false;   // ロード完了フラグ
  materialError   = null;    // App.jsx ローダーが汎用に読むトースト用。graph を持たないため照合はせず常に null
  materials       = null;    // 材マスタ配列（読み取り専用）
  materialMap     = null;    // Map<code, material>
  materialDiffs   = null;    // docDiffMap(material)。Map<code, {baseOrigin, diffFields, baseEntry}>

  // graph は持たない（階切替で古い graph を抱える穴を作らない。パネルは App から渡る graph prop を読む）。
  constructor() {
    makeObservable(this, {
      materialsLoaded: observable,
      materialError:   observable,
      // observable.ref: 材数百件を MobX にプロキシ化させない・builtin エントリとの === 同一性を保つ
      // （FinishModeState と同じ理由）
      materials:       observable.ref,
      materialMap:     observable.ref,
      materialDiffs:   observable.ref,
      expandedPath:   observable.ref,
      selectedRoomId: computed,
      toggleNode:     action,
      activeTab:      observable,
      selection:      observable.ref,
      dragState:      observable.ref,
      moveState:      observable.ref,
      stairUnderContext: observable.ref,
      setStairUnderContext: action,
      isMoving:       computed,
      startMove:      action,
      updateMove:     action,
      commitMove:     action,
      cancelMove:     action,
      selectNode:     action,
      setActiveTab:   action,
      startDrag:      action,
      updateDrag:     action,
      commitDrag:     action,
      cancelDrag:     action,
    });
  }

  /**
   * 材データを動的 import でロードする（FinishModeState.init と同じ経路）。結果の形も同じ { ok, error }。
   * graph を持たないため自階の材コードの照合はしない（error は常に null。未解決コードの検出は
   * 仕上げモード突入時と読込み時の照合が担い、天伏パネルは解けないコードをそのまま表示する）。
   * composeCatalog の重複禁止検査などの例外は呼び出し元（App.jsx のモード切替）まで素通しする。
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  async init() {
    const matMod = await import('../finish/materials/materialData.js');
    const materials   = composeList(CatalogKind.MATERIAL, matMod.MATERIALS);
    const materialMap = composeCatalog(CatalogKind.MATERIAL, matMod.MATERIALS);
    const materialDiffs = docDiffMap(CatalogKind.MATERIAL, matMod.MATERIALS);
    runInAction(() => {
      this.materials       = materials;
      this.materialMap     = materialMap;
      this.materialDiffs   = materialDiffs;
      this.materialsLoaded = true;
      this.materialError   = null;
    });
    return { ok: true, error: null };
  }

  /** カテゴリ（'backing' / 'panel' / 'finish'）で材選択肢をフィルタ（未ロードなら空）。 */
  getMaterialsByCategory(category) {
    return (this.materials ?? []).filter(m => m.category === category);
  }

  /** 材コードの docDiffMap エントリ（{baseOrigin, diffFields, baseEntry}）。差分なし・未ロードは null。 */
  materialDiff(code) { return this.materialDiffs?.get(code) ?? null; }

  /** 選択中の群 id（ModePanel／BottomSheet の raiseSignal 用）。三角の開閉（expandedPath）では変わらない＝シートを縮めない。選択なしは null。 */
  get selectedRoomId() {
    return this.selection?.groupId ?? null;
  }

  /**
   * 三角のクリック。depth 段目のノード id が開いていれば、その段以下を畳む（path.slice(0, depth)）。
   * 別のノードなら、その段を id に付け替えて深い段を畳む（各段で開くのは1つだけ）。
   */
  toggleNode(depth, id) {
    const path = this.expandedPath;
    this.expandedPath = path[depth] === id ? path.slice(0, depth) : [...path.slice(0, depth), id];
  }

  setActiveTab(tab) {
    if (!CEILING_TABS.includes(tab)) throw new Error(`CeilingModeState.setActiveTab: 未知のタブです: ${tab}`);
    this.activeTab = tab;
  }

  // ---- 階段下の群（選択専用。ceiling/ceilingStairUnder.js）----

  /** 階段下の判定材料を置く（App.jsx の直下階 peek の effect が呼ぶ）。null は「判定できない＝分けない」。 */
  setStairUnderContext(ctx) { this.stairUnderContext = ctx; }

  /**
   * graph の階段下の天井セル（stairId → Set）。判定材料が無い・別の階のもの（planeId 不一致。階切替直後の古い peek）は null＝分けない。
   * 読み取りスコープで包まない（パネルの observer が graph の変更に反応できるように。アクションは呼び側が withGraphReadScope で包む）。
   * owners を渡せば所属索引を作り直さない。
   */
  stairUnderKeysOf(graph, owners = null) {
    const ctx = this.stairUnderContext;
    if (!graph || !ctx || ctx.planeId !== graph.plane?.id) return null;
    return stairUnderCeilingKeys(graph, owners ?? ceilingCellOwnersOf(graph), ctx);
  }

  /** 群の一覧（階段下の群込み）。アクションから呼ぶ用に読み取りスコープで包む。 */
  _groupsOf(graph, owners) {
    return withGraphReadScope(graph, () => ceilingGroupsOf(graph, owners, this.stairUnderKeysOf(graph, owners)));
  }

  // ---- 天井セルの群選択と、選択中の残りからの区画の作成（S12b）----

  /**
   * 群 g を選択にして、展開の経路を合わせる（owner は選択の所属）。switchTab が真（キャンバスの選択）なら所属でタブを切り替え、
   * 偽（パネルの行クリック）なら今のタブのまま。展開は path（行クリックなら押された行の祖先の経路）、無ければ nodePathOf（そのタブの木に無ければ畳む）。
   */
  _selectGroup(graph, group, owner, groupId, switchTab, path = null) {
    this.selection = { owner, groupId, cellKeys: new Set(group.cells) };
    if (switchTab) this.activeTab = owner.kind === 'stair' ? 'stair' : 'interior';
    this.expandedPath = path ?? nodePathOf(graph, groupId, this.activeTab, this.stairUnderKeysOf(graph)) ?? [];
  }

  /**
   * 押した点が選べるセルなら dragState を作る。選べないセルからは何もしない（前の選択を保つ）。
   * 開始セルの群 G を引き、G が選択中の群で room／stair の残りかつ2セル以上なら intent 'create'（なぞったセルで区画を作る。G の中だけ）、
   * それ以外は 'select'（G 全体を選ぶ。プレビューは G 全体）。区画の群（zone）の再タップは 'select'＝何も作らない。
   */
  startDrag(graph, wx, wy) {
    const owners = buildCeilingCellOwners(graph);
    const drag = beginCeilingDrag(graph, owners, wx, wy);
    if (!drag) return;
    const { groupOfCell, groups } = this._groupsOf(graph, owners);
    const groupId = groupOfCell.get(drag.visited.keys().next().value);
    const group = groups.get(groupId);
    if (!group) return;
    // 階段下の群は1セルでも・全体でも区画にできる（階段下を丸ごと1区画にする。他の群は2セル以上の真部分集合だけ）
    if (this.selection?.groupId === groupId && group.kind !== 'zone' && group.cells.size >= (group.kind === 'stairUnder' ? 1 : 2)) {
      const visited = new Map([...drag.visited].filter(([key]) => group.cells.has(key)));
      this.dragState = { ...drag, visited, owners, intent: 'create', groupId, group, preview: NO_CELLS };
      return;
    }
    const preview = withGraphReadScope(graph, () => [...group.cells]
      .map(key => { const b = cellBoundsFromKey(key, graph); return b && { key, ...b }; })
      .filter(Boolean));
    this.dragState = { ...drag, owners, intent: 'select', groupId, group, preview };
  }

  updateDrag(graph, wx, wy, stepMm) {
    const state = this.dragState;
    if (!state || state.intent !== 'create') return; // 'select' は群全体なので、なぞったセルは見ない
    const next = extendCeilingDrag(graph, state.owners, state, wx, wy, stepMm, state.group.cells);
    if (next !== state) this.dragState = { ...state, visited: next.visited, lastWorld: next.lastWorld };
  }

  /**
   * ドラッグ確定。dragState が無いとき: タップなら選択解除、タップでなければ（選べないセルからのドラッグ）何もしない。
   * 'select': タップでもドラッグでも選択を開始セルの群全体に置き換える（トグル・追加なし）。
   * 'create': なぞったセル N（G の中）が空、または G と同じ（真部分集合でない）なら何もしない（選択はそのまま）。
   *   それ以外は書込み先の部屋（room 群は R、stair 群は対の部屋。無ければ何もしない）へ新しい区画を作る（withFinishUndo＋markDirty。
   *   undo 1回で消える）。初期値: room 群は部屋の CH（数値で固定）と部屋の形状、stair 群は直進系の傾斜（stairCeilingSlopeDefaults）、算出できなければ平面＋部屋の CH。
   *   作ったあとは新しい区画の群を選択して展開する。ctx（{graph, project}）は 'create' では必須（省略はプログラミングエラーとして例外）。
   */
  commitDrag({ tap = false, ctx } = {}) {
    const state = this.dragState;
    if (!state) {
      if (tap) { this.selection = null; this.expandedPath = []; }
      return;
    }
    this.dragState = null;
    if (state.intent === 'select') {
      if (!ctx) throw new Error('CeilingModeState.commitDrag: 展開の経路を引くには ctx（{ graph, project }）が必要です');
      this._selectGroup(ctx.graph, state.group, state.owner, state.groupId, true);
      return;
    }
    if (!ctx) throw new Error('CeilingModeState.commitDrag: 区画の作成には ctx（{ graph, project }）が必要です');
    const { graph, project } = ctx;
    const group = state.group;
    const cells = new Set(state.visited.keys());
    // 真部分集合のときだけ作る（階段下の群は同一集合も可）
    if (cells.size === 0 || (group.kind !== 'stairUnder' && cells.size >= group.cells.size)) return;
    const room = group.roomId ? graph.roomMap.get(group.roomId) : null;
    if (!room) return; // 対の部屋の無い階段
    const spec = this._newZoneSpec(graph, project, group, room, cells);
    let created = null;
    withFinishUndo(graph, () => {
      created = createZone(graph, room, cells, spec);
      if (created.zoneId) room.setCeilingZones(created.zones);
    });
    if (!created.zoneId) return;
    markDirty();
    this.selectNode(graph, zoneGroupId(room.id, created.zoneId));
  }

  _newZoneSpec(graph, project, group, room, cells) {
    const ch = roomCeilingHeight(graph, room).mm;
    if (group.kind === 'room') return { heightMm: ch, ...roomCeilingShapeOf(room) };
    const stair = graph.stairMap.get(group.stairId);
    const slope = stairCeilingSlopeDefaults(graph, stair, cells, floorHeightAbove(project, project?.activePlane));
    return slope ?? { heightMm: ch, shape: CeilingShape.FLAT, dims: [] };
  }

  /**
   * 群 id のノードを選ぶ（パネルの行クリック用。S12c）。群のセルで選択を作り、今のタブの木での経路を開く（タブは切り替えない）。
   * セルが 0 件（群が無い。天井なしの部屋・全セルが区画に入った部屋の残りなど）なら展開だけ（選択は変えない）。
   * 今のタブの木に無いノード（undo などで消えた区画）は展開を畳む（expandedPath = []）。
   * path（行クリック時の、押された行の祖先を含む経路）があればそれをそのまま開く（同じ区画が2本の階段の下に出ても押した側が開く）。
   */
  selectNode(graph, groupId, path = null) {
    const owners = buildCeilingCellOwners(graph);
    const group = this._groupsOf(graph, owners).groups.get(groupId);
    if (group) { this._selectGroup(graph, group, group.owner, groupId, false, path); return; }
    this.expandedPath = path ?? nodePathOf(graph, groupId, this.activeTab, this.stairUnderKeysOf(graph)) ?? [];
  }

  /** ドラッグ中だけ消す（選択は保つ）。App.jsx の interruptCurrentAction が cancelDrag?.() で呼ぶ。 */
  cancelDrag() { this.dragState = null; }

  /** ドラッグ中のプレビュー。'select' は群全体、'create' は訪れたセルの矩形。 */
  get previewCells() {
    const s = this.dragState;
    if (!s) return NO_CELLS;
    return s.intent === 'create' ? [...s.visited.values()] : s.preview;
  }

  /** 確定した選択のセルキー集合。 */
  get selectedCellKeys() { return this.selection ? this.selection.cellKeys : NO_KEYS; }

  // ---- 天井芯の移動（長押しメニューの「移動」。S8b）----
  // FloorplanModeState の CL 移動と同じ形・同じ文言（範囲解決は modes/clMove.js prepareCenterLineMove が共有）。
  // graph・project は保持せず、呼び出しごとに ctx = { graph, project } で受ける（階切替で古い graph を抱えない。
  // new CeilingModeState() の引数なし生成を保つ）。確定は transform/centerLineOps.js commitCLMoveOp
  // （App 側 commitCLMove。最後に commitMove を呼ぶ）。

  /** 長押し開始時に呼ぶ移動範囲の先読み（確定までの待ち時間を使う）。ctx が無ければ何もしない。 */
  preloadMove(cl, ctx) {
    if (!ctx) return;
    this._pendingPreload = { clId: cl.id, promise: resolveMoveRange(ctx.project, ctx.graph, cl) };
  }

  /** 移動を開始する。範囲計算が閾値超過なら moveState を立てずエラー文言を返す（成功は null）。
   *  ctx は必須。省略はプログラミングエラーとして例外（エラー文言では返さない）。 */
  async startMove(cl, ctx) {
    if (!ctx) throw new Error('CeilingModeState.startMove: ctx（{ graph, project }）が必要です');
    const pending = this._pendingPreload;
    this._pendingPreload = null;
    return runBusy('移動準備', async () => {
      const { moveState, error } = await prepareCenterLineMove(ctx.project, ctx.graph, cl, pending);
      if (error) return error;
      runInAction(() => { this.moveState = moveState; });
      return null;
    });
  }

  updateMove(newValue) {
    if (!this.moveState) return;
    runInAction(() => {
      // cl.value は確定済み座標のまま保持し、pendingDelta だけ更新する（FloorplanModeState.updateMove と同じ）。
      const { cl, range } = this.moveState;
      const clamped = Math.min(Math.max(newValue, range.min), range.max);
      cl.pendingDelta = clamped - cl.value;
    });
  }

  commitMove() { this.moveState = null; }

  cancelMove() {
    if (this.moveState) {
      runInAction(() => { this.moveState.cl.pendingDelta = 0; });
    }
    this.moveState = null;
  }

  get isMoving() { return this.moveState !== null; }

  // ---- Lifecycle ----

  dispose() {
    this.cancelMove();
    this.cancelDrag();
    this.selection = null;
    this.expandedPath = [];
  }
}
