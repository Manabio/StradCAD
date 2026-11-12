// 基礎伏図／1階伏図の見せ分け（structSlotView → SceneLayers → StructuralLayer／MemberTagLayer の slotView）の配線テスト。
// .jsx は node:test から単体 import できないためソース走査で固定する。判定は structuralClassification.js C 節の述語だけ
// （レンダラに role 名・主構造名の比較を書かない）。コメント（行・ブロック・JSX コメント）は
// uiBusySourceScan.js の stripCommentsKeepStrings で落としてから照合する（コメント文への誤マッチで変異を見逃さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, stripCommentsKeepStrings } from '../uiBusySourceScan.js';

const code = (rel) => stripCommentsKeepStrings(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));
const count = (text, needle) => text.split(needle).length - 1;

const app = stripCommentsKeepStrings(readAppSrc());
const scene = code('SceneLayers.jsx');
const layer = code('StructuralLayer.jsx');
const tags = code('MemberTagLayer.jsx');

test('【配線】App.jsx: 選択中スロットから resolveSharedPlaneView で視点を作り、SceneLayers へ structSlotView として渡す', () => {
  assert.equal(count(app, 'resolveSharedPlaneView('), 1);
  assert.match(app, /const structSlotView = structSlots\s*\?\s*resolveSharedPlaneView\(structSlots\.find\(s => s\.key === activeStructSlot\) \?\? null, structSlots, structComposition\?\.subjectPlane\?\.id \?\? null\)\s*:\s*null;/);
  assert.equal(count(app, 'structSlotView={structSlotView}'), 1);
});

test('【配線】SceneLayers.jsx: StructuralLayer と MemberTagLayer の両方へ slotView を渡す', () => {
  assert.equal(count(scene, 'slotView={structSlotView ?? null}'), 2);
  const sl = scene.slice(scene.indexOf('<StructuralLayer'), scene.indexOf('<MemberTagLayer'));
  assert.ok(sl.includes('slotView={structSlotView ?? null}'), 'StructuralLayer 側');
  const tg = scene.slice(scene.indexOf('<MemberTagLayer'));
  assert.ok(tg.includes('slotView={structSlotView ?? null}'), 'MemberTagLayer 側');
});

