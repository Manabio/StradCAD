// フロア（階・検討案）の並替・切替まわりの計算・低レベル永続化操作。App.jsx から抽出。
// Planeメタの書き戻し（applyFloorInsert・applyPlaneMetas）はここに置く。ダイアログ表示等の
// 画面配線は App.jsx 側に残す。
import { runInAction } from 'mobx';
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

// planeId を削除してよいか（false なら削除を中断すべき）。アクティブ階本体、またはその検討案が
// アクティブなままでは削除できない——削除前に必ず switchFloor で切り替えること（store.js
// removeFloor のJSDoc参照）。階削除・検討案削除の「切替えてから削除する」フローが、切替失敗時に
// アクティブ階を削除してしまう事故を防ぐガード（QA指摘F1・2026-09-27）。
export function blocksFloorRemoval(project, planeId) {
  return project.activePlaneId === planeId || isActiveAnAltOf(project, planeId);
}

// ---- 振り直しの純関数（階操作の共通規則。途中階の上階追加と階移動の振り直し一本化 ステップ1）----
// planes（elevation昇順の採用フロア一覧）の fromIndex 以降を、planes[fromIndex-1]（無ければ
// planes[0] を基準に fromIndex=1 とみなす）から順に startFloor・elevation・name を決め直す。
// 挿入・ドラッグ移動・階変更・階削除の4経路が本関数へ寄せる。戻り値は { id, name, startFloor,
// elevation } の更新一覧（値が変化する階のみ）。fromIndex が末尾以降・planes が空/1件なら空配列。
export function renumberPlanesFrom(planes, fromIndex) {
  if (!planes || planes.length === 0) return [];
  const start = fromIndex <= 0 ? 1 : fromIndex;
  if (start >= planes.length) return [];
  const base = planes[start - 1] ?? planes[0];

  const updates = [];
  let prevSF      = base.startFloor;
  let prevStories = base.stories;
  let prevElev    = base.elevation;
  for (let i = start; i < planes.length; i++) {
    const plane   = planes[i];
    const newSF   = addSkipZero(prevSF + prevStories - 1, 1);
    const newElev = prevElev + prevStories * 3000;
    // 一般階は makeFloorName、それ以外は renameFloor で書式を保持
    const name = plane.stories > 1
      ? makeFloorName(newSF, plane.stories)
      : renameFloor(plane.name, newSF);
    if (name !== plane.name || newSF !== plane.startFloor || newElev !== plane.elevation) {
      updates.push({ id: plane.id, name, startFloor: newSF, elevation: newElev });
    }
    prevSF      = newSF;
    prevStories = plane.stories;
    prevElev    = newElev;
  }
  return updates;
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
  return renumberPlanesFrom(newOrder, 1);
}

