/**
 * FlatBuffers シリアライズ / デシリアライズ (スキーマコンパイラ不要の手書き実装)
 *
 * encode(snapshot) → Uint8Array
 * decode(bytes)    → snapshot  (plain object, graphSnapshot.js の JSON 形式と同一)
 *
 * テーブル定義（フィールドインデックス）は下記定数で一元管理する。
 * 各フィールドに addFieldXxx(index, value, default) を呼ぶ際、
 * value == default のフィールドは FlatBuffers が省略するため読み取り時はデフォルト値で復元される。
 */

import { Builder, ByteBuffer } from 'flatbuffers';

// ================================================================
// 列挙値エンコード
// ================================================================
const CL_TYPE_ENC  = { X: 0, Y: 1, R: 2 };
const CL_TYPE_DEC  = ['X', 'Y', 'R'];
const DIM_KIND_ENC = { grid: 0, center: 1, control: 2 };
const DIM_KIND_DEC = ['grid', 'center', 'control'];
const SIDE_ENC     = { top: 0, bottom: 1, left: 2, right: 3 };
const SIDE_DEC     = ['top', 'bottom', 'left', 'right'];

// ================================================================
// フィールドインデックス定数
// ================================================================

// GraphSnapshot (root): 35 フィールド
const GS = {
  CLS: 0, PTS: 1, WALLS: 2, DIAGS: 3, VLINES: 4, HLINES: 5, ARCS: 6, CIRCS: 7, DIMS: 8, ROOMS: 9, ROOM_ORDER: 10,
  // 11 は旧 INTERIOR_WALL_PANEL（内壁面材の per-floor 設定。部屋の壁材へ移行し廃止。slot 予約）
  EXTERIOR_WALL_BACKING: 12, // per-floor 設定
  FLOOR_DATUM: 13, // この階の設計用床レベル(mm)
  EDGES: 14, // 境界エッジ（仕上げモード）
  INTERIOR_WALL_BACKING: 15, CEILING_BACKING: 16, FLOOR_BACKING: 17, // 共通仕様タブ per-floor 設定
  OPENINGS: 18, // 開口（建具・窓）
  STRUCTURE_OVERRIDE: 19, // per-floor 設定: 主要構造の階ごとの例外（空文字=null=建物全体値を継承）
  STRUCTURAL_INFO: 20, // 建物全体: 構造情報（StructuralInfo テーブル）。project 単位の blob のみで使用
  // 構造モード（柱・梁・耐力壁・耐力壁開口・スラブ・基礎・柱脚・貫通孔）
  COLUMNS: 21, BEAMS: 22, STRUCT_WALLS: 23, WALL_OPENINGS: 24, SLABS: 25, FOOTINGS: 26, SLEEVES: 27,
  // トポロジー自動補完の除外集合（per-floor）
  EXCLUDED_COLUMN_SLOTS: 28, EXCLUDED_BEAM_SLOTS: 29,
  // 構造部材タグ台帳（建物全体共有。project 単位の blob のみで使用）
  TAG_REGISTRY_KEYS: 30, TAG_REGISTRY_VALS: 31,
  // 柱芯（ColumnAxis）オフセット（per-floor。CL id → 通り芯からの偏心量mm、文字列化して保存）
  COLUMN_AXIS_KEYS: 32, COLUMN_AXIS_VALS: 33,
  // トポロジー自動補完の除外集合（per-floor、基礎・柱脚分）
  EXCLUDED_FOOTING_SLOTS: 34,
  // 階段（仕上げモード、設置階に帰属）
  STAIRS: 35, STAIR_ORDER: 36,
  // 外部仕上げ行（仕上げモード: 外部/外部建具/構造。per-floor）
  EXTERIOR_ROWS: 37, EXTERIOR_FITTING_ROWS: 38, STRUCTURE_ROWS: 39,
  // 部屋の既定値（共通仕様タブ per-floor 設定）。CH初期値は 0 = 未保存（旧データ）扱い
  DEFAULT_FLOOR_LEVEL: 40, DEFAULT_CEILING_HEIGHT: 41,
};

// Stair: 15 フィールド
const ST = {
  ID: 0, TYPE: 1, STRUCTURE: 2, CELLS: 3, TOTAL_STEPS: 4,
  TREAD: 5, HAS_RISER: 6, RISER: 7, NOSING: 8, WIDTH: 9,
  UP_DIR: 10, FLIP: 11,
  HAS_SECTIONS: 12, SECTIONS: 13, // 区間別・段数（歩行順、カンマ区切り文字列。例:"4,1,3"）
  ROOM_ID: 14, // 変換元 Room の ID（空文字列 = null。旧データ・上階自動設置分は常に空）
};

// StructuralMaterialType 列挙値エンコード（柱・梁・耐力壁・スラブ・基礎で共通）
const MATERIAL_TYPE_ENC = { WOOD: 0, STEEL: 1, RC: 2 };
const MATERIAL_TYPE_DEC = ['WOOD', 'STEEL', 'RC'];

// StructuralInfo: 12 フィールド（建物全体の構造情報の既定値）
const SI = {
  MAIN_STRUCTURE: 0, OTHER_STRUCTURES: 1, FOUNDATION_TYPE: 2,
  DESIGN_STRENGTH: 3, CONCRETE_TYPE: 4, MAIN_BAR: 5, HOOP_BAR: 6,
  SNOW_AREA: 7, BASIC_WIND_SPEED: 8, SURFACE_ROUGHNESS: 9, SEISMIC_ZONE_FACTOR: 10,
  COLUMN_FACE_PROJECTION: 11, // 旧・建物1値の出幅(mm)。無キー時の移行既定として保持。
  FACE_PROJ_KEYS: 12, FACE_PROJ_VALS: 13, // 出幅マップ（1構造×1通り芯）。keys/vals 並列ベクトル。
};

// Edge: 4 フィールド
const ED = { KEY: 0, MASTER_TYPE: 1, OVR_KEYS: 2, OVR_VALS: 3 };

// ExteriorFinishRow（外部仕上げ行 — exteriorRows/exteriorFittingRows/structureRowsで共通）: 6 フィールド
const XR = { ID: 0, PART: 1, FINISH: 2, BASE: 3, NOTE: 4, ROOM_ID: 5 };

// Room: 25 フィールド
const RM = {
  ID: 0, NAME: 1, CELLS: 2, REF_IDS: 3, GEN_WALL_IDS: 4,
  HAS_POS: 5, POS_X: 6, POS_Y: 7,
  FIN_FLOOR: 8, FIN_BASE_MAT: 9, FIN_BASE_H: 10,
  FIN_WALL: 11, FIN_DADO_MAT: 12, FIN_DADO_H: 13,
  FIN_CEIL_MAT: 14, FIN_CEIL_H: 15, FIN_CORNICE: 16, FIN_NOTE: 17,
  KIND: 18,
  TEMPLATE_KEY: 19, OVR_KEYS: 20, OVR_VALS: 21, // 内装マスター参照 + 個別上書きポケット
  HAS_FLOOR_LEVEL: 22, FLOOR_LEVEL: 23, // 床レベル差(mm)。null は HAS=0 で表現
  FEATURE: 24, // 属性軸（none=0 / stair=1 / void=2）。kind とは独立
};

// Room.kind 列挙値エンコード（VOID は旧データデコード専用。書き込みは INTERIOR/EXTERIOR のみ）
const ROOM_KIND_ENC = { interior: 0, void: 1, exterior: 2 };
const ROOM_KIND_DEC = ['interior', 'void', 'exterior'];

// Room.feature 列挙値エンコード（属性軸。null は none=0）
const ROOM_FEATURE_ENC = { stair: 1, void: 2, stairVoid: 3, undefined: 4 };
const ROOM_FEATURE_DEC = [null, 'stair', 'void', 'stairVoid', 'undefined'];

// CenterLine: 17 フィールド (0–16)
const CL = {
  ID: 0, TYPE: 1, VALUE: 2, LABELED: 3, TRIM: 4,
  REF_ID: 5, REF_OFF: 6,
  LO_REF: 7, HI_REF: 8,
  HAS_LO: 9, LO: 10,
  HAS_HI: 11, HI: 12,
  DISC: 13, LW: 14, LT: 15, COL: 16,
};

// ExtentRef: 3 フィールド (clId | wallId + offset)
const ER = { CL_ID: 0, WALL_ID: 1, OFFSET: 2 };

// Point: 3 フィールド
const PT = { ID: 0, X: 1, Y: 2 };

// Wall: 20 フィールド
const WL = {
  ID: 0, AXIS_CL: 1, AXIS_OFF: 2, IS_V: 3,
  CL_S: 4, S_OFF: 5, CL_E: 6, E_OFF: 7,
  DISC: 8, LW: 9, LT: 10, COL: 11,
  IS_ROOM_WALL: 12, IS_EXTERIOR_WALL: 13,
  HAS_WALL_FINISH: 14, WALL_FINISH: 15, // 室内側仕上げ厚(mm)。null=不明・手動壁
  HAS_BACKING_OFFSET: 16, BACKING_OFFSET: 17, // 下地帯中心のaxisCL.valueからの符号付きオフセット(mm)。null=対称（現行式）
  HAS_BACKING_DEPTH: 18, BACKING_DEPTH: 19,   // 下地帯深さ(mm)。null=現行式。0=下地なし（仕上げのみの薄壁）
};

// Opening: 15 フィールド（開口 — 建具・窓）
const OP = {
  ID: 0, AXIS_CL: 1, WALL_SIDE: 2, IS_V: 3,
  REF_CL: 4, REF_OFF: 5, WIDTH: 6, CATEGORY: 7, SUB_TYPE: 8,
  HINGE_SIDE: 9, SWING_SIDE: 10,
  DISC: 11, LW: 12, LT: 13, COL: 14,
};

// Opening.category 列挙値エンコード
const OPENING_CATEGORY_ENC = { fitting: 0, window: 1 };
const OPENING_CATEGORY_DEC = ['fitting', 'window'];

// DiagonalLine: 7 フィールド
const DG = { ID: 0, A: 1, B: 2, DISC: 3, LW: 4, LT: 5, COL: 6 };

// VerticalLine: 8 フィールド
const VL = { ID: 0, CLV: 1, CLH_S: 2, CLH_E: 3, DISC: 4, LW: 5, LT: 6, COL: 7 };

// HorizontalLine: 8 フィールド
const HL = { ID: 0, CLH: 1, CLV_S: 2, CLV_E: 3, DISC: 4, LW: 5, LT: 6, COL: 7 };

// Arc: 9 フィールド
const AR = { ID: 0, CTR: 1, RAD: 2, SA: 3, IA: 4, DISC: 5, LW: 6, LT: 7, COL: 8 };

