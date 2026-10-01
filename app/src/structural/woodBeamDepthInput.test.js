// 在来木造の梁カード: 部材番号の入力不可と「梁成」「自動梁の対象」の表示だけの欄（ユーザー裁定2026-10-02）。
// 純関数の単体テスト＋MemberListTab.jsx のソース検査（.jsx は node:test から import できないため。
// 前例: manualMemberAddWiring.test.js）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stripCommentLines, extractFunctionBody } from '../uiBusySourceScan.js';
import { isMemberNumberLocked } from './memberCatalog.js';
import { showsWoodBeamDepthFields, woodBeamDepthOptions, woodBeamDepthFieldView } from './woodBeamDepthInput.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from './structureRules.js';
import { makeBeam, makeColumn } from './memberTestFixtures.js';

const WOOD_CTX = { woodFixedSection: true };

test('部材番号の入力可否: 在来の梁は不可・在来の基礎梁は可・非在来の梁は可・在来の柱は可', () => {
  assert.equal(isMemberNumberLocked(makeBeam('b1', 'WOOD-120x240', { role: 'primary' }), 'beamMap', WOOD_CTX), true);
  assert.equal(isMemberNumberLocked(makeBeam('b2', 'WOOD-120x240', { role: 'secondary' }), 'beamMap', WOOD_CTX), true);
  assert.equal(isMemberNumberLocked(makeBeam('b3', 'RC-300x300', { role: 'foundation' }), 'beamMap', WOOD_CTX), false, '基礎梁は断面が構造算定で決まり成の自動算定の対象外');
  assert.equal(isMemberNumberLocked(makeBeam('b4', 'STEEL-H', { role: 'primary' }), 'beamMap', { woodFixedSection: false }), false);
  assert.equal(isMemberNumberLocked(makeBeam('b5', 'STEEL-H', { role: 'primary' }), 'beamMap', undefined), false);
  assert.equal(isMemberNumberLocked(makeColumn('c1', 'WOOD-120x120'), 'columnMap', WOOD_CTX), false, '柱は対象外');
});

test('梁成の欄を出す条件: 在来・beamMap・主構造の材種・成の自動更新 role', () => {
  const wood = rulesFor(TRADITIONAL_WOOD_STRUCTURE);
  const beam = makeBeam('b1', 'WOOD-120x240', { materialType: wood.baseMaterial, role: 'primary' });
  assert.equal(showsWoodBeamDepthFields('beamMap', beam, wood), true);
  assert.equal(showsWoodBeamDepthFields('beamMap', { ...beam, role: 'secondary' }, wood), true);
  assert.equal(showsWoodBeamDepthFields('beamMap', { ...beam, role: 'floor' }, wood), true);
  assert.equal(showsWoodBeamDepthFields('beamMap', { ...beam, role: 'foundation' }, wood), false);
  assert.equal(showsWoodBeamDepthFields('beamMap', { ...beam, role: 'eaves' }, wood), false);
  assert.equal(showsWoodBeamDepthFields('beamMap', { ...beam, materialType: 'STEEL' }, wood), false);
  assert.equal(showsWoodBeamDepthFields('columnMap', beam, wood), false);
  assert.equal(showsWoodBeamDepthFields('beamMap', beam, rulesFor(UNSPECIFIED_STRUCTURE)), false, '在来でない主構造');
});

test('woodBeamDepthOptions: 幅ごとの昇順・重複なし・幅が非数なら空', () => {
  const o120 = woodBeamDepthOptions(120);
  assert.deepEqual(o120, [120, 150, 180, 210, 240, 270, 300, 330, 360]);
  assert.deepEqual(woodBeamDepthOptions(105), [105, 120, 150, 180, 210, 240, 270, 300, 330, 360]);
  assert.deepEqual(woodBeamDepthOptions(90).slice(0, 2), [90, 120]);
  for (const bad of [NaN, null, undefined, '120', 0, -120, Infinity, 100]) {
    assert.deepEqual(woodBeamDepthOptions(bad), [], `幅=${String(bad)} は空`);
  }
});

