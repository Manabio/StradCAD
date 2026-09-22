// ================================================================
// 保存時の使用エントリ収集（4.3・4.5-3・ステップ4）。
//
// codeNormalization.js の走査器（enumerateMaterialCodeRefs）を共有する——材コードの
// 「どのフィールドが対象か」を二重実装しない（走査器を壊すと codeNormalization.test.js と
// usedEntries.test.js の両方が赤くなる）。
//
// 葉モジュール。codeNormalization.js・materialCode.js・catalogKinds.js・catalogBundle.js
// （いずれも葉）にのみ依存する。store.js / snap.js / .jsx を静的 import しない。
// ================================================================

import { enumerateMaterialCodeRefs, SNAPSHOT_REF_WALKERS } from './codeNormalization.js';
import { isMaterialCode } from './materialCode.js';
import { kindDef } from './catalogKinds.js';
import { emptyBundle, withEntries, bundleEntries } from './catalogBundle.js';

/**
 * snapshot（1階分）が参照する材コードを Set で返す（12桁数字として不正な値は含めない）。
 * @param {object} snapshot
 * @returns {Set<string>}
 */
export function collectUsedMaterialCodes(snapshot) {
  const codes = new Set();
  for (const ref of enumerateMaterialCodeRefs(snapshot)) {
    if (isMaterialCode(ref.code)) codes.add(ref.code);
  }
  return codes;
}

/**
 * snapshot（1階分）が参照するカタログキーを種別ごとに収集する。走査は
 * codeNormalization.js の SNAPSHOT_REF_WALKERS（kind → enumerate）を共有する——
 * 「どのフィールドが対象か」を二重実装しない（collectUsedMaterialCodesが
 * enumerateMaterialCodeRefsを共有しているのと同型）。
 * - interiorMaster: rooms[].templateKey
 * - boundaryMaster: edges[].masterType
 * - section: columns/beams/structuralWalls/slabs/footings の sectionDefId
 * - openingSubType: openings[] の `${category}:${subType}`（catalogKinds.js の keyOf と同型）
 * @returns {{ interiorMaster: Set<string>, boundaryMaster: Set<string>, section: Set<string>, openingSubType: Set<string> }}
 */
export function collectUsedKeys(snapshot) {
  const interiorMaster = new Set();
  const boundaryMaster = new Set();
  const section = new Set();
  const openingSubType = new Set();
  if (!snapshot) return { interiorMaster, boundaryMaster, section, openingSubType };

  for (const ref of SNAPSHOT_REF_WALKERS.interiorMaster.enumerate(snapshot)) interiorMaster.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.boundaryMaster.enumerate(snapshot)) boundaryMaster.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.section.enumerate(snapshot)) section.add(ref.code);
  for (const ref of SNAPSHOT_REF_WALKERS.openingSubType.enumerate(snapshot)) openingSubType.add(ref.code);

  return { interiorMaster, boundaryMaster, section, openingSubType };
}

/**
 * 使用材コードの集合に、内装マスター・境界マスターが内部で参照する材コードを推移的に追加する
 * （4.3）。LAYER_SOURCE の層（実行時解決）は辿らない——固定コード（layer.code）だけを見る
 * （ステップ7b）。理由: LAYER_SOURCE.FLOOR_EXTERIOR_BACKING/FLOOR_INTERIOR_BACKING の実体は
 * graph.exteriorWallBacking/interiorWallBacking（codeNormalization.js BACKING_FIELDS 経由で
 * collectUsedMaterialCodes が既に収集済み）、ROOM_WALL_MATERIAL/ROOM_FINISH の実体は
 * room.customOverrides の wallMaterial/wallFinish（同じく isRoomMaterialOverride 経由で
 * 別経路収集済み）——ここで LAYER_SOURCE を辿ると同じ材コードを二重収集するだけになる。
 * @param {Set<string>|Iterable<string>} codes 直接参照された材コード
 * @param {{ interiorMasters?: Iterable<{wallMaterial?: string, wallFinish?: string}>,
 *           boundaryMasters?: Iterable<{layers?: Array<{code?: string|null}>}> }} used
 *        使用されている（解決済みの）内装・境界マスターのエントリ本体
 * @returns {Set<string>}
 */
