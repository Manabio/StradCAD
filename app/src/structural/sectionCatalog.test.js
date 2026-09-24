// structural/sectionCatalog.js の単体テスト（overlayを立てない経路）。
// overlayを立てる系（setOverlay/clearOverlays）はsectionCatalog.overlay.test.js
// （node:testはファイル単位で別プロセスのため、overlay汚染を避けて専用ファイルに分ける。
// catalogRegistry.overlay.test.js / core/room.overlay.test.js と同じ方針）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Project, CenterLineType, Discipline, StructuralMaterialType } from '../core.js';
import {
  findSectionEntry, woodRectSectionKey, sectionList, SECTION_CATALOG,
  parseSectionSpec, parseSectionSpecList,
} from './sectionCatalog.js';
import { recomputeStructuralForGraph } from './structuralRecompute.js';

test('findSectionEntry: 未知キーはnull', () => {
  assert.equal(findSectionEntry('NO-SUCH-KEY'), null);
  assert.equal(findSectionEntry(null), null);
  assert.equal(findSectionEntry(undefined), null);
});

test('findSectionEntry: overlay空ならSECTION_CATALOGの要素と同一参照（===）を返す（composeCatalogがコピーしない）', () => {
  const builtinEntry = SECTION_CATALOG.find(s => s.key === 'WOOD-120x120');
  assert.ok(builtinEntry, 'WOOD-120x120がSECTION_CATALOGに無い');
  assert.equal(findSectionEntry('WOOD-120x120'), builtinEntry);
});

test('woodRectSectionKey: overlay空ならカタログに無い組み合わせはnull・あるものはキーを返す', () => {
  assert.equal(woodRectSectionKey(120, 120), 'WOOD-120x120');
  assert.equal(woodRectSectionKey(120, 999), null, '存在しない成はnull');
  assert.equal(woodRectSectionKey(999, 120), null, '存在しない幅はnull');
});

test('sectionList: overlay空ならSECTION_CATALOGと同じ要素・同じ順序（===同一性）', () => {
  const list = sectionList();
  assert.equal(list.length, SECTION_CATALOG.length);
  for (let i = 0; i < SECTION_CATALOG.length; i++) {
    assert.equal(list[i], SECTION_CATALOG[i], `index ${i} の要素が同一参照でない`);
  }
});

// ---- 失敗系: 未知のsectionDefIdを持つ部材でも既定300へ落ち、構造再計算は例外を投げない ----
test('【失敗系】未知のsectionDefIdを持つ梁はsectionWidthが既定300へ落ち、recomputeStructuralForGraphは例外を投げない', async () => {
  const project = new Project('proj-unknown-section', 'test');
  const { graph } = project.addPlane(0, '1階', 'p1');
  graph.structureOverride = 'S造'; // S造はwallBeamAxes/framingが無く下階peekが要らないため最小構成で足りる

  const x0 = graph.addCenterLine(CenterLineType.VERTICAL, 0,    { labeled: true, discipline: Discipline.STRUCT });
  const x1 = graph.addCenterLine(CenterLineType.VERTICAL, 4000, { labeled: true, discipline: Discipline.STRUCT });
  const y0 = graph.addCenterLine(CenterLineType.HORIZONTAL, 0,    { labeled: true, discipline: Discipline.STRUCT });

  const beam = graph.addBeam(StructuralMaterialType.STEEL, 'STEEL-NO-SUCH-KEY', y0, false, x0, x1, { role: 'primary' });
  assert.equal(beam.sectionWidth, 300, '未知のsectionDefIdはsectionWidthの既定300へ落ちる');

  await assert.doesNotReject(
    () => recomputeStructuralForGraph(graph, project, 'S造'),
    '未知のsectionDefIdがあってもrecomputeStructuralForGraphは例外を投げない',
  );
});

