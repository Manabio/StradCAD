// ================================================================
// 構造由来の分類の「単一の真実」（問題.md のデータ化）。
//
// 「主構造 × (図面種別・部材role ／ スライダースロット種別) → 有無」を1テーブルに集約する。
// 各consumer が *データだけ* をここから読む：
//   生成        … structuralAutoFill.js（FIGURE_MEMBERS で部材生成を取捨）
//   構造リスト   … MemberListTab.jsx（FIGURE_MEMBERS で分類を出し分け）
//   スライダー   … App.jsx / buildStructuralFigureSlots（SLOT_PRESENCE でスロットを取捨）
//   削除        … structuralRecompute.js（×化した自動部材を削除候補に）
// 機構（生成・図面合成・描画）は統合しない——figure.md の「生成≠図面選定」を守るため、
// ここはあくまで宣言データに留める。
//
// 静的な参照データ（core.js 非依存。memberCatalog.js と同じく循環import回避）。
// 主構造キーは StructuralInfoDialog.MAIN_STRUCTURE_OPTIONS の正式表記（'未定' を除く6種）と一致させる。
// ※ RC造は半角括弧 '(...)' 、木造は全角括弧 '（...）' の混在表記が正規（MAIN_STRUCTURE_OPTIONS 準拠）。
// ================================================================

// 主構造の正規キー（表示順）。SLOT_PRESENCE / FIGURE_MEMBERS の boolean 配列はこの並びに対応する。
export const STRUCTURES = Object.freeze([
  'RC造(ラーメン)', 'RC造(壁式)', 'S造', 'SRC造', '木造（在来）', '木造（2"×4"）',
]);

// 主構造ごとの性質。
//  isRigidFrame : 柱・梁でラーメン躯体を構成する構造形式か（柱芯＝偏芯量の対象。木造・壁式は対象外）。
//  baseMaterial : 既定の構造材料（StructuralMaterialType の値と一致する文字列リテラル。core.js 非依存のため直書き）。
export const STRUCTURE_PROFILES = Object.freeze({
  'RC造(ラーメン)': { isRigidFrame: true,  baseMaterial: 'RC'    },
  'RC造(壁式)':    { isRigidFrame: false, baseMaterial: 'RC'    },
  'S造':           { isRigidFrame: true,  baseMaterial: 'STEEL' },
  'SRC造':         { isRigidFrame: true,  baseMaterial: 'STEEL' },
  '木造（在来）':   { isRigidFrame: false, baseMaterial: 'WOOD'  },
  '木造（2"×4"）': { isRigidFrame: false, baseMaterial: 'WOOD'  },
});

/** 主構造の性質を返す。未知（'未定' 等）は既定（非ラーメン・木造材）——生成・変換は呼び出し側で別途ガード済み。 */
export function structureProfile(structure) {
  return STRUCTURE_PROFILES[structure] ?? { isRigidFrame: false, baseMaterial: 'WOOD' };
}

/** 実効主構造がラーメン系（柱・梁躯体）か。柱芯オフセットの対象判定に使う（従来 structuralAutoFill 内の同名関数を移設）。 */
export function isRigidFrameStructure(structure) {
  return structureProfile(structure).isRigidFrame;
}

// ----------------------------------------------------------------
// A. 図面種別 × 部材の有無（問題.md「構造リストの図に表示される構造ごと分類」）
// ----------------------------------------------------------------

// 図面種別（部材の出し分けの軸）。地階躯体図・小屋伏図は Phase B でスロットと共に追加する。
export const FIGURE_TYPE = Object.freeze({
  FOUNDATION:       'foundation',      // 基礎伏図（地階のない建物）
  ABOVEGROUND:      'aboveground',     // 地上階伏図（n階伏図）
  ROOF:             'roof',            // R階伏図（最上。屋根スラブ伏図）
  UNDERGROUND_BEAM: 'undergroundBeam', // 地中梁図（地階≥2のとき最下）
});

// 部材種別（出し分けの粒度）。footing/beam は role まで割る——問題.md がベース/柱脚・梁/基礎梁を別行に持つため。
export const MEMBER_KIND = Object.freeze({
  COLUMN:              'column',             // 柱
  BEAM:                'beam',               // 梁（大梁・小梁。role:'primary'/'secondary'）
  FOUNDATION_BEAM:     'foundationBeam',     // 基礎梁・地中梁（role:'foundation'）
  INDEPENDENT_FOOTING: 'independentFooting', // ベース（独立基礎。footingMap の IndependentFooting）
  COLUMN_BASE:         'columnBase',         // 柱脚（footingMap の ColumnBase）
  SLAB:                'slab',               // スラブ
  WALL:                'wall',               // 壁（耐力壁 wallMap）
});

