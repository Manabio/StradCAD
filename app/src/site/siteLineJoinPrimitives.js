import { resolvePlanLinePointsMm } from '../renderer/planLineJoin.js';

// 敷地モード境界線（renderer/SiteLinesLayer.jsx）を renderer/figureLineJoin.js（展開図の
// 「L字の角の外角を閉じる」案2・第1弾。設計意図は .claude/elevation-model.md の
// 「### L字の角の外角を閉じる」節を参照）へ渡す primitives 配列へ写像し、境界線の最終描画座標
// （世界mm）まで解決する純関数群。「どの線を対象にし、どの幅を使うか」「延長計算をどの空間
// （px/mm）で行うか」という判断（呼び出し側=SiteLinesLayerが下していた判断）をここへ切り出す
// （siteGeometry.js と同じくレンダラ(.jsx)から分離した純幾何。plain Node から import 可能に保つ。
// renderer/figureLineJoin.js は react-konva 非依存の純モジュールのため import してよいが、
// store.js・appViewport.js は静的 import しない——viewportLike は duck-type で受け取る）。
//
// 対象は SiteLineKind を問わず site.lines 全件——境界(BOUNDARY)・道路境界(ROAD)・測量(SURVEY)・
// 道路幅員(ROAD_WIDTH)・その他(OTHER)いずれも同じ実線・同じ太さ（thick/ultraThick）で描かれ、
// kindによる別扱いは色だけ（renderer/SiteLinesLayer.jsx の KIND_COLOR）なので、join対象を
// kindで絞る理由がない。三斜の補助線（重心バッジ）・寸法ラベル・選択ハイライトの丸・描画中
// プレビュー線（mode.siteDrawState / SiteDrawPreview）は site.lines に含まれないため、この
// モジュールのシグネチャ上そもそも渡しようがなく自然に対象外になる。site.lines は現状すべて
// 実線（dash指定を持たない）——出力プリミティブにも dash は付けない（figureLineJoin.js の
// collectCandidates は p.dash が truthy な line を候補から除外する）。
//
// 幅は実スクリーンpx（viewport.lineWeightsPx.thick/ultraThick）をそのまま渡す。
// figureLineJoin.js の THIN_PX しきい値・延長量の算式は実スクリーンpx前提のため、mm換算した値を
// 渡すとズーム倍率次第でしきい値判定が狂う（例: 極端な拡大でTHIN_PX未満に落ち、常に3〜4px幅で
// 見えているはずの境界線の延長が効かなくなる）。
//
// renderer/SiteLinesLayer.jsx は境界線の座標を世界mmのままKonva<Line>へ渡し、親Group
// （x=offsetX,y=offsetY,scaleX,scaleY）にKonva自身が世界→スクリーン変換を委ねている
// （展開図のような「レンダラがmm→pxを手動変換して渡す」方式ではない）。そのため
// ①viewportLike.worldToScreenで実スクリーンpx空間へ持ち上げてjoinを解決し、
// ②viewportLike.screenToWorldで世界mmへ戻す、という往復が必要になる——この往復自体は
// 敷地固有ではないため renderer/planLineJoin.js の resolvePlanLinePointsMm へ一本化した
// （第3弾。階段レイヤ renderer/StairLayer.jsx も同じ往復を使う）。
// 呼び出し側の.jsxはこの往復判断を一切持たず、返り値のmm座標をそのままLine pointsへ渡すだけにする。
//
// @param {{id, startPoint:{x,y}, endPoint:{x,y}}[]} lines - site.lines
// @param {string|null} selectedLineId
// @param {{thick?:number, ultraThick?:number}} lineWeightsPx - viewport.lineWeightsPx
// @returns {object[]} lines と同じ順序・同じ長さの figureLineJoin.js 語彙のprimitives配列
export function mapSiteLinesToJoinPrimitives(lines, selectedLineId, lineWeightsPx) {
  return lines.map(line => ({
    type: 'line',
    x1: line.startPoint.x, y1: line.startPoint.y,
    x2: line.endPoint.x,   y2: line.endPoint.y,
    width: line.id === selectedLineId ? lineWeightsPx.ultraThick : lineWeightsPx.thick,
  }));
}

/**
 * site.lines の最終描画座標（世界mm）とstrokeWidth（px）を、L字の角の外角閉じを適用したうえで
 * 解決する。line.id をキーにした Map を返すため、呼び出し側（SiteLinesLayer.jsx）は
 * `resolved.get(line.id)` の `points`/`width` をそのまま Konva <Line> へ渡すだけでよく、
 * 幅の判断（選択中か否か）を .jsx 側で重複して持たない——本関数が幅の唯一の供給源になる。
 * @param {{id, startPoint:{x,y}, endPoint:{x,y}}[]} lines - site.lines
 * @param {string|null} selectedLineId
 * @param {{thick?:number, ultraThick?:number}} lineWeightsPx - viewport.lineWeightsPx
 * @param {{worldToScreen:(x:number,y:number)=>{x:number,y:number}, screenToWorld:(x:number,y:number)=>{x:number,y:number}}} viewportLike
 * @returns {Map<string, {points:[number,number,number,number], width:number}>}
 */
export function resolveSiteLinePointsMm(lines, selectedLineId, lineWeightsPx, viewportLike) {
  const primitives = mapSiteLinesToJoinPrimitives(lines, selectedLineId, lineWeightsPx);
  const keyed = primitives.map((p, i) => ({ ...p, key: lines[i].id }));
  return resolvePlanLinePointsMm(keyed, lineWeightsPx, viewportLike);
}
