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

// ---- 天伏: なぞり（区画の作成）とパンを、動き出しの速さで見分ける（ユーザー指示 2026-10-19）----
// 天伏のロングタップは全部メニュー（天井芯の追加・移動・削除・延長）に使うので、なぞりはドラッグで始める。
// 押下点から 8px（useLongPress の閾値）を超えたら判定窓（CEILING_DECIDE_MS）を開き、窓の中で CEILING_PAN_PX を
// 超えればパン、超えずに窓が閉じればなぞり。判定は入口の 1 回だけで、パンに入った後はどんな速さでも追従する。
// なぞりができない押下点（選択中の群の外・何も選択していない）は 8px 超で即パン（窓を開かない）。
// 数値は暫定（実機で合わせる前提）。
export const CEILING_PAN_PX = 16;
export const CEILING_DECIDE_MS = 80;

/**
 * 天伏で 8px 超えた時点・判定窓の中の move で呼ぶ。
 *   canTrace … 押下点のセルが選択中の群に属し区画を作れる（startDrag の intent が 'create'）
 *   dist     … 押下点からの距離（px）
 * @returns {'pan'|'wait'}  'wait' は判定窓の中（窓が閉じればなぞり。閉じる側は呼び出し側のタイマー）
 */
export function ceilingDragStart({ canTrace, dist }) {
  if (!canTrace) return 'pan';
  return Number.isFinite(dist) && dist > CEILING_PAN_PX ? 'pan' : 'wait';
}