test('【配線】StructuralLayer.jsx: 柱・ベース帯・footing・梁帯・非正角標記・スラブ・壁・小屋組が述語を通る', () => {
  assert.match(layer, /slotView = null \}\) => \{/);
  assert.match(layer, /const columnGroups = sharedPlaneDrawsKind\(slotView, MEMBER_KIND\.COLUMN\) \? framingColumnGroups\(figureRules\.drawing\) : \[\];/);
  assert.match(layer, /\{woodFoundation && sharedPlaneDrawsKind\(slotView, MEMBER_KIND\.FOUNDATION_BEAM\) && \(/);
  assert.match(layer, /\(footing\?\.graph\?\.footings \?\? \[\]\)\.filter\(f => sharedPlaneDrawsMember\(slotView, 'footingMap', f\)\)\.map\(/);
  assert.match(layer, /const visibleBeamSpans = beamDrawSpans\.filter\(s => sharedPlaneDrawsMember\(slotView, 'beamMap', s\.beam\)\);/);
  assert.equal(count(layer, '{visibleBeamSpans.flatMap('), 1, '梁帯（当たり図形を含む）');
  assert.match(layer, /beamDepthMarks\(figureRules\.drawing, lod, visibleBeamSpans\.map\(/);
  assert.match(layer, /\(slab\?\.graph\?\.slabs \?\? \[\]\)\.filter\(s => sharedPlaneDrawsMember\(slotView, 'slabMap', s\)\)\.flatMap\(/);
  assert.match(layer, /\(wall\?\.graph\?\.structuralWalls \?\? \[\]\)\.filter\(w => sharedPlaneDrawsMember\(slotView, 'wallMap', w\)\)\.flatMap\(/);
  assert.match(layer, /\{roofFramingPrims\.length > 0 && sharedPlaneDrawsRoofFraming\(slotView\) && \(/);
  assert.equal(count(layer, 'sharedPlaneDrawsKind(slotView, MEMBER_KIND.BEAM)'), 0, '小屋組を BEAM 種別へ写像しない');
});

test('【配線】StructuralLayer.jsx: 絞らないもの（全梁の基礎梁判定・選択強調・開口の×・交点処理）は今のまま', () => {
  assert.match(layer, /const foundationBeams = \(beam\?\.graph\?\.beams \?\? \[\]\)\.filter\(b => b\.role === 'foundation'\);/);
  assert.ok(!/foundationBeams[^\n]*sharedPlane/.test(layer), 'foundationBeams は絞り込み前の全梁');
  assert.match(layer, /beams:\s+beamDrawSpans\.map\(/, '選択強調は絞らない');
  assert.ok(!/beams:\s+visibleBeamSpans/.test(layer));
  assert.match(layer, /const junctionInput = baseSpans\.map\(/, '交点処理の入力は全梁（baseSpans 由来。見せ分けで絞らない）');
  assert.equal(count(layer, 'resolveBeamJunctionSpans(figureRules.drawing, junctionInput,'), 2, '交点処理は全梁を入力に大梁・土台の2回');
  assert.match(layer, /openingCrossSegments\(components, beam\.graph\.beams,/, '開口の×は全梁');
  assert.equal(count(layer, 'visibleBeamSpans'), 4, '定義1＋基礎梁の外形の入力1＋梁帯1＋非正角標記1だけ（他へ広げない）');
});

test('【配線】StructuralLayer.jsx: 基礎梁の外形（unionBandOutline）は 1 か所・見せ分けで描く基礎梁だけを入力にし・woodFoundation の内側・梁の Group の内側で描く', () => {
  assert.equal(count(layer, 'unionBandOutline('), 1, '呼び出しは 1 か所（梁ごとに呼ばない）');
  assert.match(layer, /import \{ unionBandOutline, segmentsMinusGaps, foundationBandInputs \} from '\.\.\/structural\/bandOutline\.js';/);
  assert.match(layer, /const foundationBeamIds = new Set\(foundationBeams\.map\(b => b\.id\)\);/);
  assert.match(layer, /const foundationBands = woodFoundation\s*\?\s*foundationBandInputs\(\s*visibleBeamSpans\.filter\(\(\{ beam: b \}\) => foundationBeamIds\.has\(b\.id\) && !b\.isPinJoint\),\s*b => beamRenderWidth\(b, lod\),\s*\)/,
    '入力は visibleBeamSpans（絞り込み後）由来・基礎梁の id・woodFoundation の内側。幅は beamRenderWidth（null＝単線LODは純関数が除く）');
  assert.ok(!/unionBandOutline\(beamDrawSpans/.test(layer) && !/foundationBands = [^;]*beamDrawSpans/.test(layer), '入力に絞り込み前の beamDrawSpans を使わない');
  assert.match(layer, /const foundationOutlines = foundationBands\.length > 0 \? unionBandOutline\(foundationBands\) : null;/);
  // 写像・区間の引き算は純モジュールへ移した（.jsx の中に写しを置かない）
  assert.ok(!/function segmentsMinusGaps|half: beamRenderWidth/.test(layer), 'segmentsMinusGaps・帯の入力の写像は structural/bandOutline.js にだけある');
  // 描画: 梁ごとの wrapPick（＝ beam-symbol の Group）の中で、帯の2本線（bandLines）より前に分岐する
  const iOutline = layer.indexOf('const outlineSegments = foundationOutlines?.get(b.id);');
  const iBand = layer.indexOf('...bandLines(`beam:${b.id}`');
  assert.ok(iOutline > 0 && iBand > iOutline, '外形の分岐が bandLines より前');
  const branch = layer.slice(iOutline, iBand);
  assert.match(branch, /if \(outlineSegments\) \{\s*return wrapPick\(\[/);
  assert.ok(branch.includes('stroke={color} strokeWidth={medium} dash={beamDash} {...pickShapeProps}'));
  assert.ok(branch.includes('...jointMarks,'));
});

test('【配線】StructuralLayer.jsx: 土台は大梁と別の組で解く（2 回目は role: BeamRole.SILL, crossings: true・eaveCorners を渡さない）。gaps が梁の帯の segments に効く', () => {
  assert.match(layer, /\.\.\.resolveBeamJunctionSpans\(figureRules\.drawing, junctionInput, \{ role: BeamRole\.SILL, crossings: true \}\),/);
  assert.match(layer, /const junctions = new Map\(\[\s*\.\.\.resolveBeamJunctionSpans\(figureRules\.drawing, junctionInput, \{ eaveCorners \}\),/);
  assert.match(layer, /\{ beam: s\.beam, coord1: j\.coord1, coord2: j\.coord2, ends: j\.ends, gaps: j\.gaps \}/, 'beamDrawSpans が gaps を通す');
  assert.match(layer, /visibleBeamSpans\.flatMap\(\(\{ beam: b, coord1, coord2, ends, gaps \}\) => \{/);
  assert.match(layer, /\.\.\.bandLines\(`beam:\$\{b\.id\}`, b\.isVertical, b\.axisValue, width \/ 2, segmentsMinusGaps\(lo, hi, gaps \?\? \[\]\), /, 'gaps を segments から引く');
  assert.match(layer, /return segmentsMinusGaps\(lo, hi, gaps\);/, '耐力壁（wallSegments）も同じ segmentsMinusGaps で開口を引く');
  assert.match(layer, /import \{ BeamRole, CAUTION_COLOR,/);
  // 非正角標記・選択強調（beams: beamDrawSpans.map(...)）は gaps を読まない
  assert.ok(!/beamDepthMarks\([^;]*gaps/.test(layer), '非正角標記の入力が gaps を読んでいる');
});

test('【配線】両レイヤ: 述語を迂回する slotView 直読み・スロット種別の比較を足していない', () => {
  for (const [name, text] of [['StructuralLayer', layer], ['MemberTagLayer', tags]]) {
    assert.ok(!/slotView\??\.(figureType|slotKey|planeId)/.test(text), `${name}: slotView の中身を直読みしている`);
    assert.ok(!/SLOT_TYPE|FIGURE_TYPE/.test(text), `${name}: スロット種別・図面種別の定数を使っている`);
  }
});

test('【配線】両レイヤ: role 名の比較は今の数のまま（StructuralLayer の基礎梁判定 1 件だけ。今回の差分で増やしていない）', () => {
  const n = (text, re) => (text.match(re) ?? []).length;
  assert.equal(n(layer, /\.role ===/g), 1, 'StructuralLayer: .role ===（foundationBeams の基礎梁判定）');
  assert.equal(n(layer, /\.role !==/g), 0, 'StructuralLayer: .role !==');
  assert.equal(n(tags, /\.role ===/g), 0, 'MemberTagLayer: .role ===');
  assert.equal(n(tags, /\.role !==/g), 0, 'MemberTagLayer: .role !==');
  for (const lit of ["'sill'", "'mat_foundation'", "'roofBeam'"]) {
    assert.equal(count(layer, lit), 0, `StructuralLayer: ${lit}`);
    assert.equal(count(tags, lit), 0, `MemberTagLayer: ${lit}`);
  }
  // 数え方が空振りでない（読み込んだ本文に比較・リテラルを数える対象が実在する）
  assert.ok(layer.includes("b.role === 'foundation'"), 'StructuralLayer の本文が読めている');
});

test('【配線】MemberTagLayer.jsx: 柱・フーチング・梁・壁・スラブの 5 種のタグ列すべてが述語を通る（filter の式全体を固定）', () => {
  assert.match(tags, /project, onTagClick, onStatusMenuRequest, slotView = null \}\) => \{/);
  assert.match(tags, /pointTags\(\(columnGraph\?\.columns \?\? \[\]\)\.filter\(e => sharedPlaneDrawsMember\(slotView, 'columnMap', e\)\), 'columnMap',/);
  assert.match(tags, /pointTags\(\(footingGraph\?\.footings \?\? \[\]\)\.filter\(e => sharedPlaneDrawsMember\(slotView, 'footingMap', e\)\), 'footingMap',/);
  assert.match(tags, /\(beamGraph\?\.beams \?\? \[\]\)\.filter\(b => !\(lod === LodLevel\.SCHEMATIC && PIN_ROLES\.has\(b\.role\)\) && sharedPlaneDrawsMember\(slotView, 'beamMap', b\)\),\s*'beamMap',/);
  assert.match(tags, /axisTags\(\(wallGraph\?\.structuralWalls \?\? \[\]\)\.filter\(e => sharedPlaneDrawsMember\(slotView, 'wallMap', e\)\), 'wallMap',/);
  assert.match(tags, /slabTags\(\(slabGraph\?\.slabs \?\? \[\]\)\.filter\(e => sharedPlaneDrawsMember\(slotView, 'slabMap', e\)\), 'slabMap'\)/);
  assert.equal(count(tags, 'sharedPlaneDrawsMember('), 5);
});
