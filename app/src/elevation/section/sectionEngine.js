/**
 * 2.5D断面エンジン: buildSectionFigure（columns→出力組み立て。WP-E4）。
 * 設計意図はarchitect承認済みの実装指示書§4参照。buildSectionFigure自体は現時点で
 * 通常部屋帯・吹抜け帯からは未使用（§11リスク4のとおり将来の統合余地）——buildColumns
 * （本ファイルからexport）はWP-E5bでelevationStairSequence.jsから直接呼ばれる。
 *
 * 内部フロー（§4のコメントどおり）: collectCutBreaks → probeColumn×N → mergeColumns
 * （同一分類の隣接併合）→ faceFromCut → floorSegments/ceilingProfile導出 → sectionEmit → content。
 *
 * ASSUMED（設計書に算出式の明記が無いためWP-E4完了条件の範囲で以下の解釈を採用。§9のとおり
 * 「手書きの小さなSectionCutリテラル→期待するプリミティブ」で直接検証する）:
 *   - floorSegments: このWPでは「区分（エリア）ごとの床段差」までは導出しない
 *     （階段の踊り場等、cutの向こうにある実際の段差反映はWP-E5でstairCut統合時に確定させる
 *     ——設計書はfloorSegmentsの算出式自体を明記していない）。今回は面全幅を覆う単一区間
 *     （floorDeltaMm:0・完了条件「隙間なく面全幅・hiX>loX」を満たす最小限の忠実な実装）。
 *   - ceilingProfile: cut.zRange.hiZ（この切断が見せる天井の絶対高さ）を面全幅にわたる
 *     水平線として2点（[loX,ceilAbsMm],[hiX,ceilAbsMm]）で返す（区分線形の最小形。昇順条件は
 *     loX<=hiXから自明に満たす）。
 *   - primaryWall未指定時は、columns中で最も広いx幅を占める壁（'wall'|'cut'band.wall）を
 *     「レイキャストで最も広く見えた壁」として選ぶ。
 *   - cut.stairCutは「事前計算済みのstairContribution結果」を直接指す想定（sectionEngine.js
 *     自身はfinish/stair側の詳細を知らない——第3層との結合点はこの1箇所に閉じる）。
 */
import { GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { localXOf, worldOf } from './sectionTypes.js';
import { collectCutBreaks, probeColumn } from './sectionProbe.js';
import { faceFromCut } from './sectionFace.js';
import { emitColumns, emitOpenGapMarks } from './sectionEmit.js';
import { stairPrimitivesForCut } from './sectionStair.js';

// bands配列が（kind・z0/z1・wall参照・distMm・layerRole・openingPassThrough）まで完全一致するか
// （mergeColumns用）。WP-E7 D1: openingPassThroughも比較対象に含める——比較しないと、開口の
// 有無で挙動が違う隣接列（片方だけopeningPassThrough:trueの'wall'帯）が誤って1列に統合され、
// その列の実際のx範囲の一部でopeningPassThroughが取りこぼされる（emitOpenGapMarksの連結成分
// 計算に渡らない）おそれがあるため。
function bandsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((band, i) => {
    const other = b[i];
    return band.kind === other.kind
      && Math.abs(band.z0 - other.z0) < GAP_EPS && Math.abs(band.z1 - other.z1) < GAP_EPS
      && (band.wall ?? null) === (other.wall ?? null)
      && (band.distMm ?? null) === (other.distMm ?? null)
      && (band.layerRole ?? null) === (other.layerRole ?? null)
      && (band.openingPassThrough ?? false) === (other.openingPassThrough ?? false);
  });
}

/**
 * `cut.ceilProfile`の区間境界を列の分割点へ足す（world座標・昇順）。
 * 天井の高さが変わる位置は列の境界でなければならない——境界をまたぐ1本の列は中点で1つの天井しか
 * 持てず、区間の片側が誤った天井で打ち切られる（実データでは境界にCLや壁があって偶然分かれるが、
 * それに依存してはいけない）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number[]} breaks - collectCutBreaksの結果（world昇順）
 * @returns {number[]}
 */
