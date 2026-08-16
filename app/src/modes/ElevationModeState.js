import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { RoomFeature } from '@core';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { selectElevationRooms } from '../elevation/elevationFaces.js';
import { buildRoomBand } from '../elevation/elevationBand.js';
import { buildStairBand } from '../elevation/elevationStair.js';
import { collectGridCLs } from '../elevation/elevationPrimitives.js';
import { buildBandsSafely } from '../elevation/elevationRooms.js';
import {
  chooseElevationScale, screenMmToModelMm, layoutBands, clampScrollY,
  visibleBandPlacements, bandIdAtY, clampFaceOffset,
} from '../elevation/elevationLayout.js';
import {
  DEFAULT_FACE_GAP_MM, FACE_GAP_SCREEN_MM, DEFAULT_NAME_GAP_MM, NAME_GAP_BELOW_SCREEN_MM,
  DEFAULT_TRIANGLE_OFFSET_MM, TRIANGLE_OFFSET_SCREEN_MM,
  DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM, FACE_LABEL_AVOID_THRESHOLD_SCREEN_MM,
  DEFAULT_OPENING_TAG_ROW_MM, OPENING_TAG_ROW_SCREEN_MM,
  DEFAULT_DIM_ROW_GAP_MM, DIM_ROW_GAP_SCREEN_MM, DEFAULT_GRID_ROW_GAP_MM, GRID_ROW_GAP_SCREEN_MM,
  LEFT_MARGIN_SCREEN_MM, DEFAULT_WALL_LESS_END_EXTEND_MM, WALL_LESS_END_EXTEND_SCREEN_MM,
} from '../elevation/elevationStyle.js';
// DEFAULT_PX_PER_MMはviewport.js（appViewport.jsとは別。window依存を持たない純モジュール
// ——appViewport.jsのヘッダコメント参照）からのみ取得する。ElevationModeState.js自体は
// node:testから単体importできる状態を保つ（ElevationModeState.test.js参照）。
import { DEFAULT_PX_PER_MM as DEFAULT_SCREEN_PX_PER_MM } from '../viewport.js';

/**
 * 展開モード（室内展開図）の MobX 状態。設計意図は .claude/elevation-model.md 参照。
 * graph を一切変更しない（表示専用）。突入時に帯（部屋ごとの展開図）を一括構築し、
 * 以後はスクロール（縦・横ともクランプスクロール。循環はしない）のみ行う。
 */
export class ElevationModeState {
  bands      = []; // observable.ref — buildRoomBand/buildStairBand の結果配列
  scrollY    = 0;  // mm（帯の縦クランプスクロール量）
  faceScroll;      // observable.map roomId → mm（面の横スクロール量。既定は未設定=0扱い）
  viewSize   = null;
  loading    = true;
  // 材料照合エラーと同じ名前・同じトースト経路をそのまま流用する（App.jsxのloader.thenが
  // モードを問わず `if (s.materialError) setToast(...)` で汎用的に読むフィールド）。
  materialError = null;

  // screenPxPerMm: 校正値（viewport.pxPerMmX/Yの平均。実画面mm→px）。ElevationModeState.js自体は
  // DOM依存のappViewport.jsを静的importしない（node:test単体実行のため。ElevationModeState.test.js
  // 参照）ため、呼び出し側（App.jsx）が解決してここへ渡す。
  constructor(graph, project = null, viewSize = null, screenPxPerMm = DEFAULT_SCREEN_PX_PER_MM) {
    this.graph    = graph;
    this.project  = project;
    this.viewSize = viewSize;
    this.screenPxPerMm = screenPxPerMm;
    this._disposed = false;
    this.faceScroll = observable.map();
    makeObservable(this, {
      bands:      observable.ref,
      scrollY:    observable,
      viewSize:   observable.ref,
      loading:    observable,
      materialError: observable,
      scale:      computed,
      layout:     computed,
      setViewSize: action,
      scrollBy:    action,
    });
  }

