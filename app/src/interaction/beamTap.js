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
