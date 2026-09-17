// structural/framingDrawing.js（伏図の描画規則：柱記号・部材線色・柱の断面フォールバック）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAMING_MONO_COLOR, COLUMN_FALLBACK_SIZE_MM,
  framingColumnGroups, framingColor, framingColorOverride,
  columnSectionSize, columnCrossPointsLocal, COLUMN_CROSS_OVERHANG_RATIO, framingColumnLineWeight, showMemberTags, beamDepthMarks,
  sillBandSpec, pickMembersOnFigure, columnListCategory, pickColumnsOnFigure, columnRenderSize,
} from './framingDrawing.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { STRUCTURES } from './structuralClassification.js';
import { LodLevel } from '../viewport.js';

const NON_TRADITIONAL_KEYS = [...STRUCTURES.filter(k => k !== TRADITIONAL_WOOD_STRUCTURE), UNSPECIFIED_STRUCTURE];

test('framingColumnGroups: 非在来は下階1群のみ・輪郭強制なし。在来は下階boxCross＋自階boxで両方輪郭強制', () => {
  const woodGroups = framingColumnGroups(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing);
  assert.deepEqual(woodGroups, [
    { category: 'columnMap', symbol: 'boxCross', outline: true },
    { category: 'columnMapSelf', symbol: 'box', outline: true },
  ]);
  for (const key of NON_TRADITIONAL_KEYS) {
    const groups = framingColumnGroups(rulesFor(key).drawing);
    assert.deepEqual(groups, [{ category: 'columnMap', symbol: 'section', outline: false }], `${key}: 下階1群のみ・輪郭強制なし`);
  }
});

test('【失敗系】framingColumnGroups: 未知の framingColumnSymbol 値は既定側（下階section・輪郭なし・自階なし）に倒す', () => {
  for (const bogus of [undefined, null, '', 'unknown', 'section']) {
    const groups = framingColumnGroups({ framingColumnSymbol: bogus });
    assert.deepEqual(groups, [{ category: 'columnMap', symbol: 'section', outline: false }], `framingColumnSymbol=${String(bogus)}`);
  }
});

test('columnListCategory: 在来木造は自階柱□（columnMapSelf）、他の主構造・未知値は下階柱×（columnMap）', () => {
  assert.equal(columnListCategory(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing), 'columnMapSelf');
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.equal(columnListCategory(rulesFor(key).drawing), 'columnMap', key);
  }
});

test('【失敗系】columnListCategory: drawing自体が未知値・{}・undefinedはcolumnMap（既定・恒等写像）', () => {
  for (const drawing of [{}, undefined, { framingColumnSymbol: 'unknown' }, { framingColumnSymbol: 'section' }]) {
    assert.equal(columnListCategory(drawing), 'columnMap', String(drawing));
  }
});

test('framingColorOverride: 在来木造は黒を返し、他の主構造はnull（ColumnsLayerの材種色フォールバックに委ねる）', () => {
  assert.equal(framingColorOverride(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing), FRAMING_MONO_COLOR);
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.equal(framingColorOverride(rulesFor(key).drawing), null, `${key}: colorOverrideはnull`);
  }
});

test('伏図の線色: 在来木造は木/鉄骨/RCの3色すべて黒。他の主構造は恒等写像（材種色のまま）', () => {
  const materialColors = ['#92400e', '#475569', '#1e293b']; // 木/鉄骨/RC（COLOR_BY_MATERIALと同じ値を直書き。renderer/.jsxは引かない）
  const woodDrawing = rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing;
  for (const c of materialColors) {
    assert.equal(framingColor(woodDrawing, c), FRAMING_MONO_COLOR, `在来木造は${c}も黒`);
  }
  for (const key of NON_TRADITIONAL_KEYS) {
    const drawing = rulesFor(key).drawing;
    for (const c of materialColors) {
      assert.equal(framingColor(drawing, c), c, `${key}: ${c}は恒等写像`);
    }
  }
});

test('framingColumnLineWeight: 在来木造は略図medium・標準/詳細thick。それ以外の主構造は全LODでmedium', () => {
  const woodDrawing = rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing;
  assert.equal(framingColumnLineWeight(woodDrawing, LodLevel.SCHEMATIC), 'medium');
  assert.equal(framingColumnLineWeight(woodDrawing, LodLevel.STANDARD), 'thick');
  assert.equal(framingColumnLineWeight(woodDrawing, LodLevel.DETAIL), 'thick');
  for (const key of NON_TRADITIONAL_KEYS) {
    const drawing = rulesFor(key).drawing;
    for (const lod of [LodLevel.SCHEMATIC, LodLevel.STANDARD, LodLevel.DETAIL]) {
      assert.equal(framingColumnLineWeight(drawing, lod), 'medium', `${key} @ ${lod}`);
    }
  }
});