  /**
   * 材データの動的ロード・直上階のpeek・帯の一括構築。
   * 1部屋の帯構築が失敗しても他の部屋は表示できるよう buildBandsSafely で隔離し、
   * 失敗があれば materialError（App.jsx が汎用的に読むトースト経路。FinishModeState と同名の
   * フィールドを流用）を設定する。init() 自体は決して reject しない（QA F4: 以前は
   * unhandled rejection でキャンバスが真っ白のまま何も通知されなかった）。
   *
   * 面間ギャップ・部屋名枠の上余白（どちらも実画面mm指定）はモデルmmへ換算する必要があるが、
   * 換算には倍率(scale)が要り、倍率は帯の高さ（面のモデル実寸のみ・ギャップ非依存）から決まる。
   * 循環参照を避けるため2パスで構築する: 1パス目は仮値(DEFAULT_FACE_GAP_MM/DEFAULT_NAME_GAP_MM)
   * で帯を組んで高さだけを確定に使い、倍率が決まってから2パス目で実値（screenMmToModelMm換算）
   * で本番の帯を組み直す（ユーザー指示の注意点。詳細は elevationLayout.js の screenMmToModelMm
   * 参照。QA G5: 部屋名枠の上余白も面間ギャップと同じ2パス方式に乗せる）。
   */
  async init() {
    try {
      const [matMod] = await Promise.all([
        import('../finish/materials/materialData.js'),
      ]);
      if (this._disposed) return { ok: true, error: null };

      const materialMap = new Map(matMod.MATERIALS.map(m => [m.code, m]));
      const upperGraph = await this._peekAboveGraph();
      if (this._disposed) return { ok: true, error: null };

      const gridCLs = collectGridCLs(this.graph);
      const rooms = selectElevationRooms(this.graph);
      const stairByRoomId = new Map(this.graph.stairs.map(s => [s.roomId, s]));
      const screenPxPerMm = this.screenPxPerMm;

      // paramsは全て2パス機構で換算する実画面mm値（+scale。オブジェクトにまとめて渡す
      // ——buildRoomBand/buildStairBandへそのまま展開できる形にしておく）。
      const buildOne = (room, params) => {
        const ctx = { project: this.project, materialMap, gridCLs, ...params };
        return room.feature === RoomFeature.STAIR
          ? buildStairBand(room, this.graph, upperGraph, { ...ctx, stair: stairByRoomId.get(room.id) ?? null })
          : buildRoomBand(room, this.graph, ctx);
      };

      // パス1: 倍率決定用（ギャップ・名前枠余白・三角オフセット・面ラベル退避閾値・建具タグ行/
      // ROW1/ROW1〜ROW2行間・壁のない端部の延長量は高さに影響しないため仮値でよい。scaleは
      // まだ未確定のためnull=壁2段書きの省略判定を行わない=項目4は常に描く扱いにする
      // ——省略の有無は帯の高さ(heightMm)にほぼ影響しないため、パス1をこの仮定にしても
      // 倍率決定に実害は無い）。
      const pass1 = buildBandsSafely(rooms, room => buildOne(room, {
        gapModelMm: DEFAULT_FACE_GAP_MM, nameGapModelMm: DEFAULT_NAME_GAP_MM,
        triangleOffsetModelMm: DEFAULT_TRIANGLE_OFFSET_MM,
        faceLabelAvoidThresholdModelMm: DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM,
        openingTagRowModelMm: DEFAULT_OPENING_TAG_ROW_MM, dimRowGapModelMm: DEFAULT_DIM_ROW_GAP_MM,
        gridRowGapModelMm: DEFAULT_GRID_ROW_GAP_MM,
        wallLessEndExtendModelMm: DEFAULT_WALL_LESS_END_EXTEND_MM, scale: null,
      }));
      const scale = chooseElevationScale(pass1.bands, this.viewSize ?? { width: 800, height: 600 });
      const gapModelMm            = screenMmToModelMm(FACE_GAP_SCREEN_MM, screenPxPerMm, scale);
      const nameGapModelMm        = screenMmToModelMm(NAME_GAP_BELOW_SCREEN_MM, screenPxPerMm, scale);
      const triangleOffsetModelMm = screenMmToModelMm(TRIANGLE_OFFSET_SCREEN_MM, screenPxPerMm, scale);
      const faceLabelAvoidThresholdModelMm =
        screenMmToModelMm(FACE_LABEL_AVOID_THRESHOLD_SCREEN_MM, screenPxPerMm, scale);
      // QA C1→D1/D2: 建具タグ行・ROW1・ROW1〜ROW2/ROW2〜通り芯丸行の行間はいずれもスクリーン
      // 固定サイズの要素（タグ・通り芯丸・面ラベル）を載せる注記帯の行位置のため、他の実画面mm値
      // と同じ2パス方式で換算する。QA D2: 以前はROW1をタグ行の2倍として式で導出していたが、
      // ユーザーが調整済みの見た目を機械的な導出が踏み外したため、3つとも独立したスクリーンmm
      // 定数（elevationStyle.js参照）から換算する形に改めた。
      const openingTagRowModelMm = screenMmToModelMm(OPENING_TAG_ROW_SCREEN_MM, screenPxPerMm, scale);
      const dimRowGapModelMm     = screenMmToModelMm(DIM_ROW_GAP_SCREEN_MM, screenPxPerMm, scale);
      const gridRowGapModelMm    = screenMmToModelMm(GRID_ROW_GAP_SCREEN_MM, screenPxPerMm, scale);
      // 項目1: 壁のない端部の延長量も他の実画面mm値と同じ2パス方式で換算する。
      const wallLessEndExtendModelMm = screenMmToModelMm(WALL_LESS_END_EXTEND_SCREEN_MM, screenPxPerMm, scale);

      // パス2: 確定した倍率でギャップ・名前枠余白・三角オフセット・面ラベル退避閾値・建具タグ行/
      // ROW1/ROW1〜ROW2行間・壁のない端部の延長量を実画面mmへ正しく換算し、scale自体もそのまま
      // 渡して（項目4の壁2段書き省略判定に使う）本番の帯を組み直す。
      const { bands, failedRoomNames } = buildBandsSafely(
        rooms,
        room => buildOne(room, {
          gapModelMm, nameGapModelMm, triangleOffsetModelMm, faceLabelAvoidThresholdModelMm,
          openingTagRowModelMm, dimRowGapModelMm, gridRowGapModelMm, wallLessEndExtendModelMm, scale,
        }),
        (err, room) => console.error(`[elevation] 部屋「${room.name}」の帯構築に失敗:`, err),
      );

      const error = failedRoomNames.length > 0
        ? `展開図の構築に失敗した部屋があります: ${failedRoomNames.join('、')}`
        : null;

      runInAction(() => {
        this.bands        = bands;
        this.loading      = false;
        this.materialError = error;
      });
      return { ok: error === null, error };
    } catch (err) {
      console.error('[elevation] モードの初期化に失敗:', err);
      const message = '展開モードの初期化に失敗しました';
      runInAction(() => {
        this.bands        = [];
        this.loading      = false;
        this.materialError = message;
      });
      return { ok: false, error: message };
    }
  }

