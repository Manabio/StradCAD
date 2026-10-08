// App.jsx（部屋名ダイアログ・仕上げ表内部タブのカード）の配線不変条件。.jsx は node:test から
// 単体 import できないため、ソーステキスト検査で固定する（finish/RoomNameInput.wiring.test.js と
// 同じ型。ブロックコメント・行コメントを除去してから検査する——team-lessons「ソース文字列を
// 正規表現で検査する配線テストが、コメント文にも一致して変異を見逃す」対応）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readAppSrc, extractFunctionBody, stripCommentLines } from './uiBusySourceScan.js';

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

// 階追加時の追従処理（階段の上階同期→昇降機の複製→外壁内側の部屋の自動追加）の順序は
// floorOrderChange.js のレジストリ（floorOrderFollowers）へ移った。App.jsx 側の配線
// （applyFloorOrderChangeを呼ぶこと）は後段の【配線・強化】executeAddUpper/'general'分岐のテストで、
// 追従処理の順序自体は floorOrderChange.test.js（レジストリの name 順）で固定する
// （途中階の上階追加と階移動の振り直し一本化 ステップ3）。

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
  const addAltIdx    = body.indexOf('addAlternativeFloor(refId, altName');
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
  const addAltIdx    = body.indexOf('addAlternativeFloor(refId, newName');
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

// ================================================================
// 途中階の上階追加と階移動の振り直し一本化 ステップ2・3（2026-10-01）: executeAddUpper／
// handleAddFloorConfirm('general'/'lower')・runDeleteFloor は computeFloorInsert／
// computeFloorDeleteReorder で振り直しを計算し、本体・追従処理は applyFloorOrderChange
// （floorOrderChange.js）へ委譲する。addFloor を直接呼ばず、applyFloorInsert も直接呼ばない
// （261001_途中階の上階追加と階移動の振り直し一本化.md §5-7）。
// ================================================================

