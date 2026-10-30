import { makeObservable, observable, action, computed, runInAction, reaction } from 'mobx';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { withGraphReadScope } from '../graphReadScope.js';
import { screenMmToModelMm, clampScrollY } from '../elevation/elevationLayout.js';
import { FACADE_EMPTY_MESSAGE, FACADE_INIT_ERROR_MESSAGE, FacadeSkipReason } from '../core/constants.js';
import { CANVAS_BG_COLOR, faceGapLimitMm } from '../elevation/elevationStyle.js';
import { buildFacadeInputs } from '../facade/facadeInputs.js';
import { leanToPlanRegions, topRoofPlanRegions } from '../structural/roofFramingRegions.js';
import { facadeExtentsMm, buildFacadeModel } from '../facade/facadeFigure.js';
import { chooseFacadeScale, layoutFacadeFaces } from '../facade/facadeLayout.js';
import {
  FACADE_GAP_SCREEN_MM, FACADE_GL_EXTEND_SCREEN_MM, FACADE_GL_MARK_SCREEN_MM, FACADE_TITLE_GAP_SCREEN_MM,
} from '../facade/facadeStyle.js';
// DEFAULT_PX_PER_MM は DOM 依存の無い viewport.js から取る（ElevationModeState.js と同じ。node:test から単体 import できる状態を保つ）。
import { DEFAULT_PX_PER_MM as DEFAULT_SCREEN_PX_PER_MM, resolveLineWeightsPx } from '../viewport.js';

// 方位は常に未設定（null）で渡す（リード裁定 S1。北の角度の入力は今後）。
const NORTH_ANGLE_DEG = null;
// viewSize が無いとき（突入直後の単体テスト等）の既定。ElevationModeState と同じ値。
const DEFAULT_VIEW_SIZE = Object.freeze({ width: 800, height: 600 });

/**
 * 立面モード（外壁立面図。東・南・西・北の4面を統一倍率で縦に並べる）の MobX 状態。
 * graph を一切変更しない（表示専用）。突入時に全採用階を読んで入力を組み、以後は縦スクロールだけ。
 * 立面中の自階の変更（undo/redo）には追従しない＝突入時のスナップショット（展開と同じ割り切り）。
 *
 * 倍率は幾何の外形（facadeExtentsMm）と viewSize だけで決まり、注記（GL の延長・▽・見出し）の実画面 mm は
 * 倍率が決まってからモデル mm に直す（展開の2パスと違い、外形が注記に依存しないので1パスで足りる）。
 * 倍率は viewSize で変わるので、倍率の変化を reaction で見て model を作り直す（computed にしないのは、
 * scrollBy・clampedScrollY がイベントハンドラ＝反応の外から layout→faces を読むため。computed だと
 * ホイールのたびに model を組み直してしまう）。
 */
export class FacadeModeState {
  faces      = [];   // observable.ref — buildFacadeModel の結果（東南西北。外壁が無ければ []）
  scrollY    = 0;    // mm（縦のクランプスクロール量）
  viewSize   = null;
  loading    = true;
  // 失敗通知は App.jsx の loader.then がモードを問わず読む同名フィールド（トースト経路）を流用する。
  materialError = null;
  _extents   = null; // observable.ref — facadeExtentsMm の結果（倍率の入力）

  // screenPxPerMm: 校正値（viewport.pxPerMmX/Yの平均）。呼び出し側（App.jsx）が解決して渡す（展開と同じ）。
  constructor(graph, project = null, viewSize = null, screenPxPerMm = DEFAULT_SCREEN_PX_PER_MM) {
    this.graph    = graph;
    this.project  = project;
    this.viewSize = viewSize;
    this.screenPxPerMm = screenPxPerMm;
    this._disposed = false;
    this._inputs = null;
    makeObservable(this, {
      faces:         observable.ref,
      scrollY:       observable,
      viewSize:      observable.ref,
      loading:       observable,
      materialError: observable,
      _extents:      observable.ref,
      scale:         computed,
      layout:        computed,
      clampedScrollY: computed,
      setViewSize:   action,
      scrollBy:      action,
    });
  }

