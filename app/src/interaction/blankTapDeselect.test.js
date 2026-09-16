// 構造モードの空白タップ＝選択解除（ユーザー裁定2026-09-17「外クリックで構造モードのまま無選択状態に」）。
// 純判定 isBlankTapTarget の単体テストと、本番配線（usePointerInteraction → App.jsx → StructuralPanel →
// MemberListTab）のソース走査不変条件（team-lessons「テストはヘルパーではなく本番の呼び出し経路を守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isBlankTapTarget } from './beamTap.js';

const readSrc = rel => fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8');

// Konva の Stage/図形の擬似オブジェクト（getStage() が Stage を返す）。
function makeStage() { const stage = {}; stage.getStage = () => stage; return stage; }

test('isBlankTapTarget: target が Stage 自身なら true（何の部材にも当たっていない空白タップ）', () => {
  const stage = makeStage();
  assert.equal(isBlankTapTarget(stage), true);
});

test('isBlankTapTarget: target が Stage 配下の図形（梁記号・タグ等）なら false', () => {
  const stage = makeStage();
  const shape = { getStage: () => stage, getAttr: () => 'b1' };
  assert.equal(isBlankTapTarget(shape), false);
});

test('【失敗系】isBlankTapTarget: target が null/undefined/Stage判定APIを持たないオブジェクトなら false（解除しない＝安全側）', () => {
  assert.equal(isBlankTapTarget(null), false);
  assert.equal(isBlankTapTarget(undefined), false);
  assert.equal(isBlankTapTarget({}), false);
  assert.equal(isBlankTapTarget({ getStage: () => null }), false);
});

test('【不変条件】usePointerInteraction: 構造モードの梁タップ分岐で、梁に当たらず空白タップなら onMemberDeselect を呼ぶ', () => {
  const src = readSrc('./usePointerInteraction.js');
  assert.ok(/import \{[^}]*\bisBlankTapTarget\b[^}]*\} from '\.\/beamTap\.js'/.test(src), 'isBlankTapTarget を beamTap.js から import していない');
  assert.ok(/if \(beam\) onMemberClick\(beam, 'beamMap'\);[\s\S]{0,600}?else if \(isBlankTapTarget\(e\.target\)\) onMemberDeselect\?\.\(\);/.test(src),
    '梁タップの直後に「空白タップなら onMemberDeselect」の分岐が無い（梁に当たったタップで解除しない・部材タグのタップでも解除しない構造）');
  assert.ok(/onMemberClick, onMemberDeselect,/.test(src), 'usePointerInteraction が onMemberDeselect を props として受け取っていない');
});

test('【不変条件】App.jsx: onMemberDeselect は安定参照でカウンタを進め、StructuralPanel→MemberListTab は deselectRequest で展開カードを閉じる', () => {
  const app = readSrc('../App.jsx');
  assert.ok(/const deselectStructuralMembers = useCallback\(\(\) => setMemberDeselectRequest\(n => n \+ 1\), \[\]\);/.test(app),
    'App.jsx: deselectStructuralMembers（useCallback・カウンタ加算）が無い');
  assert.ok(/onMemberDeselect: deselectStructuralMembers,/.test(app), 'App.jsx: usePointerInteraction へ onMemberDeselect が渡されていない');
  assert.ok(/deselectRequest=\{memberDeselectRequest\}/.test(app), 'App.jsx: StructuralPanel へ deselectRequest が渡されていない');
  const panel = readSrc('../structural/StructuralPanel.jsx');
  assert.ok(/<MemberListTab[^>]*deselectRequest=\{deselectRequest\}/.test(panel), 'StructuralPanel.jsx: MemberListTab へ deselectRequest が渡されていない');
  const tab = readSrc('../structural/MemberListTab.jsx');
  assert.ok(/if \(deselectRequest > 0\) setExpandedKey\(null\);/.test(tab), 'MemberListTab: deselectRequest で expandedKey を null にしていない');
  // 閉じたカードの選択解除は既存の「expandedKey==null → onSelectMembers([])」に乗る（memberSelection.test.js が固定）。
  assert.ok(/if \(expandedKey == null\) onSelectMembers\?\.\(\[\]\);/.test(tab), 'MemberListTab: expandedKey==null で選択集合を空にする effect が無い');
});
