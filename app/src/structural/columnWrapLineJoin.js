/**
 * renderer/StructuralLayer.jsx の柱の仕上げ包み（柱壁。旧`columnWrapLines`。本モジュールへ移設）が
 * 描く実線同士のL字の角に、renderer/figureLineJoin.js（案2・第1弾。展開図の「L字の角の外角を
 * 閉じる」）と同じ規則を適用する純関数群（第4弾）。設計意図は .claude/elevation-model.md
 * 「L字の角の外角を閉じる」節を参照。
 *
 * 線の太さ（`columnWrapStrokeWidth`）は壁の仕上げ材の線と**同じ供給源**
 * （`finish/wallFinishJoin.js` の `wallFinishLineWeight(detail)`。詳細LODは太線・それ以外は中線）
 * を `resolveStrokeWidth(_, Math.min(scaleX,scaleY))` に通した値を使う。
 * `resolveStrokeWidth`はズーム追従の最低1px相当保証（`Math.max(1/scale, lineWeight)`）を持ち、
 * LINE_WEIGHT_MM.medium(0.25)は既定の校正値では scale<=4（scaleDenominator>=1＝1/100〜1/1）の範囲で
 * `1/scale`側が上回るため、実スクリーンpxはちょうど1.0px——figureLineJoin.jsの
 * `THIN_PX=1`しきい値は`<=`判定（「細線同士は延長しない」）のためこの1.0pxで必ず引っかかり、
 * 柱壁のL字延長は既定ズーム（1/1まで）では発火しない。viewport.jsのzoomAtはscaleXを20まで許すため、
 * 1/1より拡大した scale>4 ではpx幅が1を超えて延長が発火する（延長量は相手半幅＝0.125mm固定）。
 * （既定ズームでは出力は素のmm座標と厳密一致。回帰は本ファイルの
 * `columnWrapLineJoin.test.js` T1 参照）。
 *
 * 「どの辺を対象にするか（`wrap.trimmed`で壁に接する辺を除外・仕上げ厚で潰れる内側境界は
 * 出さない）」「どの太さで扱うか」「px往復をどう行うか」——旧 renderer/StructuralLayer.jsx の
 * `columnWrapLines` がレンダラ内で下していた判断をすべてここへ集約する。StructuralLayer.jsx
 * (ColumnsLayer) は `columnWrapRenderProps` の返り値を `<Line key points strokeWidth stroke>` へ
 * そのまま渡すだけにする。
 *
 * StructuralLayer.jsx の柱壁 `<Line>` は strokeScaleEnabled を指定しない（既定 true）ため、
 * Konva の親 Group（viewport.scaleX/scaleY を継承）がストロークもスケールする——渡している
 * strokeWidth（`resolveStrokeWidth`の戻り値）は「世界mm相当値」であり実スクリーンpxではない
 * （finish/stair/stairLineJoinPrimitives.js と同じ状況）。figureLineJoin.js のしきい値判定・
 * 延長量計算は実スクリーンpx前提のため①実px化→②join解決→③世界mm相当へ戻す、という往復が
 * 必要になる（最終的な<Line>のstrokeWidthは不変に保つ）。この往復自体は
 * renderer/planLineJoin.js の姉妹関数 `resolvePlanLinePointsMmScaledStroke`（第6弾）へ委譲する
 * （2026-09移行）。
 *
 * L字結合は柱単位で解決する——複数の柱の包み辺が渡されても、他の柱の端点とは一切マージしない
 * （finish/stair/stairLineJoinPrimitives.js のエントリ単位解決と同じ考え方）。
 * columnWrapRenderProps は柱ごとに個別に resolvePlanLinePointsMmScaledStroke を呼び出す
 * （複数柱ぶんのprimitivesを1回のresolveJoinedLinePoints呼び出しへ混ぜない）。
 */
import { resolvePlanLinePointsMmScaledStroke } from '../renderer/planLineJoin.js';
import { resolveStrokeWidth } from '../viewport.js';
import { wallFinishLineWeight } from '../finish/wallFinishJoin.js';

/**
 * 柱の仕上げ包み（柱壁）の線の太さ。壁の仕上げ材の線と**同じ供給源・同じ引数系**
 * （`finish/wallFinishJoin.js` の `wallFinishLineWeight(detail)` を
 * `resolveStrokeWidth(_, Math.min(scaleX,scaleY))` に通す。renderer/ShapesLayer.jsx の
 * 仕上げ材の線と完全に同じ式）を使う——壁と取り合う相手と太さが揃っていないと1本の線として
 * 連続して見えないため（ユーザー指示2026-08）。詳細LODで太線になるのも壁と同時（2026-09）。
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {boolean} detail - viewport.lodLevel === LodLevel.DETAIL か
 * @param {object} [lineWeightsPx] - viewport.lineWeightsPx（実スクリーンpxの4段階表）
 * @returns {number} `resolveStrokeWidth`の戻り値（世界mm相当。Konva親Groupのscale継承前提）
 */
export function columnWrapStrokeWidth(scaleX, scaleY, detail, lineWeightsPx) {
  return resolveStrokeWidth(wallFinishLineWeight(detail), Math.min(scaleX, scaleY), lineWeightsPx);
}

// 柱壁の外形4辺（旧 columnWrapLines のペア配列と同じ頂点定義）。
function outerEdges(wrap) {
  const { xLo, xHi, yLo, yHi } = wrap;
  return [
    ['xLo', xLo, yLo, xLo, yHi],
    ['xHi', xHi, yLo, xHi, yHi],
    ['yLo', xLo, yLo, xHi, yLo],
    ['yHi', xLo, yHi, xHi, yHi],
  ];
}

