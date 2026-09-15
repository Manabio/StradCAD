// ================================================================
// 梁の軸線から「4辺すべてが梁で囲まれた矩形セル」を抽出する純モジュール
// （在来木造 ステップ3e-1。設計意図は .claude/structural-model.md 参照）。
//
// finish/gridCells.js のセルは意匠中心線＋通り芯由来の分割格子（grid上の空間分割）で、
// 梁芯を含まない。3e 床梁（セルの短辺が1820超なら床梁を割り付ける）・3f 火打ち梁
// （16㎡以下の四角の4隅）は「床梁の端が host 梁に届く」ことが前提のため、
// gridCells の分割格子ではなく生成済みの梁そのもの（軸線）からセルを導く必要がある。
// このファイルはそのための独立した純関数を提供する（gridCells.js とは別系統・統合しない）。
//
// react/konva/store/.jsx を静的に引かない（node:test から単体 import 可能）。woodFraming.js の
// mergeWallIntervals を薄く再利用するため、woodFraming.js経由でstructureRules.js/sectionCatalog.js/
// core/constants.jsへ静的到達する（3e-2で到達モジュールが8本に広がった）が、いずれも同じ「.jsx・
// store.js・snap.js・core.jsを引かない」純モジュール群であり、この規律の対象外ではない（意図的）。
// ================================================================
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { mergeWallIntervals } from './woodFraming.js';

// lines の要素として妥当か（isVertical:boolean、coord/lo/hi:有限数、lo<hi）
function isValidLine(l) {
  return !!l && typeof l.isVertical === 'boolean'
    && Number.isFinite(l.coord) && Number.isFinite(l.lo) && Number.isFinite(l.hi)
    && l.lo < l.hi;
}

// [lo,hi] 区間群を昇順ソートし、重なるか隙間が tol 以下のもの同士を連結する。
// woodFraming.js mergeWallIntervals（{lo,hi}オブジェクト版）へ薄く委譲する（3e-1で並行編集回避のため
// ローカル複製していたが、3e-2で両ファイルが揃ったため二重実装を解消した）。
function mergeIntervals(intervals, tol) {
  return mergeWallIntervals(intervals.map(([lo, hi]) => ({ lo, hi })), tol).map(iv => [iv.lo, iv.hi]);
}

// 同一方向（縦どうし／横どうし）の線群を coord で tol クラスタリングし、各クラスタの
// 区間群を tol でマージする。クラスタの代表 coord は昇順走査で最初に採用した線の coord
// （＝クラスタ内最小値）——同一線が僅かにずれた coord で複数登録されていても1本として扱う。
function clusterLines(lines, tol) {
  const sorted = [...lines].sort((a, b) => a.coord - b.coord);
  const clusters = [];
  for (const l of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && l.coord - last.coord <= tol) last.intervals.push([l.lo, l.hi]);
    else clusters.push({ coord: l.coord, intervals: [[l.lo, l.hi]] });
  }
  for (const c of clusters) c.intervals = mergeIntervals(c.intervals, tol);
  return clusters;
}

// クラスタの区間群のいずれか1つが [a,b] を tol 込みで覆っているか
// （複数区間にまたがる部分被覆の合算はしない＝L字・断片統合はしない仕様）。
function covers(cluster, a, b, tol) {
  return cluster.intervals.some(([lo, hi]) => lo <= a + tol && hi >= b - tol);
}

// クラスタの区間群のいずれか1つが、開区間 (a,b)（両端を tol だけ除いた内側）へ実質的に
// 入り込んでいるか（横断・スタブを区別しない厳密判定。端に tol 以内で接するだけ＝矩形の外との
// 境界共有は「入り込み」に含めない）。
function intrudes(cluster, a, b, tol) {
  return cluster.intervals.some(([lo, hi]) => hi > a + tol && lo < b - tol);
}

