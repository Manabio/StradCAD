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
import { findSectionEntry, woodRectSectionKey, WOOD_SQUARE_WIDTHS } from './sectionCatalog.js';

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

/** ピン接合の梁（小梁・床梁＝PIN_ROLES、ピン指定した鉄骨の大梁）の端部クリアランス(mm)の既定値。母材（取りつく
 *  大梁の縁・柱面）からこの分だけ離して止める。主構造ごとの実効値は rulesFor(...).pinBeamEndClearanceMm
 *  ——在来木造は 0（小梁・床梁を大梁面まで伸ばす。ユーザー裁定2026-09-16「鉄骨造にあった隙間は不要」）。
 *  core/structuralEntities.js の StructuralBeam（spanForColumns/spanForHostBeams）が唯一の消費先。 */
export const PIN_BEAM_END_CLEARANCE_MM = 50;

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
// 在来木造の梁成自動更新（woodAutoFill.js autoFillWoodBeamDepths）の対象role。柱と同じく主構造の
// 主要構造（framing）を持つ階の木造部材だけが対象——対象梁（成を更新する側）と荷重源（他の梁の荷重点
// として数える側）の両方がこの定数を読む（foundation/eaves/roof/landingは対象外。梁成表は主要構造の
// 大梁・小梁・床梁の話であり、基礎梁・軒桁・小屋梁・踊り場受け梁は別の算定・別の扱いを持つため）。
// numbering.individualBeamRoles（在来木造の非標準梁の個別採番。memberCatalog.js isIndividuallyNumbered）
// も同じ役割集合を読む——梁成表の対象と個別採番の対象は同じ「主要構造の梁」という理由による一致で、
// 二重管理を避けるためここを共有する。
export const WOOD_DEPTH_BEAM_ROLES = Object.freeze(['primary', 'secondary', 'floor']);
// 主要構造（部材の初期値・配置条件）。
export const TRADITIONAL_WOOD_FRAMING = Object.freeze({
  // 柱は120角が既定値（梁の材幅は柱同寸）。階ごとに graph.woodColumnWidthMm で上書きできる
  // （「各階柱寸法」欄。ステップ4 C-2）——ここは未設定時のフォールバックにすぎない。
  // 実際の解決は下記 woodColumnWidthMm/woodColumnSectionId を必ず経由すること
  // （このフィールドを他所から直接読まない）。
  columnSection:   'WOOD-120x120',
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
  // (3) 梁(role:'primary')の生成源: 通り芯グリッドの辺（既定。structuralAutoFill.js autoFillBeams）／
  // 壁線上の通し梁（在来。woodAutoFill.js autoFillWoodWallBeams）。在来は通り芯グリッドの大梁・梁芯CL上の
  // 小梁（role:'secondary'）の代わりに、壁線（自階＋1つ下の階の壁）上の壁の交点の並びを通しで1本の
  // role:'primary'（記号G）の梁として生成する（ステップ3c-2）。
  beamPlacement: 'gridEdges',
  // (2) ピン接合の梁（小梁・床梁）の端部クリアランス(mm)。在来木造だけ 0＝大梁面まで伸ばす。
  pinBeamEndClearanceMm: PIN_BEAM_END_CLEARANCE_MM,
  // (3) 平面詳細の壁下地材（間柱断面）の割付: 'fixedPitch'＝壁の始端から450固定ピッチ・見かけ幅45（既定。
  // renderer/wallStudLayout.js）／'betweenColumns'＝壁上の柱で区切った各面を studPositions で割り付け、
  // 面の両端は柱面から studColumnClearanceMm を空けて端部材を立てる（在来。woodFraming.js faceStudPositions）。
  studLayout: 'fixedPitch',
  // (2)(3) 柱の描き方: columnFinishWrap＝仕上げ包み（柱壁。finish/columnWrap.js）を平面・展開図に付けるか。
  // planColumnColor＝平面図の柱断面の線色（'material'＝材種色／'wall'＝壁と同じ線色）。
  // planColumnLineWeight＝平面図の柱断面の輪郭線幅（LINE_WEIGHT_MM のキー。'thick'＝壁の仕上げ線と同じ）。
  // framingPlanColor＝伏図（framing plan）の部材線色（'material'＝材種色／'mono'＝全黒）。
  // framingColumnSymbol＝伏図の柱記号（'section'＝断面そのまま／'crossBox'＝下階柱に×・自階柱は輪郭のみ□）。
  // framingColumnLineWeight＝伏図の柱記号の輪郭線幅（'fixed'＝常にmedium／'byLod'＝略図medium・標準詳細thick。
  // 在来木造だけ断面線が壁の下地帯線と重ならないよう標準・詳細で太くする。structural/framingDrawing.js
  // framingColumnLineWeight が唯一の解決先）。
  // memberTags＝伏図の部材タグ（memberNo）を描くか（'show'＝既定／'hide'＝在来木造。renderer/MemberTagLayer.jsx
  // の早期returnはstructural/framingDrawing.js showMemberTags を経由する。タグクリックの代替は伏図の梁タップ
  // ＝structural/framingDrawing.js pickMembersOnFigure・renderer/StructuralLayer.jsx onMemberClick。ステップ4第3単位①）。
  // beamDepthMark＝非正角材（成≠幅）の梁の標記（'none'＝既定／'offsetLine'＝在来木造。45度線2本＋
  // 平行線1本＋「幅×成」文字。structural/framingDrawing.js beamDepthMarks が唯一の解決先）。
  // 伏図（framing plan）は在来木造だけ全黒・下階柱□に×／自階柱□（ユーザー指摘2026-09-15）。
  // beamEndColumnMatch＝梁の端に取りつく柱の判定方法（'clId'＝既定。端の直交CLと柱のCLがid一致／
  // 'coordinate'＝在来木造。id不一致でも座標一致で柱とみなす——下階柱は自階の梁芯CL・中心線と別idの
  // per-floor CLに乗ることがあるため。core/structuralEntities.js _columnAtEnd が唯一の解決先。
  // ステップ1-b・下階柱面トリム）。
  // beamJunction＝伏図の梁の交点処理（'columnFace'＝既定。下階柱面で止めるだけ／'throughWins'＝在来木造。
  // 通しの梁（両側に続く梁）が勝ち、T字で突き当たる梁が負け（勝者の面で止まる）。出隅は長い方が勝ち
  // （同長はX方向）。structural/beamJunction.js の resolveBeamJunctionSpans が唯一の解決先——実体スパン
  // （spanForColumns）は書き換えず、renderer/StructuralLayer.jsx が描画専用に上書きする。ユーザー裁定
  // 2026-09-17・B-3）。
  drawing: Object.freeze({
    columnFinishWrap: true, planColumnColor: 'material', planColumnLineWeight: 'thick',
    framingPlanColor: 'material', framingColumnSymbol: 'section', framingColumnLineWeight: 'fixed',
    memberTags: 'show', beamDepthMark: 'none', beamEndColumnMatch: 'clId', beamJunction: 'columnFace',
  }),
  // 壁由来の梁芯生成源（(3)）: 自階＋1つ下の実体階の下地オーナー壁（下地材の種別は問わない）。在来のみ。
  wallBeamAxes: null,
  // 外壁アルミサッシはフィン下地直付け（openings/sashDetailCatalog.js）。
  sashFinDirect: true,
  // 採番の選択子（(3)）: individualBeamRoles＝標準材（defaultSections.beam）以外の梁を材ごとに個別採番
  // するrole集合（memberCatalog.js isIndividuallyNumbered/memberGroupKey/memberOrderKey が唯一の消費先）。
  // 既定null＝個別採番なし（同一材寸は常に1グループ）。在来木造だけ WOOD_DEPTH_BEAM_ROLES で上書きする。
  // individualColumns＝柱の個別採番（'widthOverride'＝柱寸の個別指定がある柱を1本1タグにする。ステップ3）。
  // 既定null＝個別採番なし。在来木造だけ 'widthOverride' で上書きする。
  // columnGroupScope＝柱の採番グループを建物全体でまとめるか（既定'building'。例1~3C1）／階ごとに分けるか
  // （'floor'。在来木造だけ上書き。例1C1・2C1・3C1——管柱は階の部材であり階をまたがないため。
  // ユーザー裁定2026-09-17）。memberCatalog.js memberGroupKey が唯一の消費先（columnMapにplaneIdを
  // 付与するかどうかを分岐する）。
  numbering: Object.freeze({ individualBeamRoles: null, individualColumns: null, columnGroupScope: 'building' }),
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
  // (3) 梁(role:'primary')の生成源: 通り芯グリッドの辺（在来木造だけ壁線方式へ上書き。WOOD_RULES参照）。
  beamPlacement: 'gridEdges',
  pinBeamEndClearanceMm: PIN_BEAM_END_CLEARANCE_MM,
  studLayout: 'fixedPitch',
  drawing: Object.freeze({
    columnFinishWrap: true, planColumnColor: 'material', planColumnLineWeight: 'thick',
    framingPlanColor: 'material', framingColumnSymbol: 'section', framingColumnLineWeight: 'fixed',
    memberTags: 'show', beamDepthMark: 'none', beamEndColumnMatch: 'clId', beamJunction: 'columnFace',
  }),
  // 自階の下地オーナー壁のうち下地材がRC下地の壁のみ（上下階で壁が連続し自立するため下階は見ない）。
  wallBeamAxes: 'rcBacking',
  sashFinDirect: false,
  numbering: Object.freeze({ individualBeamRoles: null, individualColumns: null, columnGroupScope: 'building' }),
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
      beamPlacement: 'wallRuns',
      // 大梁にとりつく小梁・床梁は大梁面まで伸ばす（鉄骨造にあった50mmの隙間は不要。ユーザー裁定2026-09-16）。
      pinBeamEndClearanceMm: 0,
      // 標準材（defaultSections.beam＝柱同寸の正角）以外の梁は主要構造のrole（WOOD_DEPTH_BEAM_ROLES）
      // だけ材ごとに個別採番する（ユーザー裁定2026-09-16。memberCatalog.js isIndividuallyNumbered）。
      // columnGroupScope='floor': 柱（管柱）は階の部材で階をまたがないため、採番グループも階ごとに
      // 分ける（例1C1・2C1・3C1。非在来は'building'のまま＝1~3C1のような建物全体の合算。
      // ユーザー裁定2026-09-17）。
      numbering: Object.freeze({ individualBeamRoles: WOOD_DEPTH_BEAM_ROLES, individualColumns: 'widthOverride', columnGroupScope: 'floor' }),
      // 在来木造の柱は壁の中に立つ管柱＝仕上げ包み（柱壁）は付けない。平面の柱断面は壁と同じ黒
      // （ユーザー指示2026-09-14「在来木造の柱に柱包みは不要」「茶色の断面…黒指定」）。輪郭は**極太線**——
      // 壁厚＝柱寸法（conformWoodBacking で下地120＝柱120）になると柱の輪郭が壁の下地帯の線と完全に重なり、
      // 壁と同じ太線では柱が見分けられない（実機 moku1 2026-09-15「中心線と取り合う壁の柱が消えた」）。
      // 梁の交点は「通しが勝つ」（ユーザー裁定2026-09-17・B-3）。structural/beamJunction.js
      // resolveBeamJunctionSpans が唯一の解決先。
      drawing: Object.freeze({
        columnFinishWrap: false, planColumnColor: 'wall', planColumnLineWeight: 'ultraThick',
        framingPlanColor: 'mono', framingColumnSymbol: 'crossBox', framingColumnLineWeight: 'byLod',
        memberTags: 'hide', beamDepthMark: 'offsetLine', beamEndColumnMatch: 'coordinate', beamJunction: 'throughWins',
      }) },
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

/**
 * その階の在来木造の柱寸(mm)。graph.woodColumnWidthMm（「各階柱寸法」欄・ステップ4 C-2）が
 * 木造正角のカタログ幅（sectionCatalog.js WOOD_SQUARE_WIDTHS＝90/105/120）に含まれるときだけ
 * 採用し、それ以外（未設定 null・旧データや外部.stq由来のカタログ外の値）はルール既定
 * （framing.columnSection の幅）にフォールバックする——QA裁定: カタログ外の階の値は
 * 「無効＝既定として扱う」で一本化し、conformWoodSections（無変更）と新規生成（120角）の
 * 不整合を作らない。在来木造以外（framing を持たない主構造）は柱寸という概念を持たないため常にnull。
 * 柱・梁の材幅、壁下地材、梁成算定の材幅、壁の鮮度キー、非標準梁の個別採番はすべてこれ
 * （または woodColumnSectionId）を経由して解決すること——framing.columnSection を直接読まない。
 */
export function woodColumnWidthMm(graph, project = null) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return null;
  if (graph?.woodColumnWidthMm != null && WOOD_SQUARE_WIDTHS.includes(graph.woodColumnWidthMm)) return graph.woodColumnWidthMm;
  return woodBaseColumnWidthMm(graph, project);
}

