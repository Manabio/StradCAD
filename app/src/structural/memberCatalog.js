// 注意: このファイルは core.js から（memberNumbering.js 経由で）import されるため、
// 循環import回避のため core.js への依存を持たない（StructuralMaterialType の値は文字列リテラルで直接扱う）。

import { findSectionEntry, WOOD_SQUARE_WIDTHS } from './sectionCatalog.js';

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
    filter: b => b.role !== 'secondary' && b.role !== 'landing' && b.role !== 'floor' },
  { key: 'beamSub', mapName: 'beamMap',    category: MEMBER_CATEGORY.ROD,         label: '小梁',       iconShape: 'band',
    filter: b => b.role === 'secondary', allowManualAdd: false, hideWhenEmpty: true },
  // 踊り場受け梁（WP-B。小梁と同型＝通り芯グリッドではなく階段の踊り場辺から自動生成するため
  // 手動追加UIなし。1本も無い階（階段の無い階・木造階段の階）ではセクション自体を隠す）。
  { key: 'beamLanding', mapName: 'beamMap', category: MEMBER_CATEGORY.ROD,        label: '踊り場梁',   iconShape: 'band',
    filter: b => b.role === 'landing', allowManualAdd: false, hideWhenEmpty: true },
  // 床梁（在来木造ステップ3e-2。小梁・踊り場受け梁と同型＝梁で囲まれたセルから自動生成するため
  // 手動追加UIなし。非在来・床梁の無い階ではセクション自体を隠す）。
  { key: 'beamFloor', mapName: 'beamMap', category: MEMBER_CATEGORY.ROD,          label: '床梁',       iconShape: 'band',
    filter: b => b.role === 'floor', allowManualAdd: false, hideWhenEmpty: true },
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

// 未採番（entity.memberNo が null）の表示・グルーピング用タグ。構造リストタブ（MemberListTab.jsx
// computeTagGroups）と描画エリアのタップ選択（renderer/SceneLayers.jsx openMemberCard）が同じ値で
// フォーカスキーを一致させるための単一の定義（一方だけ直書きすると未採番部材でフォーカスが外れる）。
export const UNNUMBERED_TAG = '(未採番)';

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
        case 'floor':      return 'FB'; // 床梁
        case 'foundation': return 'FG'; // 基礎梁
        case 'eaves':      return 'EG'; // 軒桁
        case 'roof':       return entity.beamType === '垂木' ? 'RF' : 'PR'; // 垂木 / 母屋
        case 'landing':    return 'LG'; // 踊り場受け梁
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
    // 在来木造（columnSizing:'fixed'）は柱寸が「各階柱寸法」欄（structural リスト柱グループ見出し）の
    // 値で決まるため、部材ごとの断面選択は意味を持たない——基礎（杭・柱脚扱いの role:'foundation'）は対象外
    // （柱寸法欄は上部構造の柱の話で杭断面には連動しない）。ctx.woodFixedSection は呼び出し側
    // （MemberListTab.jsx MemberCard の fieldCtx）が rules.columnSizing==='fixed' から解決して渡す。
    { key: 'sectionDefId',  label: '断面',     kind: 'section',
      disabledWhen: (e, ctx) => ctx?.woodFixedSection === true && e.role !== 'foundation' },
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
    // 在来木造（columnSizing:'fixed'）は梁の材幅も「下階柱同寸」（梁を支える1つ下の実体階の「各階柱寸法」欄。
    // conformWoodSectionsが resolvedBeamColumnWidthMm へそろえる）で決まるため、部材ごとの断面選択は意味を
    // 持たない——基礎梁（役割上RC・寸法は別欄で算定）は対象外。
    { key: 'sectionDefId',     label: '断面',   kind: 'section',
      disabledWhen: (e, ctx) => ctx?.woodFixedSection === true && e.role !== 'foundation' },
    // 接合方法（鉄骨の梁のみ）。when=表示条件、disabledWhen=グレー化条件（値は見せるが変更させない）。
    // 柱に取りつかない梁＝梁に接合する梁（小梁）はピン接合で固定のため選択させない（ユーザー指示）。
    // materialType は 'STEEL'（core.js を import しない方針のため文字列リテラル。ファイル冒頭の注意参照）。
    { key: 'jointType', label: '接合', kind: 'select', options: ['RIGID', 'PIN'],
      optionLabels: { RIGID: '剛接合', PIN: 'ピン接合' },
      when:        e => e.materialType === 'STEEL',
      disabledWhen: (e, ctx) => !e.joinsColumn?.(ctx?.columns) },
    { key: 'levelOffset',      label: '天端レベル（FL基準）', kind: 'number' },
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