test('【失敗系】framingColumnLineWeight: drawing自体が未知値・{}・undefinedでも全LODでmedium', () => {
  for (const drawing of [{}, undefined, { framingColumnLineWeight: 'unknown' }, { framingColumnLineWeight: 'fixed' }]) {
    for (const lod of [LodLevel.SCHEMATIC, LodLevel.STANDARD, LodLevel.DETAIL]) {
      assert.equal(framingColumnLineWeight(drawing, lod), 'medium');
    }
  }
});

test('showMemberTags: 在来木造はfalse、それ以外の主構造はtrue', () => {
  assert.equal(showMemberTags(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing), false);
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.equal(showMemberTags(rulesFor(key).drawing), true, key);
  }
});

test('【失敗系】showMemberTags: drawing自体が未知値・{}・undefinedはtrue（既定show扱い）', () => {
  for (const drawing of [{}, undefined, { memberTags: 'unknown' }, { memberTags: 'show' }]) {
    assert.equal(showMemberTags(drawing), true);
  }
});

test('pickMembersOnFigure: showMemberTagsの否定（在来木造はtrue＝タグの代わりに梁タップ、それ以外はfalse）', () => {
  assert.equal(pickMembersOnFigure(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing), true);
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.equal(pickMembersOnFigure(rulesFor(key).drawing), false, key);
  }
});

test('【失敗系】pickMembersOnFigure: drawing自体が未知値・{}・undefinedはfalse（showMemberTagsの既定showの否定）', () => {
  for (const drawing of [{}, undefined, { memberTags: 'unknown' }, { memberTags: 'show' }]) {
    assert.equal(pickMembersOnFigure(drawing), false);
  }
});

// ---- ステップ4「柱は共通と個別指定の2層」: 柱タップ（自階柱□のみ）の有効化判定 ----

test('pickColumnsOnFigure: 在来木造はtrue（自階柱□のタップで共通カードを開ける）、他の主構造はfalse', () => {
  assert.equal(pickColumnsOnFigure(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing), true);
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.equal(pickColumnsOnFigure(rulesFor(key).drawing), false, key);
  }
});

test('【失敗系】pickColumnsOnFigure: drawing自体が未知値・{}・undefinedはfalse', () => {
  for (const drawing of [{}, undefined, { memberTags: 'unknown', framingColumnSymbol: 'unknown' }, { memberTags: 'show', framingColumnSymbol: 'section' }]) {
    assert.equal(pickColumnsOnFigure(drawing), false);
  }
});

// beamDepthMarks 用の基本梁データ（sectionDefId='WOOD-120x330'。w=120, h=330、成≠幅）。
const WOOD_DRAWING = rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing;
function makeBeam(overrides = {}) {
  return {
    id: 'b1', isVertical: false, axisValue: 1000, coord1: 0, coord2: 2000,
    sectionDefId: 'WOOD-120x330', role: 'primary', materialType: 'WOOD',
    ...overrides,
  };
}

test('beamDepthMarks: 各斜線は45度（along方向とacross方向の変位の絶対値が等しい）', () => {
  const [mark] = beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam()]);
  assert.ok(mark, 'マークが1件生成されるはず');
  for (const [x1, y1, x2, y2] of mark.slopes) {
    // isVertical=false なので along=x, across=y。
    assert.equal(Math.abs(x2 - x1), Math.abs(y2 - y1), `斜線 ${[x1, y1, x2, y2]} が45度でない`);
  }
});

test('beamDepthMarks: 平行線は軸から2.5w離れ、区間は[lo+2w, hi-2w]', () => {
  const [mark] = beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam()]);
  const [x1, y1, x2, y2] = mark.parallel;
  assert.equal(y1, 1000 + 2.5 * 120, '平行線の軸からの離れ＝2.5w');
  assert.equal(y2, y1);
  assert.deepEqual([Math.min(x1, x2), Math.max(x1, x2)], [0 + 2 * 120, 2000 - 2 * 120], '区間＝[lo+2w, hi-2w]');
});

