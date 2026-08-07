/**
 * 汎用建築CAD - コアクラス定義
 *
 * このファイルは純バレル（named re-export のみ）。実体は core/ 配下の各モジュールに分離済み。
 * クラス・フィールドの一覧は core/ 配下の各ファイルを読めば分かる（詳細は .claude/data-model.md 参照）。
 */

// ================================================================
// CONSTANTS — core/constants.js に集約。
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
// POINT / INTERSECTION — core/nodes.js。
// ================================================================

export { Point, Intersection } from './core/nodes.js';

// ================================================================
// SHAPES (グラフエッジ) — 基底クラス Shape は core/shapeBase.js（非公開のため再エクスポートしない）。
// VerticalLine/HorizontalLine/DiagonalLine/Arc/Circle は core/shapes.js。
// ================================================================

export { VerticalLine, HorizontalLine, DiagonalLine, Arc, Circle } from './core/shapes.js';

// ================================================================
// WALL / OPENING — core/wall.js。
// ================================================================

export { Wall, Opening } from './core/wall.js';

// ================================================================
// CENTER LINE (中心線) — core/centerLine.js。
// ================================================================

export { CenterLine, centerLineKind } from './core/centerLine.js';

// ================================================================
// DIMENSION (寸法線) — core/dimension.js。DimensionLine は StructuralEntity と
// 同じ半公開扱い（export はするが core.js からは再エクスポートしない）。
// ================================================================

export { DimensionAnchor, HDimensionLine, VDimensionLine } from './core/dimension.js';

// ================================================================
// WALL BACKING MATERIAL / EDGE / ROOM 系 — core/room.js。
// ================================================================

export {
  WallBackingMaterial, edgeKey, Edge, RoomFinish, ExteriorFinishRow, Room,
} from './core/room.js';

// ================================================================
// STAIR (階段) — core/stair.js。
// ================================================================

export { totalStepsFromSections, Stair } from './core/stair.js';

// ================================================================
// STRUCTURAL ENTITIES — core/structuralEntities.js。
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
// PLANE (平面 = XY平面 1枚 + 高さ 1つ) — core/plane.js。
// ================================================================

export { Plane } from './core/plane.js';

// ================================================================
// PLAN GRAPH (ngraph ラッパ — 平面図の主グラフ) — core/planGraph.js。
// ================================================================

export { PlanGraph } from './core/planGraph.js';

// ================================================================
// SITE (敷地モード) — core/site.js。
// ================================================================

export { SitePoint, SiteLine, SiteTriangle, Site } from './core/site.js';

// ================================================================
// StructuralInfo (構造情報) — core/structuralInfo.js。
// ================================================================

export { StructuralInfo } from './core/structuralInfo.js';

// ================================================================
// PROJECT (MobX ルートストア) — core/project.js。
// ================================================================

export { Project } from './core/project.js';
