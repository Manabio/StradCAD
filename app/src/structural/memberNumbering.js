import { NUMBERED_MAPS, memberSymbol, memberSignature, memberSizeKey } from './memberCatalog.js';
import { conformToLedger, getGroupManualTag } from './memberGroups.js';
import { makeFloorLevelPrefix } from '../floorNumber.js';

// 部材タグ番号の採番ルール（材寸ベースグループ採番。設計意図は .claude/structural-model.md）:
//
// グループキー = entity.numberGroupId ?? signature(entity, mapName)（memberCatalog.memberSignature）。
// 「同一材寸＝同一グループ」が既定（signatureから毎回導出）。分割・統合・手動採番というユーザーの明示操作
// だけが project.memberGroupLedger へ永続化され、numberGroupId として部材へ反映される
// （memberGroups.js の conformToLedger）。
//
// 採番は2パスに分かれる（建物全体の情報が必要なため、単一graphでは完結しない）:
//   パス1（各階）: conformToLedger → collectFloorGroups で project.memberNumberIndex（非永続キャッシュ）に
//                  groupKey → {mapName, symbol, sizeKey, floorRanks, hasRoof, signature, counts} を積む。
//   パス2（建物全体で1回）: assignNumbers(project) が純関数として groupKey → タグ の対応表を作り、
//                  applyNumbers(graph, project, tags) が各階の entity.memberNo へ書き戻す。
//
// 採番規則（assignNumbers）:
//   1. 記号（memberSymbol）ごとに分ける。
//   2. 手動タグ（台帳 grp.no:<gid>）があればそれを最優先で使う（導出はしない）。
//   3. それ以外は sizeKey 降順（大きい方が若い番号）。同着は出現最下階（floorRanksの最小値）が下の方を先、
//      それでも同着なら signature の辞書順（決定論性の担保）。
//   4. 階プレフィックスは記号単位で要否判定: その記号の全グループの出現階集合が全て同一なら無し、
//      一つでも異なれば全グループに付す（有無混在を作らない）。
//   5. プレフィックス表記: 単一階=makeFloorLevelPrefix、連続階="2~4"、非連続="1,3"、屋根専用平面="R"。

// ----------------------------------------------------------------
// パス1: 収集
// ----------------------------------------------------------------

/** plane の floor rank 情報。isRoofPlane なら {rank:-1, isRoof:true}、それ以外は project.planes
 *  （elevation昇順）上の index（0=最下階）。project.planes に無い plane（検討など）は rank=-1（防御）。
 *  collectFloorGroups・分割プレビュー（previewSplitTag）が共通で使う「階の位置」の単一算出箇所。 */
export function floorRankOf(plane, project) {
  if (plane.isRoofPlane) return { rank: -1, isRoof: true };
  return { rank: project.planes.findIndex(p => p.id === plane.id), isRoof: false };
}

/**
 * graph[mapName] の各部材を project.memberNumberIndex（非永続・observable.map）に積む。
 * モード境界の反映パス・構造再計算（structuralRecompute.js）の収集フェーズで呼ぶ。
 * この関数だけでは entity.memberNo は変化しない（採番の確定は assignNumbers/applyNumbers）。
 *
 * このplane分の寄与は毎回「洗い替え」する（積み上げない）:
 *   1. 収集前に、既存の全エントリからこのplaneの寄与（counts.delete(planeId)・floorRanksの当該rank・
 *      roofplaneならhasRoof）を取り消す。
 *   2. このgraphの現在の部材を再収集する（既存グループでも mapName/symbol/sizeKey/signature を
 *      最新値へ更新する——gidを持つグループ（分割・統合済み）の材寸を編集しても sizeKey が
 *      古いまま固定化しないようにするため）。
 *   3. 収集後、counts.size===0（どの階からも参照されなくなった）グループは index から削除する。
 * これが無いと、材寸編集で組成が変わったグループの残骸（幽霊グループ）が残り、以前と同じ材寸に
 * 見えるだけの新グループが誤って生まれたり、全削除した階の痕跡が残り続けたりする。
 */
