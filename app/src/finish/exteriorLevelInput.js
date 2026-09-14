/**
 * 屋外部屋の仕上げレベル入力（FinishTable.jsx ExteriorLevelRow）の純粋な判定ロジック。
 * .jsx から切り出す理由: node:test から DOM/React 非依存で単体テストするため
 * （team-lessons「抽出純モジュールはstore.js/snap.js/.jsxを静的に引かない」）。
 */

/**
 * 勾配入力の生テキスト（数字のみ許容済み）を解釈する。
 * 空文字・"0" は「勾配指定なし」を表すため null（既存値のクリア）。
 * @param {string} t
 * @returns {number | null}
 */
export function parseSlopeInput(t) {
  if (t === '' || t === '0') return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