/**
 * その階の在来木造の柱寸(mm)の**ルール既定値**（framing.columnSectionの幅。常に120）。
 * graph.woodColumnWidthMm（「各階柱寸法」欄の上書き）は見ない——外壁の下地帯シフト
 * （柱寸が基準120より細いとき、下地帯を外側へ寄せて外面を通り芯±60に固定する。ステップ1）が
 * 「基準からどれだけ細いか」を求めるのに使う唯一の入口。在来木造以外（framingを持たない
 * 主構造）はnull。
 */
export function woodBaseColumnWidthMm(graph, project = null) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return null;
  return findSectionEntry(rules.framing.columnSection)?.width ?? null;
}

/**
 * その階の在来木造の柱の正角断面キー（例 'WOOD-120x120'）。woodColumnWidthMm の幅をカタログの
 * 正角断面へ変換する（カタログに無い幅は null）。在来木造以外は null。
 */
export function woodColumnSectionId(graph, project = null) {
  const width = woodColumnWidthMm(graph, project);
  return width != null ? woodRectSectionKey(width, width) : null;
}

/**
 * 柱1本の実効柱寸(mm)——在来木造の柱は「共通」（階の値。woodColumnWidthMm）と「個別指定」
 * （column.woodColumnWidthMm）の2層（ステップ3・2026-09-17裁定）。個別指定がカタログの正角幅
 * （WOOD_SQUARE_WIDTHS）に含まれるときだけ採用し、それ以外（null＝共通・カタログ外の無効値）は
 * 階の値へフォールバックする（woodColumnWidthMm と同じ「カタログ外は無効」規約）。
 * woodAutoFill.js conformWoodSections（柱の断面そろえ）・memberCatalog.js isIndividuallyNumbered
 * （個別採番の判定）が唯一の消費先——column.woodColumnWidthMm を他所から直接読まないこと。
 */
