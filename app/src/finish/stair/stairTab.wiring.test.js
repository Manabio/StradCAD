// 仕上げモード階段タブの連鎖グループ表示（ステップ8）の UI 配線。.jsx は node:test から単体 import できないため、
// ソーステキストの1行まるごと一致で固定する。検査の前にブロックコメント（/* */。JSX の {/* */} を含む）を取り除くので、
// コメントの中に元の式を残す変異は一致しない。行頭コメント・行末コメントも1行まるごと一致では一致しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raw = fs.readFileSync(path.resolve(import.meta.dirname, 'StairTab.jsx'), 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const lines = src.split(/\r?\n/).map(l => l.trim());
const has = (line) => lines.includes(line);
const countOf = (s, needle) => s.split(needle).length - 1;

test('【配線】一覧は mode.stairChains のグループごと。グループ行は三角（▼/▶）＋グループ名で、開閉は isChainOpen と overrides', () => {
  assert.ok(has('const chains = mode.stairChains;'), 'chains の取得行が見つからない');
  assert.ok(has('{chains.map((chain, ci) => {'), 'グループごとの map が見つからない');
  assert.ok(has('const open = isChainOpen(chain, selectedId, overrides);'), '開閉の判定行が見つからない');
  assert.ok(has('aria-expanded={open}'), '三角ボタンの aria-expanded が見つからない');
  assert.ok(has('onClick={() => setOverrides(prev => new Map(prev).set(chain.key, !open))}'), '三角の開閉の onClick が見つからない');
  assert.ok(has("{open ? '▼' : '▶'} {stairChainTitle(ci, planeById.get(chain.fromPlaneId), chainArrivalPlane(project?.planes, chain.toPlaneId))}"),
    'グループ行（三角＋グループ名。到達階は chainArrivalPlane）が見つからない');
  assert.equal(countOf(src, 'upperPlaneOf'), 0, '到達階を JSX 内で独自に計算している（chainArrivalPlane に一本化）');
  assert.equal(countOf(src, 'stairFloorLabels'), 0, '廃止した stairFloorLabels を呼んでいる');
});

test('【配線】開くのは open のときだけ各階の行を出す。行は「階表記 タイプ 段数」（空の階表記は詰める）', () => {
  assert.ok(has('{open && chain.members.map(member => {'), '展開時だけ各階の行を出す行が見つからない');
  assert.ok(has('{[stairFloorName(planeById.get(member.planeId)), TYPE_LABEL[s.type] ?? s.type, `${s.totalSteps}段`].filter(Boolean).join(\' \')}'),
    '各階の行の表記が見つからない');
});

test('【配線】編集（StairEditor）と削除（onDeleteStair）は自階の選択（selectedSelf）だけ。他階の行は読み取り専用の表示', () => {
  assert.ok(has('const selectedSelf = selectedId ? graph.stairMap.get(selectedId) : null;'), '自階の選択の判定行が見つからない');
  const editorIdx = lines.findIndex(l => l.startsWith('<StairEditor'));
  assert.ok(editorIdx > 0 && lines[editorIdx - 1] === '{selectedSelf && (', 'StairEditor は {selectedSelf && ( の直後でなければならない');
  assert.equal(countOf(src, '<StairEditor'), 1, '<StairEditor は src 全体で1箇所だけ（他階の行へ置かない）');
  assert.equal(countOf(src, 'onDeleteStair'), 2, 'onDeleteStair は引数と StairEditor の onDelete の2箇所だけ');
  assert.ok(has('onDelete={onDeleteStair}'), 'StairEditor の onDelete が見つからない');
  assert.ok(has('.filter(m => m.planeId !== activeId)'), '他階の選択が自階のメンバーを除いていない');
  assert.ok(has('{selectedOther && ('), '他階の読み取り専用表示が見つからない');
});

test('【配線】選択が変わったら（見下げ選択を含む）その階段を含むグループの閉じた操作を捨てる。依存は selectedId だけ', () => {
  assert.ok(has('}, [selectedId, mode]); // 連鎖は effect の中で mode から読む（依存は選択と mode だけ。連鎖の変化では走らせない）'), '選択変更の effect の依存が見つからない');
  assert.ok(has('const hit = mode.stairChains.filter(c => c.members.some(m => m.stairId === selectedId) && prev.has(c.key));'),
    '選択を含むグループの抽出行が見つからない');
  assert.ok(has('for (const c of hit) next.delete(c.key);'), '閉じた操作を捨てる行が見つからない');
});
