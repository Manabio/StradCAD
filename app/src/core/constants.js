/**
 * コア定数（enum・既定値）
 *
 * core.js から分離した、依存ゼロの値オブジェクト群。
 * 後方互換のため core.js が全シンボルを再エクスポートしている。
 */

export const Discipline = Object.freeze({
  ARCH:   'arch',    // 意匠
  STRUCT: 'struct',  // 構造
  FUSE:   'fuse',    // 伏図
  MEP:    'mep',     // 設備
  ELEC:   'elec',    // 電気
});

export const ShapeType = Object.freeze({
  VERTICAL:   'vertical',
  HORIZONTAL: 'horizontal',
  DIAGONAL:   'diagonal',
  ARC:        'arc',
  CIRCLE:     'circle',
  WALL:       'wall',
  OPENING:    'opening',
});

// 開口の大区分: 建具(戸) / 窓
export const OpeningCategory = Object.freeze({
  FITTING: 'fitting',
  WINDOW:  'window',
});

// 図形の種別: 一般図形 / 寸法図形
export const ShapeKind = Object.freeze({
  GENERAL:   'general',    // 一般図形 — 壁・開口・仕上げ等
  DIMENSION: 'dimension',  // 寸法図形 — 中心線・おさえ
});

// 中心線の軸種別 — 自動命名の接頭辞と整列基準を決定する
export const CenterLineType = Object.freeze({
  VERTICAL:   'X',  // 垂直中心線 — value = x座標, 左→右昇順で X1, X2, ...
  HORIZONTAL: 'Y',  // 水平中心線 — value = y座標, 下→上昇順で Y1, Y2, ...
  RADIAL:     'R',  // 放射中心線 — value = 角度(度),  挿入順で  R1, R2, ...
});

// 部屋の内外区分（base軸）
// Room.kind に代入してよいのは INTERIOR / EXTERIOR のみ。
// VOID は旧データ（FlatBuffers等）のデコード時にのみ現れる値で、読込時に
// { kind: INTERIOR, feature: RoomFeature.VOID } へ移行する（書き込みは常に新形式）。
export const RoomKind = Object.freeze({
  INTERIOR: 'interior',  // 屋内
  VOID:     'void',      // 旧データ移行専用（新規に設定しない）
  EXTERIOR: 'exterior',  // 屋外
});

// 部屋の属性軸（feature） — kind とは独立。相互排他・個別ON/OFF可。null = なし。
export const RoomFeature = Object.freeze({
  STAIR:      'stair',     // 階段
  VOID:       'void',      // 吹抜け（ユーザー指定）
  STAIR_VOID: 'stairVoid', // 階段吹抜け（最上階の屋内階段footprintへ自動指定。描画・操作対象外の自動管理Room）
  UNDEFINED:  'undefined', // 未定義の部屋（削除後も外壁線維持のため一時的に残す。仕上げ表から除外・無描画）
});

// 階段タイプ（MVPは STRAIGHT のみ実装。他は順次拡張）
export const StairType = Object.freeze({
  STRAIGHT:         'straight',         // 直進
  STRAIGHT_LANDING: 'straight_landing', // 踊り場付直進
  SWITCHBACK:       'switchback',       // 屈折（折り返し）
  WINDING:          'winding',          // 回り
  L_TURN:           'l_turn',           // 矩折
  FLARED:           'flared',           // 曲がり
  OPEN_WELL:        'open_well',        // 中空き
});

// 構造材の種別（柱・梁共通）
export const StructuralMaterialType = Object.freeze({
  WOOD:  'WOOD',
  STEEL: 'STEEL',
  RC:    'RC',
});

// 画面描画における線の太さの標準パレット（mm）。出図A2/A3セット準拠。
// ワールドmm系（Shape.lineWeight、構造部材の輪郭線）と
// 画面定数系（viewport.lineWeightsPx）の両方がこの定義だけを参照する。
// A1・A4/A5以下セットは出図機能の実装時に追加する。
export const LINE_WEIGHT_MM = Object.freeze({
  ultraThick: 0.5,
  thick:      0.35,
  medium:     0.25,
  thin:       0.13,
});

// 寸法線の種別
export const DimensionKind = Object.freeze({
  GRID:    'grid',     // 通り芯寸法
  CENTER:  'center',   // 中心線寸法
  CONTROL: 'control',  // おさえ寸法
});

export const DimensionSide = Object.freeze({
  TOP:    'top',
  BOTTOM: 'bottom',
  LEFT:   'left',
  RIGHT:  'right',
});

// 既定材コード（材マスタ materialData.js 参照）
export const DEFAULT_WALL_MATERIAL         = '111111111166'; // 部屋の壁材既定: せっこうボード t=12.5（面材）
export const DEFAULT_EXTERIOR_WALL_BACKING = '111111111155'; // 外壁下地: □-90×45 間柱（下地材）
export const DEFAULT_INTERIOR_WALL_BACKING = '111111111155'; // 内壁下地: □-90×45 間柱（下地材）
export const DEFAULT_CEILING_BACKING       = '111111111162'; // 天井下地: □-45×36 杉等・野縁（下地材、表示のみ）
export const DEFAULT_FLOOR_BACKING         = '111111111157'; // 床下地: □-60×45 杉・松等・床根太（下地材、表示のみ）

// 部屋の既定値（共通仕様タブで per-floor に変更可能）
export const DEFAULT_ROOM_FLOOR_LEVEL    = 0;    // FL初期値: 当該階FLからの相対高さmm（±0）
export const DEFAULT_ROOM_CEILING_HEIGHT = 2400; // CH初期値: 部屋の床面から天井までの距離mm

// CL（中心線）の重複判定許容誤差(mm)。追加時の重複ガード（App.jsx）・梁芯移動の範囲クランプ内寄せ
// （structural/beamAxisMove.js）の両方が同じ値・同じ目的（他CLと同一座標に到達させない）で共有する。
export const CL_OVERLAP_TOL_MM = 0.5;

// 敷地線の種別
export const SiteLineKind = Object.freeze({
  BOUNDARY:   'boundary',   // 境界（隣地境界線）
  ROAD:       'road',       // 道路境界
  SURVEY:     'survey',     // 測量
  ROAD_WIDTH: 'roadWidth',  // 道路幅員
  OTHER:      'other',      // その他
});
