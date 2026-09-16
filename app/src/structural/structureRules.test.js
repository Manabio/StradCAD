// structureRules.js（主構造・壁下地材ごとのルールセット）の単体テストと、
// 「主構造の文字列を各所で直接比較しない」不変条件の走査テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STRUCTURE_RULES, STRUCTURE_KEYS, UNSPECIFIED_RULES, UNSPECIFIED_STRUCTURE, TRADITIONAL_WOOD_STRUCTURE,
  MAIN_STRUCTURE_OPTIONS, MAT_FOUNDATION,
  rulesFor, isWoodStructure, isTraditionalWoodStructure, foundationOptionsFor, defaultMaterialFor, effectiveStructure,
  RC_FOUNDATION_OPTIONS, WOOD_FOUNDATION_OPTIONS, WOOD_FOUNDATION_BEAM,
  BACKING_RULES, BackingClass, backingRulesFor,
  woodColumnWidthMm, woodColumnSectionId, beamColumnWidthMm, resolvedBeamColumnWidthMm,
  PIN_BEAM_END_CLEARANCE_MM,
} from './structureRules.js';
import { STRUCTURES, STRUCTURE_PROFILES } from './structuralClassification.js';
import { DEFAULT_COLUMN_SECTION_BY_MATERIAL, DEFAULT_BEAM_SECTION_BY_MATERIAL, DEFAULT_SECTION_BY_MATERIAL } from './memberCatalog.js';
import { backingClassOf, RC_WALL_BACKING_CODES, WOOD_WALL_BACKING_CODES, WOOD_STUD_CODE_BY_SIZE, woodStudCodeFor } from '../finish/materials/backingClass.js';
import { StructuralInfo } from '../core/structuralInfo.js';
import { Plane, PlanGraph, CenterLineType, Discipline } from '../core.js';
import { autoFillMatFoundation } from './structuralAutoFill.js';
import { generateRoomWallsFromOutline } from '../finish/wallGeneration.js';

test('structureRules: 6種の主構造キーすべてにルールがあり、isRigidFrame/baseMaterial は構造分類（STRUCTURE_PROFILES）と一致する', () => {
  assert.deepEqual(STRUCTURE_KEYS, STRUCTURES);
  for (const key of STRUCTURES) {
    const r = STRUCTURE_RULES[key];
    assert.ok(r, `${key} のルールが無い`);
    assert.equal(r.key, key);
    assert.equal(r.isRigidFrame, STRUCTURE_PROFILES[key].isRigidFrame, `${key}: isRigidFrame`);
    assert.equal(r.baseMaterial, STRUCTURE_PROFILES[key].baseMaterial, `${key}: baseMaterial`);
    // 既定断面は材種の既定を基本にし、在来木造だけ柱・梁を120角へ上書きする（ステップ2）。
    if (key === TRADITIONAL_WOOD_STRUCTURE) {
      assert.equal(r.defaultSections.column, 'WOOD-120x120');
      assert.equal(r.defaultSections.beam, 'WOOD-120x120');
    } else {
      assert.equal(r.defaultSections.column, DEFAULT_COLUMN_SECTION_BY_MATERIAL[r.baseMaterial]);
      assert.equal(r.defaultSections.beam,   DEFAULT_BEAM_SECTION_BY_MATERIAL[r.baseMaterial]);
    }
    assert.equal(r.defaultSections.other,  DEFAULT_SECTION_BY_MATERIAL[r.baseMaterial]);
    assert.ok(['wood', 'steel', 'rc'].includes(r.family), `${key}: family`);
    assert.ok(typeof r.foundation.hasBase === 'function' && typeof r.foundation.hasMatSlab === 'function');
    assert.ok(['fixed', 'spanDivisor'].includes(r.foundation.beamSizing.kind));
    assert.ok([null, 'rcBacking', 'selfAndBelow'].includes(r.wallBeamAxes));
  }
});

