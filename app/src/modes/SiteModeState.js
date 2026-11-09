import { makeObservable, observable, action, computed, reaction, runInAction } from 'mobx';
import { SiteLineKind } from '@core';
import {
  SITE_PLACEMENT_EMPTY_MESSAGE, SITE_PLACEMENT_READ_ERROR_MESSAGE, SITE_PLACEMENT_LOADING_MESSAGE, SITE_LOG_TAG,
} from '../core/constants.js';
import { withGraphsReadScope } from '../graphReadScope.js';
import { gridBoundsMm } from '../initialView.js';
import { isSanshaKind, computeLineTriNums } from '../site/lineClassification.js';
import { rectEdge, pickRectEdgeAnchor, rectNeighbors, deriveRectAttachment } from '../site/siteRectGeometry.js';
import { composeSitePlacementView } from '../site/sitePlacementView.js';
import { gridLineSnapshot } from '../site/sitePlacementGrid.js';
import { leanToPlanRegions, topRoofPlanRegions } from '../structural/roofFramingRegions.js';
import { collectAdoptedFloors } from './adoptedFloors.js';

export class SiteModeState {
  subMode        = 'sansha'; // 'sansha' | 'rect'（'other'＝その他タブは 2026-11-09 廃止。配置図は subMode でなく showPlacement の切替）
  selectedLineId = null;     // 選択中の SiteLine ID
  siteDrawState  = null;     // { startWorld: {x,y}, endWorld: {x,y} } | null
  // 三斜入力中の数値入力状態
  // 線分a/b（バッヂ0/1個）: { focusedCell: 'len'|'red'|'blue', lenValue, redLen, blueLen, redKind, blueKind }
  //   red/blue は次の三角形を構成する2辺（赤辺・青辺）の表中入力行に対応
  // 長さセルのタップによるロック解除（バッヂ>0個の確定済み線分）:
  //   { focusedCell: 'len', lenValue, confirmedValue, lenEditing: true }
  // 線分c（バッヂ2個）または未選択: null
  inputState     = null;

  // 長方形入力（subMode === 'rect'）。三斜側の状態とは独立（互いに消さない）
  selectedRectEdge = null;   // { rectId, side } | null（共有辺）
  rectAnchor       = 'a';    // 'a' | 'b'（共有辺の基点。rectEdge の端点 a/b）
  // 最初: { kind:'first',  origin:{x,y}, focusedCell:'w'|'h',        wValue, hValue }
  // 付加: { kind:'attach', focusedCell:'along'|'depth', alongValue, depthValue }
  // 既存の長方形の修正中は両形式とも editRectId（修正対象の id）と editColumns（表の よこ/たて 列 → 入力セル）が付く
  rectInputState   = null;

  // 配置図（屋根伏せ図＋図芯合わせした敷地の外周）の表示。表示中は敷地の入力（三斜・長方形の UI と pointer 操作）を止める。
  // 読込み: 全採用階を読む（graph は変更しない表示専用。立面モードの init と同じく uiBusy/runBusy は使わない）。
  // 世代 _placementGen: 読込みの await 中に 非表示→再表示 や dispose が起きたとき、古い結果を捨てるため。
  showPlacement    = false;
  placementLoading = false;
  placementRoof    = null; // { floors: [{planeId, regions}], gridBounds, gridLines, readFailed } | null

  constructor(site, project = null) {
    this.site = site;
    this.project = project;
    this._placementGen = 0;
    this._disposed = false;
    makeObservable(this, {
      showPlacement:      observable,
      placementLoading:   observable,
      placementRoof:      observable.ref,
      placementView:      computed,
      placementMessage:   computed,
      inputSubMode:       computed,
      setShowPlacement:   action,
      subMode:            observable,
      selectedLineId:     observable,
      siteDrawState:      observable.ref,
      inputState:         observable.ref,
      selectedRectEdge:   observable.ref,
      rectAnchor:         observable,
      rectInputState:     observable.ref,
      selectedLine:       computed,
      siteDrawPreviewEnd: computed,
      setSubMode:         action,
      selectLine:         action,
      clearSelection:     action,
      startSiteDraw:      action,
      updateSiteDraw:     action,
      commitSiteDraw:     action,
      cancelSiteDraw:     action,
      setFocusedCell:     action,
      setInputValue:      action,
      cycleEdgeKind:      action,
      clearInput:         action,
      startLenEdit:       action,
      startFirstRect:     action,
      startRectEdit:      action,
      selectRectEdge:     action,
      toggleRectEdge:     action,
      toggleLineSelection: action,
      toggleRectAnchor:   action,
      setRectFocusedCell: action,
      setRectInputValue:  action,
      clearRectInput:     action,
      clearRectState:     action,
    });
    // undo 等で選択辺の長方形・修正対象の長方形が消えたら、長方形側の選択・入力を残さない
    this._rectGoneDispose = reaction(
      () => (this.selectedRectEdge != null && !this.site.rectMap.has(this.selectedRectEdge.rectId))
        || (this.rectInputState?.editRectId != null && !this.site.rectMap.has(this.rectInputState.editRectId)),
      (gone) => { if (gone) this.clearRectState(); },
    );
    // 削除・undo 等で選択中の線が消えたら、三斜側の選択・入力を残さない
    this._lineGoneDispose = reaction(
      () => this.selectedLineId != null && !this.site.lineMap.has(this.selectedLineId),
      (gone) => { if (gone) this.selectLine(null); }, // selectLine(null) は selectedLineId=null＋inputState=null の action
    );
  }

