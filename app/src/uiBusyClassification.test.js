// 入力規制ステップ2: App.jsxの非同期入口を分類するベースラインテスト（製品コードは変更しない）。
// App.jsxはreact-konva等を静的に引くためnode:testから直接importできないため、uiBusyGate.test.jsと
// 同じ作法（ソーステキストを走査する）を使う。共用ヘルパーはuiBusySourceScan.js。
//
// 名前付き非同期入口（`async function <name>(`）は GATED（runBusy(が最初のawait。判定ロジックは
// uiBusyGate.test.jsと共通）と EXEMPT（対象外。{ name, reason }の明示リスト）のどちらかに分類し、
// App.jsxの実際の列挙結果と完全一致することを固定する。無名の非同期入口（IIFE・asyncアロー）は
// 個数の上限をベースライン定数で固定する（増減どちらも検知）。
//
// §5-4（usePointerInteraction.jsのisUiBusy()の走査）はステップ3で追加した（.abort()はステップ4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readAppSrc,
  stripCommentLines,
  extractFunctionBody,
  extractArrowFunctionBody,
  assertRunBusyIsFirstAwait,
  assertBeginUiTransitionBeforeRunBusy,
  assertFirstStatementIs,
} from './uiBusySourceScan.js';

// ---- GATED（関門内。runBusy(が最初のawait）----
// 文字列の他に { name, noBeginUiTransition: true, reason } も許す——undoFloorAdd/redoFloorAddは
// performUndo/performRedoの関門を抜けた後もfire-and-forgetで走り続けるため自前でrunBusyを持つが、
// beginUiTransition()（interruptCurrentActionが今の操作を中断してしまう）はperformUndo/performRedo
// が既に済ませているためここでは呼ばない（入力規制ステップ6）。
const GATED = [
  'performUndo', 'performRedo', 'handleModeChange', 'handleFloorSwitch', 'switchFloorKeepingMode',
  'handleDeleteCenterLine', 'handleConvertCenterLine', 'handleEccConfirm', 'commitAxisEdit',
  'handleSaveConfirm', 'runDocumentImport', 'openCatalogMaintenancePanel',
  'withFloorAddUndo',
  {
    name: 'undoFloorAdd', noBeginUiTransition: true,
    reason: 'performUndoのrunBusy(の関門を抜けた後もfire-and-forgetで走り続けるため自前のrunBusyを持つ。'
      + 'beginUiTransition()はperformUndoが既に済ませており、ここで呼ぶと今の操作を中断してしまうため呼ばない。',
  },
  {
    name: 'redoFloorAdd', noBeginUiTransition: true,
    reason: '同上（performRedo側）。',
  },
  'runAddAlternative', 'runDeleteFloor', 'runDeleteAlternative', 'runCopyAlternative',
  'installElevatorFromNaming', 'deleteElevatorEquipment', 'changeElevatorUsage',
  'handleCLDialogConfirm',
];

function gatedName(entry) {
  return typeof entry === 'string' ? entry : entry.name;
}

test('【分類】GATEDのオブジェクトエントリ（noBeginUiTransition等）は全て空でないreasonを持つ', () => {
  for (const entry of GATED) {
    if (typeof entry === 'string') continue;
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0,
      `GATEDの \`${entry.name}\` にreasonが無い（例外扱いの根拠を書く）`);
  }
});

