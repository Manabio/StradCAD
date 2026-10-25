// svgFigurePrimitives.js の契約テスト（キー順・渡したキーだけ・型集合・純モジュール）。
// 出力のバイト同一を守る根拠: ヘルパーは位置引数＋extra を順に展開するだけで、検証・既定値補完・undefined 落としをしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SvgFigurePrimitiveType } from '../../core/constants.js';
import {
  rect, text, line, polyline, circleMm, circlePx, hSection, dim, levelLine, axisV, arrow,
} from './svgFigurePrimitives.js';
import { figureBounds } from './sectionGeometry.js';
import { translatePrimitive } from './layoutStudy.js';
import { extractFunctionBody, stripCommentLines } from '../../uiBusySourceScan.js';

const keys = p => Object.keys(p);

// 0 を避けた座標で作った、全ヘルパーの代表出力（型集合・範囲・平行移動の検査で共用）。
function sampleOfEach() {
  return [
    rect(1, 2, 3, 4), text(1, 2, 'a'), line(1, 2, 3, 4), polyline([[1, 2], [3, 4]]),
    circleMm(1, 2, 3), circlePx(1, 2, 3), hSection(1, 2, 3, 4, 5, 6), dim('h', 1, 2, 3, 4),
    levelLine(2), axisV(1), arrow(1, 2, 3, 4),
  ];
}

test('キー順: rect は x,y,w,h の後に extra を渡した順（memberFigures の実際の並び）', () => {
  assert.deepEqual(keys(rect(0, 1, 2, 3, { stroke: '#94a3b8' })), ['type', 'x', 'y', 'w', 'h', 'stroke']);
  assert.deepEqual(keys(rect(0, 1, 2, 3, { fill: undefined, hatch: 'concrete' })), ['type', 'x', 'y', 'w', 'h', 'fill', 'hatch']);
});

test('キー順: text は x,y,text の後に extra（4 通り）', () => {
  assert.deepEqual(keys(text(0, 1, 'a', { anchor: 'middle', size: 10, fill: '#fff', layoutId: 'text:x' })),
    ['type', 'x', 'y', 'text', 'anchor', 'size', 'fill', 'layoutId']);
  assert.deepEqual(keys(text(0, 1, 'a', { anchor: 'middle', size: 10, fill: '#fff' })), ['type', 'x', 'y', 'text', 'anchor', 'size', 'fill']);
  assert.deepEqual(keys(text(0, 1, 'a', { anchor: 'end', baseline: 'middle', size: 10, fill: '#fff' })),
    ['type', 'x', 'y', 'text', 'anchor', 'baseline', 'size', 'fill']);
  assert.deepEqual(keys(text(0, 1, 'a', { anchor: 'middle', size: 11 })), ['type', 'x', 'y', 'text', 'anchor', 'size']);
});

test('キー順: line／polyline／circle／hSection', () => {
  assert.deepEqual(keys(line(0, 1, 2, 3, { dash: 'center', stroke: '#94a3b8' })), ['type', 'x1', 'y1', 'x2', 'y2', 'dash', 'stroke']);
  assert.deepEqual(keys(line(0, 1, 2, 3, { stroke: '#475569', width: 1.5 })), ['type', 'x1', 'y1', 'x2', 'y2', 'stroke', 'width']);
  assert.deepEqual(keys(polyline([[0, 0]], { stroke: '#475569' })), ['type', 'points', 'stroke']);
  assert.deepEqual(keys(circleMm(0, 1, 2, { fill: '#e2e8f0', stroke: '#334155' })), ['type', 'cx', 'cy', 'r', 'fill', 'stroke']);
  assert.deepEqual(keys(circlePx(0, 1, 2, { fill: '#64748b' })), ['type', 'cx', 'cy', 'rPx', 'fill']);
  assert.deepEqual(keys(hSection(0, 1, 2, 3, 4, 5, { fill: '#475569' })), ['type', 'x', 'y', 'w', 'h', 'web', 'flange', 'fill']);
});

test('キー順: dim／levelLine／axisV／arrow', () => {
  assert.deepEqual(keys(dim('h', 0, 10, 5, 10, { foot: 3 })), ['type', 'dir', 'from', 'to', 'at', 'label', 'foot']);
  assert.deepEqual(keys(levelLine(0, { noLabel: true })), ['type', 'y', 'noLabel']);
  assert.deepEqual(keys(levelLine(0, { label: 'FL' })), ['type', 'y', 'label']);
  assert.deepEqual(keys(axisV(0, { layoutId: 'axis:materialAxis' })), ['type', 'x', 'layoutId']);
  assert.deepEqual(keys(axisV(0, { label: '壁芯' })), ['type', 'x', 'label']);
  assert.deepEqual(keys(arrow(0, 1, 2, 3, { points: [], labelX: 1, labelY: 2, label: 'a', stroke: '#000' })),
    ['type', 'x1', 'y1', 'x2', 'y2', 'points', 'labelX', 'labelY', 'label', 'stroke']);
});

