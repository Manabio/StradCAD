// フロア（階・検討案）の並替・切替まわりの計算・低レベル永続化操作。App.jsx から抽出。
// runInAction によるMobX状態への反映・ダイアログ表示等の配線は App.jsx 側に残す。
import { restoreGraph } from './graphSnapshot.js';
import { saveFloor, deleteFloor as dbDeleteFloor } from './storage/db.js';
import { addSkipZero, makeFloorName, renameFloor } from './floorNumber.js';

// Uint8Array 同士の内容比較（null 同士は等しい）
export function floorBytesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// planeId のフロアへスナップショットを適用する。アクティブならメモリ上のグラフへ復元し、
// 非アクティブなら IDB へ書き戻す（peek はキャッシュを持たないためこれで完全に復元される）。
// bytes === null は「IDB 未保存」状態への巻き戻し（レコード削除）。
export function applyFloorBytes(project, planeId, bytes) {
  if (project.activePlaneId === planeId && project.activeGraph) {
    if (bytes != null) restoreGraph(project.activeGraph, bytes);
    return;
  }
  (bytes != null ? saveFloor(planeId, bytes) : dbDeleteFloor(planeId)).catch(console.error);
}

// アクティブプレーンが planeId の検討かどうか
export function isActiveAnAltOf(project, planeId) {
  const active = project.activePlane;
  return active?.isAlternative && active.referenceId === planeId;
}

// ---- フロアタブのドラッグ割り込み（計算部）----
// project.planes（elevation昇順）を fromId→toZone の並びへ並び替え、
// 並替後の startFloor/elevation/name を再採番する。no-op（適用不可）なら null。
// 戻り値は index>=1（最下階は固定）の更新差分のみ。
export function computeFloorReorder(planes, fromId, toZone) {
  const sorted = planes;
  const fromIndex = sorted.findIndex(p => p.id === fromId);
  if (fromIndex <= 0) return null;  // 最下階（index 0）はドラッグ不可
  if (toZone <= 0) return null;     // 最下階の前にはドロップ不可
  if (toZone === fromIndex || toZone === fromIndex + 1) return null; // 隣接 = no-op

  // 最下階は固定、index 1.. のみ並び替え
  const bottom = sorted[0];
  const rest   = sorted.slice(1);
  const ri     = fromIndex - 1;  // rest 内のインデックス
  const [moved] = rest.splice(ri, 1);
  let rt = toZone - 1;
  if (rt > ri) rt--;             // splice で詰まった分を補正
  rest.splice(rt, 0, moved);

  const newOrder = [bottom, ...rest];

  const updates = [];
  let prevSF      = bottom.startFloor;
  let prevStories = bottom.stories;
  let prevElev    = bottom.elevation;
  for (let i = 1; i < newOrder.length; i++) {
    const plane  = newOrder[i];
    const newSF  = addSkipZero(prevSF + prevStories - 1, 1);
    const newElev = prevElev + prevStories * 3000;
    // 一般階は makeFloorName、それ以外は renameFloor で書式を保持
    const name = plane.stories > 1
      ? makeFloorName(newSF, plane.stories)
      : renameFloor(plane.name, newSF);
    updates.push({ id: plane.id, name, startFloor: newSF, elevation: newElev });
    prevSF      = newSF;
    prevStories = plane.stories;
    prevElev    = newElev;
  }
  return updates;
}

// ---- 検討の並び替え（グループ内。計算部）----
// alts（同一 referenceId で isAlternative:true のみ・altIndex昇順で呼び出し側が既に絞り込み済みの配列）を
// fromId→toZone の並びへ並び替え、altIndex を再採番する。no-op なら null。戻り値は { id, altIndex } の更新一覧。
export function computeAltReorder(alts, fromId, toZone) {
  const fromI = alts.findIndex(p => p.id === fromId);
  if (fromI < 0 || toZone === fromI || toZone === fromI + 1) return null;
  const newOrder = [...alts];
  const [moved] = newOrder.splice(fromI, 1);
  let rt = toZone;
  if (rt > fromI) rt--;
  newOrder.splice(rt, 0, moved);
  return newOrder.map((p, i) => ({ id: p.id, altIndex: i }));
}

