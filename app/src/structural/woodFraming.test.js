// woodFraming.js（在来木造の梁成表・下地割付・袖材・玄関開口・火打ち条件）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomFeature } from '../core/constants.js';
import {
  woodBeamDepthMm, woodBeamSectionKey, studPositions, studSpec, openingJambSpec, entranceOpeningWidthMm, hipBraceAllowed,
} from './woodFraming.js';
import { WOOD_BEAM_DEPTH_TABLE, TRADITIONAL_WOOD_FRAMING, TRADITIONAL_WOOD_BACKING, rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { findSectionEntry, woodRectSectionKey, SECTION_CATALOG } from './sectionCatalog.js';

test('woodBeamDepthMm: 梁成表（最終行は中間荷重3か所＝ユーザー確認済み）を距離区分×中間荷重数で引く', () => {
  // 1820以下
  assert.equal(woodBeamDepthMm(1820, 0), 120);
  assert.equal(woodBeamDepthMm(910, 1), 150);
  assert.equal(woodBeamDepthMm(1820, 2), 210);
  assert.equal(woodBeamDepthMm(1820, 3), 240);
  // 2730以下（1820超）
  assert.equal(woodBeamDepthMm(1821, 0), 240);
  assert.equal(woodBeamDepthMm(2730, 1), 270);
  assert.equal(woodBeamDepthMm(2730, 2), 270);
  assert.equal(woodBeamDepthMm(2730, 3), 300);
  // 3640以下（2730超）
  assert.equal(woodBeamDepthMm(2731, 0), 300);
  assert.equal(woodBeamDepthMm(3640, 1), 330);
  assert.equal(woodBeamDepthMm(3640, 2), 330);
  assert.equal(woodBeamDepthMm(3640, 3), 360);
});

test('woodBeamDepthMm: 表の外（3640超・4か所以上）は表の最大側の値（ユーザー裁定2026-09-14「表の最大値360を使う」）', () => {
  assert.equal(woodBeamDepthMm(3641, 0), 300, '3640超は3640以下の列');
  assert.equal(woodBeamDepthMm(5460, 3), 360, '3640超×3か所＝表の最大値');
  assert.equal(woodBeamDepthMm(1820, 4), 240, '4か所以上は3か所の行');
  assert.equal(woodBeamDepthMm(9999, 9), 360);
});

test('【失敗系】woodBeamDepthMm: 非数・0以下の距離、負や非整数の荷重数は null', () => {
  assert.equal(woodBeamDepthMm(0, 0), null);
  assert.equal(woodBeamDepthMm(NaN, 0), null);
  assert.equal(woodBeamDepthMm(undefined, 0), null);
  assert.equal(woodBeamDepthMm(1820, -1), null);
  assert.equal(woodBeamDepthMm(1820, 1.5), null);
});

test('woodBeamSectionKey: 支持間距離と中間荷重から「柱同寸×成」の断面キーを返し、表のすべての成×正角幅がカタログにある', () => {
  assert.equal(woodBeamSectionKey(3640, 3, 120), 'WOOD-120x360');
  assert.equal(woodBeamSectionKey(1820, 0, 120), 'WOOD-120x120', '成120×幅120＝正角');
  assert.equal(woodBeamSectionKey(1820, 0, 105), 'WOOD-105x120');
  assert.equal(woodBeamSectionKey(2730, 2, 90), 'WOOD-90x270');
  assert.equal(woodBeamSectionKey(5000, 5, 120), 'WOOD-120x360', '表外は最大値');
  for (const width of [90, 105, 120]) {
    for (const row of WOOD_BEAM_DEPTH_TABLE.depthsByLoads) {
      for (const depth of row) {
        assert.equal(woodRectSectionKey(width, depth), `WOOD-${width}x${depth}`, `${width}×${depth} がカタログに無い`);
      }
    }
  }
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.columnSection).width, 120, '在来木造の柱は120角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.hipBraceSection)?.width, 90, '火打ち梁は90角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.purlinSection)?.width, 90, '母屋は90角');
  assert.equal(findSectionEntry(TRADITIONAL_WOOD_FRAMING.ridgeSection)?.width, 120, '棟木は120角');
  assert.ok(findSectionEntry('WOOD-105x105'), '旧既定 105角 は旧文書のため残す');
});

test('【失敗系】woodBeamSectionKey: 梁成が引けない・幅が非数/0以下・カタログに無い幅は null', () => {
  assert.equal(woodBeamSectionKey(0, 0, 120), null);
  assert.equal(woodBeamSectionKey(1820, 0, 0), null);
  assert.equal(woodBeamSectionKey(1820, 0, NaN), null);
  assert.equal(woodBeamSectionKey(1820, 0, 150), null, '150幅の木角材はカタログに無い');
});

test('sectionCatalog: 木造エントリは正角（90/105/120）と「正角幅×梁成」の矩形で、材種WOOD・幅≦成', () => {
  const wood = SECTION_CATALOG.filter(s => s.materialType === 'WOOD');
  assert.ok(wood.length >= 3 + 3 * 8, `木造エントリが少ない（${wood.length}）`);
  for (const s of wood) {
    assert.ok([90, 105, 120].includes(s.width), `${s.key}: 幅は正角材の寸法`);
    assert.ok(s.height >= s.width, `${s.key}: 成は幅以上`);
    assert.equal(s.key, `WOOD-${s.width}x${s.height}`);
  }
});

