/**
 * 汎用建築CAD - コアクラス定義
 * 状態管理: MobX (mobx)
 * グラフ構造: ngraph.graph
 */
import { makeObservable, observable, computed, action } from 'mobx';

// ================================================================
// CONSTANTS — core/constants.js に集約。core.js が内部使用しつつ後方互換のため再エクスポートする。
// ================================================================

export {
  Discipline, ShapeType, OpeningCategory, ShapeKind, CenterLineType, RoomKind, RoomFeature,
  StairType, StructuralMaterialType, LINE_WEIGHT_MM, DimensionKind, DimensionSide,
  DEFAULT_WALL_MATERIAL, DEFAULT_EXTERIOR_WALL_BACKING,
  DEFAULT_INTERIOR_WALL_BACKING, DEFAULT_CEILING_BACKING, DEFAULT_FLOOR_BACKING,
  DEFAULT_ROOM_FLOOR_LEVEL, DEFAULT_ROOM_CEILING_HEIGHT,
  SiteLineKind, CL_OVERLAP_TOL_MM,
} from './core/constants.js';

// ================================================================
// POINT / INTERSECTION — core/nodes.js に分離。後方互換のため再エクスポートする。
// ================================================================

export { Point, Intersection } from './core/nodes.js';

// ================================================================
// SHAPES (グラフエッジ) — 基底クラス Shape は core/shapeBase.js に分離（非公開のため再エクスポートしない）。
// VerticalLine/HorizontalLine/DiagonalLine/Arc/Circle は core/shapes.js に分離。
// ================================================================

export { VerticalLine, HorizontalLine, DiagonalLine, Arc, Circle } from './core/shapes.js';

// ================================================================
// WALL / OPENING — core/wall.js に分離。後方互換のため再エクスポートする。
// ================================================================

export { Wall, Opening } from './core/wall.js';

// ================================================================
// CENTER LINE (中心線) — core/centerLine.js に分離。後方互換のため再エクスポートする。
// ================================================================

export { CenterLine, centerLineKind } from './core/centerLine.js';

// ================================================================
// DIMENSION (寸法線) — core/dimension.js に分離。DimensionLine は StructuralEntity と
// 同じ半公開扱い（export はするが core.js からは再エクスポートしない。core.js 側で
// PlanGraph が無くなったため instanceof 判定用の import も不要）。
// ================================================================

export { DimensionAnchor, HDimensionLine, VDimensionLine } from './core/dimension.js';

// ================================================================
// WALL BACKING MATERIAL / EDGE / ROOM 系 — core/room.js に分離。後方互換のため再エクスポートする。
// ================================================================

export {
  WallBackingMaterial, edgeKey, Edge, RoomFinish, ExteriorFinishRow, Room,
} from './core/room.js';

// ================================================================
// STAIR (階段) — core/stair.js に分離。後方互換のため再エクスポートする。
// ================================================================

export { totalStepsFromSections, Stair } from './core/stair.js';

// ================================================================
// STRUCTURAL ENTITIES — core/structuralEntities.js に分離。
// PlanGraph（core/planGraph.js）が材種別→クラス解決表・キー生成・直接 new するクラスを import して使い、
// core.js は後方互換のため公開クラス／関数を再エクスポートする
// （StructuralEntity / StructuralFooting は元から非公開のため再エクスポートしない）。
// ================================================================

export {
  columnSlotKey, spanKey, findHostPrimaryBeam, HOST_BEAM_MATCH_TOL_MM,
  StructuralColumn, WoodColumn, SteelColumn, RcColumn,
  StructuralBeam, WoodBeam, SteelBeam, RcBeam,
  IndependentFooting, ColumnBase,
  StructuralWall, RcBearingWall, RcWallOpening,
  StructuralSlab, RcSlab, PenetrationSleeve,
} from './core/structuralEntities.js';

// ================================================================
// PLANE (平面 = XY平面 1枚 + 高さ 1つ) — core/plane.js に分離。後方互換のため再エクスポートする。
// ================================================================

import { Plane } from './core/plane.js';
export { Plane } from './core/plane.js';

// ================================================================
// PLAN GRAPH (ngraph ラッパ — 平面図の主グラフ) — core/planGraph.js に分離。後方互換のため再エクスポートする。
// ================================================================

import { PlanGraph } from './core/planGraph.js';
export { PlanGraph } from './core/planGraph.js';

// ================================================================
// SITE (敷地モード) — core/site.js に分離。core 内部使用（Project.site）のため
// Site を import しつつ、後方互換のため全クラスを再エクスポートする。
// ================================================================

import { Site } from './core/site.js';
export { SitePoint, SiteLine, SiteTriangle, Site } from './core/site.js';

// 構造情報（StructuralInfo） — core/structuralInfo.js に分離。
// core 内部使用（Project.structuralInfo）のため import しつつ再エクスポートする。
import { StructuralInfo } from './core/structuralInfo.js';
export { StructuralInfo } from './core/structuralInfo.js';

