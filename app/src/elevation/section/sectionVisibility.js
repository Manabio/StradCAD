/**
 * 2.5D断面エンジン: 断面面内の**可視領域**（＝「断面の中」でない領域）の判定。
 *
 * 「展開図では断面の中は描画しない」（ユーザー明示指示2026-08）の**唯一の一次情報源**。
 * ユーザー定義: 断面の中とは「連続した断面線で切り取られた向こう側全て」——壁の中も、隣の
 * 部屋も、天井裏も含む。多層帯では断面線が図を左右に分割するので、**分割されたどちら側が
 * 中なのか**を決める必要がある。
 *
 * 方式は**空気セルの連結成分**（ゲームの可視性カリングで言うセル＆ポータルと同型）:
 *   1. 列（`buildColumns`のx区間）× z区間を「実体が占めない＝空気」で切り出す
 *   2. 隣接列の空気セルはz区間が重なれば連結（＝ポータル）
 *   3. 帯の持ち主の空間を種にフラッドフィルし、到達できた空気セルだけが「断面の外」
 *
 * **側（左右）判定を一次情報にしない**理由: 断面線が図を完全に分断するときしか定義できない。
 * 腰壁は天端の上で、アキは穴で、段違い天井の壁は低い側の天井より下で、それぞれ左右がつながる
 * ——「どちら側か」は線の属性ではなく、線をまたいで領域がつながっているかの**結果**である。
 * 分断する線については「左右の一方だけが到達可能」が成り立つので、その性質は単体テスト側の
 * 独立検算に使う（sectionVisibility.test.js）。
 *
 * 視線を遮る実体は`cut`（切断線を横切る壁）・`cutAlong`（縦断された壁）だけ。`wall`
 * （見えがかり）は切断面の**向こう**にあるので切断面内の横の連結を遮らない——遮ると
 * 「向こうに壁がある区間の手前の空間」まで消える。
 *
 * 本モジュールは**列（SectionColumn[]）を受け取る純関数だけ**にする——`buildColumns`を
 * import すると sectionEngine.js との循環importになる（あちらが本モジュールを使う）。
 * 呼び出し側が列を作って渡すこと。
 *
 * 純モジュール（store.js/snap.js/*.jsx/react-konva/appViewport.jsを静的importしない）。
 */
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';

// 空気とみなす最小のz幅(mm)。これ以下は実体どうしの継ぎ目であって通り抜けられない。
const MIN_AIR_MM = 1e-6;

/** 視線を完全に遮る実体の帯か（本ファイル冒頭）。 */
function blocksSightline(band) {
  return band.kind === 'cut' || band.kind === 'cutAlong';
}

/**
 * 1列の空気区間＝[loZ,hiZ]から遮蔽実体のz範囲を引いた残り（z0昇順）。
 * @param {import('./sectionTypes.js').ZBand[]} bands
 * @param {number} loZ
 * @param {number} hiZ
 * @returns {Array<{z0:number, z1:number}>}
 */
export function airIntervalsOf(bands, loZ, hiZ) {
  let out = hiZ - loZ > MIN_AIR_MM ? [{ z0: loZ, z1: hiZ }] : [];
  for (const b of bands ?? []) {
    if (!blocksSightline(b)) continue;
    const next = [];
    for (const a of out) {
      if (b.z1 <= a.z0 + GAP_EPS || b.z0 >= a.z1 - GAP_EPS) { next.push(a); continue; }
      if (b.z0 > a.z0 + GAP_EPS) next.push({ z0: a.z0, z1: b.z0 });
      if (b.z1 < a.z1 - GAP_EPS) next.push({ z0: b.z1, z1: a.z1 });
    }
    out = next;
  }
  return out.filter(a => a.z1 - a.z0 > MIN_AIR_MM);
}

// ローカルx範囲を昇順に整列し、接する/重なるものを1本へ結合する。
function mergeLocalRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi + GAP_EPS) last.hi = Math.max(last.hi, r.hi);
    else out.push({ ...r });
  }
  return out;
}