// Circle: 7 フィールド
const CI = { ID: 0, CTR: 1, RAD: 2, DISC: 3, LW: 4, LT: 5, COL: 6 };

// DimensionLine: 12 フィールド
const DL = {
  ID: 0, AXIS: 1, KIND: 2, SIDE: 3, FOOT: 4,
  HAS_POS: 5, POS: 6, ANCHORS: 7,
  DISC: 8, LW: 9, LT: 10, COL: 11,
};

// DimensionAnchor: 4 フィールド
const DA = { CL_ID: 0, OFF: 1, HAS_COORD: 2, COORD: 3 };

// StructuralColumn（柱・杭）: 16 フィールド
const SC = {
  ID: 0, MATERIAL: 1, SECTION: 2, VERT_CL: 3, HORIZ_CL: 4,
  ECC_X: 5, ECC_Y: 6, ROTATION: 7, ROLE: 8,
  HAS_TOP: 9, TOP: 10, HAS_BOTTOM: 11, BOTTOM: 12,
  MEMBER_NO: 13, EXTRA_KEYS: 14, EXTRA_VALS: 15,
};

// StructuralBeam（梁・小梁・基礎梁・軒桁・母屋・垂木）: 17 フィールド
const SB = {
  ID: 0, MATERIAL: 1, SECTION: 2, AXIS_CL: 3, IS_V: 4, CL_S: 5, CL_E: 6,
  ECC: 7, JOINT_S: 8, JOINT_E: 9, ROLE: 10,
  LEVEL_OFF: 11, START_LEVEL_OFF: 12, END_LEVEL_OFF: 13,
  MEMBER_NO: 14, EXTRA_KEYS: 15, EXTRA_VALS: 16,
};

// StructuralWall（耐力壁）: 15 フィールド
const SW = {
  ID: 0, MATERIAL: 1, SECTION: 2, AXIS_CL: 3, IS_V: 4, CL_S: 5, CL_E: 6,
  ECC: 7, THICKNESS: 8, HAS_TOP: 9, TOP: 10, BOTTOM: 11,
  MEMBER_NO: 12, EXTRA_KEYS: 13, EXTRA_VALS: 14,
};

// RcWallOpening（耐力壁開口）: 9 フィールド
const WO = {
  ID: 0, WALL_ID: 1, OFFSET: 2, WIDTH: 3, HEIGHT: 4, SILL: 5,
  AFFECTS_EFF_LEN: 6, EXTRA_KEYS: 7, EXTRA_VALS: 8,
};

// StructuralSlab（スラブ・べた基礎・屋根版）: 16 フィールド
const SL = {
  ID: 0, MATERIAL: 1, SECTION: 2, CELLS: 3, THICKNESS: 4,
  HAS_FLOOR_LEVEL: 5, FLOOR_LEVEL: 6, ROLE: 7, LEVEL_REF: 8,
  HAS_SLOPE_DIR: 9, SLOPE_DIR_X: 10, SLOPE_DIR_Y: 11, SLOPE_ANGLE: 12,
  MEMBER_NO: 13, EXTRA_KEYS: 14, EXTRA_VALS: 15,
};

// Footing（独立フーチング・柱脚）: 18 フィールド
const FT = {
  ID: 0, KIND: 1, MATERIAL: 2, SECTION: 3, VERT_CL: 4, HORIZ_CL: 5,
  ECC_X: 6, ECC_Y: 7, HAS_TOP: 8, TOP: 9, HAS_BOTTOM: 10, BOTTOM: 11,
  SECTION_SHAPE: 12, WIDTH_X: 13, WIDTH_Y: 14,
  MEMBER_NO: 15, EXTRA_KEYS: 16, EXTRA_VALS: 17,
};

// PenetrationSleeve（梁・スラブの貫通孔）: 14 フィールド
const SV = {
  ID: 0, HOST_TYPE: 1, HOST_BEAM_ID: 2, HOST_AXIS_CL: 3, HOST_CL_S: 4, HOST_CL_E: 5,
  LOCAL_POS: 6, HEIGHT_OFF: 7, HOST_SLAB_ID: 8, HOST_CELL_KEY: 9,
  LOCAL_X: 10, LOCAL_Y: 11, DIAMETER: 12, HAS_REINFORCEMENT: 13,
};

// ================================================================
// WRITE ユーティリティ
// ================================================================

/** テーブルの配列を FlatBuffers vector として書き込む */
function writeVec(b, items, fn) {
  const offs = items.map(x => fn(b, x));
  b.startVector(4, offs.length, 4);
  for (let i = offs.length - 1; i >= 0; i--) b.addOffset(offs[i]);
  return b.endVector();
}

/** 文字列配列を FlatBuffers vector として書き込む */
function writeStrVec(b, strings) {
  return writeVec(b, strings, (b2, s) => b2.createString(s));
}

/** 共通スタイルプロパティの文字列を事前生成する */
function strBase(b, rec) {
  return {
    disc: b.createString(rec.discipline ?? 'arch'),
    lt:   b.createString(rec.lineType   ?? 'solid'),
    col:  b.createString(rec.color      ?? '#000000'),
  };
}

// ================================================================
// WRITER — 各テーブル型
// ================================================================

function writeExtentRef(b, ref) {
  if (!ref) return 0;
  const sClId   = b.createString(ref.clId   ?? '');
  const sWallId = b.createString(ref.wallId ?? '');
  b.startObject(3);
  b.addFieldOffset(ER.CL_ID,   sClId,   0);
  b.addFieldOffset(ER.WALL_ID, sWallId, 0);
  b.addFieldFloat64(ER.OFFSET, ref.offset ?? 0, 0.0);
  return b.endObject();
}

function writeStructuralInfo(b, info) {
  if (!info) return 0;
  const otherVec = writeStrVec(b, info.otherStructures ?? []);
  const sMain    = b.createString(info.mainStructure    ?? '');
  const sFound   = b.createString(info.foundationType   ?? '');
  const sDesign  = b.createString(info.designStrength   ?? '');
  const sConc    = b.createString(info.concreteType     ?? '');
  const sMainBar = b.createString(info.mainBar          ?? '');
  const sHoopBar = b.createString(info.hoopBar          ?? '');
  const sSnow    = b.createString(info.snowArea         ?? '');
  const sRough   = b.createString(info.surfaceRoughness ?? '');
  const sSeismic = b.createString(info.seismicZoneFactor ?? '');
  const fpKeysVec = writeStrVec(b, info.columnFaceProjKeys ?? []);
  const fpValsVec = writeStrVec(b, info.columnFaceProjVals ?? []);

  b.startObject(14);
  b.addFieldOffset(SI.MAIN_STRUCTURE,      sMain,    0);
  b.addFieldOffset(SI.OTHER_STRUCTURES,    otherVec, 0);
  b.addFieldOffset(SI.FOUNDATION_TYPE,     sFound,   0);
  b.addFieldOffset(SI.DESIGN_STRENGTH,     sDesign,  0);
  b.addFieldOffset(SI.CONCRETE_TYPE,       sConc,    0);
  b.addFieldOffset(SI.MAIN_BAR,            sMainBar, 0);
  b.addFieldOffset(SI.HOOP_BAR,            sHoopBar, 0);
  b.addFieldOffset(SI.SNOW_AREA,           sSnow,    0);
  b.addFieldFloat64(SI.BASIC_WIND_SPEED,   info.basicWindSpeed ?? 0, 0.0);
  b.addFieldOffset(SI.SURFACE_ROUGHNESS,   sRough,   0);
  b.addFieldOffset(SI.SEISMIC_ZONE_FACTOR, sSeismic, 0);
  b.addFieldFloat64(SI.COLUMN_FACE_PROJECTION, info.columnFaceProjection ?? 0, 0.0);
  b.addFieldOffset(SI.FACE_PROJ_KEYS, fpKeysVec, 0);
  b.addFieldOffset(SI.FACE_PROJ_VALS, fpValsVec, 0);
  return b.endObject();
}

function writeCL(b, cl) {
  // ネストテーブル・文字列は startObject より前に生成する (FlatBuffers bottom-up 制約)
  const loRef  = writeExtentRef(b, cl.extentLoRef);
  const hiRef  = writeExtentRef(b, cl.extentHiRef);
  const sId    = b.createString(cl.id);
  const sRefId = b.createString(cl.refId ?? '');
  const bp     = strBase(b, { discipline: cl.discipline, lineType: cl.lineType, color: cl.color });

  b.startObject(17);
  b.addFieldOffset(CL.ID,     sId,    0);
  b.addFieldInt8(CL.TYPE,     CL_TYPE_ENC[cl.centerLineType] ?? 0, 0);
  b.addFieldFloat64(CL.VALUE, cl.value, 0.0);
  b.addFieldInt8(CL.LABELED,  cl.labeled ? 1 : 0, 0);
  b.addFieldInt8(CL.TRIM,     cl.trim    ? 1 : 0, 0);
  b.addFieldOffset(CL.REF_ID,  sRefId, 0);
  b.addFieldFloat64(CL.REF_OFF, cl.refOffset ?? 0, 0.0);
  b.addFieldOffset(CL.LO_REF,  loRef,  0);
  b.addFieldOffset(CL.HI_REF,  hiRef,  0);
  b.addFieldInt8(CL.HAS_LO,   cl.extentLo != null ? 1 : 0, 0);
  b.addFieldFloat64(CL.LO,    cl.extentLo ?? 0.0, 0.0);
  b.addFieldInt8(CL.HAS_HI,   cl.extentHi != null ? 1 : 0, 0);
  b.addFieldFloat64(CL.HI,    cl.extentHi ?? 0.0, 0.0);
  b.addFieldOffset(CL.DISC,   bp.disc, 0);
  b.addFieldFloat64(CL.LW,    cl.lineWeight ?? 0.15, 0.0);
  b.addFieldOffset(CL.LT,     bp.lt,   0);
  b.addFieldOffset(CL.COL,    bp.col,  0);
  return b.endObject();
}

function writePT(b, pt) {
  const sId = b.createString(pt.id);
  b.startObject(3);
  b.addFieldOffset(PT.ID, sId,  0);
  b.addFieldFloat64(PT.X, pt.x, 0.0);
  b.addFieldFloat64(PT.Y, pt.y, 0.0);
  return b.endObject();
}