// ---- wiring: MemberListTab.jsx がSECTION_CATALOGを直参照せずsectionList()を使う ----
test('【不変条件・ステップ8e】MemberListTab.jsx: 断面プルダウンの選択肢はSECTION_CATALOGを直参照せずsectionList()を使う', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8');
  assert.ok(!/\bSECTION_CATALOG\b/.test(src), 'MemberListTab.jsxがSECTION_CATALOGを直参照している');
  assert.ok(/\bsectionList\(\)/.test(src), 'MemberListTab.jsxがsectionList()を呼んでいない');
});

// ================================================================
// parseSectionSpec / parseSectionSpecList（ステップ8i・規格文字列の一括入力）
// ================================================================

test('parseSectionSpec: H形鋼（成×幅×ウェブ厚×フランジ厚）', () => {
  assert.deepEqual(parseSectionSpec('H300×150×6.5×9'), {
    key: 'STEEL-H300x150', materialType: 'STEEL', shape: 'hSection',
    width: 150, height: 300, webThickness: 6.5, flangeThickness: 9,
    label: 'H-300×150×6.5×9',
  });
});

test('parseSectionSpec: 角形鋼管（辺×辺×板厚）。板厚はキー・ラベルとも入力の文字列表現を保つ', () => {
  assert.deepEqual(parseSectionSpec('□200×200×9.0'), {
    key: 'STEEL-SQ200x200x9.0', materialType: 'STEEL', shape: 'squarePipe',
    width: 200, height: 200, wallThickness: 9,
    label: '□-200×200×9.0',
  });
});

test('parseSectionSpec: 区切り x / X・前後の空白を許容する', () => {
  assert.deepEqual(parseSectionSpec('  h400 x 200 x 8 x 13  '), parseSectionSpec('H400×200×8×13'));
  assert.deepEqual(parseSectionSpec('□250X250X9'), parseSectionSpec('□250×250×9'));
});

test('parseSectionSpec: 全角数字・全角×も許容する（toHalfWidthで正規化）', () => {
  assert.deepEqual(parseSectionSpec('Ｈ３００×１５０×６.５×９'), parseSectionSpec('H300×150×6.5×9'));
});

// ---- ステップ14-S: 接頭辞直後のハイフンは規格接頭辞の区切り（寸法の符号ではない） ----
test('parseSectionSpec: H直後のハイフン（アプリ自身が呼称に使う"H-…"形式）は区切りとして読み飛ばし、ハイフン無しと同じエントリになる', () => {
  assert.deepEqual(parseSectionSpec('H-250×125×6×9'), parseSectionSpec('H250×125×6×9'));
  assert.deepEqual(parseSectionSpec('H-250×125×6×9'), {
    key: 'STEEL-H250x125', materialType: 'STEEL', shape: 'hSection',
    width: 125, height: 250, webThickness: 6, flangeThickness: 9,
    label: 'H-250×125×6×9',
  });
});

test('parseSectionSpec: □直後のハイフンも区切りとして読み飛ばし、ハイフン無しと同じエントリになる', () => {
  assert.deepEqual(parseSectionSpec('□-200×200×9'), parseSectionSpec('□200×200×9'));
  assert.deepEqual(parseSectionSpec('□-200×200×9'), {
    key: 'STEEL-SQ200x200x9', materialType: 'STEEL', shape: 'squarePipe',
    width: 200, height: 200, wallThickness: 9,
    label: '□-200×200×9',
  });
});

test('parseSectionSpec: 全角ハイフン（－）・全角ー（長音記号）も接頭辞直後の区切りとして読み飛ばす', () => {
  assert.deepEqual(parseSectionSpec('H－250×125×6×9'), parseSectionSpec('H250×125×6×9'));
  assert.deepEqual(parseSectionSpec('Hー250×125×6×9'), parseSectionSpec('H250×125×6×9'));
});

// ---- 失敗系 ----
test('【失敗系】parseSectionSpec: 空文字・空白のみは例外', () => {
  assert.throws(() => parseSectionSpec(''), /空です/);
  assert.throws(() => parseSectionSpec('   '), /空です/);
});

test('【失敗系】parseSectionSpec: 桁欠け（H形鋼が3項目）は例外', () => {
  assert.throws(() => parseSectionSpec('H300×150×6.5'), /4項目が必要/);
});

