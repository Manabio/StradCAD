// フロア（階・検討案）の並替・切替まわりの計算・低レベル永続化操作。App.jsx から抽出。
// Planeメタの書き戻し（applyFloorInsert・applyPlaneMetas）はここに置く。ダイアログ表示等の
// 画面配線は App.jsx 側に残す。
import { runInAction } from 'mobx';
import { restoreGraph } from './graphSnapshot.js';
import { saveFloor, deleteFloor as dbDeleteFloor } from './storage/db.js';
import { addSkipZero, subtractSkipZero, makeFloorName, renameFloor } from './floorNumber.js';
import { STORY_HEIGHT_FALLBACK_MM, storyHeightsMm } from './floorHeights.js';

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
// heights は planes と添字を揃えた「1層分の階高(mm)」の配列。各階は自分の階高を保って積まれる
// （階高×層数ぶん上へ）。省略・欠損は STORY_HEIGHT_FALLBACK_MM。
export function renumberPlanesFrom(planes, fromIndex, heights = null) {
  if (!planes || planes.length === 0) return [];
  const start = fromIndex <= 0 ? 1 : fromIndex;
  if (start >= planes.length) return [];
  const base = planes[start - 1] ?? planes[0];
  const heightAt = (i) => heights?.[i] ?? STORY_HEIGHT_FALLBACK_MM;

  const updates = [];
  let prevSF      = base.startFloor;
  let prevStories = base.stories;
  let prevElev    = base.elevation;
  let prevHeight  = heightAt(start - 1);
  for (let i = start; i < planes.length; i++) {
    const plane   = planes[i];
    const newSF   = addSkipZero(prevSF + prevStories - 1, 1);
    const newElev = prevElev + prevStories * prevHeight;
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
    prevHeight  = heightAt(i);
  }
  return updates;
}

// order（階の並び）と添字を揃えた「1層分の階高」の配列。heightMap は storyHeightsMm の戻り値（操作前の並びから採る）。
// 壊れたデータ（同じ elevation の階など）で導いた階高が有限の正数でないときは既定値に置き換える
// （storyHeightsMm 自体は壊れた値をそのまま返す＝ダイアログで見せるため）。
function saneHeight(h) {
  return Number.isFinite(h) && h > 0 ? h : STORY_HEIGHT_FALLBACK_MM;
}
function heightsForOrder(order, heightMap) {
  return order.map(p => saneHeight(heightMap.get(p.id)));
}

// 並べ替え・削除・階変更の最後に通す正規化（挿入・下階追加は 1階を動かさない経路なので通さない）: 振り直し後に startFloor===1 になる階の elevation が 0 になるよう、
// 全採用階を同じ量だけずらす（内部の基準は「1FL=0」）。order は振り直し後の並び（id が null の要素は
// まだ存在しない新階の仮置きで、更新一覧には載せない）、updates は更新一覧（変更する）。
// startFloor===1 の階が無い・既に 0 ならずらさない。戻り値はずらし量（0 なら何もしていない）。
export function normalizeFirstFloorZero(order, updates) {
  const merged = order.map(p => {
    const u = p.id != null ? updates.find(x => x.id === p.id) : undefined;
    return { p, startFloor: u?.startFloor ?? p.startFloor, elevation: u?.elevation ?? p.elevation };
  });
  const first = merged.find(m => m.startFloor === 1);
  if (!first || first.elevation === 0) return 0;
  const shift = -first.elevation;
  for (const m of merged) {
    if (m.p.id == null) continue;
    const hit = updates.find(u => u.id === m.p.id);
    if (hit) {
      hit.elevation = m.elevation + shift;
    } else {
      updates.push({ id: m.p.id, name: m.p.name, startFloor: m.startFloor, elevation: m.elevation + shift });
    }
  }
  return shift;
}

