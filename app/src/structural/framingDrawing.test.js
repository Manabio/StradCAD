// structural/framingDrawing.js（伏図の描画規則：柱記号・部材線色・柱の断面フォールバック）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAMING_MONO_COLOR, COLUMN_FALLBACK_SIZE_MM,
  framingColumnGroups, framingColor, framingColorOverride,
  columnSectionSize, columnCrossPointsLocal, COLUMN_CROSS_OVERHANG_RATIO, framingColumnLineWeight, showMemberTags, beamDepthMarks,
  pickMembersOnFigure, columnListCategory, pickColumnsOnFigure, columnRenderSize,
  ROOF_FRAMING_DASH, showRoofFraming, roofFramingWidths, roofFramingHostMembers, roofFramingPrimitives,
} from './framingDrawing.js';
import { roofFramingLines, roofStrutPoints } from './roofFramingGeometry.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { STRUCTURES } from './structuralClassification.js';
import { LodLevel } from '../viewport.js';

const NON_TRADITIONAL_KEYS = [...STRUCTURES.filter(k => k !== TRADITIONAL_WOOD_STRUCTURE), UNSPECIFIED_STRUCTURE];

test('framingColumnGroups: 非在来は下階1群のみ・輪郭強制なし。在来は下階cross（×のみ・断面□なし）＋自階box（輪郭強制）', () => {
  // 下階柱は×だけ（実機指摘2026-09-17: 断面□まで描くと通しの梁の帯の中に柱寸の四角が残る）。
  const woodGroups = framingColumnGroups(rulesFor(TRADITIONAL_WOOD_STRUCTURE).drawing);
  assert.deepEqual(woodGroups, [
    { category: 'columnMap', symbol: 'cross', outline: false },
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

// ---- ステップC3a: 小屋組（棟木・母屋・束）の描画プリミティブ ----

const TOL = 0.5;
const WOOD_FRAMING = rulesFor(TRADITIONAL_WOOD_STRUCTURE).framing;
// moku4 の最上階（7280×8974。X 方向が幅・Y 方向が奥行き）。切妻の棟は y 方向＝x=3640。
const MOKU_RECT = { x1: 0, y1: -12614, x2: 7280, y2: -3640 };
const gableRegion = { key: 'main', rect: MOKU_RECT, shape: 'gable', ridgeIsVertical: true, highSide: null };
const baseArgs = (over = {}) => ({
  regions: [gableRegion], hostBeams: [], ridgeWidthMm: 120, purlinWidthMm: 90,
  purlinPitchMm: WOOD_FRAMING.purlinPitchMm, purlinStartOffsetsMm: WOOD_FRAMING.purlinStartOffsetsMm, tolMm: TOL, ...over,
});
const kindOf = (prims, kind) => prims.filter(p => p.kind === kind);

test('roofFramingPrimitives: 切妻（moku4 最上階）は棟木が軸±60の2本・母屋が1本ずつ6本、端は屋根範囲の辺まで。束は host が無ければ無い', () => {
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs());
  assert.equal(prims.length, 8);
  const ridges = kindOf(prims, 'ridge');
  assert.deepEqual(ridges.map(p => p.points), [
    [3580, -12614, 3580, -3640],
    [3700, -12614, 3700, -3640],
  ], '棟木は x=3640 の軸から ±60 の2本（実寸 120 角）、端は y1/y2');
  const purlins = kindOf(prims, 'purlin');
  assert.deepEqual(purlins.map(p => p.points[0]), [910, 1820, 2730, 4550, 5460, 6370], '母屋 x=910・1820・2730・4550・5460・6370');
  for (const p of purlins) {
    assert.equal(p.points[0], p.points[2], '縦線');
    assert.deepEqual([p.points[1], p.points[3]], [-12614, -3640], '端は屋根範囲の辺まで（軒の出は描かない）');
  }
  assert.equal(kindOf(prims, 'strut').length, 0, 'host 梁が無ければ束は無い');
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
});

test('【D1】roofFramingPrimitives: region.outline は閉路ごとに kind:outline（key＝region:outline:i・closed）。切妻の棟木・母屋・束の数は不変・束は外形線の対象外', () => {
  const hostBeams = [{ isVertical: false, axis: -3640, lo: 0, hi: 7280 }];
  const outline = [{ points: [7735, -13069, 7735, -3185, -455, -3185, -455, -13069] }];
  const without = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ hostBeams }));
  const withOutline = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [{ ...gableRegion, outline }], hostBeams }));
  assert.deepEqual(kindOf(withOutline, 'outline'), [{ kind: 'outline', key: 'main:outline:0', points: outline[0].points, closed: true }]);
  assert.deepEqual(withOutline.filter(p => p.kind !== 'outline'), without, '外形線以外（棟木・母屋・束）は不変');
  assert.deepEqual(['ridge', 'purlin', 'strut'].map(k => kindOf(withOutline, k).length), ['ridge', 'purlin', 'strut'].map(k => kindOf(without, k).length));
  assert.ok(kindOf(withOutline, 'strut').length > 0, '前提: 束が立つ host 梁がある');
  assert.ok(withOutline.findIndex(p => p.kind === 'outline') < withOutline.findIndex(p => p.kind === 'strut'), '外形線は束の前（region ごとの並び）');
});

