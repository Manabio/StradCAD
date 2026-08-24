/**
 * 2.5D断面エンジン: emitColumns / emitOpenGapMarks（線種テーブル・アキX連結・最終降格。WP-E2）。
 * 設計意図はarchitect承認済みの実装指示書§5.6参照。WP-E5bでelevationStairSequence.js
 * （直接。stairPrimitivesForCut内のemitLine経由でも）から呼ばれるようになった。
 *
 * §5.6「線種テーブル」の唯一の情報源。破線は必ずlineプリミティブで出す
 * （レンダラのpolyline分岐はdash非対応。.claude/elevation-model.md）。
 */
import { ElevationLineRole, weightForRole, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { zToY } from './sectionTypes.js';

/**
 * §5.6最終フィルタの唯一の適用箇所（emitLine(x1,z1,x2,z2,role)の1箇所だけで適用する、という
 * 設計方針どおり）。線分の両端がともに「baseFloorZより下」または「天井断面より上」（向こう側）
 * なら、role・dashに関わらずDETAIL+dash:'dashed'へ降格する。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} x1
 * @param {number} z1
 * @param {number} x2
 * @param {number} z2
 * @param {string} role - ElevationLineRoleの値
 * @param {{dash?:string, ceilZ?:number, neverDowngrade?:boolean}} [opts] - ceilZ未指定は
 *   cut.zRange.hiZへフォールバック（§5.6「天井断面」＝この列で見えている天井——通常はzRange
 *   上端と一致するため、これを既定にする）。neverDowngrade:true（実機フィードバック第3弾C。
 *   リード裁定で契約変更を承認済み）は本関数のbeyond/forceDash判定を丸ごと無効化し、
 *   渡されたrole・dashをそのまま使う——CUT断面（ささら12×300矩形・踊り場床CUT線・踊り場桁断面）
 *   はbaseFloorZより下でも太線実線のまま、ささらの見えがかり帯（DETAIL）は同じくbaseFloorZより
 *   下でも細線実線のまま、という「降格が残るのは踏面梯子(正面視)と壁断面の見えがかりだけ」という
 *   線種裁定を呼び出し側（sectionStair.js）から明示的に選択できるようにするフラグ
 *   （既定false＝既存呼び出しは無変更）。
 * @returns {object} lineプリミティブ（y=zToY(z)変換済み）
 */
export function emitLine(cut, x1, z1, x2, z2, role, opts = {}) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const ceilZ = opts.ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  // 水平線（z1===z2。床線・天井線・段の踏面線等の大半）は「ちょうどbaseFloorZ／ceilZに触れる」
  // だけでは向こう側と判定しない（strict <・>）——通常の床線(z=baseFloorZそのもの)を誤って
  // 降格しないため（WP-E5b回帰: 元は両端の緩い判定(<=)にしていたところ、床z=baseFloorZの
  // 通常の水平線まで「向こう側」扱いされてしまった）。垂直線・斜め線（z1!==z2）は、
  // sectionProbe.jsがcut.baseFloorZをzBreaksに割り込ませるため片端がbaseFloorZちょうどに
  // 一致するのが通常のケースになる——「ちょうど境界」を含めて向こう側とみなす（Math.max/minの
  // 緩い判定）。水平線側で「band全体がbaseFloorZ以下」を降格させたい場合はopts.forceDashで
  // 明示する（emitColumns参照）。
  const isDegenerate = Math.abs(z1 - z2) < GAP_EPS;
  const beyond = isDegenerate
    ? (z1 < baseFloorZ - GAP_EPS || z1 > ceilZ + GAP_EPS)
    : (Math.max(z1, z2) <= baseFloorZ + GAP_EPS || Math.min(z1, z2) >= ceilZ - GAP_EPS);
  const forced = opts.forceDash === true;
  const downgrade = !opts.neverDowngrade && (beyond || forced);
  const finalRole = downgrade ? ElevationLineRole.DETAIL : role;
  const finalDash = downgrade ? 'dashed' : (opts.dash ?? undefined);
  const prim = { type: 'line', x1, y1: zToY(z1), x2, y2: zToY(z2), weight: weightForRole(finalRole) };
  if (finalDash) prim.dash = finalDash;
  return prim;
}

