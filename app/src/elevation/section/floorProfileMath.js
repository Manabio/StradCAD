/**
 * 床プロファイル（FloorProfile）と面の半壁厚・run 方向の刻みの**純粋な計算**。
 *
 * 断面エンジン（section/）が引く部分を、面の体裁（elevationFloorProfile.js）から切り出した
 * もの（展開図リファクタ S1: section/ から親ディレクトリへ逆向きに import しないため）。
 * elevationFloorProfile.js は本ファイルから re-export するので、既存の呼び出し側は変わらない。
 * 面・部屋の概念は持たない（face は faceValue/axisCL を読むだけ）。
 */

import { DEFAULT_WALL_BASE, DEFAULT_WALL_FINISH } from '../../finish/wallGeneration.js';
import { gridIndexOf } from '../../finish/gridCells.js';
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

// 実壁が引けない面（単体テスト等の合成face）向けの半壁厚フォールバック(mm)。
// 既定壁下地厚(DEFAULT_WALL_BASE)の半分+既定仕上げ厚(DEFAULT_WALL_FINISH) = 45+12.5 = 57.5。
const DEFAULT_HALF_WALL_MM = DEFAULT_WALL_BASE / 2 + DEFAULT_WALL_FINISH;

/**
 * [lo,hi] 区間を、run の伸びる方向と同じ向きのCL値で刻む（elevationStepFace.js の
 * collectAxisBreaks・elevationOpenSpan.js の collectRunBreaks と同じ考え方。QA修正:
 * wallAdjacentFloorSegments でも同じ「粗いセル境界」問題が起きるため、唯一の実装として
 * ここへ統合し elevationOpenSpan.js から re-export する）。
 * @param {object} graph
 * @param {boolean} isVertical - 面のisVertical（runがY方向ならtrue）
 * @param {number} lo
 * @param {number} hi
 * @returns {number[]}
 */
