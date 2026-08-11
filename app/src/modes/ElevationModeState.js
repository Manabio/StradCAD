import { makeObservable, observable, action, computed, runInAction } from 'mobx';
import { RoomFeature } from '@core';
import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { selectElevationRooms } from '../elevation/elevationFaces.js';
import { buildRoomBand } from '../elevation/elevationBand.js';
import { buildStairBand } from '../elevation/elevationStair.js';
import { collectGridCLs } from '../elevation/elevationPrimitives.js';
import { buildBandsSafely } from '../elevation/elevationRooms.js';
import {
  chooseElevationScale, layoutBands, wrapOffset, visibleBandPlacements, bandIdAtY, clampFaceOffset,
} from '../elevation/elevationLayout.js';

/**
 * 展開モード（室内展開図）の MobX 状態。設計意図は .claude/elevation-model.md 参照。
 * graph を一切変更しない（表示専用）。突入時に帯（部屋ごとの展開図）を一括構築し、
 * 以後はスクロール（縦=帯の循環スライド、横=面の帯ごと独立クランプスライド）のみ行う。
 */
export class ElevationModeState {
  bands      = []; // observable.ref — buildRoomBand/buildStairBand の結果配列
  scrollY    = 0;  // mm（帯の縦循環スクロール量）
  faceScroll;      // observable.map roomId → mm（面の横スクロール量。既定は未設定=0扱い）
  viewSize   = null;
  loading    = true;
  // 材料照合エラーと同じ名前・同じトースト経路をそのまま流用する（App.jsxのloader.thenが
  // モードを問わず `if (s.materialError) setToast(...)` で汎用的に読むフィールド）。
  materialError = null;

  constructor(graph, project = null, viewSize = null) {
    this.graph    = graph;
    this.project  = project;
    this.viewSize = viewSize;
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

      const { bands, failedRoomNames } = buildBandsSafely(rooms, (room) => {
        const ctx = { project: this.project, materialMap, gridCLs };
        if (room.feature === RoomFeature.STAIR) {
          return buildStairBand(room, this.graph, upperGraph, { ...ctx, stair: stairByRoomId.get(room.id) ?? null });
        }
        return buildRoomBand(room, this.graph, ctx);
      }, (err, room) => console.error(`[elevation] 部屋「${room.name}」の帯構築に失敗:`, err));

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

  /** 帯の縦レイアウト（周期totalMm込み）。 */
  get layout() {
    return layoutBands(this.bands);
  }

  setViewSize(size) { this.viewSize = size; }

  /**
   * 面（帯roomId）の水平スクロール量(mm)を、有効範囲へクランプした状態で返す。
   * 既定値（未設定時）は band.bounds.minX（帯の実描画範囲の左端＝天井高寸法を含む）を
   * clampFaceOffsetへ渡すため、「画面に収まるなら中央寄せ・収まらないなら帯の左端
   * （天井高寸法込み）を左マージンへ」という初期値の規則が初回描画から成立する。
   */
  faceOffsetFor(band) {
    const viewWidthMm = (this.viewSize?.width ?? 800) / this.scale;
    return clampFaceOffset(this.faceScroll.get(band.roomId) ?? band.bounds.minX, band, viewWidthMm);
  }

  /**
   * ドラッグ量(mm。screen px→mmの換算は呼び出し側=usePointerInteraction.jsがmode.scaleで行う)を
   * 反映する。縦=帯の循環スライド(scrollY、wrapは描画側のwrapOffsetに委ねるためここでは加算するだけ)、
   * 横=roomId指定時のみ、その帯のfaceScrollをクランプしながら更新する。
   * ドラッグ方向は「コンテンツが指に追従する」向き（下/右へドラッグ→内容がその方向へスライドし、
   * 見えていなかった上/左側が現れる）。
   */
  scrollBy(dxMm, dyMm, roomId) {
    if (dyMm) this.scrollY -= dyMm;
    if (dxMm && roomId) {
      const band = this.bands.find(b => b.roomId === roomId);
      if (band) {
        const viewWidthMm = (this.viewSize?.width ?? 800) / this.scale;
        const cur = this.faceScroll.get(roomId) ?? 0;
        this.faceScroll.set(roomId, clampFaceOffset(cur - dxMm, band, viewWidthMm));
      }
    }
  }

  /** 画面y座標(px)に対応する帯のroomId（無ければnull）。usePointerInteraction.jsのpointerDown判定用。 */
  bandAtScreenY(py) {
    const mmY = py / this.scale;
    return bandIdAtY(this.layout, wrapOffset(this.scrollY, this.layout.totalMm), mmY);
  }

  /** 現在の可視帯配置（ElevationLayer.jsxが描画に使う）。 */
  visibleBands(viewHeightMm) {
    return visibleBandPlacements(this.layout, this.scrollY, viewHeightMm);
  }

  dispose() {
    this._disposed = true;
  }
}
