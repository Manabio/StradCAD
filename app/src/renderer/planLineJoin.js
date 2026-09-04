/**
 * 「Konvaの親GroupのscaleX/scaleY/offsetXYへ世界→スクリーン変換を委ねる」方式（展開図の
 * 手動t.tx/ty変換ではなく、通り芯・敷地線・階段等の平面系レイヤが使う方式）の実線について、
 * renderer/figureLineJoin.js（L字の角の外角を閉じる。案2・第1弾）を実スクリーンpx空間で
 * 適用する共通の往復処理。site/siteLineJoinPrimitives.js の resolveSiteLinePointsMm が
 * 第2弾で確立した「①viewportLike.worldToScreenで実px化→②join解決→③screenToWorldで世界mmへ戻す」
 * 往復部分を、敷地非依存の形へ切り出したもの（第3弾）。設計意図は
 * .claude/elevation-model.md「L字の角の外角を閉じる」節を参照。
 *
 * tは平行移動不変（延長量はベクトル差なのでoffsetは相殺する）が、契約を単純に保つため
 * viewportLike.worldToScreen/screenToWorldをそのまま使う（呼び出し側はViewport実体の
 * 任意の互換オブジェクトを渡すだけでよく、scaleX/scaleYフィールド名への依存を持たない）。
 *
 * @param {{key, x1:number,y1:number,x2:number,y2:number, width?:number, weight?:string, dash?:*}[]} prims
 *   - key: 戻り値Mapのキー（呼び出し側が任意に採番）
 *   - width/weight: renderer/figureLineJoin.js の weightPx と同じ規約
 *     （weightがlineWeightsPxのキーに一致すればそちらを優先、なければwidthを使う）
 *   - dash: truthyならL字結合の対象外（破線除外はfigureLineJoin.js側の規約）
 * @param {{thin?:number, medium?:number, thick?:number, ultraThick?:number}} [lineWeightsPx]
 *   - 全prims が weight未指定（width直指定のみ）なら参照されない——省略・undefinedで渡してよい
 *     （finish/stair/stairLineJoinPrimitives.js は width を実px指定するためweight表を使わない）。
 * @param {{worldToScreen:(x:number,y:number)=>{x:number,y:number}, screenToWorld:(x:number,y:number)=>{x:number,y:number}}} viewportLike
 * @returns {Map<*, {points:[number,number,number,number], width:number}>}
 */
import { resolveJoinedLinePoints, linePointsPx, weightPx } from './figureLineJoin.js';

export function resolvePlanLinePointsMm(prims, lineWeightsPx, viewportLike) {
  const linePrims = prims.map(p => ({
    type: 'line', x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2,
    width: p.width, weight: p.weight, dash: p.dash,
  }));
  const screenT = {
    tx: x => viewportLike.worldToScreen(x, 0).x,
    ty: y => viewportLike.worldToScreen(0, y).y,
  };
  const joined = resolveJoinedLinePoints(linePrims, screenT, lineWeightsPx);

  const result = new Map();
  prims.forEach((p, i) => {
    const [sx1, sy1, sx2, sy2] = linePointsPx(linePrims[i], i, screenT, joined);
    const w1 = viewportLike.screenToWorld(sx1, sy1);
    const w2 = viewportLike.screenToWorld(sx2, sy2);
    result.set(p.key, {
      points: [w1.x, w1.y, w2.x, w2.y],
      width: weightPx(linePrims[i], lineWeightsPx),
    });
  });
  return result;
}

/**
 * resolvePlanLinePointsMmの姉妹関数（第6弾）。呼び出し元のレイヤーが`strokeScaleEnabled`を
 * 指定していない（既定true。Konvaの親GroupのscaleX/scaleYを継承する）場合、`<Line>`へ渡す
 * strokeWidthは実スクリーンpxではなく「世界mm相当値」になる（finish/stair/stairLineJoinPrimitives.js・
 * structural/columnWrapLineJoin.jsが個別に持っていた往復と同じ状況）。本関数はその往復
 * （①viewportLike.scaleXを掛けて実px化→②resolvePlanLinePointsMmへ委譲→③戻り値のwidthを
 * 再びscaleXで割って世界mm相当へ戻す）を一本化したもの。
 *
 * **呼び分け**: `strokeScaleEnabled`未指定（Group拡縮継承）のレイヤはこちら
 * （`resolvePlanLinePointsMmScaledStroke`）。実px直指定（`strokeScaleEnabled={false}`）の
 * レイヤは`resolvePlanLinePointsMm`をそのまま使う。
 *
 * prims[].widthは常に実px直指定として扱われる（`weight`表を引く経路は持たない——
 * columnWrapLineJoin.jsと同じ理由。呼び出し側が太さの判断をすでに済ませているため）。
 *
 * @param {{key, x1:number,y1:number,x2:number,y2:number, width:number, dash?:*}[]} prims
 *   - width: 世界mm相当値（呼び出し側の`strokeWidth`値そのもの。実pxではない）
 * @param {{worldToScreen, screenToWorld, scaleX:number}} viewportLike
 * @returns {Map<*, {points:[number,number,number,number], width:number}>} widthは世界mm相当
 */
export function resolvePlanLinePointsMmScaledStroke(prims, viewportLike) {
  const scaleX = viewportLike.scaleX;
  const scaledPrims = prims.map(p => ({ ...p, width: p.width * scaleX }));
  const joined = resolvePlanLinePointsMm(scaledPrims, undefined, viewportLike);
  const result = new Map();
  for (const p of prims) {
    const j = joined.get(p.key);
    result.set(p.key, { points: j.points, width: j.width / scaleX });
  }
  return result;
}