function writeWall(b, w) {
  const sId   = b.createString(w.id);
  const sAxis = b.createString(w.axisCLId);
  const sClS  = b.createString(w.clStartId);
  const sClE  = b.createString(w.clEndId);
  const bp    = strBase(b, w);

  const hasWallFinish = w.wallFinish != null;
  const hasBackingOffset = w.backingOffset != null;
  const hasBackingDepth  = w.backingDepth  != null;

  b.startObject(20);
  b.addFieldOffset(WL.ID,      sId,   0);
  b.addFieldOffset(WL.AXIS_CL, sAxis, 0);
  b.addFieldFloat64(WL.AXIS_OFF, w.axisOffset ?? 0, 0.0);
  b.addFieldInt8(WL.IS_V,      w.isVertical ? 1 : 0, 0);
  b.addFieldOffset(WL.CL_S,    sClS,  0);
  b.addFieldFloat64(WL.S_OFF,  w.startOffset ?? 0, 0.0);
  b.addFieldOffset(WL.CL_E,    sClE,  0);
  b.addFieldFloat64(WL.E_OFF,  w.endOffset ?? 0, 0.0);
  b.addFieldOffset(WL.DISC,    bp.disc, 0);
  b.addFieldFloat64(WL.LW,     w.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(WL.LT,      bp.lt,   0);
  b.addFieldOffset(WL.COL,     bp.col,  0);
  b.addFieldInt8(WL.IS_ROOM_WALL, w.isRoomWall ? 1 : 0, 0);
  b.addFieldInt8(WL.IS_EXTERIOR_WALL, w.isExteriorWall ? 1 : 0, 0);
  b.addFieldInt8(WL.HAS_WALL_FINISH, hasWallFinish ? 1 : 0, 0);
  b.addFieldFloat64(WL.WALL_FINISH, hasWallFinish ? w.wallFinish : 0, 0.0);
  b.addFieldInt8(WL.HAS_BACKING_OFFSET, hasBackingOffset ? 1 : 0, 0);
  b.addFieldFloat64(WL.BACKING_OFFSET, hasBackingOffset ? w.backingOffset : 0, 0.0);
  b.addFieldInt8(WL.HAS_BACKING_DEPTH, hasBackingDepth ? 1 : 0, 0);
  b.addFieldFloat64(WL.BACKING_DEPTH, hasBackingDepth ? w.backingDepth : 0, 0.0);
  return b.endObject();
}

function writeOpening(b, o) {
  const sId    = b.createString(o.id);
  const sAxis  = b.createString(o.axisCLId);
  const sRef   = b.createString(o.refCLId);
  const sSub   = b.createString(o.subType ?? '');
  const bp     = strBase(b, o);

  b.startObject(15);
  b.addFieldOffset(OP.ID,         sId,   0);
  b.addFieldOffset(OP.AXIS_CL,    sAxis, 0);
  b.addFieldInt8(OP.WALL_SIDE,    o.wallSide < 0 ? -1 : 1, 0);
  b.addFieldInt8(OP.IS_V,         o.isVertical ? 1 : 0, 0);
  b.addFieldOffset(OP.REF_CL,     sRef,  0);
  b.addFieldFloat64(OP.REF_OFF,   o.refOffset ?? 0, 0.0);
  b.addFieldFloat64(OP.WIDTH,     o.width ?? 0, 0.0);
  b.addFieldInt8(OP.CATEGORY,     OPENING_CATEGORY_ENC[o.category] ?? 0, 0);
  b.addFieldOffset(OP.SUB_TYPE,   sSub,  0);
  b.addFieldInt8(OP.HINGE_SIDE,   o.hingeSide < 0 ? -1 : 1, 0);
  b.addFieldInt8(OP.SWING_SIDE,   o.swingSide < 0 ? -1 : 1, 0);
  b.addFieldOffset(OP.DISC,       bp.disc, 0);
  b.addFieldFloat64(OP.LW,        o.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(OP.LT,         bp.lt,   0);
  b.addFieldOffset(OP.COL,        bp.col,  0);
  return b.endObject();
}

function writeDiag(b, d) {
  const sId = b.createString(d.id);
  const sA  = b.createString(d.nodeAId);
  const sB  = b.createString(d.nodeBId);
  const bp  = strBase(b, d);

  b.startObject(7);
  b.addFieldOffset(DG.ID,   sId,  0);
  b.addFieldOffset(DG.A,    sA,   0);
  b.addFieldOffset(DG.B,    sB,   0);
  b.addFieldOffset(DG.DISC, bp.disc, 0);
  b.addFieldFloat64(DG.LW,  d.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(DG.LT,   bp.lt,   0);
  b.addFieldOffset(DG.COL,  bp.col,  0);
  return b.endObject();
}

function writeVLine(b, v) {
  const sId  = b.createString(v.id);
  const sClV = b.createString(v.clVerticalId);
  const sHS  = b.createString(v.clHStartId);
  const sHE  = b.createString(v.clHEndId);
  const bp   = strBase(b, v);

  b.startObject(8);
  b.addFieldOffset(VL.ID,    sId,  0);
  b.addFieldOffset(VL.CLV,   sClV, 0);
  b.addFieldOffset(VL.CLH_S, sHS,  0);
  b.addFieldOffset(VL.CLH_E, sHE,  0);
  b.addFieldOffset(VL.DISC,  bp.disc, 0);
  b.addFieldFloat64(VL.LW,   v.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(VL.LT,    bp.lt,   0);
  b.addFieldOffset(VL.COL,   bp.col,  0);
  return b.endObject();
}

function writeHLine(b, h) {
  const sId  = b.createString(h.id);
  const sClH = b.createString(h.clHorizontalId);
  const sVS  = b.createString(h.clVStartId);
  const sVE  = b.createString(h.clVEndId);
  const bp   = strBase(b, h);

  b.startObject(8);
  b.addFieldOffset(HL.ID,    sId,  0);
  b.addFieldOffset(HL.CLH,   sClH, 0);
  b.addFieldOffset(HL.CLV_S, sVS,  0);
  b.addFieldOffset(HL.CLV_E, sVE,  0);
  b.addFieldOffset(HL.DISC,  bp.disc, 0);
  b.addFieldFloat64(HL.LW,   h.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(HL.LT,    bp.lt,   0);
  b.addFieldOffset(HL.COL,   bp.col,  0);
  return b.endObject();
}

function writeArc(b, a) {
  const sId  = b.createString(a.id);
  const sCtr = b.createString(a.centerId);
  const bp   = strBase(b, a);

  b.startObject(9);
  b.addFieldOffset(AR.ID,   sId,  0);
  b.addFieldOffset(AR.CTR,  sCtr, 0);
  b.addFieldFloat64(AR.RAD, a.radius ?? 0, 0.0);
  b.addFieldFloat64(AR.SA,  a.startAngle ?? 0, 0.0);
  b.addFieldFloat64(AR.IA,  a.includedAngle ?? 0, 0.0);
  b.addFieldOffset(AR.DISC, bp.disc, 0);
  b.addFieldFloat64(AR.LW,  a.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(AR.LT,   bp.lt,   0);
  b.addFieldOffset(AR.COL,  bp.col,  0);
  return b.endObject();
}

function writeCircle(b, c) {
  const sId  = b.createString(c.id);
  const sCtr = b.createString(c.centerId);
  const bp   = strBase(b, c);

  b.startObject(7);
  b.addFieldOffset(CI.ID,   sId,  0);
  b.addFieldOffset(CI.CTR,  sCtr, 0);
  b.addFieldFloat64(CI.RAD, c.radius ?? 0, 0.0);
  b.addFieldOffset(CI.DISC, bp.disc, 0);
  b.addFieldFloat64(CI.LW,  c.lineWeight ?? 0.25, 0.0);
  b.addFieldOffset(CI.LT,   bp.lt,   0);
  b.addFieldOffset(CI.COL,  bp.col,  0);
  return b.endObject();
}

function writeDimAnchor(b, a) {
  const sClId = b.createString(a.clId ?? '');
  b.startObject(4);
  b.addFieldOffset(DA.CL_ID,    sClId, 0);
  b.addFieldFloat64(DA.OFF,     a.offset ?? 0, 0.0);
  b.addFieldInt8(DA.HAS_COORD,  a.coord != null ? 1 : 0, 0);
  b.addFieldFloat64(DA.COORD,   a.coord ?? 0.0, 0.0);
  return b.endObject();
}

function writeDim(b, d) {
  const anchorsVec = writeVec(b, d.anchors ?? [], writeDimAnchor);
  const sId = b.createString(d.id);
  const bp  = strBase(b, d);

  b.startObject(12);
  b.addFieldOffset(DL.ID,      sId,  0);
  b.addFieldInt8(DL.AXIS,      d.axis === 'X' ? 0 : 1, 0);
  b.addFieldInt8(DL.KIND,      DIM_KIND_ENC[d.dimensionKind] ?? 0, 0);
  b.addFieldInt8(DL.SIDE,      SIDE_ENC[d.side] ?? 0, 0);
  b.addFieldFloat64(DL.FOOT,   d.footLength ?? 0, 0.0);
  b.addFieldInt8(DL.HAS_POS,   d.position != null ? 1 : 0, 0);
  b.addFieldFloat64(DL.POS,    d.position ?? 0.0, 0.0);
  b.addFieldOffset(DL.ANCHORS, anchorsVec, 0);
  b.addFieldOffset(DL.DISC,    bp.disc, 0);
  b.addFieldFloat64(DL.LW,     d.lineWeight ?? 0.15, 0.0);
  b.addFieldOffset(DL.LT,      bp.lt,   0);
  b.addFieldOffset(DL.COL,     bp.col,  0);
  return b.endObject();
}

function writeRoom(b, rm) {
  const cellsVec    = writeStrVec(b, rm.cells);
  const refIdsVec   = writeStrVec(b, rm.referenceRoomIds);
  const genWallVec  = writeStrVec(b, rm.generatedWallIds);
  // 個別上書きポケット — キー配列・値配列に分解（値は文字列化済み）
  const overrides   = rm.overrides ?? [];
  const ovrKeysVec  = writeStrVec(b, overrides.map(o => o.key));
  const ovrValsVec  = writeStrVec(b, overrides.map(o => String(o.value ?? '')));
  const sId         = b.createString(rm.id);
  const sName       = b.createString(rm.name ?? '');
  const sTemplate   = b.createString(rm.templateKey ?? '');
  const sFinFloor   = b.createString(rm.finish?.floorMaterial     ?? '');
  const sFinBaseMat = b.createString(rm.finish?.baseboardMaterial ?? '');
  const sFinBaseH   = b.createString(rm.finish?.baseboardHeight   ?? '');
  const sFinWall    = b.createString(rm.finish?.wallMaterial      ?? '');
  const sFinDadoMat = b.createString(rm.finish?.dadoMaterial      ?? '');
  const sFinDadoH   = b.createString(rm.finish?.dadoHeight        ?? '');
  const sFinCeilMat = b.createString(rm.finish?.ceilingMaterial   ?? '');
  const sFinCeilH   = b.createString(rm.finish?.ceilingHeight     ?? '');
  const sFinCornice = b.createString(rm.finish?.cornice           ?? '');
  const sFinNote    = b.createString(rm.finish?.note              ?? '');

  // kind は interior/exterior のみ書く。旧来 kind==='void' な Room が来た場合の防御:
  // interior + feature=void として書き込む（新形式へ正規化）。
  const isLegacyVoidKind = rm.kind === 'void';
  const kindEnc    = isLegacyVoidKind ? ROOM_KIND_ENC.interior : (ROOM_KIND_ENC[rm.kind] ?? 0);
  const featureVal = isLegacyVoidKind ? 'void' : (rm.feature ?? null);

  b.startObject(25);
  b.addFieldOffset(RM.ID,           sId,          0);
  b.addFieldOffset(RM.NAME,         sName,        0);
  b.addFieldOffset(RM.CELLS,        cellsVec,     0);
  b.addFieldOffset(RM.REF_IDS,      refIdsVec,    0);
  b.addFieldOffset(RM.GEN_WALL_IDS, genWallVec,   0);
  b.addFieldInt8(RM.HAS_POS,        rm.hasNamePosition ? 1 : 0, 0);
  b.addFieldFloat64(RM.POS_X,       rm.posX ?? 0.0, 0.0);
  b.addFieldFloat64(RM.POS_Y,       rm.posY ?? 0.0, 0.0);
  b.addFieldOffset(RM.FIN_FLOOR,    sFinFloor,    0);
  b.addFieldOffset(RM.FIN_BASE_MAT, sFinBaseMat,  0);
  b.addFieldOffset(RM.FIN_BASE_H,   sFinBaseH,    0);
  b.addFieldOffset(RM.FIN_WALL,     sFinWall,     0);
  b.addFieldOffset(RM.FIN_DADO_MAT, sFinDadoMat,  0);
  b.addFieldOffset(RM.FIN_DADO_H,   sFinDadoH,    0);
  b.addFieldOffset(RM.FIN_CEIL_MAT, sFinCeilMat,  0);
  b.addFieldOffset(RM.FIN_CEIL_H,   sFinCeilH,    0);
  b.addFieldOffset(RM.FIN_CORNICE,  sFinCornice,  0);
  b.addFieldOffset(RM.FIN_NOTE,     sFinNote,     0);
  b.addFieldInt8(RM.KIND,           kindEnc, 0);
  b.addFieldOffset(RM.TEMPLATE_KEY, sTemplate,    0);
  b.addFieldOffset(RM.OVR_KEYS,     ovrKeysVec,   0);
  b.addFieldOffset(RM.OVR_VALS,     ovrValsVec,   0);
  b.addFieldInt8(RM.HAS_FLOOR_LEVEL, rm.floorLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(RM.FLOOR_LEVEL,  rm.floorLevel ?? 0.0, 0.0);
  b.addFieldInt8(RM.FEATURE,        ROOM_FEATURE_ENC[featureVal] ?? 0, 0);
  return b.endObject();
}

function writeEdge(b, e) {
  const overrides  = e.overrides ?? [];
  const ovrKeysVec = writeStrVec(b, overrides.map(o => o.key));
  const ovrValsVec = writeStrVec(b, overrides.map(o => String(o.value ?? '')));
  const sKey       = b.createString(e.key ?? '');
  const sMaster    = b.createString(e.masterType ?? '');

  b.startObject(4);
  b.addFieldOffset(ED.KEY,         sKey,       0);
  b.addFieldOffset(ED.MASTER_TYPE, sMaster,    0);
  b.addFieldOffset(ED.OVR_KEYS,    ovrKeysVec, 0);
  b.addFieldOffset(ED.OVR_VALS,    ovrValsVec, 0);
  return b.endObject();
}

function writeExteriorRow(b, r) {
  const sId     = b.createString(r.id);
  const sPart   = b.createString(r.part   ?? '');
  const sFinish = b.createString(r.finish ?? '');
  const sBase   = b.createString(r.base   ?? '');
  const sNote   = b.createString(r.note   ?? '');
  const sRoomId = b.createString(r.roomId ?? '');

  b.startObject(6);
  b.addFieldOffset(XR.ID,      sId,     0);
  b.addFieldOffset(XR.PART,    sPart,   0);
  b.addFieldOffset(XR.FINISH,  sFinish, 0);
  b.addFieldOffset(XR.BASE,    sBase,   0);
  b.addFieldOffset(XR.NOTE,    sNote,   0);
  b.addFieldOffset(XR.ROOM_ID, sRoomId, 0);
  return b.endObject();
}

function writeStair(b, st) {
  const sId   = b.createString(st.id);
  const sType = b.createString(st.type ?? 'straight');
  const sStru = b.createString(st.structure ?? 'WOOD');
  const sUp   = b.createString(st.upDirection ?? 'right');
  const sRoomId = b.createString(st.roomId ?? '');
  const cellsVec = writeStrVec(b, st.cells ?? []);
  const hasRiser = st.riser != null;
  const hasSections = st.sections != null;
  const sSections = hasSections ? b.createString(st.sections.join(',')) : 0;

  b.startObject(15);
  b.addFieldOffset(ST.ID,        sId,   0);
  b.addFieldOffset(ST.TYPE,      sType, 0);
  b.addFieldOffset(ST.STRUCTURE, sStru, 0);
  b.addFieldOffset(ST.CELLS,     cellsVec, 0);
  b.addFieldFloat64(ST.TOTAL_STEPS, st.totalSteps ?? 15, 0.0);
  b.addFieldFloat64(ST.TREAD,    st.tread ?? 250, 0.0);
  b.addFieldInt8(ST.HAS_RISER,   hasRiser ? 1 : 0, 0);
  b.addFieldFloat64(ST.RISER,    hasRiser ? st.riser : 0, 0.0);
  b.addFieldFloat64(ST.NOSING,   st.nosing ?? 30, 0.0);
  b.addFieldFloat64(ST.WIDTH,    st.width ?? 900, 0.0);
  b.addFieldOffset(ST.UP_DIR,    sUp,   0);
  b.addFieldInt8(ST.FLIP,        st.flip ? 1 : 0, 0);
  b.addFieldInt8(ST.HAS_SECTIONS, hasSections ? 1 : 0, 0);
  b.addFieldOffset(ST.SECTIONS,   sSections, 0);
  b.addFieldOffset(ST.ROOM_ID,    sRoomId, 0);
  return b.endObject();
}

// ----------------------------------------------------------------
// 構造モード（柱・梁・耐力壁・耐力壁開口・スラブ・基礎・柱脚・貫通孔）
// サブタイプ別フィールドは extraKeys/extraVals（Room.overrides と同じ文字列ペア配列）で表現する。
// ----------------------------------------------------------------

function writeColumn(b, c) {
  const sId     = b.createString(c.id);
  const sSect   = b.createString(c.sectionDefId ?? '');
  const sVert   = b.createString(c.verticalCLId);
  const sHoriz  = b.createString(c.horizontalCLId);
  const sRole   = b.createString(c.role ?? 'standard');
  const sNo     = b.createString(c.memberNo ?? '');
  const extraKeysVec = writeStrVec(b, c.extraKeys ?? []);
  const extraValsVec = writeStrVec(b, c.extraVals ?? []);

  b.startObject(16);
  b.addFieldOffset(SC.ID,       sId,    0);
  b.addFieldInt8(SC.MATERIAL,   MATERIAL_TYPE_ENC[c.materialType] ?? 0, 0);
  b.addFieldOffset(SC.SECTION,  sSect,  0);
  b.addFieldOffset(SC.VERT_CL,  sVert,  0);
  b.addFieldOffset(SC.HORIZ_CL, sHoriz, 0);
  b.addFieldFloat64(SC.ECC_X,   c.eccX ?? 0, 0.0);
  b.addFieldFloat64(SC.ECC_Y,   c.eccY ?? 0, 0.0);
  b.addFieldFloat64(SC.ROTATION, c.rotation ?? 0, 0.0);
  b.addFieldOffset(SC.ROLE,     sRole,  0);
  b.addFieldInt8(SC.HAS_TOP,    c.topLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(SC.TOP,     c.topLevel ?? 0, 0.0);
  b.addFieldInt8(SC.HAS_BOTTOM, c.bottomLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(SC.BOTTOM,  c.bottomLevel ?? 0, 0.0);
  b.addFieldOffset(SC.MEMBER_NO, sNo, 0);
  b.addFieldOffset(SC.EXTRA_KEYS, extraKeysVec, 0);
  b.addFieldOffset(SC.EXTRA_VALS, extraValsVec, 0);
  return b.endObject();
}

function writeBeam(b, bm) {
  const sId     = b.createString(bm.id);
  const sSect   = b.createString(bm.sectionDefId ?? '');
  const sAxis   = b.createString(bm.axisCLId);
  const sClS    = b.createString(bm.clStartId);
  const sClE    = b.createString(bm.clEndId);
  const sJointS = b.createString(bm.jointStart ?? 'RIGID');
  const sJointE = b.createString(bm.jointEnd   ?? 'RIGID');
  const sRole   = b.createString(bm.role ?? 'primary');
  const sNo     = b.createString(bm.memberNo ?? '');
  const extraKeysVec = writeStrVec(b, bm.extraKeys ?? []);
  const extraValsVec = writeStrVec(b, bm.extraVals ?? []);

  b.startObject(17);
  b.addFieldOffset(SB.ID,      sId,   0);
  b.addFieldInt8(SB.MATERIAL,  MATERIAL_TYPE_ENC[bm.materialType] ?? 0, 0);
  b.addFieldOffset(SB.SECTION, sSect, 0);
  b.addFieldOffset(SB.AXIS_CL, sAxis, 0);
  b.addFieldInt8(SB.IS_V,      bm.isVertical ? 1 : 0, 0);
  b.addFieldOffset(SB.CL_S,    sClS,  0);
  b.addFieldOffset(SB.CL_E,    sClE,  0);
  b.addFieldFloat64(SB.ECC,    bm.eccentricity ?? 0, 0.0);
  b.addFieldOffset(SB.JOINT_S, sJointS, 0);
  b.addFieldOffset(SB.JOINT_E, sJointE, 0);
  b.addFieldOffset(SB.ROLE,    sRole, 0);
  b.addFieldFloat64(SB.LEVEL_OFF,       bm.levelOffset      ?? 0, 0.0);
  b.addFieldFloat64(SB.START_LEVEL_OFF, bm.startLevelOffset ?? 0, 0.0);
  b.addFieldFloat64(SB.END_LEVEL_OFF,   bm.endLevelOffset   ?? 0, 0.0);
  b.addFieldOffset(SB.MEMBER_NO, sNo, 0);
  b.addFieldOffset(SB.EXTRA_KEYS, extraKeysVec, 0);
  b.addFieldOffset(SB.EXTRA_VALS, extraValsVec, 0);
  return b.endObject();
}

function writeStructWall(b, w) {
  const sId   = b.createString(w.id);
  const sSect = b.createString(w.sectionDefId ?? '');
  const sAxis = b.createString(w.axisCLId);
  const sClS  = b.createString(w.clStartId);
  const sClE  = b.createString(w.clEndId);
  const sNo   = b.createString(w.memberNo ?? '');
  const extraKeysVec = writeStrVec(b, w.extraKeys ?? []);
  const extraValsVec = writeStrVec(b, w.extraVals ?? []);

  b.startObject(15);
  b.addFieldOffset(SW.ID,      sId,   0);
  b.addFieldInt8(SW.MATERIAL,  MATERIAL_TYPE_ENC[w.materialType] ?? 2, 0);
  b.addFieldOffset(SW.SECTION, sSect, 0);
  b.addFieldOffset(SW.AXIS_CL, sAxis, 0);
  b.addFieldInt8(SW.IS_V,      w.isVertical ? 1 : 0, 0);
  b.addFieldOffset(SW.CL_S,    sClS,  0);
  b.addFieldOffset(SW.CL_E,    sClE,  0);
  b.addFieldFloat64(SW.ECC,       w.eccentricity ?? 0, 0.0);
  b.addFieldFloat64(SW.THICKNESS, w.thickness ?? 180, 0.0);
  b.addFieldInt8(SW.HAS_TOP,   w.topLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(SW.TOP,    w.topLevel ?? 0, 0.0);
  b.addFieldFloat64(SW.BOTTOM, w.bottomLevel ?? 0, 0.0);
  b.addFieldOffset(SW.MEMBER_NO, sNo, 0);
  b.addFieldOffset(SW.EXTRA_KEYS, extraKeysVec, 0);
  b.addFieldOffset(SW.EXTRA_VALS, extraValsVec, 0);
  return b.endObject();
}

function writeStructWallOpening(b, o) {
  const sId   = b.createString(o.id);
  const sWall = b.createString(o.wallId);
  const extraKeysVec = writeStrVec(b, o.extraKeys ?? []);
  const extraValsVec = writeStrVec(b, o.extraVals ?? []);

  b.startObject(9);
  b.addFieldOffset(WO.ID,      sId,   0);
  b.addFieldOffset(WO.WALL_ID, sWall, 0);
  b.addFieldFloat64(WO.OFFSET, o.offset ?? 0, 0.0);
  b.addFieldFloat64(WO.WIDTH,  o.width ?? 0, 0.0);
  b.addFieldFloat64(WO.HEIGHT, o.height ?? 2000, 0.0);
  b.addFieldFloat64(WO.SILL,   o.sillHeight ?? 0, 0.0);
  b.addFieldInt8(WO.AFFECTS_EFF_LEN, o.affectsEffectiveLength ? 1 : 0, 0);
  b.addFieldOffset(WO.EXTRA_KEYS, extraKeysVec, 0);
  b.addFieldOffset(WO.EXTRA_VALS, extraValsVec, 0);
  return b.endObject();
}

function writeSlab(b, s) {
  const sId       = b.createString(s.id);
  const sSect     = b.createString(s.sectionDefId ?? '');
  const cellsVec  = writeStrVec(b, s.cells ?? []);
  const sRole     = b.createString(s.role ?? 'slab');
  const sLevelRef = b.createString(s.levelRef ?? 'top');
  const sNo       = b.createString(s.memberNo ?? '');
  const extraKeysVec = writeStrVec(b, s.extraKeys ?? []);
  const extraValsVec = writeStrVec(b, s.extraVals ?? []);
  const hasSlopeDir  = s.slopeDirX != null && s.slopeDirY != null;

  b.startObject(16);
  b.addFieldOffset(SL.ID,      sId,   0);
  b.addFieldInt8(SL.MATERIAL,  MATERIAL_TYPE_ENC[s.materialType] ?? 2, 0);
  b.addFieldOffset(SL.SECTION, sSect, 0);
  b.addFieldOffset(SL.CELLS,   cellsVec, 0);
  b.addFieldFloat64(SL.THICKNESS, s.thickness ?? 150, 0.0);
  b.addFieldInt8(SL.HAS_FLOOR_LEVEL, s.floorLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(SL.FLOOR_LEVEL,  s.floorLevel ?? 0, 0.0);
  b.addFieldOffset(SL.ROLE,      sRole, 0);
  b.addFieldOffset(SL.LEVEL_REF, sLevelRef, 0);
  b.addFieldInt8(SL.HAS_SLOPE_DIR,  hasSlopeDir ? 1 : 0, 0);
  b.addFieldFloat64(SL.SLOPE_DIR_X, s.slopeDirX ?? 0, 0.0);
  b.addFieldFloat64(SL.SLOPE_DIR_Y, s.slopeDirY ?? 0, 0.0);
  b.addFieldFloat64(SL.SLOPE_ANGLE, s.slopeAngle ?? 0, 0.0);
  b.addFieldOffset(SL.MEMBER_NO, sNo, 0);
  b.addFieldOffset(SL.EXTRA_KEYS, extraKeysVec, 0);
  b.addFieldOffset(SL.EXTRA_VALS, extraValsVec, 0);
  return b.endObject();
}

function writeFooting(b, f) {
  const sId    = b.createString(f.id);
  const sKind  = b.createString(f.kind);
  const sSect  = b.createString(f.sectionDefId ?? '');
  const sVert  = b.createString(f.verticalCLId);
  const sHoriz = b.createString(f.horizontalCLId);
  const sShape = b.createString(f.sectionShape ?? 'rect');
  const sNo    = b.createString(f.memberNo ?? '');
  const extraKeysVec = writeStrVec(b, f.extraKeys ?? []);
  const extraValsVec = writeStrVec(b, f.extraVals ?? []);

  b.startObject(18);
  b.addFieldOffset(FT.ID,       sId,   0);
  b.addFieldOffset(FT.KIND,     sKind, 0);
  b.addFieldInt8(FT.MATERIAL,   MATERIAL_TYPE_ENC[f.materialType] ?? 2, 0);
  b.addFieldOffset(FT.SECTION,  sSect, 0);
  b.addFieldOffset(FT.VERT_CL,  sVert, 0);
  b.addFieldOffset(FT.HORIZ_CL, sHoriz, 0);
  b.addFieldFloat64(FT.ECC_X, f.eccX ?? 0, 0.0);
  b.addFieldFloat64(FT.ECC_Y, f.eccY ?? 0, 0.0);
  b.addFieldInt8(FT.HAS_TOP,    f.topLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(FT.TOP,     f.topLevel ?? 0, 0.0);
  b.addFieldInt8(FT.HAS_BOTTOM, f.bottomLevel != null ? 1 : 0, 0);
  b.addFieldFloat64(FT.BOTTOM,  f.bottomLevel ?? 0, 0.0);
  b.addFieldOffset(FT.SECTION_SHAPE, sShape, 0);
  b.addFieldFloat64(FT.WIDTH_X, f.widthX ?? 1000, 0.0);
  b.addFieldFloat64(FT.WIDTH_Y, f.widthY ?? 1000, 0.0);
  b.addFieldOffset(FT.MEMBER_NO, sNo, 0);
  b.addFieldOffset(FT.EXTRA_KEYS, extraKeysVec, 0);
  b.addFieldOffset(FT.EXTRA_VALS, extraValsVec, 0);
  return b.endObject();
}

function writeSleeve(b, s) {
  const sId           = b.createString(s.id);
  const sHostType     = b.createString(s.hostType);
  const sHostBeamId   = b.createString(s.hostBeamId    ?? '');
  const sHostAxisCLId = b.createString(s.hostAxisCLId  ?? '');
  const sHostClSId    = b.createString(s.hostClStartId ?? '');
  const sHostClEId    = b.createString(s.hostClEndId   ?? '');
  const sHostSlabId   = b.createString(s.hostSlabId    ?? '');
  const sHostCellKey  = b.createString(s.hostCellKey   ?? '');

  b.startObject(14);
  b.addFieldOffset(SV.ID,            sId,           0);
  b.addFieldOffset(SV.HOST_TYPE,     sHostType,     0);
  b.addFieldOffset(SV.HOST_BEAM_ID,  sHostBeamId,   0);
  b.addFieldOffset(SV.HOST_AXIS_CL,  sHostAxisCLId, 0);
  b.addFieldOffset(SV.HOST_CL_S,     sHostClSId,    0);
  b.addFieldOffset(SV.HOST_CL_E,     sHostClEId,    0);
  b.addFieldFloat64(SV.LOCAL_POS,    s.localPos     ?? 0, 0.0);
  b.addFieldFloat64(SV.HEIGHT_OFF,   s.heightOffset ?? 0, 0.0);
  b.addFieldOffset(SV.HOST_SLAB_ID,  sHostSlabId,   0);
  b.addFieldOffset(SV.HOST_CELL_KEY, sHostCellKey,  0);
  b.addFieldFloat64(SV.LOCAL_X,  s.localX  ?? 0, 0.0);
  b.addFieldFloat64(SV.LOCAL_Y,  s.localY  ?? 0, 0.0);
  b.addFieldFloat64(SV.DIAMETER, s.diameter ?? 100, 0.0);
  b.addFieldInt8(SV.HAS_REINFORCEMENT, s.hasReinforcement ? 1 : 0, 0);
  return b.endObject();
}

// ================================================================
// READ ユーティリティ
// ================================================================

/**
 * テーブル位置 tablePos に対するフィールドアクセサを返す。
 * f(n)  — フィールド n が存在すれば tablePos+offset を返し、なければ 0 を返す
 * str   — 文字列フィールドを読み取る (不在時 '')
 * f64   — float64 フィールドを読み取る (不在時 0.0)
 * i8    — int8 フィールドを読み取る (不在時 0)
 * nested — ネストテーブルの絶対位置を返す (不在時 0)
 * vec   — テーブルの配列を読み取る
 */
function makeReader(bb, tablePos) {
  function f(n) { return bb.__offset(tablePos, 4 + n * 2); }
  return {
    str:    n => { const o = f(n); return o ? bb.__string(tablePos + o) : ''; },
    f64:    n => { const o = f(n); return o ? bb.readFloat64(tablePos + o) : 0.0; },
    i8:     n => { const o = f(n); return o ? bb.readInt8(tablePos + o) : 0; },
    nested: n => { const o = f(n); return o ? bb.__indirect(tablePos + o) : 0; },
    vec:    (n, readFn) => {
      const o = f(n);
      if (!o) return [];
      const vecOff = tablePos + o;
      const len    = bb.__vector_len(vecOff);
      const start  = bb.__vector(vecOff);
      const out    = [];
      for (let i = 0; i < len; i++) {
        out.push(readFn(bb, bb.__indirect(start + i * 4)));
      }
      return out;
    },
    strVec: n => {
      const o = f(n);
      if (!o) return [];
      const vecOff = tablePos + o;
      const len    = bb.__vector_len(vecOff);
      const start  = bb.__vector(vecOff);
      const out    = [];
      for (let i = 0; i < len; i++) out.push(bb.__string(start + i * 4));
      return out;
    },
  };
}

// ================================================================
// READER — 各テーブル型
// ================================================================

function readExtentRef(bb, tablePos) {
  if (!tablePos) return null;
  const r = makeReader(bb, tablePos);
  const clId   = r.str(ER.CL_ID)   || null;
  const wallId = r.str(ER.WALL_ID) || null;
  if (!clId && !wallId) return null;
  return { ...(clId ? { clId } : {}), ...(wallId ? { wallId } : {}), offset: r.f64(ER.OFFSET) };
}

function readStructuralInfo(bb, tablePos) {
  if (!tablePos) return null;
  const r = makeReader(bb, tablePos);
  return {
    mainStructure:      r.str(SI.MAIN_STRUCTURE)      || '未定',
    otherStructures:    r.strVec(SI.OTHER_STRUCTURES),
    foundationType:     r.str(SI.FOUNDATION_TYPE)      || 'ベタ基礎',
    designStrength:     r.str(SI.DESIGN_STRENGTH)      || 'Fc24',
    concreteType:       r.str(SI.CONCRETE_TYPE)        || '普通コンクリート',
    mainBar:            r.str(SI.MAIN_BAR)             || 'SD345',
    hoopBar:            r.str(SI.HOOP_BAR)             || 'SD295A',
    snowArea:           r.str(SI.SNOW_AREA)            || '一般区域（多雪以外）',
    basicWindSpeed:     r.f64(SI.BASIC_WIND_SPEED)     || 34,
    surfaceRoughness:   r.str(SI.SURFACE_ROUGHNESS)    || 'III',
    seismicZoneFactor:  r.str(SI.SEISMIC_ZONE_FACTOR)  || '1.0',
    columnFaceProjection: r.f64(SI.COLUMN_FACE_PROJECTION) || 0,
    columnFaceProjKeys: r.strVec(SI.FACE_PROJ_KEYS),
    columnFaceProjVals: r.strVec(SI.FACE_PROJ_VALS),
  };
}

function readCL(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:             r.str(CL.ID),
    centerLineType: CL_TYPE_DEC[r.i8(CL.TYPE)] ?? 'X',
    value:          r.f64(CL.VALUE),
    labeled:        r.i8(CL.LABELED) !== 0,
    trim:           r.i8(CL.TRIM)    !== 0,
    refId:          r.str(CL.REF_ID) || null,
    refOffset:      r.f64(CL.REF_OFF),
    extentLoRef:    readExtentRef(bb, r.nested(CL.LO_REF)),
    extentHiRef:    readExtentRef(bb, r.nested(CL.HI_REF)),
    extentLo:       r.i8(CL.HAS_LO) ? r.f64(CL.LO) : null,
    extentHi:       r.i8(CL.HAS_HI) ? r.f64(CL.HI) : null,
    discipline:     r.str(CL.DISC)  || 'arch',
    lineWeight:     r.f64(CL.LW)    || 0.15,
    lineType:       r.str(CL.LT)    || 'center',
    color:          r.str(CL.COL)   || '#000000',
  };
}

function readPT(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return { id: r.str(PT.ID), x: r.f64(PT.X), y: r.f64(PT.Y) };
}

function readWall(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:          r.str(WL.ID),
    axisCLId:    r.str(WL.AXIS_CL),
    axisOffset:  r.f64(WL.AXIS_OFF),
    isVertical:  r.i8(WL.IS_V) !== 0,
    clStartId:   r.str(WL.CL_S),
    startOffset: r.f64(WL.S_OFF),
    clEndId:     r.str(WL.CL_E),
    endOffset:   r.f64(WL.E_OFF),
    discipline:  r.str(WL.DISC) || 'arch',
    lineWeight:  r.f64(WL.LW)   || 0.25,
    lineType:    r.str(WL.LT)   || 'solid',
    color:       r.str(WL.COL)  || '#000000',
    isRoomWall:  r.i8(WL.IS_ROOM_WALL) !== 0,
    isExteriorWall: r.i8(WL.IS_EXTERIOR_WALL) !== 0,
    wallFinish:  r.i8(WL.HAS_WALL_FINISH) !== 0 ? r.f64(WL.WALL_FINISH) : null,
    // 旧データ（フィールド未保存）は HAS_ フラグが立たず null になる（=現行対称描画へ後方互換）
    backingOffset: r.i8(WL.HAS_BACKING_OFFSET) !== 0 ? r.f64(WL.BACKING_OFFSET) : null,
    backingDepth:  r.i8(WL.HAS_BACKING_DEPTH)  !== 0 ? r.f64(WL.BACKING_DEPTH)  : null,
  };
}

function readOpening(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:          r.str(OP.ID),
    axisCLId:    r.str(OP.AXIS_CL),
    wallSide:    r.i8(OP.WALL_SIDE) < 0 ? -1 : 1,
    isVertical:  r.i8(OP.IS_V) !== 0,
    refCLId:     r.str(OP.REF_CL),
    refOffset:   r.f64(OP.REF_OFF),
    width:       r.f64(OP.WIDTH),
    category:    OPENING_CATEGORY_DEC[r.i8(OP.CATEGORY)] ?? 'fitting',
    subType:     r.str(OP.SUB_TYPE) || null,
    hingeSide:   r.i8(OP.HINGE_SIDE) < 0 ? -1 : 1,
    swingSide:   r.i8(OP.SWING_SIDE) < 0 ? -1 : 1,
    discipline:  r.str(OP.DISC) || 'arch',
    lineWeight:  r.f64(OP.LW)   || 0.25,
    lineType:    r.str(OP.LT)   || 'solid',
    color:       r.str(OP.COL)  || '#000000',
  };
}

function readDiag(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:         r.str(DG.ID),
    nodeAId:    r.str(DG.A),
    nodeBId:    r.str(DG.B),
    discipline: r.str(DG.DISC) || 'arch',
    lineWeight: r.f64(DG.LW)   || 0.25,
    lineType:   r.str(DG.LT)   || 'solid',
    color:      r.str(DG.COL)  || '#000000',
  };
}

function readVLine(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:           r.str(VL.ID),
    clVerticalId: r.str(VL.CLV),
    clHStartId:   r.str(VL.CLH_S),
    clHEndId:     r.str(VL.CLH_E),
    discipline:   r.str(VL.DISC) || 'arch',
    lineWeight:   r.f64(VL.LW)   || 0.25,
    lineType:     r.str(VL.LT)   || 'solid',
    color:        r.str(VL.COL)  || '#000000',
  };
}

function readHLine(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:             r.str(HL.ID),
    clHorizontalId: r.str(HL.CLH),
    clVStartId:     r.str(HL.CLV_S),
    clVEndId:       r.str(HL.CLV_E),
    discipline:     r.str(HL.DISC) || 'arch',
    lineWeight:     r.f64(HL.LW)   || 0.25,
    lineType:       r.str(HL.LT)   || 'solid',
    color:          r.str(HL.COL)  || '#000000',
  };
}

function readArc(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:            r.str(AR.ID),
    centerId:      r.str(AR.CTR),
    radius:        r.f64(AR.RAD),
    startAngle:    r.f64(AR.SA),
    includedAngle: r.f64(AR.IA),
    discipline:    r.str(AR.DISC) || 'arch',
    lineWeight:    r.f64(AR.LW)   || 0.25,
    lineType:      r.str(AR.LT)   || 'solid',
    color:         r.str(AR.COL)  || '#000000',
  };
}

function readCircle(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:         r.str(CI.ID),
    centerId:   r.str(CI.CTR),
    radius:     r.f64(CI.RAD),
    discipline: r.str(CI.DISC) || 'arch',
    lineWeight: r.f64(CI.LW)   || 0.25,
    lineType:   r.str(CI.LT)   || 'solid',
    color:      r.str(CI.COL)  || '#000000',
  };
}

function readDimAnchor(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    clId:   r.str(DA.CL_ID) || null,
    offset: r.f64(DA.OFF),
    coord:  r.i8(DA.HAS_COORD) ? r.f64(DA.COORD) : null,
  };
}

function readDim(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:            r.str(DL.ID),
    axis:          r.i8(DL.AXIS) === 0 ? 'X' : 'Y',
    dimensionKind: DIM_KIND_DEC[r.i8(DL.KIND)] ?? 'grid',
    side:          SIDE_DEC[r.i8(DL.SIDE)]      ?? 'top',
    footLength:    r.f64(DL.FOOT),
    position:      r.i8(DL.HAS_POS) ? r.f64(DL.POS) : null,
    anchors:       r.vec(DL.ANCHORS, readDimAnchor),
    discipline:    r.str(DL.DISC) || 'arch',
    lineWeight:    r.f64(DL.LW)   || 0.15,
    lineType:      r.str(DL.LT)   || 'solid',
    color:         r.str(DL.COL)  || '#000000',
  };
}

function readRoom(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  const ovrKeys = r.strVec(RM.OVR_KEYS);
  const ovrVals = r.strVec(RM.OVR_VALS);
  const overrides = ovrKeys.map((key, i) => ({ key, value: ovrVals[i] ?? '' }));
  // 旧データ移行: kind==='void' で保存されたバッファは interior + feature=void として復元する
  // （FEATURE フィールド未設定の旧バッファは FlatBuffers のデフォルト値 0=none が返る）。
  let kind    = ROOM_KIND_DEC[r.i8(RM.KIND)] ?? 'interior';
  let feature = ROOM_FEATURE_DEC[r.i8(RM.FEATURE)] ?? null;
  if (kind === 'void') {
    kind = 'interior';
    feature = 'void';
  }
  return {
    id:               r.str(RM.ID),
    name:             r.str(RM.NAME),
    cells:            r.strVec(RM.CELLS),
    referenceRoomIds: r.strVec(RM.REF_IDS),
    generatedWallIds: r.strVec(RM.GEN_WALL_IDS),
    hasNamePosition:  r.i8(RM.HAS_POS) !== 0,
    posX:             r.f64(RM.POS_X),
    posY:             r.f64(RM.POS_Y),
    // 壁材(FIN_WALL)・天井高さ(FIN_CEIL_H)は内装マスター管理へ移行したため読み捨てる（旧データ破棄）
    finish: {
      floorMaterial:     r.str(RM.FIN_FLOOR),
      baseboardMaterial: r.str(RM.FIN_BASE_MAT),
      baseboardHeight:   r.str(RM.FIN_BASE_H),
      dadoMaterial:      r.str(RM.FIN_DADO_MAT),
      dadoHeight:        r.str(RM.FIN_DADO_H),
      ceilingMaterial:   r.str(RM.FIN_CEIL_MAT),
      cornice:           r.str(RM.FIN_CORNICE),
      note:              r.str(RM.FIN_NOTE),
    },
    kind,
    feature,
    templateKey: r.str(RM.TEMPLATE_KEY) || null,
    overrides,
    floorLevel: r.i8(RM.HAS_FLOOR_LEVEL) ? r.f64(RM.FLOOR_LEVEL) : null,
  };
}

function readEdge(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  const ovrKeys = r.strVec(ED.OVR_KEYS);
  const ovrVals = r.strVec(ED.OVR_VALS);
  const overrides = ovrKeys.map((key, i) => ({ key, value: ovrVals[i] ?? '' }));
  return {
    key:        r.str(ED.KEY),
    masterType: r.str(ED.MASTER_TYPE) || null,
    overrides,
  };
}

function readExteriorRow(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:     r.str(XR.ID),
    part:   r.str(XR.PART),
    finish: r.str(XR.FINISH),
    base:   r.str(XR.BASE),
    note:   r.str(XR.NOTE),
    roomId: r.str(XR.ROOM_ID) || null,
  };
}

function readStair(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:          r.str(ST.ID),
    type:        r.str(ST.TYPE) || 'straight',
    structure:   r.str(ST.STRUCTURE) || 'WOOD',
    cells:       r.strVec(ST.CELLS),
    totalSteps:  r.f64(ST.TOTAL_STEPS) || 15,
    tread:       r.f64(ST.TREAD) || 250,
    riser:       r.i8(ST.HAS_RISER) ? r.f64(ST.RISER) : null,
    nosing:      r.f64(ST.NOSING) || 30,
    width:       r.f64(ST.WIDTH) || 900,
    upDirection: r.str(ST.UP_DIR) || 'right',
    flip:        r.i8(ST.FLIP) !== 0,
    sections:    r.i8(ST.HAS_SECTIONS)
      ? (r.str(ST.SECTIONS) || '').split(',').filter(Boolean).map(Number)
      : null,
    roomId:      r.str(ST.ROOM_ID) || null, // 旧データ（フィールド欠落）は空文字列扱い→null
  };
}