  /**
   * 全採用階（project.planes＝昇順）の graph を集めて入力を組み、外形→倍率→注記の換算→model を作る。
   * 自階は project.activeGraph、他階は floorSwapManager.peek（全階を並行）。peek が例外の階は graph null で
   * 渡し（buildFacadeInputs が飛ばす）、materialError に FACADE_INIT_ERROR_MESSAGE を立てて残りの階で描く
   * （外壁の取得で例外の階＝skipped の ERROR も同じ）。
   * 外壁が1本も無ければ FACADE_EMPTY_MESSAGE。init() 自体は決して reject しない。
   */
  async init() {
    try {
      const { floors, readFailed } = await this._collectFloors();
      if (this._disposed) return { ok: true, error: null };

      const graphs = floors.map(f => f.graph).filter(Boolean);
      const inputs = withGraphsReadScope(graphs, () => buildFacadeInputs(floors, this.project,
        { roofRegionsOf: facadeRoofRegionsResolver(this.project) }));
      const extents = facadeExtentsMm(inputs, { northAngleDeg: NORTH_ANGLE_DEG });
      this._inputs = inputs;
      runInAction(() => { this._extents = extents; });
      const faces = this._buildFaces();
      // 読めなかった階・外壁の取得で例外の階があれば（残りの階は描いたうえで）初期化失敗を知らせる。
      const partFailed = readFailed || inputs.skipped.some(s => s.reason === FacadeSkipReason.ERROR);
      const error = partFailed ? FACADE_INIT_ERROR_MESSAGE
        : faces.length === 0 ? FACADE_EMPTY_MESSAGE : null;
      runInAction(() => {
        this.faces = faces;
        this.loading = false;
        this.materialError = error;
      });
      // 倍率（viewSize で変わる）が変わったら注記の換算をやり直して model を作り直す。
      this._scaleReactionDispose = reaction(
        () => this.scale,
        () => this._rebuildFaces(),
      );
      return { ok: error === null, error };
    } catch (err) {
      console.error('[facade] モードの初期化に失敗:', err);
      runInAction(() => {
        this.faces = [];
        this.loading = false;
        this.materialError = FACADE_INIT_ERROR_MESSAGE;
      });
      return { ok: false, error: FACADE_INIT_ERROR_MESSAGE };
    }
  }

  /**
   * 採用階を昇順に集める（自階は live、他階は peek を並行）。peek の失敗は階ごとに握って graph null にする。
   * 自階が検討案（planes に無い）なら、同じ高さの採用階は peek で読む（立面は採用階の建物を描く）。
   * @returns {Promise<{floors: Array<{plane:object, graph:object|null}>, readFailed:boolean}>}
   */
  async _collectFloors() {
    const project = this.project;
    const planes = project?.planes ?? [];
    let readFailed = false;
    const floors = await Promise.all(planes.map(async plane => {
      if (plane.id === project.activePlaneId) return { plane, graph: project.activeGraph ?? null };
      try {
        return { plane, graph: (await floorSwapManager.peek(plane, project.structGraph)) ?? null };
      } catch (err) {
        console.warn(`[facade] 階「${plane.name ?? plane.id}」の読み込みに失敗（その階は描かない）:`, err);
        readFailed = true;
        return { plane, graph: null };
      }
    }));
    return { floors, readFailed };
  }

  /** 注記の実画面 mm を現在の倍率でモデル mm に直し、model を組む（同期）。外形が未確定なら []。 */
  _buildFaces() {
    if (!this._inputs) return [];
    const scale = this.scale;
    const toModel = screenMm => screenMmToModelMm(screenMm, this.screenPxPerMm, scale);
    return buildFacadeModel(this._inputs, {
      northAngleDeg: NORTH_ANGLE_DEG,
      annotationMm: {
        glExtendMm: toModel(FACADE_GL_EXTEND_SCREEN_MM),
        glMarkMm:   toModel(FACADE_GL_MARK_SCREEN_MM),
        titleGapMm: toModel(FACADE_TITLE_GAP_SCREEN_MM),
      },
      bgColor: CANVAS_BG_COLOR, // ▽の塗り＝キャンバスの地（展開図の通り芯丸と同じ）
      // 建具の姿図の見付1px保証（展開図 elevationFigure.js appendOpenings と同じ値。描画側の線幅＝校正値から）
      minFaceMm: faceGapLimitMm(scale, resolveLineWeightsPx(this.screenPxPerMm), 'thin', 'medium'),
    });
  }