// ---- 階削除の振り直し（計算部）----
// 削除後の planesAfterRemoval（elevation昇順）で、removedIndex（削除前の採用階配列での
// index）以降を renumberPlanesFrom へ委譲する。removedIndex が末尾（範囲外）なら空配列。
export function computeFloorDeleteReorder(planesAfterRemoval, removedIndex) {
  return renumberPlanesFrom(planesAfterRemoval, removedIndex);
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
// planes（elevation昇順の採用フロア一覧）内の対象階（planeId）の startFloor を newStartFloor へ
// 差し替え、それ以降は renumberPlanesFrom で決め直す。対象階自身は elevation=直下階から導く
// 現行ロジックを保つ（最下階なら自身の元 elevation へフォールバック）。
// 適用不可（newStartFloor===0・planeId未検出）なら null。
export function computeFloorChangeReorder(planes, planeId, newStartFloor) {
  if (newStartFloor === 0) return null;
  const idx = planes.findIndex(p => p.id === planeId);
  if (idx < 0) return null;

  const target = planes[idx];
  const newElev = idx > 0
    ? planes[idx - 1].elevation + planes[idx - 1].stories * 3000
    : planes[0].elevation;
  const newName = target.stories > 1
    ? makeFloorName(newStartFloor, target.stories)
    : renameFloor(target.name, newStartFloor);
  const updatedTarget = { ...target, name: newName, startFloor: newStartFloor, elevation: newElev };

  const newPlanes = [...planes];
  newPlanes[idx] = updatedTarget;
  const rest = renumberPlanesFrom(newPlanes, idx + 1);

  const updates = [];
  if (newName !== target.name || newStartFloor !== target.startFloor || newElev !== target.elevation) {
    updates.push({ id: updatedTarget.id, name: newName, startFloor: newStartFloor, elevation: newElev });
  }
  updates.push(...rest);
  return updates;
}

// ---- 途中階の上階追加（挿入）の計算部（振り直し一本化 ステップ2）----
// planes（elevation昇順の採用フロア一覧）で、表示中の階 currentPlaneId の直上へ stories 階分の
// 新階を挿入するときの { newPlane, updates } を返す。newPlane は executeAddUpper／'general' の
// 現行計算と同じ規則（topFloor = 表示中の階の最上段、addSkipZero(topFloor, 1)、
// elevation = 表示中の階のelevation + 3000×表示中の階のstories）。updates は「新階を挿入位置の
// 直後に差し込んだ配列」で renumberPlanesFrom(arr, 挿入位置+2)（新階より上の既存階だけ。新階自身は
// 含まない）。currentPlaneId が planes に無ければ null。表示中の階が最上階なら updates は空配列
// （従来の上階追加と同じ結果）。
export function computeFloorInsert(planes, currentPlaneId, stories) {
  const idx = planes.findIndex(p => p.id === currentPlaneId);
  if (idx < 0) return null;

  const current       = planes[idx];
  const topFloor       = current.startFloor + current.stories - 1;
  const newStartFloor  = addSkipZero(topFloor, 1);
  const newName        = makeFloorName(newStartFloor, stories);
  const newElevation   = current.elevation + current.stories * 3000;
  const newPlane = { name: newName, startFloor: newStartFloor, elevation: newElevation, stories };

  const arr = [...planes];
  arr.splice(idx + 1, 0, { id: null, ...newPlane });
  const updates = renumberPlanesFrom(arr, idx + 2);

  return { newPlane, updates };
}

// ---- 途中階の上階追加（挿入）の適用（振り直し一本化 ステップ2）----
// updates（振り直し後の既存Planeメタ）を project.planeMap へ書いてから addNewFloor() を呼ぶ
// （上の階をずらしてから新階を足す。同じ高さが一瞬でも並ばない順序）。addNewFloor が投げたら、
// updates を書く前のメタへ全て戻してから再 throw する（メタの変更が残らない）。addNewFloor の
// 戻り値をそのまま返す。
export function applyFloorInsert(project, updates, addNewFloor) {
  const before = new Map();
  for (const u of updates) {
    const plane = project.planeMap.get(u.id);
    if (plane) before.set(u.id, { name: plane.name, startFloor: plane.startFloor, elevation: plane.elevation });
  }

  runInAction(() => {
    for (const u of updates) {
      const plane = project.planeMap.get(u.id);
      if (!plane) continue;
      plane.name       = u.name;
      plane.startFloor = u.startFloor;
      plane.elevation  = u.elevation;
    }
  });

  try {
    return addNewFloor();
  } catch (e) {
    runInAction(() => {
      for (const [id, meta] of before) {
        const plane = project.planeMap.get(id);
        if (!plane) continue;
        plane.name       = meta.name;
        plane.startFloor = meta.startFloor;
        plane.elevation  = meta.elevation;
      }
    });
    throw e;
  }
}

// ---- 全採用階のPlaneメタの収集・復元（階操作のundo/redoが使う。振り直し一本化 ステップ2）----
// project.planes（elevation昇順の採用フロア一覧）から { id, name, startFloor, elevation, stories }
// の配列を採る。
export function collectPlaneMetas(project) {
  return project.planes.map(p => ({
    id: p.id, name: p.name, startFloor: p.startFloor, elevation: p.elevation, stories: p.stories,
  }));
}

// metas（collectPlaneMetasの戻り値、または renumberPlanesFrom 系の更新一覧）を project.planeMap へ
// 書き戻す。project.planeMap に存在しない id は無視する（undoで追加階を削除した後に呼ぶため、
// metas側にだけ存在するidがあり得る）。stories が undefined のエントリ（renumberPlanesFrom 系の
// 更新一覧はstoriesを持たない）では stories を書かない（途中階の上階追加と階移動の振り直し
// 一本化 ステップ3。handleReorderFloor・handleFloorChange・runDeleteFloorの振り直しループも
// 本関数へ寄せるため）。
export function applyPlaneMetas(project, metas) {
  runInAction(() => {
    for (const m of metas) {
      const plane = project.planeMap.get(m.id);
      if (!plane) continue;
      plane.name       = m.name;
      plane.startFloor = m.startFloor;
      plane.elevation  = m.elevation;
      if (m.stories !== undefined) plane.stories = m.stories;
    }
  });
}