// ----------------------------------------------------------------
// 構造モード（柱・梁・耐力壁・耐力壁開口・スラブ・基礎・柱脚・貫通孔）
// ----------------------------------------------------------------

function readColumn(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:             r.str(SC.ID),
    materialType:   MATERIAL_TYPE_DEC[r.i8(SC.MATERIAL)] ?? 'WOOD',
    sectionDefId:   r.str(SC.SECTION) || null,
    verticalCLId:   r.str(SC.VERT_CL),
    horizontalCLId: r.str(SC.HORIZ_CL),
    eccX:     r.f64(SC.ECC_X),
    eccY:     r.f64(SC.ECC_Y),
    rotation: r.f64(SC.ROTATION),
    role:     r.str(SC.ROLE) || 'standard',
    topLevel:    r.i8(SC.HAS_TOP)    ? r.f64(SC.TOP)    : null,
    bottomLevel: r.i8(SC.HAS_BOTTOM) ? r.f64(SC.BOTTOM) : null,
    memberNo:  r.str(SC.MEMBER_NO) || null,
    extraKeys: r.strVec(SC.EXTRA_KEYS),
    extraVals: r.strVec(SC.EXTRA_VALS),
  };
}

function readBeam(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:           r.str(SB.ID),
    materialType: MATERIAL_TYPE_DEC[r.i8(SB.MATERIAL)] ?? 'WOOD',
    sectionDefId: r.str(SB.SECTION) || null,
    axisCLId:     r.str(SB.AXIS_CL),
    isVertical:   r.i8(SB.IS_V) !== 0,
    clStartId:    r.str(SB.CL_S),
    clEndId:      r.str(SB.CL_E),
    eccentricity: r.f64(SB.ECC),
    jointStart:   r.str(SB.JOINT_S) || 'RIGID',
    jointEnd:     r.str(SB.JOINT_E) || 'RIGID',
    role:         r.str(SB.ROLE) || 'primary',
    levelOffset:      r.f64(SB.LEVEL_OFF),
    startLevelOffset: r.f64(SB.START_LEVEL_OFF),
    endLevelOffset:   r.f64(SB.END_LEVEL_OFF),
    memberNo:  r.str(SB.MEMBER_NO) || null,
    extraKeys: r.strVec(SB.EXTRA_KEYS),
    extraVals: r.strVec(SB.EXTRA_VALS),
  };
}

