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

// 構造リストタブのグルーピング定義（PlanGraph の map 名 → 分類・ラベル・断面アイコン形状）。
// key はReactキー・display用の一意識別子（複数グループが同一mapNameを共有できるようmapNameとは独立に持つ）。
// filter（省略時は全件）は同一mapNameを role 等でさらに分けるグループ（梁/小梁）が使う。
// allowManualAdd:false は「＋追加」UIを出さない（小梁は梁芯CLからの自動生成のみ）。
// hideWhenEmpty:true は0件時にセクション自体を非表示にする（groupMemberKindsによる分類全体の
// 非表示とは別軸——梁カテゴリ自体は表示するが、小梁が1本もない基礎伏図/R階伏図等では空セクションを出さない）。
export const MEMBER_GROUPS = [
  { key: 'column',  mapName: 'columnMap',  category: MEMBER_CATEGORY.COLUMN_LIKE, label: '柱・杭',     iconShape: 'square' },
  { key: 'footing', mapName: 'footingMap', category: MEMBER_CATEGORY.BOX_LIKE,    label: '基礎・柱脚', iconShape: 'box' },
  { key: 'beam',    mapName: 'beamMap',    category: MEMBER_CATEGORY.ROD,         label: '梁',         iconShape: 'band',
    filter: b => b.role !== 'secondary' },
  { key: 'beamSub', mapName: 'beamMap',    category: MEMBER_CATEGORY.ROD,         label: '小梁',       iconShape: 'band',
    filter: b => b.role === 'secondary', allowManualAdd: false, hideWhenEmpty: true },
  { key: 'slab',    mapName: 'slabMap',    category: MEMBER_CATEGORY.PLANE_H,     label: 'スラブ',     iconShape: 'plane' },
  { key: 'wall',    mapName: 'wallMap',    category: MEMBER_CATEGORY.PLANE_V,     label: '耐力壁',     iconShape: 'wall' },
];

// 削除APIの対応表（PlanGraph側のメソッド名）
export const REMOVE_FN_BY_MAP = {
  columnMap:  'removeColumn',
  footingMap: 'removeFooting',
  beamMap:    'removeBeam',
  slabMap:    'removeSlab',
  wallMap:    'removeWall',
};

// 採番対象の map 名（structural/memberNumbering.js・memberGroups.js 共通）。
export const NUMBERED_MAPS = ['columnMap', 'beamMap', 'wallMap', 'slabMap', 'footingMap'];

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

// ================================================================
// 部材番号の「材寸グループ採番」（structural/memberNumbering.js・memberGroups.js が使う）
//
// 署名（signature）＝グループの同一性判定に使うキー、spec＝グループが確定した材寸そのもの（台帳の
// grp.spec:<gid> に書く文字列・部材へ書き戻す文字列）。どちらも同じフィールド集合（このマップ）から
// 生成する（fieldPacking.js と同様、ドット記法で1段ネストを表す。JSON.stringify/parseは使わない）。
// ================================================================
export const SIGNATURE_FIELDS_BY_MAP = {
  columnMap: ['sectionDefId', 'mainBars.count', 'mainBars.size', 'hoopBars.size', 'hoopBars.pitch', 'pileType', 'pileDiameter'],
  footingMap: ['sectionDefId', 'sectionShape', 'widthX', 'widthY', 'mainBars.size', 'mainBars.pitch', 'baseType', 'anchorBoltCount', 'anchorBoltSize'],
  beamMap: ['sectionDefId', 'beamWidth', 'beamDepth', 'topMainBars.count', 'topMainBars.size', 'bottomMainBars.count', 'bottomMainBars.size', 'stirrupBars.size', 'stirrupBars.pitch'],
  slabMap: ['thickness', 'slabKind', 'deckDirection', 'mainBars.size', 'mainBars.pitch', 'distributionBars.size', 'distributionBars.pitch'],
  wallMap: ['thickness', 'wallType', 'verticalBars.size', 'verticalBars.pitch', 'horizontalBars.size', 'horizontalBars.pitch'],
};