// 最上階が入れ替わったとき、新しい最上階 newTop の topStoryHeightMm（最上階だけが読む階高）を更新一覧へ載せる
// （既に一覧にあればそのエントリへ、無ければ現在値のエントリを足す）。
function attachTopStoryHeight(updates, newTop, heightMm) {
  const hit = updates.find(u => u.id === newTop.id);
  if (hit) {
    hit.topStoryHeightMm = heightMm;
  } else {
    updates.push({
      id: newTop.id, name: newTop.name, startFloor: newTop.startFloor, elevation: newTop.elevation,
      topStoryHeightMm: heightMm,
    });
  }
  return updates;
}

// ---- フロアタブのドラッグ割り込み（計算部）----
// project.planes（elevation昇順）を fromId→toZone の並びへ並び替え、
// 並替後の startFloor/elevation/name を再採番する。no-op（適用不可）なら null。
// 戻り値は index>=1（最下階は固定）の更新差分のみ。
// 各階は操作前の自分の階高を保って移動する（アンカー＝最下階の elevation。従来どおり）。
// opts.topHeightMm（resolveTopStoryHeightMm(project)）を渡すと、最上階が入れ替わったとき新しい最上階の
// topStoryHeightMm（＝その階のそれまでの階高）も更新一覧へ載せる。省略時は載せない（最上階の階高が不明）。
export function computeFloorReorder(planes, fromId, toZone, opts = {}) {
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
  const heightMap = storyHeightsMm(sorted, opts.topHeightMm ?? STORY_HEIGHT_FALLBACK_MM);
  const updates = renumberPlanesFrom(newOrder, 1, heightsForOrder(newOrder, heightMap));
  const newTop = newOrder[newOrder.length - 1];
  if (opts.topHeightMm !== undefined && newTop.id !== sorted[sorted.length - 1].id) {
    attachTopStoryHeight(updates, newTop, saneHeight(heightMap.get(newTop.id)));
  }
  normalizeFirstFloorZero(newOrder, updates);
  return updates;
}