// ---- EXEMPT（対象外。理由付き）----
// 各reasonはソースを読んで判定した根拠（file:lineではなく関数名で示す。App.jsx内の1ファイルのため）。
const EXEMPT = [
  {
    name: 'handleApplyCatalogResolutions',
    reason: '唯一のawait（applyCatalogResolutions）から戻った後はsetCatalogReloadKey（React state）のみを書き、'
      + 'graph/IDBは書かない（判定基準: 最初のawait後にgraph/IDBを書くか）。対象外。',
  },
  {
    name: 'switchHistoryContext',
    reason: 'performUndo/performRedoのrunBusy(本体からcmd.context経由で呼ばれる内部関数（関門内から呼ばれる）。恒久的に対象外。',
  },
  {
    name: 'trySwitchFloor',
    reason: 'handleFloorSwitch/switchFloorKeepingMode（既に関門内で自走する）をrunで呼び、例外を成否（真偽値）に変えるだけの薄いラッパー。'
      + '自身はgraph/IDBを書かない。恒久的に対象外。',
  },
  {
    name: 'collectOpeningNumbersAllFloors',
    reason: 'modeBoundaries.opening/elevation.enterとして、handleModeChange/switchFloorKeepingModeのrunBusy(本体から呼ばれる内部関数。'
      + 'graphは変更しない（採番キャッシュのみ）。恒久的に対象外。',
  },
  {
    name: 'runStructuralEntryBoundary',
    reason: 'modeBoundaries.structure.enterとして、handleModeChange/switchFloorKeepingModeのrunBusy(本体から呼ばれる内部関数。恒久的に対象外。',
  },
  {
    name: 'runStructuralExitBoundary',
    reason: 'modeBoundaries.structure.exitとして、handleModeChange/switchFloorKeepingModeのrunBusy(本体から呼ばれる内部関数。恒久的に対象外。',
  },
  {
    name: 'handleStructuralFloorSwitch',
    reason: '同一平面ならsetActiveStructSlotKey（React state）を書くだけで返る。別平面ならswitchFloorKeepingMode（既に関門内）を'
      + 'await呼び出しするだけで、await前後で自らgraph/IDBを書かない。対象外。',
  },
  {
    name: 'handleStructuralSlotSwitch',
    reason: '同一平面ならsetActiveStructSlotKey（React state）を書くだけで返る。別平面ならswitchFloorKeepingMode（既に関門内）を'
      + 'awaitした後setActiveStructSlotKey（React state）を書くのみで、graph/IDBは書かない。対象外。',
  },
  {
    name: 'syncNewFloorFromSource',
    reason: '呼び出し元はexecuteAddUpper/handleAddFloorConfirm（いずれもwithFloorAddUndo経由でGATEDのEXEMPT）のみ。'
      + '関門化済みの呼び出し元（runBusyの中）から呼ばれる内部関数のため対象外（入力規制ステップ6）。',
  },
  {
    name: 'collectFloorBytes',
    reason: '呼び出し元はwithFloorAddUndo（GATED）のみ。関門化済みの呼び出し元（runBusyの中）から呼ばれる'
      + '内部関数のため対象外（入力規制ステップ6）。',
  },
  {
    name: 'executeAddUpper',
    reason: '呼び出し元はhandleAddFloor（[+]ボタン。onClickがguardUiで包装済み）とhandleAddFloorConfirmのみ。'
      + '本体はwithFloorAddUndo（既に関門内で自走）をawaitするだけで、awaitの前後で自らgraph/IDBを書かない'
      + '（判定基準はtrySwitchFloorと同じ）。恒久的に対象外（入力規制ステップ6）。',
  },
  {
    name: 'handleAddFloorConfirm',
    reason: '呼び出し元はAddFloorDialogのonConfirm（guardUiで包装済み）のみ。本体はexecuteAddUpper/withFloorAddUndo'
      + '（既に関門内で自走）をawaitするだけで、awaitの前後で自らgraph/IDBを書かない。恒久的に対象外（入力規制ステップ6）。',
  },
  {
    name: 'removeStairsOnFloor',
    reason: '呼び出し元はrunDeleteFloor（GATED）のみ。関門化済みの呼び出し元（runBusyの中）から呼ばれる'
      + '内部関数のため対象外（入力規制ステップ6）。',
  },
  {
    name: 'runDeleteCenterLine',
    reason: '呼び出し元はhandleDeleteCenterLine（GATED）のみ。deleteCenterLineWithUndo→toast→setFloorSyncTick'
      + 'を切り出した内部関数で、関門化済みの呼び出し元（runBusyの中）から呼ばれる（手動追加材'
      + 'サイレント撤去回避 指示書§5ステップ3）。自身はrunBusyを持たず、awaitの前後で自らgraph/IDBを'
      + '書くが、それはhandleDeleteCenterLineの関門内で行われる。恒久的に対象外。',
  },
  {
    name: 'runConvertCenterLine',
    reason: '呼び出し元はhandleConvertCenterLine（GATED）のみ。promoteCenterToGridWithUndo/'
      + 'demoteGridToCenterWithUndo呼び出し→toast→setFloorSyncTickを切り出した内部関数で、'
      + '関門化済みの呼び出し元（1段目・2段目いずれのrunBusyも）から呼ばれる（手動追加材サイレント'
      + '撤去回避 指示書§5ステップ4。runDeleteCenterLineと同じ形）。自身はrunBusyを持たず、'
      + 'awaitの前後で自らgraph/IDBを書くが、それはhandleConvertCenterLineの関門内で行われる。'
      + '恒久的に対象外。',
  },
  {
    name: 'startCenterLineMove',
    reason: 'App.jsxの本体はmodeRef.current?.startMove(cl)をawaitしtoastを出すだけで、関門（runBusy）は'
      + 'FloorplanModeState.startMoveの内部で開く（beginUiTransitionをここで呼ぶとinterruptCurrentActionが'
      + 'cancelMoveを呼び準備中の移動を壊すため、意図的にApp.jsx側では関門に入らない）。恒久的に対象外（ステップ3）。',
  },
];