test('【配線・強化】App.jsx: executeAddUpper は computeFloorInsert→applyFloorOrderChange(kind: INSERT) を使い、addFloor を直接呼ばない', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function executeAddUpper');

  assert.match(body, /computeFloorInsert\(project\.planes, currentPlane\.id, 1\)/,
    'computeFloorInsert(project.planes, currentPlane.id, 1) の呼び出しが見つからない');
  assert.match(body, /applyFloorOrderChange\(project, \{\s*\n\s*kind: FLOOR_ORDER_KIND\.INSERT,/,
    'applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.INSERT, ... }) の呼び出しが見つからない');
  // addFloor はaddPlaneへ渡すクロージャの中でだけ呼ぶ（振り直し前にいきなり新階を
  // 足す旧来の直接呼び出し `const { plane } = addFloor(` が残っていないこと）。
  assert.doesNotMatch(body, /const \{ plane \} = addFloor\(/,
    'executeAddUpper 本体に旧来の直接 addFloor( 呼び出し（振り直し前に新階を足す形）が残っている');
  assert.doesNotMatch(body, /applyFloorInsert\(/,
    'executeAddUpper が applyFloorInsert を直接呼んでいる（applyFloorOrderChangeへ委譲していない）');
});

test("【配線・強化】App.jsx: handleAddFloorConfirm の'general'分岐も computeFloorInsert→applyFloorOrderChange(kind: INSERT) を使う", () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function handleAddFloorConfirm');
  const generalIdx = body.indexOf("if (action === 'general') {");
  assert.ok(generalIdx >= 0, "'general'分岐が見つからない");
  const generalBlock = body.slice(generalIdx);

  assert.match(generalBlock, /computeFloorInsert\(project\.planes, currentPlane\.id, n\)/,
    'computeFloorInsert(project.planes, currentPlane.id, n) の呼び出しが見つからない');
  assert.match(generalBlock, /applyFloorOrderChange\(project, \{\s*\n\s*kind: FLOOR_ORDER_KIND\.INSERT,/,
    'applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.INSERT, ... }) の呼び出しが見つからない');
});

test("【配線・強化】App.jsx: handleAddFloorConfirm の'lower'分岐は applyFloorOrderChange(kind: ADD_LOWER) を使う", () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function handleAddFloorConfirm');
  const lowerIdx = body.indexOf("if (action === 'lower') {");
  assert.ok(lowerIdx >= 0, "'lower'分岐が見つからない");
  const lowerBlock = body.slice(lowerIdx, body.indexOf("if (action === 'general') {"));

  assert.match(lowerBlock, /applyFloorOrderChange\(project, \{\s*\n\s*kind: FLOOR_ORDER_KIND\.ADD_LOWER,/,
    'applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.ADD_LOWER, ... }) の呼び出しが見つからない');
});

test('【配線・強化】App.jsx: runDeleteFloor は computeFloorDeleteReorder→applyFloorOrderChange(kind: DELETE) を使う（removeFloorはaddPlane/removePlaneクロージャの中だけ）', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function runDeleteFloor');

  assert.match(body, /computeFloorDeleteReorder\(afterRemoval, idx\)/,
    'computeFloorDeleteReorder(afterRemoval, idx) の呼び出しが見つからない');
  assert.match(body, /applyFloorOrderChange\(project, \{\s*\n\s*kind: FLOOR_ORDER_KIND\.DELETE,/,
    'applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.DELETE, ... }) の呼び出しが見つからない');
  assert.match(body, /removePlane: \(\) => removeFloor\(planeId\),/,
    'removePlane: () => removeFloor(planeId), が見つからない');
  // 器具id読み・階段削除・昇降機再採番・構造反映の直接呼び出しはfollower側へ移した。
  assert.doesNotMatch(body, /readFloorEquipmentIds|renumberEquipmentAfterFloorRemoval|removeStairsOnFloor/,
    'runDeleteFloor に旧来の直接呼び出し（followerへ移した処理）が残っている');
});

test('【配線・強化】App.jsx: withFloorOpUndo は before/after それぞれで collectPlaneMetas(project) を1回ずつ採る', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function withFloorOpUndo');
  const matches = body.match(/collectPlaneMetas\(project\)/g) ?? [];
  assert.equal(matches.length, 2,
    `collectPlaneMetas(project) はbefore/afterの2回呼ぶはず（実際: ${matches.length}）`);

  const beforeIdx = body.indexOf('const metasBefore = collectPlaneMetas(project);');
  const afterIdx  = body.indexOf('const metasAfter = collectPlaneMetas(project);');
  const runIdx    = body.indexOf('await run();');
  assert.ok(beforeIdx >= 0 && afterIdx >= 0 && runIdx >= 0 && beforeIdx < runIdx && runIdx < afterIdx,
    'metasBefore→run()→metasAfter の順になっていない');
});

// 「積むかどうか」の判定は diffFloorOpSnapshot（floorOps.js）へ寄せ、旧来の
// `if (addedPlanes.length === 0) return;`（追加階が無ければ無条件でundoを積まない）は残っていない
// （途中階の上階追加と階移動の振り直し一本化 ステップ4）。
// §5-6の検出力強化: diffFloorOpSnapshot({ から undoFloorOp（1つ目の内側クロージャ）の定義直前
// までの区間（「積むかどうか」の判定域。undoFloorOp/redoFloorOp内部のreturnは別の制御フロー
// なので対象外）を切り出し、return を含む行が if (!hasChanges) return; の1行だけであることを
// 検査する（旧不良の再導入——diffFloorOpSnapshotのhasChangesに加えて旧来の
// if (addedPlanes.length === 0) return; 相当のガードを足す変異——を検知する。QA指摘）。
test('【配線・強化】App.jsx: withFloorOpUndo は diffFloorOpSnapshot({ 〜 undoFloorOp定義前 の区間に if (!hasChanges) return; 以外の return を持たない', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function withFloorOpUndo');

  assert.match(body, /const \{ addedPlanes, changedSiblings, hasChanges \} = diffFloorOpSnapshot\(\{/,
    'diffFloorOpSnapshot({ ... }) の呼び出しが見つからない');

  const startIdx = body.indexOf('diffFloorOpSnapshot({');
  const endIdx   = body.indexOf('async function undoFloorOp');
  assert.ok(startIdx >= 0 && endIdx >= 0 && startIdx < endIdx,
    'diffFloorOpSnapshot({ 〜 async function undoFloorOp の区間が見つからない');
  const region = body.slice(startIdx, endIdx);

  const returnLines = region.split(/\r?\n/).map(l => l.trim()).filter(l => l.includes('return'));
  assert.deepEqual(returnLines, ['if (!hasChanges) return;'],
    `diffFloorOpSnapshot〜undoFloorOp定義前の区間にif (!hasChanges) return;以外のreturnが残っている`
    + `（実際: ${JSON.stringify(returnLines)}）。旧来のif (addedPlanes.length === 0) return;相当の`
    + 'ガードを足す変異を防ぐため、判定はhasChangesへ一本化すること');
});

test('【配線・強化】App.jsx: undoFloorOp は removeFloor ループの後・changedSiblings書き戻しの前に applyPlaneMetas(project, metasBefore) を呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function undoFloorOp');

  const removeIdx = body.indexOf('for (const pl of addedPlanes) await removeFloor(pl.id);');
  const applyIdx  = body.indexOf('applyPlaneMetas(project, metasBefore);');
  const siblingIdx = body.indexOf('for (const rec of changedSiblings) applyFloorBytes(project, rec.planeId, rec.before);');
  assert.ok(removeIdx >= 0 && applyIdx >= 0 && siblingIdx >= 0,
    'removeFloorループ・applyPlaneMetas(metasBefore)・changedSiblings書き戻しのいずれかが見つからない');
  assert.ok(removeIdx < applyIdx && applyIdx < siblingIdx,
    'applyPlaneMetas(project, metasBefore) が removeFloorループの後・changedSiblings書き戻しの前にない');
});

test('【配線・強化】App.jsx: redoFloorOp は addFloor の前に applyPlaneMetas(project, metasAfter) を呼ぶ（既存階を先にずらしてから新階を足す）', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function redoFloorOp');

  const applyIdx = body.indexOf('applyPlaneMetas(project, metasAfter);');
  const addIdx   = body.indexOf('addFloor(pl.elevation, pl.name, pl.startFloor, pl.stories, pl.id, pl.planCutHeightMm);');
  assert.ok(applyIdx >= 0 && addIdx >= 0, 'applyPlaneMetas(metasAfter) または addFloor( 呼び出しが見つからない');
  assert.ok(applyIdx < addIdx, 'applyPlaneMetas(project, metasAfter) が addFloor( より前にない');
});

// redoFloorOpは、追加階が無く（ドラッグ移動・階変更）activeAfterIdが変わっていない場合は
// handleFloorSwitchを呼ばない（§4.3「ドラッグ移動では階は切り替わらないので無駄な切替をしない」）。
test('【配線・強化】App.jsx: redoFloorOp は activeAfterId !== project.activePlaneId のときだけ handleFloorSwitch(activeAfterId) を呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function redoFloorOp');

  assert.match(body, /^\s*if \(activeAfterId !== project\.activePlaneId\) await handleFloorSwitch\(activeAfterId\);\s*$/m,
    'if (activeAfterId !== project.activePlaneId) await handleFloorSwitch(activeAfterId); が1行まるごとの形で見つからない');
});

// ================================================================
// 途中階の上階追加と階移動の振り直し一本化 ステップ4（Q1裁定）: ドラッグ移動（runReorderFloor）・
// 階変更（runFloorChange）も、挿入・削除と同じ applyFloorOrderChange／withFloorOpUndo 経由で
// 関門・undo・追従処理を伴う。
// ================================================================

test('【配線・強化】App.jsx: runReorderFloor は computeFloorReorder( → beginUiTransition(); → withFloorOpUndo(\'階操作\' → applyFloorOrderChange(kind: REORDER) の順で呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function runReorderFloor');

  assert.match(body, /^\s*const updates = computeFloorReorder\(project\.planes, fromId, toZone\);\s*$/m,
    'computeFloorReorder(project.planes, fromId, toZone) が1行まるごとの形で見つからない');
  assert.match(body, /^\s*if \(!updates\) return;\s*$/m, 'if (!updates) return; が1行まるごとの形で見つからない');
  assert.match(body, /^\s*beginUiTransition\(\);\s*$/m, 'beginUiTransition(); が1行まるごとの形で見つからない');
  assert.match(body, /await withFloorOpUndo\('階操作', async \(\) => \{/,
    "withFloorOpUndo('階操作', async () => { ... }) の呼び出しが見つからない");
  assert.match(body, /applyFloorOrderChange\(project, \{\s*\n\s*kind: FLOOR_ORDER_KIND\.REORDER,/,
    'applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.REORDER, ... }) の呼び出しが見つからない');

  const computeIdx = body.indexOf('const updates = computeFloorReorder(project.planes, fromId, toZone);');
  const beginIdx   = body.indexOf('beginUiTransition();');
  const withIdx    = body.indexOf("withFloorOpUndo('階操作', async () => {");
  const applyIdx   = body.indexOf('applyFloorOrderChange(project, {');
  assert.ok(computeIdx >= 0 && beginIdx >= 0 && withIdx >= 0 && applyIdx >= 0
    && computeIdx < beginIdx && beginIdx < withIdx && withIdx < applyIdx,
    'computeFloorReorder( → beginUiTransition(); → withFloorOpUndo(\'階操作\' → applyFloorOrderChange( の順になっていない');
});

test('【配線・強化】App.jsx: runFloorChange は setFloorChangeDlg(null) → computeFloorChangeReorder( → beginUiTransition(); → withFloorOpUndo(\'階操作\' → applyFloorOrderChange(kind: CHANGE) の順で呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function runFloorChange');

  assert.match(body, /^\s*setFloorChangeDlg\(null\);\s*$/m, 'setFloorChangeDlg(null); が1行まるごとの形で見つからない');
  assert.match(body, /^\s*const updates = computeFloorChangeReorder\(project\.planes, planeId, newStartFloor\);\s*$/m,
    'computeFloorChangeReorder(project.planes, planeId, newStartFloor) が1行まるごとの形で見つからない');
  assert.match(body, /^\s*if \(!updates\) return;\s*$/m, 'if (!updates) return; が1行まるごとの形で見つからない');
  assert.match(body, /^\s*beginUiTransition\(\);\s*$/m, 'beginUiTransition(); が1行まるごとの形で見つからない');
  assert.match(body, /applyFloorOrderChange\(project, \{\s*\n\s*kind: FLOOR_ORDER_KIND\.CHANGE,/,
    'applyFloorOrderChange(project, { kind: FLOOR_ORDER_KIND.CHANGE, ... }) の呼び出しが見つからない');

  const setDlgIdx  = body.indexOf('setFloorChangeDlg(null);');
  const computeIdx = body.indexOf('const updates = computeFloorChangeReorder(project.planes, planeId, newStartFloor);');
  const beginIdx   = body.indexOf('beginUiTransition();');
  const withIdx    = body.indexOf("withFloorOpUndo('階操作', async () => {");
  const applyIdx   = body.indexOf('applyFloorOrderChange(project, {');
  assert.ok(setDlgIdx >= 0 && computeIdx >= 0 && beginIdx >= 0 && withIdx >= 0 && applyIdx >= 0
    && setDlgIdx < computeIdx && computeIdx < beginIdx && beginIdx < withIdx && withIdx < applyIdx,
    'setFloorChangeDlg(null) → computeFloorChangeReorder( → beginUiTransition(); → withFloorOpUndo(\'階操作\' → applyFloorOrderChange( の順になっていない');
});

test('【配線・強化】App.jsx: handleChipReorder は floor側で runReorderFloor の Promise を返す', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'function handleChipReorder');

  assert.match(body, /^\s*return runReorderFloor\(planeId, target\.toZone\);\s*$/m,
    'return runReorderFloor(planeId, target.toZone); が1行まるごとの形で見つからない');
});

test('【配線・強化】App.jsx: FloorChangeDialogのonConfirmはguardUi(n => runFloorChange(floorChangeDlg.planeId, n))で包まれている', () => {
  const appSrc = readAppSrc();
  const code = stripCommentLines(appSrc);
  assert.match(code, /<FloorChangeDialog[\s\S]{0,300}onConfirm=\{guardUi\(n => runFloorChange\(floorChangeDlg\.planeId, n\)\)\}/,
    'FloorChangeDialogのonConfirmがguardUi(n => runFloorChange(floorChangeDlg.planeId, n))で包まれていない');
});

test('【配線】App.jsx: 切断高 — cut-height メニューはダイアログを開き、onConfirm は guardUi で包まれ、runPlanCutHeight は setPlanCutHeightMm→markDirty→undoManager.push の順', () => {
  const appSrc = readAppSrc();
  const code = stripCommentLines(appSrc);
  assert.match(code, /action === 'cut-height'\) \{\s*setPlanCutHeightDlg\(\{ planeId \}\);/, "'cut-height' がダイアログを開いていない");
  assert.match(code, /<PlanCutHeightDialog[\s\S]{0,300}onConfirm=\{guardUi\(mm => runPlanCutHeight\(planCutHeightDlg\.planeId, mm\)\)\}/,
    'PlanCutHeightDialogのonConfirmがguardUiで包まれていない');
  const body = extractFunctionBody(appSrc, 'function runPlanCutHeight');
  const setIdx = body.indexOf('setPlanCutHeightMm(project, planeId, mm)');
  const dirtyIdx = body.indexOf('markDirty();');
  const pushIdx = body.indexOf('undoManager.push(');
  assert.ok(setIdx >= 0 && setIdx < dirtyIdx && dirtyIdx < pushIdx, 'setPlanCutHeightMm → markDirty → undoManager.push の順になっていない');
});

test('【配線】App.jsx: 切断高の複製 — 上階追加・一般階追加は newPlane.planCutHeightMm、下階追加は currentPlane.planCutHeightMm、redo は pl.planCutHeightMm を addFloor の第6引数へ渡す', () => {
  const code = stripCommentLines(readAppSrc());
  const upper = code.match(/addPlane: \(\) => addFloor\(newPlane\.elevation, newPlane\.name, newPlane\.startFloor, newPlane\.stories, undefined, newPlane\.planCutHeightMm\),/g) ?? [];
  assert.equal(upper.length, 2, '上階追加（executeAddUpper）と一般階追加の2箇所');
  const upperBody = extractFunctionBody(readAppSrc(), 'async function executeAddUpper');
  assert.ok(upperBody.includes('newPlane.stories, undefined, newPlane.planCutHeightMm)'), 'executeAddUpper が切断高を渡していない');
  const confirmBody = extractFunctionBody(readAppSrc(), 'async function handleAddFloorConfirm');
  assert.ok(confirmBody.includes('newPlane.stories, undefined, newPlane.planCutHeightMm)'), 'handleAddFloorConfirm（general）が切断高を渡していない');
  assert.ok(confirmBody.includes('addFloor(elev, name, sf, 1, undefined, currentPlane.planCutHeightMm)'), '下階追加が currentPlane の切断高を渡していない');
});

test('【配線】App.jsx: 検討案の作成（add-alt）・案コピーは複製元の平面を addAlternativeFloor の第3引数へ渡す', () => {
  const appSrc = readAppSrc();
  const add = extractFunctionBody(appSrc, 'async function runAddAlternative');
  assert.ok(add.includes('addAlternativeFloor(refId, altName, sourcePlane)'), 'runAddAlternative が sourcePlane を渡していない');
  const copy = extractFunctionBody(appSrc, 'async function runCopyAlternative');
  assert.ok(copy.includes('addAlternativeFloor(refId, newName, plane)'), 'runCopyAlternative が plane を渡していない');
  const menu = extractFunctionBody(appSrc, 'function handleFloorMenuAction');
  assert.ok(menu.includes('runAddAlternative(v, refId, refPlane, plane)'), 'add-alt の呼び出し元が複製元 plane を渡していない');
});

test('【配線】App.jsx: runPlanCutHeight の undo は changed.before、redo は changed.after（この順に出現）', () => {
  const body = extractFunctionBody(readAppSrc(), 'function runPlanCutHeight');
  const b = body.indexOf('setPlanCutHeightMm(project, planeId, changed.before)');
  const a = body.indexOf('setPlanCutHeightMm(project, planeId, changed.after)');
  assert.ok(b >= 0 && a >= 0 && b < a, 'undo(before) → redo(after) の順になっていない');
});

// ================================================================
// QA指摘§5-7: 振り直し（startFloor・elevation・stories）は必ず floorOps.js の applyPlaneMetas／
// applyFloorInsert 経由で書く（App.jsx 本文に直接代入が残っていないことをソース走査で固定する）。
// ================================================================

test('【不変条件・§5-7】App.jsx: startFloor=／elevation=／stories= の直接代入が無い（振り直しは必ずfloorOps.js経由）', () => {
  const code = stripCommentLines(readAppSrc());
  assert.doesNotMatch(code, /\.(startFloor|elevation|stories)\s*=(?!=)/,
    'App.jsx 本文に .startFloor=／.elevation=／.stories= への直接代入が残っている');
});

// QA指摘: floorOrderUi の switchFloor が trySwitchFloor(() => handleFloorSwitch(id)) であることを固定する
// （applyFloorOrderChange の ui.switchFloor が F1規律（trySwitchFloorで成否を判定）を経由する配線）。
test('【配線】App.jsx: floorOrderUi 本体に switchFloor: (id) => trySwitchFloor(() => handleFloorSwitch(id)), が1行まるごとの形で存在する', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'function floorOrderUi');
  assert.match(body, /^\s*switchFloor: \(id\) => trySwitchFloor\(\(\) => handleFloorSwitch\(id\)\),\s*$/m,
    'switchFloor: (id) => trySwitchFloor(() => handleFloorSwitch(id)), が1行まるごとの形で見つからない');
});

