/**
 * 下屋の平面表示の図形（軒先の線・棟木・隅木・谷木。ステップ1＝線だけ）の純モジュール。
 * renderer/RoofPlanLayer.jsx は結果を Konva 要素へ写すだけ。store.js・snap.js・.jsx・react-konva を静的に import しない
 * （node:test から単体で import できる）。graphDerived も import しない（memo は呼び出し側の jsx）。
 *
 * 対象は下屋（RoomFeature.ROOF の部屋）だけ。主屋根は対象外。全構造種別で出す（structural/roofFramingRegions.js
 * leanToPlanRegions。構造ゲートなし）。母屋・束・小屋梁は描かない。線は細い実線1本で、全 LOD で同じ。
 *
 * primitive: { kind:'line', key, role:'outline'|'ridge'|'hip'|'valley', points:number[], closed:boolean, detailOnly:false }
 *   outline＝軒先・けらばの外形線（壁の中に重なる部分は除く）、ridge＝棟木（切妻はけらばの外形線まで・寄棟は延ばさない）、
 *   hip＝隅木（軒の角まで）、valley＝谷木（軒先の線の入隅の角まで。伏図と違い平面だけ延ばす）。
 * 切妻になる L字・棟違いは暫定で軒先の線だけ（次のステップで「妻面全幅の中心が棟木」の規則を入れる）。
 */
import { CL_OVERLAP_TOL_MM } from '../../core/constants.js';
import { roofRidgeLines, roofHipDiagonals, extendLinesToOutline, extendDiagonalsToOutline } from '../../structural/roofFramingGeometry.js';
import { leanToPlanRegions } from '../../structural/roofFramingRegions.js';
import { LodLevel } from '../../viewport.js';

const segment = line => (line.isVertical
  ? [line.coord, line.lo, line.coord, line.hi]
  : [line.lo, line.coord, line.hi, line.coord]);

/**
 * 平面に描く下屋の図形（graph の屋根の部屋ごとに、外形線→棟木→隅木→谷木の順）。屋根が無い・graph が無い階は []。
 * 戻り値は読み取り専用（呼び出し側が memo して複数レンダーで共有する）。
 * @param {object|null} graph 屋根セルのある階の graph
 * @returns {Array<{kind:'line', key:string, role:'outline'|'ridge'|'hip'|'valley', points:number[], closed:boolean, detailOnly:false}>}
 */
export function roofPlanFigure(graph) {
  const out = [];
  const tolMm = CL_OVERLAP_TOL_MM;
  for (const region of leanToPlanRegions(graph)) {
    region.exposedPaths.forEach((path, i) => {
      out.push({ kind: 'line', key: `${region.key}:outline:${i}`, role: 'outline', points: path.points, closed: path.closed, detailOnly: false });
    });
    const ridges = extendLinesToOutline({
      lines: roofRidgeLines({ rect: region.rect, rects: region.rects ?? null, shape: region.shape, ridgeIsVertical: region.ridgeIsVertical, tolMm }),
      edges: region.edges, tolMm,
    });
    ridges.forEach((line, i) => {
      out.push({ kind: 'line', key: `${region.key}:ridge:${i}`, role: 'ridge', points: segment(line), closed: false, detailOnly: false });
    });
    // L字の下屋の継ぎ目（隅木・谷木）は水下への距離の場（伏図と同じ）。軒先の角（出隅・入隅）まで延ばす
    const diagonals = extendDiagonalsToOutline({
      diagonals: roofHipDiagonals({ rect: region.rect, rects: region.rects ?? null, shape: region.shape, leanToDrains: region.leanToDrains ?? null, tolMm }),
      edges: region.edges, valleys: true, tolMm,
    });
    const counts = { hip: 0, valley: 0 };
    for (const d of diagonals) {
      out.push({ kind: 'line', key: `${region.key}:${d.kind}:${counts[d.kind]++}`, role: d.kind, points: [d.x1, d.y1, d.x2, d.y2], closed: false, detailOnly: false });
    }
  }
  return out;
}

/**
 * 表示する図形。詳細（DETAIL）は全部、他の LOD は詳細だけの図形（detailOnly。ステップ2の文字・矢印）を除く。
 * 線は全 LOD で出す。
 * @param {Array<{detailOnly:boolean}>} primitives roofPlanFigure の結果
 * @param {string} lod LodLevel
 */
export function visibleRoofPlanPrimitives(primitives, lod) {
  return lod === LodLevel.DETAIL ? primitives : primitives.filter(p => !p.detailOnly);
}
