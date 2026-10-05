// タッチデバイスで、ブラウザ自身のジェスチャーがアプリ操作を邪魔しないようにする（純モジュール）。
//
// 止めるもの（ブラウザ側のジェスチャーだけ）:
// - ページのピンチ拡大: Safari 独自の gesturestart/gesturechange/gestureend、および touch-action が
//   効かない環境向けの保険として「2本指以上の touchmove」の既定動作。
// - 長押し由来の contextmenu（タッチ・ペン）。編集可能な要素の内側は止めない（貼り付けメニュー等を残す）。
// ダブルタップ拡大・長押しの文字選択・コールアウトは CSS（index.css の touch-action・user-select）と
// viewport の meta（index.html）が受け持つ。
//
// 止めないもの（今までどおり動かす）:
// - アプリ自身のピンチ・パン・2本指タップ＝Undo・3本指タップ＝Redo（Konva Stage の touch イベント。
//   ここでは preventDefault だけで stopPropagation はしないので、Stage 側のハンドラは走る）。
// - 1本指の touchmove（パネル・ダイアログのスクロールを残す）。
// - 全 touchstart の preventDefault は採らない（backGuard.js の決定と同じ。ボタンのクリック合成・
//   入力欄のフォーカスを壊すため）。
// - マウスの右クリック（contextmenu の由来が touch/pen と分かったときだけ止める。分からなければ止めない）。
//   既知の挙動: キーボードのメニューキーは pointerdown を伴わないので、直近の操作がタッチだと入力欄の外では
//   止まる（入力欄の外でブラウザのメニューを使う機能が無いので受容）。
// - OS のジェスチャー（アプリ切替・ホーム・通知・システムの戻る）。fullscreen・keyboard lock 等は使わない。
//
// 機能の無い環境でもエラーを出さない: doc が無い・addEventListener が無い・options を受けない実装・
// イベントに touches/cancelable/target.closest が無い、のどれでも例外を外へ出さない。
// リスナー登録の失敗は握って、その層だけ止める。
//
// グローバル（document）には直接触らず、引数で注入する。
// 例外の報告は console.error（error.js は文言定数の置き場で、純モジュールから呼ぶ報告口が無い）。

const GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'];
const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
const BLOCKED_POINTER_TYPES = ['touch', 'pen'];

/**
 * contextmenu を止めるか。タッチ／ペン由来で、対象が編集可能な要素の外のときだけ true。
 * 由来はイベント自身の pointerType を優先し、無ければ直近の pointerdown の pointerType を使う。
 * どちらも分からなければ false（マウスの右クリックを巻き込まない）。
 */
export function shouldBlockContextMenu({ eventPointerType, lastPointerType, targetEditable } = {}) {
  if (targetEditable) return false;
  const type = (typeof eventPointerType === 'string' && eventPointerType !== '')
    ? eventPointerType
    : lastPointerType;
  return BLOCKED_POINTER_TYPES.includes(type);
}

function isEditableTarget(target) {
  try {
    if (!target) return false;
    const el = typeof target.closest === 'function' ? target : target.parentElement;
    if (!el || typeof el.closest !== 'function') return false;
    return !!el.closest(EDITABLE_SELECTOR);
  } catch {
    return false;
  }
}

function safePreventDefault(e) {
  try {
    if (e && e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
  } catch (err) {
    console.error('gestureGuard: preventDefault に失敗', err);
  }
}

export function createGestureGuard({ doc } = {}) {
  let disposed = true;
  let lastPointerType = null;
  let listeners = [];

  const onGesture = (e) => {
    if (disposed) return;
    safePreventDefault(e);
  };

  const onTouchMove = (e) => {
    if (disposed) return;
    const touches = e && e.touches;
    if (!touches || !(touches.length >= 2)) return;
    safePreventDefault(e);
  };

  const onPointerDown = (e) => {
    if (disposed) return;
    const t = e && e.pointerType;
    lastPointerType = typeof t === 'string' && t !== '' ? t : null;
  };

  const onContextMenu = (e) => {
    if (disposed || !e) return;
    const block = shouldBlockContextMenu({
      eventPointerType: e.pointerType,
      lastPointerType,
      targetEditable: isEditableTarget(e.target),
    });
    if (block) safePreventDefault(e);
  };

  function start() {
    if (!disposed) return;
    disposed = false;
    lastPointerType = null;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const plan = [
      ...GESTURE_EVENTS.map(type => [type, onGesture, { passive: false }]),
      ['touchmove', onTouchMove, { passive: false }],
      ['pointerdown', onPointerDown, { capture: true, passive: true }],
      ['contextmenu', onContextMenu, { capture: true, passive: false }],
    ];
    for (const [type, fn, options] of plan) {
      try {
        doc.addEventListener(type, fn, options);
        listeners.push([type, fn, options]);
      } catch (err) {
        console.error(`gestureGuard: ${type} のリスナーを登録できないため、この層を止める`, err);
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const done = listeners;
    listeners = [];
    if (!doc || typeof doc.removeEventListener !== 'function') return;
    for (const [type, fn, options] of done) {
      try {
        doc.removeEventListener(type, fn, options);
      } catch (err) {
        console.error(`gestureGuard: ${type} のリスナーを外せない`, err);
      }
    }
  }

  return { start, dispose };
}