function readStructWall(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:           r.str(SW.ID),
    materialType: MATERIAL_TYPE_DEC[r.i8(SW.MATERIAL)] ?? 'RC',
    sectionDefId: r.str(SW.SECTION) || null,
    axisCLId:     r.str(SW.AXIS_CL),
    isVertical:   r.i8(SW.IS_V) !== 0,
    clStartId:    r.str(SW.CL_S),
    clEndId:      r.str(SW.CL_E),
    eccentricity: r.f64(SW.ECC),
    thickness:    r.f64(SW.THICKNESS) || 180,
    topLevel:     r.i8(SW.HAS_TOP) ? r.f64(SW.TOP) : null,
    bottomLevel:  r.f64(SW.BOTTOM),
    memberNo:  r.str(SW.MEMBER_NO) || null,
    extraKeys: r.strVec(SW.EXTRA_KEYS),
    extraVals: r.strVec(SW.EXTRA_VALS),
  };
}

function readStructWallOpening(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:     r.str(WO.ID),
    wallId: r.str(WO.WALL_ID),
    offset: r.f64(WO.OFFSET),
    width:  r.f64(WO.WIDTH),
    height: r.f64(WO.HEIGHT) || 2000,
    sillHeight: r.f64(WO.SILL),
    affectsEffectiveLength: r.i8(WO.AFFECTS_EFF_LEN) !== 0,
    extraKeys: r.strVec(WO.EXTRA_KEYS),
    extraVals: r.strVec(WO.EXTRA_VALS),
  };
}

