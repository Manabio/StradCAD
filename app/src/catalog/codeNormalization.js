// ================================================================
// スナップショットの材コード正規化（4.6）。
//
// 正規化表の入力は2つ: (1) 本体の振り直し表（legacyMaterialCodes.js・全文書共通）、
// (2) 文書固有の読み替え（束の aliases。R8の内容一致・4.6.1の承認で積む）。
// 参照値そのものを直す方式に一本化する（解決のたびに表を引く経路は作らない）。
//
// ゼロ依存の葉モジュール（legacyMaterialCodes.js だけ import可）。
// graphSnapshot.js へはまだ繋がない（接続はステップ3）。
// ================================================================

import { LEGACY_MATERIAL_CODE_ALIASES } from './legacyMaterialCodes.js';

/**
 * {legacy, aliases} → 潰し済みの読み替え表 Map<旧コード, 新コード|null>。
 * 文書側(aliases)が後勝ち。連鎖（a→b, b→c）は構築時に a→c へ潰す。循環は例外。
 */
export function buildCodeTable({ legacy = LEGACY_MATERIAL_CODE_ALIASES, aliases = {} } = {}) {
  const raw = new Map();
  for (const [from, to] of Object.entries(legacy)) raw.set(from, to);
  for (const [from, to] of Object.entries(aliases)) raw.set(from, to); // 文書側後勝ち

  const resolved = new Map();
  for (const from of raw.keys()) resolved.set(from, resolveChain(from, raw));
  return resolved;
}

function resolveChain(start, raw) {
  let current = start;
  const path = new Set([start]);
  for (;;) {
    if (!raw.has(current)) return current;
    const next = raw.get(current);
    if (next === null) return null; // 削除・廃止まで潰す
    if (path.has(next)) throw new Error(`カタログコードの読み替えが循環しています: ${start}`);
    path.add(next);
    current = next;
  }
}

function normalizeCode(code, table, unresolved, context) {
  if (!table.has(code)) return code;
  const target = table.get(code);
  if (target === null) {
    unresolved.push({ code, ...context });
    return code; // 解決できないので値は据え置き、unresolvedへ積む
  }
  return target;
}

// ----------------------------------------------------------------
// 材コード参照4系統の「対象かどうか」の判定（唯一の定義箇所）。
// normalizeSnapshotCodes（変換）と catalog/usedEntries.js の collectUsedMaterialCodes（保存時の
// 使用コード収集）が同じ判定を共有する——一方だけ直して他方が古いまま、という分岐を防ぐため
// （enumerateMaterialCodeRefs が両方の唯一の入口）。
// ----------------------------------------------------------------
const BACKING_FIELDS = ['exteriorWallBacking', 'interiorWallBacking', 'ceilingBacking', 'floorBacking'];

function isRoomMaterialOverride(ov) {
  return !!ov && (ov.key === 'wallMaterial' || ov.key === 'wallFinish');
}

function isEdgeMaterialOverride(ov) {
  return !!ov && typeof ov.value === 'string' && /^\d{12}$/.test(ov.value);
}

function isNormalizableEccentricity(item) {
  // backing==='' は per-floor 既定の合図（4.4のD裁定）——対象にしない。
  return !!item && item.backing !== '' && item.backing != null;
}

/**
 * snapshot 内の材コード参照4系統（4フィールド・rooms[].overrides・edges[].overrides・
 * clEccentricities[].backing）を読み取り専用で列挙する（変換はしない）。
 * @returns {Array<{code: string, location: string, [key: string]: unknown}>}
 */
export function enumerateMaterialCodeRefs(snapshot) {
  if (!snapshot) return [];
  const refs = [];
  for (const field of BACKING_FIELDS) {
    const code = snapshot[field];
    if (code == null) continue;
    refs.push({ code, location: field });
  }
  for (const room of snapshot.rooms ?? []) {
    for (const ov of room?.overrides ?? []) {
      if (!isRoomMaterialOverride(ov)) continue;
      refs.push({ code: ov.value, location: 'room', roomId: room.id, key: ov.key });
    }
  }
  for (const edge of snapshot.edges ?? []) {
    for (const ov of edge?.overrides ?? []) {
      if (!isEdgeMaterialOverride(ov)) continue;
      refs.push({ code: ov.value, location: 'edge', edgeKey: edge.key, key: ov.key });
    }
  }
  for (const item of snapshot.clEccentricities ?? []) {
    if (!isNormalizableEccentricity(item)) continue;
    refs.push({ code: item.backing, location: 'clEccentricity', clId: item.clId });
  }
  return refs;
}

function normalizeRooms(rooms, table, unresolved) {
  if (!Array.isArray(rooms)) return rooms;
  let changedAny = false;
  const next = rooms.map(room => {
    const overrides = room?.overrides;
    if (!Array.isArray(overrides)) return room;
    let changed = false;
    const nextOverrides = overrides.map(ov => {
      if (!isRoomMaterialOverride(ov)) return ov;
      const mapped = normalizeCode(ov.value, table, unresolved, { location: 'room', roomId: room.id, key: ov.key });
      if (mapped === ov.value) return ov;
      changed = true;
      return { ...ov, value: mapped };
    });
    if (!changed) return room;
    changedAny = true;
    return { ...room, overrides: nextOverrides };
  });
  return changedAny ? next : rooms;
}

function normalizeEdges(edges, table, unresolved) {
  if (!Array.isArray(edges)) return edges;
  let changedAny = false;
  const next = edges.map(edge => {
    const overrides = edge?.overrides;
    if (!Array.isArray(overrides)) return edge;
    let changed = false;
    const nextOverrides = overrides.map(ov => {
      if (!isEdgeMaterialOverride(ov)) return ov;
      const mapped = normalizeCode(ov.value, table, unresolved, { location: 'edge', edgeKey: edge.key, key: ov.key });
      if (mapped === ov.value) return ov;
      changed = true;
      return { ...ov, value: mapped };
    });
    if (!changed) return edge;
    changedAny = true;
    return { ...edge, overrides: nextOverrides };
  });
  return changedAny ? next : edges;
}