// ---- 階削除の振り直し（計算部）----
// 削除後の planesAfterRemoval（elevation昇順）で、removedIndex（削除前の採用階配列での
// index）以降を renumberPlanesFrom へ委譲する。removedIndex が末尾（範囲外）なら空配列。
// opts.planesBefore（削除前の採用階の並び）を渡すと、各階は削除前の自分の階高を保って積み直され
// （削除後の elevation 差には削除した階の分が入るため、階高は削除前の並びから採る）、最上階を削除した
// ときは新しい最上階の topStoryHeightMm（＝削除した階との差）も更新一覧へ載せる（opts.topHeightMm
// = resolveTopStoryHeightMm(project) も渡したときだけ）。planesBefore 省略時は全階を既定の階高で積む。
export function computeFloorDeleteReorder(planesAfterRemoval, removedIndex, opts = {}) {
  const { planesBefore, topHeightMm } = opts;
  if (!planesBefore) return renumberPlanesFrom(planesAfterRemoval, removedIndex);

  const heightMap = storyHeightsMm(planesBefore, topHeightMm ?? STORY_HEIGHT_FALLBACK_MM);
  const updates = renumberPlanesFrom(planesAfterRemoval, removedIndex, heightsForOrder(planesAfterRemoval, heightMap));
  const newTop = planesAfterRemoval[planesAfterRemoval.length - 1];
  if (topHeightMm !== undefined && newTop && newTop.id !== planesBefore[planesBefore.length - 1].id) {
    attachTopStoryHeight(updates, newTop, saneHeight(heightMap.get(newTop.id)));
  }
  normalizeFirstFloorZero(planesAfterRemoval, updates);
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
// planes（elevation昇順の採用フロア一覧）内の対象階（planeId）の startFloor を newStartFloor へ
// 差し替え、それ以降は renumberPlanesFrom で決め直す。対象階自身は elevation=直下階から導く
// 現行ロジックを保つ（最下階なら自身の元 elevation へフォールバック）。
// 適用不可（newStartFloor===0・planeId未検出）なら null。
// 各階は自分の階高を保つ（階の並びは変わらないので最上階も入れ替わらない＝topStoryHeightMm は触らない）。
// opts.topHeightMm は最上階の階高（resolveTopStoryHeightMm(project)。省略時は既定）。
export function computeFloorChangeReorder(planes, planeId, newStartFloor, opts = {}) {
  if (newStartFloor === 0) return null;
  const idx = planes.findIndex(p => p.id === planeId);
  if (idx < 0) return null;

  const heights = heightsForOrder(planes, storyHeightsMm(planes, opts.topHeightMm ?? STORY_HEIGHT_FALLBACK_MM));
  const target = planes[idx];
  const newElev = idx > 0
    ? planes[idx - 1].elevation + planes[idx - 1].stories * heights[idx - 1]
    : planes[0].elevation;
  const newName = target.stories > 1
    ? makeFloorName(newStartFloor, target.stories)
    : renameFloor(target.name, newStartFloor);
  const updatedTarget = { ...target, name: newName, startFloor: newStartFloor, elevation: newElev };

  const newPlanes = [...planes];
  newPlanes[idx] = updatedTarget;
  const rest = renumberPlanesFrom(newPlanes, idx + 1, heights);

  const updates = [];
  if (newName !== target.name || newStartFloor !== target.startFloor || newElev !== target.elevation) {
    updates.push({ id: updatedTarget.id, name: newName, startFloor: newStartFloor, elevation: newElev });
  }
  updates.push(...rest);
  normalizeFirstFloorZero(newPlanes, updates);
  return updates;
}

// ---- 途中階の上階追加（挿入）の計算部（振り直し一本化 ステップ2）----
// planes（elevation昇順の採用フロア一覧）で、表示中の階 currentPlaneId の直上へ stories 階分の
// 新階を挿入するときの { newPlane, updates } を返す。newPlane は executeAddUpper／'general' の
// 現行計算と同じ規則（topFloor = 表示中の階の最上段、addSkipZero(topFloor, 1)、
// elevation = 表示中の階のelevation + 階高×表示中の階のstories。階高は下記）。updates は「新階を挿入位置の
// 直後に差し込んだ配列」で renumberPlanesFrom(arr, 挿入位置+2)（新階より上の既存階だけ。新階自身は
// 含まない）。currentPlaneId が planes に無ければ null。地上階で、表示中の階が最上階なら
// updates は空配列（従来の上階追加と同じ結果）。
//
// 地階（current.startFloor < 0）での上階追加だけは「表示中の階とその下をずらす」（地上階の番号・
// 高さは動かさない。ユーザー裁定2026-10-01）。新階（stories=n）は表示中の階の最上段に合わせて
// startFloor = current.startFloor+current.stories-1 を基準に n-1 を引き（subtractSkipZero）、
// elevation = current.elevation+(current.stories-n)×階高 を受け取る（current.stories=1・n=1なら
// 表示中の階の元の番号・高さをそのまま受け取る従来の式と一致。current.stories>1（複層の地階）でも
// 新階が表示中の階の最上段に重ならないよう最上段基準で計算する——QA指摘・2026-10-01修正）。
// 表示中の階とそれより下の採用階は全て n 階分（startFloor -= n・elevation -= 階高×n）下へずらす
// （地下どうしの移動なので0をまたがない）。地上階（current.startFloor > 0）は本分岐を通らず、
// 従来どおり「上をずらす」。
//
// 階高（階の高さ方向の寸法。2026-10-20 階設定表 S3）: 新階の 1層分の階高 H は、直下階（表示中の階）の階高を
// 引き継ぐ。表示中の階が最上階で、さらに下階があるときは、表示中の階の階高をその直下階の階高に置き換え
// （新階も同じ H を継ぐ）。下階が無い（1階建て）ときは表示中の階の自分の階高（最上階の階高）を保つ。
// 上の既存階は各自の階高を保って積み直す。新階が最上階になるときは newPlane.topStoryHeightMm = H
// （opts.topHeightMm = resolveTopStoryHeightMm(project) を渡したときだけ載せる。新階の addFloor が受ける）。
// 地階分岐のずらし量も n×H。
export function computeFloorInsert(planes, currentPlaneId, stories, opts = {}) {
  const idx = planes.findIndex(p => p.id === currentPlaneId);
  if (idx < 0) return null;

  const current = planes[idx];
  const heightMap = storyHeightsMm(planes, opts.topHeightMm ?? STORY_HEIGHT_FALLBACK_MM);
  const isTop = idx === planes.length - 1;
  const hNew = saneHeight(isTop && idx > 0 ? heightMap.get(planes[idx - 1].id) : heightMap.get(current.id)); // 新階（と表示中の階）の階高
  const topKey = isTop && opts.topHeightMm !== undefined ? { topStoryHeightMm: hNew } : {};

  if (current.startFloor < 0) {
    const n = stories;
    const currentTopFloor = current.startFloor + current.stories - 1;
    const newStartFloor = subtractSkipZero(currentTopFloor, n - 1);
    const newElevation  = current.elevation + (current.stories - n) * hNew;
    const newName       = makeFloorName(newStartFloor, n);
    const newPlane = { name: newName, startFloor: newStartFloor, elevation: newElevation, stories: n,
      planCutHeightMm: current.planCutHeightMm, // 平面の切断高は表示中の階から複製
      ceilingCutHeightMm: current.ceilingCutHeightMm, // 天伏の切断高も同じ
      ...topKey };

    const updates = [];
    for (let i = 0; i <= idx; i++) {
      const plane       = planes[i];
      const shiftedSF   = subtractSkipZero(plane.startFloor, n);
      const shiftedElev = plane.elevation - n * hNew;
      const name = plane.stories > 1
        ? makeFloorName(shiftedSF, plane.stories)
        : renameFloor(plane.name, shiftedSF);
      if (name !== plane.name || shiftedSF !== plane.startFloor || shiftedElev !== plane.elevation) {
        updates.push({ id: plane.id, name, startFloor: shiftedSF, elevation: shiftedElev });
      }
    }
    return { newPlane, updates };
  }

  const topFloor      = current.startFloor + current.stories - 1;
  const newStartFloor  = addSkipZero(topFloor, 1);
  const newName        = makeFloorName(newStartFloor, stories);
  const newElevation   = current.elevation + current.stories * hNew;
  const newPlane = { name: newName, startFloor: newStartFloor, elevation: newElevation, stories,
    planCutHeightMm: current.planCutHeightMm, // 平面の切断高は表示中の階から複製
    ceilingCutHeightMm: current.ceilingCutHeightMm, // 天伏の切断高も同じ
    ...topKey };

  const arr = [...planes];
  arr.splice(idx + 1, 0, { id: null, ...newPlane });
  const heights = arr.map((p, i) => (i === idx || i === idx + 1) ? hNew : saneHeight(heightMap.get(p.id)));
  const updates = renumberPlanesFrom(arr, idx + 2, heights);

  return { newPlane, updates };
}

// ---- [+] ボタンの入口の判定（Q21 案A。App.jsx handleAddFloor が使う）----
// 表示中の採用階 current と採用階一覧 planes から、[+] を押したときの動作を返す。
//   null                          : 採用階でない（検討案）・階が無い → 何もしない
//   { mode:'immediate' }          : 地階（startFloor<0）→ ダイアログなしで上階追加（INSERT の地階分岐。最下階の地階も同じ。
//                                   「下階」は最下階が地上階のときだけ＝最下階の地階の下へは足さない）
//   { mode:'dialog', isLowest }   : 地上階 → ダイアログ。isLowest（最下階が地上階）のときだけ「下階」（1階分固定）が出る
export function resolveAddFloorEntry(planes, current) {
  if (!current || current.isAlternative) return null;
  if (current.startFloor < 0) return { mode: 'immediate' };
  return { mode: 'dialog', isLowest: planes[0]?.id === current.id };
}

// ---- 最下階の下への階追加（下階追加）の各新階の elevation（計算部）----
// planes（elevation昇順の採用フロア一覧）の最下階の下へ、1層の階を n 本積む。各新階は元の最下階の階高を
// 引き継ぐ（最下階が最上階でもある1階建てなら、その最上階の階高 opts.topHeightMm）。既存階は動かさない
// （1FL=0 を保つ）。戻り値は下へ i+1 本目の elevation の配列（要素 n 個）。
export function computeFloorAddLowerElevations(planes, n, opts = {}) {
  const heightMap = storyHeightsMm(planes, opts.topHeightMm ?? STORY_HEIGHT_FALLBACK_MM);
  const lowest = planes[0];
  const h = saneHeight(lowest ? heightMap.get(lowest.id) : null);
  const base = lowest?.elevation ?? 0;
  return Array.from({ length: n }, (_, i) => base - h * (i + 1));
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
    planCutHeightMm: p.planCutHeightMm,
    ceilingCutHeightMm: p.ceilingCutHeightMm,
    topStoryHeightMm: p.topStoryHeightMm,
  }));
}