export function collectFloorGroups(graph, project) {
  const { rank, isRoof } = floorRankOf(graph.plane, project);
  const planeId = graph.plane.id;

  // 1. このplaneの既存寄与を全エントリから取り消す。
  // hasRoof は building単位のフラグ（floorRanksのような複数階の集合ではない）。isRoof時に
  // 全エントリの hasRoof を一律falseへ倒してから touchedGroups だけ立て直せるのは、
  // 「屋根専用平面（isRoofPlane）は建物に1つしか存在しない」という不変条件（project.roofPlane
  // getterが単数を返す。core.js）に依存している——複数の屋根専用平面が同時に存在し得るなら、
  // 他の屋根平面の寄与まで巻き込んで消してしまう。
  for (const group of project.memberNumberIndex.values()) {
    group.counts.delete(planeId);
    if (isRoof) group.hasRoof = false;
    else if (rank >= 0) group.floorRanks.delete(rank);
  }

  // 2. 現在の部材を再収集する。
  const localCounts = new Map(); // groupKey → このgraphでの本数（このplane分をあとでcountsへ上書きする）
  const touchedGroups = new Map(); // groupKey → group（floorRanks/hasRoof反映対象）
  for (const mapName of NUMBERED_MAPS) {
    for (const entity of graph[mapName].values()) {
      const symbol = memberSymbol(entity, mapName);
      const signature = memberSignature(entity, mapName);
      const sizeKey = memberSizeKey(entity, mapName);
      const groupKey = entity.numberGroupId ?? signature;
      let group = project.memberNumberIndex.get(groupKey);
      if (!group) {
        group = { mapName, symbol, sizeKey, signature, floorRanks: new Set(), hasRoof: false, counts: new Map() };
        project.memberNumberIndex.set(groupKey, group);
        // project.memberNumberIndex は deep な observable.map（core.js）のため、set() に渡した plain
        // object/Map/Set はそのまま格納されず、MobXが別のobservableオブジェクトへ深変換した複製が
        // 格納される（値渡しではなく複製）。以後 group.counts.set/group.floorRanks.add/group.hasRoof=
        // で変異する対象を「格納実体」に揃えるため、setし直した直後に get して差し替える
        // （差し替えないと元のplain objectだけが変異し、格納側のcountsが空のまま——このplaneにしか
        // 存在しない新規グループ（同一collect内で他に触られる機会が無いグループ）は、末尾のゴースト掃除
        // 〔counts.size===0〕で直後に削除され、assignNumbersに現れずmemberNoがnullのままになる
        // 再発済みバグ。同一グループに複数本あるケースは2本目以降の`.get(groupKey)`が格納実体を
        // 返すため touchedGroups 経由で偶然救われていた）。
        group = project.memberNumberIndex.get(groupKey);
      } else {
        // 既存グループでも最新の材寸へ同期する（gid付きグループの sizeKey 固定化を防ぐ）。
        group.mapName = mapName;
        group.symbol = symbol;
        group.sizeKey = sizeKey;
        group.signature = signature;
      }
      touchedGroups.set(groupKey, group);
      localCounts.set(groupKey, (localCounts.get(groupKey) ?? 0) + 1);
    }
  }
  for (const [groupKey, group] of touchedGroups) {
    if (isRoof) group.hasRoof = true;
    else if (rank >= 0) group.floorRanks.add(rank);
    group.counts.set(planeId, localCounts.get(groupKey));
  }

  // 3. どの階からも参照されなくなったグループ（幽霊グループ）を削除する。
  for (const [groupKey, group] of project.memberNumberIndex) {
    if (group.counts.size === 0) project.memberNumberIndex.delete(groupKey);
  }
}