// ---- 検討チップのロングタップ・メニューによる並替（計算部）----
// plane が検討（isAlternative）なら alts（同グループ・altIndex昇順）内での並替対象を、
// 採用なら planes（elevation昇順の採用フロア一覧）内での並替対象を返す（実行は呼び出し側）。
// plane が null（planeId未検出）なら null。
export function resolveChipReorderTarget(plane, alts, planes, direction) {
  if (!plane) return null;
  if (plane.isAlternative) {
    const i = alts.findIndex(p => p.id === plane.id);
    return { kind: 'alt', refId: plane.referenceId, toZone: direction > 0 ? i + 2 : i - 1 };
  }
  const i = planes.findIndex(p => p.id === plane.id);
  return { kind: 'floor', toZone: direction > 0 ? i + 2 : i - 1 };
}

// ---- plane一覧の復元差分計算（計算部）----
// metas: decodePlanes(bytes) の戻り値 { planes, activePlaneId } | null（文書なしは null）
// existingIds: 現在 project.planeMap に存在する plane.id の配列（起動直後は [bootPlaneId] のみのはず）
// bootPlaneId: store.js 起動時にブートストラップとして既に project.addPlane 済みの plane.id
//   （既存集合に念のため合流させる。呼び出し側が existingIds に含め忘れても bootPlaneId は
//   必ず toUpdate/toRemove いずれかに分類される）
//
// - 参照先を失った検討階（referenceId が metas.planes 内に不在）は最終集合から除外する。
//   判定は raw list（metas.planes）1段のみ——検討が別の検討を参照する多段構成は現行データ
//   モデルに存在しないため、連鎖的な孤児判定（除外された検討をさらに参照する検討の再帰除外）は行わない。
// - activePlaneId（metas.activePlaneId）が最終集合に不在、または最終集合内で isRoofPlane の
//   plane を指す場合は、最下階（isAlternative/isRoofPlane を除く elevation 最小のplane。
//   無ければ最終集合の先頭）へフォールバックする（屋根専用平面は構造モード専用の合成平面で
//   平面モードの復帰導線を持たないため、通常のアクティブ階として復元してはならない。
//   ただし plane 自体は最終集合から除外しない——構造モードの図面合成に必要）。
// - 戻り値: { toAdd, toUpdate, toRemove, activePlaneId }。文書なし（metas が null または
//   metas.planes が空/未定義）は null を返す。
export function reconcilePlanes(metas, existingIds, bootPlaneId) {
  if (!metas || !metas.planes || metas.planes.length === 0) return null;

  // 参照先を失った検討階を除外
  const finalMetas = metas.planes.filter(p =>
    !p.isAlternative || metas.planes.some(q => q.id === p.referenceId));
  const finalIds = new Set(finalMetas.map(p => p.id));

  const existingSet = new Set([...(existingIds ?? []), bootPlaneId]);
  const toAdd    = finalMetas.filter(p => !existingSet.has(p.id));
  const toUpdate = finalMetas.filter(p => existingSet.has(p.id));
  const toRemove = [...existingSet].filter(id => id != null && !finalIds.has(id));

  const bottomCandidates = finalMetas
    .filter(p => !p.isAlternative && !p.isRoofPlane)
    .sort((a, b) => a.elevation - b.elevation);
  const savedActive = finalMetas.find(p => p.id === metas.activePlaneId);
  const activePlaneId = (savedActive && !savedActive.isRoofPlane)
    ? savedActive.id
    : (bottomCandidates[0]?.id ?? finalMetas[0]?.id ?? null);

  return { toAdd, toUpdate, toRemove, activePlaneId };
}

// ---- 階変更（計算部）----
// planes（elevation昇順の採用フロア一覧）内の planeId 以降の startFloor/elevation/name を
// newStartFloor 起点で再採番する。適用不可（newStartFloor===0・planeId未検出）なら null。
export function computeFloorChangeReorder(planes, planeId, newStartFloor) {
  if (newStartFloor === 0) return null;
  const idx = planes.findIndex(p => p.id === planeId);
  if (idx < 0) return null;
  const updates = [];
  let prevSF   = newStartFloor;
  let prevSto  = 1;
  let prevElev = planes[idx - 1]
    ? planes[idx - 1].elevation + planes[idx - 1].stories * 3000
    : planes[0].elevation;
  for (let i = idx; i < planes.length; i++) {
    const p  = planes[i];
    const sf = i === idx ? newStartFloor : addSkipZero(prevSF + prevSto - 1, 1);
    const el = i === idx ? prevElev : prevElev + prevSto * 3000;
    const name = p.stories > 1 ? makeFloorName(sf, p.stories) : renameFloor(p.name, sf);
    updates.push({ id: p.id, name, startFloor: sf, elevation: el });
    prevSF = sf; prevSto = p.stories; prevElev = el;
  }
  return updates;
}
