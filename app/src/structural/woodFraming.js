// ================================================================
// 在来木造の部材寸法・割付の純関数（仕様: 2026-09-14 ユーザー確認。設計意図は .claude/structural-model.md）。
//
// 値（表・係数）は structureRules.js の TRADITIONAL_WOOD_FRAMING / TRADITIONAL_WOOD_BACKING が持ち、
// ここは「その値をどう適用するか」だけを持つ（core.js 非依存の純モジュール。node:test から単体で読める。
// core/constants.js は import 無しの純定数なので参照してよい＝beamAxisMove.js と同じ経路）。
// 生成（壁交点柱・壁下梁・頭つなぎ・床梁・火打ち梁）や描画（伏図の×／□・下地割付線）は次ステップ以降の
// 消費側が、これらを呼ぶ形で載せる。
// ================================================================
import { RoomFeature, CL_OVERLAP_TOL_MM } from '../core/constants.js';
import { WOOD_BEAM_DEPTH_TABLE, TRADITIONAL_WOOD_FRAMING, TRADITIONAL_WOOD_BACKING, rulesFor, TRADITIONAL_WOOD_STRUCTURE } from './structureRules.js';
import { woodRectSectionKey } from './sectionCatalog.js';

// 壁の端部の取り合い許容(mm)。壁の端は**取り合う壁の半厚（仕上げ込み）ぶん控えて生成される**
// （仕上げモードの壁生成。実機: x=0 の縦壁に突き当たる横壁は x=57.5 から始まる）ため、交点・T字・
// コーナーの判定では範囲をこの値だけ外へ広げる。壁厚の上限（RC壁200＋仕上げ）の半分を超える値にし、
// 材の半厚を個別に持ち回らない（壁の外周仕上げの有無で半厚が変わり、`materialRange` 由来の値では
// 控え量に届かない例が実機であった）。壁同士がこれ以上離れて終わる構成は「交わっていない」とみなす。
// 本体は woodAutoFill.js（壁交点柱・壁線通し梁）が主用途だが、woodColumnOffset.js（純モジュール。
// core.js非依存を保つため woodAutoFill.js を import できない）も同じ値で壁を同定するため、
// 依存の少ないこちらを真実のソースにし woodAutoFill.js は再exportする。
export const WALL_JUNCTION_TOL_MM = 150;

/**
 * 梁成（成D mm）を「支持する2点間距離」と「中間荷重の数」から梁成表で引く。
 * 距離は区分の上限以下で最初に当てはまる列（1820以下／2730以下／3640以下）。
 * 表の外（3640超・中間荷重4か所以上）は**表の最大側の値**を使う（ユーザー裁定2026-09-14:
 * 「表の最大値360を使う」＝既定120のまま過小断面が図に出るより、最大値を入れて auto のまま気付けるようにする）。
 * 中間荷重の数＝その梁に取りつく梁（受梁・床梁）＋その梁の上に立つ上階の柱の本数（同裁定）。
 * 非数・0以下の距離・負や非整数の荷重数は null（入力の誤り＝呼び出し側が扱う）。
 * @param {number} spanMm - 支持点間距離(mm)
 * @param {number} intermediateLoads - 中間荷重の数（0〜。3超は3扱い）
 * @param {typeof WOOD_BEAM_DEPTH_TABLE} [table]
 * @returns {number|null}
 */
export function woodBeamDepthMm(spanMm, intermediateLoads, table = WOOD_BEAM_DEPTH_TABLE) {
  if (!Number.isFinite(spanMm) || spanMm <= 0) return null;
  if (!Number.isInteger(intermediateLoads) || intermediateLoads < 0) return null;
  const found = table.spanLimitsMm.findIndex(limit => spanMm <= limit);
  const col = found < 0 ? table.spanLimitsMm.length - 1 : found;
  const row = table.depthsByLoads[Math.min(intermediateLoads, table.depthsByLoads.length - 1)];
  return row[col];
}

/**
 * 梁の断面キー（材幅＝柱同寸 × 成）。既に決まった成から断面キーを引く「成→断面」の判断をここ1か所に
 * 置く（woodBeamSectionKey・autoFillWoodBeamDepths＝ステップ3d が別式で組み直さないため）。
 * @param {number} depthMm - 梁成（成が引けない呼び出し元は先にnullで打ち切ること）
 * @param {number} columnWidthMm - その階の柱寸法（正角）
 * @returns {string|null} 例 'WOOD-120x240'。成・幅が非数/0以下・カタログに無い幅は null
 */