// EXEMPT reasonに「未対応」を含む件数（ステップ3〜6で減らす。ステップ6で対象が尽きたため0にする）。
const PENDING_COUNT = 0;

// ---- 無名の非同期入口（IIFE・asyncアロー）の個数上限 ----
// IIFE: `(async (...) => { ... })(...)`。asyncアロー（コールバック）: それ以外の
// `async (...) => `／`async <ident> =>`（関数呼び出しの引数・オブジェクトのプロパティ値等）。
// ステップ3で cl-move・cl-to-grid/cl-to-center のIIFE2件を名前付き関数（startCenterLineMove・
// handleConvertCenterLine）へ切り出したため6→4。一方、runBusy(に渡す`async () => {...}`
// コールバック（handleDeleteCenterLine・handleConvertCenterLine・handleEccConfirm・
// commitAxisEditの4件）が新たに加わったため15→19。ステップ5で保存・読込み・カタログ保守を開くの
// runBusy(コールバック3件（handleSaveConfirm・runDocumentImport・openCatalogMaintenancePanel）が
// 加わったため19→22。ステップ6でwithFloorAddUndoのundo/redoクロージャ内のIIFE2件を名前付き関数
// （undoFloorAdd・redoFloorAdd）へ切り出したため4→2（残るのは412/435の上階peek useEffectのみ）。
// 一方runBusy(コールバック7件（withFloorAddUndo・undoFloorAdd・redoFloorAdd・runAddAlternative・
// runDeleteFloor・runDeleteAlternative・runCopyAlternative）が新たに加わったため22→29。
// 昇降機の仕様追加ステップ4・S3bでinstallElevatorFromNaming（GATED）のrunBusy(コールバック1件が
// 加わったため29→30。ステップ4・S4で project.equipmentIndex を埋めるuseEffect内のIIFE
// （410/435の上階peek useEffectと同型）が1件加わったため2→3（412/435→412/435/新規の3件）。
// ステップ5でdeleteElevatorEquipment・changeElevatorUsage（いずれもGATED）のrunBusy(コールバックが
// 2件加わったため30→32。手動追加材サイレント撤去回避ステップ3でhandleDeleteCenterLineが
// 固定材の事前確認を挟む2段runBusy構成になり、runBusy(コールバックが1件（確認了承後の2段目）
// 加わったため32→33。同ステップ4でhandleConvertCenterLineも同じ2段runBusy構成になり、
// runBusy(コールバックが1件（確認了承後の2段目）加わったため33→34。線種変更の移籍一本化
// ステップ5でhandleCLDialogConfirmが新たにGATEDへ加わり、そのrunBusy(コールバックが1件
// 加わったため34→35。
const ANON_IIFE_COUNT = 3;
const ANON_CALLBACK_COUNT = 35;
const ANON_TOTAL_COUNT = ANON_IIFE_COUNT + ANON_CALLBACK_COUNT;

function findNamedAsyncFunctions(code) {
  const names = [];
  const re = /async function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code))) names.push(m[1]);
  return names;
}

// `async`の直前（空白を無視した直前の非空白文字）が`(`で、かつその`(`の直前（同様に空白無視）が
// 識別子文字（呼び出し・メソッドの引数として渡している＝コールバック）でなければ、その`(`は
// 文単独のグルーピング括弧＝即時実行関数（IIFE）と判定する。`(`が無ければ単純呼び出しの引数・
// プロパティ値等のコールバックと判定する。
function precedingNonWhitespaceChar(code, idx) {
  let i = idx - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  return i >= 0 ? code[i] : '';
}