// 図面種別 × 部材 → 有無（問題.md 表A）。値は STRUCTURES と同順の boolean 配列。
// 未登録の (figureType, memberKind) は figureShowsMember が true（出し分けしない＝常に表示・生成）を返す。
//                                            RCラ   RC壁    S      SRC    木在   木2×4
export const FIGURE_MEMBERS = Object.freeze({
  [FIGURE_TYPE.FOUNDATION]: {
    [MEMBER_KIND.FOUNDATION_BEAM]:     [true,  true,  true,  true,  true,  true ], // 基礎梁
    [MEMBER_KIND.INDEPENDENT_FOOTING]: [true,  true,  true,  true,  true,  true ], // ベース
    [MEMBER_KIND.COLUMN_BASE]:         [true,  false, true,  true,  false, false], // 柱脚
  },
  [FIGURE_TYPE.ABOVEGROUND]: {
    [MEMBER_KIND.COLUMN]: [true,  false, true,  true,  true,  false], // 柱
    [MEMBER_KIND.BEAM]:   [true,  false, true,  true,  true,  false], // 梁
    [MEMBER_KIND.WALL]:   [true,  true,  false, true,  true,  true ], // 壁（耐力壁）
    [MEMBER_KIND.SLAB]:   [true,  true,  true,  true,  true,  false], // スラブ
  },
  // R階伏図：柱・梁・スラブのみ（それ以外＝壁・基礎系はカテゴリ自体非表示）。スラブはS造＝デッキ/ブレースだが
  // 「表示する」点で○（描き方の違いは slabFigure 側）。「それ以外非表示」は既定 true を覆すため明示 false を置く。
  [FIGURE_TYPE.ROOF]: {
    [MEMBER_KIND.COLUMN]:              [true,  false, true,  true,  true,  false], // 柱
    [MEMBER_KIND.BEAM]:               [true,  false, true,  true,  true,  false], // 梁
    [MEMBER_KIND.SLAB]:               [true,  true,  true,  true,  false, false], // スラブ（S造=デッキ/ブレース）
    [MEMBER_KIND.WALL]:               [false, false, false, false, false, false], // 壁＝非表示
    [MEMBER_KIND.INDEPENDENT_FOOTING]: [false, false, false, false, false, false], // ベース＝非表示
    [MEMBER_KIND.COLUMN_BASE]:         [false, false, false, false, false, false], // 柱脚＝非表示
  },
  // 地中梁図は「地階＝RC造」固定で構造ゲートを掛けない（どの主構造でも生成）。表示は柱・基礎梁・スラブのみ
  // （ベース・柱脚はその上の基礎伏図側＝それ以外非表示）。Phase B で図面として接続する。
  [FIGURE_TYPE.UNDERGROUND_BEAM]: {
    [MEMBER_KIND.COLUMN]:              [true,  true,  true,  true,  true,  true ], // 柱
    [MEMBER_KIND.FOUNDATION_BEAM]:     [true,  true,  true,  true,  true,  true ], // 基礎梁（地中梁）
    [MEMBER_KIND.SLAB]:               [true,  true,  true,  true,  true,  true ], // スラブ
    [MEMBER_KIND.INDEPENDENT_FOOTING]: [false, false, false, false, false, false], // ベース＝非表示
    [MEMBER_KIND.COLUMN_BASE]:         [false, false, false, false, false, false], // 柱脚＝非表示
  },
});

/** map名＋entityから出し分けマトリクスの部材種別キーを導出する。
 *  footing→ベース/柱脚（ColumnBase は 'baseType' を持つ）、beam→梁/基礎梁（role:'foundation'）で割る。
 *  memberCatalog.memberSymbol と同じ判定基準を使う。 */
export function memberKindOf(mapName, entity) {
  switch (mapName) {
    // 杭（柱 role:'foundation'＝PIL）は表A対象外＝ゲートしない（null）。通常柱のみ「柱」行で取捨する。
    case 'columnMap':  return entity?.role === 'foundation' ? null : MEMBER_KIND.COLUMN;
    case 'footingMap': return (entity && 'baseType' in entity) ? MEMBER_KIND.COLUMN_BASE : MEMBER_KIND.INDEPENDENT_FOOTING;
    case 'beamMap':
      if (entity?.role === 'foundation') return MEMBER_KIND.FOUNDATION_BEAM; // 基礎梁・地中梁
      // 軒桁(eaves)・屋根架構(roof)は表A対象外（屋根+/小屋伏図側・部材生成は次フェーズ）＝ゲートしない。
      if (entity?.role === 'eaves' || entity?.role === 'roof') return null;
      return MEMBER_KIND.BEAM; // 大梁(primary)・小梁(secondary)
    case 'slabMap':    return MEMBER_KIND.SLAB;
    case 'wallMap':    return MEMBER_KIND.WALL;
    default:           return null;
  }
}

/** その図面種別・部材種別を、その主構造で出す（生成・表示する）か。
 *  未登録の組み合わせ・未知の主構造は true（出し分けしない）。 */