test('structureRules: 木造系（在来・2×4）の判定・基礎種別・基礎梁寸法・呼称は従来の分岐と同じ値', () => {
  for (const key of ['木造（在来）', '木造（2"×4"）']) {
    const r = rulesFor(key);
    assert.equal(isWoodStructure(key), true);
    assert.equal(foundationOptionsFor(key), WOOD_FOUNDATION_OPTIONS);
    assert.deepEqual([...foundationOptionsFor(key)], ['なし', 'ベタ基礎', '土間コン']);
    assert.equal(r.foundation.hasBase('ベタ基礎'), false, 'べた基礎ならベースなし');
    assert.equal(r.foundation.hasBase('なし'), true);
    assert.equal(r.foundation.hasBase('土間コン'), true);
    assert.equal(r.foundation.hasMatSlab('ベタ基礎'), true);
    assert.equal(r.foundation.hasMatSlab('土間コン'), false);
    assert.deepEqual({ ...r.foundation.beamSizing }, { kind: 'fixed', ...WOOD_FOUNDATION_BEAM });
    assert.equal(r.foundation.drawsBands, true);
    assert.equal(r.foundation.beamGroupLabel, '土台基礎');
    assert.equal(r.foundation.beamSectionField, false);
    assert.equal(r.foundation.sectionFigure, 'wood');
    assert.deepEqual(r.designation, { roof: '小屋伏図', floorSuffix: '梁伏図' });
    assert.equal(r.sashFinDirect, true);
    assert.equal(defaultMaterialFor(key), 'WOOD');
  }
  assert.equal(isTraditionalWoodStructure('木造（在来）'), true);
  assert.equal(isTraditionalWoodStructure('木造（2"×4"）'), false, '2×4は在来ではない');
  assert.equal(rulesFor(TRADITIONAL_WOOD_STRUCTURE).wallBeamAxes, 'selfAndBelow', '在来だけ壁由来の梁芯を自階＋下階から生成');
  assert.equal(rulesFor('木造（2"×4"）').wallBeamAxes, null, '2×4は壁自体が構造体＝壁下に梁を入れない');
});

// ---- 各階柱寸法（ステップ4 C-2a）: woodColumnWidthMm/woodColumnSectionId ----
test('woodColumnWidthMm/woodColumnSectionId: graph.woodColumnWidthMm 未設定は在来木造のルール既定（120角）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  assert.equal(woodColumnWidthMm(graph), 120);
  assert.equal(woodColumnSectionId(graph), 'WOOD-120x120');
});

test('woodColumnWidthMm/woodColumnSectionId: graph.woodColumnWidthMm を設定すると階の値が優先される', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(105);
  assert.equal(woodColumnWidthMm(graph), 105);
  assert.equal(woodColumnSectionId(graph), 'WOOD-105x105');
});

test('【失敗系】woodColumnWidthMm/woodColumnSectionId: 在来木造以外は graph.woodColumnWidthMm を設定していても常に null', () => {
  for (const structure of ['木造（2"×4"）', 'S造', 'RC造(ラーメン)', UNSPECIFIED_STRUCTURE]) {
    const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
    graph.structureOverride = structure;
    graph.setWoodColumnWidthMm(105);
    assert.equal(woodColumnWidthMm(graph), null, structure);
    assert.equal(woodColumnSectionId(graph), null, structure);
  }
});

test('【失敗系】woodColumnWidthMm/woodColumnSectionId: カタログに無い幅（正角材90/105/120以外。例100）は無効として扱い、ルール既定（120角）へフォールバックする（QA裁定: conformWoodSectionsと新規生成の不整合を防ぐ）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(100);
  assert.equal(woodColumnWidthMm(graph), 120, 'カタログ外の階の値は無効＝既定(120)を返す（生値100は返さない）');
  assert.equal(woodColumnSectionId(graph), 'WOOD-120x120');
});

// ---- beamColumnWidthMm（実機裁定ステップ4 C-2 QA2「梁幅は支持する下階柱の柱寸」）----
test('beamColumnWidthMm: belowGraphのwoodColumnWidthMmを優先する（梁を支える1つ下の実体階の柱寸）', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  const belowGraph = new PlanGraph(new Plane('p0', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  belowGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  belowGraph.setWoodColumnWidthMm(105);
  graph.setWoodColumnWidthMm(90); // 自階の値は無視される（belowGraphが優先）
  assert.equal(beamColumnWidthMm(graph, belowGraph), 105);
});

test('【失敗系】beamColumnWidthMm: belowGraphが無い（最下階の基礎伏図・屋根専用平面）場合は自階の値へフォールバックする', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(105);
  assert.equal(beamColumnWidthMm(graph, null), 105);
  assert.equal(beamColumnWidthMm(graph, undefined), 105, 'belowGraph省略時も自階の値へフォールバック');
});

