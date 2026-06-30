import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { worldToCell, refreshCells } from '../finish/gridCells.js';
import { classifyStairArea } from '../finish/stair/stairClassify.js';
import { ERR_MATERIAL_MISMATCH } from '../error.js';

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// グラフ上で「材コード」を保持するフィールド（照合対象）。
// 永続化されるのは選択された材のみ（材マスタ全体は保存しない）ため、
// これらのフィールドが参照する材コードのみを照合する。
const MATERIAL_CODE_GRAPH_FIELDS    = [
  'interiorWallPanel', 'exteriorWallBacking',
  'interiorWallBacking', 'ceilingBacking', 'floorBacking',
]; // per-floor 設定
const MATERIAL_CODE_OVERRIDE_FIELDS = ['wallMaterial', 'wallFinish'];               // Room.customOverrides

export class FinishModeState {
  dragState      = null; // { currentCell, visitedCells: Map } | null
  selectedRoomId = null;
  namingRoomId   = null;
  selectedStairId = null;

  // ---- 材データ（突入時ロード・離脱時破棄） ----
  materialsLoaded = false;       // ロード完了フラグ
  materialError   = null;        // 照合エラーメッセージ | null
  materials       = null;        // 材マスタ配列（読み取り専用）
  materialMap     = null;        // Map<code, material>
  interiorMasters = null;        // 内装マスター（key → 定義）

  constructor(graph) {
    this.graph = graph;
    // 仕上げモード突入後に finishNaming() で確定した Room ID を記録する。
    // FinishModeState はモード切替のたびに new で生成されるため、
    // フロアプランモードに戻ると自動的にリセットされる。
    this.sessionModifiedRoomIds = new Set();
    makeObservable(this, {
      dragState:      observable.ref,
      selectedRoomId: observable,
      namingRoomId:   observable,
      selectedStairId: observable,
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
      finishNaming: action,
      cancelNaming: action,
      deleteRoom:   action,
      selectStair:  action,
      deleteStair:  action,
      convertRoomToStair: action,
    });
  }

  // ---- 材データのロード・照合（突入時に App.jsx から1度だけ await される） ----