export function woodBeamSectionForDepth(depthMm, columnWidthMm) {
  if (depthMm == null || !Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  // 成が材幅より小さくなる組み合わせ（例: 柱120で成120未満）は無い（表の最小が120）ため、幅×max(成,幅)で引く。
  return woodRectSectionKey(columnWidthMm, Math.max(depthMm, columnWidthMm));
}

/**
 * 梁の断面キー（材幅＝柱同寸 × 梁成表の成）。「支持間距離と中間荷重から梁断面を決める」という
 * 呼び出し側の判断をここ1か所に置く（生成側が別式で組み直さないため）。
 * @param {number} spanMm
 * @param {number} intermediateLoads
 * @param {number} columnWidthMm - その階の柱寸法（正角）
 * @returns {string|null} 例 'WOOD-120x240'。梁成が引けない・カタログに無い幅は null
 */
export function woodBeamSectionKey(spanMm, intermediateLoads, columnWidthMm) {
  return woodBeamSectionForDepth(woodBeamDepthMm(spanMm, intermediateLoads), columnWidthMm);
}

// 支持点・荷重点の座標を許容誤差(tol)でまとめる（昇順ソート後、直前に残した点からtol未満なら同一点扱い）。
// woodBeamDepthForSpans が支持点・荷重点の両方に使う私的ヘルパ（呼び出し側で個別に丸めさせない）。
function dedupCoords(coords, tol) {
  const sorted = [...coords].sort((a, b) => a - b);
  const out = [];
  for (const c of sorted) {
    if (out.length === 0 || c - out[out.length - 1] >= tol) out.push(c);
  }
  return out;
}

/**
 * 梁1本の断面を「支持区間ごとの梁成表引きの最大値」で決める（ステップ3d）。支持点（両端＋中間の
 * 支持柱等）を昇順・tol以内でまとめ、隣り合う支持点2点ずつを区間とみなして各区間の距離と区間内部
 * （両端からtolを超えて内側）の荷重点数から `woodBeamDepthMm` で成を引き、区間の最大値を返す
 * （表は距離・荷重数とも単調のため、最大区間が最大の成を要求するとは限らず全区間を評価する）。
 * 荷重点も同じtolでまとめる（同位置の複数荷重源は表の「1か所」に集約）。
 * 支持点が2点未満（まとめた結果1点以下になる場合を含む）・非数混入・いずれかの区間で
 * `woodBeamDepthMm` がnullを返す（距離0以下・荷重数が不正）場合はnull。
 * @param {number[]} supportCoords - 支持点の座標(mm)
 * @param {number[]} loadCoords - 荷重点の座標(mm)
 * @param {number} [tol] - 座標の同一視許容誤差(mm)
 * @returns {number|null}
 */
export function woodBeamDepthForSpans(supportCoords, loadCoords, tol = CL_OVERLAP_TOL_MM) {
  if (!Array.isArray(supportCoords) || supportCoords.some(c => !Number.isFinite(c))) return null;
  if (!Array.isArray(loadCoords) || loadCoords.some(c => !Number.isFinite(c))) return null;
  const supports = dedupCoords(supportCoords, tol);
  if (supports.length < 2) return null;
  const loads = dedupCoords(loadCoords, tol);
  let maxDepth = null;
  for (let i = 0; i < supports.length - 1; i++) {
    const lo = supports[i], hi = supports[i + 1];
    const count = loads.filter(l => l > lo + tol && l < hi - tol).length;
    const depth = woodBeamDepthMm(hi - lo, count);
    if (depth == null) return null;
    if (maxDepth == null || depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

/**
 * 梁の端に取りつく他の梁（ends）から、十字貫通（同じ位置で両方向に相手梁が続く＝通過しているだけで
 * 荷重ではない）を除いた荷重点の座標を返す。ends は `{coord, dir}`（dir=符号。反対側の端に向かう
 * 符号で+1/−1を想定）の配列——同じcoord（tol以内）に+1と−1の両方があれば貫通とみなし除外、
 * 片側だけ（T字）なら1か所として残す。同じcoordにdirが重複しても1か所（Setで畳む）。
 * @param {Array<{coord:number, dir:number}>} ends
 * @param {number} [tol]
 * @returns {number[]} 貫通を除いた代表座標（グループの先頭値）
 */
export function crossingBeamLoadCoords(ends, tol = CL_OVERLAP_TOL_MM) {
  const groups = [];
  for (const e of ends) {
    let g = groups.find(g => Math.abs(g.coord - e.coord) < tol);
    if (!g) { g = { coord: e.coord, dirs: new Set() }; groups.push(g); }
    g.dirs.add(Math.sign(e.dir));
  }
  return groups.filter(g => !(g.dirs.has(1) && g.dirs.has(-1))).map(g => g.coord);
}

/**
 * 受梁（区間内部に自階柱があり、その真下に下階柱が無い梁。判定は呼び出し側＝woodAutoFill.jsが行い
 * isCarrierで渡す）の成を、その受梁の端が取りつく host 梁へ不動点まで伝播する（ステップ3c-3。裁定
 * 2026-09-14「受梁を受ける梁は受梁同寸」）。host の成 = max(host の成, 受梁の成)——伝播で成が
 * 上がった梁は、それ自身が受梁かどうかに関わらずさらにその host へ伝播する（荷重経路を辿る）。
 * 循環（A→B→A等）があっても、各ノードの成は入力に現れる値の中で単調に増えるだけなので有限回で
 * 不動点に達する（無限ループにはならないが、想定外の入力に備え反復回数の安全弁を持つ）。
 * 非数のdepth・idの無い要素は無視する。未知のhostId（同じidの要素がnodesに無い）も無視する
 * （例外を投げない）。
 * @param {Array<{id:string, depth:number, isCarrier:boolean, hostIds?:string[]}>} nodes
 * @returns {Map<string, number>} id -> 伝播後の成（入力のdepthのまま、または伝播で上がった値）
 */
export function propagateCarrierDepths(nodes) {
  const list = Array.isArray(nodes) ? nodes : [];
  const depthById = new Map();
  const hostsById = new Map();
  for (const n of list) {
    if (!n || n.id == null || !Number.isFinite(n.depth)) continue;
    depthById.set(n.id, n.depth);
    hostsById.set(n.id, Array.isArray(n.hostIds) ? n.hostIds : []);
  }
  const queue = list.filter(n => n && n.isCarrier && depthById.has(n.id)).map(n => n.id);
  const inQueue = new Set(queue);
  // 安全弁: 通常は単調増加＋入力値の有限集合により自然に停止するが、想定外の入力で反復が
  // 膨らまないよう上限を設ける（循環自体は正しく1回で収束するため、この上限に届くのは異常系のみ）。
  const maxSteps = depthById.size * depthById.size + depthById.size + 16;
  let steps = 0;
  while (queue.length > 0) {
    if (++steps > maxSteps) break;
    const id = queue.shift();
    inQueue.delete(id);
    const depth = depthById.get(id);
    for (const hostId of hostsById.get(id) ?? []) {
      if (!depthById.has(hostId)) continue; // 未知hostIdは無視
      if (depth > depthById.get(hostId)) {
        depthById.set(hostId, depth);
        if (!inQueue.has(hostId)) { queue.push(hostId); inQueue.add(hostId); }
      }
    }
  }
  return depthById;
}

/**
 * 壁の区間（下地帯や壁厚から求めた [lo,hi] 等）を、重なるか隙間が tol 以下のもの同士でまとめ、
 * 昇順の最大区間の配列にする（throughBeamRuns が「梁を架けられる連続区間」を判定する前段）。
 * 非数・hi<=lo の区間は捨てる。
 * @param {Array<{lo:number, hi:number}>} intervals
 * @param {number} [tol] - 連結を許す隙間の上限(mm)
 * @returns {Array<{lo:number, hi:number}>}
 */
export function mergeWallIntervals(intervals, tol = CL_OVERLAP_TOL_MM) {
  const valid = (intervals ?? [])
    .filter(iv => iv && Number.isFinite(iv.lo) && Number.isFinite(iv.hi) && iv.hi > iv.lo)
    .sort((a, b) => a.lo - b.lo);
  const out = [];
  for (const iv of valid) {
    const last = out[out.length - 1];
    if (last && iv.lo <= last.hi + tol) {
      last.hi = Math.max(last.hi, iv.hi);
    } else {
      out.push({ lo: iv.lo, hi: iv.hi });
    }
  }
  return out;
}

/**
 * 区間 target=[lo,hi] から、covering（同軸の生の区間群。マージ不要）で覆われた部分を差し引き、
 * 覆われていない残りの区間を返す（土台の候補源(b) 基礎梁スパンが候補源(a) 壁線through-runで
 * 覆われた分を除く用途。「1階の土台が同軸で重複」修正・2026-09-18裁定「通し（候補源a）を優先し、
 * 候補源(b) は候補源(a) の run の和集合で覆われた残りだけを候補にする」）。covering は内部で
 * mergeWallIntervals（同じtol）へ通してから引くため、隣接・重複する区間を渡してもよい。
 * 各返り値ピースには、その端が covering との境界で生じた「切断点」か（true）、target の元の端が
 * そのまま残っているか（false）かを loCut/hiCut で示す——呼び出し側（woodAutoFill.js）が
 * loCut/hiCut に応じて実CL（covering側の境界CL、または target 側の元の端点CL）のどちらを使うかを
 * 判定するために使う（本関数はCLを一切扱わない数値だけの純関数）。tol以下に縮む断片は捨てる。
 * target が不正（非数・hi<=lo）は[]。covering が空/nullは target をそのまま1ピース
 * （loCut:false, hiCut:false）で返す（差し引く物が無ければ全区間が残る）。
 * @param {{lo:number, hi:number}} target
 * @param {Array<{lo:number, hi:number}>} covering
 * @param {number} [tol]
 * @returns {Array<{lo:number, hi:number, loCut:boolean, hiCut:boolean}>}
 */
export function subtractCoveredSpan(target, covering, tol = CL_OVERLAP_TOL_MM) {
  if (!target || !Number.isFinite(target.lo) || !Number.isFinite(target.hi) || target.hi <= target.lo) return [];
  if (!covering || covering.length === 0) return [{ lo: target.lo, hi: target.hi, loCut: false, hiCut: false }];
  const merged = mergeWallIntervals(covering, tol);
  const pieces = [];
  let cursor = target.lo;
  let cursorCut = false;
  for (const cov of merged) {
    if (cov.hi <= cursor + tol) continue;   // targetのcursorより手前＝無関係
    if (cov.lo >= target.hi - tol) break;   // targetの終端より後ろ＝以降も無関係（mergedはlo昇順）
    const covLo = Math.max(cov.lo, target.lo);
    const covHi = Math.min(cov.hi, target.hi);
    if (covLo > cursor + tol) {
      pieces.push({ lo: cursor, hi: covLo, loCut: cursorCut, hiCut: true });
    }
    if (covHi > cursor) { cursor = covHi; cursorCut = true; }
  }
  if (target.hi - cursor > tol) {
    pieces.push({ lo: cursor, hi: target.hi, loCut: cursorCut, hiCut: false });
  }
  return pieces;
}

/**
 * 点群（例: 上階柱の(x,y)）を、下地帯（halfDepth）を持つ壁区間へスナップする（在来木造・上階柱直下の
 * 柱＝ステップ3bが使う）。点の法線方向座標が壁の下地帯の内側（|perp − s.coord| ≤ s.halfDepth）かつ
 * 走行方向が壁の範囲内（自由端の外は junctionTol まで許容）な**すべての**組合せを返す（1点が複数の
 * 壁区間に一致する場合は複数件。1件も一致しなければ0件）。**segments の並び順には依存しない**——
 * どの壁が「勝つ」かの決定（run に入るか等）は、run情報を持たない本関数の責務ではなく呼び出し側
 * （`woodAutoFill.js`の`autoFillWoodColumns`）が同じ(x,y)の複数件から決定的タイブレークで1件選ぶ
 * （QA F6・2026-09-16：旧実装は`segments`配列の最初の一致で`break`しており`graph.walls`の並び順に
 * 結果が依存する不具合だった）。dist＝|perp − s.coord|（タイブレークの判定材料として持ち帰る）。
 * 純関数（graph非依存）。
 * @param {Array<{x:number, y:number}>} points
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number, halfDepth:number}>} segments
 * @param {number} junctionTol - 壁の端部の取り合い許容(mm)
 * @returns {Array<{x:number, y:number, isVertical:boolean, coord:number, along:number, dist:number,
 *   lo:number, hi:number, seg:object}>} lo/hi は一致した壁区間そのもの（junctionTol抜きの生の範囲。
 *   woodColumnOffset.js が自動判定の走行方向サンプリング候補を区間内に限定するために使う）。
 *   seg は一致した元の segments 要素そのもの（参照。coord/lo/hi の値一致で再同定させない——
 *   QA指摘・2026-09-17: woodColumnOffset.js が bandOffset を読むために使う）。
 */
export function pointsOnWallLines(points, segments, junctionTol) {
  const out = [];
  for (const p of (points ?? [])) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    for (const s of (segments ?? [])) {
      const perp = s.isVertical ? p.x : p.y;
      const dist = Math.abs(perp - s.coord);
      if (dist > s.halfDepth) continue;
      const along = s.isVertical ? p.y : p.x;
      if (along < s.lo - junctionTol || along > s.hi + junctionTol) continue;
      out.push({ x: p.x, y: p.y, isVertical: s.isVertical, coord: s.coord, along, dist, lo: s.lo, hi: s.hi, seg: s });
    }
  }
  return out;
}

/**
 * 壁線上の通し梁の支持区間（run＝分割前の最大区間。壁が途切れず続く連続区間を両端で1本にまとめる。
 * 端は壁の交点＝自由端へは伸ばさない。区間内部の下階柱による分割は columnSplitPoints が別に行う——
 * 「壁が途切れているか」と「下階柱で区切るか」は別の判定軸のため、本関数は前者だけを持つ）。
 * points（線上の端点候補座標。重複・未ソート可）を昇順・tol未満は同一点としてdedupし、隣り合う2点の
 * ペアが mergedIntervals（mergeWallIntervals の結果を想定）のいずれか1つに収まる＝壁が途切れず
 * 続いているかを判定、覆われたペアが連続する最大の並びを1本の [lo,hi] にまとめる。壁が途中で
 * 切れている点（被覆区間の外）は端にできない。点が2点未満・非数混入・被覆ペアが無ければ空配列。
 * @param {number[]} points
 * @param {Array<{lo:number, hi:number}>} mergedIntervals
 * @param {number} [tol]
 * @returns {Array<{lo:number, hi:number}>}
 */
export function throughBeamRuns(points, mergedIntervals, tol = CL_OVERLAP_TOL_MM) {
  if (!Array.isArray(points) || points.some(p => !Number.isFinite(p))) return [];
  const pts = dedupCoords(points, tol);
  if (pts.length < 2) return [];
  const covered = (a, b) => (mergedIntervals ?? []).some(iv => iv.lo <= a + tol && iv.hi >= b - tol);
  const out = [];
  let runStart = null;
  for (let i = 0; i < pts.length - 1; i++) {
    if (covered(pts[i], pts[i + 1])) {
      if (runStart == null) runStart = pts[i];
    } else {
      if (runStart != null) out.push({ lo: runStart, hi: pts[i] });
      runStart = null;
    }
  }
  if (runStart != null) out.push({ lo: runStart, hi: pts[pts.length - 1] });
  return out;
}

/**
 * 壁線の通し区間run（throughBeamRuns の結果1件、{lo,hi}）を、区間内部の下階柱の位置で分割する
 * （ユーザー裁定2026-09-16「梁は下階柱（面）から下階柱（面）で区切られる材ごとに区別する」。
 * ステップ3c-2b）。分割点＝columnPoints のうち、法線方向座標（isVertical?柱x:柱y）がaxisCoordに
 * tol以内で一致し、走行方向座標（isVertical?柱y:柱x）がrunの**厳密に内側**（run.lo+tol < along <
 * run.hi-tol。両端に一致する柱は既存の端点そのもので分割点ではない）にあるもの。
 * 【不変条件】axisCoordはaxisCL.effectiveValue（＝beam.axisValue）、tolはCL_OVERLAP_TOL_MMを渡すこと
 * ——woodAutoFill.js の alongCoordOnAxis（3d・支持点判定）と同じ述語にすることで、「3cが切る位置」＝
 * 「3dが支持点として数える位置」を一致させる（3cが切らない下階柱を3dが支持点に数える、またはその逆の
 * 食い違いを起こさない）。role（'foundation'＝杭を候補から外す等）の絞り込みは呼び出し側の責務
 * （woodAutoFill.js の3b・3dと同じ規律。ここではrole自体を見ない）。
 * 近接点（tol未満）は同一点としてdedupCoords（他関数と共通のヘルパ）でまとめる。
 * 分割点0件・columnPoints省略/空はrun両端のみ（[lo,hi]。分割しない従来どおりの結果）。
 * run不正（非数・hi<=lo）・axisCoord非数は空配列（呼び出し側がrunを丸ごとスキップする合図）。
 * @param {{lo:number, hi:number}} run
 * @param {number} axisCoord - 梁が乗る通り芯／梁芯の座標（法線方向。axisCL.effectiveValue）
 * @param {boolean} isVertical
 * @param {Array<{x:number, y:number}>} columnPoints - 下階柱（role絞り込みは呼び出し側）
 * @param {number} [tol]
 * @returns {number[]} 昇順の端点列 [lo, ...内部の分割点, hi]
 */
export function columnSplitPoints(run, axisCoord, isVertical, columnPoints, tol = CL_OVERLAP_TOL_MM) {
  if (!run || !Number.isFinite(run.lo) || !Number.isFinite(run.hi) || run.hi <= run.lo) return [];
  if (!Number.isFinite(axisCoord)) return [];
  const interior = (columnPoints ?? [])
    .filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .filter(p => Math.abs((isVertical ? p.x : p.y) - axisCoord) < tol)
    .map(p => (isVertical ? p.y : p.x))
    .filter(v => v > run.lo + tol && v < run.hi - tol);
  return dedupCoords([run.lo, ...interior, run.hi], tol);
}

/**
 * 柱（下階柱＝頭つなぎ／自階柱＝受梁）の直上・直下に、両端が支持された梁を新設・延長するための候補区間を
 * 求める（ステップ3h。ユーザー裁定「下階柱／自階柱を中心に水平・垂直のうち、隣の梁までの総長が短い
 * いずれかの方向へ両端を固定した梁を延長、または生成する」）。
 * 点 P（柱のAXIS座標。偏心を含めない）ごとに、水平・垂直の両方向で「Pを通り、隣接する直交の既存梁2本
 * （segments）に支持される区間」を求め、両方向とも候補になれば総長（支持点間距離）が短い方を採用する。
 * 同長は横梁（isVertical:false）を優先する（floorBeamIsVertical・beamJunctionと同じタイブレーク）。
 *  - **no-opの判定（指摘B・2026-09-18）**: Pが既存梁区間の**内部**（両端からtol超）にあれば無条件no-op。
 *    Pが既存梁の**端**に一致する場合は、その点が「支持されている」ときだけno-op——支持＝
 *    supportPoints（下階柱のAXIS点列）にPと一致する点があるか、Pが**別の**既存梁区間の内部でもある
 *    （T字）。後者はinterior判定（全segments横断）に既に含まれるため、実質「端点一致＋supportPoints
 *    一致」だけを追加条件として見ればよい。**端点一致だが無支持**（L字の自由コーナー・単独の梁端）は
 *    従来の「無条件no-op」から外れ、候補評価へ進む——これが延長・新設のトリガーになる。
 *    kind:'below'の点はsupportPoints自身の由来（呼び出し側がbelowPtsをそのまま渡す）なので、端点一致
 *    すれば必ず支持済み＝従来どおりno-op（挙動不変）。
 *  - ある方向（isVertical）の支持＝直交する（isVertical!==方向）既存梁区間で、Pの法線座標
 *    （方向がisVertical=trueならP.x、falseならP.y）を[lo−tol, hi+tol]で覆うもの。その区間のcoordが
 *    「支持座標」——along方向（isVertical=trueならP.y、falseならP.x）で見て、along−tol未満の最大の
 *    支持座標(loA)とalong+tol超の最小の支持座標(hiA)の間[loA,hiA]がその方向の候補区間になる
 *    （**総長＝hiA−loAは以後の重なりトリムに関わらず不変**——方向選択の基準はこの「隣の梁までの
 *    総長」のまま）。**片側にしか支持が無い方向は候補外**。
 *  - **延長（指摘B）**: 候補区間[loA,hiA]が同軸（同isVertical・同coord）の既存梁区間と重なる場合、
 *    候補外にはせず、Pを含む側の残り区間へトリムする（Pの along は既存区間の内部には無い——interior
 *    判定で既に除外済みのため、along が既存区間の lo 側・hi 側のどちらか片方にしか無いことが保証
 *    される）。along が既存区間より小さい側なら hi をその既存区間の lo まで縮め
 *    （`extendsHiSeg`にその既存区間を記録）、大きい側なら lo をその既存区間の hi まで縮める
 *    （`extendsLoSeg`）。複数の既存区間が重なる場合はPに最も近い（along側に一番寄っている）ものを
 *    使う。トリム後の残りが tol 以下なら候補外（延長する意味の無い長さ）。
 *  - 両方向とも候補外なら点自体をスキップする（例外を投げない）。
 * 出力の loSeg/hiSeg は支持区間（segmentsの要素）そのものの参照（呼び出し側が端点CL等を逆引きするため。
 * 座標から再同定させない——QA2026-09-17と同じ規律）。extendsLoSeg/extendsHiSegも同様に参照そのもの
 * （非nullの側は呼び出し側がloSeg/hiSegの代わりにそちらの端点CLを使う——延長先は新しいCLを作らず
 * 既存梁の端点そのものへ接続するため）。(isVertical,coord,lo,hi)をtol丸めしたキーでdedupeし、
 * isVertical(false優先)→coord→lo→hiの順で決定的にソートする。純関数（graph非依存）。
 * **同一区間が下階柱・自階柱の両方から到達可能な場合は、pointsの並び順で先に処理された方のkindが勝つ**
 * （dedupeがseen集合への先着で決まるため）——呼び出し側（woodAutoFill.js）はbelowTiePtsをselfCarrierPtsより
 * 前に並べており、これにより頭つなぎ（below）が受梁（self）より優先される（m10）。
 * @param {Array<{x:number, y:number, kind:'below'|'self'}>} points
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} segments - 既存梁の区間
 *   （縦横混在。呼び出し側が「このパスで確定した壁線通し梁の候補区間＋手動固定の同材種梁」等、
 *   冪等性を保つ集合を渡す。追加フィールド（axisCL等）があっても無視して素通しする）
 * @param {Array<{x:number, y:number}>} [supportPoints] - 下階柱のAXIS点列（無支持の端点一致＝L字
 *   自由コーナーかどうかの判定に使う。省略時は「支持なし」＝端点一致は常に候補評価へ進む）
 * @param {number} [tol]
 * @returns {Array<{isVertical:boolean, coord:number, lo:number, hi:number, kind:'below'|'self',
 *   loSeg:object, hiSeg:object, extendsLoSeg:object|null, extendsHiSeg:object|null}>}
 */
export function columnSupportBeamCandidates(points, segments, supportPoints = [], tol = CL_OVERLAP_TOL_MM) {
  const segs = (segments ?? []).filter(s => s && Number.isFinite(s.coord) && Number.isFinite(s.lo) && Number.isFinite(s.hi));
  const supports = (supportPoints ?? []).filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const results = [];
  const seen = new Set();
  for (const p of (points ?? [])) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;

    // Pが既存梁区間の内部（両端からtol超。縦横問わず）にあれば無条件no-op。
    const interior = segs.some(s => s.isVertical
      ? Math.abs(p.x - s.coord) < tol && p.y > s.lo + tol && p.y < s.hi - tol
      : Math.abs(p.y - s.coord) < tol && p.x > s.lo + tol && p.x < s.hi - tol);
    if (interior) continue;

    // Pが既存梁区間の端に一致（縦横問わず）し、かつ支持済み（supportPointsに一致点がある）ならno-op。
    // 端点一致だが無支持（L字自由コーナー・単独の梁端）は候補評価へ進む。
    const atEndpoint = segs.some(s => s.isVertical
      ? Math.abs(p.x - s.coord) < tol && (Math.abs(p.y - s.lo) < tol || Math.abs(p.y - s.hi) < tol)
      : Math.abs(p.y - s.coord) < tol && (Math.abs(p.x - s.lo) < tol || Math.abs(p.x - s.hi) < tol));
    if (atEndpoint && supports.some(sp => Math.abs(sp.x - p.x) < tol && Math.abs(sp.y - p.y) < tol)) continue;

    const dirs = [];
    for (const isVertical of [true, false]) {
      const coord = isVertical ? p.x : p.y;
      const along = isVertical ? p.y : p.x;
      const perp = segs.filter(s => s.isVertical === !isVertical && s.lo - tol <= coord && coord <= s.hi + tol);
      const loCands = perp.filter(s => s.coord < along - tol);
      const hiCands = perp.filter(s => s.coord > along + tol);
      if (loCands.length === 0 || hiCands.length === 0) continue; // 片側しか支持が無い方向は候補外
      const loSeg = loCands.reduce((a, b) => (b.coord > a.coord ? b : a));
      const hiSeg = hiCands.reduce((a, b) => (b.coord < a.coord ? b : a));
      const fullLo = loSeg.coord, fullHi = hiSeg.coord;

      // 同軸（同isVertical・同coord）の既存梁区間との重なりをPを含む側へトリムする（延長。指摘B）。
      // interior判定で既にPがどの同軸区間の内部にも無いことが保証されているため、重なる既存区間は
      // 必ず along の片側（lo側 or hi側）に完全に収まる。
      let lo = fullLo, hi = fullHi, extendsLoSeg = null, extendsHiSeg = null;
      const before = segs.filter(s => s.isVertical === isVertical && Math.abs(s.coord - coord) < tol
        && s.hi <= along + tol && s.hi > lo + tol);
      const after = segs.filter(s => s.isVertical === isVertical && Math.abs(s.coord - coord) < tol
        && s.lo >= along - tol && s.lo < hi - tol);
      if (before.length > 0) {
        extendsLoSeg = before.reduce((a, b) => (b.hi > a.hi ? b : a)); // alongに最も近い（hiが最大）ものを使う
        lo = extendsLoSeg.hi;
      }
      if (after.length > 0) {
        extendsHiSeg = after.reduce((a, b) => (b.lo < a.lo ? b : a)); // alongに最も近い（loが最小）ものを使う
        hi = extendsHiSeg.lo;
      }
      if (hi - lo <= tol) continue; // 延長後の残りが無い（意味の無い長さ）は候補外
      dirs.push({ isVertical, coord, lo, hi, kind: p.kind, loSeg, hiSeg, extendsLoSeg, extendsHiSeg, length: fullHi - fullLo });
    }
    if (dirs.length === 0) continue; // 両方向とも候補外
    // 総長（延長前の[loA,hiA]全長。支持点間距離）が短い方向を採用。同長は横梁(isVertical:false)を優先。
    dirs.sort((a, b) => a.length - b.length || (a.isVertical === b.isVertical ? 0 : (a.isVertical ? 1 : -1)));
    const best = dirs[0];
    // dedupeキーの丸め粒度は比較tolに合わせる（m8）——固定1mm丸めだと、tol以内で「同じ」と判定される
    // 値でも丸め境界をまたぐと別キーになり重複が漏れることがある。
    const key = `${best.isVertical}:${Math.round(best.coord / tol)}:${Math.round(best.lo / tol)}:${Math.round(best.hi / tol)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      isVertical: best.isVertical, coord: best.coord, lo: best.lo, hi: best.hi, kind: best.kind,
      loSeg: best.loSeg, hiSeg: best.hiSeg, extendsLoSeg: best.extendsLoSeg, extendsHiSeg: best.extendsHiSeg,
    });
  }
  results.sort((a, b) => (a.isVertical === b.isVertical ? 0 : (a.isVertical ? 1 : -1)) || a.coord - b.coord || a.lo - b.lo || a.hi - b.hi);
  return results;
}

/**
 * 上階の頭つなぎ・受梁（beamSegments。ステップ3h）を「壁線とみなして」下階の壁（wallSegments）と
 * 交わる位置を列挙する（ステップ3h-2。柱は壁の中にしか立たないため、この点が下階の柱候補になる）。
 *  - 直交交点＝梁のcoord（法線座標）が壁の走行範囲[lo−tol, hi+tol]内、かつ壁のcoordが梁の走行範囲
 *    [lo−tol, hi+tol]内の組合せ。
 *  - 加えて、**同軸（平行・同coord）で梁の端（lo/hi）が壁の走行範囲内にある点**も含める（梁が下階壁の
 *    上に載って終わる＝端部に柱が要る）。
 * 重複（mm丸め）はdedupeし、x→yの順で決定的にソートする。純関数（graph非依存。失敗系は例外を
 * 投げず無視する）。
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} beamSegments
 * @param {Array<{isVertical:boolean, coord:number, lo:number, hi:number}>} wallSegments
 * @param {number} [tol]
 * @returns {Array<{x:number, y:number}>}
 */
export function beamWallCrossPoints(beamSegments, wallSegments, tol = CL_OVERLAP_TOL_MM) {
  const beams = (beamSegments ?? []).filter(s => s && Number.isFinite(s.coord) && Number.isFinite(s.lo) && Number.isFinite(s.hi));
  const walls = (wallSegments ?? []).filter(s => s && Number.isFinite(s.coord) && Number.isFinite(s.lo) && Number.isFinite(s.hi));
  const seen = new Set();
  const points = [];
  const push = (x, y) => {
    // dedupeキーの丸め粒度は比較tolに合わせる（m8。columnSupportBeamCandidatesと同じ規律）。
    const key = `${Math.round(x / tol)}:${Math.round(y / tol)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push({ x, y });
  };
  for (const beam of beams) {
    for (const wall of walls) {
      if (beam.isVertical !== wall.isVertical) {
        // 直交交点: 梁の位置が壁の範囲内、かつ壁の位置が梁の範囲内。
        if (beam.coord < wall.lo - tol || beam.coord > wall.hi + tol) continue;
        if (wall.coord < beam.lo - tol || wall.coord > beam.hi + tol) continue;
        push(beam.isVertical ? beam.coord : wall.coord, beam.isVertical ? wall.coord : beam.coord);
      } else if (Math.abs(beam.coord - wall.coord) < tol) {
        // 同軸: 梁端が壁の走行範囲内にあれば、その端点（梁が壁上に載って終わる点）。
        // ここのtol一致は3b（pointsOnWallLinesのhalfDepth＝壁下地帯半幅）より厳しい——梁軸と壁軸が
        // 帯の中心からtolを超えてずれている同軸ケースを拾い漏らすが、拾い漏らしは「柱が立たない」
        // 安全側（m7・過剰生成にはならない）。

        for (const end of [beam.lo, beam.hi]) {
          if (end < wall.lo - tol || end > wall.hi + tol) continue;
          push(beam.isVertical ? beam.coord : end, beam.isVertical ? end : beam.coord);
        }
      }
    }
  }
  return points.sort((a, b) => a.x - b.x || a.y - b.y);
}

/**
 * 壁下地材（縦下地）の割付位置＝**材の中心**のA端からの距離 mm（昇順）。
 * 仕様「A,B間を割り付ける場合、AB間の両端に (AB間距離 − (AB間距離/455の商 − 1)×455) / 2 をとり、
 * 残りを455で割付」——両端の余りを等分し、内側を等ピッチにする。
 * 商が1以下（距離 < 2ピッチ）は中央に1本、距離がピッチ未満でも中央1本（0本にはしない。
 * 仕様の式が未定義な領域の解釈＝ASSUMED。.claude/structural-model.md に記録）。
 * 距離0以下・非数・ピッチ0以下は空配列。
 * @param {number} lengthMm - AB間距離
 * @param {number} [pitchMm] - 割付ピッチ（既定455。外壁は仕上げモードの「縦下地間隔」で変更可）
 * @returns {number[]} 材の中心位置（A端からの距離）
 */
export function studPositions(lengthMm, pitchMm = TRADITIONAL_WOOD_BACKING.studPitchMm) {
  if (!Number.isFinite(lengthMm) || lengthMm <= 0 || !Number.isFinite(pitchMm) || pitchMm <= 0) return [];
  const q = Math.floor(lengthMm / pitchMm);
  const n = Math.max(0, q - 1); // 内側のピッチ数
  const end = (lengthMm - n * pitchMm) / 2;
  const out = [];
  for (let i = 0; i <= n; i++) out.push(end + i * pitchMm);
  return out;
}

/**
 * 壁の下地区間 [lo,hi] を、その壁上に立つ柱の区間（長さ方向の [lo,hi]。順不同・重複可）で「面」に分ける。
 * 面＝柱と柱の間（2点間）。区間の端が柱で終わらない（開口の縁・自由端）面は columnAtLo/Hi が false。
 * 柱の端が区間の端に接している（柱面まで下地帯が正規化されている）場合も「柱で終わる」と扱う。
 * 区間の外にある柱・幅0以下の面は出さない。純関数。
 * @param {number} lo
 * @param {number} hi
 * @param {Array<[number,number]>} columnIntervals
 * @returns {Array<{lo:number, hi:number, columnAtLo:boolean, columnAtHi:boolean}>}
 */
export function wallRunFaces(lo, hi, columnIntervals) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const columns = (columnIntervals ?? [])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a && b >= lo && a <= hi)
    .sort((a, b) => a[0] - b[0]);
  const faces = [];
  let cur = lo, columnAtLo = false;
  for (const [a, b] of columns) {
    if (a > cur) faces.push({ lo: cur, hi: a, columnAtLo, columnAtHi: true });
    cur = Math.max(cur, b);
    columnAtLo = true;
  }
  if (hi > cur) faces.push({ lo: cur, hi, columnAtLo, columnAtHi: false });
  return faces;
}

/**
 * 1面（柱と柱の間）の壁下地材の中心位置＝面の始端からの距離 mm（昇順）。
 *  - 柱で終わる端には、柱面から clearanceMm を空けて端部材を立てる（中心＝clearance＋材厚/2）。
 *  - 面の全長（2点間距離）を studPositions で割り付け、端部材や面の外にかかる材は落とす
 *    （材の区間 [中心±材厚/2] が空き区間に収まるものだけ。距離が短い面は端部材だけ・0本になる）。
 * 非数・0以下の長さ・材厚0以下は空配列。
 * @param {number} lengthMm - 面の長さ（柱面〜柱面。柱で終わらない端は区間の端まで）
 * @param {{columnAtLo?:boolean, columnAtHi?:boolean}} ends - 両端が柱で終わるか
 * @param {{pitchMm?:number, depthMm?:number, clearanceMm?:number}} [spec]
 *   pitchMm: 割付ピッチ（既定 studPitchMm=455）／depthMm: 材の長さ方向の厚み（既定 studDepthMm=30）／
 *   clearanceMm: 柱面からのクリアランス（既定 studColumnClearanceMm=10）
 * @returns {number[]}
 */
export function faceStudPositions(lengthMm, { columnAtLo = false, columnAtHi = false } = {}, {
  pitchMm = TRADITIONAL_WOOD_BACKING.studPitchMm,
  depthMm = TRADITIONAL_WOOD_BACKING.studDepthMm,
  clearanceMm = TRADITIONAL_WOOD_BACKING.studColumnClearanceMm,
} = {}) {
  if (!Number.isFinite(lengthMm) || lengthMm <= 0 || !Number.isFinite(depthMm) || depthMm <= 0) return [];
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) return [];
  const half = depthMm / 2;
  const out = [];
  // 端部材。空き区間 [freeLo, freeHi] は端部材（無ければ面の端）の内側。
  let freeLo = 0, freeHi = lengthMm;
  if (columnAtLo && clearanceMm + depthMm <= lengthMm) { out.push(clearanceMm + half); freeLo = clearanceMm + depthMm; }
  if (columnAtHi && lengthMm - clearanceMm - depthMm >= freeLo) { out.push(lengthMm - clearanceMm - half); freeHi = lengthMm - clearanceMm - depthMm; }
  for (const p of studPositions(lengthMm, pitchMm)) {
    if (p - half >= freeLo && p + half <= freeHi) out.push(p);
  }
  return out.sort((a, b) => a - b);
}