test('【失敗系】parseSectionSpec: 桁欠け（角形鋼管が2項目）は例外', () => {
  assert.throws(() => parseSectionSpec('□200×200'), /3項目が必要/);
});

test('【失敗系】parseSectionSpec: 数値でない項目は例外', () => {
  assert.throws(() => parseSectionSpec('H300×abc×6.5×9'), /数値でない項目/);
});

test('【失敗系】parseSectionSpec: 未知の記号（H/□以外で始まる）は例外', () => {
  assert.throws(() => parseSectionSpec('△100×100×10'), /未対応の断面記号/);
});

// ---- ステップ14-S: 0以下の寸法は例外（負号は接頭辞直後以外の項目では通常の符号として読む） ----
test('【失敗系】parseSectionSpec: H形鋼の幅が負（H250×-125×6×9）は例外', () => {
  assert.throws(() => parseSectionSpec('H250×-125×6×9'), /0以下の寸法があります/);
});

test('【失敗系】parseSectionSpec: H形鋼の成が0（H0×125×6×9）は例外', () => {
  assert.throws(() => parseSectionSpec('H0×125×6×9'), /0以下の寸法があります/);
});

test('【失敗系】parseSectionSpec: 角形鋼管の板厚が0（□200×200×0）は例外', () => {
  assert.throws(() => parseSectionSpec('□200×200×0'), /0以下の寸法があります/);
});

test('【失敗系】parseSectionSpec: 文字列以外は例外', () => {
  assert.throws(() => parseSectionSpec(null), /不正です/);
  assert.throws(() => parseSectionSpec(undefined), /不正です/);
});

// ---- parseSectionSpecList ----
test('parseSectionSpecList: " / " 区切りで複数件を解析する', () => {
  const { entries, errors } = parseSectionSpecList('H400×200×8×13 / □250×250×9');
  assert.equal(errors.length, 0);
  assert.deepEqual(entries.map(e => e.key), ['STEEL-H400x200', 'STEEL-SQ250x250x9']);
});

test('parseSectionSpecList: 改行・カンマ区切りも許容する', () => {
  const { entries, errors } = parseSectionSpecList('H400×200×8×13\n□250×250×9,H300×150×6.5×9');
  assert.equal(errors.length, 0);
  assert.deepEqual(entries.map(e => e.key), ['STEEL-H400x200', 'STEEL-SQ250x250x9', 'STEEL-H300x150']);
});

test('【失敗系】parseSectionSpecList: 失敗した行は捨てず理由付きで返し、他行の解析は継続する', () => {
  const { entries, errors } = parseSectionSpecList('H400×200×8×13 / bogus / □250×250×9');
  assert.deepEqual(entries.map(e => e.key), ['STEEL-H400x200', 'STEEL-SQ250x250x9']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 'bogus');
  assert.match(errors[0].reason, /未対応の断面記号/);
});

test('parseSectionSpecList: 空文字・空白行は無視する（エラーにもしない）', () => {
  const { entries, errors } = parseSectionSpecList('H400×200×8×13 /  / \n\n□250×250×9');
  assert.equal(entries.length, 2);
  assert.equal(errors.length, 0);
});

test('parseSectionSpecList: 空・未指定は entries/errors とも空', () => {
  assert.deepEqual(parseSectionSpecList(''), { entries: [], errors: [] });
  assert.deepEqual(parseSectionSpecList(undefined), { entries: [], errors: [] });
});

