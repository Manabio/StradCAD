import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { regionCellsAt, refreshCells, cellBoundsFromKey, cellBoundsList, worldToCell } from '../finish/gridCells.js';
import { classifyStairArea } from '../finish/stair/stairClassify.js';
import { cellsBeyondBreak } from '../finish/stair/stairGeometry.js';
import { ensureUnderStairSplit, removeUnderStairSplit, findUnderStairSplitCLs } from '../finish/stair/stairUnderSplit.js';
import { stairUnderRoomsOf } from '../finish/stair/stairUnderRooms.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { snapshotFinishState, pushFinishUndo, withFinishUndo } from '../finish/finishUndo.js';
import { FINISH_FIELDS } from '../finish/roomReinterpret.js';
import { ERR_MATERIAL_MISMATCH } from '../error.js';
import { RoomFeature, RoomKind } from '@core';

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// グラフ上で「材コード」を保持するフィールド（照合対象）。
// 永続化されるのは選択された材のみ（材マスタ全体は保存しない）ため、
// これらのフィールドが参照する材コードのみを照合する。
const MATERIAL_CODE_GRAPH_FIELDS    = [
  'exteriorWallBacking',
  'interiorWallBacking', 'ceilingBacking', 'floorBacking',
]; // per-floor 設定
const MATERIAL_CODE_OVERRIDE_FIELDS = ['wallMaterial', 'wallFinish'];               // Room.customOverrides

export class FinishModeState {
  dragState      = null; // { currentCell, visitedCells: Map, stairKeys: Set, startCellKey } | null
  selectedRoomId = null;
  namingRoomId   = null;
  namingIsNew    = false; // namingRoomId が新規作成（commitDragでaddRoom）か既存部屋選択かのフラグ
  // commitDragでダイアログを開いたときの選択順セルキー配列（非observable。フェーズ4: 階段変換時の
  // 上り口ヒントに使う。startDrag優先1の階段選択経路では設定しない）。ダイアログを閉じる際にクリア。
  namingCellOrder = null;
  selectedStairId = null;

  // ---- 直下階の階段（見下げ表示のヒット判定用。init() で peek しロード） ----
  lowerStairs = []; // Array<{ stair, cellBounds }>（cellBounds は下階graphで解決したワールド矩形配列）

  // ---- 直上階の吹抜け（部屋カードのCH自動計算用。init() で peek しロード） ----
  upperVoids = []; // Array<{ cellBounds, ch }>（cellBounds は上階graphで解決したワールド矩形配列、ch は吹抜け部屋のCH実効値）
  upperFloorHeight = null; // 当該階FL標高〜直上階FL標高の差(mm)。上階が無ければ null

  // ---- 材データ（突入時ロード・離脱時破棄） ----
  materialsLoaded = false;       // ロード完了フラグ
  materialError   = null;        // 照合エラーメッセージ | null
  materials       = null;        // 材マスタ配列（読み取り専用）
  materialMap     = null;        // Map<code, material>
  interiorMasters = null;        // 内装マスター（key → 定義）

  constructor(graph, project = null) {
    this.graph = graph;
    this.project = project;
    this._disposed = false; // dispose() 後の非同期継続（_loadLowerStairs 等）の書き込みを止めるガード
    // 仕上げモード突入後に applyNaming() で確定した Room ID を記録する。
    // FinishModeState はモード切替のたびに new で生成されるため、
    // フロアプランモードに戻ると自動的にリセットされる。
    this.sessionModifiedRoomIds = new Set();
    // 新規部屋ダイアログの undo 用スナップショット（部屋作成前の状態。非observable）。
    // commitDrag での作成とダイアログ確定（applyNaming）を1つの undo エントリに
    // まとめるため、確定まで push を保留する。キャンセル時は破棄（作成＋取消＝差分なし）。
    this._pendingDialogUndo = null;
    // 直近の applyNaming が積んだ undo エントリ（非observable）。階段変換時、
    // App.jsx が上階自動設置（syncUpperFloors）の巻き戻しを同じエントリへ合成するために参照する。
    this.lastNamingUndoEntry = null;
    makeObservable(this, {
      dragState:      observable.ref,
      selectedRoomId: observable,
      namingRoomId:   observable,
      namingIsNew:    observable,
      selectedStairId: observable,
      lowerStairs:     observable.ref,
      upperVoids:      observable.ref,
      upperFloorHeight: observable,
      materialsLoaded: observable,
      materialError:   observable,
      materialMap:     observable.ref,
      isDragging:     computed,
      previewCells:   computed,
      startDrag:    action,
      updateDrag:   action,
      commitDrag:   action,
      cancelDrag:   action,
      selectRoom:   action,
      applyNaming:  action,
      cancelNaming: action,
      deleteRoom:   action,
      deleteFromDialog: action,
      selectStair:  action,
      deleteStair:  action,
      revertStairToRoom:  action,
    });
  }

  // ---- 材データのロード・照合（突入時に App.jsx から1度だけ await される） ----