test('woodBeamDepthFieldView: 梁成（手入力なし・有効・無効）', () => {
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'auto' }, 120).depthValue, null, 'M なし→自動');
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'auto', woodManualDepthMm: null }, 120).depthValue, null);
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'auto', woodManualDepthMm: 360 }, 120).depthValue, 360, '有効な M→その値');
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'auto', woodManualDepthMm: 120 }, 120).depthValue, 120, '幅ちょうどは有効');
  for (const bad of [0, 100, NaN, -1, '360', Infinity]) {
    assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'auto', woodManualDepthMm: bad }, 120).depthValue, null, `M=${String(bad)} は自動`);
  }
  assert.equal(woodBeamDepthFieldView({ woodManualDepthMm: 360 }, NaN).depthValue, null, '幅が非数なら自動');
});

test('woodBeamDepthFieldView: 自動梁の対象（auto→自動、locked・calculated→固定）', () => {
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'auto' }, 120).autoTargetValue, 'auto');
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'locked' }, 120).autoTargetValue, 'locked');
  assert.equal(woodBeamDepthFieldView({ dimensionStatus: 'calculated' }, 120).autoTargetValue, 'locked');
});

// ---- MemberListTab.jsx の配線（ソース検査。コメント行を除き、1行まるごと一致で見る）----
const stripped = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'MemberListTab.jsx'), 'utf8'));
function wholeLineCount(line) {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (stripped.match(new RegExp(`^\\s*${escaped}$`, 'gm')) || []).length;
}

test('【配線】部材番号欄の disabled と確定処理の入口が isMemberNumberLocked の結果に結び付く', () => {
  assert.equal(wholeLineCount('const memberNumberLocked = isMemberNumberLocked(representative, group.mapName, fieldCtx);'), 1);
  assert.equal(wholeLineCount('disabled={readOnly || memberNumberLocked}'), 1, '部材番号 input の disabled');
  // 拒否は関数本体の最初の文であること（別の関数へ移す・ブロックコメントで囲む変異を落とす）。
  const firstStatement = name => {
    const lines = extractFunctionBody(stripped, `function ${name}(`).split('\n').map(l => l.trim()).filter(Boolean);
    assert.equal(lines[0], '{', `${name} の本体`);
    return lines[1];
  };
  assert.equal(firstStatement('commitManualNumber'),
    'if (memberNumberLocked) { setManualDraft(null); return; } // 在来木造の梁は台帳へ何も書かない（入口の拒否）', 'commitManualNumber の入口');
  assert.equal(firstStatement('handleManualFocus'), 'if (memberNumberLocked) return;', 'handleManualFocus の入口');
});

test('【配線】梁成・自動梁の対象の選択欄は disabled で、確定処理（onChange）を持たない', () => {
  assert.equal(wholeLineCount('value={woodBeamView.depthValue ?? \'\'}'), 1);
  assert.equal(wholeLineCount('value={woodBeamView.autoTargetValue}'), 1);
  // 2つの select ブロックを丸ごと取り出し、disabled があり onChange が無いことを見る。
  const blocks = [...stripped.matchAll(/<select\n\s*value=\{woodBeamView\.[\s\S]*?<\/select>/g)].map(m => m[0]);
  assert.equal(blocks.length, 2, '梁成・自動梁の対象の select ブロック');
  for (const b of blocks) {
    assert.equal((b.match(/^\s*disabled$/gm) || []).length, 1, 'select に disabled が1行ある');
    assert.ok(!/onChange/.test(b), 'select に確定処理 onChange が無い');
  }
  assert.equal(wholeLineCount('const showWoodBeamDepthFields = showsWoodBeamDepthFields(group.mapName, representative, rulesFor(structure));'), 1);
});