// ================================================================
// QA指摘（横断テスト）: withFloorOpUndo は全呼び出し箇所で、呼び出し元がbeginUiTransition()を
// 済ませてから呼ぶ不変条件（withFloorOpUndo自身はbeginUiTransition()を呼ばない。
// uiBusyClassification.test.jsのnoBeginUiTransition扱いの裏付け）。呼び出し件数も固定し、
// 増減（新しい呼び出し元の追加・既存の削除）を検知する。
// 変異: executeAddUpper／handleAddFloorConfirmの'lower'/'general'分岐／runReorderFloor／
// runFloorChangeのいずれかから beginUiTransition(); を外すと赤になる。
// ================================================================

test('【不変条件・横断】App.jsx: await withFloorOpUndo( の全呼び出し箇所は、直前の非空行が beginUiTransition(); である（呼び出し件数は5件固定）', () => {
  const lines = stripCommentLines(readAppSrc()).split(/\r?\n/);
  const callLineIdxs = [];
  lines.forEach((line, i) => { if (line.includes('await withFloorOpUndo(')) callLineIdxs.push(i); });

  assert.equal(callLineIdxs.length, 5,
    `await withFloorOpUndo( の呼び出し件数が5件固定と異なる（実際: ${callLineIdxs.length}）。`
    + '呼び出し元が増減していないか見直すこと');

  for (const idx of callLineIdxs) {
    let prev = idx - 1;
    while (prev >= 0 && lines[prev].trim() === '') prev--;
    assert.ok(prev >= 0 && lines[prev].trim() === 'beginUiTransition();',
      `await withFloorOpUndo( の直前の非空行が beginUiTransition(); ではない`
      + `（呼び出し行: "${lines[idx].trim()}"、直前の非空行: "${prev >= 0 ? lines[prev].trim() : '(なし)'}"）`);
  }
});