  /**
   * 材データ・内装マスターを動的 import でロードし、永続化データと照合する。
   * 不一致があれば this.materialError に ERR_MATERIAL_MISMATCH を設定する（throw はしない）。
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  async init() {
    // 直進階段の階段下分割CL（stairUnderSplit.js）を保証する（旧データ・上階自動設置分の
    // 補完＝開くだけで修復。syncUpperFloors と同じ自動同期のため undo 対象外）。
    runInAction(() => {
      for (const stair of this.graph.stairs) {
        ensureUnderStairSplit(stair, this.graph, this._selfStairRiser(stair));
      }
    });

    const [matMod, masterMod, compMod] = await Promise.all([
      import('../finish/materials/materialData.js'),
      import('../finish/materials/interiorMasters.js'),
      import('../finish/edgeComposition.js'),
    ]);

    const materials = matMod.MATERIALS;
    const materialMap = new Map(materials.map(m => [m.code, m]));
    this._composition = compMod; // 層構成→寸法解決（壁生成で使用）

    // 照合: 永続化データが参照する材コードがすべてマスタに存在するか
    const missing = [];
    for (const code of this._collectReferencedCodes()) {
      if (!materialMap.has(code)) missing.push(code);
    }
    const error = missing.length > 0 ? ERR_MATERIAL_MISMATCH : null;

    runInAction(() => {
      this.materials       = materials;
      this.materialMap     = materialMap;
      this.interiorMasters = masterMod.INTERIOR_MASTERS;
      this.materialsLoaded = true;
      this.materialError   = error;
    });

    await Promise.all([this._loadLowerStairs(), this._loadUpperVoids()]);

    return { ok: error === null, error };
  }

  /**
   * 直下階（activePlaneの1つ下の採用フロア）の階段を peek し、見下げクリック判定用に保持する。
   * 直下階が無い場合は空配列のまま。App.jsx の upperStairEntries（描画用）と同じ peek 経路を使う。
   * peek は非同期（IDB読込）のため、待機中に dispose() されるとモード切替後の古い状態を
   * 書き込んでしまう（App.jsx:231 の cancelled ガードと同じ問題）。_disposed を見て止める。
   */
  async _loadLowerStairs() {
    const project = this.project;
    const planes = project?.planes ?? [];
    const active = project?.activePlane;
    const idx = planes.findIndex(p => p.id === active?.id);
    const below = idx > 0 ? planes[idx - 1] : null;
    if (!below || !active) {
      if (!this._disposed) runInAction(() => { this.lowerStairs = []; });
      return;
    }
    const temp = await floorSwapManager.peek(below, project.structGraph);
    if (this._disposed) return;
    runInAction(() => {
      this.lowerStairs = temp.stairs.map(s => ({
        stair: s,
        cellBounds: cellBoundsList(s.cells, temp),
      }));
    });
  }

  /**
   * 直上階（activePlaneの1つ上の採用フロア）の吹抜け（feature='void'）を peek し、
   * 部屋カードの CH 自動計算（voidCHAbove）用に保持する。直上階が無ければ空のまま。
   * _loadLowerStairs と同じ peek 経路・_disposed ガード。
   */
  async _loadUpperVoids() {
    const project = this.project;
    const planes = project?.planes ?? [];
    const active = project?.activePlane;
    const idx = planes.findIndex(p => p.id === active?.id);
    const above = idx >= 0 && idx + 1 < planes.length ? planes[idx + 1] : null;
    if (!above || !active) {
      if (!this._disposed) runInAction(() => { this.upperVoids = []; this.upperFloorHeight = null; });
      return;
    }
    const temp = await floorSwapManager.peek(above, project.structGraph);
    if (this._disposed) return;
    const voids = temp.rooms
      .filter(r => r.feature === RoomFeature.VOID)
      .map(r => ({
        cellBounds: cellBoundsList(r.cells, temp),
        ch: r.getFinishInfo().ceilingHeight ?? temp.defaultCeilingHeight,
      }));
    runInAction(() => {
      this.upperVoids = voids;
      this.upperFloorHeight = above.elevation - active.elevation;
    });
  }

  /**
   * 部屋上部の吹抜けによる CH 自動計算。上階の吹抜け（feature='void'）が部屋セルを
   * どれだけ覆うかで判定する:
   *   全セル → { full:true, ch }（丸ごと吹抜け。CH欄は計算値の読取専用表示）
   *   一部   → { full:false, ch }（自CHに「, 計算値」を併記）
   *   覆いなし・上階なし・上階CHが数値でない（レンジ表記等） → null（通常表示）
   * ch = (上階FL標高 − 当該階FL標高) + 上階吹抜け部屋の実効CH。
   * 複数の吹抜けが覆う場合は覆うセル数が最多の吹抜けの CH を採用する。
   */
  voidCHAbove(room) {
    if (this.upperFloorHeight == null || this.upperVoids.length === 0) return null;
    const counts = new Map(); // 吹抜けエントリ → 覆っている自部屋セル数
    let covered = 0, total = 0;
    for (const key of refreshCells(room.cells, this.graph)) {
      total++;
      const b = cellBoundsFromKey(key, this.graph);
      if (!b) continue;
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
      const v = this.upperVoids.find(e =>
        e.cellBounds.some(r => cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2));
      if (v) { covered++; counts.set(v, (counts.get(v) ?? 0) + 1); }
    }
    if (covered === 0 || total === 0) return null;
    const best = [...counts.entries()].reduce((a, b2) => (b2[1] > a[1] ? b2 : a))[0];
    const upperCH = Number(best.ch);
    if (!Number.isFinite(upperCH)) return null;
    return { full: covered === total, ch: this.upperFloorHeight + upperCH };
  }

  /** 自階階段の蹴上(mm)。stair.riser 未指定なら階高/総段数から推定（App.jsx の install entries と同じ計算）。 */
  _selfStairRiser(stair) {
    if (stair.riser != null) return stair.riser;
    const fh = floorHeightAbove(this.project, this.project?.activePlane);
    return fh != null ? fh / Math.max(1, stair.totalSteps) : null;
  }