// ================================================================
// 非正角材（成≠幅）の梁の個別採番（在来木造。ユーザー裁定2026-09-16。設計意図は
// .claude/structural-model.md ステップ4第3単位）。
//
// 標準材（standardSection引数。省略時 rules.defaultSections.beam＝建物共通の固定値）以外の在来木造の
// 梁は、成が同じでも材ごとに個別のグループとして管理する（伏図で材をタップして選択する対象でもある）。
// 在来木造は「標準材＝階の柱寸の正角」（structureRules.js woodColumnSectionId。ステップ4 C-2）なので、
// 呼び出し側（structural/memberNumbering.js・MemberListTab.jsx）がそれを解決して渡す。rules 自体も
// 呼び出し側（structureRules.js の rulesFor）が解決して渡す——ここは structureRules.js を import しない
// （structureRules.js が memberCatalog.js を import する循環を避けるため。ファイル冒頭の注意と同じ理由）。
// ================================================================

/** entity が個別採番の対象か（在来木造の非標準梁、または柱寸を個別指定した在来木造の柱）。
 *  柱（mapName==='columnMap'）は rules.numbering.individualColumns==='widthOverride'（在来木造だけ。
 *  ステップ3）かつ entity.woodColumnWidthMm が木造正角のカタログ幅（WOOD_SQUARE_WIDTHS）に含まれる
 *  ときだけ対象——杭（role:'foundation'）は柱寸法欄の対象外なので除く。カタログ外の値（旧データ等）は
 *  個別扱いにしない（QA裁定10: 採番だけ個別・寸法解決は階の値というねじれを作らない——
 *  structureRules.js の columnWidthMm/columnSectionId も同じ「カタログ幅か否か」だけで判定するため、
 *  ここを合わせることで「個別採番されるが表示は共通の値」という食い違いを防ぐ）。
 *  「個別指定＝階の値と同値」は MemberListTab.jsx の MemberColumnWidthSelect が書き込み時点で
 *  null（共通）へ正規化するため存在しない（このファイルは graph を持たず階の値と直接比較できない
 *  ——排他の保証は書き込み側の責務）。standardSection は柱側では使わない（柱の「標準」は個体の
 *  woodColumnWidthMm の有無そのもので、断面キーの一致比較ではないため）。
 *  梁は従来どおり: rules.numbering.individualBeamRoles を持たない主構造（非在来6種・未定）は常にfalse。
 *  standardSection＝標準材のsectionDefId（省略時 rules.defaultSections.beam＝建物共通の固定値）。
 *  在来木造は呼び出し側（structural/memberNumbering.js・MemberListTab.jsx）が structureRules.js の
 *  woodColumnSectionId（階の柱寸から導く正角）を解決して渡す——このファイルは循環import回避のため
 *  structureRules.js を import しない（ファイル冒頭の注意）。 */
export function isIndividuallyNumbered(entity, mapName, rules, standardSection = rules.defaultSections.beam) {
  if (mapName === 'columnMap') {
    return rules.numbering?.individualColumns === 'widthOverride'
      && entity.materialType === rules.baseMaterial
      && entity.role !== 'foundation'
      && WOOD_SQUARE_WIDTHS.includes(entity.woodColumnWidthMm);
  }
  return mapName === 'beamMap'
    && (rules.numbering?.individualBeamRoles?.includes(entity.role) ?? false)
    && entity.materialType === rules.baseMaterial
    && entity.sectionDefId !== standardSection;
}

/** グループキー（memberNumbering.js collectFloorGroups/applyNumbers・MemberListTab.jsx の groupKey導出の
 *  唯一の入口）。numberGroupId（分割・統合済み）を最優先し、無ければ個別採番対象は部材ごとに一意
 *  （signature+id）、それ以外は従来どおり signature（同一材寸＝同一グループ）。
 *  columnMap かつ rules.numbering.columnGroupScope==='floor'（在来木造。structureRules.js）のときだけ、
 *  共通柱（個別採番対象でない柱）の groupKey に `@<planeId>` を付けて階ごとに分ける——柱（管柱）は
 *  階の部材で建物全体をまたがないため（ユーザー裁定2026-09-17）。signature 自体（台帳 grp.join・
 *  memberSignature の比較）は変えない——階の分離は groupKey だけの話（noJoinSignatureFor 参照）。
 *  呼び出し側（memberNumbering.js・MemberListTab.jsx）が graph.plane.id を渡す——このファイルは
 *  graph を持たない設計（循環import回避）のため引数で受け取るだけで、省略時（null）は従来どおり
 *  建物全体で1グループ（既存テスト・非対応呼び出し元の後方互換）。 */
export function memberGroupKey(entity, mapName, rules, standardSection = rules.defaultSections.beam, planeId = null) {
  if (entity.numberGroupId) return entity.numberGroupId;
  const signature = memberSignature(entity, mapName);
  if (isIndividuallyNumbered(entity, mapName, rules, standardSection)) return `${signature}#${entity.id}`;
  if (mapName === 'columnMap' && rules.numbering?.columnGroupScope === 'floor' && planeId != null) return `${signature}@${planeId}`;
  return signature;
}

