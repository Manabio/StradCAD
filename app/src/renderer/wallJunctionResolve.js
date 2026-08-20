/**
 * 壁のT字取り合い（突き当たり）を検出し、詳細LOD描画にのみ反映する調整結果を返す。
 *
 * ジオメトリ（Wall.startOffset/endOffset 等）は一切変更しない。既存のトリム
 * （core/wallChamfer.js trimIntersectingWalls＝手動壁、stairUnderWalls.js trimStairUnderJunctions＝
 * 階段下壁）が壁の論理端点を相手壁の face（materialRange の境界）へ既にスナップしている
 * 前提の上で、「その端点から先、下地だけが相手壁の仕上げ層を貫通して相手の下地近位面まで
 * 到達する」という描画上の見た目だけを解決する。resolveStairSideLines（stairGeometry.js）
 * と同様、「描画ルールを幾何モジュールに集約しレンダラは写像するだけ」という既存パターンに
 * 倣う。対象は壁全般（手動壁・部屋壁・外壁・階段下壁を区別しない）。
 *
 * - 壁A（突き当たり側）: 下地の描画範囲を、直交する壁Bの下地帯（backingRange）のうち
 *   Aが接している側の近位面まで延長する（baseExtend）。Aの仕上げ帯・仕上げ境界線・
 *   cap線は延長しない（現行どおりAの端点まで）——Aが「突き当たり側」の場合、その端の
 *   cap線はB内部へ食い込む形になり不要なため描画を抑止する。
 * - 壁B（通し壁）: Aの下地幅（Aのbacking Range）に対応する区間で、A側の仕上げ帯・
 *   仕上げ面線をカットする（finishCuts）。Bの下地帯・反対側の仕上げは連続のまま
 *   （このモジュールはBの仕上げ関連要素にのみ finishCuts を返し、下地には触れない）。
 * - B・Aいずれかが薄壁（backingDepth===0＝下地なし）の場合は対象外（貫通元/貫通先の
 *   下地が無い）。
 * - コーナー（Aの直交位置がBの端に近い）・X字（Aの端点がBに近くない＝Aが通り抜ける）は
 *   対象外。コーナーの取り合いは既存の端点処理（trimIntersectingWalls/
 *   trimStairUnderJunctions）の守備範囲であり、この描画解決の対象ではない。
 */

// 「Aの端点がBの材(materialRange)に触れている」とみなす許容差(mm)。
// 既存トリムは理論上ゼロ誤差でface位置へスナップするため小さい値で足りるが、
// 厳密スナップを経ていない壁（未トリムの手動壁等）も拾えるよう、代表的な仕上げ厚
// オーダー（DEFAULT_WALL_FINISH 相当。wallGeneration.js 参照）を許容差とする。
// 150mm（コーナー除外・近接候補探索の許容差）より意図的に小さくし、「明確に離れている
// （デザイン上の隙間）」壁を誤ってT字扱いしないようにする。
const TOUCH_TOLERANCE = 30; // mm

// 「Aの直交位置がBの端に近い＝コーナー」とみなす距離。コーナーの取り合いは既存の
// 端点処理の守備範囲であり対象外にする。trimIntersectingWalls/trimStairUnderJunctions の
// 近接判定tolerance（150mm）と揃え、トリム側が「コーナー」と判定する範囲とこの描画側の
// 除外範囲を一致させる（トリムがコーナー処理した壁を、ここでT字として誤検出しないため）。
const CORNER_EXCLUSION = 150; // mm

function wallLenRange(w) {
  return [Math.min(w.coord1, w.coord2), Math.max(w.coord1, w.coord2)];
}

/**
 * 壁配列から T字取り合いを検出し、壁ID → 描画調整のMapを返す。
 * @param {import('@core').Wall[]} walls
 * @returns {Map<string, {baseExtend:{lo?:number,hi?:number}, finishCuts:[number,number][]}>}
 */
export function resolveWallTJunctions(walls) {
  const result = new Map();
  const ensure = (id) => {
    if (!result.has(id)) result.set(id, { baseExtend: {}, finishCuts: [] });
    return result.get(id);
  };

  for (const a of walls) {
    if (a.wallFinish == null) continue; // 仕上げ厚不明（手動壁で寸法未確定）は対象外
    const aBacking = a.backingRange;
    if (!aBacking) continue; // Aが薄壁（下地なし）は対象外
    const [alo, ahi] = wallLenRange(a);

    for (const b of walls) {
      if (b === a || b.isVertical === a.isVertical || b.wallFinish == null) continue;
      const bBacking = b.backingRange;
      if (!bBacking) continue; // Bが薄壁（下地なし）は対象外（貫通先の下地が無い）

      const [blo, bhi] = wallLenRange(b);
      const aAxisPos = a.axisValue; // Aの厚み方向位置 = Bの長さ方向での占有位置

      // コーナー除外: Aの直交位置がBの両端の近く（CORNER_EXCLUSION以内）ならコーナー扱い
      if (aAxisPos <= blo + CORNER_EXCLUSION || aAxisPos >= bhi - CORNER_EXCLUSION) continue;

      const bRange = b.materialRange;

      for (const [end, coord, anchor] of [['lo', alo, ahi], ['hi', ahi, alo]]) {
        // Aのこの端点がBの材(materialRange)に触れているか（X字＝Aが素通りする場合は
        // どちらの端点もBの材に近くならないため、この判定だけで自然に除外される）
        if (coord < bRange.lo - TOUCH_TOLERANCE || coord > bRange.hi + TOUCH_TOLERANCE) continue;

        // B側: Aの下地幅でBの仕上げ帯・仕上げ面線をカットする——ただしAの本体が
        // Bの仕上げ面側にあるときだけ。反対側（軸〜下地側。例: 1部屋が複数部屋に
        // 面する通し壁で、向かい側の部屋を区切る壁が軸CL位置へ突き当たるケース）から
        // 触れるAはBの仕上げ層を貫通しないため、仕上げ面線は連続のまま残す
        // （カットすると突き当たり位置で反対側の仕上げ材が分断されて見える）。
        // bodySide===0（anchorがB軸上＝判定不能の退化）は従来どおりカットする。
        const bodySide = Math.sign(anchor - b.axisCL.effectiveValue);
        if (bodySide === 0 || bodySide === b.faceDir) {
          ensure(b.id).finishCuts.push([Math.min(aBacking.lo, aBacking.hi), Math.max(aBacking.lo, aBacking.hi)]);
        }

        // A側: Bの下地帯（bBacking）のうち、Aが接している側（bRangeのlo寄りかhi寄りか）の
        // 面を延長先にする
        const fromLoSide = Math.abs(coord - bRange.lo) <= Math.abs(coord - bRange.hi);
        const target = fromLoSide
          ? Math.min(bBacking.lo, bBacking.hi)
          : Math.max(bBacking.lo, bBacking.hi);

        // target が現端点(coord)よりさらに外側（anchorの反対方向）にある場合のみ延長する
        // （既にBの下地近位面を超えている等のケースでは縮めない＝現状維持）
        const dir = Math.sign(coord - anchor) || 1;
        if (dir * (target - coord) > 0) {
          ensure(a.id).baseExtend[end] = target;
        }
      }
    }
  }

  return result;
}
