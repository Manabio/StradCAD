// 構造モードの梁タップ（伏図。ステップ4第3単位①・QA指摘F4）の当たり判定・成立条件を判定する
// 純関数群（react/konva/store非依存。node:testから単体import可能——team-lessons「抽出モジュールは
// 呼び出し側もテストで守る」）。usePointerInteraction.js の pointerUp から呼ぶ。
//
// Konva の onClick/onTap は移動閾値・長押し状態を見ないため使わない——梁上でパンを終える／
// 長押し成立後の pointerup でも部材カードが開いてしまう（QA指摘F4）。openings/OpeningsLayer.jsx の
// opening-symbol（openingId属性）＋usePointerInteraction.js の openingAtKonvaTarget と同じ流儀に揃え、
// パン未開始（drag.current無し＝8px超移動なし）かつ長押し未成立のときだけ呼ぶ。

/** Konvaのイベントターゲット（<Group name="beam-symbol" beamId={...}>本体、またはその子孫の図形）から
 *  beamId属性を取り出し、graph.beamMapから実体を解決する。見つからなければnull。 */
export function beamAtKonvaTarget(target, graph) {
  if (!target || typeof target.getAttr !== 'function') return null;
  const id = target.getAttr('beamId') ?? target.findAncestor?.('.beam-symbol')?.getAttr('beamId');
  return id != null ? (graph?.beamMap?.get(id) ?? null) : null;
}

/** Konvaのイベントターゲット（<Group name="column-symbol" columnId={...}>本体、またはその子孫の図形）から
 *  columnId属性を取り出し、graph.columnMapから実体を解決する。見つからなければnull。
 *  beamAtKonvaTarget と同じ流儀（ステップ4「柱は共通と個別指定の2層」・自階柱□タップ）。 */
export function columnAtKonvaTarget(target, graph) {
  if (!target || typeof target.getAttr !== 'function') return null;
  const id = target.getAttr('columnId') ?? target.findAncestor?.('.column-symbol')?.getAttr('columnId');
  return id != null ? (graph?.columnMap?.get(id) ?? null) : null;
}

/**
 * 梁タップが成立する条件（呼び出し元＝usePointerInteraction.js の pointerUp が解決した信号を渡す
 * 純判定）。構造モードでも onMemberClick 未指定（省略時）・メニュー表示中・パン発生後（8px超移動。
 * drag.current有り＝panned）・長押し成立後（menuの有無に関わらず。longPress.hasFired()）・
 * 他ジェスチャー進行中（busy＝描画/移動モード中）のいずれかなら false。
 * @returns {boolean}
 */
export function shouldFireMemberTap({ appMode, onMemberClick, menu, panned, longPressFired, busy }) {
  return appMode === 'structure' && !!onMemberClick && !menu && !panned && !longPressFired && !busy;
}

/**
 * 構造モードの「空白タップ」（何の部材にも当たらないタップ）か。Konva は何もヒットしないとき
 * イベントの target を Stage 自身にする——梁記号（beam-symbol）・部材タグなど listening な図形に
 * 当たったときは target がその図形（またはその子孫）になるので Stage ではない。
 * 空白タップは選択解除（展開中のカードを閉じ、伏図の強調を消す。構造モードには留まる）に使う
 * （ユーザー裁定2026-09-17「外クリックで構造モードのまま無選択状態に」）。
 * target が無い・Stage 判定 API を持たない（テストの擬似 target 等）場合は false（解除しない＝安全側）。
 */
export function isBlankTapTarget(target) {
  if (!target || typeof target.getStage !== 'function') return false;
  const stage = target.getStage();
  return !!stage && target === stage;
}