test('渡したキーだけ: extra 省略時は位置引数のキーだけを持ち、既定値を足さない', () => {
  assert.equal(keys(rect(0, 1, 2, 3)).length, 5);
  assert.equal(keys(text(0, 1, 'a')).length, 4);
  assert.equal(keys(line(0, 1, 2, 3)).length, 5);
  assert.equal(keys(polyline([])).length, 2);
  assert.equal(keys(circleMm(0, 1, 2)).length, 4);
  assert.equal(keys(circlePx(0, 1, 2)).length, 4);
  assert.equal(keys(hSection(0, 1, 2, 3, 4, 5)).length, 7);
  assert.equal(keys(dim('h', 0, 1, 2, 3)).length, 6);
  assert.equal(keys(levelLine(0)).length, 2);
  assert.equal(keys(axisV(0)).length, 2);
  assert.equal(keys(arrow(0, 1, 2, 3)).length, 5);
  for (const k of ['stroke', 'fill', 'width', 'hatch', 'dash']) {
    assert.equal(k in line(0, 1, 2, 3), false, `line に既定の ${k} を足さない`);
    assert.equal(k in rect(0, 1, 2, 3), false, `rect に既定の ${k} を足さない`);
  }
  assert.equal('label' in levelLine(0, { noLabel: true }), false);
  assert.equal('rPx' in circleMm(0, 1, 2), false);
  assert.equal('r' in circlePx(0, 1, 2), false);
});

test('【失敗系】extra に undefined／null を渡しても throw せず、位置引数のキーだけになる', () => {
  for (const extra of [undefined, null]) {
    assert.deepEqual(keys(rect(0, 1, 2, 3, extra)), ['type', 'x', 'y', 'w', 'h']);
    assert.deepEqual(keys(text(0, 1, 'a', extra)), ['type', 'x', 'y', 'text']);
    assert.deepEqual(keys(line(0, 1, 2, 3, extra)), ['type', 'x1', 'y1', 'x2', 'y2']);
    assert.deepEqual(keys(polyline([], extra)), ['type', 'points']);
    assert.deepEqual(keys(circleMm(0, 1, 2, extra)), ['type', 'cx', 'cy', 'r']);
    assert.deepEqual(keys(circlePx(0, 1, 2, extra)), ['type', 'cx', 'cy', 'rPx']);
    assert.deepEqual(keys(hSection(0, 1, 2, 3, 4, 5, extra)), ['type', 'x', 'y', 'w', 'h', 'web', 'flange']);
    assert.deepEqual(keys(levelLine(0, extra)), ['type', 'y']);
    assert.deepEqual(keys(axisV(0, extra)), ['type', 'x']);
    assert.deepEqual(keys(arrow(0, 1, 2, 3, extra)), ['type', 'x1', 'y1', 'x2', 'y2']);
  }
  assert.deepEqual(keys(dim('h', 0, 1, 2, 3, null)), ['type', 'dir', 'from', 'to', 'at', 'label']);
});

test('【失敗系】extra の値が undefined でもキーは残る（undefined キーの有無まで出力を変えない）', () => {
  const r = rect(0, 1, 2, 3, { fill: undefined, hatch: 'concrete' });
  assert.ok('fill' in r && r.fill === undefined);
  const d = dim('h', 0, 10, 5, undefined);
  assert.equal('label' in d, true);
  assert.equal(d.label, undefined);
});

test('型集合: 全ヘルパーの出力型 ＝ SvgFigurePrimitiveType ＝ AutoScaledFigure.renderPrimitive の case 集合', () => {
  const enumTypes = Object.values(SvgFigurePrimitiveType).sort();
  assert.deepEqual([...new Set(sampleOfEach().map(p => p.type))].sort(), enumTypes);
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'AutoScaledFigure.jsx'), 'utf8');
  const body = extractFunctionBody(src, 'function renderPrimitive');
  const cases = [...body.matchAll(/case '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(cases)].sort(), enumTypes);
});

test('型集合: 全ヘルパーの出力は figureBounds が空の既定値にならない範囲を寄与する', () => {
  const empty = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  for (const p of sampleOfEach()) {
    const b = figureBounds([p]);
    assert.notDeepEqual(b, empty, `${p.type} は figureBounds に寄与する`);
    assert.ok(Number.isFinite(b.minX) && Number.isFinite(b.maxY), `${p.type} の範囲が有限`);
  }
});

test('型集合: ARROW 以外は layoutStudy.translatePrimitive で動く（ARROW は既知の例外で動かない）', () => {
  for (const p of sampleOfEach()) {
    if (p.type === SvgFigurePrimitiveType.ARROW) {
      assert.deepEqual(translatePrimitive(p, 7, 9), p, 'arrow は構造断面の配置検討の対象外（建具姿図専用）');
    } else {
      assert.notDeepEqual(translatePrimitive(p, 7, 9), p, `${p.type} は translatePrimitive で動く`);
    }
  }
});

test('純モジュール: svgFigurePrimitives.js は store／snap／.jsx を import しない', () => {
  const src = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'svgFigurePrimitives.js'), 'utf8'));
  const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(specs, ['../../core/constants.js']);
  for (const s of specs) {
    assert.ok(!/store\.js$|snap\.js$|\.jsx$/.test(s), `${s} を引かない`);
  }
});