// ---- 階の平面切断高の変更（applyPlaneMetas 経由）----
// 検討案を含む任意の plane が対象。不正値（有限の正数でない）・plane 未検出・変化なしは何もせず null。
// 変更したら { before, after }（undo/redo はこの値で同関数を呼び直す）。
export function setPlanCutHeightMm(project, planeId, mm) {
  const plane = project.planeMap.get(planeId);
  if (!plane || !Number.isFinite(mm) || mm <= 0) return null;
  const before = plane.planCutHeightMm;
  if (before === mm) return null;
  applyPlaneMetas(project, [{
    id: plane.id, name: plane.name, startFloor: plane.startFloor, elevation: plane.elevation,
    stories: plane.stories, planCutHeightMm: mm,
  }]);
  return { before, after: mm };
}

// ---- 階の天伏切断高の変更（setPlanCutHeightMm と同型。applyPlaneMetas 経由）----
export function setCeilingCutHeightMm(project, planeId, mm) {
  const plane = project.planeMap.get(planeId);
  if (!plane || !Number.isFinite(mm) || mm <= 0) return null;
  const before = plane.ceilingCutHeightMm;
  if (before === mm) return null;
  applyPlaneMetas(project, [{
    id: plane.id, name: plane.name, startFloor: plane.startFloor, elevation: plane.elevation,
    stories: plane.stories, ceilingCutHeightMm: mm,
  }]);
  return { before, after: mm };
}