export function collectRunBreaks(graph, isVertical, lo, hi) {
  // 全CLの座標値（分割CLに限らない）はグリッド索引が持つ——スコープ内なら組み直さない。
  const g = gridIndexOf(graph);
  const values = new Set([lo, hi]);
  for (const v of (isVertical ? g.allYValues : g.allXValues)) {
    if (v > lo && v < hi) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * face自身の壁厚の半分(mm)。|faceValue - axisCL.effectiveValue|（面自身の芯からのオフセット量＝
 * 半壁厚）を返す。0（合成face等でfaceValueが不明・芯に一致する場合）はDEFAULT_HALF_WALL_MM
 * （既定壁下地厚の半分+既定仕上げ厚=57.5mm）へフォールバックする。
 * @param {object} face
 * @returns {number}
 */
export function halfWallThicknessMm(face) {
  const v = Math.abs((face.faceValue ?? face.axisCL?.effectiveValue ?? 0) - (face.axisCL?.effectiveValue ?? 0));
  return v > 0 ? v : DEFAULT_HALF_WALL_MM;
}

/**
 * @typedef {Array<[number, number]>} FloorProfile
 *   その面の**断面線（下側の輪郭）**を表す折れ線。`[[localX, absZ], ...]`・x昇順で、垂直な
 *   段差は同じxを2点書く。範囲外（壁のない端部のはり出しぶん）は端点の値を保持する。
 *   `elevationFigure.js`の`ceilAbsAtX`が解釈する`ceilingProfile`（天井プロファイル）の
 *   **双子**——上下が逆なだけで、規約も補間の仕方もわざと同一に揃えてある（床と天井で
 *   別々の読み方を覚えなくていいように。elevationFigure.js側は本ファイルの
 *   drawnFloorProfileZAtをそのまま呼ぶ＝実装も1つ）。
 */

// profileLimitsOnで外挿（1/4・3/4の2点から線形に延ばす）を行う最小の区間長(mm)。GAP_EPS(1e-6)
// では分母(2q)が図面の実寸法スケールから外れるほど小さくなり、区間内にプロファイルの準垂直な
// 段差（同じ位置のはずの2点が丸め誤差でμm単位ずれた状態）が挟まると、外挿値が段差の高さぶん
// 上下へ飛び出す（QA指摘8）。1e-3mm＝1µmは作図上まったく意味を持たない幅なので、ここより
// 短い区間は外挿せず端点値をそのまま返す。
const PROFILE_LIMIT_MIN_SPAN_MM = 1e-3;

// [xl,xr]の**内側**でのprofileの線形な値（左端の右極限・右端の左極限）。区間内にprofileの
// 断点が無いことを前提に、内側の2点（1/4・3/4）から線形に外挿して求める——端点をそのまま
// 引くと、垂直な段差のある境界でどちら側の値が返るかが曖昧になる（drawnFloorProfileZAtは
// ceilAbsAtXと同じく「同じxの2点目」を返す規約）。
export function profileLimitsOn(profile, xl, xr) {
  // 極小区間（またはxr<=xl・NaN）は外挿せず端点値。`!(… > …)`はNaNもこちらへ落とすため。
  if (!(xr - xl > PROFILE_LIMIT_MIN_SPAN_MM)) {
    return [drawnFloorProfileZAt(profile, xl), drawnFloorProfileZAt(profile, xr)];
  }
  const q = (xr - xl) / 4;
  const z1 = drawnFloorProfileZAt(profile, xl + q);
  const z2 = drawnFloorProfileZAt(profile, xr - q);
  const slope = (z2 - z1) / (2 * q);
  return [z1 - slope * q, z2 + slope * q];
}

/**
 * 2つのFloorProfileを**max**（＝2本の断面線のうち高い方が下側の輪郭）に合成する。
 * 断点は両者のx（和集合）に加え、区間内で大小が入れ替わる**交点x**も挿入する——入れないと
 * 交差の手前まで低い側の値が採られ、輪郭が実際より下（余分に描く側）へ膨らむ。
 * 片方が空なら他方のコピー。
 *
 * **各プロファイルは自分のx範囲の中でだけ効き、範囲外は相手に譲る**——読み出し側
 * （drawnFloorProfileZAt）の「範囲外は端点値を保持」をそのまま合成に持ち込むと、踊り場の
 * ような**短い寄与**の端点値が面の全長を覆い、そこにある階段の勾配を丸ごと飲み込んでしまう
 * （回帰: seq2のレーンの床線が全区間消える）。両方の範囲外は、結果の端点保持で表現される。
 * @param {FloorProfile|null|undefined} a
 * @param {FloorProfile|null|undefined} b
 * @returns {FloorProfile}
 */
export function mergeFloorProfiles(a, b) {
  if (!a?.length) return b?.length ? b.map(p => [...p]) : [];
  if (!b?.length) return a.map(p => [...p]);
  const breaks = [...new Set([...a, ...b].map(([x]) => x))].sort((p, q) => p - q);
  const out = [];
  const push = (x, z) => {
    const last = out[out.length - 1];
    // 同じ点の重複だけ落とす（同じx・違うz＝垂直な段差は両方残す）。
    if (last && Math.abs(last[0] - x) <= GAP_EPS && Math.abs(last[1] - z) <= GAP_EPS) return;
    out.push([x, z]);
  };
  if (breaks.length < 2) {
    const x = breaks[0];
    return [[x, Math.max(drawnFloorProfileZAt(a, x), drawnFloorProfileZAt(b, x))]];
  }
  const covers = (p, xl, xr) => p[0][0] <= xl + GAP_EPS && p[p.length - 1][0] >= xr - GAP_EPS;
  for (let i = 0; i + 1 < breaks.length; i++) {
    const xl = breaks[i], xr = breaks[i + 1];
    if (xr - xl <= GAP_EPS) continue;
    const active = [a, b].filter(p => covers(p, xl, xr));
    if (active.length === 0) continue; // どちらの範囲でもない区間（両者が離れている）は跨いで結ぶ
    if (active.length === 1) {
      const [l, r] = profileLimitsOn(active[0], xl, xr);
      push(xl, l); push(xr, r);
      continue;
    }
    const [al, ar] = profileLimitsOn(a, xl, xr);
    const [bl, br] = profileLimitsOn(b, xl, xr);
    push(xl, Math.max(al, bl));
    const dl = al - bl, dr = ar - br;
    if ((dl > GAP_EPS && dr < -GAP_EPS) || (dl < -GAP_EPS && dr > GAP_EPS)) {
      const t = dl / (dl - dr);
      push(xl + (xr - xl) * t, al + (ar - al) * t);
    }
    push(xr, Math.max(ar, br));
  }
  return out;
}

/**
 * FloorProfileの高さ（絶対z）を面ローカルxで引く。null・空は-Infinity＝下限なし。
 * 補間・範囲外クランプの規約はelevationFigure.jsの`ceilingProfile`（天井プロファイル）と
 * 同一——同ファイルの`ceilAbsAtX`は本関数へ委譲している（QA修正2026-09で実装を1つに統合）。
 * @param {FloorProfile|null|undefined} profile
 * @param {number} x
 * @returns {number}
 */
export function drawnFloorProfileZAt(profile, x) {
  if (!profile?.length) return -Infinity;
  const first = profile[0], last = profile[profile.length - 1];
  const cx = Math.min(Math.max(x, first[0]), last[0]); // 範囲外は端点値へクランプ
  for (let i = 0; i + 1 < profile.length; i++) {
    const [x1, z1] = profile[i];
    const [x2, z2] = profile[i + 1];
    if (cx >= x1 - GAP_EPS && cx <= x2 + GAP_EPS) {
      return x2 === x1 ? z2 : z1 + ((cx - x1) / (x2 - x1)) * (z2 - z1);
    }
  }
  return last[1];
}

/**
 * FloorProfileの[x0,x1]区間での**最大**高さ（区分線形なので端点＋区間内の断点のmaxで足りる）。
 * null・空は-Infinity。
 * @param {FloorProfile|null|undefined} profile
 * @param {number} x0
 * @param {number} x1
 * @returns {number}
 */
export function drawnFloorProfileZMax(profile, x0, x1) {
  if (!profile?.length) return -Infinity;
  const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
  let z = Math.max(drawnFloorProfileZAt(profile, lo), drawnFloorProfileZAt(profile, hi));
  for (const [x, pz] of profile) if (x > lo + GAP_EPS && x < hi - GAP_EPS) z = Math.max(z, pz);
  return z;
}