  /**
   * stair の破れ線先セル集合。cellsBeyondBreak が内部で refreshCells 済みのため、
   * 返るキーは現行グリッド分割のもの（startDrag のポインタ判定と同じ前提）。
   */
  _beyondBreakOf(stair) {
    return cellsBeyondBreak(stair, this.graph, this._selfStairRiser(stair));
  }

  /** ワールド座標 (x,y) を占有する下階階段（見下げ）を返す。無ければ null。 */
  _lowerStairForPoint(x, y) {
    for (const entry of this.lowerStairs) {
      if (entry.cellBounds.some(b => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2)) {
        return entry.stair;
      }
    }
    return null;
  }

  /**
   * 部屋ドラッグから除外する自階階段セルの Set。破れ線先セルのうち、直下階に階段が無い
   * （＝階段下エリア）ものは部屋ドラッグを許容するため除外対象から外す。
   * 階段吹抜け（STAIR_VOID。最上階の自動管理 Room）のセルも除外する
   * （commitDrag の rooms 走査から外れるため、除外しないと二重割当の部屋が作れてしまう）。
   */
  _roomExcludedStairKeys() {
    const stairKeys = new Set();
    for (const s of this.graph.stairs) {
      const cells = refreshCells(s.cells, this.graph);
      const beyond = this._beyondBreakOf(s);
      for (const key of cells) {
        if (beyond.has(key)) {
          const cb = cellBoundsFromKey(key, this.graph);
          if (cb) {
            const cx = (cb.x1 + cb.x2) / 2, cy = (cb.y1 + cb.y2) / 2;
            if (!this._lowerStairForPoint(cx, cy)) continue; // 下階階段も無い→階段下エリアとして部屋ドラッグ許容
          }
        }
        stairKeys.add(key);
      }
    }
    for (const room of this.graph.rooms) {
      if (room.feature !== RoomFeature.STAIR_VOID) continue;
      for (const key of refreshCells(room.cells, this.graph)) stairKeys.add(key);
    }
    return stairKeys;
  }

  /** 階段（自階／下階見下げ）を選択し、部屋選択・命名・部屋ドラッグ状態をクリアする。 */
  _selectStair(id) {
    this.selectStair(id);
    this.namingRoomId = null;
    this.dragState    = null;
  }

  /** 永続化データ（per-floor 設定・Room.customOverrides）が参照する材コード集合を集める。 */
  _collectReferencedCodes() {
    const codes = new Set();
    const g = this.graph;

    for (const f of MATERIAL_CODE_GRAPH_FIELDS) {
      const v = g?.[f];
      if (typeof v === 'string' && v) codes.add(v);
    }

    for (const room of g?.rooms ?? []) {
      const ov = room.customOverrides;
      if (!ov) continue;
      for (const f of MATERIAL_CODE_OVERRIDE_FIELDS) {
        const v = ov instanceof Map ? ov.get(f) : ov[f];
        if (typeof v === 'string' && v) codes.add(v);
      }
    }

    // 境界エッジの個別上書き — 12桁材コードらしき値をすべて照合対象に含める
    for (const e of g?.edges ?? []) {
      const ov = e.overrides;
      if (!ov) continue;
      const vals = ov instanceof Map ? ov.values() : Object.values(ov);
      for (const v of vals) {
        if (typeof v === 'string' && /^\d{12}$/.test(v)) codes.add(v);
      }
    }
    return codes;
  }

  /** 材コードから材を取得（未ロード・未登録なら null）。 */
  getMaterial(code) { return this.materialMap?.get(code) ?? null; }

  /** カテゴリ（'backing' / 'panel' / 'finish'）で材選択肢をフィルタ。 */
  getMaterialsByCategory(category) {
    return (this.materials ?? []).filter(m => m.category === category);
  }

  /** 内装マスターを key から取得（未ロード・未登録なら null）。 */
  getInteriorMaster(key) { return this.interiorMasters?.[key] ?? null; }

  /** 部屋外周壁の寸法 {wallBase, wallFinish}（実材厚から導出）。未解決なら null。 */
  roomWallDims(graph, room) {
    return this._composition?.roomWallDims(graph, room, this.materialMap) ?? null;
  }

  /** 外壁ループの寸法 {wallBase, wallFinish}。未解決なら null。 */
  exteriorWallDims(graph) {
    return this._composition?.exteriorWallDims(graph, this.materialMap) ?? null;
  }

  /**
   * 階段下部屋（破れ線先セルに部屋指定された領域）を検出する（仕上げモード脱出時の
   * 階段下壁生成 stairUnderWalls.js の入力）。中間階（beyondセルの直下に下階階段がある＝
   * 見下げ吹抜け）の階段は対象外（部屋ドラッグでは既に除外されているため通常は該当なしだが、
   * データ不整合への安全側ガードとして保持する）。
   * @returns {Array<{ stair, room, riser, beyondCells:Set<string>, splitCLIds:Set<string> }>}
   */
  stairUnderRooms(graph) {
    const result = [];
    for (const stair of graph.stairs) {
      const riser  = this._selfStairRiser(stair);
      const beyond = cellsBeyondBreak(stair, graph, riser);
      if (beyond.size === 0) continue;

      // beyondセルのいずれかが下階階段の見下げに当たる中間階の階段は対象外
      // （階段下エリアではなく下階階段の吹抜けのため）。
      let hasLowerStair = false;
      for (const key of beyond) {
        const cb = cellBoundsFromKey(key, graph);
        if (!cb) continue;
        const cx = (cb.x1 + cb.x2) / 2, cy = (cb.y1 + cb.y2) / 2;
        if (this._lowerStairForPoint(cx, cy)) { hasLowerStair = true; break; }
      }
      if (hasLowerStair) continue;

      const splitCLIds = new Set(findUnderStairSplitCLs(stair, graph).map(cl => cl.id));

      for (const room of stairUnderRoomsOf(stair, graph, beyond)) {
        result.push({ stair, room, riser, beyondCells: beyond, splitCLIds });
      }
    }
    return result;
  }