// ---- 階操作（追加・ドラッグ移動・階変更）のundoに積むべき差分（計算部。振り直し一本化 ステップ4）----
// before/after は planeId→bytes（Uint8Array|null）の Map（App.jsxのcollectFloorBytesの戻り値）。
// metasBefore/metasAfter は collectPlaneMetas の戻り値（全採用階の{id,name,startFloor,elevation,
// stories}配列。elevation昇順）。追加階が無くても、Planeメタ（ドラッグ移動・階変更）だけが
// 変化したケースでも undo に積めるよう、「積むかどうか」の判定をhasChangesへ一本化する。
// 戻り値:
//   addedPlanes: after にあって before に無い id のメタ（metasAfter から抜く。insert/addLower用）
//   changedSiblings: before/after 両方にあり bytes が変化した { planeId, before, after } の配列
//   metasChanged: metasBefore と metasAfter が一致しない（階数・値のいずれかが違う）
//   hasChanges: addedPlanes.length>0 || changedSiblings.length>0 || metasChanged
//   levelsChanged: levelsBefore と levelsAfter（collectProjectLevels の戻り値。省略可）が一致しない
//     （階設定表の GL。Plane に属さない project 単位の値なので、メタ・バイト列とは別に比べる。S4）
//   removedPlanes: removalBefore（collectRemovalRecords の戻り値。階削除が消す採用階＋検討案）のうち
//     existingIdsAfter（操作後の project.planeMap の id 集合）に無いもの。removalBefore を渡すときは
//     existingIdsAfter も必須（省略すると検討案が全て「消えた」扱いになるため throw する）
export function diffFloorOpSnapshot({
  before, after, metasBefore, metasAfter, levelsBefore, levelsAfter, removalBefore, existingIdsAfter,
}) {
  const addedPlanes = metasAfter.filter(m => !before.has(m.id));
  if (removalBefore?.length && !existingIdsAfter) {
    throw new Error('diffFloorOpSnapshot: removalBefore を渡すときは existingIdsAfter も必要');
  }
  const removedPlanes = (removalBefore ?? []).filter(r => !existingIdsAfter.has(r.id));

  const changedSiblings = [];
  for (const [planeId, beforeBytes] of before) {
    if (!after.has(planeId)) continue;
    const afterBytes = after.get(planeId);
    if (!floorBytesEqual(beforeBytes, afterBytes)) {
      changedSiblings.push({ planeId, before: beforeBytes, after: afterBytes });
    }
  }

  const metasChanged = !planeMetasEqual(metasBefore, metasAfter);
  const levelsChanged = !projectLevelsEqual(levelsBefore, levelsAfter);
  const hasChanges = addedPlanes.length > 0 || removedPlanes.length > 0 || changedSiblings.length > 0
    || metasChanged || levelsChanged;

  return { addedPlanes, removedPlanes, changedSiblings, metasChanged, levelsChanged, hasChanges };
}

