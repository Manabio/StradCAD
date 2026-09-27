// 入力規制ステップ2: App.jsxの非同期入口を分類するベースラインテスト（製品コードは変更しない）。
// App.jsxはreact-konva等を静的に引くためnode:testから直接importできないため、uiBusyGate.test.jsと
// 同じ作法（ソーステキストを走査する）を使う。共用ヘルパーはuiBusySourceScan.js。
//
// 名前付き非同期入口（`async function <name>(`）は GATED（runBusy(が最初のawait。判定ロジックは
// uiBusyGate.test.jsと共通）と EXEMPT（対象外。{ name, reason }の明示リスト）のどちらかに分類し、
// App.jsxの実際の列挙結果と完全一致することを固定する。無名の非同期入口（IIFE・asyncアロー）は
// 個数の上限をベースライン定数で固定する（増減どちらも検知）。
//
// §5-4（usePointerInteraction.jsのisUiBusy()/.abort()の走査）はステップ3・4で追加する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readAppSrc,
  stripCommentLines,
  extractFunctionBody,
  assertRunBusyIsFirstAwait,
} from './uiBusySourceScan.js';

// ---- GATED（関門内。runBusy(が最初のawait）----
const GATED = ['performUndo', 'performRedo', 'handleModeChange', 'handleFloorSwitch', 'switchFloorKeepingMode'];

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
    reason: '呼び出し元はexecuteAddUpper/handleAddFloorConfirmのみ（いずれもステップ6で関門化予定のEXEMPT）。'
      + '関門化予定の呼び出し元から呼ばれる内部関数のため、呼び出し元がステップ6で関門化されれば合わせて解消する。対象外。',
  },
  {
    name: 'collectFloorBytes',
    reason: '呼び出し元はwithFloorAddUndoのみ（ステップ6で関門化予定のEXEMPT）。関門化予定の呼び出し元から呼ばれる'
      + '内部関数のため、呼び出し元がステップ6で関門化されれば合わせて解消する。対象外。',
  },
  {
    name: 'withFloorAddUndo',
    reason: '未対応（ステップ6で関門へ）。runより前にcollectFloorBytes（IDB読込含む）、run実行後にもcollectFloorBytes・'
      + 'undoManager.push（IIFE内でremoveFloor/applyFloorBytes等のgraph/IDB書込）を行う層2の入口だが、まだrunBusyに入っていない。',
  },
  {
    name: 'executeAddUpper',
    reason: '未対応（ステップ6で関門へ）。withFloorAddUndo経由でaddFloor・syncNewFloorFromSource（graph/IDB書込）を行う層2の'
      + '入口だが、まだrunBusyに入っていない。',
  },
  {
    name: 'handleAddFloorConfirm',
    reason: '未対応（ステップ6で関門へ）。withFloorAddUndo経由でaddFloor等（graph/IDB書込）を行う層2の入口だが、まだrunBusyに入っていない。',
  },
  {
    name: 'handleFloorMenuAction',
    reason: '未対応（ステップ6で関門へ）。delete/delete-alt/add-alt/copy-alt等の分岐でremoveFloor・restoreGraph・runInAction'
      + '（graph/IDB書込）を行う層2の入口だが、まだrunBusyに入っていない。',
  },
  {
    name: 'removeStairsOnFloor',
    reason: '呼び出し元はhandleFloorMenuActionの action===\'delete\' 分岐のみ（ステップ6で関門化予定のEXEMPT）。'
      + '関門化予定の呼び出し元から呼ばれる内部関数のため、呼び出し元がステップ6で関門化されれば合わせて解消する。対象外。',
  },
  {
    name: 'commitAxisEdit',
    reason: '未対応（分類ステップで発見。ステップ5または6で扱う）。唯一のawait（resolveLowestGraph）から戻った後にapply(newVal)'
      + '（si.columnFaceProjections.set/deleteとautoFillColumnAxisOffsets/autoFillBeamEccentricityでgraphを書く）を行うため、'
      + '判定基準（最初のawait後にgraph/IDBを書くか）に該当する層2の入口。カタログ以外で発見したため報告で目立たせる。',
  },
  {
    name: 'handleDeleteCenterLine',
    reason: '未対応（ステップ3で関門へ）。structuralSync.whenIdle()の後にdeleteCenterLineWithUndo（graph書込・他階IDB読み書きを伴う）'
      + 'を行う層2の入口だが、まだrunBusyに入っていない。',
  },
  {
    name: 'handleEccConfirm',
    reason: '未対応（分類ステップで発見。ステップ5または6で扱う）。handleDeleteCenterLineと同型（structuralSync.whenIdle()の後に'
      + 'applyCLEccentricityWithUndoでgraph・他階IDBを書く）で層2の入口だが、まだrunBusyに入っていない。CL関連のためステップ3以降で'
      + '扱う候補として報告で目立たせる。',
  },
];

// EXEMPT reasonに「未対応」を含む件数（ステップ3〜6で減らし、ステップ7で0をassertする）。
const PENDING_COUNT = 7;

// ---- 無名の非同期入口（IIFE・asyncアロー）の個数上限 ----
// IIFE: `(async (...) => { ... })(...)`。asyncアロー（コールバック）: それ以外の
// `async (...) => `／`async <ident> =>`（関数呼び出しの引数・オブジェクトのプロパティ値等）。
const ANON_IIFE_COUNT = 6;
const ANON_CALLBACK_COUNT = 15;
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

  const exemptNames = EXEMPT.map(e => e.name);
  const classifiedNames = new Set([...GATED, ...exemptNames]);

  // 分類表にあるがApp.jsxに存在しない名前
  for (const name of classifiedNames) {
    assert.ok(actualNames.has(name), `分類表にある \`${name}\` がApp.jsxに存在しません`);
  }
  // App.jsxにあるが分類表にない名前
  for (const name of actualNames) {
    assert.ok(classifiedNames.has(name), `新しい非同期入口 \`${name}\` が分類されていません（GATEDかEXEMPTに追加し理由を書く）`);
  }
  // 重複登録が無いこと
  assert.equal(classifiedNames.size, GATED.length + exemptNames.length,
    'GATED/EXEMPTに同じ名前が重複して登録されています');
});

for (const name of GATED) {
  test(`【分類・GATED】App.jsx: ${name} はrunBusy(が最初のawait`, () => {
    const appSrc = readAppSrc();
    const body = extractFunctionBody(appSrc, `async function ${name}`);
    assertRunBusyIsFirstAwait(body, name);
  });
}

test('【分類】EXEMPTのreasonに「未対応」を含む件数はPENDING_COUNTと一致する（ステップ3〜6で減らし、ステップ7で0にする）', () => {
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