  /**
   * 突入時の初期化。配置の痕跡（site.placement）があれば配置図を開いた状態にして読込みを待つ。
   * 決して reject しない（読込みの失敗は placementRoof.readFailed）。
   */
  async init() {
    if (this.site.placement != null) await this.setShowPlacement(true);
  }

  get selectedLine() {
    return this.selectedLineId ? (this.site.lineMap.get(this.selectedLineId) ?? null) : null;
  }

  // pointer 操作が読むサブモード。配置図の表示中は null（押下を記録せず入力を止める。パンは効く）
  get inputSubMode() {
    return this.showPlacement ? null : this.subMode;
  }

  get placementView() {
    return this.showPlacement && this.placementRoof
      ? composeSitePlacementView({ site: this.site, roof: this.placementRoof })
      : null;
  }

  // 配置図の下に出す通知文。読込み中 → 読めなかった階・屋根がある → 屋根の線が1本も無い、の優先順
  get placementMessage() {
    if (!this.showPlacement) return null;
    if (this.placementLoading) return SITE_PLACEMENT_LOADING_MESSAGE;
    const view = this.placementView;
    if (!view) return null;
    if (this.placementRoof.readFailed || view.roofFailedCount > 0) return SITE_PLACEMENT_READ_ERROR_MESSAGE;
    if (view.roofEmpty) return SITE_PLACEMENT_EMPTY_MESSAGE;
    return null;
  }

  /**
   * 配置図の表示を切り替える。表示にするときは敷地の選択・入力・描画中の線を捨てて全採用階を読む。
   * 返す Promise は読込みの完了で解決し、決して reject しない（失敗は placementRoof.readFailed）。
   */
  setShowPlacement(on) {
    if (on === this.showPlacement) return Promise.resolve();
    this.showPlacement = on;
    if (on) {
      this.clearSelection();
      this.cancelSiteDraw();
      return this._loadPlacement();
    }
    this.placementRoof = null;
    this.placementLoading = false;
    this._placementGen++;
    return Promise.resolve();
  }

  async _loadPlacement() {
    const gen = ++this._placementGen;
    const project = this.project;
    runInAction(() => { this.placementLoading = true; });
    let roof;
    try {
      const { floors, readFailed } = await collectAdoptedFloors(project, SITE_LOG_TAG);
      if (this._disposed || gen !== this._placementGen || !this.showPlacement) return;
      let regionFailed = false;
      const graphs = floors.map(f => f.graph).filter(Boolean);
      const regionFloors = withGraphsReadScope(graphs, () => floors.flatMap(f => {
        if (!f.graph) return []; // peek に失敗した階（readFailed は collectAdoptedFloors が立てている）
        try {
          return [{ planeId: f.plane.id, regions: [...leanToPlanRegions(f.graph), ...topRoofPlanRegions(f.graph, project)] }];
        } catch (err) {
          console.warn(`${SITE_LOG_TAG} 階「${f.plane.name ?? f.plane.id}」の屋根を解決できませんでした（その階は描かない）:`, err);
          regionFailed = true;
          return [];
        }
      }));
      roof = {
        floors: regionFloors,
        gridBounds: project?.structGraph ? gridBoundsMm(project.structGraph) : null,
        gridLines: gridLineSnapshot(project?.structGraph),
        readFailed: readFailed || regionFailed,
      };
    } catch (err) {
      console.error(`${SITE_LOG_TAG} 配置図の読込みに失敗:`, err);
      roof = { floors: [], gridBounds: null, gridLines: [], readFailed: true };
    }
    if (this._disposed || gen !== this._placementGen || !this.showPlacement) return;
    runInAction(() => {
      this.placementRoof = roof;
      this.placementLoading = false;
    });
  }