  // 選択は連結領域単位。短縮CLでL字化した領域は、内部のどこを指しても
  // 構成セル全部をまとめて拾う（先頭はポインタ直下のセル）
  //
  // 階段クリックの優先順位（ポインタ直下 wx,wy で判定）:
  //   1. 自階階段のセルかつ破れ線手前          → その自階階段を選択（roomIdのRoomがあればダイアログも開く＝既存扱い）
  //   2. 自階階段のセルで破れ線先＋下階階段あり → 下階階段を選択（見下げクリック。ダイアログなし）
  //   3. 自階に階段が無い＋下階階段あり         → 下階階段を選択（見下げクリック。ダイアログなし）
  //   4. 自階階段のセルで破れ線先＋下階階段なし → 階段下エリアとして部屋ドラッグを許可
  startDrag(wx, wy) {
    // 開いているダイアログがあればまず閉じる（キャンバスクリックで閉じる）。
    // namingIsNew（新規部屋）なら現行どおり削除、既存部屋なら選択維持のまま閉じるだけ（cancelNaming参照）。
    if (this.namingRoomId) this.cancelNaming(this.namingRoomId);

    const region = regionCellsAt(wx, wy, this.graph);
    if (region.length === 0) return;

    // 階段のセルを直接指した場合は部屋ドラッグを開始せず、その階段自体を選択する。
    // 判定はポインタ直下のセル（region[0]）のみで行う。連結領域全体との交差で
    // 判定すると、領域が階段の実占有より広い場合（L字の空象限が連結している等）に
    // 階段でないマスのクリックでも階段が選択されてしまう（＝矩形的な過剰選択）。
    const pointerKey = region[0].key;
    let stair = null;
    for (const s of this.graph.stairs) {
      const cells = refreshCells(s.cells, this.graph);
      if (cells.has(pointerKey)) { stair = s; break; }
    }

    if (stair) {
      const beyond = this._beyondBreakOf(stair);
      if (!beyond.has(pointerKey)) {
        // 優先1: 自階階段（破れ線手前）— stair.roomId の Room があれば既存扱いでダイアログも開く
        // （上り口ヒントは不要 — 選択順セルキーが無い経路のため namingCellOrder は明示的にクリアする）
        this._selectStair(stair.id);
        if (stair.roomId && this.graph.roomMap.has(stair.roomId)) {
          this.namingIsNew     = false;
          this.namingRoomId    = stair.roomId;
          this.namingCellOrder = null;
        }
        return;
      }
      const lower = this._lowerStairForPoint(wx, wy);
      if (lower) {
        this._selectStair(lower.id); // 優先2: 破れ線先＝下階階段の見下げ
        return;
      }
      // 優先4: 破れ線先だが下階階段なし → 階段下エリアとして下の部屋ドラッグへフォールスルー
    } else {
      const lower = this._lowerStairForPoint(wx, wy);
      if (lower) {
        this._selectStair(lower.id); // 優先3: 自階に階段が無い箇所での下階階段の見下げ
        return;
      }
    }

    // 階段マスは部屋ドラッグに含めない（階段は Room とは別エンティティのため、
    // 部屋の重なり判定に乗らず、含めると階段に重なった部屋が誤って作られてしまう）。
    // ただし破れ線先セルで直下階に階段が無いもの（階段下エリア）は部屋ドラッグを許容する。
    const stairKeys = this._roomExcludedStairKeys();
    const cells = region.filter(c => !stairKeys.has(c.key));
    if (cells.length === 0) return;

    this.selectedStairId = null;
    this.dragState = {
      currentCell: cells[0],
      visitedCells: new Map(cells.map(c => [c.key, c])),
      stairKeys,
      startCellKey: cells[0].key, // ドラッグ開始セル（階段セル除外後）。commitDragの所属判定に使う
    };
  }

  updateDrag(wx, wy) {
    const state = this.dragState;
    if (!state) return;
    const region = regionCellsAt(wx, wy, this.graph)
      .filter(c => !state.stairKeys.has(c.key));
    if (region.length === 0) return;
    if (region.every(c => state.visitedCells.has(c.key))) {
      this.dragState = { ...state, currentCell: region[0] };
    } else {
      const visited = new Map(state.visitedCells);
      for (const c of region) visited.set(c.key, c);
      this.dragState = { ...state, currentCell: region[0], visitedCells: visited };
    }
  }