  _rebuildFaces() {
    if (this._disposed) return;
    try {
      const faces = this._buildFaces();
      runInAction(() => { this.faces = faces; });
    } catch (err) {
      console.error('[facade] 立面の再構築に失敗:', err);
      runInAction(() => { this.faces = []; this.materialError = FACADE_INIT_ERROR_MESSAGE; });
    }
  }

  /** 4面の外形と画面の大きさで決める固定倍率（px/mm。ズームなし）。外形が未確定なら外形0で求める。 */
  get scale() {
    const ext = this._extents;
    const size = this.viewSize ?? DEFAULT_VIEW_SIZE;
    return chooseFacadeScale({
      maxWidthMm: ext?.maxWidthMm ?? 0, maxHeightMm: ext?.maxHeightMm ?? 0,
      viewWidthPx: size.width, viewHeightPx: size.height, screenPxPerMm: this.screenPxPerMm,
    });
  }

  /** 面の縦の配置（各面の top・横中央寄せ・全高）。面の間隔は実画面 mm をモデル mm に直して渡す。 */
  get layout() {
    const scale = this.scale;
    return layoutFacadeFaces(this.faces, {
      scale,
      viewWidthPx: (this.viewSize ?? DEFAULT_VIEW_SIZE).width,
      gapMm: screenMmToModelMm(FACADE_GAP_SCREEN_MM, this.screenPxPerMm, scale),
    });
  }

  /** 現在の viewSize/scale における縦スクロールの有効範囲でクランプした値（循環しない）。 */
  get clampedScrollY() {
    const viewHeightMm = (this.viewSize ?? DEFAULT_VIEW_SIZE).height / this.scale;
    return clampScrollY(this.scrollY, this.layout, viewHeightMm);
  }

  setViewSize(size) { this.viewSize = size; }

  /**
   * 縦のドラッグ量（mm。px→mm は呼び出し側＝usePointerInteraction.js が mode.scale で割る）を反映する。
   * 書き込み時にクランプする（展開の QA G1 と同じ。端を越えた分がデッドゾーンとして溜まらない）。
   * 向きは「内容が指に追従する」（下へドラッグ→内容が下へ）。
   */
  scrollBy(dyMm) {
    if (!dyMm) return;
    const viewHeightMm = (this.viewSize ?? DEFAULT_VIEW_SIZE).height / this.scale;
    this.scrollY = clampScrollY(this.scrollY - dyMm, this.layout, viewHeightMm);
  }

  dispose() {
    this._scaleReactionDispose?.();
    this._disposed = true;
  }
}

/**
 * 立面の屋根の region の解決（buildFacadeInputs の roofRegionsOf）。下屋＝その階の leanToPlanRegions、主屋根・屋根区画＝
 * topRoofPlanRegions（最上階でなければ []。陸屋根は出ない）。roofFramingRegions.js は storage を推移的に引くため facade/ からは
 * 引かず、ここで解決して渡す（展開の帯ビルダーと同じ流儀）。probe（scripts/probe/dumpFacade.mjs）も同じ関数を使う。
 */
export function facadeRoofRegionsResolver(project) {
  return graph => ({ leanTo: leanToPlanRegions(graph), top: topRoofPlanRegions(graph, project) });
}

/** 複数の graph をまとめて読み取りスコープに入れる（graphReadScope.js。ElevationModeState._buildBands の入れ子と同じ）。 */
function withGraphsReadScope(graphs, fn) {
  return graphs.reduceRight((inner, g) => () => withGraphReadScope(g, inner), fn)();
}
