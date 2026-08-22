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
import { localXOf } from './sectionTypes.js';
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
 * 隣接する列のbandsが完全一致すれば1列へ統合する（§4「同一分類の隣接併合」）。
 * @param {import('./sectionTypes.js').SectionColumn[]} columns - x0昇順
 * @returns {import('./sectionTypes.js').SectionColumn[]}
 */
export function mergeColumns(columns) {
  const merged = [];
  for (const col of columns) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.x1 - col.x0) < GAP_EPS && bandsEqual(last.bands, col.bands)) {
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
  const breaks = collectCutBreaks(cut, probeCtx);
  const rawColumns = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const worldLo = breaks[i], worldHi = breaks[i + 1];
    if (worldHi - worldLo < GAP_EPS) continue;
    const worldMid = (worldLo + worldHi) / 2;
    const bands = probeColumn(cut, worldMid, probeCtx);
    const localA = localXOf(cut, worldLo), localB = localXOf(cut, worldHi);
    rawColumns.push({
      x0: Math.min(localA, localB), x1: Math.max(localA, localB), worldLo, worldHi, bands,
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
