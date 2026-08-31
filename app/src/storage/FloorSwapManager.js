/**
 * FloorSwapManager
 *
 * フロア単位のスワップアウト / スワップインを管理する。
 * 通り芯（全階共通、project.structGraph）+ 構造情報（建物全体既定値、project.structuralInfo）の永続化も担う。
 *
 * ── フロア操作 ──
 *   activate(plane, graph)           — IDB から復元 + auto-save 開始
 *   deactivate(plane, graph)         — IDB に保存 + clearFloorData()
 *   peek(plane, structGraph)         — IDB から読み取り専用の一時グラフへ復元（非アクティブ化）
 *   disposeAll()                     — 全 auto-save 停止
 *
 * ── 編集可能peek ──
 *   startEditablePeek(plane, graph)  — デバウンス自動保存を開始
 *   flushEditablePeek()              — autorunは止めず、保留中のデバウンス保存だけを確定する
 *   stopEditablePeek()               — autorunを止め、保留中の保存を確定してから終了する
 *
 * ── 通り芯・構造情報操作 ──
 *   setupStructGraph(structGraph, structuralInfo, projectId, ledger)
 *                                    — IDB から通り芯・構造情報・部材グループ台帳を復元 + auto-save 開始
 *   disposeStructGraph()             — 通り芯・構造情報 auto-save 停止
 *
 * ── 敷地（project.site）dirty追跡 ──
 *   startSiteDirtyTracking(site)     — 敷地の変更を markDirty() する autorun を開始（保存自体は行わない）
 *   disposeSiteDirtyTracking()       — 上記 autorun を停止
 */

import { autorun, runInAction } from 'mobx';
import { PlanGraph } from '@core';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import { closeConvexCorners } from '../finish/wallGeneration.js';
import { saveFloor, loadFloor, saveProject, loadProject } from './db.js';
import { markDirty } from '../dirtyState.js';

export class FloorSwapManager {
  _cleanups    = new Map(); // planeId → cleanup fn
  _structCleanup = null;   // 通り芯 auto-save cleanup fn
  _peekCleanup = null;     // 編集可能peek（下階）の auto-save cleanup fn（disposeまで行う）
  _peekFlush   = null;     // 編集可能peek（下階）の保留中デバウンス保存だけを確定するfn（disposeしない）
  _siteCleanup = null;     // 敷地（project.site）dirty追跡 cleanup fn

  // ----------------------------------------------------------------
  // フロア操作
  // ----------------------------------------------------------------

  /**
   * 読み込んだグラフの「導出済み幾何」を復元する（IDBから読んだ直後に必ず通す）。
   *
   * 出隅の取り合い（closeConvexCorners）は仕上げモード脱出時に壁の端点へ**焼き込む**導出結果
   * のため、そのロジックより古い保存データには反映されていない——そして壁は仕上げモードを
   * 出直すまで再生成されないので、平面も展開図も欠けたまま何度読み直しても直らなかった
   * （ユーザー実機指摘2026-08「21」の2階 X2×Y2+3500）。読み込み経路（activate/peek）で
   * 一度閉じ直すことで、データの世代に関係なく常に閉じた状態から始まる。
   * ここは冪等（角のマスが空いているときだけ伸ばす）なので既に閉じたデータには何もしない。
   * auto-save 開始**前**に呼ぶ: 開いただけの修復で dirty にして未保存警告を出さないため
   * （壁の端点は _startAutoSave の autorun の観測対象でもないが、順序で意図を示す）。
   */
  _healDerivedGeometry(graph) {
    runInAction(() => closeConvexCorners([...graph.walls]));
  }

  async activate(plane, graph) {
    this._stopAutoSave(plane.id);
    const bytes = await loadFloor(plane.id);
    if (bytes) {
      restoreGraph(graph, bytes);
      this._healDerivedGeometry(graph);
    }
    this._startAutoSave(plane, graph);
  }

  async deactivate(plane, graph) {
    this._stopAutoSave(plane.id);
    await saveFloor(plane.id, serializeGraph(graph));
    graph.clearFloorData();
  }