  /**
   * 選択状態表（判定はドラッグ開始セル startCellKey で行う）:
   *   完全一致                 → 全体選択・既存ダイアログ                              [判定1]
   *   複数部屋を完全包含        → 統合（dominantに吸収）・既存ダイアログ                [判定2]
   *   開始セルが部分指定        → その部分指定を全体選択・既存ダイアログ                [判定3-部分指定]
   *   開始セルが親/単一の名前セル → その部屋を全体選択・既存ダイアログ                   [判定3-名前セル]
   *   開始セルが親/単一のその他セル → 新規部分指定（cells=newCells∩その部屋）・新規ダイアログ [判定3-その他セル]
   *   開始セルが未指定           → 新規部屋（newCellsから全部屋所属セルを除外）・新規ダイアログ [判定3-未指定]
   * 階段エリアのセル（開始セルが自階階段）は startDrag 側で既にダイアログまで処理済みで
   * commitDrag には到達しない。feature=STAIR の部屋は cells ドリフトに備えて防御的に除外する。
   */
  commitDrag() {
    const state = this.dragState;
    if (!state) return;
    const newCells = new Set(state.visitedCells.keys());
    if (newCells.size === 0) { this.dragState = null; return; }
    const startCellKey = state.startCellKey;
    // ダイアログを開く際に渡す選択順セルキー配列（挿入順。フェーズ4の上り口ヒント用）
    const cellOrder = [...state.visitedCells.keys()];

    // undo 用: 変更前スナップショット。統合（判定2）は即時 push、
    // 新規作成（判定3）はダイアログ確定（applyNaming）まで push を保留する。
    const undoBefore = snapshotFinishState(this.graph);

    // 部屋の保存済みセルは指定時点のグリッド分割を凍結したキーであり、その後
    // floorplanモードで領域内部に区切りCLが追加されると現在のキーと一致しなく
    // なる。refreshCells で現在のグリッド分割に展開してから比較する。
    const cellsCache = new Map();
    const cellsOf = (r) => {
      if (!cellsCache.has(r.id)) cellsCache.set(r.id, refreshCells(r.cells, this.graph));
      return cellsCache.get(r.id);
    };

    const rooms = this.graph.rooms.filter(r =>
      r.feature !== RoomFeature.STAIR && r.feature !== RoomFeature.STAIR_VOID
      && r.feature !== RoomFeature.UNDEFINED);
    const overlapping = rooms.filter(r => [...cellsOf(r)].some(c => newCells.has(c)));

    if (overlapping.length > 0) {
      // 判定1: 既存部屋と完全一致 — 全体選択・既存ダイアログ（セルは変えない）
      const exactMatch = overlapping.find(r => setsEqual(cellsOf(r), newCells));
      if (exactMatch) { this._openDialog(exactMatch.id, false, cellOrder); return; }

      // 判定2: 重複する全部屋が newCells に包含される — 拡張・統合
      // （例: A部屋とB部屋を合わせてドラッグ → 一つの大きな部屋に）
      const allContained = overlapping.every(r => [...cellsOf(r)].every(c => newCells.has(c)));
      if (allContained) {
        const dominant = overlapping.reduce((a, b) =>
          cellsOf(b).size > cellsOf(a).size ? b : a
        );
        // 吸収される部屋の部分指定（子）は dominant へ referenceRoomIds を付け替える（孤児参照を作らない）。
        // child === dominant を除外し、自己参照（dominant.referenceRoomIds.add(dominant.id)）を防ぐ
        // （自己参照が生じると deleteRoom の子カスケードが無限再帰しうる）。
        for (const r of overlapping) {
          if (r.id === dominant.id) continue;
          for (const child of rooms) {
            if (child.id === dominant.id) continue;
            if (child.referenceRoomIds.has(r.id)) {
              child.referenceRoomIds.delete(r.id);
              child.referenceRoomIds.add(dominant.id);
            }
          }
        }
        dominant.setCells(newCells);
        dominant.generatedWallIds.clear();
        for (const r of overlapping) {
          if (r.id !== dominant.id) this.graph.removeRoom(r.id);
        }
        // 統合はダイアログをキャンセルしても確定したまま残るため、ここで即時 push する
        pushFinishUndo(this.graph, undoBefore);
        this._openDialog(dominant.id, false, cellOrder);
        return;
      }
    }

    // 判定3: 上記のいずれにも当てはまらない — 開始セルの所属で分岐
    // 部分指定（referenceRoomIds 非空）が優先。複数該当なら roomOrder 先勝ち。
    const partialOwners = rooms.filter(r => r.referenceRoomIds.size > 0 && cellsOf(r).has(startCellKey));
    if (partialOwners.length > 0) {
      this._openDialog(this._firstInRoomOrder(partialOwners).id, false, cellOrder);
      return;
    }

    // 親/単一部屋（referenceRoomIds 空）
    const owner = rooms.find(r => r.referenceRoomIds.size === 0 && cellsOf(r).has(startCellKey));
    if (owner) {
      if (this._nameCellKeyOf(owner) === startCellKey) {
        // 名前セル — その部屋を全体選択・既存ダイアログ
        this._openDialog(owner.id, false, cellOrder);
        return;
      }
      // その他セル — 新規部分指定（cells = newCells ∩ その部屋の現在セル）
      const cells = new Set([...newCells].filter(c => cellsOf(owner).has(c)));
      const room = this.graph.addRoom(cells, '', crypto.randomUUID(), new Set([owner.id]));
      this._pendingDialogUndo = undoBefore;
      this._openDialog(room.id, true, cellOrder);
      return;
    }

    // 未指定 — 新規部屋（newCells から全部屋所属セルを除外。除外で空になったら何もしない）
    const claimed = new Set();
    for (const r of rooms) for (const c of cellsOf(r)) claimed.add(c);
    const freeCells = new Set([...newCells].filter(c => !claimed.has(c)));
    this.dragState = null;
    if (freeCells.size === 0) return;
    const room = this.graph.addRoom(freeCells);
    this._pendingDialogUndo = undoBefore;
    this._openDialog(room.id, true, cellOrder);
  }