test('【D1】roofFramingPrimitives: 閉路が複数（外周＋穴）なら outline:0・outline:1。寄棟・片流れも出る。key は一意', () => {
  const rings = [{ points: [3100, -100, 3100, 3100, -100, 3100, -100, -100] }, { points: [1100, 1100, 1100, 1900, 1900, 1900, 1900, 1100] }];
  const hip = { key: 'main', rect: null, rects: [{ x1: 0, y1: 0, x2: 3000, y2: 1000 }], shape: 'hip', ridgeIsVertical: null, highSide: null, outline: rings };
  const mono = { key: 'lean:r1', rect: { x1: 0, y1: 0, x2: 2000, y2: 1500 }, shape: 'mono', ridgeIsVertical: false, highSide: 'left', outline: [rings[0]] };
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [hip, mono] }));
  assert.deepEqual(kindOf(prims, 'outline').map(p => p.key), ['main:outline:0', 'main:outline:1', 'lean:r1:outline:0']);
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
});

test('【D1・失敗系】roofFramingPrimitives: outline が無い・空の region は外形線を出さない。略図・非在来は outline があっても空', () => {
  for (const region of [gableRegion, { ...gableRegion, outline: [] }, { ...gableRegion, outline: undefined }]) {
    assert.equal(kindOf(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region] })), 'outline').length, 0);
  }
  const region = { ...gableRegion, outline: [{ points: [0, 0, 1, 0, 1, 1, 0, 1] }] };
  assert.deepEqual(roofFramingPrimitives(WOOD_DRAWING, LodLevel.SCHEMATIC, baseArgs({ regions: [region] })), []);
  assert.deepEqual(roofFramingPrimitives(rulesFor('S造').drawing, LodLevel.STANDARD, baseArgs({ regions: [region] })), []);
});

test('roofFramingPrimitives: 束は母屋・棟木と host 梁の全交点に半径45（母屋90角の半分）で出る（東西の軒桁 y=-3640・-12614 で 7×2=14 か所）', () => {
  const hostBeams = [
    { isVertical: false, axis: -3640, lo: 0, hi: 7280 },
    { isVertical: false, axis: -12614, lo: 0, hi: 7280 },
  ];
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.DETAIL, baseArgs({ hostBeams }));
  const struts = kindOf(prims, 'strut');
  assert.equal(struts.length, 14);
  for (const s of struts) assert.equal(s.radius, 45);
  const at = y => struts.filter(s => s.y === y).map(s => s.x).sort((a, b) => a - b);
  assert.deepEqual(at(-3640), [910, 1820, 2730, 3640, 4550, 5460, 6370]);
  assert.deepEqual(at(-12614), [910, 1820, 2730, 3640, 4550, 5460, 6370]);
  assert.deepEqual(struts[0], { kind: 'strut', key: 'main:strut:0', x: 910, y: -12614, radius: 45 }, '型と座標を固定');
});