  /**
   * 材データ・内装マスターを動的 import でロードし、永続化データと照合する。
   * 不一致があれば this.materialError に ERR_MATERIAL_MISMATCH を設定する（throw はしない）。
   * @returns {Promise<{ ok: boolean, error: string|null }>}
   */
  async init() {
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

    return { ok: error === null, error };
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

  /** エッジの詳細断面バンド（LOD詳細描画用）。未解決なら null。 */
  resolveEdgeSection(edge, graph, cellToRoom) {
    return this._composition?.resolveEdgeSection(edge, graph, this.materialMap, cellToRoom) ?? null;
  }

  startDrag(wx, wy) {
    const cell = worldToCell(wx, wy, this.graph);
    if (!cell) return;
    this.dragState = { currentCell: cell, visitedCells: new Map([[cell.key, cell]]) };
  }

  updateDrag(wx, wy) {
    const state = this.dragState;
    if (!state) return;
    const cell = worldToCell(wx, wy, this.graph);
    if (!cell) return;
    if (state.visitedCells.has(cell.key)) {
      this.dragState = { ...state, currentCell: cell };
    } else {
      const visited = new Map(state.visitedCells);
      visited.set(cell.key, cell);
      this.dragState = { ...state, currentCell: cell, visitedCells: visited };
    }
  }

  commitDrag() {
    const state = this.dragState;
    if (!state) return;
    const newCells = new Set(state.visitedCells.keys());
    if (newCells.size === 0) { this.dragState = null; return; }

    // 部屋の保存済みセルは指定時点のグリッド分割を凍結したキーであり、その後
    // floorplanモードで領域内部に区切りCLが追加されると現在のキーと一致しなく
    // なる。refreshCells で現在のグリッド分割に展開してから比較する。
    const cellsCache = new Map();
    const cellsOf = (r) => {
      if (!cellsCache.has(r.id)) cellsCache.set(r.id, refreshCells(r.cells, this.graph));
      return cellsCache.get(r.id);
    };

    const overlapping = this.graph.rooms.filter(r =>
      [...cellsOf(r)].some(c => newCells.has(c))
    );

    // 判定0: 重複なし — 新規部屋として登録
    if (overlapping.length === 0) {
      const room = this.graph.addRoom(newCells);
      this.dragState      = null;
      this.namingRoomId   = room.id;
      this.selectedRoomId = room.id;
      return;
    }

    // 判定1: 既存部屋と完全一致 — リネームのみ（セルは変えない）
    const exactMatch = overlapping.find(r => setsEqual(cellsOf(r), newCells));
    if (exactMatch) {
      this.dragState      = null;
      this.namingRoomId   = exactMatch.id;
      this.selectedRoomId = exactMatch.id;
      return;
    }

    // 判定2: 重複する全部屋が newCells に包含される — 拡張・統合
    // （例: A部屋とB部屋を合わせてドラッグ → 一つの大きな部屋に）
    const allContained = overlapping.every(r =>
      [...cellsOf(r)].every(c => newCells.has(c))
    );
    if (allContained) {
      const dominant = overlapping.reduce((a, b) =>
        cellsOf(b).size > cellsOf(a).size ? b : a
      );
      dominant.setCells(newCells);
      dominant.generatedWallIds.clear();
      for (const r of overlapping) {
        if (r.id !== dominant.id) this.graph.removeRoom(r.id);
      }
      this.dragState      = null;
      this.namingRoomId   = dominant.id;
      this.selectedRoomId = dominant.id;
      return;
    }

    // 判定S: 「参照元 R + その部分指定」構造で newCells が収まるか確認
    //
    // 条件:
    //   1. overlapping 内に「参照元（referenceRoomIds 空）かつ newCells ⊆ R.cells」な部屋 R がある
    //   2. overlapping の残りは全て R の部分指定（R を参照している子部屋）
    const mainRoom = overlapping.find(r =>
      r.referenceRoomIds.size === 0 &&
      [...newCells].every(c => cellsOf(r).has(c))
    );

    if (mainRoom) {
      const R = mainRoom;
      const otherOverlapping = overlapping.filter(r => r.id !== R.id);
      const allChildrenOfR = otherOverlapping.every(r => r.referenceRoomIds.has(R.id));

      if (allChildrenOfR) {
        const partialSpecs = this.graph.rooms.filter(p => p.referenceRoomIds.has(R.id));
        const coveredByPartial = partialSpecs.some(p =>
          [...newCells].some(c => cellsOf(p).has(c))
        );

        if (coveredByPartial) {
          // ケース2': 部分指定のセル域が選択された → 部分指定をリネーム
          const targetPartial = partialSpecs.find(p =>
            [...newCells].every(c => cellsOf(p).has(c))
          );
          if (targetPartial) {
            this.dragState      = null;
            this.namingRoomId   = targetPartial.id;
            this.selectedRoomId = targetPartial.id;
            return;
          }
          // targetPartial 未特定（複数の部分指定を跨ぐ選択）→ 判定3へ
        } else {
          // 参照元のセル域が選択された
          const partialModifiedFirst = partialSpecs.some(p =>
            this.sessionModifiedRoomIds.has(p.id)
          );
          if (partialModifiedFirst) {
            // ケース2': 部分指定が先に命名済み → 参照元 R をリネーム
            this.dragState      = null;
            this.namingRoomId   = R.id;
            this.selectedRoomId = R.id;
          } else if (partialSpecs.length === 0 && this.sessionModifiedRoomIds.has(R.id)) {
            // 部分指定なし かつ 親が今セッションで命名済み → 新規部分指定として登録
            // （ケース2'のセットアップ: 同セッション内で A+B→"部屋1" の直後に B をドラッグ）
            const room = this.graph.addRoom(newCells, '', crypto.randomUUID(), new Set([R.id]));
            this.dragState      = null;
            this.namingRoomId   = room.id;
            this.selectedRoomId = room.id;
          } else {
            // ケース1/2: 分割
            this._splitRoom(R, newCells, partialSpecs, cellsOf);
          }
          return;
        }
      }
    }

    // 判定3: 上記のいずれにも当てはまらない部分重複 — 部分指定として登録
    // （複数部屋にまたがるドラッグなど）
    const refIds = new Set(overlapping.map(r => r.id));
    const room = this.graph.addRoom(newCells, '', crypto.randomUUID(), refIds);
    this.dragState      = null;
    this.namingRoomId   = room.id;
    this.selectedRoomId = room.id;
  }

  _splitRoom(R, newCells, partialSpecs, cellsOf) {
    const isCase1 = partialSpecs.length === 0;
    if (isCase1) {
      // ケース1: 単純分割 — R の残りセルをそのまま維持し、選択セルで新部屋を作る
      const remaining = new Set([...cellsOf(R)].filter(c => !newCells.has(c)));
      R.setCells(remaining);
      R.generatedWallIds.clear();
    } else {
      // ケース2: 部分指定を独立させ、R を解体
      for (const p of partialSpecs) {
        p.referenceRoomIds.clear();
        p.generatedWallIds.clear();
      }
      const partialCells = new Set(partialSpecs.flatMap(p => [...cellsOf(p)]));
      const remaining = new Set(
        [...cellsOf(R)].filter(c => !newCells.has(c) && !partialCells.has(c))
      );
      if (remaining.size > 0) {
        R.setCells(remaining);
        R.generatedWallIds.clear();
      } else {
        this.graph.removeRoom(R.id);
      }
    }
    const newRoom = this.graph.addRoom(newCells);

    // ケース1: 新部屋（ユーザーが選択したセル）を残存部屋 R の直前に配置する
    // 仕上げ表の期待順: 新部屋 → R（残余）
    if (isCase1 && this.graph.roomMap.has(R.id)) {
      const ro = this.graph.roomOrder;
      const newIdx = ro.indexOf(newRoom.id);
      if (newIdx >= 0) {
        ro.splice(newIdx, 1);
        const rIdx = ro.indexOf(R.id);
        if (rIdx >= 0) ro.splice(rIdx, 0, newRoom.id);
        else ro.push(newRoom.id);
      }
    }

    this.dragState      = null;
    this.namingRoomId   = newRoom.id;
    this.selectedRoomId = newRoom.id;
  }

  cancelDrag() { this.dragState = null; }

  selectRoom(roomId) { this.selectedRoomId = roomId; }

  finishNaming(roomId, name) {
    const room = this.graph.roomMap.get(roomId);
    if (room) room.setName(name || '部屋');
    // このセッションで命名した部屋として記録する。
    // 判定S で「部分指定が先に命名されたか」の判断に使う。
    this.sessionModifiedRoomIds.add(roomId);
    this.namingRoomId = null;
    // 境界エッジの生成はモード境界の差分追跡で行う（フェーズ4）。命名時の即時生成は廃止。
  }

  cancelNaming(roomId) {
    // キャンセル時は部屋を削除し、sessionModifiedRoomIds には記録しない
    this.graph.removeRoom(roomId);
    this.namingRoomId   = null;
    this.selectedRoomId = null;
  }

  /** ユーザーが明示的に部屋を削除する（仕上げ表の削除ボタン用）。壁・境界エッジの後始末はモード切替時の既存ロジックに委ねる。 */
  deleteRoom(roomId) {
    this.graph.removeRoom(roomId);
    if (this.selectedRoomId === roomId) this.selectedRoomId = null;
    if (this.namingRoomId === roomId) this.namingRoomId = null;
  }

  // ---- 階段 ----

  selectStair(id) { this.selectedStairId = id; }

  deleteStair(id) {
    this.graph.removeStair(id);
    if (this.selectedStairId === id) this.selectedStairId = null;
  }

  /**
   * 部屋名入力ダイアログで「階段」を選んだとき、その部屋を階段に変換する。
   * 部屋セルからタイプ・向きを推定して Stair を生成し、部屋は削除する。
   */
  convertRoomToStair(roomId, floorHeight = null) {
    const room = this.graph.roomMap.get(roomId);
    if (!room) return null;
    const cells = new Set(room.cells);
    this.graph.removeRoom(roomId);
    const cls = classifyStairArea(cells, this.graph, floorHeight);
    const opts = {
      type: cls.type, cells, upDirection: cls.upDirection,
      flip: cls.flip ?? false, segments: cls.segments ?? null,
    };
    if (cls.totalSteps) opts.totalSteps = cls.totalSteps;
    const stair = this.graph.addStair(opts);
    this.namingRoomId   = null;
    this.selectedRoomId = null;
    this.selectedStairId = stair.id;
    return stair;
  }

  get isDragging()   { return this.dragState !== null; }
  get previewCells() { return this.dragState ? [...this.dragState.visitedCells.values()] : []; }

  // ---- Lifecycle ----

  dispose() {
    this.cancelDrag();
    // 材データを破棄（仕上げモード離脱時）
    this.materials       = null;
    this.materialMap     = null;
    this.interiorMasters = null;
    this._composition    = null;
    this.materialsLoaded = false;
    this.materialError   = null;
  }
}
