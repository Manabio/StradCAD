/**
 * 2.5D断面エンジン: 構造梁の展開図への加算寄与（WP-C。第3層＝階段幾何（sectionStair.js）と並ぶ
 * 別の寄与源。architect承認済み実装指示書§5参照）。設計意図は.claude/elevation-model.md
 * 「階をまたぐ2層帯」節参照。純モジュール（node:testから単体import可能。store.js/snap.js/
 * *.jsx/react-konva/appViewport.jsを静的importしない）。
 *
 * 遮蔽はしない（純粋な加算レイヤ。他の壁・アキとの重なり判定は取らない——構造梁はレイキャスト
 * （sectionProbe.js）の塞ぎ判定には一切参加しない。将来的な遮蔽対応はdefer）。
 *
 * 各層（cut.layers。自階=floorZMm:0・上階=floorZMm:floorHeight）のgraph.beamsをそのまま拾う——
 * 構造梁は「その梁が実際に立つ階のgraph」に帰属するため（structural-model.md「柱は自階の柱を
 * 自階graphに持つ」と同じ規律を梁にも適用）、伏図と同じ帰属をそのまま展開図の高さ方向へ投影する
 * だけで正しい階の梁が正しい高さに出る。role（primary/secondary/landing等）でのフィルタは
 * **基礎梁(role:'foundation')の除外1件のみ**——踊り場受け梁(landing)専用ではなく、その切断が
 * 拾う全構造梁が対象、という原則は変えない（追加仕様2026-08「2.5D展開では、基礎、基礎梁の
 * 描画は不要」）。1平面に基礎伏図＋1階伏図の2スロットが乗る（App.jsx）ため、1階のgraph.beamsには
 * 基礎梁と1階の梁が同居する——除外しないと室内展開図の床下に基礎梁が細破線で出る。
 * 基礎・柱脚（footingMap）・べた基礎（slab role:'mat_foundation'）は元々本モジュールの
 * 対象外（graph.beams/graph.columnsしか読まない）ため、追加の除外は要らない。
 */
import { findSectionEntry } from '../../structural/sectionCatalog.js';
import { ElevationLineRole, GAP_EPS_MM as GAP_EPS } from '../elevationStyle.js';
import { localXOf } from './sectionTypes.js';
import { emitLine } from './sectionEmit.js';

// 断面成(depthMm)のフォールバック既定値（sectionDefIdがカタログに無く・beamDepthも未設定の
// 場合の保険。木造既定断面WOOD-105x105と同値）。
const DEFAULT_DEPTH_MM = 105;

// 基礎（梁=基礎梁・地中梁 / 柱=杭）を表すrole。展開図では一律に描かない（追加仕様2026-08）。
const FOUNDATION_ROLE = 'foundation';

/**
 * @typedef {{isVertical:boolean, axisWorld:number, spanLo:number, spanHi:number,
 *   widthMm:number, topZ:number, depthMm:number, role:string}} BeamSolid
 */

/**
 * @typedef {{xLo:number, xHi:number, yLo:number, yHi:number, baseZ:number}} ColumnSolid
 *   平面の占有矩形（軸並行）＋足元の絶対z。柱は「その階の床から天井まで立つ」ものとして扱い、
 *   上端zは持たない（下記 structuralColumnPrimitivesForCut の設計判断を参照）。
 */

/**
 * cut.layers（SectionCut.layers。自階・上階のgraph参照＋floorZMm）から、各層のgraph.beamsを
 * BeamSolid[]へ変換する。layers・beamsが空なら空配列（例外なし）。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {BeamSolid[]}
 */
export function structuralContribution(layers) {
  const result = [];
  for (const layer of layers ?? []) {
    for (const beam of layer.graph?.beams ?? []) {
      if (beam.role === FOUNDATION_ROLE) continue; // 追加仕様2026-08: 基礎梁は展開図に描かない
      const depthMm = findSectionEntry(beam.sectionDefId)?.height ?? beam.beamDepth ?? DEFAULT_DEPTH_MM;
      result.push({
        isVertical: beam.isVertical,
        axisWorld: beam.axisValue,
        spanLo: Math.min(beam.coord1, beam.coord2),
        spanHi: Math.max(beam.coord1, beam.coord2),
        widthMm: beam.sectionWidth,
        topZ: layer.floorZMm + beam.levelOffset,
        depthMm,
        role: beam.role,
      });
    }
  }
  return result;
}