test('beamDepthMarks: ラベルは「幅×成」の文字列で、縦梁はrotation=-90・横梁は0', () => {
  const [horiz] = beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam()]);
  assert.equal(horiz.label.text, '120×330');
  assert.equal(horiz.label.rotation, 0);
  const [vert] = beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ isVertical: true })]);
  assert.equal(vert.label.text, '120×330');
  assert.equal(vert.label.rotation, -90);
});

// beamDepthMarksの側選択テスト共通ヘルパ（axisValue=1000からの向きを符号で返す）。
function sideOf(beams) {
  const [mark] = beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, beams);
  return Math.sign(mark.parallel[1] - 1000);
}

test('beamDepthMarks: 側の選択（片側だけに他梁があり2.5w超で近接なし→その側／両側で+側が2.5w以内→−1）', () => {
  const base = makeBeam();
  // +側にだけ他梁（axisValue=1500,距離500>2.5w=300なので近接ガード対象外）。
  assert.equal(sideOf([base, { ...base, id: 'other', axisValue: 1500 }]), 1);
  // −側にだけ他梁（axisValue=500,距離500>2.5w=300）。
  assert.equal(sideOf([base, { ...base, id: 'other', axisValue: 500 }]), -1);
  // 両側にあり、+側の最近傍が2.5w(=300)以内（250）→−1。
  assert.equal(sideOf([base, { ...base, id: 'plus', axisValue: 1250 }, { ...base, id: 'minus', axisValue: 700 }]), -1);
});

test('【裁定2026-09-16・対称化】beamDepthMarks: 片側のみに他梁があっても2.5w以内に近ければ反対側（空いている側）へ出す', () => {
  const base = makeBeam();
  // +側のみaxisValue=1200（距離200<=2.5w=300）、−側は空 → 反対側(−1)へ出す。
  assert.equal(sideOf([base, { ...base, id: 'other', axisValue: 1200 }]), -1);
  // 対称: −側のみaxisValue=800（距離200<=2.5w=300）、+側は空 → 反対側(+1)へ出す。
  assert.equal(sideOf([base, { ...base, id: 'other', axisValue: 800 }]), 1);
});

test('【失敗系】beamDepthMarks 側選択: スパンが重ならない同方向の梁・向きの違う梁は近傍に数えない', () => {
  const base = makeBeam(); // isVertical:false, axisValue:1000, coord1:0, coord2:2000
  // −側axisValue=500（距離500>2.5w=300。近接ガード対象外）は重なるので数える。
  // +側axisValue=2000はスパンが重ならない(5000..7000)ため無視されるはず——もし誤って数えられると
  // 「両側」判定になり、+側の最近傍(距離1000>2.5w)は遠いので既定+1が返ってしまい、
  // 正しく無視されたときの結果（−側のみ→−1）と食い違う。
  assert.equal(sideOf([
    base,
    { ...base, id: 'farPlus', axisValue: 2000, coord1: 5000, coord2: 7000 },
    { ...base, id: 'minus', axisValue: 500 },
  ]), -1);
  // +側isVertical:trueのaxisValue=2000は向きが違うため無視されるはず——もし誤って数えられると
  // 同様に「両側」判定になり+1が返ってしまう。−側axisValue=500（同方向・重なる・距離500>2.5w）。
  assert.equal(sideOf([
    base,
    { ...base, id: 'plusPerp', axisValue: 2000, isVertical: true },
    { ...base, id: 'minus', axisValue: 500 },
  ]), -1);
});

test('【失敗系】beamDepthMarks: 正角材・スパン不足・SCHEMATIC・カタログ外・基礎梁は空', () => {
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ sectionDefId: 'WOOD-120x120' })]), [], '正角材は空');
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ coord1: 0, coord2: 400 })]), [], 'hi-lo<=4wは空');
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.SCHEMATIC, [makeBeam()]), [], 'SCHEMATICは空');
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ sectionDefId: 'NO-SUCH-SECTION' })]), [], 'カタログ外は空');
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ role: 'foundation' })]), [], '基礎梁は空');
});

test('【失敗系】beamDepthMarks: 非在来6種＋未知値のdrawingは常に空（LOD・梁の形状は正常でも）', () => {
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.deepEqual(beamDepthMarks(rulesFor(key).drawing, LodLevel.STANDARD, [makeBeam()]), [], key);
  }
  for (const drawing of [{}, undefined, { beamDepthMark: 'unknown' }]) {
    assert.deepEqual(beamDepthMarks(drawing, LodLevel.STANDARD, [makeBeam()]), [], String(drawing));
  }
});