/**
 * 梁の軸線 lines から、縦線 coord 集合 × 横線 coord 集合の**全ペア**（隣接に限らない）が作る矩形のうち、
 * 4辺すべてがその線上の梁で覆われ、かつ**内部（両端を除いた開区間）へ入り込む梁が1本も無い**ものを返す。
 *
 * 隣接ペア限定（旧実装）だと、実データで大部屋の隅にT字に取りつく別の壁由来の梁の座標が縦・横の
 * クラスタ列に混ざるだけで、その座標の左右（上下）どちらの隣接ペアも4辺被覆にならず、大部屋自体が
 * 1個のセルとしても検出できなくなる（実測: moku1.stq 2階でこの理由により短辺>1820のセルが0個に
 * 落ちていた——大部屋の内部にT字の座標が挟まるだけで矩形自体を隣接ペアで表現できなくなるため）。
 * 全ペアを候補にする必要があるが、内部判定は**横断（反対側の辺まで届く梁）とスタブ（矩形内部へ
 * 突き出すだけで反対側の辺まで届かない梁）を区別しない**——スタブを許すと、スタブ自身が実は
 * 隣接する別区画の壁下梁・頭つなぎであるケースで、大きい方の矩形が「内部に壁がある」にもかかわらず
 * 1個の床梁対象セルとして検出され、その壁とほぼ同一軸・近接並行の二重梁を生んでしまう
 * （実測: moku1.stq 2階 x=1820 の壁下梁 y[-9100,-6370] と、スタブを許した場合に生成される
 * 床梁 y[-10794,-7280] が y[-9100,-7280] で同一軸重複。3階では頭つなぎ y=-10794 [0,1820] と
 * 生成される床梁 y=-10819 がほぼ同一位置に並行——どちらも「床梁は上下階とも壁・柱の無い区画に
 * 置く」という前提が崩れる）。矩形内部に梁（＝多くは壁の下地帯に沿う梁）が少しでも入り込んでいる
 * 時点で「壁・柱の無い区画」ではないため、区画として扱わないのが用語の定義に忠実。
 * 〔割り切り・deferred〕この判定は矩形のみを候補にするため、L字型の空き（収納等のスタブ壁を持つ
 * 部屋）は床梁の対象として検出できない（面を分解してL字を複数の矩形として扱う拡張は次フェーズ）。
 *
 * @param {Array<{isVertical: boolean, coord: number, lo: number, hi: number}>} lines
 *   梁の軸線。縦線（isVertical:true）は coord=x・lo/hi はy範囲、横線は coord=y・lo/hi はx範囲。
 *   同一 coord（tol未満で同一視）の線は区間の和集合として扱ってよい（複数線分に分かれていてもよい）。
 * @param {number} [tol] - 座標の同一視・区間連結の許容誤差(mm)
 * @returns {Array<{x1:number, y1:number, x2:number, y2:number}>}
 *   x1<x2, y1<y2。y1昇順→x1昇順の決定的な順で返す（呼び出し順に依存しないよう明示的にソートする）。
 *   非矩形・被覆が欠ける矩形・内部に梁が入り込む矩形は含めない。
 *
 * 計算量: 縦線クラスタ数を n、横線クラスタ数を m とすると候補矩形は O(n^2 m^2)、各候補の内部侵入
 * チェックがさらに O(n+m) を要するため最悪 O(n^2 m^2 (n+m))——だが伏図の通り芯・梁芯（クラスタ）本数は
 * 実データでも数十程度（moku1.stq実測で2階18本→縦横クラスタ計10本前後）のため実用上問題ない
 * （probe実測: 数十msで完了）。
 */
export function beamGridCells(lines, tol = CL_OVERLAP_TOL_MM) {
  if (!Array.isArray(lines)) return [];
  const valid = lines.filter(isValidLine);
  const verticals = clusterLines(valid.filter(l => l.isVertical), tol);
  const horizontals = clusterLines(valid.filter(l => !l.isVertical), tol);
  if (verticals.length < 2 || horizontals.length < 2) return [];

  const cells = [];
  for (let k = 0; k < horizontals.length - 1; k++) {
    for (let l = k + 1; l < horizontals.length; l++) {
      const top = horizontals[k], bottom = horizontals[l];
      const y1 = top.coord, y2 = bottom.coord;
      for (let i = 0; i < verticals.length - 1; i++) {
        for (let j = i + 1; j < verticals.length; j++) {
          const left = verticals[i], right = verticals[j];
          const x1 = left.coord, x2 = right.coord;
          if (!covers(left, y1, y2, tol)) continue;
          if (!covers(right, y1, y2, tol)) continue;
          if (!covers(top, x1, x2, tol)) continue;
          if (!covers(bottom, x1, x2, tol)) continue;
          // 内部（i<m<j／k<m<l）のクラスタが矩形の内部（開区間）へ入り込んでいれば、横断・スタブを
          // 区別せず候補から外す（二重梁の回避。JSDoc参照）。
          let divided = false;
          for (let m = i + 1; m < j && !divided; m++) {
            if (intrudes(verticals[m], y1, y2, tol)) divided = true;
          }
          for (let m = k + 1; m < l && !divided; m++) {
            if (intrudes(horizontals[m], x1, x2, tol)) divided = true;
          }
          if (divided) continue;
          cells.push({ x1, y1, x2, y2 });
        }
      }
    }
  }
  cells.sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1));
  return cells;
}
