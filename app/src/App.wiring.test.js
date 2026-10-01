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
  const addIdx   = body.indexOf('addFloor(pl.elevation, pl.name, pl.startFloor, pl.stories, pl.id);');
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
