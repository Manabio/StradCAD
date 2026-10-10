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
  CEILING: 'ceiling', // 天井芯（天伏モードの天井セルだけを割る線。種別 'ceiling'）
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

// 屋外部屋の仕上げレベル（おさえ）の基準
export const ExteriorLevelRef = Object.freeze({
  ROOM: 'room', // 部屋内レベル
  GL:   'gl',   // GL
});

// 部屋の属性軸（feature） — kind とは独立。相互排他・個別ON/OFF可。null = なし。
export const RoomFeature = Object.freeze({
  STAIR:      'stair',     // 階段
  VOID:       'void',      // 吹抜け（ユーザー指定）
  STAIR_VOID: 'stairVoid', // 階段吹抜け（最上階の屋内階段footprintへ自動指定。描画・操作対象外の自動管理Room）
  UNDEFINED:  'undefined', // 未定義の部屋（削除後も外壁線維持のため一時的に残す。仕上げ表から除外・無描画）
  // 昇降機（建築基準法上の総称。分類＝EV／エスカレーター／DW は器具行が持つ。この属性の
  // Room が昇降路）。床なし＝上階スラブ開口。展開図は描かない（ユーザー裁定2026-09-29:
  // 「昇降機の中にEV/エスカレーター/DWがある。昇降機とEV等は並列ではない」）。
  ELEVATOR_EQUIPMENT: 'elevatorEquipment',
  // 屋根（下屋＝屋根面がある階のセルに付く）。kind は EXTERIOR に固定。壁・境界・2a委譲の判定では
  // 「部屋の無いセル」と同値（finish/edgeClassify.js isEnclosureOutside。外壁の内外判定が feature を
  // 見る唯一の例外）。
  ROOF:       'roof',
});

export function isRoofFeature(feature) {
  return feature === RoomFeature.ROOF;
}

// 屋根の Room.name は固定（編集口なし。ユーザー裁定: 屋根に名前は付けない）。
export const ROOF_ROOM_NAME = '屋根';

// 屋根の形状（RoofSpec.shape。null＝自動で、表示時に finish/roof/roofDefaults.js resolveRoofShape が導く）。
// 陸屋根は下屋でも選べる（既定になるのは非木造の主屋根だけ＝B3）。
export const RoofShape = Object.freeze({
  MONO:      'mono',      // 片流れ
  GABLE:     'gable',     // 切妻
  HIP:       'hip',       // 寄棟
  STAGGERED: 'staggered', // 棟違い
  FLAT:      'flat',      // 陸屋根
});
export const ROOF_SHAPE_LABELS = Object.freeze({
  [RoofShape.MONO]:      '片流れ',
  [RoofShape.GABLE]:     '切妻',
  [RoofShape.HIP]:       '寄棟',
  [RoofShape.STAGGERED]: '棟違い',
  [RoofShape.FLAT]:      '陸屋根',
});
// 天井区画の形状（CeilingZone.shape。core/ceilingZone.js）。S5 は 'flat' だけを使う（傾斜・円弧・ドームは S6 以降。箱だけ先に持つ）。
export const CeilingShape = Object.freeze({
  FLAT:  'flat',  // 平面
  SLOPE: 'slope', // 傾斜
  ARC:   'arc',   // 円弧
  DOME:  'dome',  // ドーム
});
// 片流れの高い側（RoofSpec.highSide。null＝自動で、表示時に finish/roof/roofGeometry.js resolveRoofHighSide が導く）。
// y 軸は下向き正なので top＝y が小さい辺、left＝x が小さい辺。
export const RoofHighSide = Object.freeze({
  TOP:    'top',
  BOTTOM: 'bottom',
  LEFT:   'left',
  RIGHT:  'right',
});
export const ROOF_HIGH_SIDE_LABELS = Object.freeze({
  [RoofHighSide.TOP]:    '上',
  [RoofHighSide.BOTTOM]: '下',
  [RoofHighSide.LEFT]:   '左',
  [RoofHighSide.RIGHT]:  '右',
});
// 切妻の棟木の向き（RoofSpec.ridgeDirection。null＝自動で長手に沿う＝既定。表示時・構造再計算時に
// finish/roof/roofGeometry.js resolveRoofRidgeIsVertical が導く）。切妻だけに効く（寄棟は棟木が長手に沿わないと成り立たない）。
export const RoofRidgeDirection = Object.freeze({
  VERTICAL:   'vertical',   // 棟木が y 方向（縦）
  HORIZONTAL: 'horizontal', // 棟木が x 方向（横）
});
export const ROOF_RIDGE_DIRECTION_LABELS = Object.freeze({
  [RoofRidgeDirection.VERTICAL]:   '縦',
  [RoofRidgeDirection.HORIZONTAL]: '横',
});
// 形状の自動判定: 短手（屋根範囲に内接する全矩形の短辺の最大）がこの値以下なら片流れ、超えれば切妻。
export const ROOF_MONO_MAX_SHORT_SPAN_MM = 3640;

// 屋根の既定値（RoofSpec）
export const DEFAULT_ROOF_SLOPE = 3;                  // 勾配 N/10 の N（屋外部屋の exteriorSlope＝1/N とは別）
export const DEFAULT_ROOF_EAVE_OVERHANG_MM = 455;     // 軒の出幅
export const DEFAULT_ROOF_GABLE_OVERHANG_MM = 455;    // 妻側の出幅
export const DEFAULT_ROOF_SHEATHING = '101200000008'; // 野地板: 構造用合板 t=12（面材）
export const DEFAULT_ROOF_UNDERLAYMENT = '302000000003'; // 防水シート: 改質アスファルトルーフィング
export const DEFAULT_ROOF_NOTE = '下野';               // 下屋（セルに付けた屋根）の備考の付与時の既定