// band全体がbaseFloorZ以下／ceilZ以上（水平な上端・下端エッジが「ちょうど境界に触れるだけ」
// でも降格させたい場合の判定。emitLineのopts.forceDashに渡す）。
function bandFullyBeyond(cut, band, ceilZ) {
  const baseFloorZ = cut.baseFloorZ ?? 0;
  const top = ceilZ ?? cut.zRange?.hiZ ?? Infinity;
  return band.z1 <= baseFloorZ + GAP_EPS || band.z0 >= top - GAP_EPS;
}

// z区間が重なるか（隣接列の同一kind判定・アキ連結成分判定の共通ヘルパ）。
function overlapsZ(a, b) {
  return a.z0 < b.z1 - GAP_EPS && a.z1 > b.z0 + GAP_EPS;
}

// col（SectionColumn|null）から、[z0,z1]と重なる指定kindのband（無ければnull）を返す。
function matchingBand(col, z0, z1, kind) {
  if (!col) return null;
  return col.bands.find(b => b.kind === kind && overlapsZ(b, { z0, z1 })) ?? null;
}

// col（SectionColumn|null）の[z0,z1]範囲が「アキ扱い」（kind==='open' または
// openingPassThrough:true）で完全に覆われているか（凹み判定・cut縁のopen判定に使う）。
// 列が無い（範囲外）場合はopen扱い（画面の外は常に開放）。
function isOpenSideAt(col, z0, z1) {
  if (!col) return true;
  return col.bands.some(b => (b.kind === 'open' || b.openingPassThrough) && overlapsZ(b, { z0, z1 }));
}

/**
 * SectionColumn[] → 切断壁の断面（両縁）・見えがかり壁面の輪郭／凹み側面線 のプリミティブ列
 * （§3.4役割分担表・§5.5・§5.6）。アキXはemitOpenGapMarks側（本関数はopen/slab bandを描かない
 * ——slabは非描画のまま、AMBIGUITY F）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number}} [emitCtx]
 * @returns {object[]}
 */
