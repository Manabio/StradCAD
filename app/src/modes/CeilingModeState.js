import { makeObservable, observable, action, runInAction } from 'mobx';
import { buildCeilingCellOwners } from '../ceiling/ceilingOwners.js';
import { beginCeilingDrag, extendCeilingDrag } from '../ceiling/ceilingSelection.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { composeList, composeCatalog, docDiffMap } from '../catalog/catalogRegistry.js';

// 天伏（天井伏図）モードの状態。仕上げモードとは独立。仕上げ表との共有はデータ（Room の天井欄）と
// 純モジュールだけ（ユーザー裁定 2026-10-10）。FinishModeState を継承しない。
// graph は変えない。材データ（天井材・仕上げの表示名・選択肢用）は init() で FinishModeState.init と同じ経路
// （materialData.js の動的 import → composeCatalog）で読む（S3）。天井セルの選択（S2）は
// ceiling/ceilingSelection.js（純モジュール）が組み立て、ここは選択・ドラッグ中の状態を持つだけ。
// 選択・dragState は undo に積まない。
// 階切替・モード切替では App.jsx の effect が前のモードを dispose して破棄する（追加配線なし）。

/** 専用パネルのタブ id（内部＝部屋ごとの天井欄／階段＝階段ごとの天井欄）。 */
export const CEILING_TABS = Object.freeze(['interior', 'stair']);

const NO_CELLS = Object.freeze([]);
const NO_KEYS = new Set();

export class CeilingModeState {
  selectedRoomId = null;     // 一覧で強調中の行 id（部屋 id／部屋の無い階段は stair.id） | null
  activeTab      = 'interior'; // 'interior' | 'stair'
  selection      = null;     // null | { owner, cellKeys: Set<string> }（確定した天井セルの選択）
  dragState      = null;     // null | { owner, visited, lastWorld, owners }（ドラッグ中）

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
      selectedRoomId: observable,
      activeTab:      observable,
      selection:      observable.ref,
      dragState:      observable.ref,
      selectRoom:     action,
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

  /** 行のタップ・選択の確定で強調行を変える。選択中のセルの所属と別の行なら、セルの選択は解除する。 */
  selectRoom(id) {
    this.selectedRoomId = id ?? null;
    if (this.selection && this.selection.owner.rowId !== this.selectedRoomId) this.selection = null;
  }

  setActiveTab(tab) {
    if (!CEILING_TABS.includes(tab)) throw new Error(`CeilingModeState.setActiveTab: 未知のタブです: ${tab}`);
    this.activeTab = tab;
  }

  // ---- 天井セルのドラッグ選択（ドラッグしたセルだけ。部屋を超えない）----

  /** 押した点が選べるセルなら dragState を作る。選べないセルからは何もしない（前の選択を保つ）。 */
  startDrag(graph, wx, wy) {
    const owners = buildCeilingCellOwners(graph);
    const drag = beginCeilingDrag(graph, owners, wx, wy);
    if (!drag) return;
    this.dragState = { ...drag, owners };
  }

  updateDrag(graph, wx, wy, stepMm) {
    const state = this.dragState;
    if (!state) return;
    const next = extendCeilingDrag(graph, state.owners, state, wx, wy, stepMm);
    if (next !== state) this.dragState = { ...next, owners: state.owners };
  }

  /**
   * ドラッグ確定。dragState があればその所属・セルを選択に置き換える（トグル・追加なし）。
   * 無いとき: タップなら選択解除、タップでなければ（選べないセルからのドラッグ）何もしない。
   */
  commitDrag({ tap = false } = {}) {
    const state = this.dragState;
    if (!state) {
      if (tap) { this.selection = null; this.selectedRoomId = null; }
      return;
    }
    this.selection = { owner: state.owner, cellKeys: new Set(state.visited.keys()) };
    this.selectedRoomId = state.owner.rowId;
    this.activeTab = state.owner.kind === 'stair' ? 'stair' : 'interior';
    this.dragState = null;
  }

  /** ドラッグ中だけ消す（選択は保つ）。App.jsx の interruptCurrentAction が cancelDrag?.() で呼ぶ。 */
  cancelDrag() { this.dragState = null; }

  /** ドラッグ中のプレビュー（訪れたセルの矩形）。 */
  get previewCells() { return this.dragState ? [...this.dragState.visited.values()] : NO_CELLS; }

  /** 確定した選択のセルキー集合。 */
  get selectedCellKeys() { return this.selection ? this.selection.cellKeys : NO_KEYS; }

  // ---- Lifecycle ----

  dispose() {
    this.cancelDrag();
    this.selection = null;
    this.selectRoom(null);
  }
}