// ---- 階削除（undo 対象）----
// 階削除が消す平面（採用階＋その検討案）のスナップショット。collectPlaneMetas／collectFloorBytes は採用階
// だけを採るため、検討案とメタの全項目（isAlternative・referenceId・altIndex）は別に採る。getBytes は
// planeId→Promise<Uint8Array|null>（アクティブ階はメモリから、他は IDB から。App.jsx の readPlaneBytes）。
// 採用階でない・存在しない planeId は空配列。順序は採用階→検討案（altIndex 昇順）。
// 既知の限界: 屋根専用平面（roofForPlaneId）は階操作の undo 対象外のため採らない。
export async function collectRemovalRecords(project, planeId, getBytes) {
  const target = project.planeMap.get(planeId);
  if (!target || target.isAlternative) return [];
  const alts = [...project.planeMap.values()]
    .filter(p => p.isAlternative && p.referenceId === planeId)
    .sort((a, b) => a.altIndex - b.altIndex);
  const records = [];
  for (const p of [target, ...alts]) {
    records.push({
      id: p.id, name: p.name, startFloor: p.startFloor, elevation: p.elevation, stories: p.stories,
      planCutHeightMm: p.planCutHeightMm, ceilingCutHeightMm: p.ceilingCutHeightMm,
      topStoryHeightMm: p.topStoryHeightMm,
      isAlternative: p.isAlternative, referenceId: p.referenceId, altIndex: p.altIndex,
      // インスタンスそのもの（undo スタックの編集エントリが graph を掴んでいるため、復活は同じ instance で行う）
      plane: p, graph: project.graphMap.get(p.id),
      bytes: await getBytes(p.id),
    });
  }
  return records;
}

// 消えた平面を同じ id で作り直し、バイト列を IDB へ書く（階削除の undo／失敗時の巻き戻し）。
// 採用階→検討案（altIndex 昇順）の順。既に存在する id は触らない（巻き戻しで再入しても重複しない）。
// records が Plane／PlanGraph のインスタンスを持つとき（collectRemovalRecords の戻り値）は同じインスタンスを
// project.restorePlane で戻す——削除前の編集の undo エントリ（graph を掴む）が復活した階に効く。インスタンスが
// 無い記録だけ addFloor／addAlternativeFloor で作り直す（store.js のもの。本モジュールは store.js を引かないため注入）。
// 既知の限界: 削除中に編集した分の履歴は無い（削除前の履歴は戻る）。
export async function restoreRemovedPlanes(project, records, { addFloor, addAlternativeFloor, saveFloorFn = saveFloor }) {
  const ordered = [
    ...records.filter(r => !r.isAlternative),
    ...records.filter(r => r.isAlternative).sort((a, b) => a.altIndex - b.altIndex),
  ];
  for (const r of ordered) {
    if (project.planeMap.has(r.id)) continue;
    if (r.plane && r.graph) {
      project.restorePlane(r.plane, r.graph); // 同じ Plane／PlanGraph インスタンスを戻す
    } else if (!r.isAlternative) {
      addFloor(r.elevation, r.name, r.startFloor, r.stories, r.id, r.planCutHeightMm, r.ceilingCutHeightMm, r.topStoryHeightMm);
    } else if (!addAlternativeFloor(r.referenceId, r.name, undefined, r.id, r.altIndex)) {
      throw new Error(`検討案 ${r.id} の親の採用階 ${r.referenceId} が無く作り直せない`);
    }
    applyPlaneMetas(project, [r]); // 検討案は親の elevation 等で作られるため、記録した値へ揃える
    if (r.bytes != null) await saveFloorFn(r.id, r.bytes);
  }
}