function readSlab(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:           r.str(SL.ID),
    materialType: MATERIAL_TYPE_DEC[r.i8(SL.MATERIAL)] ?? 'RC',
    sectionDefId: r.str(SL.SECTION) || null,
    cells:        r.strVec(SL.CELLS),
    thickness:    r.f64(SL.THICKNESS) || 150,
    floorLevel:   r.i8(SL.HAS_FLOOR_LEVEL) ? r.f64(SL.FLOOR_LEVEL) : null,
    role:         r.str(SL.ROLE) || 'slab',
    levelRef:     r.str(SL.LEVEL_REF) || 'top',
    slopeDirX: r.i8(SL.HAS_SLOPE_DIR) ? r.f64(SL.SLOPE_DIR_X) : null,
    slopeDirY: r.i8(SL.HAS_SLOPE_DIR) ? r.f64(SL.SLOPE_DIR_Y) : null,
    slopeAngle: r.f64(SL.SLOPE_ANGLE),
    memberNo:  r.str(SL.MEMBER_NO) || null,
    extraKeys: r.strVec(SL.EXTRA_KEYS),
    extraVals: r.strVec(SL.EXTRA_VALS),
  };
}

function readFooting(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:   r.str(FT.ID),
    kind: r.str(FT.KIND) || 'independent',
    materialType: MATERIAL_TYPE_DEC[r.i8(FT.MATERIAL)] ?? 'RC',
    sectionDefId: r.str(FT.SECTION) || null,
    verticalCLId:   r.str(FT.VERT_CL),
    horizontalCLId: r.str(FT.HORIZ_CL),
    eccX: r.f64(FT.ECC_X),
    eccY: r.f64(FT.ECC_Y),
    topLevel:    r.i8(FT.HAS_TOP)    ? r.f64(FT.TOP)    : null,
    bottomLevel: r.i8(FT.HAS_BOTTOM) ? r.f64(FT.BOTTOM) : null,
    sectionShape: r.str(FT.SECTION_SHAPE) || 'rect',
    widthX: r.f64(FT.WIDTH_X) || 1000,
    widthY: r.f64(FT.WIDTH_Y) || 1000,
    memberNo:  r.str(FT.MEMBER_NO) || null,
    extraKeys: r.strVec(FT.EXTRA_KEYS),
    extraVals: r.strVec(FT.EXTRA_VALS),
  };
}

