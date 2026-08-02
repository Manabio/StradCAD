/**
 * 部材グループ台帳（project.memberGroupLedger）の読み書きと、分割・統合の明示操作を扱う。
 *
 * 台帳は「分割・統合というユーザーの明示的な意思」だけを持つ（既定の集約は毎回 signature から導出する。
 * memberNumbering.js の collectFloorGroups/assignNumbers 参照）。無操作なら台帳は空のまま。
 *
 * 格納 key/value（すべて string→string、fieldPacking.js と同じ「JSON を使わない」方針）:
 *   grp.spec:<gid>       = 材寸spec文字列（memberCatalog.memberSpecString と同形式）
 *   grp.join:<gid>       = 加入署名（materialize 時点の memberSignature。他階の同署名部材を次のモード境界で吸収する）
 *   grp.no:<gid>         = 手動タグ文字列（任意。手動で番号を打った場合のみ）
 *   grp.mergedInto:<gid> = 統合により吸収された旧gid → 統合先gid（Phase C mergeGroups が書く。conformToLedger が
 *                          既に numberGroupId=<gid> を持つ他階の部材を、次のモード境界で統合先gidへ転送するための
 *                          転送先ポインタ。多段統合（統合先がさらに別統合に吸収される）にも追従できるよう連鎖解決する）
 */
import { NUMBERED_MAPS, memberSymbol, memberSignature, memberSpecString } from './memberCatalog.js';

const specKeyOf       = gid => `grp.spec:${gid}`;
const joinKeyOf       = gid => `grp.join:${gid}`;
const noKeyOf         = gid => `grp.no:${gid}`;
const mergedIntoKeyOf = gid => `grp.mergedInto:${gid}`;
const JOIN_PREFIX = 'grp.join:';
const NO_PREFIX   = 'grp.no:';

export function getGroupSpec(ledger, gid) { return ledger.get(specKeyOf(gid)) ?? null; }
export function setGroupSpec(ledger, gid, spec) { ledger.set(specKeyOf(gid), spec); }
export function getGroupJoin(ledger, gid) { return ledger.get(joinKeyOf(gid)) ?? null; }
export function setGroupJoin(ledger, gid, signature) { ledger.set(joinKeyOf(gid), signature); }
export function getGroupManualTag(ledger, gid) { return ledger.get(noKeyOf(gid)) ?? null; }
export function setGroupManualTag(ledger, gid, tag) { ledger.set(noKeyOf(gid), tag); }
export function clearGroupManualTag(ledger, gid) { ledger.delete(noKeyOf(gid)); }
export function getMergedInto(ledger, gid) { return ledger.get(mergedIntoKeyOf(gid)) ?? null; }
export function setMergedInto(ledger, oldGid, newGid) { ledger.set(mergedIntoKeyOf(oldGid), newGid); }

/** 台帳に登録されている全ての手動タグ（gid → タグ文字列）。project.memberNumberIndex に未収集の
 *  （他階にしか実体が無い）グループの手動タグも拾える——「タグ空間の一意性」判定
 *  （assignNumbersの衝突回避・MemberListTab.jsxの重複タグ入力チェック）が土台にする一次データ。 */
export function allManualTags(ledger) {
  const tags = new Map();
  for (const [key, value] of ledger.entries()) {
    if (key.startsWith(NO_PREFIX)) tags.set(key.slice(NO_PREFIX.length), value);
  }
  return tags;
}

// 台帳（project.memberGroupLedger）専用の軽量スナップショット。分割・統合のUndoで
// serializeStructCLs/restoreStructCLs（structGraph全体＋structuralInfoまで巻き込む重い操作）を使うと、
// restoreStructCLsがstructGraph.clear()でCenterLine実体を作り直すため、restoreGraph（entityのCL参照
// 解決はstructGraphの現在の実体を見る）と順序依存が生まれ、どちらを先に呼んでも一方が古い/未生成の
// CL実体を掴む不具合になる。台帳はCL参照を持たないただの文字列マップのため、この専用スナップショットなら
// restoreGraph との呼び出し順序に一切依存しない（MemberListTab.jsx の分割・統合Undoで使う）。
export function snapshotLedger(project) {
  return [...project.memberGroupLedger.entries()];
}
export function restoreLedger(project, snapshot) {
  project.memberGroupLedger.replace(snapshot);
}

// gid が（多段統合の可能性込みで）最終的にどの gid へ転送されるかを解決する（自己参照循環はガードして打ち切る）。
function resolveMergedGid(ledger, gid) {
  const seen = new Set();
  let current = gid;
  while (!seen.has(current)) {
    seen.add(current);
    const next = getMergedInto(ledger, current);
    if (!next) return current;
    current = next;
  }
  return current; // 循環（本来起きない）の防御的フォールバック
}

// grp.join:<gid> の値が signature と一致する gid を探す（見つからなければ null）。
// 「gid未設定かつ署名が grp.join と一致」で他階の部材を同一グループへ吸収する判定に使う。
function findGidByJoinSignature(ledger, signature) {
  for (const [key, val] of ledger.entries()) {
    if (val === signature && key.startsWith(JOIN_PREFIX)) return key.slice(JOIN_PREFIX.length);
  }
  return null;
}

