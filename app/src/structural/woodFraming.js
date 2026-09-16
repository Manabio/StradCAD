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
 * @returns {Array<{x:number, y:number, isVertical:boolean, coord:number, along:number, dist:number}>}
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
      out.push({ x: p.x, y: p.y, isVertical: s.isVertical, coord: s.coord, along, dist });
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