// ================================================================
// 屋根と他の階の整合（ステップB1b）: 階段の新規指定の確定前の拒否・屋根の付与直後の警告の配線。
// 判断は純関数（finish/stair/stairRoofConflict.js・finish/roof/roofFloorCheck.js）に置いてあり、ここでは
// 呼び出し側（App.jsx）の順序だけを、コメント行を除いた関数本体・1行まるごとの一致で固定する。
// ================================================================

const STAIR_BRANCH_LINE =
  'if (!stairChecked && modeRef.current?.isStairConversionIntent(id, payload) && upperAdoptedPlanes(project.planes, project.activePlane).length > 0) { guardUi(convertStairFromNaming)(id, payload); return; }';

test('【配線・B1b】applyRoomNaming: 階段の新規指定は、変更（applyNaming）より前の1行で convertStairFromNaming へ分岐しreturnする（昇降機の分岐の後）', () => {
  const body = extractFunctionBody(readAppSrc(), 'function applyRoomNaming');
  const lines = body.split('\n').map(l => l.trim());
  const branchIdx = lines.indexOf(STAIR_BRANCH_LINE);
  assert.ok(branchIdx >= 0, `階段の分岐が1行まるごとの形で見つからない: ${STAIR_BRANCH_LINE}`);
  const elevatorIdx = lines.findIndex(l => l.startsWith('if (modeRef.current?.isElevatorInstallIntent(id, payload))'));
  const applyIdx = lines.findIndex(l => l.includes('modeRef.current?.applyNaming('));
  assert.ok(elevatorIdx >= 0 && applyIdx >= 0, '前提: 昇降機の分岐と applyNaming の呼び出しがある');
  assert.ok(elevatorIdx < branchIdx && branchIdx < applyIdx,
    `階段の分岐は昇降機の分岐より後・applyNaming の呼び出しより前（昇降機:${elevatorIdx}、階段:${branchIdx}、applyNaming:${applyIdx}）`);
});

