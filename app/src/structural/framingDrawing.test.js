// structural/framingDrawing.js（伏図の描画規則：柱記号・部材線色・柱の断面フォールバック）の単体テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAMING_MONO_COLOR, COLUMN_FALLBACK_SIZE_MM,
  framingColumnGroups, framingColor, framingColorOverride,
  columnSectionSize, columnCrossPointsLocal,
} from './framingDrawing.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { STRUCTURES } from './structuralClassification.js';

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

test('【失敗系】断面がカタログに無い柱は120角にフォールバックし、対角線2本の端点集合＝矩形4隅の集合', () => {
  for (const column of [{ sectionDefId: undefined }, { sectionDefId: 'NO-SUCH-SECTION' }, {}]) {
    const size = columnSectionSize(column);
    assert.deepEqual(size, { width: COLUMN_FALLBACK_SIZE_MM, height: COLUMN_FALLBACK_SIZE_MM });
    const lines = columnCrossPointsLocal(size.width, size.height);
    assert.equal(lines.length, 2, '対角線は2本');
    const points = new Set();
    for (const [x1, y1, x2, y2] of lines) {
      points.add(`${x1},${y1}`);
      points.add(`${x2},${y2}`);
    }
    const h = COLUMN_FALLBACK_SIZE_MM / 2;
    const corners = new Set([`${-h},${-h}`, `${h},${h}`, `${-h},${h}`, `${h},${-h}`]);
    assert.deepEqual(points, corners, '対角線2本の端点は矩形の4隅と一致するはず（式の写経ではなく意図の検査）');
  }
});