// 屋根の野地板・防水シートの選択肢（材料コード。名前は材データから引く。並びは表示順）。
// 野地板: 構造用合板（t=9/12/15/24/28）→ 硬質木片 → 高圧木毛 → 硬質木毛 → 断熱・複合耐火（各 t=15/18/25/30）。
export const ROOF_SHEATHING_CODES = Object.freeze([
  '101200000007', '101200000008', '101200000009', '101200000010', '101200000011',
  '301000000021', '301000000022', '301000000023', '301000000024',
  '301000000025', '301000000026', '301000000027', '301000000028',
  '301000000029', '301000000030', '301000000031', '301000000032',
  '301000000033', '301000000034', '301000000035', '301000000036',
]);
export const ROOF_UNDERLAYMENT_CODES = Object.freeze([
  '302000000007', // アスファルトルーフィング
  '302000000003', // 改質アスファルトルーフィング
  '302000000008', // 粘着層付きルーフィング
  '302000000009', // 透湿防水ルーフィング
]);

// 昇降路（isShaftFeature の部屋）の属性。床なし＝上階スラブ開口・展開図は描かない・共通仕様
// 「昇降路」で壁材を一括指定。PS 等は後日。
export const SHAFT_FEATURES = Object.freeze(new Set([
  RoomFeature.ELEVATOR_EQUIPMENT,
]));
export function isShaftFeature(feature) {
  return SHAFT_FEATURES.has(feature);
}

// 昇降機の分類（器具行が持つ。今回追加できるのはEVのみ。'dw'／'escalator'は先送り）。
export const ElevatorEquipmentCategory = Object.freeze({ EV: 'ev' });

// EV（昇降機の分類の1つ）の用途。
export const EvUsage = Object.freeze({
  PASSENGER:          'passenger',         // 乗用
  PASSENGER_FREIGHT:  'passengerFreight',  // 人荷用
  FREIGHT:            'freight',           // 荷物用
});
export const DEFAULT_EV_USAGE = EvUsage.PASSENGER;

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

// 折返し・回り階段の出入口（上り口・到達口）の辺。LEFT/RIGHT は「その口を歩くときの進行方向」
// （上り口は upDirection、U字の到達口は逆向き）から見た向きで、flip に依存しない（finish/stair/stairPorts.js）。
// null=自動（張り出しがあれば隣レーン側＝内側相当、無ければ end）。旧値 'inner'/'outer' は読込みで null に落とす。
export const StairPortSide = Object.freeze({
  END:   'end',   // 走行端（レーン基端の辺）
  LEFT:  'left',  // 進行方向の左の辺
  RIGHT: 'right', // 進行方向の右の辺
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
export const DEFAULT_WALL_MATERIAL         = '301000000002'; // 部屋の壁材既定: せっこうボード t=12.5（面材）
export const DEFAULT_CEILING_PANEL         = '301000000001'; // 部屋の天井材既定: せっこうボード t=9.5（面材。customOverrides.ceilingPanel の読み時補完）
export const DEFAULT_CEILING_FINISH        = '302000000001'; // 部屋の天井仕上げ既定: ビニールクロス（customOverrides.ceilingFinish の読み時補完）
export const DEFAULT_EXTERIOR_WALL_BACKING = '101400000005'; // 外壁下地: □-90×45 間柱（下地材）
export const DEFAULT_INTERIOR_WALL_BACKING = '101400000005'; // 内壁下地: □-90×45 間柱（下地材）
export const DEFAULT_CEILING_BACKING       = '101400000012'; // 天井下地: □-45×36 杉等・野縁（下地材、表示のみ）
export const DEFAULT_FLOOR_BACKING         = '101400000007'; // 床下地: □-60×45 杉・松等・床根太（下地材、表示のみ）

// 昇降路（isShaftFeature の部屋）の壁仕上げ材・防音材（共通仕様タブ per-floor 設定）
export const DEFAULT_SHAFT_WALL_MATERIAL = '301000000002'; // 昇降路壁材既定: せっこうボード t=12.5（面材）
export const SHAFT_WALL_MATERIAL_CODES = Object.freeze([
  '301000000002', // せっこうボード t=12.5
  '301000000005', // 強化せっこうボード t=12.5
  '301000000020', // 強化せっこうボード t=12.5+12.5
]);
export const ShaftSoundproof = Object.freeze({
  NONE:      'none',
  INSULATION: 'insulation',
});
export const DEFAULT_SHAFT_SOUNDPROOF = ShaftSoundproof.NONE;

// 部屋の既定値（共通仕様タブで per-floor に変更可能）
export const DEFAULT_ROOM_FLOOR_LEVEL    = 0;    // FL初期値: 当該階FLからの相対高さmm（±0）
export const DEFAULT_ROOM_CEILING_HEIGHT = 2400; // CH初期値: 部屋の床面から天井までの距離mm

// CL（中心線）の重複判定許容誤差(mm)。追加時の重複ガード（transform/centerLineOps.js）・梁芯移動の範囲クランプ内寄せ
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