/** グループの合計本数（counts の全階分の合計。カードの広がりバッジ表示用）。 */
export function totalCountOf(group) {
  let total = 0;
  for (const n of group.counts.values()) total += n;
  return total;
}

/**
 * カードヘッダの「広がりバッジ」表示文字列（例 "2~3F・計12本"、単一階なら "1F・計6本"、
 * 屋根専用平面のみなら "R・計4本"）。collectFloorGroups が積んだ project.memberNumberIndex の
 * エントリ（floorRanks/hasRoof/counts）から作る。floorPrefixLabel と同じ階表記ロジックだが、
 * 番号プレフィックス用（"F"なし）ではなくバッジ用（"F"付き）に整形する。
 */
export function floorSpanLabel(group, project) {
  const planes = project.planes;
  // project.planes より大きい/負の rank（階削除直後、まだ project.memberNumberIndex が再収集されて
  // いない一時的な状態）は無視する（store.js の removeFloor が clearMemberNumberIndex するまでの
  // 短い間だけ起こり得る。落ちてはいけない・古い階を指しては表示しない）。
  const ranks = [...group.floorRanks].filter(r => r >= 0 && r < planes.length).sort((a, b) => a - b);
  let out = '';
  if (ranks.length === 1) {
    out = `${makeFloorLevelPrefix(planes[ranks[0]].startFloor)}F`;
  } else if (ranks.length > 1) {
    const contiguous = ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);
    out = contiguous
      ? `${makeFloorLevelPrefix(planes[ranks[0]].startFloor)}~${makeFloorLevelPrefix(planes[ranks[ranks.length - 1]].startFloor)}F`
      : ranks.map(r => `${makeFloorLevelPrefix(planes[r].startFloor)}F`).join(',');
  }
  if (group.hasRoof) out = out ? `${out},R` : 'R';
  return `${out}・計${totalCountOf(group)}本`;
}

// ----------------------------------------------------------------
// パス2: 採番（純関数。dry-run可能＝分割プレビュー用途にも使える）
// ----------------------------------------------------------------

// グループの「出現階の同一性」判定キー（階プレフィックスの要否判定に使う）。
function floorIdentityKey(group) {
  const ranks = [...group.floorRanks].sort((a, b) => a - b).join(',');
  return group.hasRoof ? `${ranks}+R` : ranks;
}

// sizeKey 降順・出現最下階昇順・signature昇順のタイブレークで比較する（負=aが先）。
function compareGroupsDesc(a, b) {
  const len = Math.max(a.sizeKey.length, b.sizeKey.length);
  for (let i = 0; i < len; i++) {
    const va = a.sizeKey[i] ?? 0, vb = b.sizeKey[i] ?? 0;
    if (va !== vb) return vb - va; // 降順（大きい方が先＝若い番号）
  }
  const minA = a.floorRanks.size ? Math.min(...a.floorRanks) : Infinity;
  const minB = b.floorRanks.size ? Math.min(...b.floorRanks) : Infinity;
  if (minA !== minB) return minA - minB; // 出現最下階が下（rankが小さい）方を先
  if (a.signature !== b.signature) return a.signature < b.signature ? -1 : 1; // 最終同着: 辞書順
  return 0;
}

// 階プレフィックス文字列を作る（単一階/連続階/非連続/屋根の組み合わせ）。
function floorPrefixLabel(group, project) {
  const planes = project.planes; // elevation昇順。rank はこの配列のindexと一致する
  // 階削除直後の一時的な孤児rankを無視する（floorSpanLabel と同じ理由）。
  const ranks = [...group.floorRanks].filter(r => r >= 0 && r < planes.length).sort((a, b) => a - b);
  let out = '';
  if (ranks.length === 1) {
    out = makeFloorLevelPrefix(planes[ranks[0]].startFloor);
  } else if (ranks.length > 1) {
    const contiguous = ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);
    out = contiguous
      ? `${makeFloorLevelPrefix(planes[ranks[0]].startFloor)}~${makeFloorLevelPrefix(planes[ranks[ranks.length - 1]].startFloor)}`
      : ranks.map(r => makeFloorLevelPrefix(planes[r].startFloor)).join(',');
  }
  if (group.hasRoof) out = out ? `${out},R` : 'R';
  return out;
}

