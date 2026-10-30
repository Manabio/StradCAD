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
// 屋根区画（PlanGraph.roofZones[].spec）の材料コード参照の location（catalog/codeNormalization.js）とその表示名
export const ROOF_ZONE_SPEC_LOCATION = 'roofZoneSpec';
export const ROOF_ZONE_LABEL = '屋根区画';
// 外部タブ（finish/exteriorGroups.js buildExteriorGroups）の群の種別
export const ExteriorGroupType = Object.freeze({
  MAIN_ROOF: 'mainRoof',  // 主屋根（区画以外の範囲。セルを持たない固定の群）
  ROOF:      'roof',      // 屋根セルの群（下屋）
  ROOF_ZONE: 'roofZone',  // 屋根区画の群（PlanGraph.roofZones の1件）
  ROOM:      'room',      // roomId 連動群
  PART:      'part',      // 手入力の部位群
});
export const ROOF_ZONE_GROUP_KEY_PREFIX = 'roofZone:';          // 区画の群の key ＝ 接頭辞 + zone.id
export const MAIN_ROOF_GROUP_LABEL_WITH_ZONES = '屋根（主屋根・区画以外）'; // 区画が1件以上あるときの主屋根の群の見出し
export const ROOF_ZONE_EMPTY_SUFFIX = '（範囲なし）';             // 実効セルが0の区画の見出しに付ける
// 天伏パネル外部タブ（軒裏）の行の種別と、区画の行の id 接頭辞・見出し（'軒裏（屋根区画' + n + '）'）
export const SoffitRowKind = Object.freeze({
  LEAN_TO: 'leanTo', // 直上階の下屋（表示のみ）
  MAIN:    'main',   // 最上階の主屋根（区画以外）
  ZONE:    'zone',   // 最上階の屋根区画
});
export const SOFFIT_ROW_ZONE_ID_PREFIX = 'soffit:zone:';
export const SOFFIT_ZONE_ROW_LABEL_PREFIX = '軒裏（屋根区画';
export const SOFFIT_ZONE_ROW_LABEL_SUFFIX = '）';
// 形状の自動判定: 短手（屋根範囲に内接する全矩形の短辺の最大）がこの値以下なら片流れ、超えれば切妻。
export const ROOF_MONO_MAX_SHORT_SPAN_MM = 3640;

// 屋根の既定値（RoofSpec）
export const DEFAULT_ROOF_SLOPE = 3;                  // 勾配 N/10 の N（屋外部屋の exteriorSlope＝1/N とは別）
export const DEFAULT_ROOF_EAVE_OVERHANG_MM = 455;     // 軒の出幅
export const DEFAULT_ROOF_GABLE_OVERHANG_MM = 455;    // 妻側の出幅
export const DEFAULT_ROOF_SHEATHING = '101200000008'; // 野地板: 構造用合板 t=12（面材）
export const DEFAULT_ROOF_UNDERLAYMENT = '302000000003'; // 防水シート: 改質アスファルトルーフィング
export const DEFAULT_ROOF_NOTE = '下野';               // 下屋（セルに付けた屋根）の備考の付与時の既定
// 軒裏（RoofSpec.soffit*）の既定値。RoofSpec 自体は空（''・null）を既定に持ち、読み替えは finish/roof/roofDefaults.js resolveSoffitSpec が行う。
// 下屋を付けた時点で材コード・向き・備考を保存する（材料コードは保存されていないと使用コードの収集・照合に乗らないため）。
export const DEFAULT_SOFFIT_MATERIAL = '301000000015'; // 軒裏仕上げ材: けい酸カルシウム板 t=8
export const DEFAULT_SOFFIT_BACKING = '101400000015';  // 軒裏下地材: □-30×15（木造の場合。軒天野縁）
export const DEFAULT_SOFFIT_NOTE = '目透かし貼り';      // 下屋の軒裏の備考の付与時の既定
// 軒裏の向き（RoofSpec.soffitOrientation。null＝傾斜）。傾斜＝屋根勾配なり、水平＝地面に対して水平。
export const SoffitOrientation = Object.freeze({
  SLOPED: 'sloped',
  LEVEL:  'level',
});

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

