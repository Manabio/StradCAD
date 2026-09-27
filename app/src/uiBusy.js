/**
 * awaitをまたいでgraph／IDBを書くUI入口（層2）が同期で入る、汎用の「UI busy 関門」（画面全体の
 * 入力を塞ぐ状態）を1箇所で管理する。同期編集（層0）と背景の構造同期（層1。structuralSync.js）は
 * 対象外——それらは自前のwhenIdle()を持つ。
 *
 * 現在の利用者は階切替・モード切替・undo/redo（App.jsxの5経路: handleFloorSwitch/
 * switchFloorKeepingMode/handleModeChange/performUndo/performRedo）に加え、CL削除・入替え・
 * 偏芯・出幅編集（App.jsxのhandleDeleteCenterLine/handleConvertCenterLine/handleEccConfirm/
 * commitAxisEdit）・移動準備（modes/FloorplanModeState.jsのstartMove内。App.jsx側は
 * beginUiTransitionを呼ばない）も同じ関門に入る（入力規制ステップ3・2026-09-28）。以後保存・
 * 読込み・階操作も同じ関門に入る予定。各経路が本モジュールの runBusy() で自分の処理本体を包み、
 * isUiBusy() が真の間だけポインタ・キーボードを塞ぐ（App.jsx側の責務）。ここでは「今、関門の中か」
 * を深さで数えるだけで、排他制御（mutex）は持たない——入れ子が多く（例: performUndo内の
 * switchHistoryContextが内部でswitchFloorを呼ぶ）mutexにすると容易にデッドロックするため、
 * 深さの加算・減算で自然に処理し、外側が終わるまでisUiBusy()は真のままにする。
 * 葉モジュール: mobx以外の他のsrcをimportしない（node:testから単体import可能に保つ。
 * storage/floorWriteGeneration.jsと同じ規律）。
 */

import { observable, runInAction } from 'mobx';

const depth = observable.box(0);
const currentLabel = observable.box(null);
let idleResolvers = [];

/** 現在、いずれかのUI入口の関門の中かどうか。 */
export function isUiBusy() {
  return depth.get() > 0;
}

/** 現在の関門の最外側のlabel（観測可能）。関門の外ではnull。入れ子の内側のlabelには置き換わらない。 */
export function uiBusyLabel() {
  return currentLabel.get();
}

/**
 * fn を「関門の中」として実行する。呼び出しと同時（fnの最初のawaitより前）に同期で深さを進め、
 * fn の完了（成功・失敗いずれも）後に深さを戻す。入れ子呼び出しは深さで数えるだけで、
 * 外側の runBusy が戻るまで isUiBusy() は真のまま。label は深さが 0→1 のときだけ記録し、
 * 深さが 0 に戻ったときに null へ戻す（入れ子の内側の label は表示しない）。
 */
export async function runBusy(label, fn) {
  runInAction(() => {
    if (depth.get() === 0) currentLabel.set(label);
    depth.set(depth.get() + 1);
  });
  try {
    return await fn();
  } finally {
    runInAction(() => {
      depth.set(depth.get() - 1);
      if (depth.get() === 0) {
        currentLabel.set(null);
        const resolvers = idleResolvers;
        idleResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    });
  }
}

/**
 * depth が 0 になるまで待つ Promise（既に 0 なら即resolve）。テストと将来のステップ
 * （保存・読込み・階操作を関門に組み込む際の待ち合わせ）用。CL削除・入替え・偏芯・出幅編集は
 * 入力規制ステップ3で対応済み（whenUiIdle自体は使わず、各入口が自身のrunBusy呼び出しの中で
 * structuralSync.whenIdle()を待つ）。UIからは使わない。
 * @returns {Promise<void>}
 */
export function whenUiIdle() {
  if (depth.get() === 0) return Promise.resolve();
  return new Promise(resolve => { idleResolvers.push(resolve); });
}
