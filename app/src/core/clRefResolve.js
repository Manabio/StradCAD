/**
 * CL参照解決の共有ロジック（旧 core.js PlanGraph 内で3箇所（addCenterLine内・
 * _resolveExtentRef・resolveCenterLineRefs・resolveExtentWallRefs）に再実装されていた
 * 「clId→CenterLine」「wallId→Wall」の解決処理を統合）。
 *
 * 重要な不変条件（過去の不具合の再発防止。旧コメント参照）:
 *   resolveCenterLineRefs は「まだ解決できていない参照だけ」を埋める（既存の解決済み参照を
 *   上書きしない）。addCenterLine は呼び出し時点で shapeMap にある CL しか解決できないため、
 *   restoreGraph 等で参照先が自分より後に追加される順序だと解決漏れが起きる
 *   （問題.md: フロア切替でCLの短縮が解除されY2まで延長される不具合の原因）。
 *   全 CL 追加後に resolveCenterLineRefs を呼び、未解決分だけ解決し直す設計を維持する。
 *
 * CenterLine/ShapeType は呼び出し側（core/planGraph.js）から引数として受け取る
 * （core/*.js は core.js を import しない規約のため）。
 */

// clId が指す CenterLine を解決する。自グラフ shapeMap → structGraph.shapeMap の順に検索。
export function resolveCLById(shapeMap, structGraph, clId, CenterLine) {
  if (!clId) return null;
  const cl = shapeMap.get(clId) ?? structGraph?.shapeMap.get(clId);
  return cl instanceof CenterLine ? cl : null;
}

// wallId が指す Wall を解決する。壁は階固有のため自グラフ shapeMap のみを見る。
export function resolveWallById(shapeMap, wallId, ShapeType) {
  if (!wallId) return null;
  const wall = shapeMap.get(wallId);
  return wall?.type === ShapeType.WALL ? wall : null;
}

// extentLoRef/extentHiRef（{clId}|{wallId}|null）→ { cl, wall } を解決する
// （setCenterLineExtentRef が使う。旧 _resolveExtentRef と同一ロジック）。
export function resolveExtentRef(shapeMap, structGraph, ref, CenterLine, ShapeType) {
  if (!ref) return { cl: null, wall: null };
  if (ref.clId) {
    return { cl: resolveCLById(shapeMap, structGraph, ref.clId, CenterLine), wall: null };
  }
  if (ref.wallId) {
    return { cl: null, wall: resolveWallById(shapeMap, ref.wallId, ShapeType) };
  }
  return { cl: null, wall: null };
}

// 新規追加された CenterLine の refId・extentLoRef・extentHiRef を解決し、cl に書き込む
// （addCenterLine 専用。作成直後は _referencedCL 等が必ず null なので無条件に上書きしてよい）。
export function resolveNewCenterLineRefs(shapeMap, structGraph, cl, CenterLine, ShapeType) {
  if (cl.refId) {
    const refCL = resolveCLById(shapeMap, structGraph, cl.refId, CenterLine);
    if (refCL) cl._referencedCL = refCL;
  }
  if (cl.extentLoRef) {
    const { cl: loCL, wall: loWall } = resolveExtentRef(shapeMap, structGraph, cl.extentLoRef, CenterLine, ShapeType);
    if (loCL) cl._extentLoCL = loCL;
    if (loWall) cl._extentLoWall = loWall;
  }
  if (cl.extentHiRef) {
    const { cl: hiCL, wall: hiWall } = resolveExtentRef(shapeMap, structGraph, cl.extentHiRef, CenterLine, ShapeType);
    if (hiCL) cl._extentHiCL = hiCL;
    if (hiWall) cl._extentHiWall = hiWall;
  }
}
