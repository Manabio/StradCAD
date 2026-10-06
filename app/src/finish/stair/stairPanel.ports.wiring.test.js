// 階段パネルの出入口の辺（ステップ9a）の UI 配線。.jsx は node:test から単体 import できないため、
// ソーステキストの1行まるごと一致で固定する。検査の前にブロックコメント（/* */。JSX の {/* */} を含む）を取り除くので、
// コメントの中に元の式を残す変異は一致しない。行頭コメント・行末コメントも1行まるごと一致では一致しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const load = (name) => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const lines = src.split(/\r?\n/).map(l => l.trim());
  return { src, has: (line) => lines.includes(line) };
};
const countOf = (s, needle) => s.split(needle).length - 1;

const panel = load('StairPanel.jsx');
const tab = load('StairTab.jsx');

test('【配線】StairEditor は upperGraph を受け取り、StairTab が mode.upperFloorGraph を渡す', () => {
  assert.ok(panel.has('export const StairEditor = observer(({ stair, graph, project, upperGraph = null, onDelete }) => {'), 'StairEditor の引数に upperGraph が無い');
  assert.ok(tab.has('stair={selectedSelf} graph={graph} project={project} upperGraph={mode.upperFloorGraph}'), 'StairTab が upperGraph を渡していない');
  assert.equal(countOf(tab.src, 'upperFloorGraph'), 1, 'upperFloorGraph は StairEditor への1箇所だけ');
});

test('【配線】候補の床確認は上り口＝自階（graph）・到達口＝上階（upperGraph）。候補が1つ以下の口は行を出さない', () => {
  assert.ok(panel.has("const cands = stairPortCandidates(stair, graph, port, { floorGraph: port === 'entry' ? graph : upperGraph });"),
    '口ごとの床確認のグラフの切替行が見つからない');
  assert.ok(panel.has('{portRows.filter(r => r.sides.length > 1).map(r => ('), '候補が2つ以上の口だけ行を出すフィルタ行が見つからない');
  assert.ok(panel.has('<select style={inputStyle} value={r.current} onChange={onPortSideChange(r.port)}>'), '出入口の select 行が見つからない');
  assert.ok(panel.has('{r.sides.map(v => <option key={v} value={v}>{PORT_SIDE_LABELS[v]}</option>)}'), '候補だけを選択肢にする行が見つからない');
  assert.equal(countOf(panel.src, 'stairPortCandidates('), 1, '候補の列挙は1箇所だけ');
});

test('【配線】上階の床を確かめられなかった（floorChecked=false）口には「上階の床は未確認」の注記', () => {
  assert.ok(panel.has("{!r.floorChecked && <div style={{ fontSize: 11, color: '#64748b', marginLeft: 72 }}>上階の床は未確認</div>}"),
    '未確認の注記の行が見つからない');
});

test('【配線】ラベルは「走行端」「左（上りから見て）」「右（上りから見て）」。旧語彙（INNER/OUTER）・旧関数は残さない', () => {
  assert.ok(panel.has("[StairPortSide.END]:   '走行端',"));
  assert.ok(panel.has("[StairPortSide.LEFT]:  '左（上りから見て）',"));
  assert.ok(panel.has("[StairPortSide.RIGHT]: '右（上りから見て）',"));
  assert.equal(countOf(panel.src, 'INNER'), 0);
  assert.equal(countOf(panel.src, 'OUTER'), 0);
  assert.equal(countOf(panel.src, 'resolveUTurnPorts'), 0, '解決は stairPorts.js の resolveStairPorts に一本化');
});

test('【配線】辺の切替は portSideChange（総蹴上数を保つ。null＝直進部が足りず拒否）。反転・上り方向の変更で resetPortSides、編集後に alignPortTurnSteps', () => {
  assert.ok(panel.has('const fields = portSideChange(stair, port, e.target.value, portZone(portInfo, port).zoneLen);'), 'portSideChange の呼び出し行が見つからない');
  assert.ok(panel.has('if (!fields) return;'), '拒否（null）で何もしない行が見つからない');
  assert.ok(panel.has("<select style={inputStyle} value={stair.upDirection} onChange={e => withFinishUndo(graph, () => { stair.setField('upDirection', e.target.value); applyFields(resetPortSides(stair)); afterEdit(); })}>"),
    '昇り方向の handler（resetPortSides 込み）の行が見つからない');
  assert.ok(panel.has("<input type=\"checkbox\" checked={stair.flip} onChange={e => withFinishUndo(graph, () => { stair.setField('flip', e.target.checked); applyFields(resetPortSides(stair)); afterEdit(); })} />"),
    '反転の handler（resetPortSides 込み）の行が見つからない');
  assert.ok(panel.has('if (info) applyFields(alignPortTurnSteps(stair, resolveStairPorts(stair, info)));'), 'afterEdit の取りつき蹴上のそろえ行が見つからない');
});