function classifyAnonymousAsyncArrows(code) {
  const re = /async\s*(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g;
  const iife = [];
  const callback = [];
  let m;
  while ((m = re.exec(code))) {
    const asyncIdx = m.index;
    const before1 = precedingNonWhitespaceChar(code, asyncIdx);
    if (before1 !== '(') { callback.push(m[0]); continue; }
    // before1の'('の位置を探す（asyncIdxから逆走査で直近の非空白文字が'('だったその位置）
    let parenIdx = asyncIdx - 1;
    while (/\s/.test(code[parenIdx])) parenIdx--;
    const before2 = precedingNonWhitespaceChar(code, parenIdx);
    if (/[A-Za-z0-9_$]/.test(before2)) callback.push(m[0]);
    else iife.push(m[0]);
  }
  return { iife, callback };
}

test('【分類】App.jsx: 名前付き非同期入口はGATED/EXEMPTのいずれかに分類され、実際の列挙結果と完全一致する', () => {
  const appSrc = readAppSrc();
  const code = stripCommentLines(appSrc);
  const actualNames = new Set(findNamedAsyncFunctions(code));

  const gatedNames  = GATED.map(gatedName);
  const exemptNames = EXEMPT.map(e => e.name);
  const classifiedNames = new Set([...gatedNames, ...exemptNames]);

  // 分類表にあるがApp.jsxに存在しない名前
  for (const name of classifiedNames) {
    assert.ok(actualNames.has(name), `分類表にある \`${name}\` がApp.jsxに存在しません`);
  }
  // App.jsxにあるが分類表にない名前
  for (const name of actualNames) {
    assert.ok(classifiedNames.has(name), `新しい非同期入口 \`${name}\` が分類されていません（GATEDかEXEMPTに追加し理由を書く）`);
  }
  // 重複登録が無いこと
  assert.equal(classifiedNames.size, gatedNames.length + exemptNames.length,
    'GATED/EXEMPTに同じ名前が重複して登録されています');
});

for (const entry of GATED) {
  const name = gatedName(entry);
  test(`【分類・GATED】App.jsx: ${name} はrunBusy(が最初のawait`, () => {
    const appSrc = readAppSrc();
    const body = extractFunctionBody(appSrc, `async function ${name}`);
    assertRunBusyIsFirstAwait(body, name);
  });
  if (typeof entry === 'string' || !entry.noBeginUiTransition) {
    test(`【分類・GATED】App.jsx: ${name} はbeginUiTransition()をrunBusy(より前で呼ぶ`, () => {
      const appSrc = readAppSrc();
      const body = extractFunctionBody(appSrc, `async function ${name}`);
      assertBeginUiTransitionBeforeRunBusy(body, name);
    });
  } else {
    test(`【分類・GATED・例外】App.jsx: ${name} はbeginUiTransition()を呼ばない（${entry.reason}）`, () => {
      const appSrc = readAppSrc();
      const body = extractFunctionBody(appSrc, `async function ${name}`);
      assert.ok(!body.includes('beginUiTransition()'), `${name} の本体にbeginUiTransition()があってはいけない`);
    });
  }
}

// commitAxisEditは、beginUiTransition()（内部でinterruptCurrentAction→cancelAxisEditを呼び
// axisEditStateを消す）より前に、axisEditStateの読み出し・key/oldRawの採取を同期で済ませて
// おく必要がある（「落とし穴」・入力規制ステップ3のQA指摘）。
test('【分類・GATED】App.jsx: commitAxisEdit はaxisEditStateの読み出し・oldRawの採取がbeginUiTransition()より前', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'async function commitAxisEdit');
  const beginIdx = body.indexOf('beginUiTransition()');
  assert.ok(beginIdx >= 0, 'commitAxisEditの本体にbeginUiTransition()の呼び出しが無い');
  const esIdx = body.indexOf('axisEditState');
  assert.ok(esIdx >= 0 && esIdx < beginIdx,
    'commitAxisEditではaxisEditStateの読み出しがbeginUiTransition()より前である必要がある');
  const oldRawIdx = body.indexOf('oldRaw = ');
  assert.ok(oldRawIdx >= 0 && oldRawIdx < beginIdx,
    'commitAxisEditではoldRawの採取がbeginUiTransition()より前である必要がある');
});

test('【分類】EXEMPTのreasonに「未対応」を含む件数はPENDING_COUNTと一致する（ステップ3〜6で0まで減らした）', () => {
  const pending = EXEMPT.filter(e => e.reason.includes('未対応'));
  assert.equal(pending.length, PENDING_COUNT,
    `未対応件数が想定と異なる（実際: ${pending.map(e => e.name).join(', ')}）`);
});