test('roofFramingPrimitives: 母屋・棟木と交わらない host 梁（範囲外・平行）には束が立たない', () => {
  const hostBeams = [
    { isVertical: false, axis: -3640, lo: 0, hi: 1000 },      // x=910 の母屋だけに届く
    { isVertical: true, axis: 3640, lo: -12614, hi: -3640 },  // 棟木と平行（重なり）
    { isVertical: false, axis: -2000, lo: 0, hi: 7280 },      // 屋根範囲の外（y が範囲外）
  ];
  const struts = kindOf(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ hostBeams })), 'strut');
  assert.deepEqual(struts.map(s => [s.x, s.y]), [[910, -3640]]);
});

test('roofFramingPrimitives: 片流れは棟木なし・母屋は高い側の辺から（高さ3000は455始まり・残り725。top: y=455,1365,2275 の3本）', () => {
  const region = { key: 'lean:r1', rect: { x1: 0, y1: 0, x2: 9000, y2: 3000 }, shape: 'mono', ridgeIsVertical: false, highSide: 'top' };
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region] }));
  assert.equal(kindOf(prims, 'ridge').length, 0);
  assert.deepEqual(kindOf(prims, 'purlin').map(p => p.points),
    [455, 1365, 2275].map(y => [0, y, 9000, y]));
});

test('roofFramingPrimitives: 寄棟は棟木側から910ごとの環状の母屋（2周×4辺）と、長さ（長辺−短辺）の棟木2本線', () => {
  const region = { key: 'main', rect: { x1: 0, y1: 0, x2: 7280, y2: 5460 }, shape: 'hip', ridgeIsVertical: false, highSide: null };
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region] }));
  assert.deepEqual(kindOf(prims, 'ridge').map(p => p.points), [
    [2730, 2670, 4550, 2670], [2730, 2790, 4550, 2790],
  ], '棟木は y=2730 の軸 ±60、x は 2730〜4550（長さ 7280−5460=1820）');
  assert.equal(kindOf(prims, 'purlin').length, 8);
});

// L字（9100×7280 から右上 3640×3640 を欠く）。rect:null・rects の region＝矩形でない寄棟（C2e-2）。
const L_RECTS = [
  { x1: 0, y1: 0, x2: 5460, y2: 3640 }, { x1: 0, y1: 3640, x2: 5460, y2: 7280 }, { x1: 5460, y1: 3640, x2: 9100, y2: 7280 },
];
const lHipRegion = { key: 'main', rect: null, rects: L_RECTS, shape: 'hip', ridgeIsVertical: null, highSide: null };

test('【C2e-2】roofFramingPrimitives: 矩形でない寄棟（rect:null・rects）は棟木の対（軸±60）・母屋（10本）・束が出る。key は main:ridge:i:± の形', () => {
  const hostBeams = [{ isVertical: false, axis: 910, lo: 0, hi: 9100 }];
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [lHipRegion], hostBeams }));
  assert.deepEqual(kindOf(prims, 'ridge').map(p => [p.key, p.points]), [
    ['main:ridge:0:-', [3640, 5400, 7280, 5400]], ['main:ridge:0:+', [3640, 5520, 7280, 5520]],
    ['main:ridge:1:-', [2670, 2730, 2670, 4550]], ['main:ridge:1:+', [2790, 2730, 2790, 4550]],
  ], '棟木 y=5460 の x3640..7280 と x=2730 の y2730..4550（軸±60の2本ずつ）');
  assert.deepEqual(kindOf(prims, 'purlin').map(p => p.points), [
    [910, 910, 4550, 910], [1820, 1820, 3640, 1820], [4550, 4550, 8190, 4550], [1820, 5460, 3640, 5460], [910, 6370, 8190, 6370],
    [910, 910, 910, 6370], [1820, 1820, 1820, 5460], [3640, 1820, 3640, 5460], [4550, 910, 4550, 4550], [8190, 4550, 8190, 6370],
  ]);
  const struts = kindOf(prims, 'strut');
  assert.deepEqual(struts.map(s => [s.x, s.y, s.radius]).sort((a, b) => a[0] - b[0]), [[910, 910, 45], [4550, 910, 45]],
    '束は y=910 の梁と、母屋 x=910・x=4550 の交点（向きが混在する線でも立つ）');
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
});