  /** referenceRoomIds 非空の候補が複数ある場合、graph.roomOrder で最も先の部屋を返す。 */
  _firstInRoomOrder(list) {
    const order = this.graph.roomOrder;
    return list.reduce((a, b) => order.indexOf(a.id) <= order.indexOf(b.id) ? a : b);
  }

  /**
   * room の「名前セル」（名前の表示アンカーを worldToCell したセルキー）。無名部屋は null（＝名前セルなし扱い）。
   * アンカー算出は FinishModeLayer.jsx の部屋名描画ロジックと同一
   * （room.namePosition があればその座標、なければ room.cells 中の最大面積セル中心）。
   */
  _nameCellKeyOf(room) {
    if (!room.name) return null;
    let cx, cy;
    if (room.namePosition) {
      cx = room.namePosition.x;
      cy = room.namePosition.y;
    } else {
      let largest = null, maxArea = 0;
      for (const key of room.cells) {
        const b = cellBoundsFromKey(key, this.graph);
        if (!b) continue;
        const area = (b.x2 - b.x1) * (b.y2 - b.y1);
        if (area > maxArea) { maxArea = area; largest = b; }
      }
      if (!largest) return null;
      cx = (largest.x1 + largest.x2) / 2;
      cy = (largest.y1 + largest.y2) / 2;
    }
    const cell = worldToCell(cx, cy, this.graph);
    return cell ? cell.key : null;
  }

  /**
   * ドラッグ確定後、部屋名ダイアログを開く（既存部屋 or 新規部屋）共通処理。
   * cellOrder（選択順セルキー配列）は階段変換時の上り口ヒントとして applyNaming が使う。
   */
  _openDialog(roomId, isNew, cellOrder = null) {
    this.dragState       = null;
    this.namingIsNew     = isNew;
    this.namingRoomId    = roomId;
    this.namingCellOrder = cellOrder;
    this.selectedRoomId  = roomId;
  }

  cancelDrag() { this.dragState = null; }

  selectRoom(roomId) {
    this.selectedRoomId = roomId;
    this.selectedStairId = null;
  }

  /**
   * ダイアログ確定時に kind/feature/name をまとめて適用する（旧 finishNaming を置き換え）。
   * feature の遷移により Stair の生成・削除・名前変更を行う:
   *   非STAIR → 'stair': 新規変換（Stair生成。名前は空許容）
   *   STAIR   → 'stair': 名前変更のみ（既存Stairは再変換しない）
   *   STAIR   → null/'void': 連動Stairを削除してfeatureを設定
   *   それ以外: setFeatureのみ（kindの排他・void切替）
   * 名前は feature==='stair' 以外は現行どおり既定「部屋」を適用する（stairは空許容）。
   * @returns {Stair|null} 新規に階段変換した場合はその Stair（呼び出し側の stairFloorSync 判定用）、それ以外は null。
   */
  applyNaming(roomId, { name, kind, feature }, floorHeight = null) {
    // 新規部屋なら作成前（commitDrag 冒頭）のスナップショットを使い、
    // 「作成＋命名」を1つの undo エントリにまとめる。既存部屋なら現時点から。
    const undoBefore = this._pendingDialogUndo ?? snapshotFinishState(this.graph);
    this._pendingDialogUndo = null;

    const room = this.graph.roomMap.get(roomId);
    if (!room) return null;

    room.setKind(kind);

    const wasStair = room.feature === RoomFeature.STAIR;
    const toStair  = feature === RoomFeature.STAIR;
    let convertedStair = null;

    if (toStair) {
      room.setName(name); // 階段は空許容（既定「部屋」を適用しない）
      if (name) this.sessionModifiedRoomIds.add(roomId);
      if (!wasStair) {
        room.setFeature(RoomFeature.STAIR);
        const cells = new Set(room.cells);
        // namingCellOrder（commitDragで開いたダイアログの選択順セルキー）を上り口ヒントとして渡す。
        // startDrag優先1経由（namingCellOrder無し）では null のまま渡り、現行の幾何推定にフォールバックする。
        const cls = classifyStairArea(cells, this.graph, floorHeight, this.namingCellOrder);
        const opts = {
          type: cls.type, cells, upDirection: cls.upDirection,
          flip: cls.flip ?? false, sections: cls.sections ?? null,
          roomId: room.id,
        };
        if (cls.totalSteps) opts.totalSteps = cls.totalSteps;
        convertedStair = this.graph.addStair(opts);
        // 直進階段は破れ線位置（FL+1600）の分割CLで階段下の指定経路を用意する（stairUnderSplit.js）
        ensureUnderStairSplit(convertedStair, this.graph, this._selfStairRiser(convertedStair));
        this.selectedStairId = convertedStair.id;
      } else {
        // 既にSTAIR — 再変換せず、既存Stairの選択だけ更新する
        const stair = [...this.graph.stairMap.values()].find(s => s.roomId === roomId);
        this.selectedStairId = stair ? stair.id : null;
      }
      // 屋外階段 → 外部タブに部位「階段」の行を自動追加（新規変換・既存階段の再確定＝kind切替の両方が通る）。
      // 屋内階段（屋外→屋内へ切替された場合含む）→ 連動行を削除。
      if (room.kind === RoomKind.EXTERIOR) {
        if (!this.graph.exteriorRows.some(r => r.roomId === room.id)) {
          this.graph.addExteriorRow('exteriorRows', '階段', room.id);
        }
      } else {
        this.graph.removeExteriorRowsByRoomId(room.id);
      }
      this.selectedRoomId = room.id;
    } else {
      if (wasStair) this._removeLinkedStair(roomId); // STAIR → null/void: 連動Stairを削除
      room.setFeature(feature ?? null);
      room.setName(name || '部屋');
      this.sessionModifiedRoomIds.add(roomId);
      this.selectedRoomId  = roomId;
      this.selectedStairId = null;
    }

    this.namingRoomId    = null;
    this.namingIsNew     = false;
    this.namingCellOrder = null;
    // 確定時にのみ未定義Roomから該当セルを引き抜く（cancelNaming 時は未定義側を変更しないため安全）。
    this._subtractCellsFromUndefined(room.cells);
    // 境界エッジの生成はモード境界の差分追跡で行う（フェーズ4）。命名時の即時生成は廃止。
    this.lastNamingUndoEntry = pushFinishUndo(this.graph, undoBefore);
    return convertedStair;
  }

