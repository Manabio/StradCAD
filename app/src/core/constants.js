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
// 仕上げモード外部タブの主屋根の見出しに置く、平面で屋根区画を指定するトグル（FinishModeState.roofZonePickActive）のラベル
export const ROOF_ZONE_PICK_START_LABEL = '＋屋根区画を指定';
export const ROOF_ZONE_PICK_END_LABEL = '指定を終える';
// 屋根区画の小屋組 region の key の接頭辞（structural/roofFramingRegions.js。key＝`zone:<zoneId>`。区画以外の主屋根は 'main'）
export const ROOF_ZONE_REGION_KEY_PREFIX = 'zone:';
// 下屋（leanToPlanRegions）の region の key の接頭辞（key＝`lean:<roomId>`）。配置図の屋根伏せ図が下屋と主屋根・区画を見分ける
export const LEAN_TO_REGION_KEY_PREFIX = 'lean:';
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

// 部分詳細図の line.weightRole の既定。LINE_WEIGHT_MM のキー。
export const DETAIL_DEFAULT_WEIGHT_ROLE = 'thin';

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

// 柱の長クリックメニューの項目 id（interaction/menuItems.js・interaction/columnLongPress.js・App.jsx handleMenuSelect が共有）。
export const ColumnMenuItemId = Object.freeze({
  ADD: 'column-add', // 柱追加（CL の交点）
  DEL: 'column-del', // 柱削除（柱の断面内）
});

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