test('【C2e-2b】roofFramingPrimitives: L字の寄棟は隅木6・谷木1が points と key（main:hip:i・main:valley:i）で出る。並びは棟木→母屋→隅木→谷木→束', () => {
  const hostBeams = [{ isVertical: false, axis: 910, lo: 0, hi: 9100 }];
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [lHipRegion], hostBeams }));
  assert.deepEqual(kindOf(prims, 'hip').map(p => [p.key, p.points]), [
    ['main:hip:0', [0, 0, 2730, 2730]], ['main:hip:1', [0, 7280, 2730, 4550]], ['main:hip:2', [3640, 5460, 2730, 4550]],
    ['main:hip:3', [5460, 0, 2730, 2730]], ['main:hip:4', [9100, 3640, 7280, 5460]], ['main:hip:5', [9100, 7280, 7280, 5460]],
  ]);
  assert.deepEqual(kindOf(prims, 'valley').map(p => [p.key, p.points]), [['main:valley:0', [5460, 3640, 3640, 5460]]]);
  const order = ['ridge', 'purlin', 'hip', 'valley', 'strut'];
  const ranks = prims.map(p => order.indexOf(p.kind));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '種別の並び');
  assert.equal(new Set(prims.map(p => p.key)).size, prims.length, 'key は一意');
});

test('【C2e-2b】roofFramingPrimitives: 矩形の寄棟は隅木4（谷木なし）。斜め線を足しても束の数は変わらない（斜め線に束は立たない）', () => {
  const region = { key: 'main', rect: { x1: 0, y1: 0, x2: 7280, y2: 5460 }, shape: 'hip', ridgeIsVertical: false, highSide: null };
  const hostBeams = [{ isVertical: false, axis: 910, lo: 0, hi: 7280 }, { isVertical: true, axis: 910, lo: 0, hi: 5460 }];
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region], hostBeams }));
  assert.deepEqual(kindOf(prims, 'hip').map(p => p.points), [
    [0, 0, 2730, 2730], [0, 5460, 2730, 2730], [7280, 0, 4550, 2730], [7280, 5460, 4550, 2730],
  ]);
  assert.equal(kindOf(prims, 'valley').length, 0);
  // 斜め線を受け取らない確認: 隅木・谷木を除いた線だけから roofStrutPoints を直接引いた数と一致する
  const { ridges, purlins } = roofFramingLines({
    rect: region.rect, shape: 'hip', purlinPitchMm: WOOD_FRAMING.purlinPitchMm,
    purlinStartOffsetsMm: WOOD_FRAMING.purlinStartOffsetsMm, tolMm: TOL,
  });
  assert.equal(kindOf(prims, 'strut').length, roofStrutPoints([...ridges, ...purlins], hostBeams, TOL).length);
});

test('【C2e-2b・失敗系】roofFramingPrimitives: 切妻・片流れ・陸屋根は隅木・谷木を持たない（矩形・矩形でない範囲とも）', () => {
  const rect = { x1: 0, y1: 0, x2: 7280, y2: 5460 };
  for (const shape of ['gable', 'mono', 'flat', 'staggered']) {
    for (const region of [{ key: 'main', rect, shape, ridgeIsVertical: false, highSide: 'top' }, { ...lHipRegion, shape }]) {
      const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region] }));
      assert.equal(prims.filter(p => p.kind === 'hip' || p.kind === 'valley').length, 0, shape);
    }
  }
});

test('【C2e-2・失敗系】roofFramingPrimitives: rects があっても矩形でない切妻・片流れ・陸屋根は空。rects が空・無しの rect:null も空', () => {
  for (const shape of ['gable', 'mono', 'flat', 'staggered']) {
    const region = { ...lHipRegion, shape };
    assert.deepEqual(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region] })), [], shape);
  }
  for (const rects of [[], undefined, null]) {
    assert.deepEqual(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [{ ...lHipRegion, rects }] })), []);
  }
});

test('roofFramingPrimitives: 複数 region（主屋根＋下屋）は region の key で区別され、それぞれの線が出る', () => {
  const lean = { key: 'lean:r1', rect: { x1: 0, y1: 0, x2: 9000, y2: 3000 }, shape: 'mono', ridgeIsVertical: false, highSide: 'top' };
  const prims = roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [gableRegion, lean] }));
  assert.equal(prims.filter(p => p.key.startsWith('main:')).length, 8);
  assert.equal(prims.filter(p => p.key.startsWith('lean:r1:')).length, 3);
});