export function expandTransitiveMaterials(codes, { interiorMasters = [], boundaryMasters = [] } = {}) {
  const expanded = new Set(codes);
  for (const master of interiorMasters) {
    if (isMaterialCode(master?.wallMaterial)) expanded.add(master.wallMaterial);
    if (isMaterialCode(master?.wallFinish)) expanded.add(master.wallFinish);
  }
  for (const master of boundaryMasters) {
    for (const layer of master?.layers ?? []) {
      if (isMaterialCode(layer?.code)) expanded.add(layer.code);
    }
  }
  return expanded;
}

/**
 * 使用キー（種別ごと）と解決済みMap（種別ごと。composeCatalogの結果）から、文書同梱束を
 * 組み立てる。解決できないキー（resolvedByKindにエントリが無い）は同梱**せず**、
 * unresolvedKeys（種別ごとのSet）として返す——呼び出し側（store.js）が黙って落とさず、
 * 既存の同梱レコードから回収する（recoverUnresolvedEntries）か、回収できなければ
 * 利用者へ通知する材料にする（2026-09-22 QA指摘A: 解決できないユーザー材を無言で
 * 落として上書き保存すると .stq から材が消えるため）。
 * @param {{ usedKeysByKind: Map<string, Set<string>|Iterable<string>>,
 *           resolvedByKind: Map<string, Map<string, object>>,
 *           aliases?: object }} args
 * @returns {{ bundle: object, unresolvedKeys: Map<string, Set<string>> }}
 *          bundle はカタログ束（{version, catalogs, encodings, aliases}）。
 *          unresolvedKeys は解決できなかったキーの種別ごとのSet（空なら全解決）。
 */
export function buildDocumentBundle({ usedKeysByKind, resolvedByKind, aliases = {} }) {
  let bundle = emptyBundle();
  const unresolvedKeys = new Map();
  for (const [kind, keys] of usedKeysByKind) {
    const resolved = resolvedByKind.get(kind);
    const entries = [];
    const unresolved = new Set();
    for (const key of keys) {
      const entry = resolved?.get(key);
      if (entry) entries.push(entry);
      else unresolved.add(key);
    }
    bundle = withEntries(bundle, kind, entries);
    bundle = { ...bundle, encodings: { ...bundle.encodings, [kind]: kindDef(kind).encoding } };
    if (unresolved.size > 0) unresolvedKeys.set(kind, unresolved);
  }
  return { bundle: { ...bundle, aliases }, unresolvedKeys };
}

/**
 * buildDocumentBundle が解決できなかったキー（unresolvedKeys）を、既存の同梱束
 * （前回保存分。IDBから読んだ decode 済みの束）から回収して bundle へ追記する
 * （2026-09-22 QA指摘A）。既存にもエントリが無いキーは stillUnresolvedByKind として返す
 * ——呼び出し側（store.js）はこれを利用者への通知（件数・キー名）に使う。
 * 純関数（IDB非依存）: 既存束はデコード済みの状態で受け取る。
 * @param {object} bundle buildDocumentBundle の bundle
 * @param {Map<string, Set<string>>} unresolvedKeys buildDocumentBundle の unresolvedKeys
 * @param {Map<string, object|null|undefined>} existingBundlesByKind 種別ごとの既存の束（無ければ省略可）
 * @returns {{ bundle: object, stillUnresolvedByKind: Map<string, Set<string>> }}
 */
export function recoverUnresolvedEntries(bundle, unresolvedKeys, existingBundlesByKind = new Map()) {
  let result = bundle;
  const stillUnresolvedByKind = new Map();
  for (const [kind, keys] of unresolvedKeys) {
    if (!keys || keys.size === 0) continue;
    const def = kindDef(kind);
    const existingBundle = existingBundlesByKind.get(kind);
    const existingEntries = existingBundle ? bundleEntries(existingBundle, kind) : [];
    const existingByKey = new Map(existingEntries.map(e => [def.keyOf(e), e]));
    const recovered = [];
    const stillUnresolved = new Set();
    for (const key of keys) {
      const entry = existingByKey.get(key);
      if (entry) recovered.push(entry);
      else stillUnresolved.add(key);
    }
    if (recovered.length > 0) {
      result = withEntries(result, kind, [...bundleEntries(result, kind), ...recovered]);
    }
    if (stillUnresolved.size > 0) stillUnresolvedByKind.set(kind, stillUnresolved);
  }
  return { bundle: result, stillUnresolvedByKind };
}