  // ドラッグ方向（45度基準）で垂直/水平を判定した確定端点
  get siteDrawPreviewEnd() {
    if (!this.siteDrawState) return null;
    const { startWorld: s, endWorld: e } = this.siteDrawState;
    const dx = e.x - s.x;
    const dy = e.y - s.y;
    return Math.abs(dy) >= Math.abs(dx)
      ? { x: s.x, y: e.y }  // 垂直線
      : { x: e.x, y: s.y }; // 水平線
  }

  setSubMode(mode) {
    this.subMode        = mode;
    this.selectedLineId = null;
    this.clearRectState();
  }

  selectLine(lineId) {
    // 描画エリアで三斜入力済み線分をクリックした場合、情報ウィンドウを三斜タブに切替
    if (lineId != null) {
      const line = this.site.lineMap.get(lineId);
      if (line && isSanshaKind(line.lineKind)) {
        this.subMode = 'sansha';
        this.clearRectState();
      }
    }
    this.selectedLineId = lineId;
    if (this.subMode !== 'sansha' || lineId == null) {
      this.inputState = null;
      return;
    }
    const badgeCount = computeLineTriNums(this.site).get(lineId)?.length ?? 0;
    if (badgeCount >= 2) {
      // 線分c（バッヂ2個）→ 選択のみ（長さ編集は長さセルのタップで明示的にロック解除）
      this.inputState = null;
    } else {
      // 線分a（バッヂ0個）/ 線分b（バッヂ1個）→ 赤辺・青辺の入力行を追加
      // バッヂ0個のみ、長さフィールドを初期フォーカス（線分長さの確定が未済のため）
      this.inputState = {
        focusedCell: badgeCount === 0 ? 'len' : 'red',
        redLen: '', blueLen: '', lenValue: '',
        // 三斜の線種は SURVEY（無指定）⇄ ROAD の2値。新しい辺は常に無指定
        // （道路指定は外周になった線へユーザーが明示的に行う）
        redKind: SiteLineKind.SURVEY,
        blueKind: SiteLineKind.SURVEY,
      };
    }
  }

  // 描画エリアの線タップ: 選択中の線の再タップは解除、違う線なら選択
  toggleLineSelection(lineId) {
    if (lineId != null && this.selectedLineId === lineId) this.clearSelection();
    else this.selectLine(lineId);
  }

  clearSelection() {
    this.selectedLineId = null;
    this.inputState     = null;
    this.clearRectState();
  }

  // 長方形側の選択・入力を消す（基点は既定へ戻す）
  clearRectState() {
    this.selectedRectEdge = null;
    this.rectAnchor       = 'a';
    this.rectInputState   = null;
  }

  setFocusedCell(cell) {
    if (!this.inputState) return;
    this.inputState = { ...this.inputState, focusedCell: cell };
  }

  setInputValue(val) {
    if (!this.inputState) return;
    const fc = this.inputState.focusedCell;
    const key = fc === 'red' ? 'redLen' : fc === 'blue' ? 'blueLen' : 'lenValue';
    this.inputState = { ...this.inputState, [key]: val };
  }

  // 赤辺/青辺（未確定行）の線種を切替（無指定=SURVEY ⇄ 道路=ROAD。BOUNDARY は無指定扱い）
  cycleEdgeKind(which) {
    if (!this.inputState) return;
    const key = which === 'red' ? 'redKind' : 'blueKind';
    const cur = this.inputState[key];
    const next = cur === SiteLineKind.ROAD ? SiteLineKind.SURVEY : SiteLineKind.ROAD;
    this.inputState = { ...this.inputState, [key]: next };
  }

  clearInput() {
    this.inputState = null;
  }

  // ---- 三斜タブ 長さセルのタップ：確定済み線分の長さフィールドをロック解除 ----

  startLenEdit(lineId) {
    const line = this.site.lineMap.get(lineId);
    if (!line) return;
    const len = line.length.toFixed(0);
    this.selectedLineId = lineId;
    this.inputState = {
      focusedCell:    'len',
      lenValue:       len,
      confirmedValue: len,
      lenEditing:     true,
    };
  }

  // ---- 長方形入力 ----

  // 最初の長方形: 描画エリアのタップ点を左上角として寸法入力へ
  startFirstRect(wx, wy) {
    this.selectedRectEdge = null;
    this.rectInputState = {
      kind: 'first', origin: { x: wx, y: wy }, focusedCell: 'w', wValue: '', hValue: '',
    };
  }