export function emitColumns(columns, cut, emitCtx = {}) {
  const prims = [];
  const ceilZ = emitCtx.ceilZ;
  columns.forEach((col, i) => {
    const prev = columns[i - 1] ?? null;
    const next = columns[i + 1] ?? null;
    for (const band of col.bands) {
      if (band.kind === 'cut') {
        // 切断壁の断面矩形の両縁: その縁が接する側がopenならCUT、塞がれていればSILHOUETTE
        // （AMBIGUITY B）。列の外（画面端）はopen扱い。WP-E5b修正: 隣接列が「別のcut band」で
        // なければopen扱いにしていた旧実装（`|| !matchingBand(...,'cut')`）は、隣接列が
        // 'wall'（距離のある見えがかり壁）のときも「塞がれていない」と誤判定していた
        // （例: seq1で切断された往復間の壁の縁が、遠くに見える別の壁（'wall'band）に接する場合。
        // 保存意味論「seq1では切断線を横切るcutとして厚みの2縁=open側CUT/塞がれ側SILHOUETTE」
        // を満たすには、'wall'・'cutAlong'等どの種類であれ何らかの実体があれば「塞がれている」
        // とみなす必要がある——isOpenSideAtは`kind==='open'`（または開口貫通）だけをopenと
        // みなすため、そのままの結果を使えばよい）。
        const leftOpen  = isOpenSideAt(prev, band.z0, band.z1);
        const rightOpen = isOpenSideAt(next, band.z0, band.z1);
        prims.push(emitLine(cut, col.x0, band.z0, col.x0, band.z1,
          leftOpen ? ElevationLineRole.CUT : ElevationLineRole.SILHOUETTE, { ceilZ }));
        prims.push(emitLine(cut, col.x1, band.z0, col.x1, band.z1,
          rightOpen ? ElevationLineRole.CUT : ElevationLineRole.SILHOUETTE, { ceilZ }));
      } else if (band.kind === 'wall') {
        // 見えがかり壁面の輪郭（上端・下端）。水平線（縮退）はemitLineの単独判定では
        // 「ちょうどbaseFloorZ/ceilZに触れるだけ」を向こう側と見なさないため、band全体が
        // baseFloorZ以下／ceilZ以上ならforceDashで明示的に降格する（WP-E5b: sectionProbe.jsが
        // cut.baseFloorZをzBreaksに割り込ませることで生じる、内部分割されたband用の対応）。
        const beyondBand = bandFullyBeyond(cut, band, ceilZ);
        prims.push(emitLine(cut, col.x0, band.z0, col.x1, band.z0, ElevationLineRole.SILHOUETTE, { ceilZ, forceDash: beyondBand }));
        prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, ElevationLineRole.SILHOUETTE, { ceilZ, forceDash: beyondBand }));
        // 凹み: 隣接列で同一z区間のwallのdistMmが変化した境界にSILHOUETTE縦線（§5.5）。
        const prevWall = matchingBand(prev, band.z0, band.z1, 'wall');
        if (!prevWall || prevWall.distMm !== band.distMm) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
        }
        const nextWall = matchingBand(next, band.z0, band.z1, 'wall');
        if (!nextWall || nextWall.distMm !== band.distMm) {
          prims.push(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
        }
      } else if (band.kind === 'cutAlong') {
        // cutAlong（縦断された壁。WP-E5リード裁定・§6.1）: 見付面自体は塗らず輪郭のみ描く。
        // 上端エッジ（腰壁ならtopHeight位置。壁がz途中で終わる場合その上はrayが継続し別kindの
        // bandになる＝band.z1が常に「この壁のこの位置での実際の上端」）はCUT水平線
        // （band全体がbaseFloorZ以下なら降格。'wall'と同じforceDash判定）。
        prims.push(emitLine(cut, col.x0, band.z1, col.x1, band.z1, ElevationLineRole.CUT,
          { ceilZ, forceDash: bandFullyBeyond(cut, band, ceilZ) }));
        // 端部縦線: 壁のx方向の実際の端（隣接列に同じcutAlong壁が続かない側）にCUT縦線
        // （壁の実端の断面。§5.5の凹み側面線と同じ「隣接列と比較」パターンだが、cutAlongは
        // 塗り分けを持たないため常にCUT——壁が存在しない側=open端という区別を線種に反映する
        // 必要が無い、壁の実端そのものを示す線のため）。
        const prevAlong = matchingBand(prev, band.z0, band.z1, 'cutAlong');
        if (!prevAlong) {
          prims.push(emitLine(cut, col.x0, band.z0, col.x0, band.z1, ElevationLineRole.CUT, { ceilZ }));
        }
        const nextAlong = matchingBand(next, band.z0, band.z1, 'cutAlong');
        if (!nextAlong) {
          prims.push(emitLine(cut, col.x1, band.z0, col.x1, band.z1, ElevationLineRole.CUT, { ceilZ }));
        }
      }
      // open/slabの帯自体はここでは描かない（AMBIGUITY F）。ただしslab→openの境界（＝above層の
      // 床の端）はSILHOUETTE水平線として描く（WP-E5b追加。§5.6「2FLの中線= above層の床スラブ端
      // （slabとopenの境界）→SILHOUETTE水平線」）。同一列内でz方向に隣接するslab/open帯の境界を
      // 対象にする——列をまたぐslab⇄open（x方向の境界）は凹み側面線に相当する概念が無く
      // （床の厚み方向の境界であってwallの見付面ではない）、本WPでは対象外（ASSUMED）。
    }
    for (let i = 0; i + 1 < col.bands.length; i++) {
      const a = col.bands[i], b = col.bands[i + 1];
      const aIsFloorEdge = (a.kind === 'slab' || a.kind === 'open');
      const bIsFloorEdge = (b.kind === 'slab' || b.kind === 'open');
      if (aIsFloorEdge && bIsFloorEdge && a.kind !== b.kind) {
        prims.push(emitLine(cut, col.x0, a.z1, col.x1, a.z1, ElevationLineRole.SILHOUETTE, { ceilZ }));
      }
    }
  });
  return dedupeLines(prims);
}