// ================================================================
// SECTION_CATALOG 同値固定（ステップ8i・変更前=2026-09-23時点のbuildHSections/buildSquarePipes
// 直書き実装の出力をJSONで固定。buildHSections/buildSquarePipesをparseSectionSpec経由へ
// 書き直した後も、この115件・全項目・順序が1件も変わらないことを固定する）。
// ================================================================
const SECTION_CATALOG_GOLDEN = [{"key":"WOOD-90x90","materialType":"WOOD","shape":"rect","width":90,"height":90,"label":"90×90"},{"key":"WOOD-90x120","materialType":"WOOD","shape":"rect","width":90,"height":120,"label":"90×120"},{"key":"WOOD-90x150","materialType":"WOOD","shape":"rect","width":90,"height":150,"label":"90×150"},{"key":"WOOD-90x180","materialType":"WOOD","shape":"rect","width":90,"height":180,"label":"90×180"},{"key":"WOOD-90x210","materialType":"WOOD","shape":"rect","width":90,"height":210,"label":"90×210"},{"key":"WOOD-90x240","materialType":"WOOD","shape":"rect","width":90,"height":240,"label":"90×240"},{"key":"WOOD-90x270","materialType":"WOOD","shape":"rect","width":90,"height":270,"label":"90×270"},{"key":"WOOD-90x300","materialType":"WOOD","shape":"rect","width":90,"height":300,"label":"90×300"},{"key":"WOOD-90x330","materialType":"WOOD","shape":"rect","width":90,"height":330,"label":"90×330"},{"key":"WOOD-90x360","materialType":"WOOD","shape":"rect","width":90,"height":360,"label":"90×360"},{"key":"WOOD-105x105","materialType":"WOOD","shape":"rect","width":105,"height":105,"label":"105×105"},{"key":"WOOD-105x120","materialType":"WOOD","shape":"rect","width":105,"height":120,"label":"105×120"},{"key":"WOOD-105x150","materialType":"WOOD","shape":"rect","width":105,"height":150,"label":"105×150"},{"key":"WOOD-105x180","materialType":"WOOD","shape":"rect","width":105,"height":180,"label":"105×180"},{"key":"WOOD-105x210","materialType":"WOOD","shape":"rect","width":105,"height":210,"label":"105×210"},{"key":"WOOD-105x240","materialType":"WOOD","shape":"rect","width":105,"height":240,"label":"105×240"},{"key":"WOOD-105x270","materialType":"WOOD","shape":"rect","width":105,"height":270,"label":"105×270"},{"key":"WOOD-105x300","materialType":"WOOD","shape":"rect","width":105,"height":300,"label":"105×300"},{"key":"WOOD-105x330","materialType":"WOOD","shape":"rect","width":105,"height":330,"label":"105×330"},{"key":"WOOD-105x360","materialType":"WOOD","shape":"rect","width":105,"height":360,"label":"105×360"},{"key":"WOOD-120x120","materialType":"WOOD","shape":"rect","width":120,"height":120,"label":"120×120"},{"key":"WOOD-120x150","materialType":"WOOD","shape":"rect","width":120,"height":150,"label":"120×150"},{"key":"WOOD-120x180","materialType":"WOOD","shape":"rect","width":120,"height":180,"label":"120×180"},{"key":"WOOD-120x210","materialType":"WOOD","shape":"rect","width":120,"height":210,"label":"120×210"},{"key":"WOOD-120x240","materialType":"WOOD","shape":"rect","width":120,"height":240,"label":"120×240"},{"key":"WOOD-120x270","materialType":"WOOD","shape":"rect","width":120,"height":270,"label":"120×270"},{"key":"WOOD-120x300","materialType":"WOOD","shape":"rect","width":120,"height":300,"label":"120×300"},{"key":"WOOD-120x330","materialType":"WOOD","shape":"rect","width":120,"height":330,"label":"120×330"},{"key":"WOOD-120x360","materialType":"WOOD","shape":"rect","width":120,"height":360,"label":"120×360"},{"key":"STEEL-H100x100","materialType":"STEEL","shape":"hSection","width":100,"height":100,"webThickness":6,"flangeThickness":8,"label":"H-100×100×6×8"},{"key":"STEEL-H125x125","materialType":"STEEL","shape":"hSection","width":125,"height":125,"webThickness":6.5,"flangeThickness":9,"label":"H-125×125×6.5×9"},{"key":"STEEL-H148x100","materialType":"STEEL","shape":"hSection","width":100,"height":148,"webThickness":6,"flangeThickness":9,"label":"H-148×100×6×9"},{"key":"STEEL-H150x150","materialType":"STEEL","shape":"hSection","width":150,"height":150,"webThickness":7,"flangeThickness":10,"label":"H-150×150×7×10"},{"key":"STEEL-H175x175","materialType":"STEEL","shape":"hSection","width":175,"height":175,"webThickness":7.5,"flangeThickness":11,"label":"H-175×175×7.5×11"},{"key":"STEEL-H194x150","materialType":"STEEL","shape":"hSection","width":150,"height":194,"webThickness":6,"flangeThickness":9,"label":"H-194×150×6×9"},{"key":"STEEL-H200x100","materialType":"STEEL","shape":"hSection","width":100,"height":200,"webThickness":5.5,"flangeThickness":8,"label":"H-200×100×5.5×8"},{"key":"STEEL-H200x200","materialType":"STEEL","shape":"hSection","width":200,"height":200,"webThickness":8,"flangeThickness":12,"label":"H-200×200×8×12"},{"key":"STEEL-H244x175","materialType":"STEEL","shape":"hSection","width":175,"height":244,"webThickness":7,"flangeThickness":11,"label":"H-244×175×7×11"},{"key":"STEEL-H250x250","materialType":"STEEL","shape":"hSection","width":250,"height":250,"webThickness":9,"flangeThickness":14,"label":"H-250×250×9×14"},{"key":"STEEL-H294x200","materialType":"STEEL","shape":"hSection","width":200,"height":294,"webThickness":8,"flangeThickness":12,"label":"H-294×200×8×12"},{"key":"STEEL-H300x150","materialType":"STEEL","shape":"hSection","width":150,"height":300,"webThickness":6.5,"flangeThickness":9,"label":"H-300×150×6.5×9"},{"key":"STEEL-H300x300","materialType":"STEEL","shape":"hSection","width":300,"height":300,"webThickness":10,"flangeThickness":15,"label":"H-300×300×10×15"},{"key":"STEEL-H340x250","materialType":"STEEL","shape":"hSection","width":250,"height":340,"webThickness":9,"flangeThickness":14,"label":"H-340×250×9×14"},{"key":"STEEL-H344x300","materialType":"STEEL","shape":"hSection","width":300,"height":344,"webThickness":10,"flangeThickness":16,"label":"H-344×300×10×16"},{"key":"STEEL-H350x175","materialType":"STEEL","shape":"hSection","width":175,"height":350,"webThickness":7,"flangeThickness":11,"label":"H-350×175×7×11"},{"key":"STEEL-H350x350","materialType":"STEEL","shape":"hSection","width":350,"height":350,"webThickness":12,"flangeThickness":19,"label":"H-350×350×12×19"},{"key":"STEEL-H390x300","materialType":"STEEL","shape":"hSection","width":300,"height":390,"webThickness":10,"flangeThickness":16,"label":"H-390×300×10×16"},{"key":"STEEL-H394x400","materialType":"STEEL","shape":"hSection","width":400,"height":394,"webThickness":11,"flangeThickness":18,"label":"H-394×400×11×18"},{"key":"STEEL-H400x200","materialType":"STEEL","shape":"hSection","width":200,"height":400,"webThickness":8,"flangeThickness":13,"label":"H-400×200×8×13"},{"key":"STEEL-H400x400","materialType":"STEEL","shape":"hSection","width":400,"height":400,"webThickness":13,"flangeThickness":21,"label":"H-400×400×13×21"},{"key":"STEEL-H440x300","materialType":"STEEL","shape":"hSection","width":300,"height":440,"webThickness":11,"flangeThickness":18,"label":"H-440×300×11×18"},{"key":"STEEL-H446x199","materialType":"STEEL","shape":"hSection","width":199,"height":446,"webThickness":8,"flangeThickness":12,"label":"H-446×199×8×12"},{"key":"STEEL-H450x200","materialType":"STEEL","shape":"hSection","width":200,"height":450,"webThickness":9,"flangeThickness":14,"label":"H-450×200×9×14"},{"key":"STEEL-H482x300","materialType":"STEEL","shape":"hSection","width":300,"height":482,"webThickness":11,"flangeThickness":15,"label":"H-482×300×11×15"},{"key":"STEEL-H488x300","materialType":"STEEL","shape":"hSection","width":300,"height":488,"webThickness":11,"flangeThickness":18,"label":"H-488×300×11×18"},{"key":"STEEL-H496x199","materialType":"STEEL","shape":"hSection","width":199,"height":496,"webThickness":9,"flangeThickness":14,"label":"H-496×199×9×14"},{"key":"STEEL-H500x200","materialType":"STEEL","shape":"hSection","width":200,"height":500,"webThickness":10,"flangeThickness":16,"label":"H-500×200×10×16"},{"key":"STEEL-H582x300","materialType":"STEEL","shape":"hSection","width":300,"height":582,"webThickness":12,"flangeThickness":17,"label":"H-582×300×12×17"},{"key":"STEEL-H588x300","materialType":"STEEL","shape":"hSection","width":300,"height":588,"webThickness":12,"flangeThickness":20,"label":"H-588×300×12×20"},{"key":"STEEL-H596x199","materialType":"STEEL","shape":"hSection","width":199,"height":596,"webThickness":10,"flangeThickness":15,"label":"H-596×199×10×15"},{"key":"STEEL-H600x200","materialType":"STEEL","shape":"hSection","width":200,"height":600,"webThickness":11,"flangeThickness":17,"label":"H-600×200×11×17"},{"key":"STEEL-H692x300","materialType":"STEEL","shape":"hSection","width":300,"height":692,"webThickness":13,"flangeThickness":20,"label":"H-692×300×13×20"},{"key":"STEEL-H700x300","materialType":"STEEL","shape":"hSection","width":300,"height":700,"webThickness":13,"flangeThickness":24,"label":"H-700×300×13×24"},{"key":"STEEL-H792x300","materialType":"STEEL","shape":"hSection","width":300,"height":792,"webThickness":14,"flangeThickness":22,"label":"H-792×300×14×22"},{"key":"STEEL-H800x300","materialType":"STEEL","shape":"hSection","width":300,"height":800,"webThickness":14,"flangeThickness":26,"label":"H-800×300×14×26"},{"key":"STEEL-H890x299","materialType":"STEEL","shape":"hSection","width":299,"height":890,"webThickness":15,"flangeThickness":23,"label":"H-890×299×15×23"},{"key":"STEEL-H900x300","materialType":"STEEL","shape":"hSection","width":300,"height":900,"webThickness":16,"flangeThickness":28,"label":"H-900×300×16×28"},{"key":"STEEL-SQ50x50x2.3","materialType":"STEEL","shape":"squarePipe","width":50,"height":50,"wallThickness":2.3,"label":"□-50×50×2.3"},{"key":"STEEL-SQ50x50x3.2","materialType":"STEEL","shape":"squarePipe","width":50,"height":50,"wallThickness":3.2,"label":"□-50×50×3.2"},{"key":"STEEL-SQ60x60x2.3","materialType":"STEEL","shape":"squarePipe","width":60,"height":60,"wallThickness":2.3,"label":"□-60×60×2.3"},{"key":"STEEL-SQ60x60x3.2","materialType":"STEEL","shape":"squarePipe","width":60,"height":60,"wallThickness":3.2,"label":"□-60×60×3.2"},{"key":"STEEL-SQ75x75x2.3","materialType":"STEEL","shape":"squarePipe","width":75,"height":75,"wallThickness":2.3,"label":"□-75×75×2.3"},{"key":"STEEL-SQ75x75x3.2","materialType":"STEEL","shape":"squarePipe","width":75,"height":75,"wallThickness":3.2,"label":"□-75×75×3.2"},{"key":"STEEL-SQ90x90x3.2","materialType":"STEEL","shape":"squarePipe","width":90,"height":90,"wallThickness":3.2,"label":"□-90×90×3.2"},{"key":"STEEL-SQ90x90x4.5","materialType":"STEEL","shape":"squarePipe","width":90,"height":90,"wallThickness":4.5,"label":"□-90×90×4.5"},{"key":"STEEL-SQ100x100x3.2","materialType":"STEEL","shape":"squarePipe","width":100,"height":100,"wallThickness":3.2,"label":"□-100×100×3.2"},{"key":"STEEL-SQ100x100x4.5","materialType":"STEEL","shape":"squarePipe","width":100,"height":100,"wallThickness":4.5,"label":"□-100×100×4.5"},{"key":"STEEL-SQ100x100x6.0","materialType":"STEEL","shape":"squarePipe","width":100,"height":100,"wallThickness":6,"label":"□-100×100×6.0"},{"key":"STEEL-SQ125x125x4.5","materialType":"STEEL","shape":"squarePipe","width":125,"height":125,"wallThickness":4.5,"label":"□-125×125×4.5"},{"key":"STEEL-SQ125x125x6.0","materialType":"STEEL","shape":"squarePipe","width":125,"height":125,"wallThickness":6,"label":"□-125×125×6.0"},{"key":"STEEL-SQ150x150x4.5","materialType":"STEEL","shape":"squarePipe","width":150,"height":150,"wallThickness":4.5,"label":"□-150×150×4.5"},{"key":"STEEL-SQ150x150x6.0","materialType":"STEEL","shape":"squarePipe","width":150,"height":150,"wallThickness":6,"label":"□-150×150×6.0"},{"key":"STEEL-SQ150x150x9.0","materialType":"STEEL","shape":"squarePipe","width":150,"height":150,"wallThickness":9,"label":"□-150×150×9.0"},{"key":"STEEL-SQ175x175x6.0","materialType":"STEEL","shape":"squarePipe","width":175,"height":175,"wallThickness":6,"label":"□-175×175×6.0"},{"key":"STEEL-SQ175x175x9.0","materialType":"STEEL","shape":"squarePipe","width":175,"height":175,"wallThickness":9,"label":"□-175×175×9.0"},{"key":"STEEL-SQ200x200x6.0","materialType":"STEEL","shape":"squarePipe","width":200,"height":200,"wallThickness":6,"label":"□-200×200×6.0"},{"key":"STEEL-SQ200x200x9.0","materialType":"STEEL","shape":"squarePipe","width":200,"height":200,"wallThickness":9,"label":"□-200×200×9.0"},{"key":"STEEL-SQ200x200x12.0","materialType":"STEEL","shape":"squarePipe","width":200,"height":200,"wallThickness":12,"label":"□-200×200×12.0"},{"key":"STEEL-SQ250x250x6.0","materialType":"STEEL","shape":"squarePipe","width":250,"height":250,"wallThickness":6,"label":"□-250×250×6.0"},{"key":"STEEL-SQ250x250x9.0","materialType":"STEEL","shape":"squarePipe","width":250,"height":250,"wallThickness":9,"label":"□-250×250×9.0"},{"key":"STEEL-SQ250x250x12.0","materialType":"STEEL","shape":"squarePipe","width":250,"height":250,"wallThickness":12,"label":"□-250×250×12.0"},{"key":"STEEL-SQ300x300x9.0","materialType":"STEEL","shape":"squarePipe","width":300,"height":300,"wallThickness":9,"label":"□-300×300×9.0"},{"key":"STEEL-SQ300x300x12.0","materialType":"STEEL","shape":"squarePipe","width":300,"height":300,"wallThickness":12,"label":"□-300×300×12.0"},{"key":"STEEL-SQ300x300x16.0","materialType":"STEEL","shape":"squarePipe","width":300,"height":300,"wallThickness":16,"label":"□-300×300×16.0"},{"key":"STEEL-SQ350x350x12.0","materialType":"STEEL","shape":"squarePipe","width":350,"height":350,"wallThickness":12,"label":"□-350×350×12.0"},{"key":"STEEL-SQ350x350x16.0","materialType":"STEEL","shape":"squarePipe","width":350,"height":350,"wallThickness":16,"label":"□-350×350×16.0"},{"key":"STEEL-SQ350x350x19.0","materialType":"STEEL","shape":"squarePipe","width":350,"height":350,"wallThickness":19,"label":"□-350×350×19.0"},{"key":"STEEL-SQ400x400x12.0","materialType":"STEEL","shape":"squarePipe","width":400,"height":400,"wallThickness":12,"label":"□-400×400×12.0"},{"key":"STEEL-SQ400x400x16.0","materialType":"STEEL","shape":"squarePipe","width":400,"height":400,"wallThickness":16,"label":"□-400×400×16.0"},{"key":"STEEL-SQ400x400x19.0","materialType":"STEEL","shape":"squarePipe","width":400,"height":400,"wallThickness":19,"label":"□-400×400×19.0"},{"key":"STEEL-SQ400x400x22.0","materialType":"STEEL","shape":"squarePipe","width":400,"height":400,"wallThickness":22,"label":"□-400×400×22.0"},{"key":"STEEL-SQ450x450x16.0","materialType":"STEEL","shape":"squarePipe","width":450,"height":450,"wallThickness":16,"label":"□-450×450×16.0"},{"key":"STEEL-SQ450x450x19.0","materialType":"STEEL","shape":"squarePipe","width":450,"height":450,"wallThickness":19,"label":"□-450×450×19.0"},{"key":"STEEL-SQ450x450x22.0","materialType":"STEEL","shape":"squarePipe","width":450,"height":450,"wallThickness":22,"label":"□-450×450×22.0"},{"key":"STEEL-SQ500x500x16.0","materialType":"STEEL","shape":"squarePipe","width":500,"height":500,"wallThickness":16,"label":"□-500×500×16.0"},{"key":"STEEL-SQ500x500x19.0","materialType":"STEEL","shape":"squarePipe","width":500,"height":500,"wallThickness":19,"label":"□-500×500×19.0"},{"key":"STEEL-SQ500x500x22.0","materialType":"STEEL","shape":"squarePipe","width":500,"height":500,"wallThickness":22,"label":"□-500×500×22.0"},{"key":"STEEL-SQ550x550x19.0","materialType":"STEEL","shape":"squarePipe","width":550,"height":550,"wallThickness":19,"label":"□-550×550×19.0"},{"key":"STEEL-SQ550x550x22.0","materialType":"STEEL","shape":"squarePipe","width":550,"height":550,"wallThickness":22,"label":"□-550×550×22.0"},{"key":"STEEL-SQ600x600x19.0","materialType":"STEEL","shape":"squarePipe","width":600,"height":600,"wallThickness":19,"label":"□-600×600×19.0"},{"key":"STEEL-SQ600x600x22.0","materialType":"STEEL","shape":"squarePipe","width":600,"height":600,"wallThickness":22,"label":"□-600×600×22.0"},{"key":"STEEL-SQ600x600x25.0","materialType":"STEEL","shape":"squarePipe","width":600,"height":600,"wallThickness":25,"label":"□-600×600×25.0"},{"key":"STEEL-PIPE150","materialType":"STEEL","shape":"roundPipe","width":150,"height":150,"wallThickness":6,"label":"φ-150×6"},{"key":"RC-300x300","materialType":"RC","shape":"rect","width":300,"height":300,"label":"RC 300×300"},{"key":"RC-ROUND350","materialType":"RC","shape":"round","width":350,"height":350,"label":"RC丸 φ350"}];

test('【不変条件・ステップ8i】SECTION_CATALOG: buildHSections/buildSquarePipesをparseSectionSpec経由へ書き直した後も115件・全項目・順序が1件も変わらない（変更前=直書き実装の出力をJSONで固定）', () => {
  assert.equal(SECTION_CATALOG.length, 115);
  assert.deepEqual(SECTION_CATALOG, SECTION_CATALOG_GOLDEN);
});