  /**
   * 非アクティブなフロアを「アクティブ化せず」読み取り専用で覗く。
   * 既存のスワップ状態・auto-save には一切影響しない、使い捨ての一時グラフを返す。
   * 通り芯移動の随伴範囲探査（他フロアの随伴CL・壁の検出）専用。
   */
  async peek(plane, structGraph) {
    const bytes = await loadFloor(plane.id);
    const tempGraph = new PlanGraph(plane);
    tempGraph._structGraph = structGraph;
    if (bytes) {
      restoreGraph(tempGraph, bytes);
      // アクティブ階と同じ見た目にする（展開図・図面合成は他階を peek で読むため、
      // ここを揃えないと平面だけ角が閉じて展開図は欠けたまま、という食い違いが出る）
      this._healDerivedGeometry(tempGraph);
    }
    return tempGraph;
  }

  disposeAll() {
    this.stopEditablePeek();
    for (const cleanup of this._cleanups.values()) cleanup();
    this._cleanups.clear();
    this.disposeStructGraph();
    this.disposeSiteDirtyTracking();
  }

  // ----------------------------------------------------------------
  // 編集可能peek（構造モードの伏図に描く「1つ下の階」を、その伏図の構造リストから
  // 編集・永続化するためのチャネル。アクティブ階ではないため通常のauto-saveに乗らない）。
  // ----------------------------------------------------------------