/**
 * project.memberNumberIndex（建物全体、収集済み）から groupKey → タグ文字列 の対応表を作る純関数。
 * 副作用なし（entity には触れない）。dry-run（分割プレビュー等）にそのまま使える。
 */
export function assignNumbers(project) {
  const bySymbol = new Map(); // `${mapName}:${symbol}` → [{groupKey, group}]
  for (const [groupKey, group] of project.memberNumberIndex) {
    const symbolKey = `${group.mapName}:${group.symbol}`;
    if (!bySymbol.has(symbolKey)) bySymbol.set(symbolKey, []);
    bySymbol.get(symbolKey).push({ groupKey, group });
  }

  const tags = new Map();
  for (const entries of bySymbol.values()) {
    const firstIdentity = floorIdentityKey(entries[0].group);
    const needsPrefix = entries.some(e => floorIdentityKey(e.group) !== firstIdentity);
    const sorted = [...entries].sort((a, b) => compareGroupsDesc(a.group, b.group));

    // 手動タグ（grp.no）を持つグループは連番から除外する——連番に含めてから上書きすると、
    // その分の番号が誰にも使われず欠番になる（例: 2番目が手動なら 1,2,3... のうち2が空いてC1,C3になる）。
    // 手動グループを飛ばして詰めることで、自動グループは常に連続した番号になる。
    // taken はこの記号内で既に使われている完成タグ（prefix込み文字列）の集合——手動タグを先に
    // 埋めておき、自動採番の候補が手動タグと文字列として衝突したら候補を進めてスキップする
    // （衝突を放置すると computeTagGroups がタグ文字列でカードをまとめるため、sizeKeyの異なる
    // 2グループが1枚のカードに融合してしまう。QA再現: qa-manualcollision.mjs）。
    const taken = new Set();
    for (const entry of sorted) {
      const manualTag = getGroupManualTag(project.memberGroupLedger, entry.groupKey);
      if (manualTag) { tags.set(entry.groupKey, manualTag); taken.add(manualTag); }
    }
    let autoIndex = 0;
    for (const entry of sorted) {
      if (tags.has(entry.groupKey)) continue; // 手動タグ済み
      const prefix = needsPrefix ? floorPrefixLabel(entry.group, project) : '';
      let candidate;
      do {
        autoIndex += 1;
        candidate = `${prefix}${entry.group.symbol}${autoIndex}`;
      } while (taken.has(candidate));
      tags.set(entry.groupKey, candidate);
      taken.add(candidate);
    }
  }
  return tags;
}

/**
 * 分割UIのプレビュー用 dry-run（MemberListTab.jsx）。project.memberNumberIndex を複製し、
 * 「分割で切り出す新グループ」を1件追加して（分割元グループから対象分を減算するオプション込みで）
 * assignNumbers を実行し、新グループに割り振られる予定タグを返す。実データ（project.memberNumberIndex・
 * memberGroupLedger）には一切書き込まない（assignNumbers に渡すのは同じ形を持つ使い捨てのビューだけ）。
 *
 * @param {object} floorInfo floorRankOf(graph.plane, project) の戻り値
 * @param {object} [options]
 * @param {string} [options.remainderGroupKey] 分割元の現在の groupKey（分割元からの減算に使う）
 * @param {boolean} [options.removeFromRemainder] true なら分割元グループの出現階集合からこの階を除く
 *   （「この階」スコープ、または「この部材」で分割元がこの階に他に残らない場合）
 * @returns {string|null} 予定タグ
 */