test('【配線・B1b】convertStairFromNaming: 事前チェック（上の階の peek を含む）が変更（applyRoomNaming の再入）より前で、拒否ならreturnする', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function convertStairFromNaming');
  const lines = body.split('\n').map(l => l.trim());
  const idxOf = (pred) => lines.findIndex(pred);
  const whenIdleIdx = idxOf(l => l === 'await structuralSync.whenIdle();');
  const importIdx = idxOf(l => l === "const m = await import('./finish/stair/stairFloorSync.js');");
  const checkIdx = idxOf(l => l === 'rejection = await m.findStairUpperRoofRejection(project, g, prep.cells, prep.indoor);');
  const rejectIdx = idxOf(l => l === 'if (rejection) { setToast({ msg: rejection, key: Date.now() }); return; }');
  const commitIdx = idxOf(l => l === 'applyRoomNaming(id, payload, { stairChecked: true });');
  for (const [name, i] of [['whenIdle', whenIdleIdx], ['動的import', importIdx], ['事前チェック', checkIdx], ['拒否のreturn', rejectIdx], ['確定', commitIdx]]) {
    assert.ok(i >= 0, `${name} の行が1行まるごとの形で見つからない`);
  }
  assert.ok(whenIdleIdx < importIdx && importIdx < checkIdx && checkIdx < rejectIdx && rejectIdx < commitIdx,
    `順序は whenIdle → import → 事前チェック → 拒否return → 確定 のはず（${whenIdleIdx},${importIdx},${checkIdx},${rejectIdx},${commitIdx}）`);
  assert.equal(body.match(/applyRoomNaming\(/g)?.length ?? 0, 1, 'applyRoomNaming の呼び出しは確定の1回だけ（事前チェックの前に変更が起きない）');
  assert.ok(!body.includes('.applyNaming('), 'モード状態の applyNaming を直接呼ばない（必ず applyRoomNaming 経由）');
  // 事前チェックの失敗（peek 失敗等）は握りつぶさず、何も変更せず専用メッセージを出してreturnする
  assert.ok(lines.includes('setToast({ msg: ERR_STAIR_UPPER_CHECK_FAILED, key: Date.now() });'), '確認失敗のトーストが無い');
});

