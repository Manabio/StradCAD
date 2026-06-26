import { makeFloorName } from '../floorNumber.js';

// 構造モードの図面呼称（伏図名称）の判定。伏図呼称の判定木を「1平面=1呼称」に正規化したもの。
// 最下階判定が最優先（最下階は視点に関わらず常に基礎伏図）。
//
// graph はアクティブな平面のものだけを渡すこと（フロア切替は IDB スワップを伴うため、
// 非アクティブな平面の graph.structureOverride は信頼できない）。非アクティブな平面の
// 呼称を求める場合は graph に null を渡す（building全体の主構造のみで判定する）。

/** plane が建物全体（project.planes、elevation昇順）の中で最下階（＝基礎伏図として扱う実体平面）かどうかを返す。
 *  屋根専用平面は対象外（常に false）。自動補完（structuralAutoFill.js）が柱/梁 vs 基礎・柱脚の生成を
 *  振り分ける際にも参照する単一の判定（判定木の「①最下階（視点に関わらず）」をそのまま使う）。 */
export function isFoundationPlane(plane, project) {
  if (plane.isRoofPlane) return false;
  const real = project.planes; // 採用かつ屋根専用平面を除く・elevation昇順
  return real.findIndex(p => p.id === plane.id) === 0;
}

/** plane の「1つ下の階」を返す。用途は2つ:
 *  ① 構造モードの伏図に描く柱の取得元（伏図慣習：ある階の伏図に描かれる柱は1つ下の階の柱。例: 2階伏図に
 *     1階の柱を書く）。柱データ自体は各階が自階graphに持つため、App.jsx がこの階を peek して読み取り専用に描く。
 *  ② 屋根専用平面の軒桁を含む横架材(role:'eaves')の材質の実効値（屋根の1つ下＝最上の実体平面の設定を使う）。
 *  屋根専用平面 → 最上の実体平面（project.planes末尾）。通常階(rank>=1) → project.planes[rank-1]。
 *  最下階（rank0、基礎伏図） → null（1つ下が無い＝伏図に柱を描かない。呼び出し元は実効値のフォールバックを自前で持つ）。 */
export function structuralPlaneBelow(plane, project) {
  const real = project.planes;
  if (plane.isRoofPlane) return real[real.length - 1] ?? null;
  const rank = real.findIndex(p => p.id === plane.id);
  if (rank <= 0) return null;
  return real[rank - 1];
}

/** plane の構造モード上の図面呼称（例: "1階伏図", "基礎伏図", "2階床伏図", "小屋伏図"）を返す。 */
export function computeStructuralDesignation(plane, graph, project) {
  if (plane.isRoofPlane) {
    const isWood = (project.structuralInfo.mainStructure ?? '').startsWith('木造');
    return isWood ? '小屋伏図' : 'R階伏図';
  }

  const real = project.planes; // 採用かつ屋根専用平面を除く・elevation昇順
  const idx = real.findIndex(p => p.id === plane.id);
  if (idx < 0) return '';
  if (isFoundationPlane(plane, project)) return '基礎伏図'; // ①最下階（視点に関わらず）

  const floorLabel = makeFloorName(plane.startFloor, 1);
  // ⑤最上階・床（「R階」は屋根専用平面側の呼称のため、実体平面は自身の階番号を使う）。
  if (idx === real.length - 1) return `${floorLabel}床伏図`;
  if (plane.startFloor < 0) return `${floorLabel}伏図`; // ②地下階（最下階を除く）

  const effective = graph?.structureOverride ?? project.structuralInfo.mainStructure;
  const isWood = (effective ?? '').startsWith('木造');
  return isWood ? `${floorLabel}梁伏図` : `${floorLabel}伏図`; // ③1階／④中間階
}