/** 採番の並び順キー（memberNumbering.compareGroupsDesc がsizeKey・出現階に次ぐタイブレークに使う）。
 *  個別採番対象は位置（柱＝座標(x,y)・梁＝軸方向→軸座標→区間下端）で決める——idに依存しないため、
 *  部材の再生成でidが変わっても番号が安定する。非個別・非梁・非柱は空配列（従来どおりsignatureでタイブレーク）。
 *  柱はAXIS（axisX/axisY。偏心を含まない）で取る——個別柱の偏心（woodColumnOffset.js）の値が変わっても
 *  グリッド位置は変わらないため、無関係な採番順の揺れを避ける（.claude/structural-model.md参照）。 */
export function memberOrderKey(entity, mapName, rules, standardSection = rules.defaultSections.beam) {
  if (!isIndividuallyNumbered(entity, mapName, rules, standardSection)) return [];
  if (mapName === 'columnMap') return [entity.axisX ?? 0, entity.axisY ?? 0];
  return [entity.isVertical ? 1 : 0, entity.axisValue ?? 0, Math.min(entity.coord1 ?? 0, entity.coord2 ?? 0)];
}

/** 手動採番の materialize（MemberListTab.jsx commitManualNumber）・統合（mergeGroups。QA指摘F12で
 *  対象を拡張）で memberGroups.splitGroup/mergeGroups へ渡す splitFromSignature。個別採番対象は
 *  常に「今の署名」を返し、join=false を強制する——署名が一致するので join は必ず抑止される。台帳
 *  （grp.join）を書くと、直後の conformToLedger が「gid未設定かつ同署名」の他の個別採番対象
 *  （同じ標準外断面の別の梁）まで新gidへ吸収してしまい、個別採番が無効化される
 *  （QA指摘F1: 120×330 ×3本で1本に手動タグを打つと3本ともそのタグに統合された。QA指摘F12: 統合
 *  経路も同じ穴＝個別採番4本のうち2本だけ統合しても4本とも同じタグになった）。個別採番対象で
 *  なければ null（従来どおり常にjoinする＝同署名の将来の部材も自動で同じタグに合流する。この既定
 *  挙動は個別採番と無関係の構造では維持する）。
 *  **共通柱（在来木造・columnGroupScope='floor'）はここでは対象にしない**——QA裁定（2026-09-17）:
 *  一時期ここで在来columnMapのjoinを個別/共通問わず全面抑止したが、在来木造の柱は壁交点から
 *  毎回自動生成されるため、手動タグを打った直後に同じ階へ新たに生成された同寸の共通柱まで
 *  join抑止で合流しなくなり実害が出た（実測: 2階の柱にCXと手動タグ→壁交点から生成された同寸の
 *  後発共通柱が別グループのまま合流しない）。「他階への波及だけ遮断し、同一階内の合流は維持する」
 *  ためのjoin値（階を含む）は joinSignatureFor が別に持つ——ここ（join可否そのものの判定）は
 *  個別採番対象だけを見る素の判定に戻した。 */
export function noJoinSignatureFor(entity, mapName, rules, standardSection = rules.defaultSections.beam) {
  return isIndividuallyNumbered(entity, mapName, rules, standardSection) ? memberSignature(entity, mapName) : null;
}

/** grp.join（加入署名）に書く/比較する値の唯一の入口（memberGroups.js の materializeGroup が書き手・
 *  findGidByJoinSignature〔conformToLedger経由〕が読み手）。既定は memberSignature と同じ（従来どおり
 *  建物全体で合流＝同署名の他階の部材も次のモード境界で同じグループへ吸収される）。
 *  columnMap かつ rules.numbering.columnGroupScope==='floor'（在来木造）のときだけ signature に
 *  `@<planeId>` を付け、join（同署名の部材の自動合流）を**その階の中だけ**に限定する——他階への
 *  波及は遮断しつつ、同一階内で後から自動生成された同寸の柱（共通・個別を問わない）が既存の手動タグ
 *  グループへ合流する経路は維持する（QA裁定2026-09-17。noJoinSignatureFor のJSDoc参照）。
 *  standardSection は受け取らない（姉妹関数のmemberGroupKey/isIndividuallyNumberedと違い、floor-scope
 *  判定は columnGroupScope だけで決まり isIndividuallyNumbered を呼ばないため——未使用引数を残さない）。
 *  呼び出し側（memberGroups.js conformToLedger・MemberListTab.jsx commitManualNumber）が
 *  graph.plane.id を渡す——このファイルは graph を持たない設計のため引数で受け取るだけで、
 *  省略時（null）は従来どおり建物全体で1つの加入署名になる（後方互換）。 */
export function joinSignatureFor(entity, mapName, rules, planeId = null) {
  const signature = memberSignature(entity, mapName);
  return (mapName === 'columnMap' && rules?.numbering?.columnGroupScope === 'floor' && planeId != null)
    ? `${signature}@${planeId}` : signature;
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