export function columnWidthMm(column, graph, project = null) {
  const own = column?.woodColumnWidthMm;
  return (own != null && WOOD_SQUARE_WIDTHS.includes(own)) ? own : woodColumnWidthMm(graph, project);
}

/** columnWidthMm の正角断面キー版（例 'WOOD-105x105'）。カタログに無ければ null。 */
export function columnSectionId(column, graph, project = null) {
  const w = columnWidthMm(column, graph, project);
  return w != null ? woodRectSectionKey(w, w) : null;
}

/**
 * その階の梁が参照すべき柱寸(mm)——「梁を支える柱」は伏図の帰属どおり1つ下の実体階の柱
 * （structural-model.md「柱は自階の柱を自階graphに持つ。伏図慣習は図面合成で実現する」）なので、
 * 梁の材幅・梁成算定の材幅・非標準梁の個別採番の標準材は graph 自身ではなく belowGraph の
 * woodColumnWidthMm を参照する（実機裁定・ステップ4 C-2 QA2）。belowGraph が無い（最下階の
 * 基礎伏図・屋根専用平面）か、belowGraph側が在来木造でない（解決不能）場合は graph 自身の値へ
 * フォールバックする。柱自身の断面・壁下地材（conformWoodBacking）・壁の鍵は対象外
 * （従来どおり graph 自身の woodColumnWidthMm を直接使う）。
 * 呼び出し側は belowGraph として「自階の下の実体階」を渡すこと——編集可能peek経由の書き換え
 * 直後に読む場合は floorSwapManager.flushEditablePeek() で保留中のデバウンス保存を確定してから
 * fresh peek すること（stopEditablePeekと同じ「読む前に書く」規律。undo-redo.md参照）。
 *
 * **この関数（belowGraph引数を取る生の計算）を呼べるのは structural/structuralRecompute.js と
 * structural/structuralOrchestration.js の下階編集経路だけ**（構造再計算が唯一の書き込み元。
 * 下記 resolvedBeamColumnWidthMm 参照）。それ以外（採番パイプライン・UI・梁芯CL操作等の同期経路）は
 * belowGraph を持ち回らずに済む resolvedBeamColumnWidthMm(graph, project) を使うこと——belowGraph
 * 無しの同期経路でこの関数を直接呼ぶと常に自階の値へ落ち、下階の柱寸変更が反映されない
 * （実機QA指摘: 標準材の解決が採番パイプラインとUIで二系統に分かれ、タグが往復するバグ。
 * ステップ4 C-2 QA4で二系統を解消した）。
 */
