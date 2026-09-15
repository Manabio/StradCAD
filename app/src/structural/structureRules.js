// ================================================================
// 主構造・壁下地材ごとの「ルールセット」（2026-09-14「現在の描画決定プロセスを精査し、
// 主要構造、壁下地材ごとに入替えができるような合理的な仕組みを構築」。設計意図は .claude/structural-model.md）。
//
// 主構造で分岐する処理は、ここから `rulesFor(structure)` で引いた値・選択肢だけを読む。
// `startsWith('木造')` や `=== '木造（在来）'` のような主構造文字列の直接比較を各所に書かない
// （structureRules.test.js がソースを走査して直書きを検出する）。
//
// 分類（.claude/structural-model.md「主構造による分岐の3分類」）:
//   (1) 共通（構造非依存）        … ここには現れない（図面合成・採番・除外集合等の機構そのもの）。
//   (2) 処理は共通・値が構造で違う … 値フィールド（defaultSections / foundation.* / designation 等）。
//   (3) 処理そのものが違う        … 選択子フィールド（wallBeamAxes / foundation.beamSizing.kind 等）。
//       消費側は選択子で分岐し、処理本体は各モジュールが持つ（ここに処理は書かない）。
//
// 静的な参照データ（core.js 非依存。structuralClassification.js / memberCatalog.js と同じ循環import回避）。
// 主構造キーの正式表記は structuralClassification.STRUCTURES（'未定' を除く6種）が真実で、共通タブの
// 選択肢 MAIN_STRUCTURE_OPTIONS もここから組み立てる。
// ================================================================
import { STRUCTURES, STRUCTURE_PROFILES } from './structuralClassification.js';
import { DEFAULT_SECTION_BY_MATERIAL, DEFAULT_COLUMN_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { BackingClass } from '../finish/materials/backingClass.js';

/** 主構造未指定を表す値（MAIN_STRUCTURE_OPTIONS[0]。core/structuralInfo.js の既定・FlatBuffers復元の既定もこれ）。 */
export const UNSPECIFIED_STRUCTURE = '未定';
/** 木造（在来）の正式表記（グリッド910提案・在来限定ルールの唯一の直書き）。 */
export const TRADITIONAL_WOOD_STRUCTURE = '木造（在来）';

/** 主構造の系統（材種とは別軸: SRC造は baseMaterial=STEEL だが RC も持つ）。 */
export const StructureFamily = Object.freeze({ WOOD: 'wood', STEEL: 'steel', RC: 'rc' });

// 共通タブ「主構造」「その他」の選択肢（正式表記。'未定' 以外はルールセットのキーそのもの）。
export const MAIN_STRUCTURE_OPTIONS  = Object.freeze([UNSPECIFIED_STRUCTURE, ...STRUCTURES]);
export const OTHER_STRUCTURE_OPTIONS = Object.freeze([...STRUCTURES]);

// 基礎種別の選択肢（共通タブ・構造リスト「土台基礎」見出しの右横で共用）。
export const RC_FOUNDATION_OPTIONS   = Object.freeze(['杭基礎（既製コンクリート杭）', '独立基礎', '布基礎', 'ベタ基礎']);
// 木造（在来・2"×4"）の基礎種別（仕様「なし / べた基礎* / 土間コン」。'べた基礎'＝canonical表記の 'ベタ基礎'）。
export const WOOD_FOUNDATION_OPTIONS = Object.freeze(['なし', 'ベタ基礎', '土間コン']);
export const MAT_FOUNDATION = 'ベタ基礎';

// ---- 在来木造の固有仕様（2026-09-14 ユーザー確認。設計意図は .claude/structural-model.md）----
// 梁成（成D mm）の決め方: 支持する2点間距離（mm）の区分 × 中間荷重の数（0〜3か所）。
// 表の最終行はユーザー確認済み（2026-09-14）で「中間荷重3か所」。表の外（3640超・4か所以上）は
// 最大側の値を使う（同日裁定）。適用は woodFraming.js の woodBeamDepthMm。
export const WOOD_BEAM_DEPTH_TABLE = Object.freeze({
  spanLimitsMm: Object.freeze([1820, 2730, 3640]),
  //               1820以下 2730以下 3640以下
  depthsByLoads: Object.freeze([
    Object.freeze([120, 240, 300]), // 中間荷重なし
    Object.freeze([150, 270, 330]), // 中間荷重1か所
    Object.freeze([210, 270, 330]), // 中間荷重2か所
    Object.freeze([240, 300, 360]), // 中間荷重3か所
  ]),
});
// 主要構造（部材の初期値・配置条件）。
export const TRADITIONAL_WOOD_FRAMING = Object.freeze({
  columnSection:   'WOOD-120x120', // 柱は120角が初期値（梁の材幅は柱同寸）
  ridgeSection:    'WOOD-120x120', // 棟木は120角
  purlinSection:   'WOOD-90x90',   // 母屋は90角
  hipBraceSection: 'WOOD-90x90',   // 火打ち梁は90角
  beamTopBelowFLMm: 100,           // 梁天端はFL−100
  floorBeamMaxPitchMm: 1820,       // 床梁は柱間・梁間に1820を超えない位置に設ける
  hipBraceMaxAreaM2: 16,           // 火打ち梁は16㎡以下の四角の4隅（吹抜け可・EV/階段内は不可）
});
// 木造下地（壁下地材・外壁の開口まわり）。寸法は「柱寸×○」で柱寸に連動する係数として持つ
// （適用は woodFraming.js の studSpec / openingJambSpec / studPositions）。
export const TRADITIONAL_WOOD_BACKING = Object.freeze({
  studPitchMm: 455,        // 縦下地の割付ピッチ（外壁は仕上げモード外部タブ「縦下地間隔」で変更可＝初期値）
  studDepthMm: 30,         // 壁下地材の断面＝柱寸×30
  windowJambDepthMm: 45,   // 外壁アルミ窓の両袖＝柱寸×45
  doorJambDepthMm: null,   // 外壁アルミ扉の両袖＝柱と同寸（null＝柱寸）
  jambClearanceMm: 5,      // 袖材の左右クリアランス
  studColumnClearanceMm: 10, // 各面の端部材（壁下地材）は柱面からこのクリアランスを空けて立てる
});

// 木造（在来）の基礎梁標準寸法・下限（仕様確認済み）。標準は150×600（=350+250）。
// 幅の最小135／成の最小450（梁間≤3640mmのとき）。auto算定は標準値、下限はユーザー編集時のバリデーション用。
export const WOOD_FOUNDATION_BEAM = Object.freeze({ width: 150, depth: 600, minWidth: 135, minDepth: 450, minDepthSpanLimit: 3640 });
// 木造基礎の断面詳細の既定寸法（仕様確認済み）。ベース600×150・張り出し0、べた基礎 厚150・天端GL+50、基礎梁の地中部250。
export const WOOD_FOUNDATION_SECTION_DEFAULTS = Object.freeze({
  embedDepth: 250, baseWidth: 600, baseThickness: 150, baseOverhang: 0, matThickness: 150, matTopAboveGL: 50,
});

// 材種 → 既定断面（(2) 値。材種の既定を基本に、主構造キーごとの上書き（在来木造＝柱120角）を withProfile で重ねる）。
// 主構造由来の柱・梁・耐力壁の既定断面は**必ずここ**（rulesFor(structure).defaultSections）から引く——
// 生成（autoFill）・手動追加（MemberListTab）・材変換（convertMembersToEffectiveMaterial）・梁芯移動
// （beamAxisMove）が別々に DEFAULT_*_BY_MATERIAL[材種] を引くと、主構造で値を分けた瞬間に経路ごとに
// 断面が食い違う（structureRules.test.js の不変条件が DEFAULT_COLUMN_SECTION_BY_MATERIAL の直接参照を検出）。
// 材種固定の部材（基礎・柱脚・基礎梁＝常にRC、踊り場受け梁＝階段の材種）は材種の既定を直接引いてよい。
function sectionsFor(material) {
  return Object.freeze({
    column: DEFAULT_COLUMN_SECTION_BY_MATERIAL[material],
    beam:   DEFAULT_BEAM_SECTION_BY_MATERIAL[material],
    other:  DEFAULT_SECTION_BY_MATERIAL[material], // 基礎・柱脚・耐力壁用
  });
}

// 木造系（在来・2"×4"）に共通のルール。
const WOOD_RULES = Object.freeze({
  family: StructureFamily.WOOD,
  isTraditionalWood: false,
  foundation: Object.freeze({
    options: WOOD_FOUNDATION_OPTIONS,
    // ベース（独立フーチング）はべた基礎時はなし（土台のみ）。なし／土間コンは基礎梁＋ベースの合成。
    hasBase:    foundationType => foundationType !== MAT_FOUNDATION,
    // べた基礎（マットスラブ role:'mat_foundation'）はべた基礎時のみ自動生成。
    hasMatSlab: foundationType => foundationType === MAT_FOUNDATION,
    // 基礎梁の断面算定（(3) 処理の選択）: 土台幅基準の標準寸法固定。
    beamSizing: Object.freeze({ kind: 'fixed', ...WOOD_FOUNDATION_BEAM }),
    // 基礎伏図に土台・ベース帯を描く（StructuralLayer.jsx の woodFoundationBands）。
    drawsBands: true,
    // 構造リスト: 基礎伏図の梁グループ見出し・基礎梁の断面マスター選択の有無・断面図の種類。
    beamGroupLabel: '土台基礎',
    beamSectionField: false,
    sectionFigure: 'wood',
    sectionDefaults: WOOD_FOUNDATION_SECTION_DEFAULTS,
    // 基礎伏図の土台帯（幅150の中線・袋綴じ）。ベース帯の幅は sectionDefaults.baseWidth。
    sillWidthMm: 150,
    // 玄関建具部分は基礎・両袖取付柱とも「扉幅＋両端クリアランス」で開ける。
    entranceClearanceMm: 5,
  }),
  designation: Object.freeze({ roof: '小屋伏図', floorSuffix: '梁伏図' }),
  // 在来木造の固有仕様（framing/backing）は在来キーだけが持つ。2"×4"・非木造は null。
  framing: null,
  backing: null,
  // (3) 柱の配置源: 通り芯の交点（既定）／壁が交差する位置（在来。woodAutoFill.js）。
  columnPlacement: 'gridIntersections',
  // (3) 柱幅の算定: 負担床面積から概算（既定）／固定（在来＝柱寸法は欄で決める。tributaryWidth を算定しない）。
  columnSizing: 'tributary',
  // (3) 平面詳細の壁下地材（間柱断面）の割付: 'fixedPitch'＝壁の始端から450固定ピッチ・見かけ幅45（既定。
  // renderer/wallStudLayout.js）／'betweenColumns'＝壁上の柱で区切った各面を studPositions で割り付け、
  // 面の両端は柱面から studColumnClearanceMm を空けて端部材を立てる（在来。woodFraming.js faceStudPositions）。
  studLayout: 'fixedPitch',
  // (2)(3) 柱の描き方: columnFinishWrap＝仕上げ包み（柱壁。finish/columnWrap.js）を平面・展開図に付けるか。
  // planColumnColor＝平面図の柱断面の線色（'material'＝材種色／'wall'＝壁と同じ線色）。
  // planColumnLineWeight＝平面図の柱断面の輪郭線幅（LINE_WEIGHT_MM のキー。'thick'＝壁の仕上げ線と同じ）。
  drawing: Object.freeze({ columnFinishWrap: true, planColumnColor: 'material', planColumnLineWeight: 'thick' }),
  // 壁由来の梁芯生成源（(3)）: 自階＋1つ下の実体階の下地オーナー壁（下地材の種別は問わない）。在来のみ。
  wallBeamAxes: null,
  // 外壁アルミサッシはフィン下地直付け（openings/sashDetailCatalog.js）。
  sashFinDirect: true,
});

// RC系（ラーメン・壁式）に共通のルール。
const RC_RULES = Object.freeze({
  family: StructureFamily.RC,
  isTraditionalWood: false,
  foundation: Object.freeze({
    options: RC_FOUNDATION_OPTIONS,
    hasBase:    () => true,
    hasMatSlab: () => false, // 非木造の基礎スラブは手動配置
    beamSizing: Object.freeze({ kind: 'spanDivisor', depthDivisor: 7 }), // D = 最長柱間 / 7
    drawsBands: false,
    beamGroupLabel: null,
    beamSectionField: true,
    sectionFigure: 'rc',
    sectionDefaults: null,
    sillWidthMm: null,
    entranceClearanceMm: null,
  }),
  designation: Object.freeze({ roof: 'R階伏図', floorSuffix: '伏図' }),
  framing: null,
  backing: null,
  columnPlacement: 'gridIntersections',
  columnSizing: 'tributary',
  studLayout: 'fixedPitch',
  drawing: Object.freeze({ columnFinishWrap: true, planColumnColor: 'material', planColumnLineWeight: 'thick' }),
  // 自階の下地オーナー壁のうち下地材がRC下地の壁のみ（上下階で壁が連続し自立するため下階は見ない）。
  wallBeamAxes: 'rcBacking',
  sashFinDirect: false,
});

// 鉄骨系（S造・SRC造）に共通のルール。
const STEEL_RULES = Object.freeze({
  ...RC_RULES,
  family: StructureFamily.STEEL,
  foundation: Object.freeze({ ...RC_RULES.foundation, beamSizing: Object.freeze({ kind: 'spanDivisor', depthDivisor: 8 }) }),
  wallBeamAxes: null,
});

// 主構造キー → ルールセット。isRigidFrame / baseMaterial は structuralClassification.js の
// STRUCTURE_PROFILES（構造分類の単一の真実）から取り、二重管理しない。
function withProfile(key, rules, sectionOverrides = null) {
  const profile = STRUCTURE_PROFILES[key];
  return Object.freeze({
    key,
    ...rules,
    isRigidFrame: profile.isRigidFrame,
    baseMaterial: profile.baseMaterial,
    defaultSections: Object.freeze({ ...sectionsFor(profile.baseMaterial), ...(sectionOverrides ?? {}) }),
  });
}

export const STRUCTURE_RULES = Object.freeze({
  'RC造(ラーメン)': withProfile('RC造(ラーメン)', RC_RULES),
  'RC造(壁式)':    withProfile('RC造(壁式)', RC_RULES),
  'S造':           withProfile('S造', STEEL_RULES),
  'SRC造':         withProfile('SRC造', STEEL_RULES),
  // 在来木造: 柱120角・梁は材幅＝柱同寸（成は梁成表。既定はその最小120）。framing/backing は在来固有仕様。
  [TRADITIONAL_WOOD_STRUCTURE]: withProfile(TRADITIONAL_WOOD_STRUCTURE,
    { ...WOOD_RULES, isTraditionalWood: true, wallBeamAxes: 'selfAndBelow',
      framing: TRADITIONAL_WOOD_FRAMING, backing: TRADITIONAL_WOOD_BACKING,
      columnPlacement: 'wallIntersections', columnSizing: 'fixed', studLayout: 'betweenColumns',
      // 在来木造の柱は壁の中に立つ管柱＝仕上げ包み（柱壁）は付けない。平面の柱断面は壁と同じ黒
      // （ユーザー指示2026-09-14「在来木造の柱に柱包みは不要」「茶色の断面…黒指定」）。輪郭は**極太線**——
      // 壁厚＝柱寸法（conformWoodBacking で下地120＝柱120）になると柱の輪郭が壁の下地帯の線と完全に重なり、
      // 壁と同じ太線では柱が見分けられない（実機 moku1 2026-09-15「中心線と取り合う壁の柱が消えた」）。
      drawing: Object.freeze({ columnFinishWrap: false, planColumnColor: 'wall', planColumnLineWeight: 'ultraThick' }) },
    { column: TRADITIONAL_WOOD_FRAMING.columnSection, beam: TRADITIONAL_WOOD_FRAMING.columnSection }), // 梁の既定＝柱同寸の正角
  '木造（2"×4"）': withProfile('木造（2"×4"）', WOOD_RULES), // 壁自体が構造体＝壁下に梁を入れない（wallBeamAxes:null）
});

// 未指定（'未定'）・未知の主構造のルール。生成・変換は呼び出し側で別途ガード済みのため、ここは
// 「木造扱いしない・材種は木造既定」という従来のフォールバック（defaultMaterialType='WOOD'、
// isWoodStructure=false、基礎種別はRC系選択肢、図面呼称は非木造）をそのまま表す。
export const UNSPECIFIED_RULES = Object.freeze({
  key: UNSPECIFIED_STRUCTURE,
  ...STEEL_RULES,
  family: null,
  isRigidFrame: false,
  baseMaterial: 'WOOD',
  defaultSections: sectionsFor('WOOD'),
});

/** 主構造（実効値の文字列表記）のルールセットを返す。未知・未指定は UNSPECIFIED_RULES。 */
export function rulesFor(structure) {
  return STRUCTURE_RULES[structure] ?? UNSPECIFIED_RULES;
}

/** その階の実効主構造（階の上書き優先・なければ建物全体値）。core 非依存のためここに置き、
 *  structuralAutoFill.js / wallBeamAxes.js / woodAutoFill.js がこれを共有する（重複定義を持たない）。 */
export function effectiveStructure(graph, project = null) {
  return graph?.structureOverride
    ?? project?.structuralInfo?.mainStructure
    // project が手元に無い経路（描画レイヤ・展開図）は graph の後方参照（core/planGraph.js の
    // _structuralInfo。peek の一時グラフは全階共通の structGraph 経由）から建物全体値を引く。
    ?? graph?._structuralInfo?.mainStructure
    ?? graph?._structGraph?._structuralInfo?.mainStructure;
}

/** 木造系（在来・2"×4"）か。 */
export function isWoodStructure(structure) {
  return rulesFor(structure).family === StructureFamily.WOOD;
}

/** 在来木造か（2"×4"は含まない）。壁下地からの梁芯・小梁自動生成など在来限定ルールの判定。 */
export function isTraditionalWoodStructure(structure) {
  return rulesFor(structure).isTraditionalWood === true;
}

/** 主構造に応じた基礎種別の選択肢。木造系のみ「なし/ベタ基礎/土間コン」、それ以外はRC系選択肢。 */
export function foundationOptionsFor(structure) {
  return rulesFor(structure).foundation.options;
}

/** 主構造の表記から既定の材種（StructuralMaterialType の値と一致する文字列リテラル）を導出する。 */
export function defaultMaterialFor(structure) {
  return rulesFor(structure).baseMaterial;
}

/** 全主構造キー（表示順。structuralClassification.STRUCTURES と同一）。 */
export const STRUCTURE_KEYS = STRUCTURES;

// ----------------------------------------------------------------
// 壁下地材ごとのルール（問題.md「壁下地材ごとに入替え」）。下地材の分類は finish/materials/backingClass.js
// の材コード集合（真実のソース）で決まり、ここはその分類ごとの選択子だけを持つ。
// ----------------------------------------------------------------
export { BackingClass };

export const BACKING_RULES = Object.freeze({
  // 木質下地: 断面寸法（見込み方向）が90mm以上ならサッシはフィン直付け（主構造が木造でなくても）。
  [BackingClass.WOOD]:  Object.freeze({ sashFinMinDepth: 90, beamAxisSource: false }),
  // RC壁下地: RC造の「壁由来の梁芯・小梁自動生成」の生成源。
  [BackingClass.RC]:    Object.freeze({ sashFinMinDepth: null, beamAxisSource: true }),
  // 軽鉄スタッド・鋼材等: どちらの規則も持たない。
  [BackingClass.OTHER]: Object.freeze({ sashFinMinDepth: null, beamAxisSource: false }),
});

/** 下地材分類のルールを返す（未知は OTHER）。 */
export function backingRulesFor(backingClass) {
  return BACKING_RULES[backingClass] ?? BACKING_RULES[BackingClass.OTHER];
}
