import { makeObservable, observable, action, computed, reaction, runInAction } from 'mobx';
import { SiteLineKind } from '@core';
import {
  SITE_PLACEMENT_EMPTY_MESSAGE, SITE_PLACEMENT_READ_ERROR_MESSAGE, SITE_PLACEMENT_LOADING_MESSAGE, SITE_LOG_TAG,
  SitePlacementAlongVertex, CenterLineType,
} from '../core/constants.js';
import { withGraphsReadScope } from '../graphReadScope.js';
import { gridBoundsMm } from '../initialView.js';
import { isSanshaKind, computeLineTriNums } from '../site/lineClassification.js';
import { rectEdge, pickRectEdgeAnchor, rectNeighbors, deriveRectAttachment } from '../site/siteRectGeometry.js';
import { composeSitePlacementView, samePlacementVertex, placementVertexIndex } from '../site/sitePlacementView.js';
import { gridLineSnapshot, markExteriorGridLines } from '../site/sitePlacementGrid.js';
import { computeExteriorWallSegments } from '../finish/wallGeneration.js';
import { evalNumpadExpr } from '../ui/numpadUtils.js';
import { computeSitePlacement } from '../site/sitePlacementSolve.js';
import {
  applySitePlacementWithUndo, TOAST_PLACEMENT_INCOMPLETE, TOAST_PLACEMENT_DISTANCE_BAD, TOAST_PLACEMENT_UNSOLVABLE,
  TOAST_PLACEMENT_ALONG_INCOMPLETE, TOAST_PLACEMENT_ALONG_AXIS,
} from '../transform/sitePlacementEdit.js';
import { leanToPlanRegions, topRoofPlanRegions } from '../structural/roofFramingRegions.js';
import { collectAdoptedFloors } from './adoptedFloors.js';

// 2 段目「位置」の入力バッファ（vertex＝共有点 1|2。保存値は {vertex, centerLineId, distance, sideFlipped}）
const emptyAlongInput = () => ({
  vertex: SitePlacementAlongVertex.V1, centerLineId: null, distanceValue: '', sideFlipped: false,
});

const emptyPlacementInput = () => ({
  v1: null, v2: null, centerLineId: null, distanceValue: '', rotationFlipped: false, sideFlipped: false,
  along: emptyAlongInput(),
});

// 1 段目の通り芯の軸と直交する軸（縦⇄横）。それ以外（放射など）は直交する軸なし
const ORTHOGONAL_AXIS = Object.freeze({
  [CenterLineType.VERTICAL]: CenterLineType.HORIZONTAL,
  [CenterLineType.HORIZONTAL]: CenterLineType.VERTICAL,
});

// 距離の入力文字列（NumPad の式 '1000+500' 等を敷地の他の入力と同じ評価器で数値に）。未入力・0 以下・式でないものは NaN
const evalPlacementDistance = (s) => (s.trim() === '' ? NaN : evalNumpadExpr(s, { positiveOnly: true }));

// 保存済みの配置（site.placement.input）から配置指定の入力を作る。痕跡が無ければ空
function placementInputFromSite(site) {
  const input = site.placement?.input;
  if (!input) return emptyPlacementInput();
  const a = input.along;
  return {
    v1: input.v1 ? { x: input.v1.x, y: input.v1.y } : null,
    v2: input.v2 ? { x: input.v2.x, y: input.v2.y } : null,
    centerLineId: input.centerLineId || null, // 保存側は未指定を '' に揃える
    distanceValue: String(input.distance),
    rotationFlipped: !!input.rotationFlipped,
    sideFlipped: !!input.sideFlipped,
    along: a
      ? { vertex: a.vertex, centerLineId: a.centerLineId, distanceValue: String(a.distance), sideFlipped: !!a.sideFlipped }
      : emptyAlongInput(),
  };
}

