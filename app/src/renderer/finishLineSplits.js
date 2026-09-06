/**
 * 壁仕上げ材の線を「1本の線分」にまとめる解決（純モジュール）。
 *
 * 平面の壁仕上げ材は2本の線で表す——外側の**面線**（仕上げ面 face）と内側の**内側線**
 * （仕上げ／下地の境界 fin）。壁の取り合いの角では、この1本に見える線が実際には複数の
 * `<Line>` に分かれて描かれていた。実機2026-09（2階X2×Y1+2000の出隅）の水平線は
 *
 *   壁Aの面線(2485) ／ 交差部の短い駒の面線(12.5) ／ 直交壁の妻線(102.5)
 *
 * の3本で1本を構成していた。ユーザー指示2026-09「不足した仕上げ材の線分を追加している個所を
 * **線分延長**にして、壁仕上げ材線分は1本線分で描画」に対応する解決をここに集約する。
 *
 * ## 連なり（run）の作り方
 *  - 対象は**壁仕上げ材として描かれる線すべて**——面線・内側線に加えて**妻線（cap）・
 *    木口線（ecap）も入れる**。線の**役割**ではなく**同一直線上に並んでいるか**が条件で、
 *    種別で分けると連なりが妻線のところで途切れる（拾い漏れの原因だった）。
 *  - **同一直線**: 向き（縦／横）が同じ、線の位置の差が SPLIT_AXIS_EPS 以内、かつ**線種が同じ**
 *    （色・線幅・破線。違う線種をまとめると見た目が変わってしまう）。
 *  - **接している**: 長さ方向の区間が SPLIT_TOUCH_EPS 以内で接する、または重なる。
 *    開口で分かれた線分は開口幅ぶんの隙間が空くため、この条件に入らない（＝まとめない）。
 *
 * ## まとめる／まとめない
 *  - 連なりの中で**長さがその壁の材幅以下**の線分を「取り合いを埋めるために足された線分」
 *    （filler）と見なす。閾値は任意の数値ではなく `materialRange` の幅——角を埋める線分は
 *    原理的に相手の材幅を超えず、妻線・木口線は定義上ちょうど材幅になる。
 *  - **filler を含む連なりだけ**をまとめる。長い壁どうしが端で接するだけの並び（T字で分割
 *    された通し壁など）は「追加線分がある箇所」ではないので手を触れない。
 *  - まとめた1本は、連なりの中で**最も長い filler でない線分**（本体）が引く。他の線分は
 *    描かない。本体が1本も無い連なりは、延長の主体が決められないのでまとめない。
 *
 * ## 端をどこに置くか（ユーザー確定2026-09「案A」）
 * 各線分は「まとめるときに使う区間」（mergeLo/mergeHi）を自分で持つ。妻線はそのまま材幅
 * いっぱいだが、**木口線は自壁の内側線の位置まで**に切り詰めた区間を持つ——出隅では
 * 「外側線は相手の仕上げ面まで／内側線は相手の内側線まで」が仕上げ材の取り合い規則
 * （finish/wallFinishJoin.js）で、木口線を材幅いっぱいのまま採ると内側線が相手の内側線を
 * **通り越して**仕上げ面まで達してしまう（ユーザー実機指摘）。
 *
 * 純モジュール（node:test から単体 import 可能。store.js/*.jsx/react-konva を静的に引かない）。
 */

// 同一直線と見なす、線の位置（厚み方向）の許容差(mm)。
export const SPLIT_AXIS_EPS = 0.5;
// 端点が接していると見なす、長さ方向の許容差(mm)。
export const SPLIT_TOUCH_EPS = 1;

/**
 * 分かれて描かれている仕上げ線を1本にまとめる指示を返す。
 * @param {Array<{key:*, vertical:boolean, at:number, lo:number, hi:number,
 *                mergeLo:number, mergeHi:number, fillerMax:number, styleKey:string}>} lines
 *   key: 呼び出し側の採番（ShapesLayer.jsx の <Line> の key と同じ文字列を使う）
 *   vertical: 線そのものの向き（縦線ならtrue。壁の向きではない——縦壁の妻線は横線）
 *   at: 線の位置（縦線ならx、横線ならy）。lo/hi: 実際に描かれている長さ方向の区間。
 *   mergeLo/mergeHi: まとめるときに使う区間（木口線は自壁の内側線まで切り詰めた区間）
 *   fillerMax: これ以下の長さなら「埋めるために足された線分」と見なす閾値（その壁の材幅）
 *   styleKey: 線種（色・線幅・破線）が同じかの比較キー
 * @returns {Map<*, [number,number]|null>}
 *   値が配列＝その線分をこの区間で描く（まとめた1本）。null＝その線分は描かない。
 *   まとめ対象にならなかった線分はMapに入らない（呼び出し側は従来どおり描く）。
 */
export function resolveFinishLineMerges(lines) {
  const result = new Map();
  const buckets = new Map(); // `${vertical}|${styleKey}` → 線分[]
  for (const l of lines) {
    const k = `${l.vertical}|${l.styleKey}`;
    const b = buckets.get(k);
    if (b) b.push(l);
    else buckets.set(k, [l]);
  }
  for (const bucket of buckets.values()) {
    // 位置（at）でクラスタに分ける。浮動小数の微差を吸収するため、隣どうしの差で連ねる。
    bucket.sort((a, b) => a.at - b.at);
    let i = 0;
    while (i < bucket.length) {
      let j = i + 1;
      while (j < bucket.length && bucket[j].at - bucket[j - 1].at <= SPLIT_AXIS_EPS) j++;
      mergeTouchingRuns(bucket.slice(i, j), result);
      i = j;
    }
  }
  return result;
}

// 同一直線上の線分群を長さ方向に並べ、接している連なりごとに「まとめる1本」を決める。
function mergeTouchingRuns(sameLine, result) {
  const sorted = [...sameLine].sort((a, b) => a.lo - b.lo);
  let run = [];
  let end = -Infinity;
  const flush = () => {
    if (run.length >= 2) mergeRun(run, result);
    run = [];
  };
  for (const l of sorted) {
    if (run.length === 0 || l.lo <= end + SPLIT_TOUCH_EPS) {
      run.push(l);
      end = Math.max(end, l.hi);
    } else {
      flush();
      run = [l];
      end = l.hi;
    }
  }
  flush();
}

// 1つの連なりを1本へまとめる。埋め線を含まない連なり・本体が無い連なりは手を触れない。
function mergeRun(run, result) {
  const isFiller = (l) => l.hi - l.lo <= l.fillerMax + SPLIT_TOUCH_EPS;
  if (!run.some(isFiller)) return;
  let owner = null;
  for (const l of run) {
    if (isFiller(l)) continue;
    if (!owner || l.hi - l.lo > owner.hi - owner.lo) owner = l;
  }
  if (!owner) return; // 埋め線だけの連なり——延長の主体が無いので触らない
  let lo = Infinity, hi = -Infinity;
  for (const l of run) {
    if (l.mergeLo < lo) lo = l.mergeLo;
    if (l.mergeHi > hi) hi = l.mergeHi;
  }
  for (const l of run) result.set(l.key, l === owner ? [lo, hi] : null);
}