// 階削除の redo: removedPlanes の採用階を（検討案ごと）消す。対象（とその検討案）を表示中なら switchTo(id)
// で pickRemovalFallback の階へ退避し、なお表示中なら（切替失敗）アクティブ階を消さず false を返して中断する
// （F1・2026-09-27）。removeFloorFn は store.js removeFloor、switchTo は App.jsx の trySwitchFloor 経由の切替。
// 戻り値: 全て消せたら true。
export async function removePlanesForRedo(project, removedPlanes, activeAfterId, { removeFloorFn, switchTo }) {
  for (const r of removedPlanes) {
    if (r.isAlternative || !project.planeMap.has(r.id)) continue;
    if (blocksFloorRemoval(project, r.id)) {
      const fallbackId = pickRemovalFallback(project, r.id, activeAfterId);
      if (fallbackId) await switchTo(fallbackId);
      if (blocksFloorRemoval(project, r.id)) return false;
    }
    await removeFloorFn(r.id);
  }
  return true;
}

// 階削除の redo で、対象の階を表示中のとき退避する先。preferredId（最初の削除後に表示していた階）が
// 今も有り、対象とその検討案でなければそれ。無ければ runDeleteFloor と同じ規則（直上の採用階、無ければ直下）。
export function pickRemovalFallback(project, planeId, preferredId) {
  const preferred = preferredId ? project.planeMap.get(preferredId) : null;
  if (preferred && preferred.id !== planeId && !(preferred.isAlternative && preferred.referenceId === planeId)) {
    return preferred.id;
  }
  const adopted = project.planes;
  const idx = adopted.findIndex(p => p.id === planeId);
  return (adopted[idx + 1] ?? adopted[idx - 1])?.id ?? null;
}

// ---- project 単位の高さ設定（GL）の収集・復元（階設定表。階操作の undo/redo が Plane メタと一緒に使う）----
// glBelow1FlMm＝GL は 1FL からの下がり量（負＝GL が 1FL より上）。Plane に属さないので collectPlaneMetas とは別。
// basementStructure＝建物全体の地階構造（StructuralInfo。下階追加が初期値を書くので undo/redo で戻す。S5c-2）。
// キーが無い levels（旧形の記録）では触らない。
export function collectProjectLevels(project) {
  return {
    glBelow1FlMm: project.glBelow1FlMm,
    basementStructure: project.structuralInfo?.basementStructure ?? null,
  };
}

export function applyProjectLevels(project, levels) {
  if (!levels) return;
  project.setGlBelow1FlMm(levels.glBelow1FlMm);
  if ('basementStructure' in levels) {
    runInAction(() => project.structuralInfo.setBasementStructure(levels.basementStructure ?? null));
  }
}

