// ModePanel（横長の右側パネル）のドロワー開閉の判断。純モジュール（react・store.js を引かない）。

// 取っ手の寸法（px）。右ガター（幅48px）の通り芯ラベル・長押しの邪魔を最小にするため小さくする。
export const HANDLE_WIDTH = 20;
export const HANDLE_HEIGHT = 64;

// 信号が truthy に変化したときだけ開く（BottomSheet の raiseSignal と同じ規則）。
// 同じ値のまま・falsy への変化では開かない（0・空文字・null・undefined は falsy）。
export function shouldOpenOnSignal(prevSignal, signal) {
  return signal !== prevSignal && !!signal;
}

// 外枠の transform。開＝移動なし／閉＝自分の幅ぶん右へ退避。
export function drawerTransform(open) {
  return open ? 'translateX(0)' : 'translateX(100%)';
}