  /** roomId を roomId に持つ Stair があれば道連れで削除する（Room削除経路の共通ガード）。 */
  _removeLinkedStair(roomId) {
    const stair = [...this.graph.stairMap.values()].find(s => s.roomId === roomId);
    if (!stair) return;
    removeUnderStairSplit(stair, this.graph); // 階段下の分割CLを指定ごと元に戻す
    this.graph.removeStair(stair.id);
    this.graph.removeExteriorRowsByRoomId(roomId); // 連動する外部仕上げ行（部位「階段」）も削除
    if (this.selectedStairId === stair.id) this.selectedStairId = null;
  }

  /**
   * Room を「未定義」へ変換する（削除しても外壁線を維持するための残置）。
   * kind と cells は保持し、名前・feature・仕上げ関連のみ初期化する。
   * 未定義Room は仕上げ表から除外・無描画だがセル選択は可能（ドラッグで親指定Roomとして切り出せる）。
   */
  _makeUndefined(room) {
    room.setName('');
    room.setFeature(RoomFeature.UNDEFINED);
    room.setTemplateKey(null);
    room.customOverrides.clear();
    for (const f of FINISH_FIELDS) room.finish.setField(f, '');
    room.setFloorLevel(null);
    room.namePosition = null;
    room.generatedWallIds.clear();
  }

  /**
   * cells を未定義Room群から取り除く（命名確定・新規候補室の削除取消で呼ぶ）。
   * refreshCells で現行キーへ正規化した集合から差し引き、空になった未定義Roomは削除する。
   */
  _subtractCellsFromUndefined(cells) {
    for (const u of this.graph.rooms) {
      if (u.feature !== RoomFeature.UNDEFINED) continue;
      const current = refreshCells(u.cells, this.graph);
      const remaining = new Set([...current].filter(c => !cells.has(c)));
      if (remaining.size === 0) this.graph.removeRoom(u.id);
      else u.setCells(remaining);
    }
  }

  /**
   * ダイアログの「キャンセル」。namingIsNew（新規部屋）のときだけ現行どおり部屋を削除する
   * （sessionModifiedRoomIds には記録しない）。既存部屋のときは何も変更せず閉じるだけ（選択は維持）。
   */
  cancelNaming(roomId) {
    // 新規部屋の作成＋キャンセルは差分ゼロなので undo エントリを積まず、保留分を破棄する
    this._pendingDialogUndo = null;
    if (this.namingIsNew) {
      this._removeLinkedStair(roomId);
      this.graph.removeRoom(roomId);
      this.selectedRoomId = null;
    }
    this.namingRoomId    = null;
    this.namingIsNew     = false;
    this.namingCellOrder = null;
  }

  /**
   * ユーザーが明示的に部屋を削除する（仕上げ表の削除ボタン・ダイアログの削除ボタン共通）。
   * 子（自idを referenceRoomIds に含む部分指定）があれば先に道連れで削除する（親カスケード）。
   * その部屋を roomId に持つ Stair があれば道連れで削除する。壁・境界エッジの後始末はモード切替時の既存ロジックに委ねる。
   */
  deleteRoom(roomId) {
    withFinishUndo(this.graph, () => this._deleteRoomNoUndo(roomId));
  }

  /**
   * deleteRoom の実体（undo 記録なし。カスケード再帰・deleteFromDialog から使う）。
   * 部分指定（referenceRoomIds非空）の子・屋外部屋は現行どおり removeRoom。
   * 屋内の親/単一部屋は removeRoom せず _makeUndefined へ変換し、外壁線を維持する
   * （B: 未定義の部屋。子を持つ親は先に子を再帰 removeRoom してから未定義化する）。
   */
  _deleteRoomNoUndo(roomId) {
    const room = this.graph.roomMap.get(roomId);
    if (!room) return;
    const children = this.graph.rooms.filter(r => r.referenceRoomIds.has(roomId));
    for (const child of children) this._deleteRoomNoUndo(child.id); // 再帰（各自の連動Stairガード込み）

    this._removeLinkedStair(roomId);
    if (room.referenceRoomIds.size > 0 || room.kind === RoomKind.EXTERIOR) {
      this.graph.removeRoom(roomId);
    } else {
      this._makeUndefined(room);
    }
    if (this.selectedRoomId === roomId) this.selectedRoomId = null;
    if (this.namingRoomId === roomId) this.namingRoomId = null;
  }

