import { makeObservable, observable, action, computed } from 'mobx';
import { SiteLineKind } from '@core';
import { isSanshaKind, computeLineTriNums } from '../site/lineClassification.js';

export class SiteModeState {
  subMode        = 'sansha'; // 'sansha' | 'other' | 'placement'
  selectedLineId = null;     // 選択中の SiteLine ID
  siteDrawState  = null;     // { startWorld: {x,y}, endWorld: {x,y} } | null
  // 三斜入力中の数値入力状態
  // 線分a/b（バッヂ0/1個）: { focusedCell: 'len'|'red'|'blue', lenValue, redLen, blueLen, redKind, blueKind }
  //   red/blue は次の三角形を構成する2辺（赤辺・青辺）の表中入力行に対応
  // 編集ボタンによるロック解除（バッヂ>0個の確定済み線分）:
  //   { focusedCell: 'len', lenValue, confirmedValue, lenEditing: true }
  // 線分c（バッヂ2個）または未選択: null
  inputState     = null;

  constructor(site) {
    this.site = site;
    makeObservable(this, {
      subMode:            observable,
      selectedLineId:     observable,
      siteDrawState:      observable.ref,
      inputState:         observable.ref,
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
    });
  }

  get selectedLine() {
    return this.selectedLineId ? (this.site.lineMap.get(this.selectedLineId) ?? null) : null;
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
  }

  selectLine(lineId) {
    // 描画エリアで三斜入力済み線分をクリックした場合、情報ウィンドウを三斜タブに切替
    if (lineId != null) {
      const line = this.site.lineMap.get(lineId);
      if (line && isSanshaKind(line.lineKind)) {
        this.subMode = 'sansha';
      }
    }
    this.selectedLineId = lineId;
    if (this.subMode !== 'sansha' || lineId == null) {
      this.inputState = null;
      return;
    }
    const badgeCount = computeLineTriNums(this.site).get(lineId)?.length ?? 0;
    if (badgeCount >= 2) {
      // 線分c（バッヂ2個）→ 選択のみ（長さ編集は編集ボタンで明示的にロック解除）
      this.inputState = null;
    } else {
      // 線分a（バッヂ0個）/ 線分b（バッヂ1個）→ 赤辺・青辺の入力行を追加
      // バッヂ0個のみ、長さフィールドを初期フォーカス（線分長さの確定が未済のため）
      const line = this.site.lineMap.get(lineId);
      this.inputState = {
        focusedCell: badgeCount === 0 ? 'len' : 'red',
        redLen: '', blueLen: '', lenValue: '',
        redKind: line?.lineKind ?? SiteLineKind.SURVEY,
        blueKind: line?.lineKind ?? SiteLineKind.SURVEY,
      };
    }
  }

  clearSelection() {
    this.selectedLineId = null;
    this.inputState     = null;
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

  // 赤辺/青辺（未確定行）の線種を循環切替
  cycleEdgeKind(which) {
    if (!this.inputState) return;
    const order = [SiteLineKind.BOUNDARY, SiteLineKind.ROAD, SiteLineKind.SURVEY];
    const key = which === 'red' ? 'redKind' : 'blueKind';
    const cur = this.inputState[key];
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.inputState = { ...this.inputState, [key]: next };
  }

  clearInput() {
    this.inputState = null;
  }

  // ---- 三斜タブ「編集」ボタン：確定済み線分の長さフィールドをロック解除 ----

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
    this.clearSelection();
    this.cancelSiteDraw();
  }
}
