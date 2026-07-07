import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { regionCellsAt, refreshCells, cellBoundsFromKey, cellBoundsList } from '../finish/gridCells.js';
import { classifyStairArea } from '../finish/stair/stairClassify.js';
import { cellsBeyondBreak } from '../finish/stair/stairGeometry.js';
import { floorHeightAbove } from '../finish/stair/stairDimensions.js';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
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
  dragState      = null; // { currentCell, visitedCells: Map, stairKeys: Set } | null
  selectedRoomId = null;
  namingRoomId   = null;
  selectedStairId = null;

  // ---- 直下階の階段（見下げ表示のヒット判定用。init() で peek しロード） ----
  lowerStairs = []; // Array<{ stair, cellBounds }>（cellBounds は下階graphで解決したワールド矩形配列）

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
    // 仕上げモード突入後に finishNaming() で確定した Room ID を記録する。
    // FinishModeState はモード切替のたびに new で生成されるため、
    // フロアプランモードに戻ると自動的にリセットされる。
    this.sessionModifiedRoomIds = new Set();
    makeObservable(this, {
      dragState:      observable.ref,
      selectedRoomId: observable,
      namingRoomId:   observable,
      selectedStairId: observable,
      lowerStairs:     observable.ref,
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

    await this._loadLowerStairs();

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

  /** 自階階段の蹴上(mm)。stair.riser 未指定なら階高/総段数から推定（App.jsx の install entries と同じ計算）。 */
  _selfStairRiser(stair) {
    if (stair.riser != null) return stair.riser;
    const fh = floorHeightAbove(this.project, this.project?.activePlane);
    return fh != null ? fh / Math.max(1, stair.totalSteps) : null;
  }

  /**
   * stair の破れ線先セル集合。cellsBeyondBreak は stair.cells をそのまま参照するため、
   * floorplanモードでの区切りCL追加により保存済みキーが古くなっている場合に備え、
   * refreshCells 後のキー集合（cells）に差し替えた最小限のオブジェクトを渡す
   * （既存の startDrag のポインタ判定と同じ refreshCells 前提を合わせるため）。
   */
  _beyondBreakOf(stair, cells) {
    const shim = {
      type: stair.type, upDirection: stair.upDirection, flip: stair.flip,
      sections: stair.sections, totalSteps: stair.totalSteps, cells,
    };
    return cellsBeyondBreak(shim, this.graph, this._selfStairRiser(stair));
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
   */
  _roomExcludedStairKeys() {
    const stairKeys = new Set();
    for (const s of this.graph.stairs) {
      const cells = refreshCells(s.cells, this.graph);
      const beyond = this._beyondBreakOf(s, cells);
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

  /** エッジの詳細断面バンド（LOD詳細描画用）。未解決なら null。 */
  resolveEdgeSection(edge, graph, cellToRoom) {
    return this._composition?.resolveEdgeSection(edge, graph, this.materialMap, cellToRoom) ?? null;
  }

  // 選択は連結領域単位。短縮CLでL字化した領域は、内部のどこを指しても
  // 構成セル全部をまとめて拾う（先頭はポインタ直下のセル）
  //
  // 階段クリックの優先順位（ポインタ直下 wx,wy で判定）:
  //   1. 自階階段のセルかつ破れ線手前          → その自階階段を選択
  //   2. 自階階段のセルで破れ線先＋下階階段あり → 下階階段を選択（見下げクリック）
  //   3. 自階に階段が無い＋下階階段あり         → 下階階段を選択（見下げクリック）
  //   4. 自階階段のセルで破れ線先＋下階階段なし → 階段下エリアとして部屋ドラッグを許可
  startDrag(wx, wy) {
    const region = regionCellsAt(wx, wy, this.graph);
    if (region.length === 0) return;

    // 階段のセルを直接指した場合は部屋ドラッグを開始せず、その階段自体を選択する。
    // 判定はポインタ直下のセル（region[0]）のみで行う。連結領域全体との交差で
    // 判定すると、領域が階段の実占有より広い場合（L字の空象限が連結している等）に
    // 階段でないマスのクリックでも階段が選択されてしまう（＝矩形的な過剰選択）。
    const pointerKey = region[0].key;
    let stair = null, stairCells = null;
    for (const s of this.graph.stairs) {
      const cells = refreshCells(s.cells, this.graph);
      if (cells.has(pointerKey)) { stair = s; stairCells = cells; break; }
    }

    if (stair) {
      const beyond = this._beyondBreakOf(stair, stairCells);
      if (!beyond.has(pointerKey)) {
        this._selectStair(stair.id); // 優先1: 自階階段（破れ線手前）
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

  selectRoom(roomId) {
    this.selectedRoomId = roomId;
    this.selectedStairId = null;
  }

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

  selectStair(id) {
    this.selectedStairId = id;
    this.selectedRoomId  = null;
  }

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
      flip: cls.flip ?? false, sections: cls.sections ?? null,
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
    this.lowerStairs     = [];
    this._disposed       = true;
  }
}