test('【分類】App.jsx: 無名の非同期入口（IIFE・asyncアロー）の個数はベースラインで固定されている', () => {
  const appSrc = readAppSrc();
  const code = stripCommentLines(appSrc);
  const { iife, callback } = classifyAnonymousAsyncArrows(code);
  assert.equal(iife.length, ANON_IIFE_COUNT,
    `無名IIFEの数が想定と異なる（実際: ${iife.length}件）。増減どちらもGATED/EXEMPT分類の見直しが必要`);
  assert.equal(callback.length, ANON_CALLBACK_COUNT,
    `無名asyncアロー（コールバック）の数が想定と異なる（実際: ${callback.length}件）。増減どちらもGATED/EXEMPT分類の見直しが必要`);
  assert.equal(iife.length + callback.length, ANON_TOTAL_COUNT);
});

// ---- §5-4（遮断点A）: usePointerInteraction.jsのisUiBusy()走査（.abort()の走査はステップ4）----
// handlePointerDown/handleTouchStartはアロー関数（`const <name> = (e) => {`）なので、
// extractFunctionBody（"async function <name>"／") {"探索）は使えない。ニードル自体が末尾`{`で
// 終わるようにし、その位置から波括弧の対応数で本体を抽出する（extractArrowFunctionBodyは
// uiBusySourceScan.jsで共用。ステップ4の.abort()走査でも使う）。
test('【分類・§5-4】usePointerInteraction.js: handlePointerDown/handleTouchStart は本体の最初の文がisUiBusy()ガードである（途中・末尾にあるだけでは緑にしない）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'interaction/usePointerInteraction.js'), 'utf8');
  const pdBody = extractArrowFunctionBody(src, 'const handlePointerDown = (e) => {');
  assertFirstStatementIs(pdBody, 'if (isUiBusy()) return;', 'handlePointerDown');
  const tsBody = extractArrowFunctionBody(src, 'const handleTouchStart = (e) => {');
  assertFirstStatementIs(tsBody, 'if (isUiBusy()) return;', 'handleTouchStart');
});

// ---- §5-4後半（入力規制ステップ4）: resetGestureRefsが長押しタイマーをabortすることの走査 ----
// 関門に入る直前（App.jsx beginUiTransition→interruptCurrentAction）に押し始めた長押し
// （gutterLongPress／axisLabelLongPress／longPress）のsetTimeoutが生きたまま残ると、関門の中で
// 500ms後にonFireしてメニュー表示やstartMoveを起こす（§1.3の穴）。3つのabort()呼び出しを
// 個別にassertする（1つでも欠けたら該当assertだけが赤になるよう、まとめて1個のincludes判定にはしない）。
test('【分類・§5-4後半】usePointerInteraction.js: resetGestureRefs はgutterLongPress/axisLabelLongPress/longPressをabortする', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, 'interaction/usePointerInteraction.js'), 'utf8');
  const body = extractFunctionBody(src, 'function resetGestureRefs');
  assert.ok(body.includes('gutterLongPress.abort()'), 'resetGestureRefsの本体にgutterLongPress.abort()が無い');
  assert.ok(body.includes('axisLabelLongPress.abort()'), 'resetGestureRefsの本体にaxisLabelLongPress.abort()が無い');
  assert.ok(body.includes('longPress.abort()'), 'resetGestureRefsの本体にlongPress.abort()が無い');
});

// ---- §5-4後半・QA差し戻し（2026-09-28）: interruptCurrentActionが仕上げモードのドラッグをcancelする ----
// resetGestureRefsはfinishDragDownRefをnullに戻すだけで、対になるFinishModeState.dragStateは
// 消さない。仕上げモードでドラッグ中にESC／関門突入すると、dragStateが残ったままプレビュー・
// crosshairが消えず、pointermove/pointerupの`finishDragDownRef.current && dragState`条件で
// commitDragも飛ばされる（QA指摘）。interruptCurrentActionの本体にcancelDragの呼び出しがある
// ことを固定する（cancelDragを持つのはFinishModeStateのみ。他モードはno-op）。
test('【分類・QA指摘】App.jsx: interruptCurrentAction はmodeRef.current?.cancelDrag?.()を呼ぶ', () => {
  const appSrc = readAppSrc();
  const body = extractFunctionBody(appSrc, 'function interruptCurrentAction');
  assert.ok(body.includes('cancelDrag'), 'interruptCurrentActionの本体にcancelDragの呼び出しが無い');
});