export function beamColumnWidthMm(graph, belowGraph, project = null) {
  const rules = rulesFor(effectiveStructure(graph, project));
  if (!rules.framing) return null;
  if (belowGraph) {
    const belowWidth = woodColumnWidthMm(belowGraph, project);
    if (belowWidth != null) return belowWidth;
  }
  return woodColumnWidthMm(graph, project);
}

/**
 * standardBeamSectionFor（非標準梁の個別採番の標準材）・conformWoodSections（梁の材幅）・
 * autoFillWoodBeamDepths（梁成算定の材幅）が読む**唯一の入口**。structural/structuralRecompute.js
 * （と下階編集経路。structuralOrchestration.js）が再計算のたびに beamColumnWidthMm(graph, belowGraph,
 * project) の結果を graph.beamColumnWidthMm（非永続の派生フィールド）へ書き込んだものをそのまま返す
 * ——採番パイプライン（collectFloorGroups/applyNumbers/renumberMembers）・UI（MemberListTab.jsx）・
 * 梁芯CL操作（transform/centerLineOps.js）は belowGraph を一切持ち回らない。
 * 未再計算（graph.beamColumnWidthMm===null。文書未読込み直後・突入直後の一瞬など）の間は自階の
 * woodColumnWidthMm で暫定する——次の再計算で正しい値に補正される（意図的な結果整合性。
 * .claude/structural-model.md 参照）。
 */
export function resolvedBeamColumnWidthMm(graph, project = null) {
  return graph?.beamColumnWidthMm ?? woodColumnWidthMm(graph, project);
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
