// ================================================================
// スナップショットのカタログコード正規化（4.6→ステップ7a: 種別化）。
//
// 正規化表の入力は2つ: (1) 本体の振り直し表（legacyMaterialCodes.js・material種別のみの既定入力。
// 他種別は空表）、(2) 文書固有の読み替え（束の aliases。R8の内容一致・4.6.1の承認で積む）。
// 参照値そのものを直す方式に一本化する（解決のたびに表を引く経路は作らない）。
//
// ステップ7a: alias状態・正規化表・未解決コードの蓄積を種別（kind）ごとに持つ。参照の
// 「どのフィールドが対象か」は SNAPSHOT_REF_WALKERS（kind → {enumerate, rewrite}）に集約する——
// catalog/usedEntries.js collectUsedKeys がこの enumerate を共有する（二重実装を作らない）。
//
// ゼロ依存の葉モジュール（legacyMaterialCodes.js だけ import可）。
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

/** table でコード1件を正規化する（種別非依存の共通ロジック）。 */
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
// material: 材コード参照4系統の「対象かどうか」の判定（唯一の定義箇所）。
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
// interiorMaster: rooms[].templateKey・boundaryMaster: edges[].masterType の
// enumerate/rewrite（material と同じ normalizeCode を共有する）。
// ----------------------------------------------------------------
function enumerateInteriorMasterRefs(snapshot) {
  if (!snapshot) return [];
  const refs = [];
  for (const room of snapshot.rooms ?? []) {
    if (room?.templateKey) refs.push({ code: room.templateKey, location: 'room', roomId: room.id });
  }
  return refs;
}

function normalizeRoomTemplateKeys(rooms, table, unresolved) {
  if (!Array.isArray(rooms)) return rooms;
  let changedAny = false;
  const next = rooms.map(room => {
    if (!room?.templateKey) return room;
    const mapped = normalizeCode(room.templateKey, table, unresolved, { location: 'room', roomId: room.id });
    if (mapped === room.templateKey) return room;
    changedAny = true;
    return { ...room, templateKey: mapped };
  });
  return changedAny ? next : rooms;
}

function rewriteInteriorMasterRefs(snapshot, table) {
  if (!snapshot) return { snapshot, unresolved: [] };
  const unresolved = [];
  const rooms = normalizeRoomTemplateKeys(snapshot.rooms, table, unresolved);
  if (rooms === snapshot.rooms) return { snapshot, unresolved };
  return { snapshot: { ...snapshot, rooms }, unresolved };
}

function enumerateBoundaryMasterRefs(snapshot) {
  if (!snapshot) return [];
  const refs = [];
  for (const edge of snapshot.edges ?? []) {
    if (edge?.masterType) refs.push({ code: edge.masterType, location: 'edge', edgeKey: edge.key });
  }
  return refs;
}

function normalizeEdgeMasterTypes(edges, table, unresolved) {
  if (!Array.isArray(edges)) return edges;
  let changedAny = false;
  const next = edges.map(edge => {
    if (!edge?.masterType) return edge;
    const mapped = normalizeCode(edge.masterType, table, unresolved, { location: 'edge', edgeKey: edge.key });
    if (mapped === edge.masterType) return edge;
    changedAny = true;
    return { ...edge, masterType: mapped };
  });
  return changedAny ? next : edges;
}

function rewriteBoundaryMasterRefs(snapshot, table) {
  if (!snapshot) return { snapshot, unresolved: [] };
  const unresolved = [];
  const edges = normalizeEdgeMasterTypes(snapshot.edges, table, unresolved);
  if (edges === snapshot.edges) return { snapshot, unresolved };
  return { snapshot: { ...snapshot, edges }, unresolved };
}

// ----------------------------------------------------------------
// section: columns/beams/structuralWalls/slabs/footings[].sectionDefId・
// openingSubType: openings[] の `${category}:${subType}`（catalogKinds.js の keyOf と同型）。
// どちらも現状は読み取り専用（rewrite:null。ステップ8/10で参照の書換え先を実装するまでは
// 書換えの入口を持たない——alias を積もうとしたら例外にする＝黙って効かないaliasを作らない）。
// ----------------------------------------------------------------
const SECTION_MEMBER_LISTS = ['columns', 'beams', 'structuralWalls', 'slabs', 'footings'];

function enumerateSectionRefs(snapshot) {
  if (!snapshot) return [];
  const refs = [];
  for (const listName of SECTION_MEMBER_LISTS) {
    for (const member of snapshot[listName] ?? []) {
      if (member?.sectionDefId) refs.push({ code: member.sectionDefId, location: listName, memberId: member.id });
    }
  }
  return refs;
}

function enumerateOpeningSubTypeRefs(snapshot) {
  if (!snapshot) return [];
  const refs = [];
  for (const opening of snapshot.openings ?? []) {
    if (opening?.category && opening?.subType) {
      refs.push({ code: `${opening.category}:${opening.subType}`, location: 'opening', openingId: opening.id });
    }
  }
  return refs;
}

