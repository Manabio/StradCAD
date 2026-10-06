// 階段の削除の連動（件B ステップ3・4）の UI 配線。.jsx は node:test から単体 import できないため、ソーステキストの
// 1行まるごと一致（m フラグ・行頭行末アンカー）で固定する。行頭コメント・行末コメントに元の式を残す変異に一致しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');
const lines = (src) => src.split(/\r?\n/);

test('【配線・件B】StairTab: StairEditor の onDelete は onDeleteStair（モードの deleteStair 直呼びではない）', () => {
  const src = read('StairTab.jsx');
  assert.match(src, /^\s*onDelete=\{onDeleteStair\}\s*$/m, 'onDelete={onDeleteStair} が1行まるごとの形で見つからない');
  assert.doesNotMatch(src, /mode\.deleteStair\(/, 'mode.deleteStair( の直呼びが残っている（連動削除の関門を通らない）');
  assert.match(src, /^export const StairTab = observer\(\(\{ graph, mode, project, onDeleteStair \}\) => \{\s*$/m, 'StairTab が onDeleteStair を受け取らない');
});

test('【配線・件B】StairPanel: 削除ボタンは onDelete を呼ぶ', () => {
  const src = read('StairPanel.jsx');
  assert.match(src, /^\s*onClick=\{\(\) => onDelete && onDelete\(stair\.id\)\}\s*$/m, '削除ボタンの onClick が見つからない');
});

test('【配線・件B】FinishTable: StairTab へ onDeleteStair、内部タブの RoomDeleteConfirm へ onDeleteStairRoom を渡し、外部タブの RoomDeleteConfirm には渡さない', () => {
  const src = read('../FinishTable.jsx');
  assert.match(src, /^\s*\? <StairTab graph=\{graph\} mode=\{mode\} project=\{project\} onDeleteStair=\{onDeleteStair\} \/>\s*$/m,
    '<StairTab ... onDeleteStair={onDeleteStair} /> が1行まるごとの形で見つからない');
  const confirms = lines(src).filter(l => l.trim().startsWith('<RoomDeleteConfirm '));
  assert.equal(confirms.length, 2, '<RoomDeleteConfirm は内部タブ・外部タブの2箇所のはず');
  assert.equal(confirms.filter(l => l.includes('onDeleteStairRoom={onDeleteStairRoom}')).length, 1, 'onDeleteStairRoom を渡すのは内部タブの1箇所だけ');
  assert.equal(confirms.filter(l => l.includes('onDeleteStair')).length, 1, 'onDeleteStair 系を渡す RoomDeleteConfirm は内部タブの1箇所だけ');
});

test('【配線・件B】RoomDeleteConfirm: 階段のペア部屋なら onDeleteStairRoom（部屋 id）へ回し、それ以外（または onDeleteStairRoom なし）は mode.deleteRoom', () => {
  const src = read('../RoomDeleteConfirm.jsx');
  assert.match(src, /^\s*const stair = onDeleteStairRoom \? mode\.stairOfRoom\(deleteConfirm\.roomId\) : null;\s*$/m, 'stair の判定行が見つからない');
  assert.match(src, /^\s*if \(stair\) onDeleteStairRoom\(deleteConfirm\.roomId\);\s*$/m, 'if (stair) onDeleteStairRoom(deleteConfirm.roomId); が見つからない');
  assert.match(src, /^\s*else mode\.deleteRoom\(deleteConfirm\.roomId\);\s*$/m, 'else mode.deleteRoom(...) が見つからない');
});

test('【配線・件B】RoomDeleteConfirm: 削除不可の理由（mode.roomDeleteBlockReason）があるときは理由だけを示し、削除の選択肢（削除ボタン・mode.deleteRoom）を出さない', () => {
  const src = read('../RoomDeleteConfirm.jsx');
  const ls = lines(src).map(l => l.trim());
  const reasonIdx = ls.indexOf('const blockReason = mode.roomDeleteBlockReason(deleteConfirm.roomId);');
  const branchIdx = ls.indexOf('if (blockReason) {');
  const deleteBtnIdx = ls.indexOf("{ label: '削除', value: 'ok', danger: true },");
  const closeOnlyIdx = ls.indexOf("buttons={[{ label: '閉じる', value: 'cancel' }]}");
  assert.ok(reasonIdx >= 0 && branchIdx > reasonIdx, '理由の取得 → if (blockReason) { の順で見つからない');
  assert.ok(closeOnlyIdx > branchIdx && ls.indexOf('message={blockReason}') > branchIdx, '理由ありの分岐が理由と「閉じる」だけのダイアログを出していない');
  assert.ok(deleteBtnIdx > closeOnlyIdx, '削除ボタンは理由ありの分岐より後（理由ありでは到達しない）');
  const nullGuardIdx = ls.indexOf('if (!deleteConfirm) return null;');
  assert.ok(nullGuardIdx >= 0 && nullGuardIdx < reasonIdx, 'deleteConfirm なしの早期 return の後で理由を引く');
});

test('【配線・件B】FinishSidebar・FinishHalfModal は onDeleteStair・onDeleteStairRoom を FinishTable へ中継する', () => {
  for (const f of ['../FinishSidebar.jsx', '../FinishHalfModal.jsx']) {
    const src = read(f);
    assert.match(src, /^\s*onDeleteStair=\{onDeleteStair\}\s*$/m, `${f}: onDeleteStair={onDeleteStair} が見つからない`);
    assert.match(src, /^\s*onDeleteStairRoom=\{onDeleteStairRoom\}\s*$/m, `${f}: onDeleteStairRoom={onDeleteStairRoom} が見つからない`);
    assert.match(src, /onChangeEquipmentUsage, onDeleteStair,\s*$/m, `${f}: onDeleteStair を引数に受けていない`);
    assert.match(src, /^\s*onDeleteStairRoom,\s*$/m, `${f}: onDeleteStairRoom を引数に受けていない`);
  }
});