test('【失敗系】roofFramingPrimitives: 略図（SCHEMATIC）は region・host があっても空', () => {
  const hostBeams = [{ isVertical: false, axis: -3640, lo: 0, hi: 7280 }];
  assert.deepEqual(roofFramingPrimitives(WOOD_DRAWING, LodLevel.SCHEMATIC, baseArgs({ hostBeams })), []);
});

test('【失敗系】roofFramingPrimitives: 非在来6種＋未知値・未定義の drawing は常に空（LOD・region・host が正常でも）', () => {
  const hostBeams = [{ isVertical: false, axis: -3640, lo: 0, hi: 7280 }];
  for (const key of NON_TRADITIONAL_KEYS) {
    assert.deepEqual(roofFramingPrimitives(rulesFor(key).drawing, LodLevel.STANDARD, baseArgs({ hostBeams })), [], key);
  }
  for (const drawing of [{}, undefined, null, { roofFramingLines: 'unknown' }, { roofFramingLines: 'none' }]) {
    assert.deepEqual(roofFramingPrimitives(drawing, LodLevel.STANDARD, baseArgs({ hostBeams })), [], String(drawing));
  }
});

test('【失敗系】roofFramingPrimitives: region が空・undefined・null なら空。陸屋根・棟違いの region は線を持たない', () => {
  for (const regions of [[], undefined, null]) {
    assert.deepEqual(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions })), []);
  }
  for (const shape of ['flat', 'staggered']) {
    const region = { ...gableRegion, shape };
    assert.deepEqual(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ regions: [region] })), [], shape);
  }
});

test('【失敗系】roofFramingPrimitives: 幅が不正（0・負・NaN・未指定）は RangeError', () => {
  for (const bad of [0, -120, NaN, undefined]) {
    assert.throws(() => roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ ridgeWidthMm: bad })), RangeError, `ridge ${bad}`);
    assert.throws(() => roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ purlinWidthMm: bad })), RangeError, `purlin ${bad}`);
  }
  assert.throws(() => roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ purlinPitchMm: 0 })), RangeError, 'ピッチ 0');
  assert.throws(() => roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ purlinStartOffsetsMm: [] })), RangeError, '候補が空');
  assert.throws(() => roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD, baseArgs({ purlinPitchMm: undefined })), RangeError, 'ピッチなし');
});

test('showRoofFraming: 在来木造の略図以外だけ true。ROOF_FRAMING_DASH は中心線と同じ一点鎖線 [12,4,2,4]', () => {
  assert.equal(showRoofFraming(WOOD_DRAWING, LodLevel.STANDARD), true);
  assert.equal(showRoofFraming(WOOD_DRAWING, LodLevel.DETAIL), true);
  assert.equal(showRoofFraming(WOOD_DRAWING, LodLevel.SCHEMATIC), false);
  for (const key of NON_TRADITIONAL_KEYS) assert.equal(showRoofFraming(rulesFor(key).drawing, LodLevel.DETAIL), false, key);
  assert.deepEqual([...ROOF_FRAMING_DASH], [12, 4, 2, 4]);
});

test('roofFramingWidths: 在来木造は棟木120・母屋90。framing が無い（非在来）・断面がカタログに無いときは null', () => {
  assert.deepEqual(roofFramingWidths(WOOD_FRAMING), { ridgeWidthMm: 120, purlinWidthMm: 90 });
  for (const key of NON_TRADITIONAL_KEYS) assert.equal(roofFramingWidths(rulesFor(key).framing), null, key);
  assert.equal(roofFramingWidths(undefined), null);
  assert.equal(roofFramingWidths({ ...WOOD_FRAMING, ridgeSection: 'NO-SUCH' }), null);
  assert.equal(roofFramingWidths({ ...WOOD_FRAMING, purlinSection: 'NO-SUCH' }), null);
});

