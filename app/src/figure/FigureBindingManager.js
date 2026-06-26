/**
 * FigureBindingManager
 *
 * FigureDef ＋ 主題階（subjectPlane）から、各レイヤの供給階を解決し、
 * 非アクティブ階を FloorSwapManager.peek で自己完結グラフへ復元したバインディング集合
 * （FigureComposition）を組み立てる。`secondaryEdit` 役割を持つ非アクティブ階には
 * 編集可能 peek を張り、退出時に確定停止する。
 *
 * フロアスワップ機構（peek / 編集可能 peek）の所有者を1か所に集約し、
 * 「アクティブ階＋1つ下」という構造モードの特殊配線を「N階×役割付き」の一般形にする。
 *
 *   activate(figureDef, subjectPlane, subjectGraph, project) → FigureComposition
 *      供給階を解決・peek（subject 以外）・planeId 重複排除して composition を返す。
 *      表示用 autofill はこの後（commit の前）に呼び出し側が適用する。
 *   commit(composition)   — secondaryEdit バインディングの編集可能 peek を開始（表示 autofill 後に呼ぶ）
 *   deactivate()          — 編集可能 peek を確定停止
 */

import { floorSwapManager } from '../storage/FloorSwapManager.js';
import { resolveSourcePlanes, LayerRole } from './figureTypes.js';

export class FigureComposition {
  constructor(figureDef, subjectPlane) {
    this.figureDef = figureDef;
    this.subjectPlane = subjectPlane;
    this.bindings = []; // [{ plane, graph, roles:Set }]（planeId で重複排除済み）
    this.layers = [];   // [{ spec, binding }]
  }

  /** mapName（カテゴリ）を担当するレイヤを解決し { graph, spec } を返す。無ければ null。
   *  「柱は下階・床下材は自階」のような帰属分岐も、表示スタイル・編集役割も、すべてレイヤ定義から一元的に決まる。 */
  resolveCategory(mapName) {
    for (const { spec, binding } of this.layers) {
      if (spec.categories.includes(mapName)) return { graph: binding.graph, spec };
    }
    return null;
  }

  /** mapName を担当するバインディング graph。無ければ null。 */
  graphForCategory(mapName) {
    return this.resolveCategory(mapName)?.graph ?? null;
  }

  /** mapName を担当するレイヤの表示スタイル（LayerStyle）。無ければ undefined。 */
  styleForCategory(mapName) {
    return this.resolveCategory(mapName)?.spec.style;
  }

  /** mapName を担当するレイヤの編集役割（LayerRole）。無ければ undefined。 */
  roleForCategory(mapName) {
    return this.resolveCategory(mapName)?.spec.role;
  }
}

export class FigureBindingManager {
  _composition = null;

  async activate(figureDef, subjectPlane, subjectGraph, project) {
    this.deactivate(); // 前セッションの編集可能 peek を確定停止してから組み直す
    const comp = new FigureComposition(figureDef, subjectPlane);
    const byPlaneId = new Map(); // planeId → binding（同一階を複数レイヤが参照しても1グラフに集約）

    for (const spec of figureDef.layers) {
      const planes = resolveSourcePlanes(spec.source, subjectPlane, project);
      for (const plane of planes) {
        let binding = byPlaneId.get(plane.id);
        if (!binding) {
          const graph = plane.id === subjectPlane.id
            ? subjectGraph
            : await floorSwapManager.peek(plane, project.structGraph);
          binding = { plane, graph, roles: new Set() };
          byPlaneId.set(plane.id, binding);
          comp.bindings.push(binding);
        }
        binding.roles.add(spec.role);
        comp.layers.push({ spec, binding });
      }
    }

    this._composition = comp;
    return comp;
  }

  /** 表示用 autofill 完了後に呼ぶ。非アクティブ階の secondaryEdit バインディングを編集可能化する。
   *  （現状 FloorSwapManager は編集可能 peek を1チャネルしか持たないため、secondaryEdit は1階のみ想定。
   *   複数階の同時編集が必要になった時点で FloorSwapManager 側を多チャネル化する。） */
  commit(composition) {
    for (const binding of composition.bindings) {
      if (binding.plane.id === composition.subjectPlane.id) continue; // 自階は通常の auto-save に乗る
      if (binding.roles.has(LayerRole.SECONDARY_EDIT)) {
        floorSwapManager.startEditablePeek(binding.plane, binding.graph);
      }
    }
  }

  deactivate() {
    floorSwapManager.stopEditablePeek();
    this._composition = null;
  }
}

export const figureBindingManager = new FigureBindingManager();