test('【配線・ステップ4】convertStairFromNaming: 下階の階段の吹抜けとの重なりの拒否（prep.rejection）は、関門（beginUiTransition）に入る前にトーストしてreturnする', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function convertStairFromNaming');
  const lines = body.split('\n').map(l => l.trim());
  const rejectIdx = lines.indexOf('if (prep.rejection) { setToast({ msg: prep.rejection, key: Date.now() }); return; }');
  const gateIdx = lines.indexOf('beginUiTransition();');
  assert.ok(rejectIdx >= 0, 'prep.rejection のトースト＋return の1行が1行まるごとの形で見つからない');
  assert.ok(gateIdx >= 0 && rejectIdx < gateIdx, `拒否のreturnは関門に入る前（拒否:${rejectIdx}、関門:${gateIdx}）`);
});

test('【配線・B1b】applyRoomNaming: 再入フラグ stairChecked の既定は false（既定が true だと事前チェックが丸ごと無効になる）', () => {
  const src = readAppSrc();
  const lines = stripCommentLines(src).split('\n').map(l => l.trim());
  assert.ok(lines.includes('function applyRoomNaming(id, payload, { stairChecked = false } = {}) {'),
    'function applyRoomNaming(id, payload, { stairChecked = false } = {}) { が1行まるごとの形で見つからない');
  assert.equal(lines.filter(l => l.includes('stairChecked: true')).length, 1, 'stairChecked: true で再入するのは convertStairFromNaming の1箇所だけ');
});

test('【配線・B1b】convertStairFromNaming: 確認失敗（catch）の直後は return、await 後の再確認も1行まるごと一致で確定より前・中で return、確定の例外は識別を付ける', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function convertStairFromNaming');
  const lines = body.split('\n').map(l => l.trim());
  // (1) catch: setToast(確認失敗) の直後の行が return;（消すと、上の階を確認できないまま階段を確定してしまう）
  const catchIdx = lines.indexOf('} catch (err) {');
  assert.ok(catchIdx >= 0, '確認の catch が無い');
  assert.deepEqual(lines.slice(catchIdx + 1, catchIdx + 4), [
    'console.error(err);',
    'setToast({ msg: ERR_STAIR_UPPER_CHECK_FAILED, key: Date.now() });',
    'return;',
  ], 'catch は console.error → 確認失敗のトースト → return; の順');
  // (2) await 後の再確認
  const recheckLine = 'if (modeRef.current !== fmode || project.activeGraph !== g || !fmode.isStairConversionIntent(id, payload)) {';
  const recheckIdx = lines.indexOf(recheckLine);
  assert.ok(recheckIdx >= 0, `再確認の if が1行まるごとの形で見つからない: ${recheckLine}`);
  assert.deepEqual(lines.slice(recheckIdx + 1, recheckIdx + 4), [
    'setToast({ msg: ERR_STAIR_DESIGNATE_ABORTED, key: Date.now() });',
    'return;',
    '}',
  ], '再確認が偽でなければ 中断のトースト → return; で閉じる');
  const commitIdx = lines.indexOf('applyRoomNaming(id, payload, { stairChecked: true });');
  assert.ok(commitIdx > recheckIdx, '再確認は確定（applyRoomNaming の再入）より前');
  // (3) 確定の例外は階段の指定の失敗として識別する（階切替の汎用文言に丸められない）
  assert.equal(lines[commitIdx - 1], 'try {', '確定は try の中');
  assert.deepEqual(lines.slice(commitIdx + 1, commitIdx + 4), [
    '} catch (err) {',
    'throw tagElevatorOpFailure(err, { code: ERR_STAIR_DESIGNATE_FAILED, message: ERR_STAIR_DESIGNATE_FAILED_MESSAGE });',
    '}',
  ]);
});

test('【配線・B1b】applyRoomNaming: 屋根の警告は applyNaming と rejection の判定より後で、wasRoof は applyNaming より前に採る', () => {
  const body = extractFunctionBody(readAppSrc(), 'function applyRoomNaming');
  const lines = body.split('\n').map(l => l.trim());
  const wasRoofIdx = lines.indexOf('const wasRoof = isRoofFeature(project.activeGraph.roomMap.get(id)?.feature);');
  const applyIdx = lines.findIndex(l => l.includes('modeRef.current?.applyNaming('));
  const rejectionIdx = lines.indexOf('if (rejection) { setToast({ msg: rejection, key: Date.now() }); return; }');
  const warnIdx = lines.indexOf('if (isRoofFeature(roofRoom?.feature) && !wasRoof) warnUpperRoomsOverRoof(project.activeGraph, new Set(roofRoom.cells));');
  assert.ok(wasRoofIdx >= 0 && warnIdx >= 0 && applyIdx >= 0 && rejectionIdx >= 0, '必要な行が1行まるごとの形で見つからない');
  assert.ok(wasRoofIdx < applyIdx, 'wasRoof は applyNaming より前に採る（確定後では常に真になる）');
  assert.ok(applyIdx < rejectionIdx && rejectionIdx < warnIdx, '警告は拒否の判定より後（拒否された屋根では出さない）');
});

