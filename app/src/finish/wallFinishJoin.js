/**
 * 壁仕上げ材どうしが**取り合う**ときの規則の、唯一の供給源。
 *
 * ユーザー確定仕様（2026-09。壁同士の取り合いとして確定し、2026-09に柱の仕上げ包みへも
 * 適用範囲を広げた）: **仕上げ材が取り合う箇所では、外側の線（仕上げ面線）同士・内側の線
 * （仕上げ／下地の境界線＝fin線）同士がそれぞれ取り合う**。外側線は既存のトリム
 * （`core/wallChamfer.js` / `finish/wallGeneration.js closeConvexCorners` / 柱包みの
 * `resolveSideCover` のトリム）が相手の仕上げ面へ位置を合わせ済みなので、ここで扱うのは
 * **内側線の合わせ先**——「相手の内側線の位置（`finBoundary`）へ置く」。
 *
 * この規則を使う経路（**判定を変えるときはこのファイルだけを直す**）:
 *  - 壁 ↔ 壁: `renderer/wallJunctionResolve.js` パス2（出隅・入隅・十字）。相手壁の
 *    `finBoundary` を自壁のfin線の端点（finEnd）に置く。
 *  - 壁 ↔ 柱の仕上げ包み（柱壁）: `finish/columnWrap.js` `resolveSideCover` のトリム分岐。
 *    包みの面が壁の仕上げ面へ揃った側では、包みの内側境界を相手壁の `finBoundary` に置く
 *    （`finishJoinInset`）。**自前の仕上げ厚で内側へ入れると、壁のfin線と柱壁の内側線が
 *    仕上げ厚2枚ぶん食い違って離れて見える**（実機指摘2026-09。トリム量に関わらず常に
 *    2×wallFinish の隙間になる）。
 *
 * 純モジュール（node:test から単体 import 可能。store.js/*.jsx/react-konva を静的に引かない）。
 */
import { LINE_WEIGHT_MM } from '../core/constants.js';


/**
 * 壁仕上げ材の線（面線・妻線・内側線・木口線）の線幅(mm)。**詳細LODだけ太線**にする
 * ——ユーザー指示2026-09「平面詳細描画時、壁仕上げ線を中線から太線に」。対象は仕上げ材の
 * 4本だけで、下地（間柱）と略図・標準LODの壁線は壁Shapeの既定（medium＝core/shapeBase.js）
 * のまま。
 *
 * **柱の仕上げ包み（柱壁）もこの関数を使う**——壁と太さが揃っていないと1本の線として
 * 連続して見えない（ユーザー指示2026-08）。太さの判断をここ1箇所に閉じ込め、壁側と柱側で
 * 別々に決めない（`structural/columnWrapLineJoin.js` の `columnWrapStrokeWidth` が本関数を引く）。
 * @param {boolean} detail - viewport.lodLevel === LodLevel.DETAIL か
 * @returns {number} LINE_WEIGHT_MM のいずれかの値(mm)
 */
export function wallFinishLineWeight(detail) {
  return detail ? LINE_WEIGHT_MM.thick : LINE_WEIGHT_MM.medium;
}

// 端点はねだし判定・fin線可視性判定の座標許容誤差(mm)。ShapesLayer.jsx のecap判定と
// `resolveFinVisibility` の両方が使う共有定数（旧: 両ファイルに別々の同名定数を持っており、
// 値のドリフトが実バグの一因だった。単一の供給源に統合する）。
export const ENDPOINT_EPS = 0.5;

/**
 * 内側線（fin線）の位置と可視性を解決する——壁単体（他壁との取り合いを一切見ない）だけで
 * 決まる性質のため、`wallJunctionResolve.js` パス2の候補判定（makeView）・ShapesLayer.jsx の
 * 描画ガード・柱包みの取り合いの**唯一の供給源**にする（旧: 描画ガードとパス2が別々に同じ式を
 * 持っており、`wallFinish>0`だけを見て materialRange 上の可視性を見ていなかったため、
 * `|axisOffset|===wallFinish`の薄壁（内側線が軸CL上に潰れる。`finish/stair/stairUnderWalls.js`の
 * ルール2＝階段下部屋の外側仕上げ薄壁が実際に生成する形状）でfin線が描かれないのにパス2が
 * capSuppressを立ててしまい、端にcapもfinも無くなる回帰を生んだ）。
 * @param {import('@core').Wall} wall
 * @returns {{finBoundary:number, finVisible:boolean}}
 */
export function resolveFinVisibility(wall) {
  const { lo, hi } = wall.materialRange;
  const finBoundary = wall.axisValue - wall.faceDir * (wall.wallFinish ?? 0);
  const finVisible = wall.wallFinish > 0
    && finBoundary >= lo && finBoundary <= hi
    && Math.abs(finBoundary - wall.axisCL.effectiveValue) > ENDPOINT_EPS;
  return { finBoundary, finVisible };
}

/**
 * 取り合う相手（壁）の内側線の位置＝こちらの内側線を置く先。fin線が描かれない壁
 * （`finVisible===false`）とは取り合わない＝null を返す（呼び出し側は自前の寸法で納める）。
 * @param {{finBoundary:number, finVisible:boolean}|null|undefined} finLine
 *   - `resolveFinVisibility` の戻り値（呼び出し側がビューへ写して持っていてもよい）
 * @returns {number|null}
 */
export function finishJoinBoundary(finLine) {
  return finLine?.finVisible ? finLine.finBoundary : null;
}

/**
 * 面（外向き法線が `side` の面）が相手壁の仕上げ面へ揃って取り合うとき、その面から相手の
 * 内側線までの**見込み量**（面から内向きを正とする符号付き距離）を返す。取り合わないなら null。
 *
 * 相手の内側線は相手の材の中（＝この面より外側）にあるため、通常は**負**になる
 * ——「面から内側へ自前の仕上げ厚ぶん入れる」のではなく「相手の内側線まで外へ出す」のが
 * 取り合いの規則だからで、符号はその向きの違いをそのまま表す。
 * @param {{finBoundary:number, finVisible:boolean}|null|undefined} finLine - 相手壁のfin線
 * @param {number} faceValue - 取り合う面の座標（トリム後＝相手の仕上げ面と揃った位置）
 * @param {-1|1} side - その面の外向き法線（-1: lo側の面 / +1: hi側の面）
 * @returns {number|null}
 */
export function finishJoinInset(finLine, faceValue, side) {
  const target = finishJoinBoundary(finLine);
  return target == null ? null : side * (faceValue - target);
}
