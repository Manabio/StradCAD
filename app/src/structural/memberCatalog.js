// 注意: このファイルは core.js から（memberNumbering.js 経由で）import されるため、
// 循環import回避のため core.js への依存を持たない（StructuralMaterialType の値は文字列リテラルで直接扱う）。

import { findSectionEntry } from './sectionCatalog.js';

// 構造部材の分類定義（A=点定義/B=軸定義/C=面定義/D=垂直面材。F=基礎・G=開口貫通は別分類でこの定数の対象外。
// CLAUDE.md「構造材定義」セクション参照）
export const MEMBER_CATEGORY = Object.freeze({
  COLUMN_LIKE: 'A1', // 柱・杭
  BOX_LIKE:    'A2', // 基礎・柱脚
  ROD:         'B',  // 梁系
  PLANE_H:     'C',  // スラブ系
  PLANE_V:     'D',  // 耐力壁
});

// 構造リストタブのグルーピング定義（PlanGraph の map 名 → 分類・ラベル・断面アイコン形状）
export const MEMBER_GROUPS = [
  { mapName: 'columnMap',  category: MEMBER_CATEGORY.COLUMN_LIKE, label: '柱・杭',     iconShape: 'square' },
  { mapName: 'footingMap', category: MEMBER_CATEGORY.BOX_LIKE,    label: '基礎・柱脚', iconShape: 'box' },
  { mapName: 'beamMap',    category: MEMBER_CATEGORY.ROD,         label: '梁',         iconShape: 'band' },
  { mapName: 'slabMap',    category: MEMBER_CATEGORY.PLANE_H,     label: 'スラブ',     iconShape: 'plane' },
  { mapName: 'wallMap',    category: MEMBER_CATEGORY.PLANE_V,     label: '耐力壁',     iconShape: 'wall' },
];

// 削除APIの対応表（PlanGraph側のメソッド名）
export const REMOVE_FN_BY_MAP = {
  columnMap:  'removeColumn',
  footingMap: 'removeFooting',
  beamMap:    'removeBeam',
  slabMap:    'removeSlab',
  wallMap:    'removeWall',
};

// 描画エリアの部材タグをクリックした時、構造リストタブで自動フォーカスする「寸法」フィールド。
// 自動算定（memberSizing.js）の対象＝Tri-stateでロック制御するフィールドのみ対象（耐力壁・スラブは未対応）。
export const PRIMARY_DIMENSION_FIELD_BY_MAP = {
  columnMap:  'tributaryWidth',
  footingMap: 'widthX',
  beamMap:    'beamDepth',
};

// 構造リストタブの断面図（AutoScaledFigure）に渡す表示枠の上限(px)。図ごとに密度が異なる
// （柱は通り芯/柱芯/偏芯量のラベル・寸法が密集し縮尺が選定しにくいため、他より広めに確保する）。
// 未定義の mapName は規定値（230×270）を使う。
export const FIGURE_FRAME_BY_MAP = {
  columnMap: { maxWidth: 340, maxHeight: 320 },
};
export const DEFAULT_FIGURE_FRAME = { maxWidth: 230, maxHeight: 270 };

const MATERIAL_LABEL = {
  WOOD:  '木造',
  STEEL: 'S造',
  RC:    'RC造',
};
export function materialLabel(materialType) { return MATERIAL_LABEL[materialType] ?? materialType; }

// 部材番号の慣用記号（分類ごとに自動採番。新規追加時に自動付与、手動編集も可能）
export function memberSymbol(entity, mapName) {
  switch (mapName) {
    case 'columnMap':
      return entity.role === 'foundation' ? 'PIL' : 'C'; // 杭 / 柱
    case 'footingMap':
      return 'baseType' in entity ? 'CB' : 'F'; // 柱脚(ColumnBase) / 独立フーチング(IndependentFooting)
    case 'beamMap':
      switch (entity.role) {
        case 'secondary':  return 'B';  // 小梁
        case 'foundation': return 'FG'; // 基礎梁
        case 'eaves':      return 'EG'; // 軒桁
        case 'roof':       return entity.beamType === '垂木' ? 'RF' : 'PR'; // 垂木 / 母屋
        default:           return 'G';  // 大梁
      }
    case 'slabMap':
      switch (entity.role) {
        case 'mat_foundation': return 'MF'; // べた基礎
        case 'roof_panel':     return 'RS'; // 屋根版
        default:                return 'S'; // スラブ
      }
    case 'wallMap':
      return 'W'; // 耐力壁
    default:
      return '?';
  }
}

