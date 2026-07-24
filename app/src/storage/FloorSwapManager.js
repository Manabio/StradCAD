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
 * ── 通り芯・構造情報操作 ──
 *   setupStructGraph(structGraph, structuralInfo, projectId, tagRegistry)
 *                                    — IDB から通り芯・構造情報・構造部材タグ台帳を復元 + auto-save 開始
 *   disposeStructGraph()             — 通り芯・構造情報 auto-save 停止
 */

import { autorun } from 'mobx';
import { PlanGraph } from '@core';
import { serializeGraph, restoreGraph, serializeStructCLs, restoreStructCLs } from '../graphSnapshot.js';
import { saveFloor, loadFloor, saveProject, loadProject } from './db.js';
import { markDirty } from '../dirtyState.js';

export class FloorSwapManager {
  _cleanups    = new Map(); // planeId → cleanup fn
  _structCleanup = null;   // 通り芯 auto-save cleanup fn
  _peekCleanup = null;     // 編集可能peek（下階）の auto-save cleanup fn

  // ----------------------------------------------------------------
  // フロア操作
  // ----------------------------------------------------------------

  async activate(plane, graph) {
    this._stopAutoSave(plane.id);
    const bytes = await loadFloor(plane.id);
    if (bytes) restoreGraph(graph, bytes);
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
    if (bytes) restoreGraph(tempGraph, bytes);
    return tempGraph;
  }

  disposeAll() {
    this.stopEditablePeek();
    for (const cleanup of this._cleanups.values()) cleanup();
    this._cleanups.clear();
    this.disposeStructGraph();
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
    const dispose = autorun(() => {
      void serializeGraph(graph); // シリアライズ対象の全observableを依存に取る
      if (!initialized) { initialized = true; return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; saveFloor(plane.id, serializeGraph(graph)); }, 400);
    });
    this._peekCleanup = () => {
      dispose();
      if (timer) { clearTimeout(timer); return saveFloor(plane.id, serializeGraph(graph)); } // 保留中の編集を確定
      return Promise.resolve();
    };
  }

  /** 編集可能peekを停止し、保留中の編集の確定保存まで待てる Promise を返す。
   *  呼び出し側が直後に同じ階を loadFloor/peek する場合は必ず await すること（書込み前に読む競合の防止）。 */
  stopEditablePeek() {
    const flushed = this._peekCleanup?.() ?? Promise.resolve();
    this._peekCleanup = null;
    return flushed;
  }

  // ----------------------------------------------------------------
  // 通り芯（全階共通）操作
  // ----------------------------------------------------------------

  async setupStructGraph(structGraph, structuralInfo, projectId, tagRegistry) {
    this.disposeStructGraph();
    const bytes = await loadProject(projectId);
    if (bytes) restoreStructCLs(structGraph, structuralInfo, bytes, tagRegistry);
    this._startStructAutoSave(structGraph, structuralInfo, tagRegistry);
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

  _startStructAutoSave(structGraph, structuralInfo, tagRegistry) {
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
      // 構造部材タグ台帳（project.structuralTagRegistry）の変更も dirty 対象にする
      void tagRegistry?.size;

      if (!initialized) { initialized = true; return; }

      markDirty();
    });

    this._structCleanup = () => dispose();
  }

  // ----------------------------------------------------------------
  // 明示的保存
  // ----------------------------------------------------------------

  async saveNow(plane, graph, structGraph, structuralInfo, projectId, tagRegistry) {
    await saveFloor(plane.id, serializeGraph(graph));
    await saveProject(projectId, serializeStructCLs(structGraph, structuralInfo, tagRegistry));
  }
}

export const floorSwapManager = new FloorSwapManager();
