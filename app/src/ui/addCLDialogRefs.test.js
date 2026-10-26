// ui/addCLDialogRefs.js（CL追加ダイアログの参照の既定・畳み込み）の単体テスト＋AddCLDialog.jsx の配線のソース走査。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Discipline, AddCLOptionKind } from '../core/constants.js';
import { initialRef, distStrForRef, foldRefForConfirm, isAddDialogRefCandidate } from './addCLDialogRefs.js';
import { CL_KINDS, APP_MODES, isRenderTarget, isAddDialogSnapOnlyRef } from '../core/centerLineKindPolicy.js';
import { rulesFor, TRADITIONAL_WOOD_STRUCTURE, UNSPECIFIED_STRUCTURE } from '../structural/structureRules.js';

// ---- isAddDialogRefCandidate（吸着専用の参照を S造の階だけに限る。S3-5 S3） ----
const duckCL = (kind) => {
  const base = { centerLineType: 'vertical', labeled: kind === 'struct' };
  switch (kind) {
    case 'struct':  return { ...base, discipline: Discipline.STRUCT, lineType: 'center' };
    case 'center':  return { ...base, discipline: Discipline.ARCH, lineType: 'center' };
    case 'aux':     return { ...base, discipline: Discipline.ARCH, lineType: 'dashed' };
    case 'beam':    return { ...base, discipline: Discipline.FUSE, lineType: 'center' };
    case 'ceiling': return { ...base, discipline: Discipline.CEILING, lineType: 'center' };
    default: throw new Error(`未知のCL種別: ${kind}`);
  }
};

test('isAddDialogRefCandidate: 5種別×全appMode×主構造。S造は S3-3 の式（描画対象 ∪ 吸着専用）、S造以外は描画対象のみ', () => {
  const structures = { 'S造': true, [TRADITIONAL_WOOD_STRUCTURE]: false, 'RC造(ラーメン)': false, 'SRC造': false, [UNSPECIFIED_STRUCTURE]: false };
  for (const [structure, isSteel] of Object.entries(structures)) {
    const rules = rulesFor(structure);
    assert.equal(rules.manualBeamAxisOnArchLines, isSteel, `前提 ${structure}`);
    for (const appMode of APP_MODES) {
      for (const kind of CL_KINDS) {
        const cl = duckCL(kind);
        const expected = isSteel
          ? isRenderTarget(cl, appMode) || isAddDialogSnapOnlyRef(cl, appMode)
          : isRenderTarget(cl, appMode);
        assert.equal(isAddDialogRefCandidate(cl, appMode, rules), expected, `${structure} appMode=${appMode} kind=${kind}`);
      }
    }
  }
  // 要点: 構造モードの中心線はS造だけ候補に入る
  assert.equal(isAddDialogRefCandidate(duckCL('center'), 'structure', rulesFor('S造')), true);
  assert.equal(isAddDialogRefCandidate(duckCL('center'), 'structure', rulesFor(TRADITIONAL_WOOD_STRUCTURE)), false);
});

test('【失敗系】isAddDialogRefCandidate: rules が無い（undefined/null）と throw する', () => {
  assert.throws(() => isAddDialogRefCandidate(duckCL('center'), 'structure', undefined), /rules が必要/);
  assert.throws(() => isAddDialogRefCandidate(duckCL('center'), 'structure', null), /rules が必要/);
});

const center = (id, value) => ({ id, value, discipline: Discipline.ARCH, lineType: 'center', labeled: false });
const aux    = (id, value) => ({ id, value, discipline: Discipline.ARCH, lineType: 'dashed', labeled: false });
const grid   = (id, value) => ({ id, value, discipline: Discipline.STRUCT, lineType: 'center', labeled: true });
// 構造モードの柱芯の合成CL（App.jsx buildColumnAxisRefs。実CLではないので discipline/lineType を持たない）
const colAxis = (id, clId, value, axisOffset) => ({ id: `colaxis:${id}`, optionKind: AddCLOptionKind.COLUMN_AXIS, clId, value, axisOffset, label: '柱芯' });

test('initialRef: 吸着専用（構造モードの中心線）が最寄りなら、参照はその中心線・距離は 0', () => {
  const c = center('c1', 3300);
  assert.deepEqual(initialRef([c, grid('g1', 0), grid('g2', 6000)], 3290, 'structure', 1), { refId: 'c1', distStr: '0' });
});

test('initialRef: 通り芯が最寄りなら従来どおり（その通り芯・実際の距離）。同距離は先頭', () => {
  assert.deepEqual(initialRef([center('c1', 3300), grid('g1', 3000)], 3050, 'structure', 1), { refId: 'g1', distStr: '50' });
  // 同距離（先頭の勝ち）
  assert.deepEqual(initialRef([grid('g1', 1000), grid('g2', 2000)], 1500, 'structure', 1), { refId: 'g1', distStr: '500' });
});

test('initialRef: 構造モード以外では中心線も従来どおり実際の距離（吸着専用にならない）', () => {
  for (const mode of ['floorplan', 'finish', 'opening', 'ceiling']) {
    assert.deepEqual(initialRef([center('c1', 3300)], 3290, mode, 1), { refId: 'c1', distStr: '10' }, mode);
  }
});

test('initialRef: 構造モードでも補助線は吸着専用ではない（実際の距離）', () => {
  assert.deepEqual(initialRef([aux('a1', 3300)], 3290, 'structure', 1), { refId: 'a1', distStr: '10' });
});