export function figureShowsMember(figureType, memberKind, structure) {
  const idx = STRUCTURES.indexOf(structure);
  const row = FIGURE_MEMBERS[figureType]?.[memberKind];
  if (!row || idx < 0) return true;
  return row[idx];
}

// 部材種別 → 生成・削除・表示を支配する図面種別。各部材は「地上階伏図の部材」か「基礎伏図の部材」の
// いずれかに属する（問題.md 表Aの2グループ）。1枚の平面が複数カテゴリの部材を生成しても
// （基礎面＝自階の柱＋床下の基礎）、部材ごとに正しい行で取捨できる
// （柱は常に地上階の柱ルール、基礎梁は常に基礎ルール）。地中梁図(UNDERGROUND_BEAM)は専用平面の
// figureType を直接渡す Phase B 側で扱うため、ここには現れない（FOUNDATION と同値＝常に○のため実害なし）。
export const GOVERNING_FIGURE = Object.freeze({
  [MEMBER_KIND.COLUMN]:              FIGURE_TYPE.ABOVEGROUND,
  [MEMBER_KIND.BEAM]:                FIGURE_TYPE.ABOVEGROUND,
  [MEMBER_KIND.WALL]:               FIGURE_TYPE.ABOVEGROUND,
  [MEMBER_KIND.SLAB]:               FIGURE_TYPE.ABOVEGROUND,
  [MEMBER_KIND.FOUNDATION_BEAM]:     FIGURE_TYPE.FOUNDATION,
  [MEMBER_KIND.INDEPENDENT_FOOTING]: FIGURE_TYPE.FOUNDATION,
  [MEMBER_KIND.COLUMN_BASE]:         FIGURE_TYPE.FOUNDATION,
});

/** その部材種別を、その主構造で生成・表示するか（部材の所属図面ルールで判定）。
 *  未知の部材種別・主構造は true。生成（autoFill）・削除（deleteClassificationOverflow）・
 *  構造リスト表示の共通ゲート。
 *  figureType を渡すと所属図面ルール（GOVERNING_FIGURE）を上書きする——R階伏図など、平面が
 *  単一図面種別に属し全部材をその図面ルールで判定する場合に使う（構造リスト表示のみ。生成・削除は
 *  GOVERNING_FIGURE のまま＝R階の生成/削除は別経路が担う）。 */
export function structureHasMemberKind(memberKind, structure, figureType = null) {
  return figureShowsMember(figureType ?? GOVERNING_FIGURE[memberKind] ?? null, memberKind, structure);
}

// ----------------------------------------------------------------
// B. スライダー図面スロットの有無（問題.md「平面と構造の移動スライダーのラベル対応」）
// ----------------------------------------------------------------

// スライダー図面スロット種別（下→上の概念順）。Phase B で buildStructuralFigureSlots が消費する。
export const SLOT_TYPE = Object.freeze({
  UNDERGROUND_BEAM: 'undergroundBeam', // 地中梁図（地階≥2のとき最下）
  UNDERGROUND_BODY: 'undergroundBody', // Bn躯体図（各地階）
  FOUNDATION:       'foundation',      // 基礎伏図（地階のない建物）
  GROUND_FLOOR:     'groundFloor',     // 1階伏図（地階なし・木造のみ。基礎伏図に追加）
  FLOOR:            'floor',           // n階伏図（各地上階）
  ROOF_SLAB:        'roofSlab',        // R階伏図（最上）
  ROOF_FRAME:       'roofFrame',       // 屋根+ →（選択時）小屋伏図（最上）
});

// スロット種別 × 主構造 → 出現（問題.md 表B）。値は STRUCTURES と同順の boolean 配列。
//                                       RCラ   RC壁    S      SRC    木在   木2×4
export const SLOT_PRESENCE = Object.freeze({
  [SLOT_TYPE.UNDERGROUND_BEAM]: [true,  true,  true,  true,  true,  true ],
  [SLOT_TYPE.UNDERGROUND_BODY]: [true,  true,  true,  true,  true,  true ],
  [SLOT_TYPE.FOUNDATION]:       [true,  true,  true,  true,  true,  true ],
  [SLOT_TYPE.GROUND_FLOOR]:     [false, false, false, false, true,  true ],
  [SLOT_TYPE.FLOOR]:            [true,  true,  true,  true,  true,  true ],
  [SLOT_TYPE.ROOF_SLAB]:        [true,  true,  true,  true,  false, false],
  [SLOT_TYPE.ROOF_FRAME]:       [false, false, true,  false, true,  true ],
});

/** そのスロット種別が、その主構造でスライダーに出現するか。未登録・未知は true。 */
export function slotPresent(slotType, structure) {
  const idx = STRUCTURES.indexOf(structure);
  const row = SLOT_PRESENCE[slotType];
  if (!row || idx < 0) return true;
  return row[idx];
}