  /**
   * peek で得た下階グラフを「編集可能」にし、変更を下階のIDBへデバウンス保存する。
   * 表示用autofill（柱の差分補完・採番）を済ませてから呼ぶこと——初回autorunをベースラインに
   * するため、表示生成分は保存されず、以降のユーザー編集のみが保存される。
   */
  startEditablePeek(plane, graph) {
    void this.stopEditablePeek();
    let initialized = false;
    let timer = null;
    const flushPending = () => {
      if (!timer) return Promise.resolve();
      clearTimeout(timer);
      timer = null;
      return saveFloor(plane.id, serializeGraph(graph));
    };
    const dispose = autorun(() => {
      void serializeGraph(graph); // シリアライズ対象の全observableを依存に取る
      if (!initialized) { initialized = true; return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; saveFloor(plane.id, serializeGraph(graph)); }, 400);
    });
    this._peekFlush = flushPending;
    this._peekCleanup = () => {
      dispose();
      return flushPending(); // 保留中の編集を確定
    };
  }

  /**
   * autorun は止めずに、保留中のデバウンス保存だけを確定する（Promise を返す）。
   * 明示保存（saveToIDB）の直前に呼ぶ——デバウンス分（最大400ms）の下階編集が
   * floorsへ未反映のまま保存documentへコミットされる（取りこぼす）のを防ぐ。
   * 保留中の保存が無ければ何もせず即座に解決する。
   */
  flushEditablePeek() {
    return this._peekFlush ? this._peekFlush() : Promise.resolve();
  }

  /** 編集可能peekを停止し、保留中の編集の確定保存まで待てる Promise を返す。
   *  呼び出し側が直後に同じ階を loadFloor/peek する場合は必ず await すること（書込み前に読む競合の防止）。 */
  stopEditablePeek() {
    const flushed = this._peekCleanup?.() ?? Promise.resolve();
    this._peekCleanup = null;
    this._peekFlush = null;
    return flushed;
  }

  // ----------------------------------------------------------------
  // 通り芯（全階共通）操作
  // ----------------------------------------------------------------

  async setupStructGraph(structGraph, structuralInfo, projectId, ledger) {
    this.disposeStructGraph();
    const bytes = await loadProject(projectId);
    if (bytes) restoreStructCLs(structGraph, structuralInfo, bytes, ledger);
    this._startStructAutoSave(structGraph, structuralInfo, ledger);
  }

  disposeStructGraph() {
    this._structCleanup?.();
    this._structCleanup = null;
  }

  // ----------------------------------------------------------------
  // Private: フロア auto-save
  // ----------------------------------------------------------------

  _startAutoSave(plane, graph) {
    let initialized = false;

    const dispose = autorun(() => {
      void graph.shapeMap.size;
      void graph.intersectionMap.size;
      void graph.roomMap.size;
      void graph.stairMap.size;
      // 構造部材の生成・削除も dirty 対象にする（構造モードの自動補完・部材編集だけを行った
      // セッションで beforeunload 警告が出ず部材が失われるのを防ぐ。粒度は shapeMap と同じ size のみ）。
      void graph.columnMap.size;
      void graph.beamMap.size;
      void graph.wallMap.size;
      void graph.slabMap.size;
      void graph.footingMap.size;
      void graph.sleeveMap.size;
      void graph.columnAxisOffsets.size;
      void graph.clEccentricities.size;
      void graph.kneeDropWalls.size;
      for (const cl of graph.centerLines) {
        void cl._value;
        void cl.refOffset;
      }

      if (!initialized) { initialized = true; return; }

      markDirty();
    });

    this._cleanups.set(plane.id, () => dispose());
  }

  _stopAutoSave(planeId) {
    this._cleanups.get(planeId)?.();
    this._cleanups.delete(planeId);
  }

  // ----------------------------------------------------------------
  // Private: 通り芯 dirty 追跡
  // ----------------------------------------------------------------

  _startStructAutoSave(structGraph, structuralInfo, ledger) {
    let initialized = false;

    const dispose = autorun(() => {
      void structGraph.shapeMap.size;
      for (const cl of structGraph.centerLines) {
        void cl._value;
        void cl.refOffset;
      }
      // 建物全体の構造情報（project.structuralInfo）の変更も dirty 対象にする
      void structuralInfo.mainStructure;
      void structuralInfo.otherStructures.length;
      void structuralInfo.foundationType;
      void structuralInfo.designStrength;
      void structuralInfo.concreteType;
      void structuralInfo.mainBar;
      void structuralInfo.hoopBar;
      void structuralInfo.snowArea;
      void structuralInfo.basicWindSpeed;
      void structuralInfo.surfaceRoughness;
      void structuralInfo.seismicZoneFactor;
      // 部材グループ台帳（project.memberGroupLedger）の変更も dirty 対象にする
      void ledger?.size;

      if (!initialized) { initialized = true; return; }

      markDirty();
    });

    this._structCleanup = () => dispose();
  }

  // ----------------------------------------------------------------
  // 敷地（project.site）dirty追跡
  //
  // 敷地は project.site として独立した永続化チャネル（graphSnapshot.js serializeSite）を持つが、
  // 書き込みは saveToIDB（明示保存）でのみ行う。ここでは「敷地編集だけのセッションで
  // beforeunload 警告が出ず無警告消失する」のを防ぐため、_startStructAutoSave と同じ
  // initialized ガード方式で markDirty() のみ行う（構造部材の前例と同じ）。
  // ----------------------------------------------------------------

  startSiteDirtyTracking(site) {
    this.disposeSiteDirtyTracking();
    let initialized = false;

    const dispose = autorun(() => {
      void site.pointMap.size; void site.lineMap.size; void site.triangleMap.size;
      void site.lineOrder.length; void site.history.length;
      for (const p of site.pointMap.values())    { void p.x; void p.y; }
      for (const l of site.lineMap.values())     { void l.lineKind; }
      for (const t of site.triangleMap.values()) { void t.lineKind; }

      if (!initialized) { initialized = true; return; }

      markDirty();
    });

    this._siteCleanup = () => dispose();
  }

  disposeSiteDirtyTracking() {
    this._siteCleanup?.();
    this._siteCleanup = null;
  }

  // ----------------------------------------------------------------
  // 明示的保存
  // ----------------------------------------------------------------

  async saveNow(plane, graph, structGraph, structuralInfo, projectId, ledger) {
    await saveFloor(plane.id, serializeGraph(graph));
    await saveProject(projectId, serializeStructCLs(structGraph, structuralInfo, ledger));
  }
}

export const floorSwapManager = new FloorSwapManager();
