// スマホ・タブレットの「戻る」操作で編集中の文書から離れないための多層防御（純モジュール）。
//
// 前提（調査で確定）:
// - 左右どちらの端からでも戻る症状は Android 10 以降のシステムの戻るジェスチャー。OS が Chrome より
//   手前で横取りするため、ページ側の touchstart の preventDefault・touch-action・
//   overscroll-behavior では止められない。よって「ジェスチャーを止める」のではなく
//   「戻るが起きても文書から離れない」ようにする。
// - 全 touchstart の preventDefault は採らない（システムジェスチャーに効かず、ボタンのクリック合成・
//   入力欄のフォーカス・パネルのスクロールを壊すため）。
// - 3ボタンナビの端末の Chrome 自身のオーバースクロール履歴移動・プル更新は CSS
//   overscroll-behavior: none（index.css）で止める。
//
// L1（Android のみ）: CloseWatcher（Chrome 126 以降）。有効な CloseWatcher があれば Android の戻るは
//   それを閉じるだけで履歴は動かない。close のたびに作り直す。
// L2（Android・iOS）: 履歴の番兵。Chrome の history manipulation intervention により、ユーザー操作なしで
//   足した履歴エントリは戻るで飛ばされるため、pushState は必ずユーザー操作のハンドラの中で行う。
//   番兵の有無は内部フラグでなく毎回 history.state で判定する（reload・bfcache 復帰でもずれない）。
//   番兵の無いエントリへ降りたら、pushState でなく history.forward() で番兵へ戻る
//   （履歴を足さないので intervention の対象にならない）。forward が効かない（前方エントリ無し）
//   場合は、次のユーザー操作で積み直される。
//
// デスクトップを対象外にする理由: 戻るボタンが空振りして番兵が意味を持たず、デスクトップ Chrome の
// CloseWatcher は Esc に反応してアプリの Esc 操作と競合するため。
//
// グローバル（window・history・navigator）には直接触らず、すべて引数で注入する。
// 例外の報告は console.error（error.js は文言定数の置き場で、純モジュールから呼ぶ報告口が無い）。

export const GUARD_STATE_KEY = '__stradBackGuard';

const GESTURE_EVENTS = ['pointerup', 'touchend', 'keydown'];

/** 'android' | 'ios' | null（デスクトップ・判定不能は null）。 */
export function detectBackGuardPlatform({ userAgent, uaDataPlatform, maxTouchPoints } = {}) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (uaDataPlatform === 'Android' || /Android/.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  // iPadOS のデスクトップ表示は Macintosh を名乗るため、タッチ点数で Mac と区別する
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return 'ios';
  // Android タブレットの Chrome は既定で PC版サイト表示になり、UA が X11; Linux になって Android の語が
  // 消えるため、タッチ付きの Linux を android とみなす。タッチ画面付きの Linux PC も android 扱いに
  // なる誤判定は受容する（戻るボタンが空振りするだけ）。ChromeOS（X11; CrOS）は含まれない。
  if (/X11; Linux/.test(ua) && maxTouchPoints > 1) return 'android';
  return null;
}

export function createBackGuard({ win, history, platform, CloseWatcherCtor }) {
  let disposed = true;
  let l2Dead = false;
  let watcher = null;
  let listeners = [];

  const hasGuard = () => {
    const s = history.state;
    return s !== null && typeof s === 'object' && s[GUARD_STATE_KEY] === true;
  };

  const destroyWatcher = () => {
    const w = watcher;
    watcher = null;
    if (!w) return;
    try { w.destroy(); } catch (err) { console.error('backGuard: CloseWatcher の破棄に失敗', err); }
  };

  const createWatcher = () => {
    try {
      const w = new CloseWatcherCtor();
      w.addEventListener('close', () => {
        if (disposed || watcher !== w) return;
        watcher = null;
        createWatcher();
      });
      watcher = w;
    } catch (err) {
      console.error('backGuard: CloseWatcher を作れないため L1 を止める', err);
      watcher = null;
    }
  };

  const onGesture = () => {
    if (disposed || l2Dead || hasGuard()) return;
    try {
      history.pushState({ [GUARD_STATE_KEY]: true }, '');
    } catch (err) {
      l2Dead = true;
      console.error('backGuard: 履歴の番兵を積めないため L2 を止める', err);
    }
  };

  const onPopState = () => {
    if (disposed || l2Dead || hasGuard()) return;
    try {
      history.forward();
    } catch (err) {
      l2Dead = true;
      console.error('backGuard: 履歴を進められないため L2 を止める', err);
    }
  };

  function start() {
    if (!platform || !disposed) return;
    disposed = false;
    l2Dead = false;
    for (const type of GESTURE_EVENTS) listeners.push([type, onGesture, true]);
    listeners.push(['popstate', onPopState, false]);
    for (const [type, fn, capture] of listeners) win.addEventListener(type, fn, capture);
    if (platform === 'android' && typeof CloseWatcherCtor === 'function') createWatcher();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [type, fn, capture] of listeners) win.removeEventListener(type, fn, capture);
    listeners = [];
    destroyWatcher();
  }

  return { start, dispose };
}