/**
 * 参照所在の唯一の集約点（kind → {enumerate(snapshot), rewrite(snapshot, table)|null}）。
 * enumerate は catalog/usedEntries.js collectUsedKeys（保存時の使用キー収集）と
 * applyDocumentCodeNormalization の unresolved 検出が共有する。rewrite が null の種別は
 * まだ参照の書換え先を持たない（section=ステップ8・openingSubType=ステップ10）——
 * setDocumentAliases/addDocumentAliases でその種別に非空のaliasesを積もうとすると例外になる。
 */
export const SNAPSHOT_REF_WALKERS = Object.freeze({
  material: Object.freeze({
    enumerate: enumerateMaterialCodeRefs,
    rewrite: (snapshot, table) => normalizeSnapshotCodes(snapshot, table),
  }),
  interiorMaster: Object.freeze({
    enumerate: enumerateInteriorMasterRefs,
    rewrite: rewriteInteriorMasterRefs,
  }),
  boundaryMaster: Object.freeze({
    enumerate: enumerateBoundaryMasterRefs,
    rewrite: rewriteBoundaryMasterRefs,
  }),
  section: Object.freeze({
    enumerate: enumerateSectionRefs,
    rewrite: null,
  }),
  openingSubType: Object.freeze({
    enumerate: enumerateOpeningSubTypeRefs,
    rewrite: null,
  }),
});

// ----------------------------------------------------------------
// 文書単位の正規化表（種別ごと。読込み時に1回設定し、各階がデコードされるたびに適用する）。
//
// 文書固有の読み替え（束の aliases[kind]）は catalogOverlayLoader.js（読込み時）・
// catalog/incomingReconcile.js（起動時照合。ステップ6-1）が setDocumentAliases/
// addDocumentAliases を通して設定する。その段階でも本体の振り直し表
// （LEGACY_MATERIAL_CODE_ALIASES。material種別のみの既定入力）だけは常に効かせる——
// 「表が未設定＝正規化しない」ではなく「表が未設定＝本体表だけで正規化する」が既定
// （2026-09-22 裁定）。setDocumentAliases(kind, null) は文書固有の上書きを解除するだけで、
// 本体表による正規化そのものは止めない。material以外の種別は本体表が空（{}）——文書固有の
// 読み替えが無ければ実質no-op。
//
// 状態はkindごとにMapで持つ（documentAliasesByKind が生の {from:to}・documentCodeTableByKind は
// それから導出したMap）。setDocumentCodeTable は低レベルAPIとして残す（catalogOverlayLoader.js
// の失敗路の巻き戻し等、表そのものを直接扱いたい呼び出しのため）。
// ----------------------------------------------------------------
const documentAliasesByKind = new Map(); // kind -> 生の読み替え表（後からaddDocumentAliasesで追記される）
const documentCodeTableByKind = new Map(); // kind -> Map|null（明示設定された表）
const defaultCodeTableByKind = new Map(); // kind -> buildCodeTable({legacy: legacyTableFor(kind)}) の遅延キャッシュ
let unresolvedAccumulator = [];
// 重複排除キー（kind+code+location）の集合。同じ箇所（例: 同一フィールド名・room/edge/
// clEccentricityの種別）が繰り返し未解決になっても単調増加させない。
let unresolvedKeys = new Set();

function requireKind(kind) {
  if (kind === undefined) {
    throw new Error('カタログ種別(kind)の指定は必須です（省略できません）');
  }
  if (!SNAPSHOT_REF_WALKERS[kind]) {
    throw new Error(`未知のカタログ種別です: ${kind}`);
  }
}

/** kindの本体振り直し表の既定入力。material のみ LEGACY_MATERIAL_CODE_ALIASES、他は空表。 */
function legacyTableFor(kind) {
  return kind === 'material' ? LEGACY_MATERIAL_CODE_ALIASES : {};
}

function defaultCodeTableFor(kind) {
  if (!defaultCodeTableByKind.has(kind)) {
    defaultCodeTableByKind.set(kind, buildCodeTable({ legacy: legacyTableFor(kind) }));
  }
  return defaultCodeTableByKind.get(kind);
}

function effectiveCodeTable(kind) {
  const override = documentCodeTableByKind.get(kind);
  if (override) return override;
  return defaultCodeTableFor(kind);
}

function unresolvedDedupeKey(kind, u) {
  return `${kind}::${u.code}::${u.location}`;
}

/**
 * 読込み時に文書固有の正規化表を設定する（低レベルAPI。表は消さずに持ち続ける。
 * 閉じるときは null で解除）。documentAliasesByKind（生の読み替え表）とは独立に表だけを
 * 直接差し替えたい呼び出し（catalogOverlayLoader.js の失敗路の巻き戻し等）のために残す。
 * @param {string} kind
 * @param {Map<string,string|null>|null} table
 */
export function setDocumentCodeTable(kind, table) {
  requireKind(kind);
  if (table == null) documentCodeTableByKind.delete(kind);
  else documentCodeTableByKind.set(kind, table);
}

/** kindに現在設定されている文書固有の正規化表（未設定は null）。 */
export function currentCodeTable(kind) {
  requireKind(kind);
  return documentCodeTableByKind.get(kind) ?? null;
}