// spec文字列の1フィールド値を復元する（fieldPacking.js の coerce と同じ規則。JSON.parse は使わない）。
function coerceSpecValue(raw) {
  if (raw === '') return null;
  if (raw === 'true')  return true;
  if (raw === 'false') return false;
  return raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
}

// spec文字列（"key=val|key=val..."）を entity へ書き戻す。ドット記法は1段ネストとして復元する
// （MemberListTab.jsx の foundationSection 更新と同じ「setField(parent, {...spread, [child]:v})」パターン）。
function applySpecToEntity(entity, spec) {
  if (!spec) return;
  for (const pair of spec.split('|')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const field = pair.slice(0, eq);
    const raw   = pair.slice(eq + 1);
    const dot = field.indexOf('.');
    if (dot > 0) {
      const parent = field.slice(0, dot);
      const child  = field.slice(dot + 1);
      entity.setField(parent, { ...(entity[parent] ?? {}), [child]: coerceSpecValue(raw) });
    } else {
      entity.setField(field, coerceSpecValue(raw));
    }
  }
}

/**
 * graph 内の各部材を台帳に合わせる（モード境界の反映パス・構造再計算の収集フェーズで呼ぶ、
 * structuralRecompute.js 参照）。
 *   - numberGroupId が既にある部材: まず grp.mergedInto を辿って統合先gidへ転送（Phase C mergeGroups が
 *     吸収した旧gidを持つ他階の部材を、次のモード境界で統合先へ合流させる経路）。その上で
 *     grp.spec:<gid> の材寸を部材へ conform（分割・統合で確定した材寸に揃える）。
 *   - numberGroupId が無い部材: signature が grp.join:<gid> のどれかと一致すれば、その gid（同様に
 *     mergedInto を解決した最終gid）を吸収し spec に conform。
 * Phase A では台帳が常に空（split/merge の UI が無い）ため実質 no-op。Phase B/C の分割・統合が
 * 台帳へ書き込むようになった時点から機能する。
 */
export function conformToLedger(graph, project) {
  const ledger = project.memberGroupLedger;
  for (const mapName of NUMBERED_MAPS) {
    for (const entity of graph[mapName].values()) {
      if (entity.numberGroupId) {
        const resolved = resolveMergedGid(ledger, entity.numberGroupId);
        if (resolved !== entity.numberGroupId) entity.setNumberGroupId(resolved);
        applySpecToEntity(entity, getGroupSpec(ledger, resolved));
        continue;
      }
      const signature = memberSignature(entity, mapName);
      const gid = findGidByJoinSignature(ledger, signature);
      if (gid) {
        const resolved = resolveMergedGid(ledger, gid);
        entity.setNumberGroupId(resolved);
        applySpecToEntity(entity, getGroupSpec(ledger, resolved));
      }
    }
  }
}