// 完全に同一（type/x1/y1/x2/y2/weight/dash）の線プリミティブを1本にまとめる（WP-E5b追加）。
// sectionProbe.jsがcut.baseFloorZ/ceilZをzBreaksに割り込ませる（§5.6最終フィルタをband内部の
// 一部にも適用できるようにするため）副作用として、同一kindの隣接z区間が「上端／下端」を
// それぞれ独立に描く際、その内部分割の境界ちょうどで同じ水平線が2回出ることがある
// （例: wallの下側区間の上端縁と上側区間の下端縁が同じz=baseFloorZに重なる）——見た目には
// 影響しない冗長プリミティブだが、テスト側の本数アサーションを不安定にするため統合する。
function dedupeLines(prims) {
  const seen = new Set();
  const out = [];
  for (const p of prims) {
    const key = p.type === 'line' ? `${p.type}|${p.x1}|${p.y1}|${p.x2}|${p.y2}|${p.weight}|${p.dash ?? ''}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * SectionColumn[] → アキのX（対角線2本。AMBIGUITY E）のプリミティブ列。
 * kind==='open' の band、および openingPassThrough:true が付いた band（kind問わず。§5.4・
 * WP-E7でopeningがこのフラグを立てる想定——本関数自体はフラグの由来を問わない）を
 * 「アキ扱い」とみなし、列をまたいでz範囲が重なるもの同士を連結成分としてまとめてから
 * 1組ずつXを描く（defer D1「開口が2階アキと連続する場合の1つの大きなX」の一般規則。§7）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {{ceilZ?:number}} [emitCtx]
 * @returns {object[]}
 */
export function emitOpenGapMarks(columns, cut, emitCtx = {}) {
  const ceilZ = emitCtx.ceilZ;
  const cells = [];
  columns.forEach((col, colIndex) => {
    for (const b of col.bands) {
      if (b.kind === 'open' || b.openingPassThrough) {
        cells.push({ colIndex, x0: col.x0, x1: col.x1, z0: b.z0, z1: b.z1 });
      }
    }
  });

  // 連結成分（列インデックスが隣接し、z範囲が重なるセル同士を1つにまとめる）。
  const groups = [];
  for (const cell of cells) {
    const touching = groups.filter(g => g.some(c =>
      Math.abs(c.colIndex - cell.colIndex) <= 1 && overlapsZ(c, cell)));
    if (touching.length === 0) { groups.push([cell]); continue; }
    const [target, ...rest] = touching;
    target.push(cell);
    for (const other of rest) {
      target.push(...other);
      groups.splice(groups.indexOf(other), 1);
    }
  }

  const prims = [];
  for (const g of groups) {
    const x0 = Math.min(...g.map(c => c.x0));
    const x1 = Math.max(...g.map(c => c.x1));
    const z0 = Math.min(...g.map(c => c.z0));
    const z1 = Math.max(...g.map(c => c.z1));
    // §5.6: baseFloorZより上=一点鎖線(center)、床断面より下=破線(dashed)。連結成分がbaseFloorZを
    // またぐ（D1の「開口+上階アキ」等）場合は、床断面より下へ到達している時点でdashedを選ぶ
    // （ASSUMED: 設計書はこの併合時の様式を明記していないため、より弱い表現＝dashedを安全側の
    // 既定にした。報告に明記する）。
    const dash = z0 >= (cut.baseFloorZ ?? 0) - GAP_EPS ? 'center' : 'dashed';
    prims.push(emitLine(cut, x0, z0, x1, z1, ElevationLineRole.DETAIL, { dash, ceilZ }));
    prims.push(emitLine(cut, x0, z1, x1, z0, ElevationLineRole.DETAIL, { dash, ceilZ }));
  }
  return prims;
}
