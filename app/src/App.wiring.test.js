// App.jsx（部屋名ダイアログ・仕上げ表内部タブのカード）の配線不変条件。.jsx は node:test から
// 単体 import できないため、ソーステキスト検査で固定する（finish/RoomNameInput.wiring.test.js と
// 同じ型。ブロックコメント・行コメントを除去してから検査する——team-lessons「ソース文字列を
// 正規表現で検査する配線テストが、コメント文にも一致して変異を見逃す」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, extractFunctionBody } from './uiBusySourceScan.js';

const filePath = path.resolve(import.meta.dirname, 'App.jsx');
const src = fs.readFileSync(filePath, 'utf8');

function stripComments(text) {
  const withoutBlockComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlockComments.split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

const codeOnly = stripComments(src);

// ステップ1（部屋編集の導線変更）: 部屋名ダイアログ（新規Room命名専用）と仕上げ表内部タブの
// カード（既存部屋編集）は同じ applyRoomNaming（applyNaming＋階段変換時のsyncUpperFloors）を使う。
test('【不変条件】RoomNameInput の onConfirm と FinishSidebar/FinishHalfModal の onApplyNaming は同じ applyRoomNaming を渡す', () => {
  assert.ok(/onConfirm=\{applyRoomNaming\}/.test(codeOnly),
    'RoomNameInput の onConfirm={applyRoomNaming} が見つからない');
  const onApplyNamingMatches = codeOnly.match(/onApplyNaming=\{applyRoomNaming\}/g) ?? [];
  assert.equal(onApplyNamingMatches.length, 2,
    `onApplyNaming={applyRoomNaming} は FinishSidebar/FinishHalfModal の2箇所のはず（実際: ${onApplyNamingMatches.length}）`);
});

test('【不変条件】RoomNameInput に onDelete を渡していない・deleteFromDialog を呼んでいない（削除ボタン廃止）', () => {
  assert.ok(!/onDelete=/.test(codeOnly), 'onDelete= が残っている');
  assert.ok(!/deleteFromDialog/.test(codeOnly), 'deleteFromDialog の呼び出しが残っている');
});

// T6: applyRoomNaming は floorHeightAbove(project, project.activePlane) を applyNaming の第3引数に
// 渡し、戻り値（convertedStair）が真のときだけ syncUpperFloors を lastNamingUndoEntry 付きで呼ぶ。
test('【不変条件・T6】applyRoomNaming は applyNaming(id, payload, floorHeight) の形でfloorHeightAboveの結果を渡す', () => {
  const startIdx = codeOnly.indexOf('function applyRoomNaming');
  assert.ok(startIdx >= 0, 'function applyRoomNaming が見つからない');
  const endIdx = codeOnly.indexOf('\n  }', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 4);
  assert.ok(/const floorHeight = floorHeightAbove\(project, project\.activePlane\);/.test(block),
    'floorHeight を floorHeightAbove(project, project.activePlane) から求めていない');
  assert.ok(/modeRef\.current\?\.applyNaming\(id, payload, floorHeight\)/.test(block),
    'applyNaming(id, payload, floorHeight) の呼び出しが見つからない');
});

test('【不変条件・T6】applyRoomNaming は convertedStair が真のときだけ syncUpperFloors を lastNamingUndoEntry 付きで呼ぶ', () => {
  const startIdx = codeOnly.indexOf('function applyRoomNaming');
  const endIdx = codeOnly.indexOf('\n  }', startIdx);
  const block = codeOnly.slice(startIdx, endIdx + 4);
  assert.ok(/if \(convertedStair\) \{/.test(block),
    'if (convertedStair) { ガードが見つからない');
  const ifIdx = block.indexOf('if (convertedStair) {');
  const afterIf = block.slice(ifIdx);
  assert.ok(/const undoEntry = modeRef\.current\?\.lastNamingUndoEntry \?\? null;/.test(afterIf),
    'if (convertedStair) 内で lastNamingUndoEntry を読んでいない');
  assert.ok(/m\.syncUpperFloors\(project, project\.activeGraph, \{ undoEntry \}\)/.test(afterIf),
    'if (convertedStair) 内で syncUpperFloors(project, project.activeGraph, { undoEntry }) を呼んでいない');
});

// T7: 部屋名ダイアログが開いている間（namingRoomId有り）はFinishSidebar/FinishHalfModal（カード）を
// 描画しない。カード経由のapplyNamingが、開いている新規ダイアログの保留undo・選択順を消費しない前提。
test('【不変条件・T7】FinishSidebar/FinishHalfModal は !mode.namingRoomId のときだけ描画する', () => {
  assert.ok(/\{appMode === 'finish' && mode && !mode\.namingRoomId && \(/.test(codeOnly),
    "仕上げ表パネルの描画条件に appMode === 'finish' && mode && !mode.namingRoomId && ( が見つからない");
});

// ================================================================
// 昇降機の仕様追加 ステップ4・S4（QA指摘W1・W2）: installElevatorFromNaming の onApplied・
// project.equipmentIndex を埋める effect の配線。1行まるごとの形で固定する
// （team-lessons「行末コメントに元の式を残す変異・条件式を定数に差し替える変異」対応）。
// ================================================================

test('【配線・強化・W1】App.jsx: installElevatorFromNaming は onApplied: () => setFloorSyncTick(t => t + 1), を1行まるごとの形で渡す', () => {
  assert.match(src, /^\s*onApplied: \(\) => setFloorSyncTick\(t => t \+ 1\),\s*$/m,
    'onApplied: () => setFloorSyncTick(t => t + 1), が1行まるごとの形で見つからない');
});

test('【配線・強化・W2】App.jsx: project.equipmentIndexを埋めるeffectが project.replaceEquipmentIndex(entries) を1行まるごとの形でrunInActionの中から呼ぶ', () => {
  assert.match(src, /^\s*runInAction\(\(\) => project\.replaceEquipmentIndex\(entries\)\);\s*$/m,
    'runInAction(() => project.replaceEquipmentIndex(entries)); が1行まるごとの形で見つからない');
});

// QA指摘n1-a: aborted で message が無いとき（isStillValid の再確認による中断等）も、ダイアログが
// 無言で開いたままにならないよう既存の類似文言（ERR_ELEVATOR_FLOORS_CHANGED）で代用する。
test('【配線・強化・n1-a】App.jsx: installElevatorFromNaming は aborted のとき r.message ?? ERR_ELEVATOR_FLOORS_CHANGED を1行まるごとの形でトースト表示する', () => {
  assert.match(src, /^\s*setToast\(\{ msg: r\.message \?\? ERR_ELEVATOR_FLOORS_CHANGED, key: Date\.now\(\) \}\);\s*$/m,
    'setToast({ msg: r.message ?? ERR_ELEVATOR_FLOORS_CHANGED, key: Date.now() }); が1行まるごとの形で見つからない');
});

// QA指摘n1-b: commitActive がグラフを変更した後に拒否・例外・undoエントリnullのいずれかに
// なった場合、設置階も確定前のスナップショットへ戻してから例外にする（上階の巻き戻しだけでは
// 設置階の変更済みグラフと食い違うため）。snapshotFinishState/restoreFinishState（finishUndo.jsの
// 既存の復元関数）を使っていることを固定する。
test('【配線・強化・n1-b】App.jsx: commitActive は snapshotFinishState(g) を先頭で採り、3つの失敗経路すべてで restoreFinishState(g, before) を呼んでから例外にする', () => {
  const startIdx = src.indexOf('const commitActive = (equipment) => {');
  assert.ok(startIdx >= 0, 'commitActive が見つからない');
  const endIdx = src.indexOf('\n      };', startIdx);
  const body = src.slice(startIdx, endIdx);
  assert.match(body, /const before = snapshotFinishState\(g\);/, 'before = snapshotFinishState(g) が見つからない');
  const restoreMatches = body.match(/runInAction\(\(\) => restoreFinishState\(g, before\)\);/g) ?? [];
  assert.equal(restoreMatches.length, 3,
    `restoreFinishState(g, before) の呼び出しは3箇所（例外・拒否・undoエントリnull）のはず（実際: ${restoreMatches.length}）`);
});

// ================================================================
// 昇降機の仕様追加 ステップ5（QA指摘T3・2026-09-30）: installElevatorFromNaming・
// deleteElevatorEquipment・changeElevatorUsage の3入口それぞれについて、onApplied・
// restoreFinishStateの件数・whenIdleの位置・abortedのトースト・失敗の識別コードを
// 個別に固定する（3入口のうち1回一致すれば合格、という形にしない——本体を個別に
// extractFunctionBodyで切り出し、入口ごとに別テストにする）。
// ================================================================

function escapeRegExpLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ELEVATOR_ENTRIES = [
  {
    name: 'installElevatorFromNaming',
    needle: 'async function installElevatorFromNaming',
    restoreFinishStateCount: 3, // 例外・拒否・undoエントリnull（n1-bのテストと同じ数）
    tagLine: 'throw tagElevatorOpFailure(err);', // 既定（設置）の識別コード・文言
    abortedConditionLine: "} else if (r.status === 'aborted') {", // rejected/installedとの分岐の途中
  },
  {
    name: 'deleteElevatorEquipment',
    needle: 'async function deleteElevatorEquipment',
    restoreFinishStateCount: 2, // 例外・undoエントリnull（deleteEquipmentにlastNamingRejection相当は無い）
    tagLine: 'throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_REMOVE_FAILED, message: ERR_ELEVATOR_REMOVE_FAILED_MESSAGE });',
    abortedConditionLine: "if (r.status === 'aborted') {", // 単独のif（rejected分岐は無い）
  },
  {
    name: 'changeElevatorUsage',
    needle: 'async function changeElevatorUsage',
    restoreFinishStateCount: 2, // 例外・undoエントリnull
    tagLine: 'throw tagElevatorOpFailure(err, { code: ERR_ELEVATOR_USAGE_FAILED, message: ERR_ELEVATOR_USAGE_FAILED_MESSAGE });',
    abortedConditionLine: "if (r.status === 'aborted') {", // 単独のif
  },
];

for (const entry of ELEVATOR_ENTRIES) {
  test(`【配線・強化・QA指摘T3】App.jsx: ${entry.name} はonApplied・restoreFinishState件数・whenIdleの位置・abortedトースト・失敗の識別を個別に満たす`, () => {
    const appSrc = readAppSrc();
    const body = extractFunctionBody(appSrc, entry.needle);

    assert.match(body, /^\s*onApplied: \(\) => setFloorSyncTick\(t => t \+ 1\),\s*$/m,
      `${entry.name}: onApplied: () => setFloorSyncTick(t => t + 1), が1行まるごとの形で見つからない`);

    const restoreMatches = body.match(/runInAction\(\(\) => restoreFinishState\(g, before\)\);/g) ?? [];
    assert.equal(restoreMatches.length, entry.restoreFinishStateCount,
      `${entry.name}: restoreFinishState(g, before) の呼び出し件数が想定と異なる（実際: ${restoreMatches.length}）`);

    const whenIdleIdx = body.indexOf('await structuralSync.whenIdle();');
    const importIdx = body.indexOf("await import('./finish/equipment/equipmentFloorSync.js');");
    assert.ok(whenIdleIdx >= 0 && importIdx >= 0 && whenIdleIdx < importIdx,
      `${entry.name}: structuralSync.whenIdle()の待ちがequipmentFloorSync.jsの動的importより前にあるはず`);

    assert.match(body, /^\s*setToast\(\{ msg: r\.message \?\? ERR_ELEVATOR_FLOORS_CHANGED, key: Date\.now\(\) \}\);\s*$/m,
      `${entry.name}: abortedのトースト行が1行まるごとの形で見つからない`);

    const tagLineRe = new RegExp(`^\\s*${escapeRegExpLiteral(entry.tagLine)}\\s*$`, 'm');
    assert.match(body, tagLineRe, `${entry.name}: 失敗の識別行（${entry.tagLine}）が1行まるごとの形で見つからない`);

    // abortedのトーストが「if (r.status === 'aborted') { ... }」の中にあることを、条件行の1行まるごと
    // 一致に加え、行の並び（条件行の直後がトースト行であること）で固定する——setToast(…)の行だけを
    // 見ると、条件を`if (false) {`に差し替える変異（トーストの行自体は変えない）を見逃すため。
    const bodyLines = body.split('\n');
    const condIdx = bodyLines.findIndex(l => l.trim() === entry.abortedConditionLine);
    assert.ok(condIdx >= 0,
      `${entry.name}: aborted分岐の条件行（${entry.abortedConditionLine}）が1行まるごとの形で見つからない`);
    const toastIdx = bodyLines.findIndex(
      l => l.trim() === "setToast({ msg: r.message ?? ERR_ELEVATOR_FLOORS_CHANGED, key: Date.now() });",
    );
    assert.ok(toastIdx >= 0, `${entry.name}: abortedのトースト行が見つからない`);
    assert.equal(toastIdx, condIdx + 1,
      `${entry.name}: aborted分岐の条件行の直後がトースト行であるはず（条件行:${condIdx}行目、トースト行:${toastIdx}行目）`);
  });
}

// 階追加時、階段同期→昇降機の複製→外壁内側の部屋の自動追加の順で呼ぶ（直下階に器具行があれば
// 新階へ複製する。複製できなかった器具があればトースト表示）。
test('【配線・強化】App.jsx: syncNewFloorFromSource は syncUpperFloorsAuto → copyElevatorsToNewFloor → addNewFloorRoomFromSource の順で呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function syncNewFloorFromSource');

  assert.match(body, /^\s*await syncUpperFloorsAuto\(project, sourceGraph\);\s*$/m,
    'await syncUpperFloorsAuto(project, sourceGraph); が1行まるごとの形で見つからない');
  assert.match(body, /^\s*const copied = await copyElevatorsToNewFloor\(\{ project, activeGraph: sourceGraph, newPlane \}\);\s*$/m,
    'copyElevatorsToNewFloor の呼び出し行が1行まるごとの形で見つからない');
  assert.match(body, /^\s*await addNewFloorRoomFromSource\(project, sourceGraph, newPlane, makeFloorName\(newStartFloor, 1\)\);\s*$/m,
    'addNewFloorRoomFromSource の呼び出し行が1行まるごとの形で見つからない');

  const syncIdx = body.indexOf('await syncUpperFloorsAuto(project, sourceGraph);');
  const copyIdx = body.indexOf('const copied = await copyElevatorsToNewFloor({ project, activeGraph: sourceGraph, newPlane });');
  const roomIdx = body.indexOf('await addNewFloorRoomFromSource(project, sourceGraph, newPlane, makeFloorName(newStartFloor, 1));');
  assert.ok(syncIdx >= 0 && copyIdx >= 0 && roomIdx >= 0 && syncIdx < copyIdx && copyIdx < roomIdx,
    'syncUpperFloorsAuto → copyElevatorsToNewFloor → addNewFloorRoomFromSource の順になっていない');
});

// ================================================================
// 線種変更の移籍一本化 ステップ2（2026-09-30）: 検討案の追加・コピーで、複製するバイト列を
// 復元する前に線idを振り直す（serializeGraphWithFreshLineIds）。振り直しがthrowしたときに
// 平面を追加させない（＝状態を一切変えない）ため、直列化はaddAlternativeFloorより前に置く。
// team-lessons「正規表現は行頭・行末アンカーで1行まるごと一致させる」対応: 行末コメントに
// 元の式（serializeGraph(graph)）が残る変異でも緑にならないよう、抽出した関数本体全体に
// serializeGraph(graph)（振り直し無しの旧呼び出し）が1つも残っていないことも確認する。
// ================================================================

test('【配線・強化】App.jsx: runAddAlternative はserializeGraphWithFreshLineIds(graph)をaddAlternativeFloorより前で呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function runAddAlternative');

  assert.match(body, /^\s*const bytes = v === 'yes' \? serializeGraphWithFreshLineIds\(graph\) : null;\s*$/m,
    'const bytes = v === \'yes\' ? serializeGraphWithFreshLineIds(graph) : null; が1行まるごとの形で見つからない');
  assert.doesNotMatch(body, /serializeGraph\(graph\)/,
    '振り直し無しのserializeGraph(graph)呼び出しが残っている');

  const serializeIdx = body.indexOf('serializeGraphWithFreshLineIds(graph)');
  const addAltIdx    = body.indexOf('addAlternativeFloor(refId, altName)');
  assert.ok(serializeIdx >= 0 && addAltIdx >= 0 && serializeIdx < addAltIdx,
    'serializeGraphWithFreshLineIds(graph) がaddAlternativeFloor(refId, altName)より前にない');

  // 復元先は切替後のアクティブ階（複製先）で、切替（trySwitchFloor）より後に行う。
  assert.match(body, /^\s*if \(bytes\) restoreGraph\(project\.activeGraph, bytes\);\s*$/m,
    'if (bytes) restoreGraph(project.activeGraph, bytes); が1行まるごとの形で見つからない');
  const restoreIdx   = body.indexOf('if (bytes) restoreGraph(project.activeGraph, bytes);');
  const trySwitchIdx = body.indexOf('trySwitchFloor(');
  assert.ok(trySwitchIdx >= 0 && restoreIdx > trySwitchIdx,
    '復元がtrySwitchFloor(より後にない');
});