function normalizeEccentricities(list, table, unresolved) {
  if (!Array.isArray(list)) return list;
  let changedAny = false;
  const next = list.map(item => {
    if (!isNormalizableEccentricity(item)) return item;
    const mapped = normalizeCode(item.backing, table, unresolved, { location: 'clEccentricity', clId: item.clId });
    if (mapped === item.backing) return item;
    changedAny = true;
    return { ...item, backing: mapped };
  });
  return changedAny ? next : list;
}

/**
 * snapshot 内の材コード参照4系統（4フィールド・rooms[].overrides・edges[].overrides・
 * clEccentricities[].backing）を table で正規化する。非破壊（copy-on-write）。
 * 変化が無ければ snapshot は同一参照のまま返す。table の値が null（削除・廃止）の場合は
 * 値を据え置き、その箇所を unresolved に積む。
 * @returns {{ snapshot: object, unresolved: Array<object> }}
 */
export function normalizeSnapshotCodes(snapshot, table) {
  if (!snapshot) return { snapshot, unresolved: [] };
  if (table == null) return { snapshot, unresolved: [] }; // 表なし＝no-op（既存の合図）
  if (!(table instanceof Map)) throw new Error('コード正規化表はMapである必要があります');
  if (table.size === 0) return { snapshot, unresolved: [] };

  const unresolved = [];
  let changed = false;

  const backingFields = {};
  for (const field of BACKING_FIELDS) {
    const code = snapshot[field];
    if (code == null) { backingFields[field] = code; continue; }
    const mapped = normalizeCode(code, table, unresolved, { location: field });
    if (mapped !== code) changed = true;
    backingFields[field] = mapped;
  }

  const rooms = normalizeRooms(snapshot.rooms, table, unresolved);
  if (rooms !== snapshot.rooms) changed = true;

  const edges = normalizeEdges(snapshot.edges, table, unresolved);
  if (edges !== snapshot.edges) changed = true;

  const clEccentricities = normalizeEccentricities(snapshot.clEccentricities, table, unresolved);
  if (clEccentricities !== snapshot.clEccentricities) changed = true;

  if (!changed) return { snapshot, unresolved };
  return { snapshot: { ...snapshot, ...backingFields, rooms, edges, clEccentricities }, unresolved };
}

// ----------------------------------------------------------------
// 文書単位の正規化表（読込み時に1回設定し、各階がデコードされるたびに適用する）。
//
// 文書固有の読み替え（束の aliases）はまだどこからも setDocumentCodeTable() を呼ばない
// （束の読込み経路への接続は後続ステップ）。その段階でも本体の振り直し表
// （LEGACY_MATERIAL_CODE_ALIASES）だけは常に効かせる——「表が未設定＝正規化しない」ではなく
// 「表が未設定＝本体表だけで正規化する」が既定（2026-09-22 裁定）。setDocumentCodeTable(null) は
// 文書固有の上書きを解除するだけで、本体表による正規化そのものは止めない。
// ----------------------------------------------------------------
let documentCodeTable = null;
let defaultCodeTable = null; // buildCodeTable({}) の遅延キャッシュ（本体表のみ・不変）
let unresolvedAccumulator = [];
// 重複排除キー（code+location）の集合。同じ箇所（例: 同一フィールド名・room/edge/clEccentricityの種別）
// が繰り返し未解決になっても単調増加させない（ステップ6の消費者が付くまでの暫定対応。
// 2026-09-22 QAコメント: 消費者側の実装までは「どのコード・どの箇所種別が未解決か」が分かれば
// 十分で、件数そのものに意味を持たせない）。
let unresolvedKeys = new Set();

function unresolvedDedupeKey(u) {
  return `${u.code}::${u.location}`;
}

function effectiveCodeTable() {
  if (documentCodeTable) return documentCodeTable;
  if (!defaultCodeTable) defaultCodeTable = buildCodeTable({});
  return defaultCodeTable;
}

/** 読込み時に文書固有の正規化表を設定する（表は消さずに持ち続ける。閉じるときは null で解除）。 */
export function setDocumentCodeTable(table) {
  documentCodeTable = table ?? null;
}

/** 現在設定されている文書固有の正規化表（未設定は null。既定＝本体表の適用有無はこの値では分からない）。 */
export function currentCodeTable() {
  return documentCodeTable;
}

/**
 * 実効中の正規化表を snapshot に適用する（文書固有の表が無ければ本体表だけで正規化する）。
 * 未解決コードは code+location（`unresolvedDedupeKey`）で重複排除して蓄積する——同じ snapshot
 * （階）を繰り返し適用しても（undo/redo・再読込み等）蓄積が単調増加しない。
 */
export function applyDocumentCodeNormalization(snapshot) {
  const { snapshot: next, unresolved } = normalizeSnapshotCodes(snapshot, effectiveCodeTable());
  for (const u of unresolved) {
    const key = unresolvedDedupeKey(u);
    if (unresolvedKeys.has(key)) continue;
    unresolvedKeys.add(key);
    unresolvedAccumulator.push(u);
  }
  return next;
}

/** これまでに蓄積した未解決コードを取り出し、蓄積（重複排除キーも含め）をリセットする。 */
export function takeUnresolvedCodes() {
  const taken = unresolvedAccumulator;
  unresolvedAccumulator = [];
  unresolvedKeys = new Set();
  return taken;
}