test('【失敗系】beamColumnWidthMm: belowGraphが在来木造でない（解決不能）場合も自階の値へフォールバックする', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  const belowGraph = new PlanGraph(new Plane('p0', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  belowGraph.structureOverride = 'S造'; // 下階が在来木造でない＝belowGraph側は柱寸という概念を持たない
  graph.setWoodColumnWidthMm(105);
  assert.equal(beamColumnWidthMm(graph, belowGraph), 105, '下階が解決不能なら自階の値へフォールバック');
});

test('【失敗系】beamColumnWidthMm: 自階（graph）が在来木造でなければbelowGraphの値に関わらず常にnull', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  const belowGraph = new PlanGraph(new Plane('p0', 0, '1階', 1, 1));
  graph.structureOverride = 'S造';
  belowGraph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  belowGraph.setWoodColumnWidthMm(105);
  assert.equal(beamColumnWidthMm(graph, belowGraph), null, '自階が在来木造でなければ梁幅という概念を持たない');
});

// ---- resolvedBeamColumnWidthMm（実機QA指摘4: 標準材の解決を採番パイプライン・UI・梁芯CL操作で
// 一本化する唯一の読み口。structuralRecompute.js が書いた graph.beamColumnWidthMm を読むだけで
// belowGraph を引数に取らない）----
test('resolvedBeamColumnWidthMm: graph.beamColumnWidthMm（構造再計算が書いた派生値）をそのまま返す', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '2階', 2, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(90); // 自階の値（無視されるはず）
  graph.setBeamColumnWidthMm(105); // 構造再計算が書いた下階基準の派生値
  assert.equal(resolvedBeamColumnWidthMm(graph), 105, '派生値が優先される（自階の値90ではない）');
});

test('【失敗系】resolvedBeamColumnWidthMm: graph.beamColumnWidthMmが未再計算（null）の間は自階のwoodColumnWidthMmで暫定する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  graph.setWoodColumnWidthMm(105);
  assert.equal(graph.beamColumnWidthMm, null, '前提: 派生値は未再計算のままnull');
  assert.equal(resolvedBeamColumnWidthMm(graph), 105, '未再計算の間は自階の値へ暫定フォールバック');
});

test('structureRules: RC系はRC下地の壁だけを梁芯の生成源にし、基礎梁成はL/7。鉄骨系は生成源なし・L/8', () => {
  for (const key of ['RC造(ラーメン)', 'RC造(壁式)']) {
    const r = rulesFor(key);
    assert.equal(r.family, 'rc');
    assert.equal(isWoodStructure(key), false);
    assert.equal(r.wallBeamAxes, 'rcBacking');
    assert.deepEqual({ ...r.foundation.beamSizing }, { kind: 'spanDivisor', depthDivisor: 7 });
    assert.equal(foundationOptionsFor(key), RC_FOUNDATION_OPTIONS);
    assert.equal(r.foundation.hasBase('ベタ基礎'), true, '非木造はベースを常に生成');
    assert.equal(r.foundation.hasMatSlab('ベタ基礎'), false, '非木造の基礎スラブは手動配置');
    assert.deepEqual(r.designation, { roof: 'R階伏図', floorSuffix: '伏図' });
    assert.equal(r.sashFinDirect, false);
    assert.equal(defaultMaterialFor(key), 'RC');
  }
  for (const key of ['S造', 'SRC造']) {
    const r = rulesFor(key);
    assert.equal(r.family, 'steel');
    assert.equal(r.wallBeamAxes, null);
    assert.deepEqual({ ...r.foundation.beamSizing }, { kind: 'spanDivisor', depthDivisor: 8 });
    assert.equal(defaultMaterialFor(key), 'STEEL');
  }
  assert.equal(rulesFor('RC造(ラーメン)').isRigidFrame, true);
  assert.equal(rulesFor('RC造(壁式)').isRigidFrame, false);
});