test('initialRef: 柱芯の合成CL（種別が既定の center に落ちる形）は吸着専用にしない（実際の距離）', () => {
  assert.deepEqual(initialRef([colAxis('k1', 'g1', 3300, 60)], 3290, 'structure', 1), { refId: 'colaxis:k1', distStr: '10' });
});

test('【失敗系】印（optionKind）の無い clId つきの選択肢・未知の optionKind は推定せず throw する（柱芯の作り忘れで黙って吸着専用に落ちない）', () => {
  const noMark = { id: 'colaxis:k1', clId: 'g1', value: 3300, axisOffset: 60 };
  assert.throws(() => distStrForRef(noMark, 3290, 'structure', 1), /optionKind がありません/);
  assert.throws(() => foldRefForConfirm(noMark, 'structure', { dist: 0, dir: 1 }), /optionKind がありません/);
  assert.throws(() => distStrForRef({ ...noMark, optionKind: 'bogus' }, 3290, 'structure', 1), /未知の optionKind: bogus/);
});

test('AddCLOptionKind は凍結された enum で、App.jsx buildColumnAxisRefs が柱芯の選択肢に印を付ける', () => {
  assert.ok(Object.isFrozen(AddCLOptionKind));
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../App.jsx'), 'utf8');
  assert.match(src, /^\s*optionKind: AddCLOptionKind\.COLUMN_AXIS,\s*$/m);
});

test('【失敗系】initialRef: 選択肢0件は絶対座標（参照なし・sign×座標。Y軸は符号反転）', () => {
  assert.deepEqual(initialRef([], 2500, 'structure', 1), { refId: '', distStr: '2500' });
  assert.deepEqual(initialRef([], -2500, 'structure', -1), { refId: '', distStr: '2500' });
});

test('distStrForRef: 参照を選び直したときも吸着専用なら 0、通り芯なら距離、参照なしなら絶対座標', () => {
  assert.equal(distStrForRef(center('c1', 3300), 3290, 'structure', 1), '0');
  assert.equal(distStrForRef(grid('g1', 3000), 3290, 'structure', 1), '290');
  assert.equal(distStrForRef(null, -3290, 'structure', -1), '3290');
});

test('foldRefForConfirm: 吸着専用の参照は絶対座標（refId null・refOffset null）に畳む', () => {
  assert.deepEqual(foldRefForConfirm(center('c1', 3300), 'structure', { dist: 0, dir: 1 }), { refId: null, refOffset: null });
  // 距離を足しても吸着専用なら参照は残さない（previewWorld は呼び出し側が持つ）
  assert.deepEqual(foldRefForConfirm(center('c1', 3300), 'structure', { dist: 100, dir: -1 }), { refId: null, refOffset: null });
});

test('foldRefForConfirm: 通り芯・構造モード以外の中心線は従来どおり id＋符号つき距離', () => {
  assert.deepEqual(foldRefForConfirm(grid('g1', 3000), 'structure', { dist: 290, dir: 1 }), { refId: 'g1', refOffset: 290 });
  assert.deepEqual(foldRefForConfirm(center('c1', 3300), 'floorplan', { dist: 10, dir: -1 }), { refId: 'c1', refOffset: -10 });
});

test('foldRefForConfirm: 柱芯は元の通り芯 clId＋（柱芯偏芯量＋距離×方向）に畳む（移す前の AddCLDialog と同じ式）', () => {
  const ref = colAxis('k1', 'g1', 3300, 60);
  const legacy = (refCL, dist, dir) => ({ refId: refCL.clId, refOffset: refCL.axisOffset + dist * dir });
  for (const [dist, dir] of [[0, 1], [10, -1], [250, 1]]) {
    assert.deepEqual(foldRefForConfirm(ref, 'structure', { dist, dir }), legacy(ref, dist, dir), `dist=${dist} dir=${dir}`);
  }
});

test('【失敗系】foldRefForConfirm: 参照なし（選択肢0件・なし）は絶対座標', () => {
  assert.deepEqual(foldRefForConfirm(null, 'structure', { dist: 2500, dir: null }), { refId: null, refOffset: null });
});

test('【配線】AddCLDialog.jsx: 既定の参照・参照の選び直し・確定の畳み込みは addCLDialogRefs.js 経由（インラインの最寄り計算・柱芯の畳みが残っていない）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'AddCLDialog.jsx'), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\{?\/\*|\*)/.test(l)).join('\n');
  assert.match(code, /import \{ initialRef, distStrForRef, foldRefForConfirm \} from '\.\/addCLDialogRefs\.js';/);
  assert.match(code, /initialRef\(allOptions, worldCoord, appMode, sign\)/);
  assert.match(code, /setDistStr\(distStrForRef\(cl, worldCoord, appMode, sign\)\)/);
  assert.match(code, /foldRefForConfirm\(refCL, appMode, \{ dist, dir \}\)/);
  assert.doesNotMatch(code, /axisOffset/, '柱芯の畳み（axisOffset）が AddCLDialog.jsx に残っている');
  assert.doesNotMatch(code, /\.clId/, 'clId によるダック型の柱芯判定が AddCLDialog.jsx に残っている');
  assert.doesNotMatch(code, /allOptions\.reduce/, '最寄りの計算が AddCLDialog.jsx に残っている');
});
