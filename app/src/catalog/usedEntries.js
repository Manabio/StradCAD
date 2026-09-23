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
import { CatalogKind, kindDef } from './catalogKinds.js';
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
 * snapshot群（複数階分。decode済み）から、指定した種別（kinds）ぶんの使用キーを集めて返す
 * （4.3・ステップ7c QA指摘Major-1）。kinds に渡した種別は、使用0件でも戻り値の Map に必ず
 * 空Setとして持つ——呼び出し側（store.js collectCatalogUsageAcrossFloors）が「全種別を空Setで
 * 立ててから全階を回して埋める」という手順を個別に実装していたところを純関数として抽出した
 * もの（store.js は decode してこれに渡すだけにする）。material の直接参照（4フィールド）は
 * collectUsedMaterialCodes を、他種別は collectUsedKeys を使う——collectUsedKeys が返す
 * フィールド名（interiorMaster/boundaryMaster/section/openingSubType）は catalogKinds.js の
 * CatalogKind の値と文字列として一致するため、種別名からそのまま引ける。
 * @param {Iterable<object>} snapshots decode済みスナップショット（複数階分）
 * @param {Iterable<string>} kinds 収集対象の種別（catalogKinds.js CatalogKind の値）
 * @returns {Map<string, Set<string>>} kind → 使用キーのSet（kinds に渡した全種別ぶん、
 *          使用0件でも空Setとして存在する）
 */
export function collectUsedKeysByKind(snapshots, kinds) {
  const usedKeysByKind = new Map([...kinds].map(kind => [kind, new Set()]));
  for (const snapshot of snapshots) {
    if (usedKeysByKind.has(CatalogKind.MATERIAL)) {
      for (const code of collectUsedMaterialCodes(snapshot)) usedKeysByKind.get(CatalogKind.MATERIAL).add(code);
    }
    const used = collectUsedKeys(snapshot);
    for (const [kind, set] of usedKeysByKind) {
      if (kind === CatalogKind.MATERIAL) continue;
      const keys = used[kind]; // フィールド名はCatalogKindの値と一致する
      // 一致が崩れた種別を黙って「使用0件」扱いにすると、空配列で同梱され前回のレコードを
      // 消してしまう。登録表にはあるが収集に未対応の種別は例外で止める。
      if (!keys) throw new Error(`使用キーの収集に未対応の種別です: ${kind}`);
      for (const key of keys) set.add(key);
    }
  }
  return usedKeysByKind;
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
 * ステップ12a: `overridesBuiltin`（4.4/resolveQueue.js markOverrideが付ける「本体の上書き」印）を
 * 同梱から除去する。この属性はユーザーライブラリ側の状態（このプロジェクトのuserエントリが
 * builtinを上書きしているかどうか）であって、doc（文書同梱）はそれを持ち運ぶべきではない——
 * 別環境（overridesBuiltin無しのuserを持つ、または全く持たない環境）でこの.stqを開いたとき、
 * doc側にoverridesBuiltin:trueが残っていると、そのuserエントリを衝突検出（catalogBundle.js
 * detectLibraryConflicts）から誤って除外してしまう（「衝突なし」に見えるが実際はuser側にその
 * 上書きが存在しない）。
 * QA指摘Minor-1（2026-09-24・12a再報告）: export して catalog/catalogMaintenance.js
 * （同ディレクトリの兄弟モジュール。catalogImports.test.jsの許可リスト内）からも使う——
 * planRemoveUserEntryのdocAppend（使用中userを削除するときにdocへ書き写す1件）も同じ理由で
 * この印を持ち込んではいけない。
 * @param {object} entry
 * @returns {object}
 */
export function stripOverridesBuiltin(entry) {
  if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'overridesBuiltin')) return entry;
  const rest = { ...entry };
  delete rest.overridesBuiltin;
  return rest;
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
      if (entry) entries.push(stripOverridesBuiltin(entry));
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
 * QA指摘Minor-1（2026-09-24・12a再報告）: 回収元（旧保存の同梱束）に`overridesBuiltin`印が
 * 残っている可能性がある（保存直後の旧バージョンや、12a以前の.stqを開いた場合等）ため、
 * buildDocumentBundleと同様にstripOverridesBuiltinを通してから追記する。
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
      if (entry) recovered.push(stripOverridesBuiltin(entry));
      else stillUnresolved.add(key);
    }
    if (recovered.length > 0) {
      result = withEntries(result, kind, [...bundleEntries(result, kind), ...recovered]);
    }
    if (stillUnresolved.size > 0) stillUnresolvedByKind.set(kind, stillUnresolved);
  }
  return { bundle: result, stillUnresolvedByKind };
}

/**
 * recoverUnresolvedEntries が既存の同梱束から回収した interiorMaster/boundaryMaster エントリも
 * 含め、bundle 上の interiorMaster/boundaryMaster 全エントリから material への推移的展開を
 * やり直す（QA指摘Minor-2・回収分の推移展開）。saveCatalogDocument が最初に呼ぶ
 * expandTransitiveMaterials は「builtin/overlayで直接解決できた使用マスター」しか見ておらず、
 * 回収によって新たに束へ入った内装・境界マスターが参照する材コードはまだ material 束に無い
 * ——ここで改めて展開し、不足分を materialMap（composeCatalog(MATERIAL, ...)の結果）で解決して
 * material 束へ追記する。それでも解決できない材コードは unresolvedMaterialKeys として返す
 * （呼び出し側がさらに既存の材束から回収するか、それでも無ければ通知するかを決める）。
 * @param {object} bundle 束（withEntriesされたcatalogsを持つ。recoverUnresolvedEntries後の想定）
 * @param {Map<string, object>|undefined} materialMap 材の解決済みMap（省略時は全て未解決扱い）
 * @returns {{ bundle: object, unresolvedMaterialKeys: Set<string> }}
 */
export function reexpandTransitiveMaterials(bundle, materialMap) {
  const interiorMasters = bundleEntries(bundle, CatalogKind.INTERIOR_MASTER);
  const boundaryMasters = bundleEntries(bundle, CatalogKind.BOUNDARY_MASTER);
  const materialDef = kindDef(CatalogKind.MATERIAL);
  const existingMaterials = bundleEntries(bundle, CatalogKind.MATERIAL);
  const existingCodes = new Set(existingMaterials.map(e => materialDef.keyOf(e)));

  const expanded = expandTransitiveMaterials(existingCodes, { interiorMasters, boundaryMasters });

  const newEntries = [];
  const unresolvedMaterialKeys = new Set();
  for (const code of expanded) {
    if (existingCodes.has(code)) continue;
    const entry = materialMap?.get(code);
    if (entry) newEntries.push(entry);
    else unresolvedMaterialKeys.add(code);
  }
  if (newEntries.length === 0) return { bundle, unresolvedMaterialKeys };
  return {
    bundle: withEntries(bundle, CatalogKind.MATERIAL, [...existingMaterials, ...newEntries]),
    unresolvedMaterialKeys,
  };
}