test('【配線・強化】App.jsx: runCopyAlternative はserializeGraphWithFreshLineIds(graph)をaddAlternativeFloorより前で呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function runCopyAlternative');

  assert.match(body, /^\s*\? serializeGraphWithFreshLineIds\(graph\)\s*$/m,
    '? serializeGraphWithFreshLineIds(graph) が1行まるごとの形で見つからない');
  assert.doesNotMatch(body, /serializeGraph\(graph\)/,
    '振り直し無しのserializeGraph(graph)呼び出しが残っている');

  const serializeIdx = body.indexOf('serializeGraphWithFreshLineIds(graph)');
  const addAltIdx    = body.indexOf('addAlternativeFloor(refId, newName)');
  assert.ok(serializeIdx >= 0 && addAltIdx >= 0 && serializeIdx < addAltIdx,
    'serializeGraphWithFreshLineIds(graph) がaddAlternativeFloor(refId, newName)より前にない');

  // 直列化はアクティブ階をコピーするときだけ（非アクティブの平面のコピーで別の平面の内容を複製しない）。
  assert.match(body, /^\s*const bytes = project\.activePlaneId === planeId\s*\n\s*\? serializeGraphWithFreshLineIds\(graph\)\s*$/m,
    'const bytes = project.activePlaneId === planeId の直後の行が ? serializeGraphWithFreshLineIds(graph) でない');

  // 復元先は切替後のアクティブ階（複製先）で、切替（trySwitchFloor）より後に行う。
  assert.match(body, /^\s*if \(bytes\) restoreGraph\(project\.activeGraph, bytes\);\s*$/m,
    'if (bytes) restoreGraph(project.activeGraph, bytes); が1行まるごとの形で見つからない');
  const restoreIdx   = body.indexOf('if (bytes) restoreGraph(project.activeGraph, bytes);');
  const trySwitchIdx = body.indexOf('trySwitchFloor(');
  assert.ok(trySwitchIdx >= 0 && restoreIdx > trySwitchIdx,
    '復元がtrySwitchFloor(より後にない');
});