  /**
   * ダイアログの「削除」ボタン用。判定順が重要（先頭を後回しにすると新規候補室が誤って未定義化される）。
   *   新規候補室（namingIsNew）  → 作成取消。removeRoom し、切り出し元の未定義Roomへ cells を差し戻す
   *   feature=STAIR の部屋      → 連動Stairごと削除（deleteStair。選択クリア）
   *   部分指定（referenceRoomIds非空） → 削除後、参照元（親）を全体選択
   *   親（子持ち）・単一部屋      → deleteRoom（親カスケードで子も一括削除。屋内なら未定義化）
   */
  deleteFromDialog(roomId) {
    // 新規部屋（作成→即削除）は保留スナップショットを使う＝差分ゼロでエントリなし
    const undoBefore = this._pendingDialogUndo ?? snapshotFinishState(this.graph);
    this._pendingDialogUndo = null;

    const room = this.graph.roomMap.get(roomId);
    if (!room) {
      this.namingRoomId    = null;
      this.namingIsNew     = false;
      this.namingCellOrder = null;
      return;
    }

    if (this.namingIsNew) {
      const cells = new Set(room.cells);
      this.graph.removeRoom(roomId);
      this._subtractCellsFromUndefined(cells);
      if (this.selectedRoomId === roomId) this.selectedRoomId = null;
    } else if (room.feature === RoomFeature.STAIR) {
      const stair = [...this.graph.stairMap.values()].find(s => s.roomId === roomId);
      if (stair) this._deleteStairNoUndo(stair.id);
      else this._deleteRoomNoUndo(roomId); // 連動Stairが見つからない防御ケース
    } else if (room.referenceRoomIds.size > 0) {
      const parentId = [...room.referenceRoomIds][0];
      this._deleteRoomNoUndo(roomId);
      if (this.graph.roomMap.has(parentId)) this.selectedRoomId = parentId;
    } else {
      this._deleteRoomNoUndo(roomId);
    }

    this.namingRoomId    = null;
    this.namingIsNew     = false;
    this.namingCellOrder = null;
    pushFinishUndo(this.graph, undoBefore);
  }

  // ---- 階段 ----

  selectStair(id) {
    this.selectedStairId = id;
    // 自階階段なら背後で仕上げ表の部屋カードも選択状態にする。下階階段（見下げ）は
    // roomId が自階 roomMap に無いため（別階のRoom参照）、自然に null になる。
    const roomId = this.graph.stairMap.get(id)?.roomId ?? null;
    this.selectedRoomId = roomId && this.graph.roomMap.has(roomId) ? roomId : null;
  }

  /** stair.roomId の Room が存在すればそれも削除する（階段タブの削除ボタン経由でも Room が残らないように）。 */
  deleteStair(id) {
    withFinishUndo(this.graph, () => this._deleteStairNoUndo(id));
  }

  /**
   * deleteStair の実体（undo 記録なし。deleteFromDialog から使う）。
   * ペアRoom（stair.roomId の Room）は屋外なら removeRoom、屋内なら _makeUndefined で外壁線を維持する。
   */
  _deleteStairNoUndo(id) {
    const stair = this.graph.stairMap.get(id);
    if (stair) removeUnderStairSplit(stair, this.graph); // 階段下の分割CLを指定ごと元に戻す
    if (stair?.roomId && this.graph.roomMap.has(stair.roomId)) {
      const room = this.graph.roomMap.get(stair.roomId);
      if (room.kind === RoomKind.EXTERIOR) {
        this.graph.removeRoom(stair.roomId);
      } else {
        this._makeUndefined(room);
      }
      if (this.selectedRoomId === stair.roomId) this.selectedRoomId = null;
      if (this.namingRoomId === stair.roomId) this.namingRoomId = null;
    }
    if (stair?.roomId) this.graph.removeExteriorRowsByRoomId(stair.roomId); // 連動する外部仕上げ行も削除
    this.graph.removeStair(id);
    if (this.selectedStairId === id) this.selectedStairId = null;
  }

  /**
   * 階段OFF復帰: stair.roomId の Room を feature=null に戻し、Stair を削除して選択を Room へ戻す。
   * Room が存在しない旧データ Stair（上階自動設置分・移行前データ）は何もしない。
   * （現状 applyNaming の STAIR→null/void 遷移が同等の処理を担うため未配線。フェーズ4以降のUI導線候補として保持）
   */
  revertStairToRoom(stairId) {
    const stair = this.graph.stairMap.get(stairId);
    if (!stair) return;
    const room = stair.roomId ? this.graph.roomMap.get(stair.roomId) : null;
    if (!room) return;
    withFinishUndo(this.graph, () => {
      room.setFeature(null);
      removeUnderStairSplit(stair, this.graph); // 階段下の分割CLを指定ごと元に戻す
      this.graph.removeStair(stairId);
      this.graph.removeExteriorRowsByRoomId(room.id); // 連動する外部仕上げ行も削除
    });
    this.selectedStairId = null;
    this.selectedRoomId  = room.id;
  }

  get isDragging()   { return this.dragState !== null; }
  get previewCells() { return this.dragState ? [...this.dragState.visitedCells.values()] : []; }

  // ---- Lifecycle ----

  dispose() {
    this.cancelDrag();
    this._pendingDialogUndo = null;
    // 材データを破棄（仕上げモード離脱時）
    this.materials       = null;
    this.materialMap     = null;
    this.interiorMasters = null;
    this._composition    = null;
    this.materialsLoaded = false;
    this.materialError   = null;
    this.lowerStairs     = [];
    this.upperVoids      = [];
    this.upperFloorHeight = null;
    this._disposed       = true;
  }
}