  /** activePlaneの直上の採用フロアをpeekして返す（無ければnull）。FinishModeState._loadUpperVoidsと同形。 */
  async _peekAboveGraph() {
    const project = this.project;
    const planes = project?.planes ?? [];
    const active = project?.activePlane;
    const idx = planes.findIndex(p => p.id === active?.id);
    const above = idx >= 0 && idx + 1 < planes.length ? planes[idx + 1] : null;
    if (!above) return null;
    const temp = await floorSwapManager.peek(above, project.structGraph);
    return this._disposed ? null : temp;
  }

  /** 画面高さのみで固定倍率(px/mm)を決める（ズームなし）。 */
  get scale() {
    return chooseElevationScale(this.bands, this.viewSize ?? { width: 800, height: 600 });
  }

  /** 帯の縦レイアウト（contentHeightMm込み）。 */
  get layout() {
    return layoutBands(this.bands);
  }

  /** 現在のviewSize/scaleにおける縦スクロールの有効範囲でクランプした値（循環しない）。 */
  get clampedScrollY() {
    const viewHeightMm = (this.viewSize?.height ?? 600) / this.scale;
    return clampScrollY(this.scrollY, this.layout, viewHeightMm);
  }

  setViewSize(size) { this.viewSize = size; }

  /** 左三角のさらに左に確保する画面余白（モデルmm。項目1）。scale/screenPxPerMm連動の2パス換算。 */
  get leftMarginModelMm() {
    return screenMmToModelMm(LEFT_MARGIN_SCREEN_MM, this.screenPxPerMm, this.scale);
  }