// 階段の裏面の仕上げ（階段の属性 soffitFinish）。FINISHED=天井仕上げあり・EXPOSED=あらわし。
// null=未設定＝構造で決まる（木造＝仕上げ・それ以外＝あらわし。ceiling/stairSoffit.js stairSoffitFinished）。
export const StairSoffitFinish = Object.freeze({
  EXPOSED:  'exposed',
  FINISHED: 'finished',
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

// SVG 図（建具モード姿図・構造断面図）のプリミティブ型。生成元は structural/sectionFigure/svgFigurePrimitives.js、
// 消費側は AutoScaledFigure.jsx の renderPrimitive（case の並びはそれに合わせる）。展開図（Konva）の語彙とは別。
export const SvgFigurePrimitiveType = Object.freeze({
  RECT:       'rect',
  CIRCLE:     'circle',
  LINE:       'line',
  POLYLINE:   'polyline',
  H_SECTION:  'hSection',
  TEXT:       'text',
  ARROW:      'arrow',
  AXIS_V:     'axisV',
  LEVEL_LINE: 'levelLine',
  DIM:        'dim',
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
export const DEFAULT_EXTERIOR_CEILING_PANEL = '301000000015'; // 屋外部屋の天井材既定: けい酸カルシウム板 t=8（軒裏の DEFAULT_SOFFIT_MATERIAL と同じ材。概念は別）（天井仕上げは既定なし。getFinishInfo の読み時補完）
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

// 木造階段の裏（天伏の傾斜天井）の厚み(mm): 踏面表面から裏の天井仕上げ材の面までを、階段の傾斜に**直交して**測った厚み
// （踏面の厚みではない）。垂直方向の下がりは 厚み / cosθ（tanθ = 蹴上 / 踏面）。ceiling/stairSoffit.js が使う。
export const STAIR_SOFFIT_THICKNESS_MM = 300;

// CL（中心線）の重複判定許容誤差(mm)。追加時の重複ガード（transform/centerLineOps.js）・梁芯移動の範囲クランプ内寄せ
// （structural/beamAxisMove.js）の両方が同じ値・同じ目的（他CLと同一座標に到達させない）で共有する。
export const CL_OVERLAP_TOL_MM = 0.5;

// 梁の役割（Beam.role）。新規コードでだけ使う（既存の文字列直書きは置換しない）。
export const BeamRole = Object.freeze({
  PRIMARY:        'primary',        // 大梁
  SECONDARY:      'secondary',      // 小梁
  FLOOR:          'floor',          // 床梁
  FOUNDATION:     'foundation',     // 基礎梁
  EAVES:          'eaves',          // 軒桁
  ROOF:           'roof',           // 屋根平面の梁
  LANDING:        'landing',        // 階段踊り場の梁
  ROOF_BEAM:      'roofBeam',       // 小屋梁・飛び梁
  SILL:           'sill',           // 土台
  PARTITION_BEAM: 'partitionBeam',  // 隔て梁
});

// S造スラブを支える子梁（小梁）の最大ピッチ(mm)。スパン間をこれ以下の等間隔に割り付ける
// （structural/slabSecondaryBeamAxes.js。ユーザー指示2026-10-26）。
export const STEEL_SECONDARY_BEAM_MAX_PITCH_MM = 2500;
// S造スラブのブレース（丸鋼・L型鋼）の対角長の上限(mm)。ブレース種別ごと。ブレースの割付けで対角が
// これを超えるベイは割り付けない（ユーザー指示 問題.md 2026-10-29。メモの「7000m/12000m」は mm の誤記）。
// 子梁の分割数 n の決定（framingCells.js divideBayByMaxDiagonal）が structureRules.js
// slabSecondaryBeams.braceMaxDiagonalMm 経由で使う。
export const STEEL_BRACE_MAX_DIAGONAL_MM = Object.freeze({ roundBar: 7000, angle: 12000 });
// スラブ小梁の割付けで、断面がカタログで引けない梁（境界の大梁・子梁）の幅の代わりに使う断面（幅150。
// ユーザー裁定 2026-10-28「とりあえず H-300×150×6.5×9、幅は150」。structural/slabSecondaryBeamAxes.js）。
export const SLAB_BEAM_WIDTH_FALLBACK_SECTION_ID = 'STEEL-H300x150';
// スラブ小梁の割付け方式（structureRules.js の slabSecondaryBeams.kind）。
export const SlabSecondaryBeamPlacement = Object.freeze({ EQUAL_PITCH: 'equalPitch' });
// スラブ小梁の梁芯を作らなかったベイの理由（slabSecondaryBeamAxes.js）。
export const SlabBayFillSkip = Object.freeze({
  SHORT_SPAN: 'shortSpan', // 短辺が最大ピッチ以下
  OPENING:    'opening',   // 床開口と重なる
  NO_HOST:    'noHost',    // 端に受ける大梁（通り芯上の primary）が無い
  OCCUPIED:   'occupied',  // ベイ内に既に梁芯がある（冪等・手動の梁芯を尊重）
  BRACE_NO_DIVISION: 'braceNoDivision', // ブレースのベイで、割らなくても対角長が上限以内（n=1。子梁は不要）
});

// スラブ小梁の枠キー（PlanGraph.excludedSlabBeamSlots）の名前空間。他の除外集合のキーと区別する前置き
// （structural/slabSecondaryBeamAxes.js slabBeamSlotKey）。
export const SLAB_BEAM_SLOT_KEY_PREFIX = 'slab';

// ---- S造スラブの仕様（structural/steelSlabSpec.js。ユーザー指示 問題.md 2026-10-29「S造スラブ指定」）----
// スラブの種別。共通仕様（StructuralInfo.steelSlabSpec）と個別仕様（SteelSlab.steelSpec）が同じ選択肢を持つ。
export const SteelSlabKind = Object.freeze({
  DECK:      'deck',      // デッキプレート（既定）
  FLAT_DECK: 'flatDeck',  // フラットデッキ
  BRACE:     'brace',     // ブレース
  ALC:       'alc',       // ALC
});
export const STEEL_SLAB_KIND_LABELS = Object.freeze({
  [SteelSlabKind.DECK]:      'デッキプレート',
  [SteelSlabKind.FLAT_DECK]: 'フラットデッキ',
  [SteelSlabKind.BRACE]:     'ブレース',
  [SteelSlabKind.ALC]:       'ALC',
});
// コンクリート種別（デッキ・フラットデッキ共通）。
export const SlabConcreteType = Object.freeze({ NORMAL: 'normal', LIGHTWEIGHT: 'lightweight' });
export const SLAB_CONCRETE_TYPE_LABELS = Object.freeze({
  [SlabConcreteType.NORMAL]:      '普通',
  [SlabConcreteType.LIGHTWEIGHT]: '軽量',
});
// ブレース種別。
export const BraceMemberType = Object.freeze({ ROUND_BAR: 'roundBar', ANGLE: 'angle' });
export const BRACE_MEMBER_TYPE_LABELS = Object.freeze({
  [BraceMemberType.ROUND_BAR]: '丸鋼',
  [BraceMemberType.ANGLE]:     'L型鋼',
});
// ブレースの規格の選択肢（メモのとおり。L型鋼の区切りは ASCII の '*'）。先頭が L型鋼の既定。
export const ROUND_BAR_BRACE_SPECS = Object.freeze(['M12', 'M14', 'M16', 'M18', 'M20', 'M22', 'M24']);
export const ANGLE_BRACE_SPECS = Object.freeze([
  'L-50*50*4', 'L-50*50*6', 'L-65*65*6', 'L-75*75*6', 'L-75*75*9', 'L-90*90*7', 'L-90*90*10',
  'L-100*100*7', 'L-100*100*10', 'L-130*130*9', 'L-130*130*12',
]);
// ALC のかさ上げ鋼材（リップ溝形鋼 JIS G 3350）の選択肢。区切りは乗算記号 '×'（U+00D7。メモのとおり）。
export const RAISE_CHANNEL_SPECS = Object.freeze([
  'C-60×30×10×1.6', 'C-60×30×10×2.3', 'C-75×45×15×1.6', 'C-75×45×15×2.3',
  'C-100×50×20×1.6', 'C-100×50×20×2.3', 'C-100×50×20×3.2',
  'C-120×40×20×3.2', 'C-120×60×20×3.2', 'C-120×60×25×4.5',
  'C-150×50×20×3.2', 'C-150×65×20×3.2', 'C-150×75×20×4.5',
  'C-200×75×20×3.2', 'C-200×75×25×4.5',
]);
// 既定値（メモの * 印。メモに既定の無い項目はリード裁定）。
export const DEFAULT_DECK_PLATE_CODE = '201600000001';      // QL99-50-10（材料コード帯 2016 の先頭）
export const DEFAULT_FLAT_DECK_PLATE_CODE = '201700000001'; // JF75ME-07（材料コード帯 2017 の先頭）
export const DEFAULT_ALC_PLATE_CODE = '301200000008';       // ALCパネル（厚100）（材料コード帯 3012 の先頭）
export const DEFAULT_SLAB_CONCRETE_THICKNESS_MM = 150;      // コンクリート厚(mm)。リード裁定
export const DEFAULT_SLAB_TOP_BELOW_FL_MM = 0;              // コンクリート上面・ALC上面の FL−(mm)。0＝FL に揃える。リード裁定
export const DEFAULT_ROUND_BAR_BRACE_SPEC = 'M16';          // 丸鋼の既定（メモの * 印）
export const DEFAULT_RAISE_CHANNEL_SPEC = 'C-100×50×20×3.2'; // かさ上げ鋼材の既定（メモの * 印）
// 材料コードの帯（先頭4桁）。プレート選択肢の絞り込みと保存データの照合に使う。
export const STEEL_SLAB_DECK_CODE_BAND = '2016';       // 合成スラブ用デッキ
export const STEEL_SLAB_FLAT_DECK_CODE_BAND = '2017';  // フラットデッキ（調整プレートを含む帯）
export const STEEL_SLAB_ALC_CODE_BAND = '3012';        // ALC 平パネル
// フラットデッキ帯のうち「調整プレート」（スラブ本体にならない）の名称の先頭。選択肢から除く。
export const FLAT_DECK_ADJUST_PLATE_NAME_PREFIX = 'JFPL';

// 注意色（黄）。画面の構造モードで「手動の梁芯に近すぎる自動の梁芯に乗る子梁」を示す
// （structural/slabSecondaryBeamAxes.js nearUserSlabAxisIds）。由来色（renderer/canvasStyle.js ORIGIN_HUES）
// ではないのでそちらには足さない。
export const CAUTION_COLOR = 'hsl(48, 100%, 45%)';

/**
 * 水平ブレースの×（構造モードの伏図。structural/braceFigure.js）の線色。値 'hsl(210, 20%, 45%)'（くすんだ青灰）・
 * 意味 ブレース材の対角線・単位 CSS色・根拠 スラブ塗り（部材色を 15% 透過）とも注意色（黄）とも取り違えず、
 * 梁・柱の線の下で補助線として読める控えめな寒色。
 */
export const BRACE_LINE_COLOR = 'hsl(210, 20%, 45%)';

// CL追加ダイアログ（ui/AddCLDialog.jsx）の参照の選択肢のうち、実CLではない合成の選択肢の種類。
// 実CLの選択肢はこの印（optionKind）を持たない。印の無いものだけが CL 種別の自動導出（centerLineKind）に通る。
export const AddCLOptionKind = Object.freeze({
  COLUMN_AXIS: 'columnAxis', // 構造モードの柱芯（通り芯 clId＋偏芯量 axisOffset の合成。App.jsx buildColumnAxisRefs）
});

// ---- S造スラブ指定のベイ選択UI（renderer/StructuralLayer.jsx のベイ当たり面・structural/MemberListTab.jsx のボタン） ----
// 選択済みのベイは構造リストの部材選択と同じ色族（structural/memberSelection.js MEMBER_SELECTION_*）を使う
// ——「選ばれている」見た目をアプリで揃えるため。未選択ベイは「選べる区画」を示す淡い灰の塗りと細い枠で、
// 選択済みの青と取り違えない程度に薄くする。透明（塗り無し）にしないのは Konva が塗りの無い図形を
// ヒット判定しないため（タップで選ぶ当たり面を兼ねる）。
/** 未選択ベイの塗り（淡い灰。スレート500 #64748b を 8%）。 */
export const BAY_PICK_FILL = 'rgba(100, 116, 139, 0.08)';
/** 未選択ベイの枠線色（スレート400 #94a3b8）。 */
export const BAY_PICK_STROKE = '#94a3b8';
/** 未選択ベイの枠線の太さ（画面px。ズームに依らず一定）。 */
export const BAY_PICK_STROKE_PX = 1;
/** 入力欄の検証エラー文字色（値 '#dc2626'＝red-600・意味 入力不正・単位 CSS色・根拠 FinishTable.jsx fieldErrorStyle / CeilingPanel.jsx と同色）。 */
export const FIELD_ERROR_COLOR = '#dc2626';
// スラブ見出しの小ボタン（スラブ指定・スラブにする・指定を外す・取消）。見出し（fontSize 13）より一段小さくして
// 件数ラベルと並べる。高さはタッチ操作の下限（約28px）を確保する。色は既存のパネルのボタン（MergeBar）と同じ
// スレート系——有効=青（選択色 MEMBER_SELECTION_COLOR）、無効・枠=スレート300、文字=スレート600。
/** 小ボタンの文字サイズ（px）。 */
export const BAY_PICK_BUTTON_FONT_PX = 11;
/** 小ボタンの最小高さ（px）。 */
export const BAY_PICK_BUTTON_MIN_HEIGHT_PX = 28;
/** 小ボタンの余白（CSS padding）。 */
export const BAY_PICK_BUTTON_PADDING = '4px 8px';
/** 小ボタンの無効色・枠色（スレート300 #cbd5e1）。 */
export const BAY_PICK_BUTTON_DISABLED_COLOR = '#cbd5e1';
/** 小ボタンの文字色（スレート600 #475569）。 */
export const BAY_PICK_BUTTON_TEXT_COLOR = '#475569';

// 敷地線の種別
export const SiteLineKind = Object.freeze({
  BOUNDARY:   'boundary',   // 境界（隣地境界線）
  ROAD:       'road',       // 道路境界
  SURVEY:     'survey',     // 測量
  ROAD_WIDTH: 'roadWidth',  // 道路幅員
  OTHER:      'other',      // その他
});
