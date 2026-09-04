/**
 * 階段レイヤ（renderer/StairLayer.jsx）の外周線・踏面線（<Line>で描く実線）について、
 * 「どの線分をL字の角の対象にし、どの太さ・dashで扱うか」（旧: outlineWeight関数・
 * treadsのheavy三項演算・見下げ/s.dashedのdash三項演算）を切り出した純関数群。
 * renderer/planLineJoin.js（figureLineJoin.jsのL字の角の外角閉じ。案2・第1弾）へ渡す
 * primitivesへの写像と、実px往復の呼び出しをここへ一本化する——StairLayer.jsx は
 * stairLineRenderProps の返り値（{key,points,strokeWidth,dash}[]）を<Line>へ渡すだけにする。
 *
 * 対象は破線でない外周線（thin/medium/heavy=ささら等）・踏面線（thin/heavy）のみ。
 * 見下げ（isDownView。自階スラブの開口越しに見下ろす下階階段の点線表現）・
 * s.dashed（到達辺等、install表示でも点線の区間）はdash扱いにして対象外にする
 * （破線除外はfigureLineJoin.js側の規約。矢じり・破れ線・選択ハイライト・開口縁は
 *   このモジュールの対象外＝呼び出し側がそもそも入力チャネルへ混ぜない）。
 *
 * strokeWidthはKonvaの親GroupのscaleX/scaleYを継承する（StairLayer.jsxのLineは
 * strokeScaleEnabledを指定していない＝既定true）ため、現行のstrokeWidth値
 * （lineWeightsPx.thin/medium、またはpx(2)=2/viewport.scaleX）は「世界mm相当値」であり
 * 実スクリーンpxではない。figureLineJoin.jsのL字判定・延長量計算は実スクリーンpx基準のため、
 * ここでは①viewport.scaleXを掛けて実px化した値をresolvePlanLinePointsMmへ渡し、
 * ②戻ってきたwidthを再びscaleXで割って元のstrokeWidth値へ戻す
 * （v -> v*scaleX -> (v*scaleX)/scaleX は可逆——最終的な<Line>のstrokeWidthは不変に保つ。
 *   「それ以外のpxは動かさない」という要求を、往復の外側で満たす）。
 *
 * L字結合はエントリ単位で解決する（QA指摘2026-09）: 複数の階段（installOverlapで
 * footprintが重なるupperエントリを含む）が別々のentryとして渡されても、他エントリの端点とは
 * 一切マージしない。resolveStairLinePointsMm/stairLineRenderPropsは1エントリぶんのprimitivesだけを
 * 都度figureLineJoin.jsへ渡す（複数エントリの線分を1回のresolveJoinedLinePoints呼び出しへ混ぜない）
 * ——変更前（各エントリを個別にresolved.mapでJSX化していた描画単位）と同じ範囲に保つ。別々の階段の
 * 端点が偶然一致しても互いに影響しない。
 */
import { resolvePlanLinePointsMm } from '../../renderer/planLineJoin.js';

// 見下げ（isDownView）の点線パターン（スクリーンpx）。旧StairLayer.jsx内蔵定数を移設——
// dash判定の唯一の供給源をここに一本化する。
const DOWNVIEW_DASH_PX = [3, 3];

// lineWeightsPxに該当キーが無い場合の既定値（世界mm相当。×scaleXで実1px相当に戻る）。
// figureLineJoin.jsのweightPxが持つ既定THIN_PX=1と同じ「不明な太さは1px扱い」規約に合わせる。
const DEFAULT_STROKE_WIDTH = (scaleX) => 1 / scaleX;

// 踏面線の太さ（世界mm相当のstrokeWidth値。StairLayer.jsx旧: `s.heavy ? px(2) : viewport.lineWeightsPx.thin`）。
export function treadStrokeWidth(s, scaleX, lineWeightsPx) {
  return s.heavy ? (2 / scaleX) : (lineWeightsPx.thin ?? DEFAULT_STROKE_WIDTH(scaleX));
}

// 外周線の太さ（世界mm相当のstrokeWidth値。StairLayer.jsx旧: outlineWeight関数）。
export function outlineStrokeWidth(s, scaleX, lineWeightsPx) {
  if (s.thin) return lineWeightsPx.thin ?? DEFAULT_STROKE_WIDTH(scaleX);
  if (s.medium) return lineWeightsPx.medium ?? DEFAULT_STROKE_WIDTH(scaleX);
  return 2 / scaleX;
}

export function stairTreadKey(view, id, i) { return `${view}:${id}:t:${i}`; }
export function stairOutlineKey(view, id, i) { return `${view}:${id}:o:${i}`; }

// 見下げの点線パターンを実px→世界mm相当へ変換する（beyondLines等、L字結合を経由しない
// 常時点線の<Line>もこれを呼ぶ——dashパターン値の唯一の供給源）。
export function stairDownviewDashPx(scaleX) {
  return DOWNVIEW_DASH_PX.map(w => w / scaleX);
}