// 仕上げ材／下地材の内側境界4辺（detail時のみ）。仕上げ厚で潰れる（内側幅・高さが正でない）柱は
// 1辺も返さない（旧 columnWrapLines と同じガード）。
function innerEdges(wrap) {
  const { xLo, xHi, yLo, yHi } = wrap;
  const f = wrap.finishes ?? {};
  const ixLo = xLo + (f.xLo ?? 0), ixHi = xHi - (f.xHi ?? 0);
  const iyLo = yLo + (f.yLo ?? 0), iyHi = yHi - (f.yHi ?? 0);
  if (!(ixHi - ixLo > 0 && iyHi - iyLo > 0)) return [];
  return [
    ['xLo', ixLo, iyLo, ixLo, iyHi],
    ['xHi', ixHi, iyLo, ixHi, iyHi],
    ['yLo', ixLo, iyLo, ixHi, iyLo],
    ['yHi', ixLo, iyHi, ixHi, iyHi],
  ];
}

/** 柱壁の描画対象キー（Line key。renderer/StructuralLayer.jsx 旧実装と同じ命名）。 */
export function columnWrapOuterKey(columnId, edgeKey) { return `wrap:${columnId}:${edgeKey}`; }
export function columnWrapFinKey(columnId, edgeKey) { return `wrapfin:${columnId}:${edgeKey}`; }

/**
 * 柱1本ぶんの、実際に描く辺だけを figureLineJoin.js 語彙の primitives（mm座標。widthは未設定）へ
 * 写像する。壁の面線が引き継ぐ辺（`wrap.continued[key]`）は対象外（壁側の線に任せる。旧 columnWrapLines
 * の `skip`）。仕上げ材が無い内側境界の辺（`finishes[key]`が0以下）も対象外。
 * @param {object} column - graph.columns の1件（idのみ参照）
 * @param {object|null|undefined} wrap - finish/columnWrap.js の wrapColumnWithFinish 戻り値
 *   （null/undefined なら空配列を返す。包みを持たない柱の呼び出し元ガード漏れに備える）
 * @param {boolean} detail - true なら仕上げ／下地材の内側境界も対象に含める
 * @returns {{key:string, x1:number,y1:number,x2:number,y2:number}[]}
 */
export function columnWrapEdgePrimitives(column, wrap, detail) {
  if (!wrap) return [];
  // 壁の面線が引き継ぐ辺だけを省く（`continued`。`trimmed`との違い＝腰壁・垂れ壁と取り合う辺は
  // 引き継がれない。finish/columnWrap.js 参照）。`continued`を持たない相手（テストダブル・旧
  // 呼び出し）は従来どおり`trimmed`で判断する。
  const skip = key => (wrap.continued ?? wrap.trimmed)?.[key];
  const prims = [];
  for (const [key, x1, y1, x2, y2] of outerEdges(wrap)) {
    if (skip(key)) continue;
    prims.push({ key: columnWrapOuterKey(column.id, key), x1, y1, x2, y2 });
  }
  if (!detail) return prims;
  const f = wrap.finishes ?? {};
  for (const [key, x1, y1, x2, y2] of innerEdges(wrap)) {
    if (skip(key) || !(f[key] > 0)) continue;
    prims.push({ key: columnWrapFinKey(column.id, key), x1, y1, x2, y2 });
  }
  return prims;
}

/**
 * 柱壁（1本以上）の最終描画props（points・strokeWidth）を、L字の角の外角閉じを適用したうえで
 * 解決する。renderer/StructuralLayer.jsx (ColumnsLayer) はこの返り値をそのまま
 * `<Line key points strokeWidth stroke={color} />` へ渡すだけにする。
 * @param {{column:object, wrap:object, color:string, strokeWidth:number, detail:boolean}[]|null|undefined} wraps
 *   - strokeWidth: `columnWrapStrokeWidth`の戻り値（世界mm相当。Konva親Groupのscale継承前提）
 *   - null/undefined は空配列扱い
 * @param {{worldToScreen, screenToWorld, scaleX:number}} viewportLike
 * @returns {{key:string, points:[number,number,number,number], strokeWidth:number, color:string}[]}
 *
 * lineWeightsPx（site/stairのresolve*系と引数順を揃える受け口）は持たない——本モジュールは
 * primitivesのwidthを常に世界mm相当で直指定するため（resolvePlanLinePointsMmScaledStrokeの
 * JSDoc参照）、weight表を引く経路が存在せず、渡しても不使用（旧シグネチャで実際に不使用だった
 * ため削除）。
 */
export function columnWrapRenderProps(wraps, viewportLike) {
  const out = [];
  for (const { column, wrap, color, strokeWidth, detail } of wraps ?? []) {
    const prims = columnWrapEdgePrimitives(column, wrap, detail);
    if (prims.length === 0) continue;
    const keyed = prims.map(p => ({ ...p, width: strokeWidth }));
    // 柱単位で個別に解決する——他の柱のprimitivesとは混ぜない（コメント冒頭参照）。
    const joined = resolvePlanLinePointsMmScaledStroke(keyed, viewportLike);
    for (const p of prims) {
      const j = joined.get(p.key);
      out.push({ key: p.key, points: j.points, strokeWidth: j.width, color });
    }
  }
  return out;
}