// 頂点の状態: 指定なし／指定あり／指定はあるが今の敷地に該当する角が無い（失効）。view が無いときは失効を判定できず 'set'
function placementVertexState(v, view) {
  if (!v) return 'none';
  if (view && !view.siteCorners.some(c => samePlacementVertex(c, v))) return 'stale';
  return 'set';
}

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
  // 配置の指定入力（保存しない画面状態。表示にした時点で site.placement.input から作り、非表示で null）。
  // { v1:{x,y}|null, v2:{x,y}|null（敷地座標）, centerLineId:string|null, distanceValue:string, rotationFlipped, sideFlipped,
  //   along:{vertex:1|2, centerLineId:string|null, distanceValue:string, sideFlipped}（2 段目「位置」の入力バッファ）}
  placementInput   = null;
  placementDistanceFocused = false; // 距離欄を編集中（NumPad を出す）
  placementAlongDistanceFocused = false; // 位置の離れ欄を編集中（NumPad を出す。距離欄の編集とは排他）

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
      placementInput:     observable.ref,
      placementDistanceFocused: observable,
      placementAlongDistanceFocused: observable,
      placementVertexStates: computed,
      placementCenterLine: computed,
      placementCenterLineStale: computed,
      placementAlongCenterLines: computed,
      placementAlongCenterLine: computed,
      placementAlongStale: computed,
      placementAlongState: computed,
      placementAlongVertexStale: computed,
      placementCanCommit: computed,
      setPlacementAlongVertex: action,
      setPlacementAlongCenterLine: action,
      setPlacementAlongDistanceValue: action,
      setPlacementAlongDistanceFocused: action,
      togglePlacementAlongSide: action,
      clearPlacementAlong: action,
      pickPlacementVertex: action,
      pickPlacementCenterLine: action,
      setPlacementCenterLine: action,
      setPlacementDistanceValue: action,
      setPlacementDistanceFocused: action,
      togglePlacementRotation: action,
      togglePlacementSide: action,
      clearPlacement:     action,
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
    // 配置が非 null に変わったら（確定・undo/redo による復元）入力を保存値から作り直す。null への変化（確定の undo・解除）では触らない
    this._placementSyncDispose = reaction(
      () => this.site.placement,
      (p) => {
        if (!this.showPlacement || !p) return;
        this.placementInput = placementInputFromSite(this.site);
        this.placementDistanceFocused = false; // 打ちかけの距離は保存値に置き換わるので、NumPad は閉じる
        this.placementAlongDistanceFocused = false;
      },
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
      this.placementInput = placementInputFromSite(this.site);
      return this._loadPlacement();
    }
    this.placementInput = null;
    this.placementDistanceFocused = false;
    this.placementAlongDistanceFocused = false;
    this.placementRoof = null;
    this.placementLoading = false;
    this._placementGen++;
    return Promise.resolve();
  }

  // ---- 配置の指定（頂点2点・通り芯・距離・反転）。入力は placementInput。確定は commitPlacement ----

  // 頂点ごとの状態（'none'|'set'|'stale'）。stale＝指定はあるが今の配置図の角に一致するものが無い
  get placementVertexStates() {
    const inp = this.placementInput;
    const view = this.placementView;
    return { v1: placementVertexState(inp?.v1, view), v2: placementVertexState(inp?.v2, view) };
  }

  // 指定中の通り芯（表示時点の写し placementRoof.gridLines から id で引く）。引けなければ null
  get placementCenterLine() {
    const id = this.placementInput?.centerLineId;
    if (!id) return null;
    return this.placementRoof?.gridLines?.find(g => g.id === id) ?? null;
  }

  // 通り芯の指定はあるが写しに無い（失効）
  get placementCenterLineStale() {
    return !!this.placementInput?.centerLineId && this.placementCenterLine === null;
  }

  // 距離の入力値（数値。未入力・数値でない場合は NaN）
  _placementDistance() {
    return evalPlacementDistance(this.placementInput?.distanceValue ?? '');
  }

  // 位置（2 段目）の離れの入力値（数値。未入力・数値でない場合は NaN）
  _placementAlongDistance() {
    return evalPlacementDistance(this.placementInput?.along?.distanceValue ?? '');
  }

  // 位置の通り芯の候補＝1 段目の通り芯の軸と直交する軸の線（表示時点の写し）。1 段目が未選択・縦横以外なら []
  get placementAlongCenterLines() {
    const orthogonal = ORTHOGONAL_AXIS[this.placementCenterLine?.centerLineType];
    if (!orthogonal) return [];
    return (this.placementRoof?.gridLines ?? []).filter(g => g.centerLineType === orthogonal);
  }

  // 指定中の位置の通り芯（候補の中から id で引く。軸が 1 段目と同じ・写しに無ければ null）
  get placementAlongCenterLine() {
    const id = this.placementInput?.along?.centerLineId;
    if (!id) return null;
    return this.placementAlongCenterLines.find(g => g.id === id) ?? null;
  }

  // 位置の通り芯の指定はあるが引けない（失効。写しに無い・1 段目の軸が変わって同じ軸になった等）
  get placementAlongStale() {
    return !!this.placementInput?.along?.centerLineId && this.placementAlongCenterLine === null;
  }

  // 位置の入力の状態: 'none'＝通り芯も離れも空（共有点・側は数えない）／'ready'＝両方入力あり／'partial'＝片方だけ
  get placementAlongState() {
    const a = this.placementInput?.along;
    if (!a) return 'none';
    const hasLine = !!a.centerLineId;
    const hasDistance = a.distanceValue.trim() !== '';
    if (!hasLine && !hasDistance) return 'none';
    return hasLine && hasDistance ? 'ready' : 'partial';
  }

  // 位置の共有点（1 段目の頂点 k）が指定済みでない。位置を指定しているときだけ true（未指定の入力で常に失効と出さない）
  get placementAlongVertexStale() {
    const a = this.placementInput?.along;
    if (!a || this.placementAlongState === 'none') return false;
    return this.placementVertexStates[a.vertex === SitePlacementAlongVertex.V2 ? 'v2' : 'v1'] !== 'set';
  }

  get placementCanCommit() {
    const st = this.placementVertexStates;
    const d = this._placementDistance();
    const firstOk = st.v1 === 'set' && st.v2 === 'set' && this.placementCenterLine !== null && Number.isFinite(d) && d > 0;
    if (!firstOk) return false;
    const along = this.placementAlongState;
    if (along === 'partial') return false;
    if (along === 'none') return true;
    const ad = this._placementAlongDistance();
    return this.placementAlongCenterLine !== null && !this.placementAlongVertexStale && Number.isFinite(ad) && ad > 0;
  }

  /** 配置図上の敷地の角（敷地座標）をタップ。指定済みの角は解除、それ以外は v1→v2 の順に埋め、両方埋まっていれば v2 を置換する（v1 は距離の基準なので据え置き）。 */
  pickPlacementVertex(pt) {
    const inp = this.placementInput;
    if (!inp) return;
    const p = { x: pt.x, y: pt.y };
    const idx = placementVertexIndex(inp, p);
    if (idx === 1) this.placementInput = { ...inp, v1: null };
    else if (idx === 2) this.placementInput = { ...inp, v2: null };
    else if (this.placementVertexStates.v1 !== 'set') this.placementInput = { ...inp, v1: p }; // 空き・失効の頂点1は空きとして埋め直す
    else this.placementInput = { ...inp, v2: p }; // v2 が空・失効・埋まっていても v2 へ
  }

  setPlacementCenterLine(id) {
    const inp = this.placementInput;
    if (!inp) return;
    this.placementInput = { ...inp, centerLineId: inp.centerLineId === id ? null : id };
  }

  setPlacementDistanceValue(str) {
    if (!this.placementInput) return;
    this.placementInput = { ...this.placementInput, distanceValue: str };
  }

  setPlacementDistanceFocused(on) {
    this.placementDistanceFocused = !!on;
    if (on) this.placementAlongDistanceFocused = false; // NumPad は 1 つだけ
  }

  // ---- 2 段目「位置」の入力 ----

  setPlacementAlongVertex(vertex) {
    const inp = this.placementInput;
    if (!inp || (vertex !== SitePlacementAlongVertex.V1 && vertex !== SitePlacementAlongVertex.V2)) return;
    this.placementInput = { ...inp, along: { ...inp.along, vertex } };
  }

  setPlacementAlongCenterLine(id) {
    const inp = this.placementInput;
    if (!inp) return;
    this.placementInput = { ...inp, along: { ...inp.along, centerLineId: inp.along.centerLineId === id ? null : id } };
  }

  setPlacementAlongDistanceValue(str) {
    const inp = this.placementInput;
    if (!inp) return;
    this.placementInput = { ...inp, along: { ...inp.along, distanceValue: str } };
  }

  setPlacementAlongDistanceFocused(on) {
    this.placementAlongDistanceFocused = !!on;
    if (on) this.placementDistanceFocused = false; // NumPad は 1 つだけ
  }

  togglePlacementAlongSide() {
    const inp = this.placementInput;
    if (!inp) return { ok: true, toast: null };
    const next = { ...inp, along: { ...inp.along, sideFlipped: !inp.along.sideFlipped } };
    if (this.placementAlongState === 'none') { // 位置なしでは側は配置に効かない。フラグだけ切り替える
      this.placementInput = next;
      return { ok: true, toast: null };
    }
    return this._updateAndReplace(next);
  }

  /** 位置の入力を既定へ戻す。配置済みで確定できる入力なら即座に再配置する（沿い座標は前回の変換の据え置きに戻る）。 */
  clearPlacementAlong() {
    const inp = this.placementInput;
    if (!inp) return { ok: true, toast: null };
    this.placementAlongDistanceFocused = false;
    return this._updateAndReplace({ ...inp, along: emptyAlongInput() });
  }

  togglePlacementRotation() { return this._toggleFlip('rotationFlipped'); }

  togglePlacementSide() { return this._toggleFlip('sideFlipped'); }

  // フラグを切り替える。配置済みで確定できる入力なら即座に再配置する（undo 1 件ずつ）。戻り値は commit の結果、それ以外は {ok:true, toast:null}
  _toggleFlip(key) {
    const inp = this.placementInput;
    if (!inp) return { ok: true, toast: null };
    return this._updateAndReplace({ ...inp, [key]: !inp[key] });
  }

  // 入力を差し替え、配置済みで確定できる入力なら即座に再配置する
  _updateAndReplace(next) {
    this.placementInput = next;
    return this._replaceIfPlaced();
  }

  // 配置済みで確定できる入力なら即座に再配置する（undo 1 件）。それ以外は {ok:true, toast:null}
  _replaceIfPlaced() {
    if (this.site.placement != null && this.placementCanCommit) return this.commitPlacement();
    return { ok: true, toast: null };
  }

  /**
   * 配置図の通り芯の丸ラベルをタップ（外周の通り芯 exterior だけ。写しに無い・外周でない id は無視）。
   * 軸で段が決まる: 1 段目の通り芯 A が未選択→A／A と同じ軸→A を置換（A 自身なら解除）／A と直交する軸→位置（2 段目）の通り芯
   * （その通り芯自身なら解除）。2 段目の変更・解除は配置済みで確定できる入力なら即時再配置（1 段目の変更はしない＝［配置］で確定）。
   * @returns {{ok: boolean, toast: string|null}} 無視は {ok:false, toast:null}
   */
  pickPlacementCenterLine(id) {
    const g = this.placementRoof?.gridLines?.find(l => l.id === id);
    if (!this.placementInput || !g || !g.exterior) return { ok: false, toast: null };
    const first = this.placementCenterLine;
    if (!first || g.centerLineType === first.centerLineType) {
      this.setPlacementCenterLine(id);
      return { ok: true, toast: null };
    }
    if (ORTHOGONAL_AXIS[first.centerLineType] !== g.centerLineType) return { ok: false, toast: null }; // 放射など直交する軸が無い
    // B 自身のタップは［位置の解除］と同じ（離れも消し、配置済みなら沿い座標を据え置いて再配置）。離れだけ残すと partial で確定できなくなるため
    if (id === this.placementInput.along?.centerLineId) return this.clearPlacementAlong();
    this.setPlacementAlongCenterLine(id);
    return this._replaceIfPlaced();
  }

  /**
   * 入力から配置を解いて site.placement に保存する（undo あり）。
   * 前回の変換（R6 の沿い座標）は今の表示の変換 placementView.siteTransform。
   * @returns {{ok: boolean, toast: string|null}}
   */
  commitPlacement() {
    const inp = this.placementInput;
    const view = this.placementView;
    const cl = this.placementCenterLine;
    const st = this.placementVertexStates;
    const raw = inp?.distanceValue ?? '';
    if (!inp || !view || !cl || st.v1 !== 'set' || st.v2 !== 'set' || raw.trim() === '') {
      return { ok: false, toast: TOAST_PLACEMENT_INCOMPLETE };
    }
    const distance = this._placementDistance();
    if (!Number.isFinite(distance) || distance <= 0) return { ok: false, toast: TOAST_PLACEMENT_DISTANCE_BAD };
    const { v1, v2, centerLineId, rotationFlipped, sideFlipped } = inp;
    const along = this._resolveAlong(cl);
    if (along.toast) return { ok: false, toast: along.toast };
    const solved = computeSitePlacement({
      v1, v2, centerLine: { centerLineType: cl.centerLineType, value: cl.value }, distance,
      rotationFlipped, sideFlipped, buildingCenter: view.buildingCenter, prevTransform: view.siteTransform,
      along: along.solve,
    });
    if (!solved) return { ok: false, toast: TOAST_PLACEMENT_UNSOLVABLE };
    applySitePlacementWithUndo(this.site, {
      ...solved,
      input: {
        v1: { x: v1.x, y: v1.y }, v2: { x: v2.x, y: v2.y }, centerLineId, distance, rotationFlipped, sideFlipped,
        along: along.saved,
      },
    });
    return { ok: true, toast: null };
  }

  // 位置（2 段目）の入力を解への引数と保存値に直す。none → 両方 null、拒否理由があれば toast（partial・失効・距離不正・1 段目と同じ軸）
  _resolveAlong(firstCl) {
    const none = { solve: null, saved: null, toast: null };
    const state = this.placementAlongState;
    if (state === 'none') return none;
    if (state === 'partial') return { ...none, toast: TOAST_PLACEMENT_ALONG_INCOMPLETE };
    const a = this.placementInput.along;
    const raw = this.placementRoof?.gridLines?.find(g => g.id === a.centerLineId) ?? null;
    if (raw && raw.centerLineType === firstCl.centerLineType) return { ...none, toast: TOAST_PLACEMENT_ALONG_AXIS };
    const line = this.placementAlongCenterLine;
    if (!line || this.placementAlongVertexStale) return { ...none, toast: TOAST_PLACEMENT_INCOMPLETE };
    const distance = this._placementAlongDistance();
    if (!Number.isFinite(distance) || distance <= 0) return { ...none, toast: TOAST_PLACEMENT_DISTANCE_BAD };
    return {
      solve: { vertex: a.vertex, centerLine: { centerLineType: line.centerLineType, value: line.value }, distance, sideFlipped: a.sideFlipped },
      saved: { vertex: a.vertex, centerLineId: a.centerLineId, distance, sideFlipped: a.sideFlipped },
      toast: null,
    };
  }

  /** 配置を解除する（null＝図芯合わせへ戻る。undo あり）。入力も空に戻す。 */
  clearPlacement() {
    applySitePlacementWithUndo(this.site, null);
    this.placementInput = this.showPlacement ? emptyPlacementInput() : null;
    this.placementDistanceFocused = false;
    this.placementAlongDistanceFocused = false;
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
      const exteriorIds = new Set(); // 外周の通り芯（全採用階の外壁ループ outer の軸。courtyard は含めない）
      const graphs = floors.map(f => f.graph).filter(Boolean);
      const regionFloors = withGraphsReadScope(graphs, () => floors.flatMap(f => {
        if (!f.graph) return []; // peek に失敗した階（readFailed は collectAdoptedFloors が立てている）
        try {
          const outerAxisIds = computeExteriorWallSegments(f.graph).filter(s => s.loopType === 'outer').map(s => s.axisCLId);
          const entry = { planeId: f.plane.id, regions: [...leanToPlanRegions(f.graph), ...topRoofPlanRegions(f.graph, project)] };
          outerAxisIds.forEach(id => exteriorIds.add(id));
          return [entry];
        } catch (err) {
          console.warn(`${SITE_LOG_TAG} 階「${f.plane.name ?? f.plane.id}」の屋根を解決できませんでした（その階は描かない）:`, err);
          regionFailed = true;
          return [];
        }
      }));
      roof = {
        floors: regionFloors,
        gridBounds: project?.structGraph ? gridBoundsMm(project.structGraph) : null,
        gridLines: markExteriorGridLines(gridLineSnapshot(project?.structGraph), exteriorIds),
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
    this._placementSyncDispose?.();
    this.clearSelection();
    this.cancelSiteDraw();
    this.placementInput = null;
    this.placementDistanceFocused = false;
    this.placementAlongDistanceFocused = false;
  }
}