test('studPositions: AB間の両端に (L − (商−1)×455)/2 をとり、残りを455で割り付ける（位置は材の中心）', () => {
  // L=2730: 商=6 → 内側5ピッチ=2275、両端=(2730−2275)/2=227.5
  assert.deepEqual(studPositions(2730), [227.5, 682.5, 1137.5, 1592.5, 2047.5, 2502.5]);
  // L=1820: 商=4 → 内側3ピッチ=1365、両端=227.5
  assert.deepEqual(studPositions(1820), [227.5, 682.5, 1137.5, 1592.5]);
  // ピッチ違い（外壁の「縦下地間隔」変更）: L=1820, p=303 → 商=6 → 内側5×303=1515、両端=152.5
  assert.deepEqual(studPositions(1820, 303), [152.5, 455.5, 758.5, 1061.5, 1364.5, 1667.5]);
  // 対称性: 最初と最後の位置は両端から同じ距離。材厚（studSpec.depth）には依存しない。
  const p = studPositions(3000);
  assert.ok(Math.abs(p[0] - (3000 - p[p.length - 1])) < 1e-9);
  assert.equal(TRADITIONAL_WOOD_BACKING.studPitchMm, 455, '既定ピッチ455');
});

test('【失敗系】studPositions: 距離が2ピッチ未満は中央1本、0以下・非数・ピッチ0以下は空配列', () => {
  assert.deepEqual(studPositions(900), [450]);   // 商=1 → 内側0ピッチ → 中央
  assert.deepEqual(studPositions(300), [150]);   // 商=0 → 中央1本（0本にはしない）
  assert.deepEqual(studPositions(0), []);
  assert.deepEqual(studPositions(-1), []);
  assert.deepEqual(studPositions(NaN), []);
  assert.deepEqual(studPositions(1820, 0), []);
});

test('studSpec / openingJambSpec: 壁下地＝柱寸×30、外壁アルミ窓の袖＝柱寸×45・扉の袖＝柱同寸、クリアランス5', () => {
  assert.deepEqual(studSpec(120), { width: 120, depth: 30 });
  assert.deepEqual(openingJambSpec('window', 120), { width: 120, depth: 45, clearanceMm: 5 });
  assert.deepEqual(openingJambSpec('door', 120), { width: 120, depth: 120, clearanceMm: 5 });
  assert.deepEqual(openingJambSpec('door', 105), { width: 105, depth: 105, clearanceMm: 5 });
});

test('【失敗系】studSpec / openingJambSpec: 未知の種別・柱寸が非数/0以下は null', () => {
  assert.equal(studSpec(0), null);
  assert.equal(studSpec(NaN), null);
  assert.equal(openingJambSpec('shutter', 120), null);
  assert.equal(openingJambSpec('window', 0), null);
  assert.equal(openingJambSpec('window', NaN), null);
});

test('entranceOpeningWidthMm: 玄関建具部分の基礎・両袖取付柱の開口＝扉幅＋両端5mm（既定はルール値）', () => {
  assert.equal(entranceOpeningWidthMm(900), 910);
  assert.equal(rulesFor(TRADITIONAL_WOOD_STRUCTURE).foundation.entranceClearanceMm, 5);
  assert.equal(entranceOpeningWidthMm(900, 10), 920);
  assert.equal(entranceOpeningWidthMm(0), null);
  assert.equal(entranceOpeningWidthMm(900, -1), null);
});

test('hipBraceAllowed: 16㎡以下の四角は可、吹抜け(VOID)は可、階段(STAIR)・階段吹抜け(STAIR_VOID)・削除済み(UNDEFINED)・非四角・16㎡超は不可', () => {
  assert.equal(hipBraceAllowed({ areaM2: 16, isRectangle: true }), true);
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.VOID }), true, '吹抜けには設置可能');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.STAIR }), false, '階段内は不可');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.STAIR_VOID }), false, '階段吹抜けも階段内');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: true, feature: RoomFeature.UNDEFINED }), false, '削除済み部屋は床なし');
  assert.equal(hipBraceAllowed({ areaM2: 16.01, isRectangle: true }), false, '16㎡超は不可');
  assert.equal(hipBraceAllowed({ areaM2: 8, isRectangle: false }), false, '四角でなければ不可');
  assert.equal(hipBraceAllowed({ areaM2: 0, isRectangle: true }), false);
  assert.equal(TRADITIONAL_WOOD_FRAMING.hipBraceMaxAreaM2, 16);
});

test('【失敗系】hipBraceAllowed: cell が undefined/null でも例外を投げず false', () => {
  assert.equal(hipBraceAllowed(undefined), false);
  assert.equal(hipBraceAllowed(null), false);
});

test('structureRules: 在来木造だけが framing/backing を持ち、柱120角・梁既定＝柱同寸・梁天端FL−100・床梁1820・下地455等の値を返す', () => {
  const r = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  assert.equal(r.defaultSections.column, 'WOOD-120x120');
  assert.equal(r.defaultSections.beam, r.framing.columnSection, '梁の既定断面は柱同寸の正角');
  assert.equal(r.framing.beamTopBelowFLMm, 100);
  assert.equal(r.framing.floorBeamMaxPitchMm, 1820);
  assert.equal(r.backing.studDepthMm, 30);
  assert.equal(r.foundation.sillWidthMm, 150);
  assert.equal(r.foundation.sectionDefaults.baseWidth, 600);
  for (const key of ['木造（2"×4"）', 'S造', 'SRC造', 'RC造(ラーメン)', 'RC造(壁式)', '未定']) {
    assert.equal(rulesFor(key).framing, null, `${key} は framing を持たない`);
    assert.equal(rulesFor(key).backing, null, `${key} は backing を持たない`);
  }
  assert.equal(rulesFor('木造（2"×4"）').defaultSections.column, 'WOOD-105x105', '2×4の既定断面は変えない');
});