test('roofFramingHostMembers: role primary かつ材種が主構造の梁だけを芯々（axisValue・clStart/clEnd の effectiveValue）で写す。床梁・小梁・基礎梁・他材種は除く', () => {
  const beam = (over) => ({
    role: 'primary', materialType: 'WOOD', isVertical: false, axisValue: -3640,
    clStart: { effectiveValue: 7280 }, clEnd: { effectiveValue: 0 }, ...over,
  });
  const beams = [
    beam({}),
    beam({ role: 'floor', axisValue: 1 }),
    beam({ role: 'secondary', axisValue: 2 }),
    beam({ role: 'foundation', axisValue: 3 }),
    beam({ role: 'eaves', axisValue: 4 }),
    beam({ materialType: 'STEEL', axisValue: 5 }),
    beam({ isVertical: true, axisValue: 910, clStart: { effectiveValue: -12614 }, clEnd: { effectiveValue: -3640 } }),
  ];
  assert.deepEqual(roofFramingHostMembers(beams, 'WOOD'), [
    { isVertical: false, axis: -3640, lo: 0, hi: 7280 },
    { isVertical: true, axis: 910, lo: -12614, hi: -3640 },
  ]);
  assert.deepEqual(roofFramingHostMembers(undefined, 'WOOD'), []);
});

test('【C2a】roofFramingHostMembers: 小屋梁（role roofBeam）は横架材に含める（ユーザー裁定2026-10-02）。材種が主構造でない小屋梁・他role（床梁・小梁・土台）は引き続き除く', () => {
  const beam = (over) => ({
    role: 'primary', materialType: 'WOOD', isVertical: false, axisValue: -3640,
    clStart: { effectiveValue: 0 }, clEnd: { effectiveValue: 7280 }, ...over,
  });
  const beams = [
    beam({ role: 'roofBeam', isVertical: true, axisValue: 1820, clStart: { effectiveValue: -3640 }, clEnd: { effectiveValue: 0 } }),
    beam({ role: 'roofBeam', materialType: 'STEEL', axisValue: 9 }),
    beam({ role: 'sill', axisValue: 8 }),
    beam({ role: 'floor', axisValue: 7 }),
    beam({ role: 'secondary', axisValue: 6 }),
  ];
  assert.deepEqual(roofFramingHostMembers(beams, 'WOOD'), [{ isVertical: true, axis: 1820, lo: -3640, hi: 0 }]);
  assert.deepEqual(roofFramingHostMembers([beam({}), beams[0]], 'WOOD').length, 2, 'primaryと小屋梁が並ぶ');
});

test('【C2a】roofFramingHostMembers → roofFramingPrimitives: 小屋梁の上には（大梁と同じく）束が立つ', () => {
  const mk = role => ({
    role, materialType: 'WOOD', isVertical: false, axisValue: -3640,
    clStart: { effectiveValue: 0 }, clEnd: { effectiveValue: 7280 },
  });
  const count = role => kindOf(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD,
    baseArgs({ hostBeams: roofFramingHostMembers([mk(role)], 'WOOD') })), 'strut').length;
  assert.equal(count('roofBeam'), count('primary'), '小屋梁は大梁と同数の束が立つ');
  assert.ok(count('roofBeam') > 0);
});

test('【C2a】beamDepthMarks: 小屋梁（role roofBeam）の非正角材は他の梁と同じく標記される（寸法標記を出す裁定）。基礎梁だけが対象外のまま', () => {
  const [mark] = beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ role: 'roofBeam', sectionDefId: 'WOOD-120x210' })]);
  assert.ok(mark, '小屋梁にも標記が出る');
  assert.equal(mark.label.text, '120×210');
  assert.deepEqual(beamDepthMarks(WOOD_DRAWING, LodLevel.STANDARD, [makeBeam({ role: 'foundation' })]), []);
});

test('roofFramingHostMembers → roofFramingPrimitives: 床梁（role floor）の上には束が立たない（呼び出し側の絞り込み）', () => {
  const mk = role => ({
    role, materialType: 'WOOD', isVertical: false, axisValue: -3640,
    clStart: { effectiveValue: 0 }, clEnd: { effectiveValue: 7280 },
  });
  const count = role => kindOf(roofFramingPrimitives(WOOD_DRAWING, LodLevel.STANDARD,
    baseArgs({ hostBeams: roofFramingHostMembers([mk(role)], 'WOOD') })), 'strut').length;
  assert.equal(count('primary'), 7);
  assert.equal(count('floor'), 0);
});