/**
 * 列ごとの**到達可能な空気区間**（連結成分。本ファイル冒頭の方式そのもの）。
 *
 * 種は**各列の最下の空気区間**——床断面線は面の全長に引かれる以上、その直上の空間は
 * 定義上つねに図の対象である。上側の空気（腰壁の天端の上・アキの穴の上など、切断壁で
 * 分断されてできた2つめ以降の区間）だけが「横につながって初めて見える」対象になる。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns - x0昇順・bandsは**未クリップ**
 * @param {{loZ:number, ceilOf:(col:object)=>number}} opts - 空気の上下の枠（床断面・天井断面）
 * @returns {Array<Array<{z0:number,z1:number}>>} 列と同じ並び
 */
export function reachableAirByColumn(columns, opts) {
  return floodFill(columns, opts, (col, ivs) => (ivs.length > 0 ? [0] : [])); // 最下＝床断面の直上
}

/**
 * 空気セルの連結成分（本ファイル冒頭の方式の実体）。種の選び方だけを呼び出し側から受ける。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {{loZ:number, ceilOf:(col:object)=>number}} opts
 * @param {(col:object, intervals:Array<{z0:number,z1:number}>)=>number[]} seedIndices
 * @returns {Array<Array<{z0:number,z1:number}>>}
 */
function floodFill(columns, opts, seedIndices) {
  const { loZ, ceilOf } = opts;
  const cells = columns.map(col => airIntervalsOf(col.bands, loZ, ceilOf(col)));
  // 列がx方向に接しているか（探査の切れ目をまたいで連結させない）。
  const adjacent = (a, b) => Math.abs(a.x1 - b.x0) < GAP_EPS || Math.abs(b.x1 - a.x0) < GAP_EPS;
  const seen = new Set();
  const stack = [];
  const push = (i, k) => {
    const key = `${i}:${k}`;
    if (seen.has(key)) return;
    seen.add(key);
    stack.push([i, k]);
  };
  columns.forEach((col, i) => { for (const k of seedIndices(col, cells[i])) push(i, k); });
  while (stack.length > 0) {
    const [i, k] = stack.pop();
    const a = cells[i][k];
    for (const j of [i - 1, i + 1]) {
      if (!columns[j] || !adjacent(columns[i], columns[j])) continue;
      cells[j].forEach((b, m) => {
        if (b.z1 <= a.z0 + GAP_EPS || b.z0 >= a.z1 - GAP_EPS) return; // z区間が重ならない＝通れない
        push(j, m);
      });
    }
  }
  return cells.map((ivs, i) => ivs.filter((_, k) => seen.has(`${i}:${k}`)));
}

/**
 * 指定した種（seedRanges）の空間から到達できる列のローカルx範囲（結合済み）。
 * `reachableAirByColumn`が「各列の最下の空気」を種にするのに対し、こちらは**x範囲で種を指定**
 * する用法（上部吹抜けの2層帯が「吹抜けの範囲から到達できる上階」を求めるのに使う）。
 *
 * columnsは**打ち切り前の実体**を持つものを渡すこと（`cut.ceilProfile`を持つcutで作った列は
 * 既に天井で切られており、空気の判定に使えない）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {{loZ:number, ceilOf:(col:object)=>number}} opts
 * @param {Array<{lo:number,hi:number}>} seedRanges - 断面ローカルx
 * @returns {Array<{lo:number,hi:number}>} 断面ローカルx
 */
export function reachableLocalRanges(columns, opts, seedRanges) {
  if (columns.length === 0) return [];
  const seeds = seedRanges ?? [];
  const overlapsSeed = col => seeds.some(r => col.x0 < r.hi - GAP_EPS && col.x1 > r.lo + GAP_EPS);
  const air = floodFill(columns, opts, (col, ivs) => (overlapsSeed(col) ? ivs.map((_, k) => k) : []));
  const ranges = [];
  columns.forEach((col, i) => { if (air[i].length > 0) ranges.push({ lo: col.x0, hi: col.x1 }); });
  return mergeLocalRanges(ranges);
}