/**
 * cut.layers の各層の graph.columns を ColumnSolid[] へ変換する（構造梁と対になる加算レイヤ。
 * 追加仕様2026-08「柱・梁型の断面を展開図に描く」）。杭（role:'foundation'）は基礎梁と同じく除外。
 *
 * 平面の占有矩形は柱芯(x,y)＋カタログ断面の width(X方向)×height(Y方向)——renderer/
 * StructuralLayer.jsx の ColumnSymbol/columnDiaphragmSize と同じ規約。rotation は 90/270 のとき
 * width/height を入れ替える。それ以外の角度（ASSUMED: 実データでは稀）は軸並行の外接矩形として
 * 扱わず、回転前の寸法をそのまま使う——展開図は軸並行の切断面しか持たないため、斜め柱の正確な
 * 見付け幅は本レイヤの対象外（defer）。
 * @param {Array<{graph:object, floorZMm:number, role:string}>} layers
 * @returns {ColumnSolid[]}
 */
export function structuralColumnContribution(layers) {
  const result = [];
  for (const layer of layers ?? []) {
    for (const column of layer.graph?.columns ?? []) {
      if (column.role === FOUNDATION_ROLE) continue; // 杭は展開図に描かない
      const sec = findSectionEntry(column.sectionDefId);
      let w = sec?.width ?? DEFAULT_DEPTH_MM;
      let h = sec?.height ?? DEFAULT_DEPTH_MM;
      const rot = (((column.rotation ?? 0) % 360) + 360) % 360;
      if (Math.abs(rot - 90) < 1 || Math.abs(rot - 270) < 1) { const t = w; w = h; h = t; }
      result.push({
        xLo: column.x - w / 2, xHi: column.x + w / 2,
        yLo: column.y - h / 2, yHi: column.y + h / 2,
        baseZ: layer.floorZMm,
      });
    }
  }
  return result;
}

/**
 * ColumnSolid[] → 1つの切断（cut）に対するプリミティブ。柱の平面矩形が切断線をまたぎ、かつ
 * run方向の見付け区間が切断線の範囲と重なるものだけを、**見付け幅の両端の縦線2本**（CUT太線）で
 * 描く（＝室内展開図の「柱型」）。
 *
 * 設計判断（ASSUMED・報告済み）: 上下端の水平線は描かない。StructuralColumn.topLevel は既定0で
 * 実データでは未編集のまま（＝高さの信頼できる情報源が無い）一方、柱は床から天井まで通しで
 * 立つのが常態のため、z範囲は cut.zRange（帯の床〜天井）そのものを使い、床線・天井線と重なる
 * 水平線は積まない。baseZ が既に cut.zRange.hiZ 以上の層（例: 1階の展開図から見た2階の柱）は
 * 退化するため何も描かない。
 * @param {ColumnSolid[]} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @returns {object[]}
 */
export function structuralColumnPrimitivesForCut(contribution, cut) {
  const prims = [];
  const loZ = cut.zRange?.loZ ?? 0;
  const hiZ = cut.zRange?.hiZ ?? 0;
  for (const col of contribution ?? []) {
    const z0 = Math.max(col.baseZ, loZ);
    if (z0 >= hiZ - GAP_EPS) continue; // 上階の柱等、この帯の描画範囲に掛からない
    // 切断線（line.isVertical=true なら固定X・Y方向に伸びる）をまたぐか＋run方向の重なり。
    const [acrossLo, acrossHi, runLo, runHi] = cut.line.isVertical
      ? [col.xLo, col.xHi, col.yLo, col.yHi]
      : [col.yLo, col.yHi, col.xLo, col.xHi];
    const straddles = cut.line.axisValue >= acrossLo - GAP_EPS && cut.line.axisValue <= acrossHi + GAP_EPS;
    if (!straddles || !rangesOverlap(cut.line.lo, cut.line.hi, runLo, runHi)) continue;
    const xA = localXOf(cut, runLo), xB = localXOf(cut, runHi);
    prims.push(emitLine(cut, xA, z0, xA, hiZ, ElevationLineRole.CUT));
    prims.push(emitLine(cut, xB, z0, xB, hiZ, ElevationLineRole.CUT));
  }
  return prims;
}

// [aLo,aHi]と[bLo,bHi]が正の幅で重なるか（sectionStair.jsのrangesOverlapと同じ規約。section/内で
// 独立実装にする——sectionStair.jsへ依存すると階段固有の関数群(landing/flight向け)に構造梁の
// 関心事が紛れ込み、第3層同士が互いに依存する構成になるため）。
function rangesOverlap(aLo, aHi, bLo, bHi) {
  return aLo < bHi - GAP_EPS && aHi > bLo + GAP_EPS;
}