// entity[path] をドット記法（1段ネストのみ）で読む。fieldPacking.js の逆変換と対の読み取り専用版。
function readPath(entity, path) {
  const dot = path.indexOf('.');
  if (dot < 0) return entity[path];
  return entity[path.slice(0, dot)]?.[path.slice(dot + 1)];
}
function formatValue(v) { return v == null ? '' : String(v); }

function buildFieldPairs(entity, mapName) {
  return (SIGNATURE_FIELDS_BY_MAP[mapName] ?? []).map(f => [f, formatValue(readPath(entity, f))]);
}

/** グループの同一性判定キー（mapName・記号・材料・SIGNATURE_FIELDS_BY_MAP のフィールド値を連結）。
 *  entity.numberGroupId が無い部材の既定 groupKey、および台帳 grp.join との一致判定に使う。 */
export function memberSignature(entity, mapName) {
  const symbol = memberSymbol(entity, mapName);
  const pairs = buildFieldPairs(entity, mapName);
  return `${mapName}|${symbol}|${entity.materialType}|${pairs.map(([k, v]) => `${k}=${v}`).join('|')}`;
}

/** グループが確定した材寸の永続表現（台帳 grp.spec:<gid> の値・conform 時に部材へ書き戻す文字列）。
 *  signature と異なり mapName・記号・材料は含まない（部材側に既に materialType があるため冗長）。 */
export function memberSpecString(entity, mapName) {
  return buildFieldPairs(entity, mapName).map(([k, v]) => `${k}=${v}`).join('|');
}

// 配筋サイズ文字列（例 'D25'）から数値部分を取り出す（呼び径の大小比較用）。
function barNumeric(size) {
  const m = String(size ?? '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : 0;
}
// 本数×呼び径（柱・梁の主筋量の近似比較値）。
function barWeight(bar) { return (bar?.count ?? 0) * barNumeric(bar?.size); }
// 呼び径×(1000/ピッチ)（スラブ・耐力壁の配筋密度の近似比較値）。
function barDensity(bar) { return bar?.pitch ? barNumeric(bar.size) * (1000 / bar.pitch) : 0; }

// 大小比較キー（配列を先頭要素から比較。数値が大きいほど「大きい」＝採番で若い番号が先）。
// 断面の大小は外接矩形 width×height（丸は径がwidth=heightとしてカタログに入っているため同一計算式で成立）。
export const SIZE_KEY_BY_MAP = {
  columnMap(entity) {
    const sec = findSectionEntry(entity.sectionDefId);
    const area = sec ? sec.width * sec.height : 0;
    return [area, barWeight(entity.mainBars)];
  },
  footingMap(entity) {
    const area = (entity.widthX ?? 0) * (entity.widthY ?? 0);
    const embedDepth = entity.pedestalDepth
      ?? (entity.topLevel != null && entity.bottomLevel != null ? Math.abs(entity.bottomLevel - entity.topLevel) : 0);
    return [area, embedDepth];
  },
  beamMap(entity) {
    const barScore = barWeight(entity.topMainBars) + barWeight(entity.bottomMainBars);
    if (entity.role === 'foundation') return [entity.beamDepth ?? 0, entity.beamWidth ?? 0, barScore];
    const sec = findSectionEntry(entity.sectionDefId);
    const height = sec?.height ?? entity.beamDepth ?? 0;
    const width  = sec?.width  ?? entity.beamWidth  ?? 0;
    return [height, width, barScore];
  },
  slabMap(entity) {
    return [entity.thickness ?? 0, barDensity(entity.mainBars) + barDensity(entity.distributionBars)];
  },
  wallMap(entity) {
    return [entity.thickness ?? 0, barDensity(entity.verticalBars) + barDensity(entity.horizontalBars)];
  },
};

/** entity の sizeKey（SIZE_KEY_BY_MAP[mapName] の結果。未定義 mapName は空配列）。 */
export function memberSizeKey(entity, mapName) {
  return SIZE_KEY_BY_MAP[mapName]?.(entity) ?? [];
}
