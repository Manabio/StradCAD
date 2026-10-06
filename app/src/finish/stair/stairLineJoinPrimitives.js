/**
 * 階段レイヤ（renderer/StairLayer.jsx）の外周線・踏面線（<Line>で描く実線）について、
 * 「どの線分をL字の角の対象にし、どの太さ・dashで扱うか」（旧: outlineWeight関数・
 * treadsのheavy三項演算・見下げ/s.dashedのdash三項演算）を切り出した純関数群。
 * renderer/planLineJoin.js（figureLineJoin.jsのL字の角の外角閉じ。案2・第1弾）へ渡す
 * primitivesへの写像と、実px往復の呼び出しをここへ一本化する——StairLayer.jsx は
 * stairLineRenderProps の返り値（{key,points,strokeWidth,dash}[]）を<Line>へ渡すだけにする。
 *
 * 対象は破線でない外周線（thin/medium/heavy=ささら等）・踏面線（thin/heavy）のみ。
 * 見下げ（下階の階段を自階で見るエントリ＝view==='upper'。isDownView の有無によらない）は実線の細線（床の端 floorEdge だけ中線）で、
 * L字結合の対象。s.dashed（到達辺等の破線の区間）はdash扱いにして対象外にする
 * （破線除外はfigureLineJoin.js側の規約。矢じり・破れ線・選択ハイライトは
 *   このモジュールの対象外＝呼び出し側がそもそも入力チャネルへ混ぜない）。
 *
 * strokeWidthはKonvaの親GroupのscaleX/scaleYを継承する（StairLayer.jsxのLineは
 * strokeScaleEnabledを指定していない＝既定true）ため、現行のstrokeWidth値
 * （lineWeightsPx.thin/medium、またはpx(2)=2/viewport.scaleX）は「世界mm相当値」であり
 * 実スクリーンpxではない。figureLineJoin.jsのL字判定・延長量計算は実スクリーンpx基準のため、
 * ①viewport.scaleXを掛けて実px化→②join解決→③戻り値をscaleXで割って世界mm相当へ戻す、という
 * 往復が必要になる（最終的な<Line>のstrokeWidthは不変に保つ）。この往復自体は
 * renderer/planLineJoin.jsの姉妹関数`resolvePlanLinePointsMmScaledStroke`（第6弾）へ委譲する
 * （2026-09移行）——本ファイルはbuildStairJoinPrimitivesがprimitivesのwidthを**世界mm相当値のまま**
 * （実px化しない）供給する側に回り、往復そのものは持たない。
 *
 * L字結合はエントリ単位で解決する（QA指摘2026-09）: 複数の階段（installOverlapで
 * footprintが重なるupperエントリを含む）が別々のentryとして渡されても、他エントリの端点とは
 * 一切マージしない。resolveStairLinePointsMm/stairLineRenderPropsは1エントリぶんのprimitivesだけを
 * 都度figureLineJoin.jsへ渡す（複数エントリの線分を1回のresolveJoinedLinePoints呼び出しへ混ぜない）
 * ——変更前（各エントリを個別にresolved.mapでJSX化していた描画単位）と同じ範囲に保つ。別々の階段の
 * 端点が偶然一致しても互いに影響しない。
 */
import { resolvePlanLinePointsMmScaledStroke } from '../../renderer/planLineJoin.js';
import { UPPER_VOID_DASH_PX } from '../voidGeometry.js';

// 上り部分（install 側の破れ先の外周線）の破線パターン（スクリーンpx）。見下げ（isDownView）は
// 実線になった（裁定2026-10-06）ため、これを使うのは beyondLines だけ。
// **書式は「上部吹抜け」と同じものを参照する**（ユーザー決定2026-09）——平面に並ぶ「見えない線」の
// 線種が系統ごとに違うと混在して見える。ここで独自のパターン値を持たないこと。
const DOWNVIEW_DASH_PX = UPPER_VOID_DASH_PX;

// lineWeightsPxに該当キーが無い場合の既定px。figureLineJoin.jsのweightPxが持つ既定THIN_PX=1と
// 同じ「不明な太さは1px扱い」規約に合わせる。
const DEFAULT_PX = 1;

// 実スクリーンpx → 世界mm相当（Konva親Groupのscale継承前提）。**線の太さの指定は実画面上の
// 絶対太さ**なので、必ずscaleXで割ってから渡す（ユーザー確定2026-09）。
// 不具合2026-09: lineWeightsPx（実px値）をこの変換なしで返しており、踏面線・外周線だけが
// 1世界mm固定＝ズームで太さが変わっていた（1/100で0.04px＝ほぼ不可視、拡大すると過太）。
const toWorld = (px, scaleX) => px / scaleX;

// 踏面線の太さ（世界mm相当のstrokeWidth値）。ささら等のheavyは2px、それ以外は細線。
export function treadStrokeWidth(s, scaleX, lineWeightsPx) {
  return toWorld(s.heavy ? 2 : (lineWeightsPx?.thin ?? DEFAULT_PX), scaleX);
}

// 外周線の太さ（世界mm相当のstrokeWidth値）。
export function outlineStrokeWidth(s, scaleX, lineWeightsPx) {
  if (s.thin) return toWorld(lineWeightsPx?.thin ?? DEFAULT_PX, scaleX);
  if (s.medium) return toWorld(lineWeightsPx?.medium ?? DEFAULT_PX, scaleX);
  return toWorld(2, scaleX);
}