// 断面矩形4辺（CUT太線。sectionStair.jsのstringerRectLinesと同型の独立実装）。
function rectLines(cut, xLo, xHi, zTop, depthMm) {
  const zBot = zTop - depthMm;
  return [
    emitLine(cut, xLo, zBot, xLo, zTop, ElevationLineRole.CUT),
    emitLine(cut, xHi, zBot, xHi, zTop, ElevationLineRole.CUT),
    emitLine(cut, xLo, zTop, xHi, zTop, ElevationLineRole.CUT),
    emitLine(cut, xLo, zBot, xHi, zBot, ElevationLineRole.CUT),
  ];
}

/**
 * BeamSolid[]（structuralContributionの結果）を、1つの切断（cut）に対する断面プリミティブへ
 * 変換する（columnsは他の第3層関数とシグネチャを揃えるためだけに受け取り、x範囲のクランプには
 * 使わない——構造梁は柱の有無と無関係にCL間の実スパンで存在するため）。
 * - 切断線と直交し、かつ切断線の位置(cut.line.axisValue)が梁のスパン内・梁の位置
 *   (beam.axisWorld)が切断線の範囲(cut.line.lo..hi)内 → 幅×せいの断面矩形（CUT太線）。
 * - 切断線と平行かつ切断線の位置が梁の幅の帯内・spanが重なる → 上端線・下端線・両端縦線
 *   （DETAIL細線）。
 * - それ以外は何も出さない。
 * baseFloorZより下・天井より上はemitLineの既存フィルタ（cut.baseFloorZ/zRange.hiZ）で自動的に
 * 細破線へ降格する（本関数は新規の破線判定を持たない）。beams空・levelOffset=0でも例外は
 * 投げない。
 * @param {BeamSolid[]} contribution
 * @param {import('./sectionTypes.js').SectionCut} cut
 * @param {import('./sectionTypes.js').SectionColumn[]} [columns]
 * @returns {object[]}
 */
export function structuralPrimitivesForCut(contribution, cut, columns) {
  void columns; // 意図的に未使用（他の第3層関数とシグネチャを揃えるためだけに受け取る。上記コメント参照）。
  const prims = [];
  for (const beam of contribution ?? []) {
    const halfW = beam.widthMm / 2;
    // crosses（直交）: sectionStair.jsのcrossesFlightと同じ規約——cut.line自身の描画範囲
    // (lo/hi)は見ず、cut.lineの位置(axisValue)が梁のスパン内かどうかだけで判定する
    // （crossesFlightがflight.runLo/runHiだけを見てcut.line.lo/hiを見ないのと同じ理由：
    // 梁は室境界の壁芯（CL）に乗ることがあり、cut.lineの描画範囲は壁面基準でわずかに
    // 内側へ詰まっている——lo/hiまで要求すると壁芯上の梁を取りこぼす）。
    const crosses = cut.line.isVertical !== beam.isVertical &&
      cut.line.axisValue >= beam.spanLo - GAP_EPS && cut.line.axisValue <= beam.spanHi + GAP_EPS;
    if (crosses) {
      const x = localXOf(cut, beam.axisWorld);
      prims.push(...rectLines(cut, x - halfW, x + halfW, beam.topZ, beam.depthMm));
      continue;
    }
    const parallel = cut.line.isVertical === beam.isVertical &&
      cut.line.axisValue >= beam.axisWorld - halfW - GAP_EPS && cut.line.axisValue <= beam.axisWorld + halfW + GAP_EPS &&
      rangesOverlap(cut.line.lo, cut.line.hi, beam.spanLo, beam.spanHi);
    if (!parallel) continue;
    const xLo = localXOf(cut, beam.spanLo), xHi = localXOf(cut, beam.spanHi);
    const loX = Math.min(xLo, xHi), hiX = Math.max(xLo, xHi);
    const zTop = beam.topZ, zBot = beam.topZ - beam.depthMm;
    prims.push(emitLine(cut, loX, zTop, hiX, zTop, ElevationLineRole.DETAIL));
    prims.push(emitLine(cut, loX, zBot, hiX, zBot, ElevationLineRole.DETAIL));
    prims.push(emitLine(cut, loX, zTop, loX, zBot, ElevationLineRole.DETAIL));
    prims.push(emitLine(cut, hiX, zTop, hiX, zBot, ElevationLineRole.DETAIL));
  }
  return prims;
}