test('【失敗系】structureRules: 未指定（\'未定\'）・未知の主構造は「木造扱いしない・材種は木造既定」の従来フォールバック', () => {
  for (const s of [UNSPECIFIED_STRUCTURE, undefined, null, '', '鉄骨造']) {
    const r = rulesFor(s);
    assert.equal(r, UNSPECIFIED_RULES, `${String(s)} は UNSPECIFIED_RULES`);
    assert.equal(isWoodStructure(s), false);
    assert.equal(isTraditionalWoodStructure(s), false);
    assert.equal(defaultMaterialFor(s), 'WOOD', '旧 defaultMaterialType の既定と同じ');
    assert.equal(foundationOptionsFor(s), RC_FOUNDATION_OPTIONS, '旧 foundationOptionsFor は非木造の選択肢');
    assert.deepEqual({ ...r.foundation.beamSizing }, { kind: 'spanDivisor', depthDivisor: 8 }, '旧 computeFoundationBeamSize はL/8');
    assert.deepEqual(r.designation, { roof: 'R階伏図', floorSuffix: '伏図' });
    assert.equal(r.wallBeamAxes, null);
    assert.equal(r.foundation.drawsBands, false);
    assert.equal(r.isRigidFrame, false);
  }
});

test('structureRules: 壁下地材ルールは材コード集合（backingClass.js）の分類で引ける', () => {
  assert.equal(backingClassOf(RC_WALL_BACKING_CODES[0]), BackingClass.RC);
  assert.equal(backingClassOf(WOOD_WALL_BACKING_CODES[0]), BackingClass.WOOD);
  assert.equal(backingClassOf('111111111134'), BackingClass.OTHER, '軽鉄スタッドは other');
  assert.equal(backingClassOf(undefined), BackingClass.OTHER);
  assert.equal(backingRulesFor(BackingClass.RC).beamAxisSource, true, 'RC壁下地だけが梁芯の生成源');
  assert.equal(backingRulesFor(BackingClass.WOOD).beamAxisSource, false);
  assert.equal(backingRulesFor(BackingClass.WOOD).sashFinMinDepth, 90, '木質下地は見込み90以上でフィン直付け');
  assert.equal(backingRulesFor('unknown'), BACKING_RULES[BackingClass.OTHER]);
});

test('structureRules: 主構造の選択肢は「未定」＋ルールセットのキー順で、既定値（StructuralInfo・FlatBuffers復元）と同じ表記', () => {
  assert.deepEqual([...MAIN_STRUCTURE_OPTIONS], [UNSPECIFIED_STRUCTURE, ...STRUCTURES]);
  // 【失敗系】主構造・基礎種別が未設定のプロジェクトの既定値は、ルールセットが「未指定」と認識する表記そのもの。
  const info = new StructuralInfo();
  assert.equal(info.mainStructure, UNSPECIFIED_STRUCTURE);
  assert.equal(rulesFor(info.mainStructure), UNSPECIFIED_RULES);
  assert.equal(info.foundationType, MAT_FOUNDATION);
  assert.ok(RC_FOUNDATION_OPTIONS.includes(info.foundationType) && WOOD_FOUNDATION_OPTIONS.includes(info.foundationType),
    '既定の基礎種別はRC系・木造系どちらの選択肢にも含まれる表記');
});

test('structureRules: べた基礎マットスラブの自動生成厚は断面図の既定（foundation.sectionDefaults.matThickness）と一致する', () => {
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  graph.structureOverride = TRADITIONAL_WOOD_STRUCTURE;
  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0, { labeled: true, discipline: Discipline.STRUCT });
  const y1 = graph.addCenterLine(CenterLineType.HORIZONTAL, 3640, { labeled: true, discipline: Discipline.STRUCT });
  const room = graph.addRoom(new Set([`${x0.id}:${y0.id}:${x1.id}:${y1.id}`]), 'LDK');
  generateRoomWallsFromOutline(graph, room);
  const project = { planes: [graph.plane], structuralInfo: { mainStructure: UNSPECIFIED_STRUCTURE, foundationType: MAT_FOUNDATION } };
  const { created } = autoFillMatFoundation(graph, project);
  assert.equal(created.length, 1, 'べた基礎のマットスラブが1枚生成されるはず');
  const slab = graph.slabs.find(s => s.id === created[0]);
  assert.equal(slab.thickness, rulesFor(TRADITIONAL_WOOD_STRUCTURE).foundation.sectionDefaults.matThickness);
  assert.equal(slab.thickness, 150);
});