function readSleeve(bb, tablePos) {
  const r = makeReader(bb, tablePos);
  return {
    id:       r.str(SV.ID),
    hostType: r.str(SV.HOST_TYPE) || 'beam',
    hostBeamId:   r.str(SV.HOST_BEAM_ID)  || null,
    hostAxisCLId: r.str(SV.HOST_AXIS_CL)  || null,
    hostClStartId: r.str(SV.HOST_CL_S)    || null,
    hostClEndId:   r.str(SV.HOST_CL_E)    || null,
    localPos:     r.f64(SV.LOCAL_POS),
    heightOffset: r.f64(SV.HEIGHT_OFF),
    hostSlabId:  r.str(SV.HOST_SLAB_ID)  || null,
    hostCellKey: r.str(SV.HOST_CELL_KEY) || null,
    localX:   r.f64(SV.LOCAL_X),
    localY:   r.f64(SV.LOCAL_Y),
    diameter: r.f64(SV.DIAMETER) || 100,
    hasReinforcement: r.i8(SV.HAS_REINFORCEMENT) !== 0,
  };
}

// ================================================================
// PUBLIC API
// ================================================================

/**
 * snapshot オブジェクト (graphSnapshot.js の buildSnapshot 出力) を
 * FlatBuffers バイナリに変換する。
 */