/**
 * 階段1エントリぶんの踏面線・外周線を、renderer/planLineJoin.jsのresolvePlanLinePointsMmへ
 * 渡すprimitives配列（実px幅つき）へ写像する。複数エントリを渡してもよいが、各エントリの
 * primitivesは呼び出し側（resolveStairLinePointsMm）で必ずエントリごとに分けて
 * resolvePlanLinePointsMmへ渡すこと（ここでは写像だけを行い、結合範囲の制御はしない）。
 * @param {{view:string, id:string, treadSegs:{x1,y1,x2,y2,heavy?}[], outlineSegs:{x1,y1,x2,y2,thin?,medium?,dashed?}[], isDownView:boolean}[]} entries
 * @param {number} scaleX - viewport.scaleX（strokeWidthの世界mm相当値を実pxへ換算する）
 * @param {{thin?:number, medium?:number}} lineWeightsPx
 * @returns {{key:string, x1:number,y1:number,x2:number,y2:number, width:number, dash?:true}[]}
 */
export function buildStairJoinPrimitives(entries, scaleX, lineWeightsPx) {
  const prims = [];
  for (const entry of entries) {
    const { view, id, treadSegs = [], outlineSegs = [], isDownView } = entry;
    treadSegs.forEach((s, i) => {
      prims.push({
        key: stairTreadKey(view, id, i),
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        width: treadStrokeWidth(s, scaleX, lineWeightsPx) * scaleX,
        dash: isDownView || undefined,
      });
    });
    outlineSegs.forEach((s, i) => {
      prims.push({
        key: stairOutlineKey(view, id, i),
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        width: outlineStrokeWidth(s, scaleX, lineWeightsPx) * scaleX,
        dash: (isDownView || s.dashed) || undefined,
      });
    });
  }
  return prims;
}

/**
 * buildStairJoinPrimitives→resolvePlanLinePointsMmの実px往復を行い、戻り値のwidthを
 * scaleXで割って元のstrokeWidth値（世界mm相当）へ戻す。
 * L字結合はエントリ単位で解決する——entriesに複数要素を渡しても、
 * resolvePlanLinePointsMmはエントリごとに個別に呼び出し、他エントリの線分とは混ぜない。
 * @param {Parameters<typeof buildStairJoinPrimitives>[0]} entries
 * @param {{worldToScreen, screenToWorld, scaleX:number}} viewportLike
 * @param {{thin?:number, medium?:number}} lineWeightsPx
 * @returns {Map<string, {points:[number,number,number,number], width:number}>}
 */
export function resolveStairLinePointsMm(entries, viewportLike, lineWeightsPx) {
  const result = new Map();
  for (const entry of entries) {
    const prims = buildStairJoinPrimitives([entry], viewportLike.scaleX, lineWeightsPx);
    // prims はwidthを実px指定済み（weightフィールドを持たない）ため、lineWeightsPx（weight表）は
    // 参照されない——weightPx(figureLineJoin.js)はp.weightが無ければp.widthへフォールバックする。
    // それを呼び出し側にも明示するため、ここではlineWeightsPxをundefinedで渡す。
    const joined = resolvePlanLinePointsMm(prims, undefined, viewportLike);
    for (const [key, v] of joined) {
      result.set(key, { points: v.points, width: v.width / viewportLike.scaleX });
    }
  }
  return result;
}

/**
 * 階段1エントリぶんの外周線・踏面線の最終描画props（points・strokeWidth・dash）を解決する。
 * StairLayer.jsxはこの返り値の各要素を`<Line key={p.key} points={p.points}
 * strokeWidth={p.strokeWidth} dash={p.dash} .../>`へそのまま渡すだけにする——太さの判断
 * （treadStrokeWidth/outlineStrokeWidth）・dashの判断（isDownView/s.dashed）・L字結合
 * （resolveStairLinePointsMm）をすべてこちらへ寄せ、.jsx側に配線の余地を残さない。
 * @param {{view:string, id:string, treadSegs:{x1,y1,x2,y2,heavy?}[], outlineSegs:{x1,y1,x2,y2,thin?,medium?,dashed?}[], isDownView:boolean}} entry
 * @param {{worldToScreen, screenToWorld, scaleX:number}} viewportLike
 * @param {{thin?:number, medium?:number}} lineWeightsPx
 * @returns {{
 *   treads:{key:string, points:[number,number,number,number], strokeWidth:number, dash:number[]|undefined}[],
 *   outline:{key:string, points:[number,number,number,number], strokeWidth:number, dash:number[]|undefined}[],
 * }}
 */
export function stairLineRenderProps(entry, viewportLike, lineWeightsPx) {
  const scaleX = viewportLike.scaleX;
  const px = (w) => w / scaleX;
  const downviewDash = stairDownviewDashPx(scaleX);
  const { view, id, treadSegs = [], outlineSegs = [], isDownView } = entry;
  const joined = resolveStairLinePointsMm([entry], viewportLike, lineWeightsPx);

  const treads = treadSegs.map((s, i) => {
    const key = stairTreadKey(view, id, i);
    const j = joined.get(key);
    return { key, points: j.points, strokeWidth: j.width, dash: isDownView ? downviewDash : undefined };
  });
  const outline = outlineSegs.map((s, i) => {
    const key = stairOutlineKey(view, id, i);
    const j = joined.get(key);
    return {
      key, points: j.points, strokeWidth: j.width,
      dash: isDownView ? downviewDash : (s.dashed ? [px(40), px(30)] : undefined),
    };
  });
  return { treads, outline };
}