function withCeilProfileBreaks(cut, breaks) {
  const prof = cut.ceilProfile;
  if (!Array.isArray(prof) || prof.length === 0) return breaks;
  const lo = breaks[0], hi = breaks[breaks.length - 1];
  const values = new Set(breaks);
  for (const seg of prof) {
    for (const localX of [seg.loX, seg.hiX]) {
      const w = worldOf(cut, localX);
      if (w > lo + GAP_EPS && w < hi - GAP_EPS) values.add(w);
    }
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * `cut.ceilProfile`（区間ごとの天井断面の高さ。断面ローカルx）から、xを含む区間の天井を引く。
 * profileが無ければnull＝打ち切らない（階段帯など、区間の天井を持たない呼び出し側は従来どおり）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {number} x0
 * @param {number} x1
 * @returns {number|null}
 */
function ceilZAt(cut, x0, x1) {
  const prof = cut.ceilProfile;
  if (!Array.isArray(prof) || prof.length === 0) return null;
  const mid = (x0 + x1) / 2;
  const hit = prof.find(s => mid >= s.loX - GAP_EPS && mid <= s.hiX + GAP_EPS);
  return hit && Number.isFinite(hit.ceilZ) ? hit.ceilZ : null;
}

/**
 * 列の帯を、その列の天井断面（ceilZ）で打ち切る（buildColumns参照）。天井より上の帯は落とし、
 * またぐ帯は天井で切る。ceilZがnull（判定不能）なら何もしない。
 *
 * **唯一の例外: 天端または下端が露出した切断壁（腰壁・垂れ壁。`isKneeDrop`）は打ち切らない**
 * （ユーザー明示指示2026-08・案A）——露出した縁は吹抜け側の空間に面していて実際に見えるため、
 * 天井の向こうにあっても断面を描く。実機「5」D1の「2階Y1から2000＝2FL+800の腰壁断面」が
 * 消えていた不具合の修正。上下いっぱいに立つ切断壁は隣室との仕切りで天井に隠れるため従来どおり
 * 落とす（同「5」A面左3200の2階壁・C1面右400の2階X2壁）。
 * **見えがかり（'wall'）には例外を適用しない**——腰壁でも、天井の向こうにあれば見えないから。
 * @param {import('./sectionTypes.js').ZBand[]} bands
 * @param {number|null} ceilZ
 * @returns {import('./sectionTypes.js').ZBand[]}
 */
function clipBandsToCeil(bands, ceilZ) {
  if (!Number.isFinite(ceilZ)) return bands;
  const exempt = b => (b.kind === 'cut' || b.kind === 'cutAlong') && b.isKneeDrop === true;
  const out = [];
  for (const band of bands) {
    if (exempt(band)) { out.push(band); continue; }
    if (band.z0 >= ceilZ - GAP_EPS) continue;
    out.push(band.z1 > ceilZ ? { ...band, z1: ceilZ } : band);
  }
  return out;
}

/**
 * 隣接する列のbandsが完全一致すれば1列へ統合する（§4「同一分類の隣接併合」）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns - x0昇順
 * @returns {import('./sectionTypes.js').SectionColumn[]}
 */
export function mergeColumns(columns) {
  const merged = [];
  for (const col of columns) {
    const last = merged[merged.length - 1];
    // ceilZ（列ごとの天井断面高さ）が違う列は統合しない——天井の高さが変わる境界そのものだから。
    const sameCeil = (last?.ceilZ ?? null) === (col.ceilZ ?? null);
    if (last && sameCeil && Math.abs(last.x1 - col.x0) < GAP_EPS && bandsEqual(last.bands, col.bands)) {
      last.x1 = col.x1;
      // WP-E5b修正: dirSign<0のcutではbuildColumnsがraw列をworld昇順で作った後、local x昇順へ
      // 並べ替える（このmergeColumnsへの入力順はlocal x昇順）ため、world順はlocal順と逆転する。
      // 「last.worldHi = col.worldHi」だけの単純代入だと、統合を重ねるたびに直前列のworldHiで
      // 上書きされ続け、最終的な統合列のworldLo/worldHiが実際の世界範囲と無関係な値になる
      // （観測: 複数列にまたがる統合でworldLo===worldHiという退化した値になった）。
      // Math.min/maxで両列の4値から実際の範囲を再計算する（dirSignの符号に関わらず正しい）。
      const lo = Math.min(last.worldLo, last.worldHi, col.worldLo, col.worldHi);
      const hi = Math.max(last.worldLo, last.worldHi, col.worldLo, col.worldHi);
      last.worldLo = lo;
      last.worldHi = hi;
    } else {
      merged.push({ ...col });
    }
  }
  return merged;
}

// columns中で最も広いx幅を占める壁（'wall'|'cut' band.wall）を返す（列内は重複カウントしない）。
function findPrimaryWall(columns) {
  const widthByWall = new Map();
  for (const col of columns) {
    const width = col.x1 - col.x0;
    const wallsInCol = new Set();
    for (const band of col.bands) {
      if ((band.kind === 'wall' || band.kind === 'cut') && band.wall) wallsInCol.add(band.wall);
    }
    for (const wall of wallsInCol) widthByWall.set(wall, (widthByWall.get(wall) ?? 0) + width);
  }
  let best = null, bestWidth = -Infinity;
  for (const [wall, width] of widthByWall) {
    if (width > bestWidth) { bestWidth = width; best = wall; }
  }
  return best;
}

function floorSegmentsFromColumns(columns, face) {
  const run = face?.run ?? 0;
  if (columns.length === 0) return [{ loX: 0, hiX: run, floorDeltaMm: 0, chMm: null, loCLId: null, hiCLId: null }];
  const loX = Math.min(...columns.map(c => c.x0));
  const hiX = Math.max(...columns.map(c => c.x1));
  return [{ loX, hiX, floorDeltaMm: 0, chMm: null, loCLId: face?.startCLId ?? null, hiCLId: face?.endCLId ?? null }];
}

function ceilingProfileFromColumns(columns, cut, face) {
  const ceilAbsMm = cut.zRange?.hiZ ?? 0;
  if (columns.length === 0) return [[0, ceilAbsMm], [face?.run ?? 0, ceilAbsMm]];
  const loX = Math.min(...columns.map(c => c.x0));
  const hiX = Math.max(...columns.map(c => c.x1));
  return [[loX, ceilAbsMm], [hiX, ceilAbsMm]];
}

/**
 * SectionCut → SectionFigure（現行StairFaceEntryと同型。§3.3）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @param {{wallFaces?:object[], primaryWall?:object|null, ceilZ?:number, floorSpanX?:object}} [opts]
 * @returns {{seqNo:string, face:object, floorSegments:object[], ceilingProfile:Array<[number,number]>,
 *   chDimSplitAbsYs:number[]|undefined, content:object[], skipBaseboard:true, skipWallLabel:true,
 *   floorSpanX:object|undefined}}
 */
/**
 * cut → SectionColumn[]（collectCutBreaks→probeColumn×N→mergeColumns。§4「内部フロー」の
 * 前半部分）。buildSectionFigureの内部処理を切り出したもの——face/floorSegments/ceilingProfile
 * を必要とせずcontentだけを組み立てたい呼び出し側（elevationStairSequence.js等）が
 * 直接使うためexportする（WP-E5b）。
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {ReturnType<typeof import('./sectionProbe.js').makeProbeContext>} probeCtx
 * @returns {import('./sectionTypes.js').SectionColumn[]}
 */
export function buildColumns(cut, probeCtx) {
  const breaks = withCeilProfileBreaks(cut, collectCutBreaks(cut, probeCtx));
  const rawColumns = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const worldLo = breaks[i], worldHi = breaks[i + 1];
    if (worldHi - worldLo < GAP_EPS) continue;
    const worldMid = (worldLo + worldHi) / 2;
    const localA = localXOf(cut, worldLo), localB = localXOf(cut, worldHi);
    // **展開図では断面の中は描画しない**（ユーザー明示指示2026-08）: 描けるのは床断面線と
    // 天井断面線に挟まれた範囲だけで、天井の向こう（天井裏・上階の躯体）には何も描かない。
    // 天井断面の高さは区間ごとに違う（吹抜けの区間だけ上階天井まで上がる）ため、**天井断面線を
    // 実際に引いている値そのもの**を`cut.ceilProfile`で受け取り、その高さで帯を打ち切る
    // ——エンジン側で天井の有無を推測すると階段帯の見え方まで変わるため、区間の天井を知っている
    // 呼び出し側（elevationVoid.js）から渡す。probeColumn自体はzRange全域を返す契約のまま
    // （不変条件テストが依存）で、描画対象の切り出しはここで行う。
    const ceilZ = ceilZAt(cut, Math.min(localA, localB), Math.max(localA, localB));
    const bands = clipBandsToCeil(probeColumn(cut, worldMid, probeCtx), ceilZ);
    rawColumns.push({
      x0: Math.min(localA, localB), x1: Math.max(localA, localB), worldLo, worldHi, bands, ceilZ,
    });
  }
  rawColumns.sort((a, b) => a.x0 - b.x0); // dirSign<0だとworld昇順とlocal昇順が逆転するため並べ替える
  return mergeColumns(rawColumns);
}

export function buildSectionFigure(cut, probeCtx, opts = {}) {
  const columns = buildColumns(cut, probeCtx);

  const wallFaces = opts.wallFaces ?? [];
  const primaryWall = opts.primaryWall !== undefined ? opts.primaryWall : findPrimaryWall(columns);
  const face = faceFromCut(cut, wallFaces, primaryWall);

  const floorSegments = floorSegmentsFromColumns(columns, face);
  const ceilingProfile = ceilingProfileFromColumns(columns, cut, face);

  const emitCtx = { ceilZ: opts.ceilZ };
  const content = [
    ...emitColumns(columns, cut, emitCtx),
    ...emitOpenGapMarks(columns, cut, emitCtx),
    ...stairPrimitivesForCut(cut.stairCut ?? null, cut, columns),
  ];

  return {
    seqNo: cut.seqNo, face, floorSegments, ceilingProfile,
    chDimSplitAbsYs: cut.chDimSplitAbsYs, content, skipBaseboard: true, skipWallLabel: true,
    floorSpanX: opts.floorSpanX,
  };
}