  /**
   * 面（帯roomId）の水平スクロール量(mm)を、有効範囲へクランプした状態で返す。
   * 既定値（未設定時）は band.leftAnchorX（左の留め三角の位置。項目10）から leftMarginModelMm
   * （項目1: 左三角が画面左端ぴったりに来ないよう実画面LEFT_MARGIN_SCREEN_MMぶん手前を既定に
   * する）を引いた位置を clampFaceOffsetへ渡すため、「画面に収まるなら中央寄せ・収まらないなら
   * 左三角の位置を左マージンへ」という初期値の規則が初回描画から成立する——leftAnchorXは全帯が
   * 同じ規則（天井高寸法線の外側へ実画面10mm）で決まるため、この既定値を使う限り帯を切り替えても
   * 左端の見え方が揃う（band.leftAnchorXが無い＝面0件の帯はband.bounds.minXへフォールバック）。
   */
  faceOffsetFor(band) {
    const viewWidthMm = (this.viewSize?.width ?? 800) / this.scale;
    const marginModelMm = this.leftMarginModelMm;
    const defaultOffset = (band.leftAnchorX ?? band.bounds.minX) - marginModelMm;
    return clampFaceOffset(this.faceScroll.get(band.roomId) ?? defaultOffset, band, viewWidthMm, marginModelMm);
  }

  /**
   * ドラッグ量(mm。screen px→mmの換算は呼び出し側=usePointerInteraction.jsがmode.scaleで行う)を
   * 反映する。縦=帯のクランプスクロール、横=roomId指定時のみ、その帯のfaceScrollをクランプ
   * しながら更新する——縦・横とも**書き込み時にクランプする**（QA G1: 読み出し側=clampedScrollY
   * だけでクランプすると、端を越えて過剰ドラッグした分がscrollYに見えないスラックとして蓄積し、
   * 逆方向ドラッグがそのスラック分だけ効かないデッドゾーンになる。横のfaceScrollは元から
   * 書き込み時クランプだったため縦だけ揃える）。
   * ドラッグ方向は「コンテンツが指に追従する」向き（下/右へドラッグ→内容がその方向へスライドし、
   * 見えていなかった上/左側が現れる）。
   */
  scrollBy(dxMm, dyMm, roomId) {
    if (dyMm) {
      const viewHeightMm = (this.viewSize?.height ?? 600) / this.scale;
      this.scrollY = clampScrollY(this.scrollY - dyMm, this.layout, viewHeightMm);
    }
    if (dxMm && roomId) {
      const band = this.bands.find(b => b.roomId === roomId);
      if (band) {
        const viewWidthMm = (this.viewSize?.width ?? 800) / this.scale;
        const cur = this.faceScroll.get(roomId) ?? 0;
        this.faceScroll.set(roomId, clampFaceOffset(cur - dxMm, band, viewWidthMm, this.leftMarginModelMm));
      }
    }
  }

  /** 画面y座標(px)に対応する帯のroomId（無ければnull）。usePointerInteraction.jsのpointerDown判定用。 */
  bandAtScreenY(py) {
    const mmY = py / this.scale;
    return bandIdAtY(this.layout, this.clampedScrollY, mmY);
  }

  /** 現在の可視帯配置（ElevationLayer.jsxが描画に使う）。 */
  visibleBands(viewHeightMm) {
    return visibleBandPlacements(this.layout, this.clampedScrollY, viewHeightMm);
  }

  dispose() {
    this._disposed = true;
  }
}