  // 共有辺を選択（基点は pickRectEdgeAnchor の規則で初期化）→ 辺長・奥行の入力へ。
  // 存在しない長方形なら何もしない
  selectRectEdge(rectId, side, viewport) {
    const rect = this.site.rectMap.get(rectId);
    if (!rect) return;
    this.selectedRectEdge = { rectId, side };
    this.rectAnchor = pickRectEdgeAnchor(rectEdge(rect, side), viewport);
    this.rectInputState = { kind: 'attach', focusedCell: 'along', alongValue: '', depthValue: '' };
  }

  // 描画エリアの辺タップ: 選択中の辺の再タップは解除（修正中の基の辺なら修正の取り消し）、違う辺なら選択
  toggleRectEdge(rectId, side, viewport) {
    const cur = this.selectedRectEdge;
    if (cur && cur.rectId === rectId && cur.side === side) this.clearRectState();
    else this.selectRectEdge(rectId, side, viewport);
  }

  // 既存の長方形の寸法修正を始める（自動選定: 隣接 0＝最初の入力形式／隣接 1＝付加入力形式で基の辺・基点を復元）。
  // 修正不可（隣接 2 以上・基点が復元できない・存在しない）なら何もしない
  // column: 表で押した列（'w'＝よこ／'h'＝たて）。最初にフォーカスする入力セルを決める
  startRectEdit(rectId, viewport, column = 'w') {
    const rect = this.site.rectMap.get(rectId);
    if (!rect) return;
    const rects = this.site.rects;
    if (rectNeighbors(rects, rectId).length === 0) {
      this.selectedRectEdge = null;
      this.rectInputState = {
        kind: 'first', origin: { x: rect.x, y: rect.y }, focusedCell: column,
        wValue: rect.w.toFixed(0), hValue: rect.h.toFixed(0), editRectId: rectId,
        editColumns: { w: 'w', h: 'h' },
      };
      return;
    }
    const d = deriveRectAttachment(rects, rectId);
    if (!d) return;
    const base = this.site.rectMap.get(d.baseRectId);
    this.selectedRectEdge = { rectId: d.baseRectId, side: d.side };
    this.rectAnchor = d.anchors.length === 2
      ? pickRectEdgeAnchor(rectEdge(base, d.side), viewport)
      : d.anchors[0];
    // 表の よこ・たて 列が入力のどのセルか（基の辺が横なら よこ＝辺長、縦なら よこ＝奥行）
    const editColumns = (d.side === 'n' || d.side === 's')
      ? { w: 'along', h: 'depth' }
      : { w: 'depth', h: 'along' };
    this.rectInputState = {
      kind: 'attach', focusedCell: editColumns[column],
      alongValue: d.along.toFixed(0), depthValue: d.depth.toFixed(0), editRectId: rectId, editColumns,
    };
  }

  toggleRectAnchor() {
    if (!this.selectedRectEdge) return;
    this.rectAnchor = this.rectAnchor === 'a' ? 'b' : 'a';
  }

  setRectFocusedCell(cell) {
    if (!this.rectInputState) return;
    this.rectInputState = { ...this.rectInputState, focusedCell: cell };
  }

  setRectInputValue(val) {
    const st = this.rectInputState;
    if (!st) return;
    const key = { w: 'wValue', h: 'hValue', along: 'alongValue', depth: 'depthValue' }[st.focusedCell];
    if (!key) return;
    this.rectInputState = { ...st, [key]: val };
  }

  // 入力と共有辺の選択を消す（確定後・Escape）
  clearRectInput() {
    this.clearRectState();
  }

  // ---- 敷地線分描画 ----

  startSiteDraw(wx, wy) {
    this.siteDrawState = { startWorld: { x: wx, y: wy }, endWorld: { x: wx, y: wy } };
  }

  updateSiteDraw(wx, wy) {
    if (!this.siteDrawState) return;
    this.siteDrawState = { ...this.siteDrawState, endWorld: { x: wx, y: wy } };
  }

  // 確定: 拘束後の始点・終点を返す。呼び出し側で SitePoint/SiteLine を生成すること
  commitSiteDraw() {
    const ds = this.siteDrawState;
    if (!ds) return null;
    const ep = this.siteDrawPreviewEnd;
    this.siteDrawState = null;
    return { startWorld: ds.startWorld, endWorld: ep };
  }

  cancelSiteDraw() {
    this.siteDrawState = null;
  }

  // ---- Lifecycle ----

  dispose() {
    this._disposed = true;
    this._rectGoneDispose?.();
    this._lineGoneDispose?.();
    this.clearSelection();
    this.cancelSiteDraw();
  }
}