// 見下げ（isDownView。自階スラブの開口越しに見る下階階段）の太さ。見えがかり線は踏面線・外周線とも
// 実線の細線（ユーザー裁定2026-10-06 Q6）。床の端（floorEdge）だけは従来どおり外周線の太さ（中線）を残す。
export function downviewTreadStrokeWidth(scaleX, lineWeightsPx) {
  return toWorld(lineWeightsPx?.thin ?? DEFAULT_PX, scaleX);
}
export function downviewOutlineStrokeWidth(s, scaleX, lineWeightsPx) {
  return s.floorEdge ? outlineStrokeWidth(s, scaleX, lineWeightsPx) : downviewTreadStrokeWidth(scaleX, lineWeightsPx);
}

export function stairTreadKey(view, id, i) { return `${view}:${id}:t:${i}`; }
export function stairOutlineKey(view, id, i) { return `${view}:${id}:o:${i}`; }

// 破れ先（上り部分）の破線パターンを実px→世界mm相当へ変換する（beyondLines等、L字結合を経由しない
// 常時破線の<Line>がこれを呼ぶ——dashパターン値の唯一の供給源）。
export function stairDownviewDashPx(scaleX) {
  return DOWNVIEW_DASH_PX.map(w => w / scaleX);
}

/**
 * 階段1エントリぶんの踏面線・外周線を、renderer/planLineJoin.jsのresolvePlanLinePointsMmScaledStroke
 * （姉妹関数。第6弾）へ渡すprimitives配列（**世界mm相当**のwidthつき。実px化は姉妹関数側に任せる）へ
 * 写像する。複数エントリを渡してもよいが、各エントリのprimitivesは呼び出し側
 * （resolveStairLinePointsMm）で必ずエントリごとに分けて渡すこと（ここでは写像だけを行い、
 * 結合範囲の制御はしない）。
 * @param {{view:string, id:string, treadSegs:{x1,y1,x2,y2,heavy?}[], outlineSegs:{x1,y1,x2,y2,thin?,medium?,dashed?}[], isDownView:boolean}[]} entries
 * @param {number} scaleX - viewport.scaleX（treadStrokeWidth/outlineStrokeWidthの既定値計算にのみ使う）
 * @param {{thin?:number, medium?:number}} lineWeightsPx
 * @returns {{key:string, x1:number,y1:number,x2:number,y2:number, width:number, dash?:true}[]}
 */
export function buildStairJoinPrimitives(entries, scaleX, lineWeightsPx) {
  const prims = [];
  for (const entry of entries) {
    const { view, id, treadSegs = [], outlineSegs = [] } = entry;
    // 「下階の階段を自階で見るエントリ」＝ view==='upper'（直下階の階段を peek したもの）。
    // 自階に階段が無い階（STAIR_VOID だけの階）では installOverlap が付かず isDownView は偽だが、
    // 同じ見下げなので細線にする（裁定2026-10-06 Q6）。isDownView は破れ先クリップ等の別判断用に残る。
    const isDownView = entry.isDownView || view === 'upper';
    treadSegs.forEach((s, i) => {
      prims.push({
        key: stairTreadKey(view, id, i),
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        width: isDownView
          ? downviewTreadStrokeWidth(scaleX, lineWeightsPx)
          : treadStrokeWidth(s, scaleX, lineWeightsPx),
      });
    });
    outlineSegs.forEach((s, i) => {
      prims.push({
        key: stairOutlineKey(view, id, i),
        x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2,
        width: isDownView
          ? downviewOutlineStrokeWidth(s, scaleX, lineWeightsPx)
          : outlineStrokeWidth(s, scaleX, lineWeightsPx),
        dash: s.dashed || undefined,
      });
    });
  }
  return prims;
}

/**
 * buildStairJoinPrimitives→resolvePlanLinePointsMmScaledStroke（実px往復。姉妹関数）を呼び出す。
 * L字結合はエントリ単位で解決する——entriesに複数要素を渡しても、
 * resolvePlanLinePointsMmScaledStrokeはエントリごとに個別に呼び出し、他エントリの線分とは混ぜない。
 * @param {Parameters<typeof buildStairJoinPrimitives>[0]} entries
 * @param {{worldToScreen, screenToWorld, scaleX:number}} viewportLike
 * @param {{thin?:number, medium?:number}} lineWeightsPx
 * @returns {Map<string, {points:[number,number,number,number], width:number}>}
 */
export function resolveStairLinePointsMm(entries, viewportLike, lineWeightsPx) {
  const result = new Map();
  for (const entry of entries) {
    const prims = buildStairJoinPrimitives([entry], viewportLike.scaleX, lineWeightsPx);
    // prims はwidthを世界mm相当のまま渡す（weightフィールドを持たない）ため、lineWeightsPx（weight表）は
    // 参照されない——resolvePlanLinePointsMmScaledStroke内部のresolvePlanLinePointsMm呼び出しは
    // lineWeightsPx未指定で行われる。
    const joined = resolvePlanLinePointsMmScaledStroke(prims, viewportLike);
    for (const [key, v] of joined) {
      result.set(key, v);
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
  const { view, id, treadSegs = [], outlineSegs = [] } = entry;
  const joined = resolveStairLinePointsMm([entry], viewportLike, lineWeightsPx);

  const treads = treadSegs.map((s, i) => {
    const key = stairTreadKey(view, id, i);
    const j = joined.get(key);
    return { key, points: j.points, strokeWidth: j.width, dash: undefined };
  });
  const outline = outlineSegs.map((s, i) => {
    const key = stairOutlineKey(view, id, i);
    const j = joined.get(key);
    return {
      key, points: j.points, strokeWidth: j.width,
      // 見下げ（isDownView）は全線実線。破線になるのは s.dashed（到達辺等）だけ
      dash: s.dashed ? [px(40), px(30)] : undefined,
    };
  });
  return { treads, outline };
}