/**
 * 壁下地材（縦下地）の断面＝柱寸×30（幅＝柱寸、見込み＝30）。
 * @param {number} columnWidthMm
 * @param {typeof TRADITIONAL_WOOD_BACKING} [backing]
 * @returns {{width:number, depth:number}|null} 非数・0以下は null
 */
export function studSpec(columnWidthMm, backing = TRADITIONAL_WOOD_BACKING) {
  if (!Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  return { width: columnWidthMm, depth: backing.studDepthMm };
}

/**
 * 外壁アルミ製の窓／扉の両袖に立てる材の断面（幅×見込み）とクリアランス。
 * 窓＝柱寸×45、扉＝柱と同寸。どちらも左右クリアランス5mm。
 * @param {'window'|'door'} kind
 * @param {number} columnWidthMm - その階の柱寸法（正角）
 * @param {typeof TRADITIONAL_WOOD_BACKING} [backing]
 * @returns {{width:number, depth:number, clearanceMm:number}|null} 不明な種別・非数は null
 */
export function openingJambSpec(kind, columnWidthMm, backing = TRADITIONAL_WOOD_BACKING) {
  if (!Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  if (kind === 'window') return { width: columnWidthMm, depth: backing.windowJambDepthMm, clearanceMm: backing.jambClearanceMm };
  if (kind === 'door')   return { width: columnWidthMm, depth: backing.doorJambDepthMm ?? columnWidthMm, clearanceMm: backing.jambClearanceMm };
  return null;
}

/**
 * 建具の袖柱1本の走行方向座標(mm)。開口の外形 [lo,hi]（走行方向。Opening.coord1/coord2）から、
 * side<0（lo側）はlo−(clearanceMm+columnWidthMm/2)、side>0（hi側）はhi+(clearanceMm+columnWidthMm/2)
 * ——柱面と開口の間にclearanceMmぶんの空きをとる（仕様2026-09-18「両袖には、5mmずつクリアランスを
 * とって柱を建てる」）。core/structuralEntities.js（袖柱のAXIS導出）とjambColumnPositions（下記。
 * woodAutoFill.jsの候補列挙）の両方から呼ばれる単一の式——同じ位置の定義を二重実装しない。
 * 非数・lo>=hi・柱寸/クリアランス不正はnull。
 * @param {-1|1} side
 * @param {number} lo - 開口の走行方向外形の低座標側（Opening.coord1）
 * @param {number} hi - 開口の走行方向外形の高座標側（Opening.coord2）
 * @param {number} columnWidthMm - その階の柱寸法（正角）
 * @param {number} [clearanceMm] - 既定は在来ルールの jambClearanceMm(5)
 * @returns {number|null}
 */
export function jambAxisValue(side, lo, hi, columnWidthMm, clearanceMm = TRADITIONAL_WOOD_BACKING.jambClearanceMm) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  if (!Number.isFinite(columnWidthMm) || columnWidthMm <= 0) return null;
  if (!Number.isFinite(clearanceMm) || clearanceMm < 0) return null;
  const off = clearanceMm + columnWidthMm / 2;
  return side < 0 ? lo - off : hi + off;
}

/**
 * 建具ごとの両袖柱の走行方向座標の候補（jambAxisValueをside=-1,+1の両方に適用したもの）。
 * 呼び出し側（woodAutoFill.js autoFillWoodColumns）が法線方向のアンカー解決・重なり判定を行う。
 * 不正な開口（lo/hi非数・id無し）は静かにスキップする（例外を投げない）。
 * @param {Array<{id:string, lo:number, hi:number}>} openings - 走行方向の外形（lo=coord1, hi=coord2）
 * @param {number} columnWidthMm
 * @param {number} [clearanceMm]
 * @returns {Array<{id:string, side:-1|1, jamb:number}>}
 */
export function jambColumnPositions(openings, columnWidthMm, clearanceMm = TRADITIONAL_WOOD_BACKING.jambClearanceMm) {
  const out = [];
  for (const o of (openings ?? [])) {
    if (!o || o.id == null) continue;
    for (const side of [-1, 1]) {
      const jamb = jambAxisValue(side, o.lo, o.hi, columnWidthMm, clearanceMm);
      if (jamb != null) out.push({ id: o.id, side, jamb });
    }
  }
  return out;
}

/**
 * 矩形2つが重なるか（軸並行の外接矩形。AABB）。辺が接するだけ（重なり幅・高さが0）は重なりなし。
 * 建具の袖柱が候補柱・既存柱の断面矩形と重なる場合に生成を省略する判定に使う
 * （finish/columnWrap.js bareColumnRect と同じ {xLo,xHi,yLo,yHi} 形状の矩形を渡すこと）。
 * openings/openingTagPlacement.js の aabbIntersects と同じ述語（AABB交差）だが、矩形の
 * フィールド名・形状が異なる（{x1,x2,y1,y2}対{xLo,xHi,yLo,yHi}）ため共通化せず別実装にしている。
 * @param {{xLo:number, xHi:number, yLo:number, yHi:number}} a
 * @param {{xLo:number, xHi:number, yLo:number, yHi:number}} b
 * @param {number} [tol] - 重なり許容(mm)。正の値にするとtol以下のわずかな重なりは無視する
 * @returns {boolean}
 */
export function rectsOverlap(a, b, tol = 0) {
  return a.xLo < b.xHi - tol && a.xHi > b.xLo + tol && a.yLo < b.yHi - tol && a.yHi > b.yLo + tol;
}

/**
 * 玄関建具部分（1FL以下に設置する建具＝ユーザー裁定2026-09-14）の基礎・両袖取付柱の開口幅
 * ＝扉幅＋両端クリアランス。
 * @param {number} doorWidthMm
 * @param {number} [clearanceMm] - 既定は在来ルールの entranceClearanceMm(5)
 * @returns {number|null} 非数・0以下は null
 */
export function entranceOpeningWidthMm(doorWidthMm, clearanceMm = rulesFor(TRADITIONAL_WOOD_STRUCTURE).foundation.entranceClearanceMm) {
  if (!Number.isFinite(doorWidthMm) || doorWidthMm <= 0 || !Number.isFinite(clearanceMm) || clearanceMm < 0) return null;
  return doorWidthMm + 2 * clearanceMm;
}

/**
 * 土台（role:'sill'）の天端レベルオフセット(mm)。仕様「土台：1階の1FL-100に天端を合わせた、柱同寸の
 * 横材」——梁天端（framing.beamTopBelowFLMm。梁天端はFL−100）と同じ値を共有し、土台専用の定数は
 * 持たない（beamTopBelowFLMmの初の本番消費者）。levelOffset は StructuralBeam の一般フィールドで
 * 「天端がFLからこの符号付き値だけ下がる」規約のため、-beamTopBelowFLMm を返す。
 * @param {{beamTopBelowFLMm:number}|null} [framing] - 非在来（framingを持たない主構造）はnull
 * @returns {number|null} framing未設定・beamTopBelowFLMmが非数なら null
 */
export function sillTopLevelOffsetMm(framing = TRADITIONAL_WOOD_FRAMING) {
  if (!framing || !Number.isFinite(framing.beamTopBelowFLMm)) return null;
  return -framing.beamTopBelowFLMm;
}

/**
 * 火打ち梁を設けられる四角か（16㎡以下の四角の4隅。吹抜け（VOID）は可、階段（STAIR・階段吹抜け STAIR_VOID）内は不可）。
 * 「EV」（仕上げモードで指定＝吹抜け扱い・EV側に部屋仕上げ材なし）は本リポにまだ表現が無く、
 * 表現方法の裁定後に不可条件へ加える。削除済み部屋（UNDEFINED＝外壁線維持のための残置）は床が
 * 無いものとして不可（ASSUMED）。
 * @param {{areaM2:number, isRectangle:boolean, feature?:string|null}|null|undefined} cell
 *   feature: RoomFeature の値（null/undefined＝通常の床）。
 * @param {number} [maxAreaM2] - 既定は在来ルールの hipBraceMaxAreaM2(16)
 * @returns {boolean} 入力が無い・不正なら false（例外を投げない）
 */
export function hipBraceAllowed(cell, maxAreaM2 = TRADITIONAL_WOOD_FRAMING.hipBraceMaxAreaM2) {
  if (!cell) return false;
  const { areaM2, isRectangle, feature = null } = cell;
  if (!isRectangle) return false;
  if (!Number.isFinite(areaM2) || areaM2 <= 0 || areaM2 > maxAreaM2) return false;
  if (feature === RoomFeature.STAIR || feature === RoomFeature.STAIR_VOID || feature === RoomFeature.UNDEFINED) return false;
  return true;
}