// スラブの役割（Slab.role）。新規コードでだけ使う（既存の文字列直書きは置換しない）。
export const SlabRole = Object.freeze({
  SLAB:           'slab',           // 一般のスラブ
  MAT_FOUNDATION: 'mat_foundation', // べた基礎のマットスラブ（基礎種別の structureRules.MAT_FOUNDATION とは別の値）
  ROOF_PANEL:     'roof_panel',     // 屋根面
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

// ---- 立面モード（facade/。外壁立面図4面）----
// 立面図の面の向き（方位）。値は面の識別子（layoutBands の roomId にも使う）。
export const FacadeDirection = Object.freeze({
  EAST:  'east',
  SOUTH: 'south',
  WEST:  'west',
  NORTH: 'north',
});
/** 立面図を描く順（上から東・南・西・北。問題.md の仕様）。 */
export const FACADE_DIRECTION_ORDER = Object.freeze([
  FacadeDirection.EAST, FacadeDirection.SOUTH, FacadeDirection.WEST, FacadeDirection.NORTH,
]);
/** 各面の見出し。 */
export const FACADE_TITLE_BY_DIRECTION = Object.freeze({
  [FacadeDirection.EAST]:  '東立面図',
  [FacadeDirection.SOUTH]: '南立面図',
  [FacadeDirection.WEST]:  '西立面図',
  [FacadeDirection.NORTH]: '北立面図',
});
/** ▽GL の文字。 */
export const FACADE_GL_LABEL = 'GL';
/** 外壁が1本も無く立面図を描けないときの表示文。 */
export const FACADE_EMPTY_MESSAGE = '外壁が無いため立面図を描けません';
/** 立面モードの初期化に失敗したときの表示文（展開モードの「展開モードの初期化に失敗しました」と同じ言い方）。 */
export const FACADE_INIT_ERROR_MESSAGE = '立面モードの初期化に失敗しました';

// ---- 敷地モードの配置図（site/sitePlacementView.js・modes/SiteModeState.js・ui/SiteInfoPanel.jsx） ----
/** 配置図の表示スイッチの見出しと2つの選択肢（表示側＝「配置」、非表示側＝「敷地入力」。画面の名前で呼ぶ）。 */
export const SITE_PLACEMENT_SWITCH_LABEL = '配置図';
export const SITE_PLACEMENT_SHOW_LABEL = '配置';
export const SITE_PLACEMENT_HIDE_LABEL = '敷地入力';
/** 配置図に描く屋根伏せ図の線が1本も無いときの表示文。 */
export const SITE_PLACEMENT_EMPTY_MESSAGE = '屋根伏図がありません';
/** 一部の階（または屋根）を読み込めなかったときの表示文（立面の FACADE_INIT_ERROR_MESSAGE と同じ位置づけ）。 */
export const SITE_PLACEMENT_READ_ERROR_MESSAGE = '一部の階を読み込めませんでした';
/** 全採用階の読み込み中の表示文。 */
export const SITE_PLACEMENT_LOADING_MESSAGE = '読み込み中…';
/**
 * 配置指定の頂点（敷地座標の角）の一致判定の許容差（mm）。保存値は角の座標のコピーなので厳密一致が本則で、
 * 浮動小数の保険としてだけ持つ（site/sitePlacementView.js の samePlacementVertex が唯一の比較口）。
 */
export const SITE_PLACEMENT_VERTEX_EPS_MM = 1e-6;
/** 配置図の境界線ラベル（site/siteBoundaryLabels.js）の種別名。パネルの短縮形 siteLineKindLabel とは別。 */
export const SITE_BOUNDARY_LABEL_NEIGHBOR = '隣地境界線';
export const SITE_BOUNDARY_LABEL_ROAD = '道路境界線';
/**
 * 境界線ラベルの片の角度が ±90 の境目にあるときの許容幅（度）。配置で通り芯に平行にそろえた辺の角度は
 * 浮動小数の誤差で ±90 の境目に来るため、この幅以内は鉛直とみなして「字の上が左」（−90）に固定する。リード裁定 2026-11-10。
 */
export const SITE_BOUNDARY_LABEL_VERTICAL_EPS_DEG = 1e-6;
/**
 * 境界線（結合した区間）の破線部を、区間の両端からこの比の位置に中心を置く（site/siteBoundaryChain.js）。
 * 区間長を 1 として 0.25 と 0.75 の 2 か所。ユーザー指示 2026-11-10。
 */
export const SITE_BOUNDARY_CHAIN_BREAK_FRACTION = 0.25;
/** 最長の区間に対する長さの比がこの値以下の区間は、破線部を中央 1 か所にする（これより長い区間は 2 か所）。ユーザー指示 2026-11-10。 */
export const SITE_BOUNDARY_CHAIN_SINGLE_BREAK_MAX_RATIO = 0.5;
/** 階番号（Plane.startFloor）で「1 階」を指す値。他モードへ敷地の境界線を出す階の判定（floorNumber.js isGroundFloorEquivalent）の基準。 */
export const GROUND_FLOOR_NUMBER = 1;
/** 配置指定 UI（ui/SiteInfoPanel.jsx）の文言。 */
export const SITE_PLACEMENT_HINT = '配置図の敷地の角（1 対目→2 対目の順）と通り芯ラベルをタップ';
/** 配置パネルの 1 対目（頂点1・頂点2・通り芯・距離）の見出し。 */
export const SITE_PLACEMENT_FIRST_PAIR_LABEL = '1 対目';
export const SITE_PLACEMENT_VERTEX1_LABEL = '頂点1';
export const SITE_PLACEMENT_VERTEX2_LABEL = '頂点2';
export const SITE_PLACEMENT_CENTER_LINE_LABEL = '通り芯';
export const SITE_PLACEMENT_DISTANCE_LABEL = '距離';
export const SITE_PLACEMENT_DISTANCE_NUMPAD_LABEL = '通り芯からの距離';
export const SITE_PLACEMENT_FLIP_ROTATION_LABEL = '回転反転';
export const SITE_PLACEMENT_FLIP_SIDE_LABEL = '側反転';
export const SITE_PLACEMENT_COMMIT_LABEL = '配置';
export const SITE_PLACEMENT_CLEAR_LABEL = '解除';
export const SITE_PLACEMENT_VERTEX_NONE = '未指定';
export const SITE_PLACEMENT_VERTEX_SET = '指定済み';
export const SITE_PLACEMENT_STALE_LABEL = '（失効）';
/** 配置の 2 対目（通り芯沿いの位置の拘束。頂点1＝1 対目の頂点との共有点・頂点2・通り芯・離れ）の UI 文言。 */
export const SITE_PLACEMENT_ALONG_LABEL = '2 対目';
/** 配置パネルの 2 対目の通り芯の行見出し（1 対目の「通り芯」と区別する）。 */
export const SITE_PLACEMENT_ALONG_CENTER_LINE_LABEL = '位置の通り芯';
/** 2 対目の頂点1 が角としては存在するが 1 対目の頂点のどちらとも一致しないときの表示。 */
export const SITE_PLACEMENT_ALONG_UNSHARED_LABEL = '（1 対目の頂点と一致しません）';
export const SITE_PLACEMENT_ALONG_DISTANCE_LABEL = '離れ';
export const SITE_PLACEMENT_ALONG_DISTANCE_NUMPAD_LABEL = '共有点から通り芯までの離れ';
export const SITE_PLACEMENT_ALONG_FLIP_SIDE_LABEL = '側反転（位置）';
export const SITE_PLACEMENT_ALONG_CLEAR_LABEL = '位置の解除';
/** 解に渡す共有点（1 対目の頂点1／頂点2 のどちらか）。FBS の ALONG_VERTEX（int8。NONE＝無し・旧データの読込み・旧読み手との整合用）と SiteModeState の解決で共用。 */
export const SitePlacementAlongVertex = Object.freeze({ NONE: 0, V1: 1, V2: 2 });
/** 敷地モード（modes/SiteModeState.js・site/sitePlacementView.js）のログの接頭辞。 */
export const SITE_LOG_TAG = '[site]';
/** 度→ラジアンの換算係数（回転の写像・図形の角度から使う）。 */
export const DEG_TO_RAD = Math.PI / 180;
/** 屋根伏せ図の線の太さ（viewport.lineWeightsPx のキー。下屋の平面表示と同じ細い実線）。 */
export const SITE_PLACEMENT_ROOF_LINE_WEIGHT = 'thin';
/** 通り芯の寸法（ガターの GRID 寸法・配置図の通り芯寸法）の寸法線・寸法値・点の色。 */
export const GRID_DIM_COLOR = '#475569';
/** 通り芯の寸法の、寸法線上の点（通り芯との交点）の半径（画面 px）。 */
export const GRID_DIM_DOT_RADIUS_PX = 2;
/** 配置図の通り芯の寸法: 通り芯の枠の端（配置後は敷地の境界線）から1段目の寸法線までの離れ（画面 px）。16 から 2 倍へ（2026-11-10 ユーザー指示「寸法線を今の 2 倍くらい境界線から離して」）。 */
export const SITE_PLACEMENT_GRID_DIM_OFFSET_PX = 32;
/** 配置図の通り芯の寸法: 1段目から2段目（全長）の寸法線までの離れ（画面 px。数値帯 13＋余白）。 */
export const SITE_PLACEMENT_GRID_DIM_ROW_GAP_PX = 24;
/** 配置図の通り芯の寸法で、全長の段を足す最小の通り芯本数（2本では間隔＝全長）。 */
export const SITE_PLACEMENT_GRID_TOTAL_MIN_LINES = 3;
/** 配置図の通り芯の線の由来色キー（canvasStyle.js の originColor へ渡す。平面の通り芯と同じ）。 */
export const SITE_PLACEMENT_GRID_ORIGIN_COLOR_KEY = 'grid';
/** 配置図の通り芯の線の太さ（viewport.lineWeightsPx のキー。平面の通り芯と同じ細線）。 */
export const SITE_PLACEMENT_GRID_LINE_WEIGHT = 'thin';
/** 配置図の 2 対目の頂点の色（選択色 MEMBER_SELECTION_COLOR と同じ Tailwind 600 系の赤）。 */
export const SITE_PLACEMENT_SECOND_PAIR_COLOR = '#dc2626';
/** 配置図の共有の頂点（1 対目と 2 対目の両方）の色（青と赤の混色を紫 1 色で）。 */
export const SITE_PLACEMENT_SHARED_VERTEX_COLOR = '#7c3aed';
/** 配置図で選択中の通り芯の丸ラベル（選択色の塗り）の文字色。 */
export const SITE_PLACEMENT_SELECTED_LABEL_TEXT_COLOR = '#ffffff';
/** 配置図で選択中の通り芯の線の太さ（viewport.lineWeightsPx のキー。通常の通り芯の細線より太い）。 */
export const SITE_PLACEMENT_SELECTED_LINE_WEIGHT = 'medium';
/** 配置図の図芯合わせで、建物側の基準にした情報源（屋根の線の外接矩形／通り芯の範囲／基準なし）。 */
export const SitePlacementCenterSource = Object.freeze({ ROOF: 'roof', GRID: 'grid', NONE: 'none' });
/** 立面の入力組み立て（facade/facadeInputs.js）で階を飛ばした理由。 */
export const FacadeSkipReason = Object.freeze({
  NO_GRAPH:         'noGraph',          // その階の graph が無い（未読込み）
  NO_EXTERIOR_WALL: 'noExteriorWall',   // 外壁の線分が1本も無い（部屋の無い階など）
  ERROR:            'error',            // 外壁の線分の取得で例外
  // 階の上端（次の階の FL）が GL 以下＝地上に出る部分が無い（GL が 2FL より上などの異常入力）。
  // 補完（STORY_HEIGHT_FALLBACK_MM）で上端を作ると上の階と z が重なるため、補わずに飛ばす。
  BELOW_GL:         'belowGl',
  // 外壁の建具の姿図に割り当てた部分詳細図が建具の寸法に合わせられない（姿図は従来の描き方へ戻る。planeId の階の建具。message に理由）。
  DETAIL_FIT_FAILED: 'detailFitFailed',
  // 以下は屋根（S2。skipped の要素に roofKey が付く）。
  ROOF_NO_OUTLINE:    'roofNoOutline',    // 屋根範囲が空・外形線が無い（その屋根は描かない）
  ROOF_FLAT_FALLBACK: 'roofFlatFallback', // 勾配・水下・到達時刻が作れない（軒の高さの水平線だけ描く）
});

// ---- 部分詳細図（detail/。一筆書きのペン命令列で登録する詳細図）----
/** ペンの進む向き。U=t−・D=t+・L=s−・R=s+（t は画面下向き正）。V は斜め（dx,dy と、軸ごとの向き ss,st=±1（省略時 +1）を持つ）。 */
export const PenDir = Object.freeze({
  UP:     'U',
  DOWN:   'D',
  LEFT:   'L',
  RIGHT:  'R',
  VECTOR: 'V',
});
/** 長さ指定の種別。fixed=固定寸法・stretch=伸縮（軸ごとに1本）・param=見付/出幅などの参照・material=材の寸法の参照。 */
export const DetailLenMode = Object.freeze({
  FIXED:    'fixed',
  STRETCH:  'stretch',
  PARAM:    'param',
  MATERIAL: 'material',
});
/** 詳細図の分類（部位・取り合い・自由部位・対の部位・姿図）。 */
export const DetailCategory = Object.freeze({
  PART:      'part',
  JUNCTION:  'junction',
  FREE_PART: 'freePart',
  PAIRED:    'paired',
  FIGURE:    'figure',
  FITTING:   'fitting', // 建具一式（部品の束。parts を持ち、最上位の strokes は空）
});
/** 詳細図の向き。 */
export const DetailView = Object.freeze({
  PLAN:      'plan',
  SECTION:   'section',
  ELEVATION: 'elevation',
});
/** 詳細図の主題（何の図か）。 */
export const DetailSubject = Object.freeze({
  JAMB:         'jamb',
  HEAD:         'head',
  SILL:         'sill',
  SASH_SECTION: 'sashSection',
  NAGESHI:      'nageshi',
  SHIKII:       'shikii',
  OPENING:      'opening',
  SANITARY:     'sanitary',
  FURNITURE:    'furniture',
  HVAC:         'hvac',
  WALL:         'wall',
  FLOOR:        'floor',
  CEILING:      'ceiling',
  FLOOR_WALL:   'floorWall',
  WALL_CEILING: 'wallCeiling',
  EAVE:         'eave',
  VERGE:        'verge',
});
/** 建具の枠など、詳細図を取り付ける先の名前（スロット）。 */
export const DetailSlot = Object.freeze({
  JAMB:         'jamb',
  HEAD:         'head',
  SILL:         'sill',
  SASH_SECTION: 'sashSection',
  NAGESHI:      'nageshi',
  SHIKII:       'shikii',
  FIGURE:       'figure', // 建具の姿図（正面図）。枠・機構・ハンドルを置き換える（S6b）。「開く側から見た図」
  FIGURE_BACK:  'figureBack', // 建具の姿図のうち、向こう側（開く側の反対）から見た図。任意。無ければ FIGURE を両側に使う（T2）
  FLOOR_WALL:   'floorWall',   // 部屋の床と壁の取り合い（Room.detailRefs。S8a）
  WALL_CEILING: 'wallCeiling', // 部屋の壁と天井の取り合い（Room.detailRefs。S8a）
  KNEE_TOP:     'kneeTop',     // 腰壁の天端（腰壁・垂れ壁の記録の detailRefs。S8b-1）
  DROP_BOTTOM:  'dropBottom',  // 垂れ壁の下端（同上）
  FLOOR_STEP:   'floorStep',   // 床の段差（高い側の部屋の Room.detailRefs。S8b-3）
  CEILING_STEP: 'ceilingStep', // 天井の段差（低い側の天井面の持ち主＝区画の CeilingZone.detailRefs か部屋の Room.detailRefs。S8b-4a）
  FITTING:      'fitting',     // 建具一式（opening.detailRefs・建具種別の detailFigures が持つ。部品の束を指す）
});
/**
 * 建具一式（DetailCategory.FITTING）の部品の役割。部品は一式の parts[] の要素 { id, role, figure }。
 * jamb 系＝平面の方立・head/sill＝展開の断面・figure 系＝姿図・slide* 6 個＝外付け引き戸の平面の部品（戸先・内側・戸尻と、その上階側）。
 */
export const FittingPartRole = Object.freeze({
  JAMB:           'jamb',
  JAMB_HINGE:     'jambHinge',
  JAMB_LATCH:     'jambLatch',
  HEAD:           'head',
  SILL:           'sill',
  FIGURE:         'figure',
  FIGURE_BACK:    'figureBack',
  SLIDE_LATCH:    'slideLatch',
  SLIDE_INNER:    'slideInner',
  SLIDE_TAIL:     'slideTail',
  SLIDE_LATCH_UP: 'slideLatchUp',
  SLIDE_INNER_UP: 'slideInnerUp',
  SLIDE_TAIL_UP:  'slideTailUp',
});
/** 部屋（Room.detailRefs）に割り当てられる slot（S8a。wall・floor・ceiling の part は要素付き＝8b）。 */
export const ROOM_DETAIL_SLOTS = Object.freeze([DetailSlot.FLOOR_WALL, DetailSlot.WALL_CEILING]);
/** 部屋（Room.detailRefs）に割り当てられる要素付き（part）の slot（S8b-3。ROOM_DETAIL_SLOTS には混ぜない＝junction の fit と通知が誤って回る）。 */
export const ROOM_PART_SLOTS = Object.freeze([DetailSlot.FLOOR_STEP, DetailSlot.CEILING_STEP]);
/** 天井区画（Room.ceilingZones の CeilingZone.detailRefs）に割り当てられる slot（S8b-4a。区画どうしの段差は低い側の区画が持つ）。 */
export const CEILING_ZONE_DETAIL_SLOTS = Object.freeze([DetailSlot.CEILING_STEP]);
/** 腰壁・垂れ壁の記録（graph.kneeDropWalls の値の detailRefs）に割り当てられる slot（S8b-1。ROOM_DETAIL_SLOTS には混ぜない）。 */
export const KNEE_DROP_DETAIL_SLOTS = Object.freeze([DetailSlot.KNEE_TOP, DetailSlot.DROP_BOTTOM]);
/**
 * 腰壁・垂れ壁の記録の「表の側」（rec.frontSide。部分詳細図の s 原点＝表の側の仕上げ面）。値は kneeDropWallGeometry の
 * roomNeg（軸の負側の部屋）・roomPos（正側）の呼び名に合わせる。記録に無ければ KNEE_DROP_FRONT_SIDE_DEFAULT。
 */
export const KneeDropFrontSide = Object.freeze({
  ROOM_NEG: 'roomNeg',
  ROOM_POS: 'roomPos',
});
export const KNEE_DROP_FRONT_SIDE_DEFAULT = KneeDropFrontSide.ROOM_NEG;
/** 平面の姿図（配置する図）が束ねる、別の向きの図の呼び名（views のキー）。front〜right は立面側、ceiling は見上げ。 */
export const DetailPlacementView = Object.freeze({
  FRONT:   'front',
  BACK:    'back',
  LEFT:    'left',
  RIGHT:   'right',
  CEILING: 'ceiling',
});
/** 平面に配置できる姿図の主題（views を持てる平面の姿図の subject）。 */
export const PLACED_FIGURE_SUBJECTS = Object.freeze([DetailSubject.SANITARY, DetailSubject.FURNITURE, DetailSubject.HVAC]);
/** PLACED_FIGURE_SUBJECTS のうち、天井側（見上げ）にも現れる主題。 */
export const CEILING_PLACED_FIGURE_SUBJECTS = Object.freeze([DetailSubject.HVAC]);
/** 有効な (category, view, subject) の組合せ表。検証（detail/detailModel.js）と割当て先の絞り込みが引く。 */
export const DETAIL_VIEW_COMBOS = Object.freeze([
  ...[DetailView.PLAN, DetailView.SECTION].flatMap(view =>
    [DetailSubject.JAMB, DetailSubject.HEAD, DetailSubject.SILL, DetailSubject.SASH_SECTION, DetailSubject.NAGESHI, DetailSubject.SHIKII]
      .map(subject => ({ category: DetailCategory.PAIRED, view, subject }))),
  ...[DetailView.ELEVATION, DetailView.PLAN].flatMap(view =>
    [DetailSubject.OPENING, DetailSubject.SANITARY, DetailSubject.FURNITURE, DetailSubject.HVAC]
      .map(subject => ({ category: DetailCategory.FIGURE, view, subject }))),
  { category: DetailCategory.JUNCTION, view: DetailView.SECTION, subject: DetailSubject.FLOOR_WALL },
  { category: DetailCategory.JUNCTION, view: DetailView.SECTION, subject: DetailSubject.WALL_CEILING },
  { category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL },
  { category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.FLOOR },
  { category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.CEILING },
  { category: DetailCategory.FREE_PART, view: DetailView.SECTION, subject: DetailSubject.EAVE },
  { category: DetailCategory.FREE_PART, view: DetailView.SECTION, subject: DetailSubject.VERGE },
  { category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING },
].map(Object.freeze));
/** スロットごとの、割り当てられる詳細図の (category, view, subject)。DETAIL_VIEW_COMBOS に含まれる。 */
export const DETAIL_SLOT_TARGETS = Object.freeze({
  [DetailSlot.JAMB]:         Object.freeze({ category: DetailCategory.PAIRED, view: DetailView.PLAN,    subject: DetailSubject.JAMB }),
  [DetailSlot.HEAD]:         Object.freeze({ category: DetailCategory.PAIRED, view: DetailView.SECTION, subject: DetailSubject.HEAD }),
  [DetailSlot.SILL]:         Object.freeze({ category: DetailCategory.PAIRED, view: DetailView.SECTION, subject: DetailSubject.SILL }),
  [DetailSlot.SASH_SECTION]: Object.freeze({ category: DetailCategory.PAIRED, view: DetailView.SECTION, subject: DetailSubject.SASH_SECTION }),
  [DetailSlot.NAGESHI]:      Object.freeze({ category: DetailCategory.PAIRED, view: DetailView.SECTION, subject: DetailSubject.NAGESHI }),
  [DetailSlot.SHIKII]:       Object.freeze({ category: DetailCategory.PAIRED, view: DetailView.SECTION, subject: DetailSubject.SHIKII }),
  [DetailSlot.FIGURE]:       Object.freeze({ category: DetailCategory.FIGURE, view: DetailView.ELEVATION, subject: DetailSubject.OPENING }),
  [DetailSlot.FIGURE_BACK]:  Object.freeze({ category: DetailCategory.FIGURE, view: DetailView.ELEVATION, subject: DetailSubject.OPENING }),
  [DetailSlot.FLOOR_WALL]:   Object.freeze({ category: DetailCategory.JUNCTION, view: DetailView.SECTION, subject: DetailSubject.FLOOR_WALL }),
  [DetailSlot.WALL_CEILING]: Object.freeze({ category: DetailCategory.JUNCTION, view: DetailView.SECTION, subject: DetailSubject.WALL_CEILING }),
  [DetailSlot.KNEE_TOP]:     Object.freeze({ category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL }),
  [DetailSlot.DROP_BOTTOM]:  Object.freeze({ category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.WALL }),
  [DetailSlot.FLOOR_STEP]:   Object.freeze({ category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.FLOOR }),
  [DetailSlot.CEILING_STEP]: Object.freeze({ category: DetailCategory.PART, view: DetailView.SECTION, subject: DetailSubject.CEILING }),
  [DetailSlot.FITTING]:      Object.freeze({ category: DetailCategory.FITTING, view: DetailView.PLAN, subject: DetailSubject.OPENING }),
});
const fittingTarget = (category, view, subject) => Object.freeze({ category, view, subject });
const FITTING_JAMB_TARGET = fittingTarget(DetailCategory.PAIRED, DetailView.PLAN, DetailSubject.JAMB);
const FITTING_FIGURE_TARGET = fittingTarget(DetailCategory.FIGURE, DetailView.ELEVATION, DetailSubject.OPENING);
const FITTING_SLIDE_TARGET = fittingTarget(DetailCategory.FIGURE, DetailView.PLAN, DetailSubject.OPENING);
/** 建具一式の部品の役割ごとの、部品本体の (category, view, subject)。DETAIL_VIEW_COMBOS に含まれる。 */
export const FITTING_PART_TARGETS = Object.freeze({
  [FittingPartRole.JAMB]:           FITTING_JAMB_TARGET,
  [FittingPartRole.JAMB_HINGE]:     FITTING_JAMB_TARGET,
  [FittingPartRole.JAMB_LATCH]:     FITTING_JAMB_TARGET,
  [FittingPartRole.HEAD]:           fittingTarget(DetailCategory.PAIRED, DetailView.SECTION, DetailSubject.HEAD),
  [FittingPartRole.SILL]:           fittingTarget(DetailCategory.PAIRED, DetailView.SECTION, DetailSubject.SILL),
  [FittingPartRole.FIGURE]:         FITTING_FIGURE_TARGET,
  [FittingPartRole.FIGURE_BACK]:    FITTING_FIGURE_TARGET,
  [FittingPartRole.SLIDE_LATCH]:    FITTING_SLIDE_TARGET,
  [FittingPartRole.SLIDE_INNER]:    FITTING_SLIDE_TARGET,
  [FittingPartRole.SLIDE_TAIL]:     FITTING_SLIDE_TARGET,
  [FittingPartRole.SLIDE_LATCH_UP]: FITTING_SLIDE_TARGET,
  [FittingPartRole.SLIDE_INNER_UP]: FITTING_SLIDE_TARGET,
  [FittingPartRole.SLIDE_TAIL_UP]:  FITTING_SLIDE_TARGET,
});
/** 建具一式の部品を指す合成キー '<一式のキー>#<role>' の区切り。詳細図のキーには使えない（detailModel.js の BAD_KEY_CHAR）。 */
export const FITTING_PART_KEY_SEPARATOR = '#';
/** 基準（Datum）の種別。origin=図を載せる原点・end=伸縮区間の終端。 */
export const DetailDatumKind = Object.freeze({
  ORIGIN: 'origin',
  END:    'end',
});
/** 局所座標の軸。s=横・t=縦（画面下向き正）。 */
export const DetailAxis = Object.freeze({
  S: 's',
  T: 't',
});
/** 基準（Datum）の役割。各図側が供給する値（壁仕上面・FL・開口端など）との対応を表す。 */
export const DetailDatumRole = Object.freeze({
  WALL_FINISH_FACE: 'wallFinishFace',
  WALL_AXIS:        'wallAxis',
  FL:               'fl',
  CEILING_FACE:     'ceilingFace',
  WALL_TOP:         'wallTop',    // 腰壁の天端の面（t の origin。S8b-1）
  WALL_BOTTOM:      'wallBottom', // 垂れ壁の下端の面（t の origin。S8b-1）
  STEP_EDGE:        'stepEdge',   // 床・天井の段差の立ち上がり面（s の origin。空気側が正＝床は低い側・天井は高い側。S8b-3・S8b-4a）
  GL:               'gl',
  ROOF_SURFACE:     'roofSurface',
  EAVE_EDGE:        'eaveEdge',
  VERGE_EDGE:       'vergeEdge',
  OPENING_OUTER:    'openingOuter',
  OPENING_INNER:    'openingInner',
  SILL:             'sill',
  HEAD:             'head',
  PLACEMENT_ORIGIN: 'placementOrigin',
});
/** LenSpec.mode='param' が参照する、取り付け先から供給される寸法。 */
export const DetailParam = Object.freeze({
  FRAME_FACE_WIDTH: 'frameFaceWidth',
  FRAME_PROJECTION: 'frameProjection',
  FRAME_DEPTH:      'frameDepth',
  WALL_THICKNESS:   'wallThickness',
  /** 部屋の巾木高さ（仕上げ設定 RoomFinish.baseboardHeight の "h=<mm>" を解析した mm。junction の floorWall だけが供給。S8c） */
  BASEBOARD_HEIGHT: 'baseboardHeight',
  /** 外付け引き戸の扉幅 DW（mm。建具一式の部品が引く。建具の間口 W から (W+50)/2 で導出） */
  DOOR_WIDTH: 'doorWidth',
  /** 外付け引き戸の穴の長さ DW−50（mm。天井詳細の上枠の線が引く。建具一式 slideInnerUp の部品が使う） */
  OPENING_CLEAR_WIDTH: 'clearWidth',
});
/** LenSpec.mode='material' が参照する材の寸法の項目。 */
export const DetailMaterialField = Object.freeze({
  THICKNESS: 'thickness',
  X:         'x',
  Y:         'y',
});
/** 部分詳細ヘルパーの床・天井の段差（floorStep・ceilingStep）の試し込みの既定の段差高（mm。S8b-3 のリード指定。実際の段差高は床高・天井高の差）。 */
export const DETAIL_FIT_DEFAULT_STEP_HEIGHT_MM = 300;
/** 部分詳細ヘルパーの床と壁の取り合い（巾木高さ param を使う図）の試し込みの既定の巾木高さ（mm。S8c。新規の部屋の既定 core/room.js DEFAULT_BASEBOARD_HEIGHT 'h=60' と同値。ヘルパーは core/room.js を引けないのでここに置く）。 */
export const DETAIL_FIT_DEFAULT_BASEBOARD_HEIGHT_MM = 60;
/** 詳細図の出どころ（provenance.source）。 */
export const DetailProvenanceSource = Object.freeze({
  MANUAL: 'manual',
  DXF:    'dxf',
  PDF:    'pdf',
});
/**
 * 詳細図の線種。'dashed' は elevation/elevationStyle.js の ElevationDash.DASHED と同値（detail/ は elevation/ を引けないのでここに置く）。
 * SWING＝開き勝手線の役割。姿図を向こうへ開く面から見るときは一点鎖線・手前に開く面と見る側が不明のときは実線（T2）。
 */
export const DetailDash = Object.freeze({
  SOLID:  'solid',
  DASHED: 'dashed',
  SWING:  'swing',
});
/** DetailFigure.version（前方互換。未知の版は読み飛ばす）。 */
export const DETAIL_FIGURE_VERSION = 1;
/** 建具記号エントリの任意項目名。{ [DetailSlot.JAMB]?: 詳細図キー, [DetailSlot.HEAD]?: 詳細図キー }（R4）。カタログ登録表と推移展開が使う。 */
export const FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD = 'detailFigures';
/** 平面の姿図が別の向きの図を束ねる任意項目名（views）。カタログ層が読み替え・推移展開・照合で引く。 */
export const DETAIL_VIEWS_FIELD = 'views';
/** 平面の姿図が持つ製品情報の任意項目名（product。名称・メーカー・型番・色名。配置ごとでなく図の側に持つ）。 */
export const DETAIL_PRODUCT_FIELD = 'product';
/** product のキー（値は文字列）。 */
export const DetailProductField = Object.freeze({
  NAME:         'name',
  MAKER:        'maker',
  MODEL_NUMBER: 'modelNumber',
  COLOR_NAME:   'colorName',
});
/** 建具一式（DetailCategory.FITTING）の部品の列を持つ項目名（図エントリの最上位）。 */
export const DETAIL_PARTS_FIELD = 'parts';
/** 詳細図キーの接頭辞（S4 の生成が使う。S2 の登録表は書式を検査しない）。 */
export const DETAIL_FIGURE_KEY_PREFIX = 'df-';
/** 詳細図由来のプリミティブに付ける出どころの印（source。kind は立面が上書きするので使わない）。 */
export const DETAIL_PRIM_SOURCE = 'detail';
/** 紙上の最小描画幅（mm）。描く図面の縮尺で実寸がこれ以下になる幅は、これに引き上げて描く（2026-11-02 裁定。展開図に限らず全図面共通）。 */
export const MIN_DRAWN_PAPER_MM = 0.5;
/** 展開図で縮尺の分母が分からないとき（1 パス目・単体テスト・ゴールデン）に想定する分母。最小描画幅は 0.5×100＝50mm。 */
export const ELEVATION_DEFAULT_SCALE_DENOM = 100;
/** 天板（腰壁の天端）の実厚（mm）。組込みの天板図と展開図の天端下の細線が共有する。 */
export const KNEE_CAP_THICKNESS_MM = 20;
/**
 * 組込みの部分詳細図のキー（detail/detailBuiltins.js が定義する図）。割当て無しの暗黙の既定（S8c）として finish/ が引くので、
 * 組込み層を静的に import しなくて済むようここに置く。巾木＝部屋に巾木高さがあれば floorWall の既定・天板＝腰壁の kneeTop の既定。
 */
export const DETAIL_BUILTIN_BASEBOARD_KEY = 'df-builtin-baseboard-10';
/** 部分詳細図の割当ての出どころ。explicit＝利用者が detailRefs へ割り当てた図・default＝割当て無しの暗黙の既定（組込みの巾木・天板。S8c）。通知は explicit だけ。 */
export const DetailFigureSource = Object.freeze({ EXPLICIT: 'explicit', DEFAULT: 'default' });
export const DETAIL_BUILTIN_KNEE_CAP_KEY = 'df-builtin-kneecap-20';
/**
 * 片開き戸の方立（平面）・上枠（展開）の組込み図のキー（S8e）。subType が SWING_LEAF_SUBTYPE の建具があれば、割当て無しの暗黙の既定として使う。
 * 方立＝詳細 LOD の平面の方立（従来の描きと同じ出力）・上枠＝展開の断面（S8e-2 で配線）。
 */
export const DETAIL_BUILTIN_DOOR_JAMB_KEY = 'df-builtin-door-jamb-30';
export const DETAIL_BUILTIN_DOOR_HEAD_KEY = 'df-builtin-door-head-30';
/**
 * 窓の方立（平面・詳細 LOD）の組込み図のキー（S8f-1）。窓（category window）があれば、割当て無しの暗黙の既定として使う。
 * 平面の方立は 3 経路あり、経路ごとに 1 つ: 閉じた矩形（sash）・開いたコの字（sashOpen）・欠き込みの六角形（開き系 notched）。見付は 25。
 */
export const DETAIL_BUILTIN_WINDOW_JAMB_KEY = 'df-builtin-window-jamb-25';
export const DETAIL_BUILTIN_WINDOW_JAMB_OPEN_KEY = 'df-builtin-window-jamb-open-25';
export const DETAIL_BUILTIN_WINDOW_JAMB_NOTCHED_KEY = 'df-builtin-window-jamb-notched-25';
/** 窓の上枠・下枠（展開の断面。S8f-3b）の組込み図のキー。窓があれば割当て無しの暗黙の既定として使う（下枠は窓台のある窓だけ）。見付は 25。 */
export const DETAIL_BUILTIN_WINDOW_HEAD_KEY = 'df-builtin-window-head-25';
export const DETAIL_BUILTIN_WINDOW_SILL_KEY = 'df-builtin-window-sill-25';
/** 片開き戸の建具種別キー（openingCatalog.js の FITTING_CATALOG）。catalog/ は openings/ を引けないので暗黙の既定の同梱判定（usedEntries.js）と共有できるようここに置く。 */
export const SWING_LEAF_SUBTYPE = 'singleSwing';
/** 引き戸の建具種別キー（openingCatalog.js の FITTING_CATALOG の sliding。外付け引き戸の組込み一式の既定に使う。catalog/ は openings/ を引けないのでここに置く）。 */
export const SLIDE_OUTSET_SUBTYPE = 'sliding';
/** 外付け引き戸の組込み一式（建具一式 FITTING）の図のキー。図は後続（C4）で detail/detailBuiltins.js が定義する。 */
export const DETAIL_BUILTIN_FITTING_SLIDING_KEY = 'df-builtin-fitting-sliding';

// ---- 平面記号の枠寸法（mm。建具の方立の組込み図と従来の描きが共有する唯一の定義。openings/openingPlanSymbolGeometry.js が再輸出）----
export const FRAME_OVERHANG_MM     = 12; // 枠が壁面から室内外へ出る量（ユーザー明示指示2026-09で10→12）
export const FRAME_JAMB_WIDTH_MM   = 30; // 方立の全幅（本体20 + かかり代10）
// 窓の方立の全幅（本体15 + かかり代10）。ユーザー裁定 2026-11-04。建具（fitting）は FRAME_JAMB_WIDTH_MM
export const WINDOW_FRAME_JAMB_WIDTH_MM = 25;
export const FRAME_KAKARI_WIDTH_MM = 10; // 方立のうち開口側かかり代（＝戸当たり）
// 扉厚（平面では「かかり代を欠き込む深さ」）。**平面記号と展開図の建具断面が共有する唯一の定義**
// ——展開図側（純モジュール）は .jsx を静的に引けないため、レンダラ（OpeningsLayer.jsx）に
// 置いていた定数を openingPlanSymbolGeometry.js へ移し、さらにここへ移した（ユーザー明示指示2026-09「平面に指定があるので参照のこと」）。
export const DOOR_LEAF_THICKNESS_MM = 30;
/** 外付け引き戸の建具幅 W＝2×扉幅 DW−50 の 50。W＝穴（DW−50）＋引き代（DW）。ユーザー指示 2026-11-10 */
export const SLIDE_OUTSET_WIDTH_DEDUCT_MM = 50;
/** 外付け引き戸の引き代区間の欠き込み深さ＝戸尻枠の入り 12＋隙間 3＋扉厚 30＋扉外面の逃げ 5（R-b・R10）。壁厚がこれ以下の壁は欠き込まない（T3）。ユーザー裁定 2026-11-10 */
export const SLIDE_OUTSET_RECESS_DEPTH_MM = 50;
/** 外付け引き戸の扉の外面と走る面（壁面）の逃げ（R10 の「扉外面が壁面から 5 内側」。扉は走る面の内側 [面−(5+扉厚), 面−5]）。欠き込み深さ 50 の内訳の 5 と同じ寸法。ユーザー裁定 2026-11-10 */
export const SLIDE_OUTSET_DOOR_FACE_INSET_MM = 5;
/** fit の長さ比較の許容（mm）。elevationStyle.js の COORD_EPS_MM と同値だが、detail/ は elevation/ を引けないので別定義。 */
export const DETAIL_FIT_EPS_MM = 1e-3;
/** 手の辺に付ける印（Move.edge）。'air'＝空気との境目（室内側の見え掛かりの線。展開図で中線になる。S8a）。 */
export const DetailEdgeMark = Object.freeze({
  AIR: 'air',
});
/** 包絡線の段差とみなす s の差の下限（mm。これ以下は見えない。S8a）。 */
export const DETAIL_ENVELOPE_STEP_MIN_MM = 1;
/** 包絡線の折れ（'V' の向きの変化）とみなす角度の下限（度。面取りの稜線。S8a）。 */
export const DETAIL_ENVELOPE_KINK_MIN_DEG = 1;
/** 展開図の切断面を詳細図の断面形へ差し替える、形状差の下限（mm。これを超えたら差し替える。S8a）。8a-2（展開の断面形の差し替え）で使用。 */
export const DETAIL_SECTION_SWAP_MIN_DIFF_MM = 100;
/** ヘルパー画面の下書き履歴（1 手戻し）の保持数の上限。超えたら古いものから捨てる（undoManager には積まない）。 */
export const DETAIL_DRAFT_HISTORY_MAX = 50;

// ---- DXF 読込み（部分詳細図 S7a。detail/dxf/）----
/** 端点スナップの許容（mm）。共線の間引き・軸平行の判定にも同値を使う（旧草案 §5.2「0.01 固定・自動で緩めない」）。 */
export const DXF_SNAP_TOL_MM = 0.01;
/** 円弧→弦の弦公差（mm。弧と弦の最大のずれ）。ASSUMED（実 DXF を見て決める）。 */
export const DXF_CHORD_TOL_MM = 0.05;
/** INSERT（ブロック挿入）を展開する深さの上限（段）。超えた INSERT は警告して展開しない。 */
export const DXF_INSERT_DEPTH_MAX = 8;
/** 読み込むエンティティ数の上限（INSERT 展開後の数にも使う）。超えたら打ち切って警告。ASSUMED。 */
export const DXF_MAX_ENTITIES = 20000;
/** 円弧を弦に分割した後の線分数の上限。超えたら打ち切って警告。ASSUMED。 */
export const DXF_MAX_SEGMENTS = 200000;
/** $INSUNITS → mm 係数（DXF 仕様: 1=inch・4=mm・5=cm・6=m）。表に無い値（0=単位なし 含む）は不明扱い。 */
export const DXF_INSUNITS_TO_MM = Object.freeze({ 1: 25.4, 4: 1, 5: 10, 6: 1000 });
/** バイナリ DXF の先頭の署名（読み込まず拒否する）。 */
export const DXF_BINARY_SIGNATURE = 'AutoCAD Binary DXF';
/** DXF から作る長さ（mm）の丸め係数（1e-6 mm 単位。浮動小数の尾を落とす）。 */
export const DXF_LEN_ROUND_FACTOR = 1e6;
/** DXF 読込みの警告コード（保存は止めない。画面に出して残す）。 */
export const DxfWarning = Object.freeze({
  UNIT_UNKNOWN:       'unitUnknown',       // $INSUNITS が無い・未知（係数 1 を仮置き）
  CONTOUR_OPEN:       'contourOpen',       // 成分が閉じた輪郭 1 周ではない（開いている・分岐している）
  SELF_INTERSECT:     'selfIntersect',     // 成分の輪郭が自己交差している
  LICENSE_UNKNOWN:    'licenseUnknown',    // ライセンス注記が未記入
  INSERT_DEPTH:       'insertDepth',       // INSERT の入れ子が DXF_INSERT_DEPTH_MAX を超えた（それ以上は展開しない）
  INSERT_CYCLE:       'insertCycle',       // INSERT が循環している（そこで打ち切り）
  UNSUPPORTED_ENTITY: 'unsupportedEntity', // 未対応のエンティティ（種類ごとの件数。無視した）
  NONUNIFORM_SCALE:   'nonuniformScale',   // 非一様スケールの INSERT 内の円・円弧（楕円を多角形で近似した）
  ENTITY_LIMIT:       'entityLimit',       // 件数上限で打ち切った
  SELF_INTERSECT_UNCHECKED: 'selfIntersectUnchecked', // 線分が多い・密集している（候補の対・格子登録数が上限超）ため自己交差の判定を省いた
  NO_DIGEST:          'noDigest',          // sha256 を取れなかった（出所の sha256 が空。読込みは続ける）
});
/** 自己交差の判定を行う成分の線分数の上限（超えたら判定を省いて SELF_INTERSECT_UNCHECKED）。ASSUMED。 */
export const DXF_SELFINT_MAX_SEGMENTS = 20000;
/** 自己交差の判定で調べる候補の対の数の上限（超えたら判定を省く。放射状に集まる図形での二乗の膨張を止める）。ASSUMED。 */
export const DXF_SELFINT_MAX_PAIRS = 4000000;
/** 自己交差の判定で格子へ登録する件数（線分ごとの標本点×周囲9セル）の上限。超えたら登録を始めず判定を省く。ASSUMED。 */
export const DXF_SELFINT_MAX_CELL_ENTRIES = 2000000;
/** INSERT が相似変換（等方スケール＋回転＋ミラー）かの判定の相対許容（数学的な許容。長さの mm ではない）。 */
export const DXF_SIMILARITY_EPS = 1e-9;
/** 円弧の掃引角が 2π（円）かの許容（rad）。 */
export const DXF_FULL_TURN_EPS = 1e-9;
/** 一周（度）。回転角の正規化の法。 */
export const FULL_TURN_DEG = 360;
/** 半周（度）。回転角を (−180,180] ・向きを持たない直線の角を (−90,90] へ寄せる法。 */
export const HALF_TURN_DEG = FULL_TURN_DEG / 2;
/** 姿図の配置（PlacedFigure）の回転の刻み（度）。回転はこの整数倍だけ許す。 */
export const PLACED_FIGURE_ROTATION_STEP_DEG = 90;
/** 姿図の配置で図が解決できないとき配置点に出す印（×）の半幅（画面 px。拡大縮小に依らず画面で一定）。 */
export const PLACED_FIGURE_MISSING_MARK_PX = 6;
/** 姿図の配置点（平面のタップ位置）を丸める刻み（mm）。 */
export const PLACED_FIGURE_POSITION_STEP_MM = 1;
/** 字句分解のエラーに載せる不正な行の先頭の長さ（巨大な行を持ち回らない）。 */
export const DXF_ERROR_TEXT_MAX = 32;
/** 出所欄（メーカー・シリーズ・ライセンス注記）の項目名。 */
export const DXF_PROVENANCE_FIELDS = Object.freeze({ MAKER: 'maker', SERIES: 'series', LICENSE_NOTE: 'licenseNote' });
/** DXF プレビューの線の見た目（淡色＝全体、強調＝選択中の成分。幅は px）。 */
export const DXF_PREVIEW_STYLE = Object.freeze({
  faint: Object.freeze({ stroke: '#cbd5e1', width: 1 }),
  selected: Object.freeze({ stroke: '#2563eb', width: 2 }),
});
/** DXF を読み込まず拒否する理由。 */
export const DxfReject = Object.freeze({
  BINARY:         'binary',        // バイナリ DXF
  BAD_GROUP_CODE: 'badGroupCode',  // group code が整数でない
  TRUNCATED:      'truncated',     // 途中で切れている（対の片割れ・EOF が無い）
  UNEXPECTED:     'unexpected',    // 想定外の例外（握って通知）
  NOT_BYTES:      'notBytes',      // 入力がバイト列でない
});

// ---- PDF 読込み（部分詳細図 S7b。detail/pdf/。pdfjs は ui/pdfLoader.js だけが引く）----
/** PDF の 1 pt = 1/72 inch → mm。 */
export const PDF_PT_TO_MM = 25.4 / 72;
/** 選べるページ数の上限（超えたページは選べない。PAGE_LIMIT）。ASSUMED。 */
export const PDF_MAX_PAGES = 200;
/** 読み込むファイルの上限バイト数（超えたら読まない。PdfReject.SIZE_LIMIT）。ASSUMED。 */
export const PDF_MAX_BYTES = 50 * 1024 * 1024;
/** 1 ページから拾うパス（constructPath）数の上限（超えたら打ち切る。PATH_LIMIT）。ASSUMED。 */
export const PDF_MAX_PATH_OPS = 200000;
/** PDF の先頭の署名（内容判定。ファイル名・拡張子・MIME は見ない）。 */
export const PDF_SIGNATURE = '%PDF-';
/** 署名を探す先頭のバイト数（仕様は先頭 1024 バイト以内）。 */
export const PDF_SIGNATURE_SCAN_BYTES = 1024;
/** ページ画像を描く倍率（canvas の px／pt。表示専用）。 */
export const PDF_PREVIEW_SCALE = 1.5;
/** pdfjs の constructPath が持つ描画命令の符号（pdfjs は export していないため固定版に合わせて持つ）。
 *  pdfjs-dist 6.4.299 固定。版を上げたら detail/pdf/pdfjsPin.test.js で照合する（DrawOPS と一致しなければ落ちる）。 */
export const PdfDrawOp = Object.freeze({ MOVE_TO: 0, LINE_TO: 1, CURVE_TO: 2, QUAD_TO: 3, CLOSE: 4 });
/** 塗りの色がこの値（pdfjs の setFillRGBColor の引数）だけのパスは地（白抜き・ページ背景）として拾わない。 */
export const PDF_BACKGROUND_FILL = '#ffffff';
/** PDF 読込みの警告コード（保存は止めない。画面に出して残す）。 */
export const PdfWarning = Object.freeze({
  PAGE_LIMIT:    'pageLimit',    // ページ数が PDF_MAX_PAGES を超える（先頭からだけ選べる）
  NO_PATHS:     'noPaths',      // 選んだ範囲にパスが無い
  TEXT_IGNORED:  'textIgnored',  // 文字（showText 系）を無視した（件数）
  IMAGE_IGNORED: 'imageIgnored', // 画像（paintImage 系）を無視した（件数）
  PATH_LIMIT:    'pathLimit',    // パス数が PDF_MAX_PATH_OPS を超えて打ち切った
  SCALE_MISSING: 'scaleMissing', // 縮尺が未入力・不正（mm へ換算できない）
  UNKNOWN_DRAW_OP:    'unknownDrawOp',    // 経路データの未知の描画命令で、その経路の残りを読めなかった（件数）
  NON_FINITE_SEGMENT: 'nonFiniteSegment', // 座標が有限でない線分を捨てた（件数）
});
/** PATH_LIMIT の打ち切りの種類（経路数か線分数か）。 */
export const PdfLimitKind = Object.freeze({ PATHS: 'paths', SEGMENTS: 'segments' });
/** PDF を読み込まず拒否する理由。 */
export const PdfReject = Object.freeze({
  NOT_PDF:            'notPdf',            // PDF ではない（署名が無い）
  LOAD_FAILED:        'loadFailed',        // pdfjs が開けなかった（壊れている・暗号化など）
  WORKER_UNAVAILABLE: 'workerUnavailable', // worker を起動できなかった
  SIZE_LIMIT:         'sizeLimit',         // ファイルが PDF_MAX_BYTES を超える（読み込まない）
  UNEXPECTED:         'unexpected',        // 純関数内の想定外の例外（握って通知）
});

// ---- 読込み後の初期表示（initialView.js。App.jsx の restoreReady 後に 1 回） ----
/** 初期表示の縮尺分母の候補（キリの良い倍率）。1階の通り芯の範囲が描画エリアに収まる最小の分母を選ぶ。 */
export const INITIAL_FIT_SCALE_DENOMS = Object.freeze([20, 30, 50, 100, 150, 200, 300, 500, 1000]);
/** 初期表示で通り芯の範囲と描画エリア内端の間に空ける余白（px）。壁の張り出し・軒先線ぶんの逃げ。 */
export const INITIAL_FIT_MARGIN_PX = 40;