// 次に発番する連番（同一 symbol の grp.spec:<symbol>#N キーの最大 N + 1）。
// ID書式は "C#1" のように記号+"#"+連番（fieldPacking.js の coerce が数値文字列を数値化するため、
// 純数字IDは禁止——常に symbol プレフィックスを付ける）。
function nextGroupSeq(ledger, symbol) {
  const prefix = `grp.spec:${symbol}#`;
  let max = 0;
  for (const key of ledger.keys()) {
    if (!key.startsWith(prefix)) continue;
    const n = Number(key.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * signature に対応する新規 gid を発行し、台帳へ spec/join を書き込む（split/merge の共通ヘルパー）。
 * splitGroup（Phase B）・mergeGroups（Phase C）から呼ばれる。
 */
export function materializeGroup(ledger, symbol, signature, specString) {
  const gid = `${symbol}#${nextGroupSeq(ledger, symbol)}`;
  setGroupSpec(ledger, gid, specString);
  setGroupJoin(ledger, gid, signature);
  return gid;
}

/**
 * Phase B: 分割。対象部材（同一階の同グループ全部材＝「この階」、または1本＝「この部材」）に
 * 新規 gid を発行し、numberGroupId を付与する。
 *
 * 値の編集（entity.setField 等）は呼び出し側が本関数の「前」に適用しておくこと——grp.spec/grp.join は
 * 呼び出し時点の（編集後の）材寸から作る。分割プレビュー（MemberListTab.jsx）が「編集後の値で採番したら
 * 何番になるか」を示すのはこの前提のため。
 * @returns {string|null} 発行した gid（対象0件なら null）
 */
export function splitGroup(project, mapName, targetMembers) {
  if (!targetMembers.length) return null;
  const rep = targetMembers[0];
  const symbol = memberSymbol(rep, mapName);
  const signature = memberSignature(rep, mapName);
  const spec = memberSpecString(rep, mapName);
  const gid = materializeGroup(project.memberGroupLedger, symbol, signature, spec);
  for (const m of targetMembers) m.setNumberGroupId(gid);
  return gid;
}

/**
 * 「グループに戻す」。対象部材の numberGroupId を外し、材寸署名からの自動導出（既定の集約）へ戻す。
 * 台帳（grp.spec/grp.join）はここでは削除しない——他階に同じ gid を持つ部材が残っている可能性があり
 * （自階だけ台帳から外れても、他階分は次のモード境界の conformToLedger が引き続き同じ gid で扱う設計）、
 * 削除すると他階分の conform が spec を失って浮いてしまう。自階分だけ外し、呼び出し側が再採番する。
 */
export function releaseFromGroup(targetMembers) {
  for (const m of targetMembers) m.setNumberGroupId(null);
}

/**
 * Phase C: 統合。選択した複数グループを1つの gid（統合先）の下に統合する。
 *
 * 「自階にいる部材への即時適用」と「台帳への記録」を分けて実装する——選択グループの中に自階に
 * 部材を持たないもの（他階のみのグループ）が混ざっていても、台帳操作（materializeGroup +
 * grp.mergedInto）だけで正しく成立する（呼び出し側で members が空配列のエントリを渡してよい）。
 *
 * 手順:
 *   1. 採用グループ（chosenIndex）の gid を決める。既に numberGroupId を持っていればそれを再利用し
 *      spec を採用値で上書き、無ければ新規 materializeGroup する。
 *   2. 吸収される各グループについて、代表部材（自階にいれば members[0]、いなければ何もしない＝
 *      他階のみで自階に痕跡が無いグループは台帳操作が不要）の gid を決める。既に numberGroupId が
 *      あればそれを「旧gid」として使う。無ければ現在の（吸収前の）材寸で materializeGroup し、
 *      その一時 gid を「旧gid」とする——これにより他階の同署名部材（gid未設定）も
 *      grp.join 経由で旧gidに一度吸収され、grp.mergedInto で統合先へ転送される経路が繋がる。
 *   3. grp.mergedInto:<旧gid> = 統合先gid を書き、他階の該当部材が次のモード境界で統合先へ
 *      合流する経路を確保する（releaseFromGroup と同じく、他階整合はモード境界の conformToLedger に委譲）。
 *   4. 自階にいる全対象部材（採用グループ含む）に統合先gidを付与し、採用specへ conform する。
 *
 * 記号・材料（materialType）が採用グループと異なるグループは無視する（統合してはいけない組み合わせ。
 * UI（MemberCard.isMergeSelectable）が選択自体を防ぐが、呼び出し側の不備でも壊れたデータを作らない
 * ための二重の防御）——無視されたグループの部材は numberGroupId・材寸のどちらも一切変更されない。
 *
 * @param {object} project
 * @param {string} mapName
 * @param {Array<{ members: object[] }>} selectedGroups 選択された各グループ（自階の部材配列。0件可）
 * @param {number} chosenIndex 採用する材寸のグループの selectedGroups 内 index
 * @returns {string|null} 統合先gid（採用グループに自階部材が1本も無ければ材寸を読めず null）
 */
export function mergeGroups(project, mapName, selectedGroups, chosenIndex) {
  const ledger = project.memberGroupLedger;
  const chosen = selectedGroups[chosenIndex];
  const chosenRep = chosen?.members?.[0];
  if (!chosenRep) return null; // 採用specを読める部材が無ければ統合不能（防御。呼び出し側は自階に居る候補からのみ選ばせる）

  const chosenSymbol = memberSymbol(chosenRep, mapName);
  const chosenMaterialType = chosenRep.materialType;
  const chosenSpec = memberSpecString(chosenRep, mapName);
  let chosenGid = chosenRep.numberGroupId;
  if (chosenGid) {
    setGroupSpec(ledger, chosenGid, chosenSpec); // 採用spec（編集後の値）で上書き
  } else {
    chosenGid = materializeGroup(ledger, chosenSymbol, memberSignature(chosenRep, mapName), chosenSpec);
  }

  selectedGroups.forEach((g, i) => {
    if (i === chosenIndex) {
      for (const m of g.members) {
        m.setNumberGroupId(chosenGid);
        applySpecToEntity(m, chosenSpec);
      }
      return;
    }
    const rep = g.members[0];
    if (rep) {
      // 防御: 記号・材料が採用グループと異なる場合は統合対象から除外する（このグループには一切触れない）。
      if (memberSymbol(rep, mapName) !== chosenSymbol || rep.materialType !== chosenMaterialType) return;
      const oldGid = rep.numberGroupId
        ?? materializeGroup(ledger, memberSymbol(rep, mapName), memberSignature(rep, mapName), memberSpecString(rep, mapName));
      if (oldGid !== chosenGid) {
        setMergedInto(ledger, oldGid, chosenGid);
        // 吸収された側の手動タグ（grp.no）は孤児化させず破棄する（統合後に見えない旧タグが
        // 台帳へ残り続けるのを防ぐ。MergeGroupsDialog は破棄される旨をあらかじめ警告表示する）。
        clearGroupManualTag(ledger, oldGid);
      }
    }
    for (const m of g.members) {
      m.setNumberGroupId(chosenGid);
      applySpecToEntity(m, chosenSpec);
    }
  });

  return chosenGid;
}