/**
 * 階操作（rollbackOnError 指定）が途中で失敗したときの巻き戻し。操作前のメタ・GL を戻し、屋根専用平面を
 * 最上階へ追従させ、バイト列が変わった階を操作前へ戻す。メタ・GL・屋根は同期で先に戻す（バイト列の採取が
 * 失敗しても残さない）。バイト列: アクティブ階はメモリ（applyBytes）と IDB（saveFloorFn）の両方へ（失敗した
 * 操作が途中で自階を IDB へ書いていることがある）、非アクティブ階は IDB へ await して書く（投げ放しで
 * 関門を抜けない）。操作前に未保存（null）だった階は IDB のレコードを消す。最後に afterApply を1回呼ぶ。
 * 既知の限界: 屋根専用平面のバイト列と structGraph は階操作の undo と同じく対象外。
 * @param {object} project
 * 階削除（removalBefore＝collectRemovalRecords の戻り値、restoreRemoved＝App.jsx が addFloor 等を束ねた
 * restoreRemovedPlanes）のときは、project から消えた平面を作り直し、残っている平面（removeFloor が IDB を
 * 途中まで消して失敗した場合）の IDB バイト列も書き戻す。
 * @param {{before:Map, metasBefore:Array, levelsBefore:object, collectBytes:()=>Promise<Map>,
 *   followRoof:(project)=>void, afterApply?:()=>void,
 *   removalBefore?:Array, restoreRemoved?:(project, records)=>Promise<void>,
 *   applyBytes?:Function, saveFloorFn?:Function, deleteFloorFn?:Function}} args
 */
export async function rollbackFloorOp(project, {
  before, metasBefore, levelsBefore, collectBytes, followRoof, afterApply, removalBefore, restoreRemoved,
  applyBytes = applyFloorBytes, saveFloorFn = saveFloor, deleteFloorFn = dbDeleteFloor,
}) {
  applyPlaneMetas(project, metasBefore);
  applyProjectLevels(project, levelsBefore);
  followRoof(project);
  try {
    if (removalBefore?.length) {
      const surviving = removalBefore.filter(r => project.planeMap.has(r.id) && r.id !== project.activePlaneId);
      await restoreRemoved(project, removalBefore);
      followRoof(project);
      for (const r of surviving) if (r.bytes != null) await saveFloorFn(r.id, r.bytes);
    }
    const failedAfter = await collectBytes();
    for (const [planeId, beforeBytes] of before) {
      if (!failedAfter.has(planeId) || floorBytesEqual(beforeBytes, failedAfter.get(planeId))) continue;
      if (planeId === project.activePlaneId && project.activeGraph && beforeBytes != null) {
        applyBytes(project, planeId, beforeBytes);
      }
      if (beforeBytes != null) await saveFloorFn(planeId, beforeBytes);
      else await deleteFloorFn(planeId);
    }
  } finally {
    await afterApply?.(); // バイト列の採取・書戻しが失敗しても、戻したメタに合わせて図は作り直す
  }
}

function projectLevelsEqual(a, b) {
  if (!a || !b) return !a && !b; // 片方だけ渡された＝比較不能。両方省略のときだけ「同じ」
  return a.glBelow1FlMm === b.glBelow1FlMm && (a.basementStructure ?? null) === (b.basementStructure ?? null);
}

function planeMetasEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.id !== y.id || x.name !== y.name || x.startFloor !== y.startFloor
      || x.elevation !== y.elevation || x.stories !== y.stories
      || x.planCutHeightMm !== y.planCutHeightMm
      || x.ceilingCutHeightMm !== y.ceilingCutHeightMm
      || x.topStoryHeightMm !== y.topStoryHeightMm) return false;
  }
  return true;
}

// metas（collectPlaneMetasの戻り値、または renumberPlanesFrom 系の更新一覧）を project.planeMap へ
// 書き戻す。project.planeMap に存在しない id は無視する（undoで追加階を削除した後に呼ぶため、
// metas側にだけ存在するidがあり得る）。stories が undefined のエントリ（renumberPlanesFrom 系の
// 更新一覧はstoriesを持たない）では stories を書かない（途中階の上階追加と階移動の振り直し
// 一本化 ステップ3。runReorderFloor・runFloorChange・runDeleteFloorの振り直しループも
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
      if (m.planCutHeightMm !== undefined) plane.planCutHeightMm = m.planCutHeightMm; // undefined なら触らない
      if (m.ceilingCutHeightMm !== undefined) plane.ceilingCutHeightMm = m.ceilingCutHeightMm; // 同上
      if (m.topStoryHeightMm !== undefined) plane.topStoryHeightMm = m.topStoryHeightMm; // 同上
    }
  });
}
