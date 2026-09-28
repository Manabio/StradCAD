/**
 * BusyOverlay（関門=uiBusyが開いている間の全画面オーバーレイ）の表示タイミング定数と、
 * 関門labelの整形。純関数のみ——他のsrcをimportしない（node:testから単体import可能に保つ）。
 */

/** 関門が開いてからこのミリ秒を超えて続いたら、遅延ラベルを表示する（短い処理はちらつかせない）。 */
export const LABEL_DELAY_MS = 400;

/** 関門がこのミリ秒を超えて開いたままならconsole.warnで1回知らせる（自動解放はしない）。 */
export const WARN_AFTER_MS = 15000;

/** uiBusyLabel()の値を画面表示用の文字列へ整形する。labelがnullなら既定文言を返す。 */
export function formatBusyLabel(label) {
  return label ? `${label}中…` : '処理中…';
}
