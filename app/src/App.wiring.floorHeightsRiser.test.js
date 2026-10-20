// 階設定表 S8: 蹴上の確認・最高の軒の高さ・数値欄の印の配線テスト（ソース文字列を読む方式）と、印の一時状態。
// 確認は関門（runBusy）の中でユーザーの回答を待たない不変条件（.claude/floor-design.md の uiBusy）に従い、ダイアログ内で
// onConfirm（→ guardUi(runFloorHeights)）の前に済ませる。「いいえ」は確定しない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Project } from './core.js';
import { readAppSrc, stripCommentLines, extractFunctionBody } from './uiBusySourceScan.js';

const src = (rel) => stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8'));
const dialogCode = () => src('ui/FloorSettingsDialog.jsx');
const panelCode = () => src('finish/stair/StairPanel.jsx');

function lineIndexes(code, res) {
  let prev = -1;
  return res.map(re => {
    const m = re.exec(code);
    assert.ok(m, `${re} が1行まるごとの形で見つからない`);
    assert.ok(m.index > prev, `${re} の位置が順序に反する`);
    prev = m.index;
    return m.index;
  });
}

test('【配線】ダイアログ: OK → 不正値は抜ける → 蹴上の変化を求める → あれば確認表示して抜ける → 無ければ onConfirm の順', () => {
  const code = dialogCode();
  const start = code.indexOf('function handleConfirm() {');
  const end = code.indexOf('function handleKeyDown(e) {');
  assert.ok(start >= 0 && end > start, 'handleConfirm が切り出せない');
  lineIndexes(code.slice(start, end), [
    /^\s*if \(!view\.ok\) return;\s*$/m,
    /^\s*const edit = computeFloorHeightEdit\(planes, draft, topHeightMm, glBelow1FlMm\);\s*$/m,
    /^\s*const risers = stairRiserChangesForEdit\(stairItems, planes, edit\.updates\);\s*$/m,
    /^\s*if \(risers\.length > 0\) \{ setPendingRisers\(risers\); return; \}\s*$/m,
    /^\s*onConfirm\(draft\);\s*$/m,
  ]);
});