test('【配線・B1b】warnUpperRoomsOverRoof: 上の階は読むだけ（peek）・結果があればトースト・失敗は console.error', () => {
  const body = extractFunctionBody(readAppSrc(), 'function warnUpperRoomsOverRoof');
  assert.ok(body.includes('findUpperRoomsOverCells(project, g, cells, (p) => floorSwapManager.peek(p, project.structGraph))'));
  assert.ok(body.includes('if (names.length > 0) setToast({ msg: ERR_ROOF_UPPER_ROOMS(names), key: Date.now() });'));
  // 部分一致だと、行末コメントに元の式を残す変異（`// .catch(console.error);`）でも緑になる——trim した行の完全一致にする
  assert.ok(body.split('\n').map(l => l.trim()).includes('.catch(console.error);'), '失敗は握りつぶさずログに出す（行まるごと一致）');
  assert.ok(!body.includes('saveFloor') && !body.includes('runBusy'), '他階へ書かない・関門にも入らない（読むだけ）');
});

// ================================================================
// 階段の削除の連動（設置階の削除＝上の階の分身・階段吹抜けも消す。2026-10-03 件B ステップ3・4）:
// 階段タブの削除（deleteStairCascade）と部屋カード「属性」で階段を外す（revertStairFromNaming）は同じ関門
// （runStairRemoval）を通す。1行まるごと一致（m フラグ・行頭行末アンカー）で、行末コメントに元の式を残す変異も赤にする。
// ================================================================

const STAIR_ENTRIES = [
  {
    name: 'deleteStairCascade',
    needle: 'async function deleteStairCascade',
    commitLine: 'fmode.deleteStair(id);',
    stairIdArg: 'stairId: id,',
    restoreCount: 2, // 例外・undoエントリnull
    guardLine: 'if (!fmode.lastStairUndoEntry) {',
  },
  {
    name: 'deleteStairRoomCascade',
    needle: 'async function deleteStairRoomCascade',
    commitLine: 'fmode.deleteRoom(roomId);',
    stairIdArg: 'stairId,',
    restoreCount: 2, // 例外・undoエントリnull
    guardLine: 'if (!fmode.lastRoomUndoEntry) {',
  },
  {
    name: 'revertStairFromNaming',
    needle: 'async function revertStairFromNaming',
    commitLine: 'fmode.applyNaming(id, payload, floorHeightAbove(project, project.activePlane));',
    stairIdArg: 'stairId,',
    restoreCount: 2, // 例外・拒否/undoエントリnull
    // QA指摘: この条件行を `if (false) {` に変えても全テストが緑だった（拒否・差分なしの巻き戻しが無検出）
    guardLine: 'if (fmode.lastNamingRejection || !fmode.lastNamingUndoEntry) {',
  },
];

test('【配線・件B】App.jsx: FinishSidebar・FinishHalfModal へ onDeleteStairRoom={guardUi(deleteStairRoomCascade)} を1行まるごとの形で2箇所渡す', () => {
  const matches = src.match(/^\s*onDeleteStairRoom=\{guardUi\(deleteStairRoomCascade\)\}\s*$/gm) ?? [];
  assert.equal(matches.length, 2, `onDeleteStairRoom={guardUi(deleteStairRoomCascade)} は2箇所のはず（実際: ${matches.length}）`);
});

test('【配線・件B】App.jsx: deleteStairRoomCascade は階段実体が無ければ関門に入らず、isStillValid で階段の存在・削除不可でないことも確かめる', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function deleteStairRoomCascade');
  const lines = body.split('\n').map(l => l.trim());
  const guardIdx = lines.indexOf('if (!stair) return; // 階段実体が既に無い等の退化ケース（関門に入らない）');
  assert.ok(guardIdx >= 0, 'stair が無いときの早期 return が見つからない');
  assert.ok(lines.includes('modeRef.current === fmode && project.activeGraph === g && fmode.stairOfRoom(roomId)?.id === stairId && !fmode.roomDeleteBlockReason(roomId);'),
    'isStillValid の条件行が1行まるごとの形で見つからない');
  assert.ok(lines.indexOf('beginUiTransition();') > guardIdx, 'beginUiTransition() は早期 return の後');
});

test('【配線・件B】App.jsx: FinishSidebar・FinishHalfModal へ onDeleteStair={guardUi(deleteStairCascade)} を1行まるごとの形で2箇所渡す', () => {
  const matches = src.match(/^\s*onDeleteStair=\{guardUi\(deleteStairCascade\)\}\s*$/gm) ?? [];
  assert.equal(matches.length, 2, `onDeleteStair={guardUi(deleteStairCascade)} は2箇所のはず（実際: ${matches.length}）`);
});

