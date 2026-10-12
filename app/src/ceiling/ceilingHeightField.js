/**
 * 天井高の点問い合わせ（純モジュール。react・store.js・snap.js・.jsx を静的に引かない）。
 * 展開図が天伏の区画・形状に追従するための足場（E0。展開図側の消費は E1 以降）。
 *
 * 唯一の供給源は ceilingSurfaces.js ceilingSurfacesOf(graph)（部屋・区画ごとの rects・zMm・shape・dims・chMm）。
 * 形状つきの高さは plan/planSolids.js ceilingSolids と同じ ceilingShapeSolidZ({shape, dims, baseZ: surface.zMm, rects}) の zAt を使う。
 * 返す高さは層の FL 基準（床段差込み）の天井面の高さ mm。
 *
 * 天井面に無い点は null（天井を持たない部屋＝吹抜け・階段・屋外・屋根・昇降路・未定義、階段所属で区画に入らないセル、部屋の外）。
 * 呼び元は null のとき roomCeilingHeight 等の従来の高さへ落とす。
 * 階段吹抜け（STAIR_VOID）の平らな天井面（stairVoidFace）は ceilingSurfacesOf に含まれるのでそのまま返る。展開図で使うかは裁定待ち。
 *
 * 境界の含み方: 矩形は閉区間（x1 <= x <= x2 かつ y1 <= y <= y2）。隣り合う面の共有辺の上の点は ceilingSurfacesOf の順で先勝ち（決定的）。
 * 呼び元（展開図）はセル中央など内部の点で問い合わせる想定で、共有辺の上の点は避ける。
 * withGraphReadScope で包まない（ceilingSurfacesOf と同じ理由。MobX の追跡下で呼ばれ得る）。索引は線形走査（面数は部屋数程度）。
 */
import { ceilingSurfacesOf } from './ceilingSurfaces.js';
import { ceilingShapeSolidZ } from './ceilingShape.js';

const inRect = (r, x, y) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2;

/**
 * @typedef {{roomId: string, zoneId: string|null, rects: Array<{x1:number,y1:number,x2:number,y2:number}>, zMm: number, shape: string, dims: number[], chMm: number}} CeilingSurface
 * @param {object|null} graph  null は空の場（surfaces 空・問い合わせは常に null）。例外にしない
 * @returns {{
 *   surfaces: CeilingSurface[],
 *   surfaceAt: (x: number, y: number) => CeilingSurface|null,
 *   zAt: (x: number, y: number) => {zMm: number, chMm: number, roomId: string, zoneId: string|null, shape: string, dims: number[]}|null,
 * }}
 */
export function buildCeilingHeightField(graph) {
  const surfaces = ceilingSurfacesOf(graph); // graph null は []（ceilingSurfacesOf が空を返す）
  // 面ごとの高さ関数は初回の問い合わせで作る（形状つきの面だけ）
  const solidZs = new Map();
  const solidZOf = s => {
    let z = solidZs.get(s);
    if (!z) { z = ceilingShapeSolidZ({ shape: s.shape, dims: s.dims, baseZ: s.zMm, rects: s.rects }); solidZs.set(s, z); }
    return z;
  };
  const surfaceAt = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const s of surfaces) if (s.rects.some(r => inRect(r, x, y))) return s;
    return null;
  };
  const zAt = (x, y) => {
    const s = surfaceAt(x, y);
    if (!s) return null;
    const fn = solidZOf(s).zAt;
    return { zMm: fn ? fn(x, y) : s.zMm, chMm: s.chMm, roomId: s.roomId, zoneId: s.zoneId, shape: s.shape, dims: s.dims };
  };
  return { surfaces, surfaceAt, zAt };
}
