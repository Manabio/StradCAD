import { resolvePlanLinePointsMm } from '../renderer/planLineJoin.js';
import { siteLineWeightKey, SITE_BOUNDARY_DASH } from './siteLineStyle.js';

// 敷地モード境界線（renderer/SiteLinesLayer.jsx）を renderer/figureLineJoin.js（展開図の
// 「L字の角の外角を閉じる」案2・第1弾。設計意図は .claude/elevation-model.md の
// 「### L字の角の外角を閉じる」節を参照）へ渡す primitives 配列へ写像し、境界線の最終描画座標
// （世界mm）まで解決する純関数群。「どの線を対象にし、どの幅を使うか」「延長計算をどの空間
// （px/mm）で行うか」という判断（呼び出し側=SiteLinesLayerが下していた判断）をここへ切り出す
// （siteGeometry.js と同じくレンダラ(.jsx)から分離した純幾何。plain Node から import 可能に保つ。
// renderer/figureLineJoin.js は react-konva 非依存の純モジュールのため import してよいが、
// store.js・appViewport.js は静的 import しない——viewportLike は duck-type で受け取る）。
//
// 対象は site.lines 全件。線幅・dash は site/siteLineStyle.js の規則: 外周（境界線）は中線の
// 一点鎖線（dash 付き＝figureLineJoin.js の collectCandidates が join 候補から除外する。角の
// 隙間は丸が覆う）、外周以外は細線の実線（join 対象）。選択中は線幅を1段上げる。三斜の補助線
// （重心バッジ）・寸法ラベル・選択ハイライトの丸・描画中プレビュー線（mode.siteDrawState /
// SiteDrawPreview）は site.lines に含まれないため、このモジュールのシグネチャ上そもそも渡しようが
// なく自然に対象外になる。
//
// 幅は実スクリーンpx（viewport.lineWeightsPx の thin/medium/thick）をそのまま渡す。
// figureLineJoin.js の THIN_PX しきい値・延長量の算式は実スクリーンpx前提のため、mm換算した値を
// 渡すとズーム倍率次第でしきい値判定が狂う。
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
// @param {{thin?:number, medium?:number, thick?:number}} lineWeightsPx - viewport.lineWeightsPx
// @param {Set<string>} outerIds - 外周（境界線）の線分ID（computeOuterLineIds）
// @returns {object[]} lines と同じ順序・同じ長さの figureLineJoin.js 語彙のprimitives配列
export function mapSiteLinesToJoinPrimitives(lines, selectedLineId, lineWeightsPx, outerIds) {
  return lines.map(line => {
    const isBoundary = outerIds.has(line.id);
    const prim = {
      type: 'line',
      x1: line.startPoint.x, y1: line.startPoint.y,
      x2: line.endPoint.x,   y2: line.endPoint.y,
      width: lineWeightsPx[siteLineWeightKey(isBoundary, line.id === selectedLineId)],
    };
    // 外周（境界線）は一点鎖線——dash 付きは join 対象外（figureLineJoin.js）
    if (isBoundary) prim.dash = SITE_BOUNDARY_DASH;
    return prim;
  });
}

/**
 * site.lines の最終描画座標（世界mm）とstrokeWidth（px）を、L字の角の外角閉じを適用したうえで
 * 解決する。line.id をキーにした Map を返すため、呼び出し側（SiteLinesLayer.jsx）は
 * `resolved.get(line.id)` の `points`/`width` をそのまま Konva <Line> へ渡すだけでよく、
 * 幅の判断（選択中か否か）を .jsx 側で重複して持たない——本関数が幅の唯一の供給源になる。
 * @param {{id, startPoint:{x,y}, endPoint:{x,y}}[]} lines - site.lines
 * @param {string|null} selectedLineId
 * @param {{thin?:number, medium?:number, thick?:number}} lineWeightsPx - viewport.lineWeightsPx
 * @param {Set<string>} outerIds - 外周（境界線）の線分ID（site/lineClassification.js computeOuterLineIds）
 * @param {{worldToScreen:(x:number,y:number)=>{x:number,y:number}, screenToWorld:(x:number,y:number)=>{x:number,y:number}}} viewportLike
 * @returns {Map<string, {points:[number,number,number,number], width:number, dash:(readonly number[])|undefined}>}
 *   dash は外周（一点鎖線）のときだけ非 undefined。幅・dash の唯一の供給源
 */
export function resolveSiteLinePointsMm(lines, selectedLineId, lineWeightsPx, outerIds, viewportLike) {
  const primitives = mapSiteLinesToJoinPrimitives(lines, selectedLineId, lineWeightsPx, outerIds);
  const keyed = primitives.map((p, i) => ({ ...p, key: lines[i].id }));
  const joined = resolvePlanLinePointsMm(keyed, lineWeightsPx, viewportLike);
  const result = new Map();
  for (const p of keyed) result.set(p.key, { ...joined.get(p.key), dash: p.dash });
  return result;
}