// 自動補完用の既定材料・断面（sectionCatalog.js の実在キーを参照）。
// キーは StructuralMaterialType の値（'WOOD'|'STEEL'|'RC'）と一致する文字列リテラル。
// 基礎・柱脚・耐力壁用（柱・梁ほどの形状の出し分けが無いため共用）。
export const DEFAULT_SECTION_BY_MATERIAL = Object.freeze({
  WOOD:  'WOOD-105x105',
  STEEL: 'STEEL-H200x100',
  RC:    'RC-300x300',
});

// 柱・杭用の既定断面（S造は角形鋼管）。
export const DEFAULT_COLUMN_SECTION_BY_MATERIAL = Object.freeze({
  WOOD:  'WOOD-105x105',
  STEEL: 'STEEL-SQ200x200x9.0',
  RC:    'RC-300x300',
});

// 梁系用の既定断面（S造はH形鋼）。
export const DEFAULT_BEAM_SECTION_BY_MATERIAL = Object.freeze({
  WOOD:  'WOOD-105x105',
  STEEL: 'STEEL-H200x100',
  RC:    'RC-300x300',
});

// 断面アイコンの縦横比（柱状=□／ロッド=帯／面材=面／壁状=縦帯の固定記号に、実寸の縦横比だけ反映する）。
// 断面形状マスター本体は次フェーズのため、現状フィールドにある寸法から導出できる範囲の近似値を返す。
export function sectionAspectRatio(entity, mapName) {
  if (mapName === 'footingMap') return entity.sectionShape === 'round' ? 1 : entity.widthX / entity.widthY;
  return 1; // 柱・梁・スラブ・耐力壁は断面寸法フィールドを持たないため既定の正方形/帯比率
}

// sectionDefId から断面マスターの形状種別を引く（柱・梁のみ実体を持つ。未設定/未知キーは null）。
export function sectionIconShape(entity) {
  return findSectionEntry(entity.sectionDefId)?.shape ?? null;
}

// アコーディオン展開フォームのフィールド定義（分類別。RoomCard の CARD_SECTIONS と同型）。
// kind: 'text' | 'number' | 'select' | 'levelPair'（topLevel/bottomLevel等の2値セット）
export const FIELD_DEFS_BY_CATEGORY = {
  [MEMBER_CATEGORY.COLUMN_LIKE]: [
    { key: 'sectionDefId',  label: '断面',     kind: 'section' },
    { key: 'topLevel',      label: '上端レベル', kind: 'number' },
    { key: 'bottomLevel',   label: '下端レベル', kind: 'number' },
  ],
  [MEMBER_CATEGORY.BOX_LIKE]: [
    { key: 'footingType', label: '基礎形式', kind: 'select', options: ['独立基礎', '複合基礎'] },
    { key: 'supportType', label: '支持形式', kind: 'select', options: ['直接基礎', '杭基礎'] },
    { key: 'baseType',    label: '柱脚形式', kind: 'select', options: ['露出', '埋込', 'ピン', '固定'] },
    { key: 'widthX',      label: '幅Wx',     kind: 'number' },
    { key: 'widthY',      label: '幅Wy',     kind: 'number' },
    { key: 'pedestalDepth', label: '埋込み深さd（自動算定）', kind: 'number' },
    { key: 'topLevel',    label: '上端レベル', kind: 'number' },
    { key: 'bottomLevel', label: '下端レベル', kind: 'number' },
  ],
  [MEMBER_CATEGORY.ROD]: [
    { key: 'sectionDefId',     label: '断面',   kind: 'section' },
    { key: 'levelOffset',      label: '基準レベル', kind: 'number' },
    { key: 'startLevelOffset', label: '始端オフセット', kind: 'number' },
    { key: 'endLevelOffset',   label: '終端オフセット', kind: 'number' },
    { key: 'beamWidth', label: '梁幅b（自動算定）', kind: 'number' },
    { key: 'beamDepth', label: '梁成D（自動算定）', kind: 'number' },
  ],
  [MEMBER_CATEGORY.PLANE_H]: [
    { key: 'slabKind',      label: '種別',       kind: 'select', options: ['slab', 'deck'] },
    { key: 'deckDirection', label: 'デッキ方向', kind: 'select', options: ['x', 'y'] },
    { key: 'thickness',     label: '厚み',       kind: 'number' },
    { key: 'levelRef',      label: '基準',       kind: 'select', options: ['top', 'bottom'] },
    { key: 'slopeAngle',    label: '勾配角度',   kind: 'number' },
  ],
  [MEMBER_CATEGORY.PLANE_V]: [
    { key: 'wallType',    label: '壁種別',     kind: 'select', options: ['rc', 'none', 'brace', 'steelPlate'] },
    { key: 'thickness',   label: '厚み',       kind: 'number' },
    { key: 'topLevel',    label: '上端レベル', kind: 'number' },
    { key: 'bottomLevel', label: '下端レベル', kind: 'number' },
  ],
};