// ================================================================
// PROJECT (MobX ルートストア)
// ================================================================

export class Project {
  constructor(id, name) {
    this.id   = id;
    this.name = name;

    this.planeMap = observable.map();
    this.graphMap = observable.map();

    this.activePlaneId = null;

    // 全階共通の通り芯専用グラフ（labeled struct CL のみ格納）
    const structPlane = new Plane('struct', 0, '__struct__');
    this.structGraph  = new PlanGraph(structPlane);

    this.site = new Site();
    this.structuralInfo = new StructuralInfo();

    // 部材グループ台帳（建物全体で共有。grp.spec:<gid>/grp.join:<gid>/grp.no:<gid>/grp.mergedInto:<gid> → 文字列）。
    // 分割・統合・手動採番というユーザーの明示操作だけを持つ（既定の集約は毎回 signature から導出する。
    // structural/memberGroups.js・memberNumbering.js 参照）。FBS の tagRegistryKeys/Vals チャネルへ
    // そのまま乗せる（graphSnapshot.js buildStructSnapshot/restoreStructCLs）。
    this.memberGroupLedger = observable.map();
    // 部材番号グループの派生キャッシュ（非永続。モード境界の収集フェーズで再構築される。
    // groupKey → {mapName, symbol, sizeKey, signature, floorRanks:Set<number>, hasRoof, counts:Map<planeId,number>}）。
    this.memberNumberIndex = observable.map();
    // 建具番号グループの派生キャッシュ（非永続。建具モード突入時の収集フェーズで再構築される。
    // signature → { symbol, subType, width, height, sillHeight, counts:Map<planeId,number>, tag }）。
    this.openingNumberIndex = observable.map();

    makeObservable(this, {
      name:          observable,
      activePlaneId: observable,
      activeGraph:   computed,
      activePlane:   computed,
      planes:        computed,
      orderedTabs:   computed,
      roofPlane:     computed,
      addPlane:      action,
      removePlane:   action,
      clearMemberNumberIndex: action,
      clearOpeningNumberIndex: action,
    });
  }

  clearMemberNumberIndex() { this.memberNumberIndex.clear(); }
  clearOpeningNumberIndex() { this.openingNumberIndex.clear(); }

  get activeGraph() {
    return this.activePlaneId ? this.graphMap.get(this.activePlaneId) : undefined;
  }

  get activePlane() {
    return this.activePlaneId ? this.planeMap.get(this.activePlaneId) : undefined;
  }

  /** 採用フロアのみを elevation 昇順で返す（階番号ロジック用。屋根専用平面は対象外） */
  get planes() {
    return [...this.planeMap.values()]
      .filter(p => !p.isAlternative && !p.isRoofPlane)
      .sort((a, b) => a.elevation - b.elevation);
  }

  /** 屋根専用平面（小屋伏／R階伏）。構造モードでのみ存在し、なければ null。 */
  get roofPlane() {
    return [...this.planeMap.values()].find(p => p.isRoofPlane) ?? null;
  }

  /** タブ表示順（採用 + 各採用の検討、elevation 昇順グループ） */
  get orderedTabs() {
    const adopted = this.planes;
    const result = [];
    for (const a of adopted) {
      result.push(a);
      const alts = [...this.planeMap.values()]
        .filter(p => p.isAlternative && p.referenceId === a.id)
        .sort((a, b) => a.altIndex - b.altIndex);
      result.push(...alts);
    }
    return result;
  }

  addPlane(elevation, name, id = crypto.randomUUID(), startFloor = 1, stories = 1,
           isAlternative = false, referenceId = null, altIndex = 0,
           isRoofPlane = false, roofForPlaneId = null) {
    const plane = new Plane(id, elevation, name, startFloor, stories, isAlternative, referenceId, altIndex,
                             isRoofPlane, roofForPlaneId);
    const graph = new PlanGraph(plane);
    graph._structGraph = this.structGraph; // 全階共通の通り芯を参照
    this.planeMap.set(plane.id, plane);
    this.graphMap.set(plane.id, graph);
    if (!this.activePlaneId) this.activePlaneId = plane.id;
    return { plane, graph };
  }

  removePlane(planeId) {
    const plane = this.planeMap.get(planeId);
    if (!plane) return;
    if (!plane.isAlternative && !plane.isRoofPlane && this.planes.length <= 1) return; // 採用の最後の1階は削除不可

    if (!plane.isAlternative) {
      // 検討をまとめて削除
      for (const [id, p] of this.planeMap) {
        if (p.isAlternative && p.referenceId === planeId) {
          this.planeMap.delete(id);
          this.graphMap.delete(id);
        }
      }
    }
    this.planeMap.delete(planeId);
    this.graphMap.delete(planeId);
    if (this.activePlaneId === planeId) {
      this.activePlaneId = this.planes[0]?.id ?? null;
    }
  }

}
