// 描画エリアの押下ジェスチャーの見分け（クリック／ロングタップ／ドラッグ＝パン）。純モジュール（import ゼロ。node:test）。
//
// 全モード共通の規則（2026-10-19「平面モード以外でも図面内の任意の点で画面移動できる」）:
//   ・ドラッグ   … 長押し成立（500ms）前に閾値超動いた → パン（画面移動）。閾値と判定は useLongPress.js の MOVE_THRESHOLD
//                  （8px。move が true を返す瞬間）で、ここの TAP_MOVE_PX は離したときのタップ判定の同じ値（別定数。
//                  useLongPress は react を引くためここから参照しない）。
//   ・ロングタップ … 500ms 静止して成立（useLongPress の onFire）。仕上げ・天伏はここからセルのなぞり（複数セルの指定）を始める。
//                  成立後に dragState が無ければ（階段などを選択済み・選べないセル）動けばパン（反応の無い押下にしない）。
//   ・クリック   … 成立前に動かず離した → タップの処理（仕上げ・天伏は startDrag＋commitDrag({tap:true})＝従来のタップと同じ）。
//   パンの終了直後に Konva が出す click（押した図形と離した図形が同じなら移動量によらず出る）は、
//   usePointerInteraction の didPanEnd（パンの積算が TAP_MOVE_PX 以上）を見て無視する（SceneLayers の階段・敷地線）。
// 呼び出し側（usePointerInteraction.js）はここの判定だけで分岐する——各モードの分岐に同じ閾値・同じ順序の
// if を書き写すと、片方だけ直したときに挙動が食い違う（team-lessons「抽出の単位は呼び出し側が下していた判断」）。

/** タップとみなす移動量（px）。これ未満なら押下点から動いていない扱い。仕上げ・天伏の commitDrag の tap と同じ値。 */
export const TAP_MOVE_PX = 8;

/** 押下点からの距離 dist がタップの範囲か。NaN（座標欠落）は「動いた」側に倒す（誤ってタップ処理を走らせない）。 */
export function isTapDistance(dist) {
  return Number.isFinite(dist) && dist < TAP_MOVE_PX;
}

/**
 * 離したときのジェスチャー。
 *   fired  … 長押しが成立していた（useLongPress.hasFired()）
 *   panned … パン中だった（drag.current あり）
 * 長押し成立が最優先（成立後に動いてもパンにはなっていない）。次にパン。どちらでもなければクリック。
 * @returns {'hold'|'pan'|'tap'}
 */
export function releaseGesture({ fired, panned }) {
  if (fired) return 'hold';
  if (panned) return 'pan';
  return 'tap';
}

/**
 * 天伏のロングタップ成立時に、なぞり（区画を作る）を始めるかメニューを出すか。
 * 天井芯の線上・端点（menuContext が EMPTY 以外）は従来どおりメニュー。空（EMPTY）で、押下点のセルが
 * 選択中の群に属し区画を作れる（startDrag の intent が 'create'）ときだけなぞり。
 * 既知の限界: 選択中の群のセルの上では「天井芯を追加」のメニューが出ない（先に空白をタップして選択を解除する）。
 * @param {{menuContext: string, emptyContext: string, intent: ('select'|'create'|null|undefined)}} a
 * @returns {'trace'|'menu'}
 */
export function ceilingHoldAction({ menuContext, emptyContext, intent }) {
  return menuContext === emptyContext && intent === 'create' ? 'trace' : 'menu';
}