test('【失敗系】beamDepthMarks: beamsがundefined/nullでも例外を投げず空配列を返す', () => {
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, undefined), []);
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, null), []);
});

test('sillBandSpec: halfはsillWidthMmの半分、weightは常にmedium（在来木造・非在来6種とも）', () => {
  for (const key of [TRADITIONAL_WOOD_STRUCTURE, ...NON_TRADITIONAL_KEYS]) {
    const foundationRules = rulesFor(key).foundation;
    const spec = sillBandSpec(foundationRules);
    assert.equal(spec.half, foundationRules.sillWidthMm / 2, `${key}: half`);
    assert.equal(spec.weight, 'medium', `${key}: weight`);
  }
});

test('【失敗系】断面がカタログに無い柱は120角にフォールバックし、対角線2本の端点集合＝矩形4隅を延長した集合（比率1なら4隅そのもの）', () => {
  for (const column of [{ sectionDefId: undefined }, { sectionDefId: 'NO-SUCH-SECTION' }, {}]) {
    const size = columnSectionSize(column);
    assert.deepEqual(size, { width: COLUMN_FALLBACK_SIZE_MM, height: COLUMN_FALLBACK_SIZE_MM });
    const lines = columnCrossPointsLocal(size.width, size.height, 1);
    assert.equal(lines.length, 2, '対角線は2本');
    const points = new Set();
    for (const [x1, y1, x2, y2] of lines) {
      points.add(`${x1},${y1}`);
      points.add(`${x2},${y2}`);
    }
    const h = COLUMN_FALLBACK_SIZE_MM / 2;
    const corners = new Set([`${-h},${-h}`, `${h},${h}`, `${-h},${h}`, `${h},${-h}`]);
    assert.deepEqual(points, corners, '比率1の対角線2本の端点は矩形の4隅と一致するはず（式の写経ではなく意図の検査）');
  }
});

// ---- QA指摘8・ステップ4: columnRenderSize（柱タップのhitStrokeWidthが常に正であることの土台） ----

test('columnRenderSize: 矩形（幅≠成）はMath.max(width, height)、正方形は一辺と同じ', () => {
  assert.equal(columnRenderSize({ sectionDefId: 'WOOD-120x330' }), 330, '幅120×成330は大きい方の330');
  assert.equal(columnRenderSize({ sectionDefId: 'WOOD-120x120' }), 120, '正方形は一辺と同じ');
});

test('【失敗系・QA指摘8】columnRenderSize: 断面がカタログに無い柱はCOLUMN_FALLBACK_SIZE_MM（120）にフォールバックし、常に正の値を返す', () => {
  for (const column of [{ sectionDefId: 'no-such' }, { sectionDefId: undefined }, {}]) {
    const size = columnRenderSize(column);
    assert.equal(size, COLUMN_FALLBACK_SIZE_MM, `カタログ外は${COLUMN_FALLBACK_SIZE_MM}角にフォールバックするはず: ${JSON.stringify(column)}`);
    assert.ok(size > 0, 'hitStrokeWidth（MEMBER_HIT_PX/scaleとのMath.max）の算出元として常に正でなければならない');
  }
});

test('columnCrossPointsLocal: 既定（COLUMN_CROSS_OVERHANG_RATIO）では×の端点が□の4隅より外（はみ出す）にあり、対角線上に乗る', () => {
  assert.ok(COLUMN_CROSS_OVERHANG_RATIO > 1, '既定比率は1超（□からでっぱる）');
  const w = 120, h = 105;
  const lines = columnCrossPointsLocal(w, h);
  assert.equal(lines.length, 2);
  for (const [x1, y1, x2, y2] of lines) {
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      assert.ok(Math.abs(x) > w / 2 && Math.abs(y) > h / 2, `端点(${x},${y})は□(±${w / 2},±${h / 2})の外`);
      // 端点は□の対角線の延長上（|x|/|y| = w/h）にある＝×の向きが□と同じ。
      assert.ok(Math.abs(Math.abs(x) / Math.abs(y) - w / h) < 1e-9, `端点(${x},${y})は□の対角線の延長上`);
    }
    // 2端点は原点対称（中心を通る1本の対角線）。
    assert.equal(x1, -x2); assert.equal(y1, -y2);
  }
  // 2本は互いに別の対角線（同じ線を2回返していない）。
  assert.notDeepEqual(lines[0], lines[1]);
});