export function encode(snapshot) {
  const b = new Builder(8192);

  const clVec        = writeVec(b, snapshot.centerLines     ?? [], writeCL);
  const ptVec        = writeVec(b, snapshot.points          ?? [], writePT);
  const wallVec      = writeVec(b, snapshot.walls           ?? [], writeWall);
  const openingVec   = writeVec(b, snapshot.openings        ?? [], writeOpening);
  const diagVec      = writeVec(b, snapshot.diagonals       ?? [], writeDiag);
  const vVec         = writeVec(b, snapshot.verticalLines   ?? [], writeVLine);
  const hVec         = writeVec(b, snapshot.horizontalLines ?? [], writeHLine);
  const arcVec       = writeVec(b, snapshot.arcs            ?? [], writeArc);
  const circVec      = writeVec(b, snapshot.circles         ?? [], writeCircle);
  const dimVec       = writeVec(b, snapshot.dimensionLines  ?? [], writeDim);
  const roomVec      = writeVec(b, snapshot.rooms           ?? [], writeRoom);
  const edgeVec      = writeVec(b, snapshot.edges           ?? [], writeEdge);
  const roomOrderVec = writeStrVec(b, snapshot.roomOrder    ?? []);
  const columnVec      = writeVec(b, snapshot.columns         ?? [], writeColumn);
  const beamVec        = writeVec(b, snapshot.beams           ?? [], writeBeam);
  const structWallVec  = writeVec(b, snapshot.structuralWalls ?? [], writeStructWall);
  const wallOpeningVec = writeVec(b, snapshot.wallOpenings    ?? [], writeStructWallOpening);
  const slabVec        = writeVec(b, snapshot.slabs           ?? [], writeSlab);
  const footingVec     = writeVec(b, snapshot.footings        ?? [], writeFooting);
  const sleeveVec      = writeVec(b, snapshot.sleeves         ?? [], writeSleeve);
  const excludedColumnSlotsVec  = writeStrVec(b, snapshot.excludedColumnSlots  ?? []);
  const excludedBeamSlotsVec    = writeStrVec(b, snapshot.excludedBeamSlots    ?? []);
  const excludedFootingSlotsVec = writeStrVec(b, snapshot.excludedFootingSlots ?? []);
  const tagRegistryKeysVec = writeStrVec(b, snapshot.tagRegistryKeys ?? []);
  const tagRegistryValsVec = writeStrVec(b, snapshot.tagRegistryVals ?? []);
  const columnAxisKeysVec = writeStrVec(b, snapshot.columnAxisOffsetKeys ?? []);
  const columnAxisValsVec = writeStrVec(b, snapshot.columnAxisOffsetVals ?? []);
  const stairVec      = writeVec(b, snapshot.stairs ?? [], writeStair);
  const stairOrderVec = writeStrVec(b, snapshot.stairOrder ?? []);
  const exteriorRowsVec        = writeVec(b, snapshot.exteriorRows        ?? [], writeExteriorRow);
  const exteriorFittingRowsVec = writeVec(b, snapshot.exteriorFittingRows ?? [], writeExteriorRow);
  const structureRowsVec       = writeVec(b, snapshot.structureRows       ?? [], writeExteriorRow);
  const sExtBacking  = b.createString(snapshot.exteriorWallBacking ?? '');
  const sIntBacking  = b.createString(snapshot.interiorWallBacking ?? '');
  const sCeilBacking = b.createString(snapshot.ceilingBacking      ?? '');
  const sFloorBacking = b.createString(snapshot.floorBacking       ?? '');
  const sStructureOverride = b.createString(snapshot.structureOverride ?? '');
  const structuralInfoOff  = writeStructuralInfo(b, snapshot.structuralInfo);

  b.startObject(42);
  b.addFieldOffset(GS.CLS,        clVec,        0);
  b.addFieldOffset(GS.PTS,        ptVec,        0);
  b.addFieldOffset(GS.WALLS,      wallVec,      0);
  b.addFieldOffset(GS.DIAGS,      diagVec,      0);
  b.addFieldOffset(GS.VLINES,     vVec,         0);
  b.addFieldOffset(GS.HLINES,     hVec,         0);
  b.addFieldOffset(GS.ARCS,       arcVec,       0);
  b.addFieldOffset(GS.CIRCS,      circVec,      0);
  b.addFieldOffset(GS.DIMS,       dimVec,       0);
  b.addFieldOffset(GS.ROOMS,      roomVec,      0);
  b.addFieldOffset(GS.ROOM_ORDER, roomOrderVec, 0);
  b.addFieldOffset(GS.EXTERIOR_WALL_BACKING, sExtBacking, 0);
  b.addFieldFloat64(GS.FLOOR_DATUM,          snapshot.floorDatum ?? 0, 0.0);
  b.addFieldOffset(GS.EDGES,                 edgeVec,     0);
  b.addFieldOffset(GS.INTERIOR_WALL_BACKING, sIntBacking,   0);
  b.addFieldOffset(GS.CEILING_BACKING,       sCeilBacking,  0);
  b.addFieldOffset(GS.FLOOR_BACKING,         sFloorBacking, 0);
  b.addFieldFloat64(GS.DEFAULT_FLOOR_LEVEL,    snapshot.defaultFloorLevel    ?? 0, 0.0);
  b.addFieldFloat64(GS.DEFAULT_CEILING_HEIGHT, snapshot.defaultCeilingHeight ?? 0, 0.0);
  b.addFieldOffset(GS.OPENINGS,              openingVec,    0);
  b.addFieldOffset(GS.STRUCTURE_OVERRIDE,    sStructureOverride, 0);
  b.addFieldOffset(GS.STRUCTURAL_INFO,       structuralInfoOff,  0);
  b.addFieldOffset(GS.COLUMNS,       columnVec,      0);
  b.addFieldOffset(GS.BEAMS,         beamVec,        0);
  b.addFieldOffset(GS.STRUCT_WALLS,  structWallVec,  0);
  b.addFieldOffset(GS.WALL_OPENINGS, wallOpeningVec, 0);
  b.addFieldOffset(GS.SLABS,         slabVec,        0);
  b.addFieldOffset(GS.FOOTINGS,      footingVec,     0);
  b.addFieldOffset(GS.SLEEVES,       sleeveVec,      0);
  b.addFieldOffset(GS.EXCLUDED_COLUMN_SLOTS,  excludedColumnSlotsVec,  0);
  b.addFieldOffset(GS.EXCLUDED_BEAM_SLOTS,    excludedBeamSlotsVec,    0);
  b.addFieldOffset(GS.EXCLUDED_FOOTING_SLOTS, excludedFootingSlotsVec, 0);
  b.addFieldOffset(GS.TAG_REGISTRY_KEYS, tagRegistryKeysVec, 0);
  b.addFieldOffset(GS.TAG_REGISTRY_VALS, tagRegistryValsVec, 0);
  b.addFieldOffset(GS.COLUMN_AXIS_KEYS, columnAxisKeysVec, 0);
  b.addFieldOffset(GS.COLUMN_AXIS_VALS, columnAxisValsVec, 0);
  b.addFieldOffset(GS.STAIRS,        stairVec,      0);
  b.addFieldOffset(GS.STAIR_ORDER,   stairOrderVec, 0);
  b.addFieldOffset(GS.EXTERIOR_ROWS,         exteriorRowsVec,        0);
  b.addFieldOffset(GS.EXTERIOR_FITTING_ROWS, exteriorFittingRowsVec, 0);
  b.addFieldOffset(GS.STRUCTURE_ROWS,        structureRowsVec,       0);
  const root = b.endObject();

  b.finish(root);
  return b.asUint8Array().slice();
}

/**
 * FlatBuffers バイナリから snapshot オブジェクトを復元する。
 */
export function decode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bb = new ByteBuffer(u8);
  const rootPos = bb.readInt32(bb.position()) + bb.position();

  const r = makeReader(bb, rootPos);
  return {
    centerLines:     r.vec(GS.CLS,        readCL),
    points:          r.vec(GS.PTS,        readPT),
    walls:           r.vec(GS.WALLS,      readWall),
    diagonals:       r.vec(GS.DIAGS,      readDiag),
    verticalLines:   r.vec(GS.VLINES,     readVLine),
    horizontalLines: r.vec(GS.HLINES,     readHLine),
    arcs:            r.vec(GS.ARCS,       readArc),
    circles:         r.vec(GS.CIRCS,      readCircle),
    dimensionLines:  r.vec(GS.DIMS,       readDim),
    rooms:           r.vec(GS.ROOMS,      readRoom),
    roomOrder:       r.strVec(GS.ROOM_ORDER),
    exteriorWallBacking: r.str(GS.EXTERIOR_WALL_BACKING) || null,
    interiorWallBacking: r.str(GS.INTERIOR_WALL_BACKING) || null,
    ceilingBacking:      r.str(GS.CEILING_BACKING)       || null,
    floorBacking:        r.str(GS.FLOOR_BACKING)         || null,
    defaultFloorLevel:    r.f64(GS.DEFAULT_FLOOR_LEVEL),
    defaultCeilingHeight: r.f64(GS.DEFAULT_CEILING_HEIGHT) || null, // 0 = 旧データ（未保存）→ 既定(2400)を維持
    floorDatum:          r.f64(GS.FLOOR_DATUM),
    edges:               r.vec(GS.EDGES, readEdge),
    openings:            r.vec(GS.OPENINGS, readOpening),
    structureOverride:   r.str(GS.STRUCTURE_OVERRIDE) || null,
    structuralInfo:      readStructuralInfo(bb, r.nested(GS.STRUCTURAL_INFO)),
    columns:             r.vec(GS.COLUMNS,       readColumn),
    beams:               r.vec(GS.BEAMS,         readBeam),
    structuralWalls:     r.vec(GS.STRUCT_WALLS,  readStructWall),
    wallOpenings:        r.vec(GS.WALL_OPENINGS, readStructWallOpening),
    slabs:               r.vec(GS.SLABS,         readSlab),
    footings:            r.vec(GS.FOOTINGS,      readFooting),
    sleeves:             r.vec(GS.SLEEVES,       readSleeve),
    excludedColumnSlots:  r.strVec(GS.EXCLUDED_COLUMN_SLOTS),
    excludedBeamSlots:    r.strVec(GS.EXCLUDED_BEAM_SLOTS),
    excludedFootingSlots: r.strVec(GS.EXCLUDED_FOOTING_SLOTS),
    tagRegistryKeys: r.strVec(GS.TAG_REGISTRY_KEYS),
    tagRegistryVals: r.strVec(GS.TAG_REGISTRY_VALS),
    columnAxisOffsetKeys: r.strVec(GS.COLUMN_AXIS_KEYS),
    columnAxisOffsetVals: r.strVec(GS.COLUMN_AXIS_VALS),
    stairs:          r.vec(GS.STAIRS, readStair),
    stairOrder:      r.strVec(GS.STAIR_ORDER),
    exteriorRows:        r.vec(GS.EXTERIOR_ROWS,         readExteriorRow),
    exteriorFittingRows: r.vec(GS.EXTERIOR_FITTING_ROWS, readExteriorRow),
    structureRows:       r.vec(GS.STRUCTURE_ROWS,        readExteriorRow),
  };
}