export function previewSplitTag(project, mapName, symbol, sizeKey, signature, floorInfo, options = {}) {
  const PREVIEW_KEY = '__split_preview__';
  const { remainderGroupKey, removeFromRemainder } = options;
  const cloned = new Map(project.memberNumberIndex);
  if (remainderGroupKey && removeFromRemainder && cloned.has(remainderGroupKey)) {
    const src = cloned.get(remainderGroupKey);
    const floorRanks = new Set(src.floorRanks);
    let hasRoof = src.hasRoof;
    if (floorInfo.isRoof) hasRoof = false; else floorRanks.delete(floorInfo.rank);
    cloned.set(remainderGroupKey, { ...src, floorRanks, hasRoof });
  }
  cloned.set(PREVIEW_KEY, {
    mapName, symbol, sizeKey, signature,
    floorRanks: !floorInfo.isRoof && floorInfo.rank >= 0 ? new Set([floorInfo.rank]) : new Set(),
    hasRoof: floorInfo.isRoof,
    counts: new Map(),
  });
  const view = { memberNumberIndex: cloned, memberGroupLedger: project.memberGroupLedger, planes: project.planes };
  return assignNumbers(view).get(PREVIEW_KEY) ?? null;
}

/**
 * assignNumbers の結果（groupKey → タグ）を graph の各部材へ書き戻す。手動タグ（grp.no）は
 * assignNumbers が既に最優先で解決済みのため、ここでは単に書き戻すだけでよい（部材単位のロック分岐は
 * 廃止済み。手動固定はグループ単位＝台帳 grp.no に一本化されている。.claude/structural-model.md 参照）。
 * @returns {{ changed: boolean, renumbered: Array<{ from: string, to: string }> }}
 *   changed=1件でも memberNo が変化したか（呼び出し側の保存要否判定に使う）。
 *   renumbered=「既に番号を持っていた部材」が別の番号に変わった遷移一覧（初回採番=null→タグ は含まない。
 *   モード境界の再採番トーストが「材寸変更にともなう振り直し」だけを報告するために使う）。
 */
export function applyNumbers(graph, project, tags, onlyMapName = null) {
  let changed = false;
  const renumbered = [];
  const maps = onlyMapName ? [onlyMapName] : NUMBERED_MAPS;
  for (const mapName of maps) {
    for (const entity of graph[mapName].values()) {
      const groupKey = entity.numberGroupId ?? memberSignature(entity, mapName);
      const tag = tags.get(groupKey);
      if (tag != null && tag !== entity.memberNo) {
        if (entity.memberNo != null) renumbered.push({ from: entity.memberNo, to: tag });
        entity.setMemberNo(tag);
        changed = true;
      }
    }
  }
  return { changed, renumbered };
}

// ----------------------------------------------------------------
// 単一graph向けの便利関数（3パスを1呼び出しにまとめる）
// ----------------------------------------------------------------

/**
 * 単一 graph だけを対象にした conform→収集→採番→適用の一括呼び出し。
 * mapName を指定すると適用（applyNumbers）をそのカテゴリだけに絞る（他カテゴリは収集のみ行われ、
 * project.memberNumberIndex は更新されるが memberNo は変化しない）。
 *
 * 建物全体をまたぐ厳密な再採番は structural/structuralOrchestration.js の reflectStructuralToOtherFloors（全階収集→assignNumbers
 * を1回→全階へapply）が担う。この関数はそれ以外の「1 graph だけのローカル編集」（部材の追加・
 * 手動タグの解除など）から呼ぶ即時反映用で、project.memberNumberIndex に既に積まれている他階分
 * （直近の反映パスで得た情報）を使って番号を決める——他階が一度も反映されていない場合は自階だけの
 * 相対順位で決まり、次のモード境界の反映パスで建物全体の順位に補正される。
 */
export function renumberMembers(graph, project, mapName = null) {
  conformToLedger(graph, project);
  collectFloorGroups(graph, project);
  const tags = assignNumbers(project);
  applyNumbers(graph, project, tags, mapName);
}