test('【配線・強化】App.jsx: syncNewFloorFromSource は複製できなかった器具があるときだけERR_ELEVATOR_COPY_SKIPPEDのトーストを出す', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function syncNewFloorFromSource');

  assert.match(body, /^\s*if \(copied\.status === 'copied' && copied\.skipped\.length > 0\) \{\s*$/m,
    'if (copied.status === \'copied\' && copied.skipped.length > 0) { が1行まるごとの形で見つからない');
  assert.match(body, /^\s*setToast\(\{ msg: ERR_ELEVATOR_COPY_SKIPPED\(newPlane\.name, copied\.skipped\.length\), key: Date\.now\(\) \}\);\s*$/m,
    'ERR_ELEVATOR_COPY_SKIPPEDのトースト行が1行まるごとの形で見つからない');

  const bodyLines = body.split('\n');
  const condIdx = bodyLines.findIndex(l => l.trim() === "if (copied.status === 'copied' && copied.skipped.length > 0) {");
  const toastIdx = bodyLines.findIndex(
    l => l.trim() === 'setToast({ msg: ERR_ELEVATOR_COPY_SKIPPED(newPlane.name, copied.skipped.length), key: Date.now() });',
  );
  assert.ok(condIdx >= 0 && toastIdx >= 0);
  assert.equal(toastIdx, condIdx + 1,
    '条件行の直後がトースト行であるはず（条件を if(false){ に差し替える変異を見逃さないため）');
});