test('【配線】ダイアログ: onConfirm の呼び出しは「蹴上の変化が無いとき」と「はい」の2か所だけ。いいえは確認を閉じるだけ', () => {
  const code = dialogCode().split('\n').filter(l => !/^\s*(\*|\/\*)/.test(l)).join('\n'); // ブロックコメントの行を除く
  assert.equal((code.match(/onConfirm\(draft\)/g) ?? []).length, 2, 'onConfirm(draft) は2か所');
  assert.match(code, /^\s*<button className="cl-dialog-btn cl-dialog-btn--cancel" autoFocus onClick=\{\(\) => setPendingRisers\(null\)\}>いいえ<\/button>\s*$/m, 'いいえ');
  assert.match(code, /^\s*<button className="cl-dialog-btn cl-dialog-btn--ok" onClick=\{\(\) => onConfirm\(draft\)\}>はい<\/button>\s*$/m, 'はい');
  assert.match(code, /^\s*\{pendingRisers && \(\s*$/m, '確認ブロックの条件行');
  assert.match(code, /^\s*\{pendingRisers \? \(\s*$/m, '確認中のボタン切替の行');
});

test('【配線】ダイアログ: 値を変えたら確認をやり直す（setHeight・setGl が確認待ちを捨てる）', () => {
  const code = dialogCode();
  const h = code.slice(code.indexOf('function setHeight('), code.indexOf('function setGl('));
  const g = code.slice(code.indexOf('function setGl('), code.indexOf('function handleConfirm()'));
  assert.match(h, /^\s*setPendingRisers\(null\);.*$/m);
  assert.match(g, /^\s*setPendingRisers\(null\);\s*$/m);
});

test('【配線】ダイアログ: 最高軒高は欄と同じ view から maxEaveHeightMm で求め、図の左の寸法の文字として渡す', () => {
  const code = dialogCode();
  lineIndexes(code, [
    /^\s*const view = floorSettingsRows\(planes, draft, topHeightMm, glBelow1FlMm\);\s*$/m,
    /^\s*const maxEave = maxEaveHeightMm\(planes, view, leanToPlaneIds\);\s*$/m,
    /^\s*const figure = layoutFloorSettingsFigure\(sectionDiagramModel\(planes, view\), \{ maxEaveMm: maxEave \}\);\s*$/m,
  ]);
  // 描画部（FigureSvg。コンポーネントより前に定義）は左の寸法の text をそのまま書く
  assert.match(code, /^\s*<text x=\{figure\.leftDim\.textX\} y=\{figure\.leftDim\.yMid \+ 12\}.*>\{figure\.leftDim\.text\}<\/text>\s*$/m);
});

test('【配線】runFloorHeights: ユーザーの回答を待たない（確認ダイアログ類を呼ばない）。階段の表示名だけ渡す', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function runFloorHeights');
  assert.ok(!/setFloorConfirm|setChoiceDlg|window\.confirm|await new Promise/.test(body), '関門の内側（呼び出し先）でユーザーの回答を待ってはいけない');
  assert.match(body, /^\s*stairItems: floorSettingsDlg\?\.stairItems,.*$/m);
  // 蹴上の確認は runBusy（withFloorOpUndo）より前＝ダイアログの onConfirm より前に済んでいる
  assert.ok(body.indexOf("withFloorOpUndo('階高の変更'") > 0 && !body.includes('pendingRisers'));
});

test('【配線】runFloorHeights: 通知と印は withFloorOpUndo の await の後（成功後）にだけ。applyFloorOrderChange の戻り値 riserChanges を使う', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function runFloorHeights');
  lineIndexes(body, [
    /^\s*let riserChanges = \[\];\s*$/m,
    /^\s*await withFloorOpUndo\('階高の変更', async \(\) => \{\s*$/m,
    /^\s*const applied = await applyFloorOrderChange\(project, \{\s*$/m,
    /^\s*riserChanges = applied\.riserChanges;\s*$/m,
    /^\s*afterCommit: async \(\) => \{\s*$/m,
    /^\s*announceRiserChanges\(project, riserChanges, floorOrderUi\(\)\.notify\);\s*$/m,
  ]);
  // 通知・dirty・図の作り直しは afterCommit のブロックの中（＝withFloorOpUndo の runBusy の中で await される）にあり、
  // withFloorOpUndo の呼び出しの後（関門の外）には何も残らない
  const ac = body.indexOf('afterCommit: async () => {');
  const acEnd = body.indexOf('\n      },', ac);
  const block = body.slice(ac, acEnd);
  assert.ok(ac > 0 && acEnd > ac, 'afterCommit ブロックが切り出せない');
  for (const s of ['announceRiserChanges(', 'markDirty();', 'await rebuildFiguresAfterHeights();']) assert.ok(block.includes(s), `afterCommit の中に ${s} が無い`);
  const tail = body.slice(body.indexOf('\n    });', acEnd) + '\n    });'.length).replace(/\s*\}\s*$/, '').trim();
  assert.equal(tail, '', `withFloorOpUndo の後に関門外の処理が残っている: ${tail}`);
  // 追従の中（floorOrderChange.js）では通知・印を出さない
  const follow = stripCommentLines(fs.readFileSync(path.resolve(import.meta.dirname, 'floorOrderChange.js'), 'utf8'));
  assert.ok(!follow.includes('markRiserAutoUpdated') && !follow.includes('ui.notify(riserChange'), '追従の中で印・通知を出してはいけない');
  assert.match(follow, /^\s*ctx\.state\.riserChanges = all;\s*$/m);
});

test('【配線】構造モードの確定(F2): 確定の前に編集用 peek を止め(prepare)、確定後・undo/redo 後に合成を作り直す', () => {
  const src = readAppSrc();
  const wf = extractFunctionBody(src, 'async function withFloorOpUndo');
  lineIndexes(wf, [
    /^\s*await structuralSync\.whenIdle\(\);\s*$/m,
    /^\s*await prepare\?\.\(\);.*$/m,
    /^\s*const before = await collectFloorBytes\(\);\s*$/m,
  ]);
  const stop = extractFunctionBody(src, 'async function stopStructuralEditablePeek');
  assert.match(stop, /^\s*if \(appModeRef\.current === 'structure'\) await figureBindingManager\.deactivate\(\);\s*$/m);
  const rb = extractFunctionBody(src, 'async function rebuildStructuralAfterHeights');
  lineIndexes(rb, [
    /^\s*await figureBindingManager\.deactivate\(\);\s*$/m,
    /^\s*if \(appModeRef\.current !== 'structure' \|\| !project\.activeGraph\) return;\s*$/m,
    /^\s*setStructComposition\(await rebuildStructuralBinding\(project\.activeGraph, project\)\);\s*$/m,
  ]);
  assert.ok(!rb.includes('runStructuralModeSetup'), '作り直しは undo を積む runStructuralModeSetup を使わない');
  const re = extractFunctionBody(src, 'async function rebuildFiguresAfterHeights');
  assert.match(re, /^\s*if \(m === 'structure'\) await rebuildStructuralAfterHeights\(\);\s*$/m, '関門の中で await する（void にしない）');
  assert.ok(!src.includes('void rebuildStructuralAfterHeights'));
});

test('【配線】afterApply・afterCommit はすべて await される（undo・redo・巻き戻し・確定直後）', () => {
  const src = readAppSrc();
  const wf = extractFunctionBody(src, 'async function withFloorOpUndo');
  assert.equal((wf.match(/^\s*await afterApply\?\.\(\);\s*$/gm) ?? []).length, 2, 'undo と redo の afterApply');
  assert.equal((wf.match(/^\s*await afterCommit\?\.\(\);\s*$/gm) ?? []).length, 1, '確定直後の afterCommit');
  assert.ok(wf.indexOf('undoManager.push(') < wf.indexOf('await afterCommit?.();'), 'afterCommit は undoManager.push の後');
  assert.ok(wf.indexOf('if (!hasChanges) return;') < wf.indexOf('await afterCommit?.();'), '変更が無いときは afterCommit を呼ばない');
  const ops = fs.readFileSync(path.resolve(import.meta.dirname, 'floorOps.js'), 'utf8');
  const rb = extractFunctionBody(ops, 'export async function rollbackFloorOp');
  assert.match(rb, /^\s*await afterApply\?\.\(\);.*$/m, 'rollbackFloorOp の finally で afterApply を await');
});

test('【配線】ダイアログ(F4): 確認中の Escape・キャンセルは「いいえ」と同じく表に戻す（確認中でなければ閉じる）', () => {
  const code = dialogCode();
  assert.match(code, /^\s*onCancel: closeDialog\s*\}\) \{\s*$|onCancel: closeDialog \}\) \{\s*$/m);
  assert.match(code, /^\s*const onCancel = \(\) => \(pendingRisers \? setPendingRisers\(null\) : closeDialog\(\)\);\s*$/m);
  assert.match(code, /^\s*if \(e\.key === 'Escape'\) onCancel\(\);\s*$/m, 'ダイアログ内の Escape');
  assert.match(code, /^\s*useEffect\(\(\) => \{ cancelRef\.current = onCancel; \}\);\s*$/m, 'ダイアログ外の Escape（cancelRef）も同じ onCancel');
  assert.match(code, /^\s*if \(e\.key === 'Escape'\) \{ cancelRef\.current\(\); return; \}\s*$/m);
});

test('【配線】FloorSettingsDialog へ stairItems・leanToPlaneIds を渡す', () => {
  const code = stripCommentLines(readAppSrc());
  assert.match(code, /^\s*stairItems=\{floorSettingsDlg\.stairItems\}\s*$/m);
  assert.match(code, /^\s*leanToPlaneIds=\{floorSettingsDlg\.leanToPlaneIds\}\s*$/m);
});

test('【配線】StairPanel: 蹴上欄の編集で印を消す。印は今の蹴上が更新後の値と一致する間だけ', () => {
  const code = panelCode();
  const start = code.indexOf('const num = (field) => (e) => {');
  const block = code.slice(start, code.indexOf('const fieldUndoProps', start));
  assert.match(block, /^\s*if \(field === 'riser'\) project\?\.clearRiserAutoUpdated\(riserKey\);.*$/m);
  assert.match(code, /^\s*const riserAutoUpdated = markedRiser !== undefined && dims\.riser != null && Math\.abs\(dims\.riser - markedRiser\) < 1e-6;\s*$/m);
  assert.match(code, /^\s*data-riser-auto-updated=\{riserAutoUpdated \|\| undefined\}\s*$/m);
});

test('印は保存しない一時状態: Project の in-memory の Map。mark で立ち、clear で消え、別の Project には無い', () => {
  const project = new Project('proj', 'test');
  assert.equal(project.riserAutoUpdated.size, 0);
  project.markRiserAutoUpdated([['p1:s1', 220], ['p2:s2', 210]]);
  assert.equal(project.riserAutoUpdated.get('p1:s1'), 220);
  project.clearRiserAutoUpdated('p1:s1');
  assert.equal(project.riserAutoUpdated.has('p1:s1'), false, '欄の編集で消える');
  assert.equal(project.riserAutoUpdated.get('p2:s2'), 210);
  assert.equal(new Project('other', 'x').riserAutoUpdated.size, 0, '文書を開き直す（Project を作り直す）と消える');
  project.clearRiserAutoUpdated('zzz'); // 無いキーを消しても落ちない
});

test('印は FBS に載らない: 保存側（graphFbs・graphSnapshot）は riserAutoUpdated を参照しない', () => {
  for (const rel of ['schema/graphFbs.js', 'graphSnapshot.js', 'storage/documentFile.js']) {
    assert.ok(!fs.readFileSync(path.resolve(import.meta.dirname, rel), 'utf8').includes('riserAutoUpdated'), rel);
  }
});