/**
 * 読込み時に文書固有の読み替え（束の aliases[kind] 相当。生の {from:to}）を設定する。
 * 内部で setDocumentCodeTable(kind, buildCodeTable({ legacy: legacyTableFor(kind), aliases })) を
 * 組み立てて即座に反映する（文書固有表の唯一の入口）。null を渡すと文書固有の読み替えを解除する
 * （本体の振り直し表はこの操作では止まらない——effectiveCodeTable の既定と同じ）。
 * SNAPSHOT_REF_WALKERS[kind].rewrite が null（参照の書換え先が未実装）の種別へ非空の aliases を
 * 積もうとすると例外——黙って効かない alias を作らないため。
 * @param {string} kind
 * @param {object|null} aliasesOrNull
 */
export function setDocumentAliases(kind, aliasesOrNull) {
  requireKind(kind);
  const next = aliasesOrNull ?? {};
  const hasAliases = Object.keys(next).length > 0;
  if (hasAliases && !SNAPSHOT_REF_WALKERS[kind].rewrite) {
    throw new Error(`種別「${kind}」は参照の読み替え（alias）にまだ対応していません`);
  }
  documentAliasesByKind.set(kind, next);
  // aliasesが空なら「文書固有の上書きなし」= documentCodeTableをnullに戻し、effectiveCodeTable()の
  // 遅延キャッシュ（defaultCodeTableByKind）へ委ねる（従来のsetDocumentCodeTable(kind, null)と同じ既定）。
  setDocumentCodeTable(kind, hasAliases ? buildCodeTable({ legacy: legacyTableFor(kind), aliases: next }) : null);
}

/** kindの現在の文書固有の読み替え（生の {from:to}。未設定時は空オブジェクト）。 */
export function currentDocumentAliases(kind) {
  requireKind(kind);
  return documentAliasesByKind.get(kind) ?? {};
}

/**
 * kindの文書固有の読み替えへ {from,to} の組を追記し、正規化表を作り直す（後効き）。
 * 既存の documentAliasesByKind に後勝ちでマージする——連鎖（a→b, b→c）はbuildCodeTableが
 * 潰し、循環は例外を投げる（buildCodeTableと同じ規約）。rewrite:null の種別への例外は
 * setDocumentAliases 経由で同じく発生する。
 * @param {string} kind
 * @param {Array<{from: string, to: string}>} pairs
 */
export function addDocumentAliases(kind, pairs) {
  requireKind(kind);
  const current = documentAliasesByKind.get(kind) ?? {};
  const next = { ...current };
  for (const { from, to } of pairs ?? []) next[from] = to;
  setDocumentAliases(kind, next);
}

/** 全種別の文書固有の読み替え・正規化表を解除する（本体の振り直し表は止まらない）。 */
export function clearDocumentAliases() {
  for (const kind of Object.keys(SNAPSHOT_REF_WALKERS)) {
    documentAliasesByKind.delete(kind);
    documentCodeTableByKind.delete(kind);
  }
}

/** これまでに蓄積した未解決コードを非破壊で覗く（takeUnresolvedCodesと違い蓄積をリセットしない）。 */
export function peekUnresolvedCodes() {
  return [...unresolvedAccumulator];
}

/**
 * 実効中の正規化表を snapshot に適用する（全種別。文書固有の表が無ければ種別ごとの
 * 本体表だけで正規化する。material以外は本体表が空のため、文書固有の読み替えが無ければ
 * 実質no-op）。rewrite:null の種別（section/openingSubType）はここでは読み飛ばす
 * （書換え先が無いため。enumerateは別途 collectUsedKeys 等が使う）。
 * 未解決コードは kind+code+location（`unresolvedDedupeKey`）で重複排除して蓄積する——同じ
 * snapshot（階）を繰り返し適用しても（undo/redo・再読込み等）蓄積が単調増加しない。
 * 署名は変更しない（呼び出し側=graphSnapshot.js は snapshot だけを渡す）。
 */
export function applyDocumentCodeNormalization(snapshot) {
  let current = snapshot;
  for (const kind of Object.keys(SNAPSHOT_REF_WALKERS)) {
    const walker = SNAPSHOT_REF_WALKERS[kind];
    if (!walker.rewrite) continue;
    const table = effectiveCodeTable(kind);
    if (!table || table.size === 0) continue;
    const { snapshot: next, unresolved } = walker.rewrite(current, table);
    current = next;
    for (const u of unresolved) {
      const key = unresolvedDedupeKey(kind, u);
      if (unresolvedKeys.has(key)) continue;
      unresolvedKeys.add(key);
      unresolvedAccumulator.push({ kind, ...u });
    }
  }
  return current;
}

/** これまでに蓄積した未解決コードを取り出し、蓄積（重複排除キーも含め）をリセットする。 */
export function takeUnresolvedCodes() {
  const taken = unresolvedAccumulator;
  unresolvedAccumulator = [];
  unresolvedKeys = new Set();
  return taken;
}