// ---- 不変条件: 主構造の文字列を各所で直接比較しない（分岐はすべて structureRules.js 経由）----
// 対象は src 配下の製品コード（*.test.js・structureRules.js 自身・構造分類の宣言データを除く）。
// 主構造キーの表記自体は STRUCTURES（structuralClassification.js）と MAIN_STRUCTURE_OPTIONS が
// STRUCTURE_KEYS から組み立てるため、他ファイルに '木造（在来）' 等のリテラルが現れたら分岐の直書き。
// 比較形だけでなく**主構造名のリテラルそのもの**（宣言・既定値・`|| 'RC造(壁式)'` 等）も検出する。
// '未定' だけは主構造以外（建物用途・境界マスタのラベル）にも同じ語があるため比較形のみを対象にし、
// 既定値の出所（core/structuralInfo.js・schema/graphFbs.js）は UNSPECIFIED_STRUCTURE を使う
// ことを上の「主構造の選択肢」テストで固定する。
const FORBIDDEN_PATTERNS = [
  /startsWith\(['"](木造|RC造|S造|SRC造)/,
  /['"]木造（在来）['"]/,
  /['"]木造（2"×4"）['"]/,
  /['"]木造\(在来\)['"]/,
  /['"](RC造\(ラーメン\)|RC造\(壁式\)|S造|SRC造)['"]/,
  /===\s*['"]未定['"]|!==\s*['"]未定['"]/,
];
const ALLOWED_FILES = new Set([
  'structural/structureRules.js',
  'structural/structuralClassification.js', // 主構造キーの宣言データ（表記の真実）
  'structural/memberCatalog.js',            // 材種→表示ラベル（'S造' 等）。主構造の分岐ではない
]);
// 主構造由来の既定断面を材種の表から直接引かない（rulesFor(...).defaultSections が唯一の入口）。
// 材種固定の部材（基礎・柱脚・基礎梁＝RC、踊り場受け梁＝階段の材種）は DEFAULT_SECTION_BY_MATERIAL /
// DEFAULT_BEAM_SECTION_BY_MATERIAL を材種キーで引いてよいが、柱の既定断面は主構造由来しか無い。
const FORBIDDEN_SECTION_PATTERNS = [/DEFAULT_COLUMN_SECTION_BY_MATERIAL/];
const ALLOWED_SECTION_FILES = new Set(['structural/structureRules.js', 'structural/memberCatalog.js']);

function listSourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listSourceFiles(p, out);
    else if (/\.(js|jsx)$/.test(ent.name) && !/\.test\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

// 行コメント（`// …`）と、ブロックコメントの行頭（` * …`／`/** …`）を落として走査する
// （複数行にまたがるブロックコメントの途中行でも先頭が `*` でない行は対象になる＝単純化を優先）。
function scanOffenders(patterns, allowed) {
  const srcRoot = path.resolve(import.meta.dirname, '..');
  const offenders = [];
  for (const file of listSourceFiles(srcRoot)) {
    const rel = path.relative(srcRoot, file).replace(/\\/g, '/');
    if (allowed.has(rel)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const code = line.replace(/\/\/.*$/, '');
      if (patterns.some(re => re.test(code))) offenders.push(`${rel}:${i + 1}: ${trimmed}`);
    });
  }
  return offenders;
}

test('【不変条件】主構造の文字列（木造/RC造/S造/SRC造/未定）を structureRules.js の外で直接比較・直書きしない', () => {
  const offenders = scanOffenders(FORBIDDEN_PATTERNS, ALLOWED_FILES);
  assert.deepEqual(offenders, [], `主構造の直書きが残っている:\n${offenders.join('\n')}`);
});

test('【不変条件】主構造由来の柱の既定断面は rulesFor(...).defaultSections 以外から引かない', () => {
  const offenders = scanOffenders(FORBIDDEN_SECTION_PATTERNS, ALLOWED_SECTION_FILES);
  assert.deepEqual(offenders, [], `材種表からの柱既定断面の直接参照が残っている:\n${offenders.join('\n')}`);
});

// ---- 不変条件（ステップ4 C-2）: 在来木造の柱寸（framing.columnSection）は structureRules.js の
// 外で直接読まない。graph.woodColumnWidthMm（「各階柱寸法」欄。階の値・未設定はこのルール既定へ
// フォールバック）を経由する woodColumnWidthMm/woodColumnSectionId が唯一の入口。
const FORBIDDEN_COLUMN_SECTION_PATTERNS = [/framing\??\.columnSection/];
const ALLOWED_COLUMN_SECTION_FILES = new Set(['structural/structureRules.js']);

test('【不変条件】在来木造の柱寸（framing.columnSection）は structureRules.js の外で直接参照しない（woodColumnWidthMm/woodColumnSectionId が唯一の入口）', () => {
  const offenders = scanOffenders(FORBIDDEN_COLUMN_SECTION_PATTERNS, ALLOWED_COLUMN_SECTION_FILES);
  assert.deepEqual(offenders, [], `framing.columnSection の直接参照が残っている:\n${offenders.join('\n')}`);
});

// ---- 不変条件（実機QA指摘4・ステップ4 C-2）: 標準材の解決を採番パイプライン（collect/apply/
// renumberMembers）・UI（MemberListTab.jsx）・梁芯CL操作（transform/centerLineOps.js）で二系統に
// 分けない。beamColumnWidthMm(graph, belowGraph, project)（belowGraphを取る生の計算）を直接呼べるのは
// 構造再計算（structuralRecompute.js）と下階編集経路（structuralOrchestration.js）だけ——
// それ以外は resolvedBeamColumnWidthMm(graph, project)（belowGraph不要）を経由する。
// standardBeamSectionFor(graph, project, rules) も belowGraph を第4引数に取らない（3引数固定）。
const FORBIDDEN_BEAM_COLUMN_WIDTH_PATTERNS = [/(?<![a-zA-Z])beamColumnWidthMm\(/];
const ALLOWED_BEAM_COLUMN_WIDTH_FILES = new Set([
  'structural/structureRules.js',           // 自身の定義
  'structural/structuralRecompute.js',      // 構造再計算（唯一の書き込み元）
  'structural/structuralOrchestration.js',  // 下階編集経路（recomputeStructuralComposition・resyncTouchedMemberGroups）
]);

test('【不変条件・実機QA指摘4】beamColumnWidthMm(（belowGraphを取る生の計算）の直接呼び出しは structuralRecompute.js と下階編集経路（structuralOrchestration.js）以外に無い', () => {
  const offenders = scanOffenders(FORBIDDEN_BEAM_COLUMN_WIDTH_PATTERNS, ALLOWED_BEAM_COLUMN_WIDTH_FILES);
  assert.deepEqual(offenders, [], `beamColumnWidthMm(の直接呼び出しが残っている（resolvedBeamColumnWidthMmを使うこと）:\n${offenders.join('\n')}`);
});

test('【不変条件・実機QA指摘4】standardBeamSectionFor の呼び出しは belowGraph を第4引数に渡さない（宣言も3引数固定）', () => {
  const memberNumberingSrc = fs.readFileSync(path.resolve(import.meta.dirname, 'memberNumbering.js'), 'utf8');
  assert.ok(/export function standardBeamSectionFor\(graph, project, rules\) \{/.test(memberNumberingSrc),
    'standardBeamSectionFor の宣言が3引数（graph, project, rules）固定になっていない');
  // 呼び出しは実装上すべて単一行のため、行単位マッチで「belowGraphを渡す呼び出し」の再導入を検出する。
  const offenders = scanOffenders([/standardBeamSectionFor\(.*belowGraph/], new Set());
  assert.deepEqual(offenders, [], `standardBeamSectionFor(...) が belowGraph を渡している呼び出しが残っている:\n${offenders.join('\n')}`);
});

test('structureRules: 描画ルール（柱包み・平面の柱線色・線幅・伏図の色/柱記号）は在来木造だけ包みなし・壁と同じ色・極太線・全黒・×/□記号、梁端の柱判定は座標一致（beamEndColumnMatch）', () => {
  // 在来は壁厚＝柱寸法で柱の輪郭が壁の下地帯の線と重なるため極太線（実機 moku1 2026-09-15「柱が消えた」）
  // beamEndColumnMatch:'coordinate' は下階柱がper-floorの梁芯CL/中心線（自階と別id）に乗っても
  // 座標一致で端の柱とみなし面までトリムするため（ステップ1-b・下階柱分割の可視化）。
  assert.deepEqual({ ...rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing }, {
    columnFinishWrap: false, planColumnColor: 'wall', planColumnLineWeight: 'ultraThick',
    framingPlanColor: 'mono', framingColumnSymbol: 'crossBox', framingColumnLineWeight: 'byLod',
    memberTags: 'hide', beamDepthMark: 'offsetLine', beamEndColumnMatch: 'coordinate',
  });
  for (const key of ['木造（2"×4"）', 'S造', 'SRC造', 'RC造(ラーメン)', 'RC造(壁式)', UNSPECIFIED_STRUCTURE]) {
    assert.deepEqual({ ...rulesFor(key).drawing }, {
      columnFinishWrap: true, planColumnColor: 'material', planColumnLineWeight: 'thick',
      framingPlanColor: 'material', framingColumnSymbol: 'section', framingColumnLineWeight: 'fixed',
      memberTags: 'show', beamDepthMark: 'none', beamEndColumnMatch: 'clId',
    }, key);
  }
});

test('structureRules: ピン接合の梁の端部クリアランス（pinBeamEndClearanceMm）は在来木造だけ0（大梁面まで伸ばす）、他の主構造・未定は既定50（PIN_BEAM_END_CLEARANCE_MM）', () => {
  assert.equal(PIN_BEAM_END_CLEARANCE_MM, 50, '既定値（鉄骨造の従来どおり）');
  assert.equal(rulesFor(TRADITIONAL_WOOD_STRUCTURE).pinBeamEndClearanceMm, 0);
  for (const key of ['木造（2"×4"）', 'S造', 'SRC造', 'RC造(ラーメン)', 'RC造(壁式)', UNSPECIFIED_STRUCTURE, 'no-such-structure']) {
    assert.equal(rulesFor(key).pinBeamEndClearanceMm, PIN_BEAM_END_CLEARANCE_MM, key);
  }
});

test('effectiveStructure: project が無くても graph の後方参照（_structuralInfo / _structGraph 経由）から建物全体値を引く', () => {
  const info = new StructuralInfo();
  info.setField('mainStructure', TRADITIONAL_WOOD_STRUCTURE);
  const graph = new PlanGraph(new Plane('p1', 0, '1階', 1, 1));
  assert.equal(effectiveStructure(graph), undefined, '参照が無ければ未定義（UNSPECIFIED_RULES に落ちる）');
  assert.equal(rulesFor(effectiveStructure(graph)), UNSPECIFIED_RULES);
  graph._structuralInfo = info;
  assert.equal(effectiveStructure(graph), TRADITIONAL_WOOD_STRUCTURE);
  // peek の一時グラフ: _structuralInfo は無いが _structGraph 経由で辿る。
  const temp = new PlanGraph(new Plane('p2', 0, '2階', 2, 1));
  const structGraph = new PlanGraph(new Plane('struct', 0, '__struct__'));
  structGraph._structuralInfo = info;
  temp._structGraph = structGraph;
  assert.equal(effectiveStructure(temp), TRADITIONAL_WOOD_STRUCTURE);
  // 階の上書きが最優先、次に project。
  temp.structureOverride = 'S造';
  assert.equal(effectiveStructure(temp, { structuralInfo: info }), 'S造');
  assert.equal(effectiveStructure(graph, { structuralInfo: { mainStructure: 'RC造(壁式)' } }), 'RC造(壁式)');
});

test('backingClass: 柱同寸の間柱（120/105/90 × 45/30）が材マスタに大きさ順で存在し、woodStudCodeFor で引ける', async () => {
  const { MATERIALS } = await import('../finish/materials/materialData.js');
  const byCode = new Map(MATERIALS.map(m => [m.code, m]));
  for (const [size, code] of Object.entries(WOOD_STUD_CODE_BY_SIZE)) {
    const [w, d] = size.split('x').map(Number);
    const m = byCode.get(code);
    assert.ok(m, `${size} のコード ${code} が材マスタに無い`);
    assert.equal(m.category, 'backing');
    assert.deepEqual([m.x, m.y], [w, d], `${size}: 断面寸法`);
    assert.equal(woodStudCodeFor(w, d), code);
    assert.equal(backingClassOf(code), BackingClass.WOOD, `${size} は木質下地`);
  }
  assert.equal(woodStudCodeFor(150, 30), null, '表に無い柱寸は null');
  // 木質グループ内で新規4件は先頭に大きさ順（120×45, 120×30, 105×45, 105×30 → 既存の 90×90 …）。
  const wood = MATERIALS.filter(m => m.category === 'backing' && backingClassOf(m.code) === BackingClass.WOOD);
  assert.deepEqual(wood.slice(0, 5).map(m => m.name), ['□-120×45', '□-120×30', '□-105×45', '□-105×30', '□-90×90']);
  // コードは一意。
  assert.equal(new Set(MATERIALS.map(m => m.code)).size, MATERIALS.length, '材コードが重複している');
});
