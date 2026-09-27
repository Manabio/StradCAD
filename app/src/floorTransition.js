/**
 * 階切替・モード切替・undo/redoの「関門」（画面全体の入力を塞ぐ遷移状態）を1箇所で管理する。
 *
 * 設計意図: 隙間A〜D（保存/読込みawait中の同期編集・割り込み・二重発火）を経路ごとに個別対策
 * するのではなく、遷移を起こす5経路（App.jsx handleFloorSwitch/switchFloorKeepingMode/
 * handleModeChange/performUndo/performRedo）が本モジュールの runFloorTransition() で自分の
 * 処理本体を包み、isFloorTransitioning() が真の間だけポインタ・キーボードを塞ぐ（App.jsx側の
 * 責務）。ここでは「今、関門の中か」を深さで数えるだけで、排他制御（mutex）は持たない
 * ——入れ子（例: performUndo内のswitchHistoryContextが内部でswitchFloorを呼ぶ）は深さの
 * 加算・減算で自然に処理でき、外側が終わるまで isFloorTransitioning() は真のままになる。
 * 葉モジュール: mobx以外の他のsrcをimportしない（node:testから単体import可能に保つ。
 * storage/floorWriteGeneration.jsと同じ規律）。
 */

import { observable, runInAction } from 'mobx';

const depth = observable.box(0);

/** 現在、いずれかの遷移（階切替・モード切替・undo/redo）の関門の中かどうか。 */
export function isFloorTransitioning() {
  return depth.get() > 0;
}

/**
 * fn を「関門の中」として実行する。呼び出しと同時（fnの最初のawaitより前）に同期で深さを進め、
 * fn の完了（成功・失敗いずれも）後に深さを戻す。入れ子呼び出しは深さで数えるだけで、
 * 外側の runFloorTransition が戻るまで isFloorTransitioning() は真のまま。
 */
export async function runFloorTransition(fn) {
  runInAction(() => depth.set(depth.get() + 1));
  try {
    return await fn();
  } finally {
    runInAction(() => depth.set(depth.get() - 1));
  }
}