for (const entry of STAIR_ENTRIES) {
  test(`【配線・件B】App.jsx: ${entry.name} は onApplied・確定行・restoreFinishState件数・whenIdle→動的import→runStairRemoval の順・失敗の識別・トーストを満たす`, () => {
    const body = extractFunctionBody(readAppSrc(), entry.needle);

    assert.match(body, /^\s*onApplied: \(\) => setFloorSyncTick\(t => t \+ 1\),\s*$/m,
      `${entry.name}: onApplied: () => setFloorSyncTick(t => t + 1), が1行まるごとの形で見つからない`);
    assert.match(body, new RegExp(`^\\s*${escapeRegExpLiteral(entry.commitLine)}\\s*$`, 'm'),
      `${entry.name}: 確定行（${entry.commitLine}）が1行まるごとの形で見つからない`);
    assert.match(body, new RegExp(`^\\s*project, activeGraph: g, ${escapeRegExpLiteral(entry.stairIdArg)} commitActive, isStillValid,\\s*$`, 'm'),
      `${entry.name}: runStairRemoval の引数行が1行まるごとの形で見つからない`);

    assert.match(body, new RegExp(`^\\s*${escapeRegExpLiteral(entry.guardLine)}\\s*$`, 'm'),
      `${entry.name}: 拒否・undoエントリnullの条件行（${entry.guardLine}）が1行まるごとの形で見つからない`);

    const restoreMatches = body.match(/^\s*runInAction\(\(\) => restoreFinishState\(g, before\)\);\s*$/gm) ?? [];
    assert.equal(restoreMatches.length, entry.restoreCount,
      `${entry.name}: restoreFinishState(g, before) は ${entry.restoreCount} 箇所のはず（実際: ${restoreMatches.length}）`);

    const lines = body.split('\n').map(l => l.trim());
    const idleIdx = lines.indexOf('await structuralSync.whenIdle();');
    const importIdx = lines.indexOf("const m = await import('./finish/stair/stairFloorSync.js');");
    const runIdx = lines.indexOf('r = await m.runStairRemoval({');
    assert.ok(idleIdx >= 0 && importIdx > idleIdx && runIdx > importIdx,
      `${entry.name}: whenIdle → 動的import → runStairRemoval の順（確定の後に遅延チャンクを読まない）になっていない`);

    assert.ok(lines.includes('throw tagElevatorOpFailure(err, { code: ERR_STAIR_DELETE_FAILED, message: ERR_STAIR_DELETE_FAILED_MESSAGE });'),
      `${entry.name}: 失敗の識別行が1行まるごとの形で見つからない`);
    const condIdx = lines.indexOf("if (r.status === 'rejected' || (r.status === 'aborted' && r.message)) {");
    assert.ok(condIdx >= 0 && lines[condIdx + 1] === 'setToast({ msg: r.message, key: Date.now() });',
      `${entry.name}: rejected／message ありの aborted のトースト（条件行の直後にトースト行）が見つからない`);
  });
}

test('【配線・件B】App.jsx: deleteStairCascade の isStillValid は mode・階・階段の存在を1行まるごとの形で確かめる', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function deleteStairCascade');
  assert.match(body, /^\s*const isStillValid = \(\) => modeRef\.current === fmode && project\.activeGraph === g && g\.stairMap\.has\(id\);\s*$/m,
    'isStillValid の行が1行まるごとの形で見つからない');
});

test('【配線・件B】App.jsx: applyRoomNaming は階段を外す意図を、昇降機・階段の新規指定の分岐の後・applyNaming より前で revertStairFromNaming へ分ける（1行まるごと）', () => {
  const body = extractFunctionBody(readAppSrc(), 'function applyRoomNaming');
  const lines = body.split('\n').map(l => l.trim());
  const branchIdx = lines.indexOf('if (modeRef.current?.isStairRemovalIntent(id, payload)) { guardUi(revertStairFromNaming)(id, payload); return; }');
  const elevatorIdx = lines.findIndex(l => l.startsWith('if (modeRef.current?.isElevatorInstallIntent(id, payload))'));
  const conversionIdx = lines.findIndex(l => l.startsWith('if (!stairChecked && modeRef.current?.isStairConversionIntent(id, payload)'));
  const applyIdx = lines.findIndex(l => l.includes('modeRef.current?.applyNaming('));
  assert.ok(branchIdx >= 0, '階段を外す分岐が1行まるごとの形で見つからない');
  assert.ok(elevatorIdx >= 0 && conversionIdx >= 0 && applyIdx >= 0, '比較対象の行が見つからない');
  assert.ok(elevatorIdx < branchIdx && conversionIdx < branchIdx && branchIdx < applyIdx,
    '階段を外す分岐は昇降機・階段の新規指定の分岐より後、applyNaming の呼び出しより前');
});

test('【配線・件B】App.jsx: revertStairFromNaming は階段実体が無ければ関門に入らず、isStillValid で意図の維持も確かめる', () => {
  const body = extractFunctionBody(readAppSrc(), 'async function revertStairFromNaming');
  const lines = body.split('\n').map(l => l.trim());
  const guardIdx = lines.indexOf('if (!stair) return; // 階段実体が既に無い等の退化ケース（関門に入らない）');
  assert.ok(guardIdx >= 0, 'stair が無いときの早期 return が見つからない');
  assert.ok(lines.includes('modeRef.current === fmode && project.activeGraph === g && g.stairMap.has(stairId) && fmode.isStairRemovalIntent(id, payload);'),
    'isStillValid の条件行が1行まるごとの形で見つからない');
  const beginIdx = lines.indexOf('beginUiTransition();');
  assert.ok(beginIdx > guardIdx, 'beginUiTransition() は早期 return の後');
});
