// S造スラブ指定（ベイ選択）の配線テスト。.jsx / react 依存のファイルは node:test から import できないため、
// ソーステキストを走査して固定する（前例: commonInfoTab.wiring.test.js・manualMemberAddWiring.test.js）。
// コメント文への誤一致を避けるため、ブロックコメントと行コメントを除いてから照合する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const read = rel => stripComments(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));

test('【配線】usePointerInteraction: ベイタップの分岐が梁タップ（shouldFireMemberTap）より前にあり、その中で onMemberDeselect・onMemberClick を呼ばない', () => {
  const code = read('../interaction/usePointerInteraction.js');
  const bayAt = code.indexOf('if (shouldFireBayTap(bayTapSignals)) {');
  const memberAt = code.indexOf('} else if (shouldFireMemberTap({');
  assert.ok(bayAt >= 0, 'shouldFireBayTap の分岐が無い');
  assert.ok(memberAt > bayAt, '梁タップの分岐は else if でベイ分岐の後ろに繋がっている（ベイ選択中は梁タップ・空白タップへ流さない）');
  const bayBranch = code.slice(bayAt, memberAt);
  assert.ok(/modeRef\.current\.toggleBay\(bayKey\)/.test(bayBranch), 'ベイ分岐は toggleBay を呼ぶ');
  assert.ok(/bayKeyAtKonvaTarget\(e\.target\)/.test(bayBranch));
  assert.ok(!/onMemberDeselect|onMemberClick/.test(bayBranch), '選択中の空白タップで選択解除（カードを閉じる）を発火させない');
  assert.ok(/bayPickActive: !!modeRef\.current\?\.bayPick/.test(code), '成立条件にトグルの状態を渡す');
});

test('【配線】StructuralLayer: bay-hit の矩形は bayPick が非 null のときだけ描き、それ以外の図形は listening しない', () => {
  const code = read('../renderer/StructuralLayer.jsx');
  assert.equal((code.match(/name="bay-hit"/g) ?? []).length, 1);
  const at = code.indexOf('{bayPick && (');
  const hit = code.indexOf('name="bay-hit"');
  assert.ok(at >= 0 && hit > at && hit - at < 400, 'bay-hit は {bayPick && ( の直下');
  assert.ok(/bayKey=\{key\}/.test(code));
  assert.equal((code.match(/^\s*listening\s*$/gm) ?? []).length, 1, '属性だけの listening（真）は bay-hit の1か所だけ（他は listening={false}）');
  assert.ok(/name="bay-hit"[\s\S]*?\n\s*listening\s*\n\s*\/>/.test(code), 'その1か所が bay-hit の Rect');
  assert.ok(/bayPick = null/.test(code), 'bayPick の既定値は null（選択中でなければ何も描かない）');
  assert.ok(/bayPick=\{mode\?\.bayPick \?\? null\}/.test(read('../renderer/SceneLayers.jsx')), 'SceneLayers が mode.bayPick を渡す');
});

test('【配線】MemberListTab: 「スラブにする」「指定を外す」は onStructureChanged（再計算＋undo 1 エントリ）の閉包の中で行い、openingRects は選択開始時の値を渡す', () => {
  const code = read('MemberListTab.jsx');
  assert.equal((code.match(/onStructureChanged\(\(\) => assignSteelSlabBays\(graph, project, keys, \{ openingRects: pick\.openingRects \}\)\)/g) ?? []).length, 1);
  assert.equal((code.match(/onStructureChanged\(\(\) => releaseSteelSlabBays\(graph, keys\)\)/g) ?? []).length, 1);
  assert.equal((code.match(/assignSteelSlabBays\(/g) ?? []).length, 1, 'graph への直接書込みはこの1か所だけ');
  assert.equal((code.match(/releaseSteelSlabBays\(/g) ?? []).length, 1);
  assert.ok(/group\.key === 'slab' && structureMode && !readOnly/.test(code), 'スラブ見出しだけに出す');
  assert.ok(/prepareSteelSlabPick\(\{ graph, project, belowGraph: composition\?\.graphForCategory\('columnMap'\) \?\? null \}\)/.test(code));
  assert.ok(/useEffect\(\(\) => \(\) => structureMode\?\.cancelBayPick\(\), \[structureMode\]\)/.test(code), 'タブを閉じたら選択状態も閉じる');
});

test('【配線】App.jsx: 構造パネルへ構造モードの状態（startBayPick を持つ mode）だけを渡す', () => {
  const code = read('../App.jsx');
  assert.ok(/structureMode=\{appMode === 'structure' && mode\?\.startBayPick \? mode : null\}/.test(code));
});
