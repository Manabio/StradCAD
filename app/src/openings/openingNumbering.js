// ================================================================
// 建具番号（記号別採番） — 設計意図は .claude/opening-model.md 参照。
//
// structural/memberNumbering.js の2パス構造をなぞるが共通化はしない
// （構造固有の台帳・sizeKey・階プレフィックス等が流れ込むため並行実装が正当）。
//
// グループキー = openingSignature(opening)（記号|種別|幅|高さ|窓台高さ）。
// 「同一仕様＝同一グループ」（signatureから毎回導出。手動タグ台帳は持たない）。
//
// 採番は2パスに分かれる（建物全体の情報が必要なため、単一graphでは完結しない）:
//   パス1（各階）: collectFloorOpeningGroups で project.openingNumberIndex（非永続キャッシュ）に
//                  signature → {symbol, subType, width, height, sillHeight, counts} を積む。
//   パス2（建物全体で1回）: assignOpeningNumbers(project) が純関数として signature → タグ の
//                  対応表を作り、applyOpeningTags(project, tags) が各グループの .tag へ書き戻す。
//
// 採番規則（assignOpeningNumbers）:
//   1. 記号（symbol）ごとに分ける。
//   2. 各記号内を 幅降順 → 高さ降順 → 窓台高さ昇順 → signature 辞書順 でソート（決定論性）。
//   3. 先頭から 1,2,3… でタグ＝`${symbol}-${n}`（ハイフン区切り。建具表の慣習。構造のC1とは書式が違う）。
//   4. 階プレフィックスは付けない（採番は全階統一＝記号-番号は仕様を指す）。
// ================================================================

import { defaultFixtureSymbol, defaultOpeningHeight } from './openingCatalog.js';

/** opening.fixtureType（未設定ならカテゴリ既定へフォールバック）。 */
export function fixtureSymbolOf(opening) {
  return opening.fixtureType ?? defaultFixtureSymbol(opening.category);
}

/**
 * opening.height（未設定・不正値ならカタログ既定へフォールバック）。
 * height<=0（null/0/負値）は不正値として未設定と同じ扱いにする（graphFbs.js の OP.HEIGHT
 * 「0=未設定」規約を負値にも広げたもの——UI入力は絶対値化で負値を弾いているが（openings/
 * OpeningEditor.jsx）、復元データ・直接代入等 UI を経由しない経路からの負値混入に対しても
 * 姿図（rect の高さ）が壊れないよう、ここでも防御する）。
 */
export function effectiveHeight(opening) {
  const h = opening.height;
  return (h != null && h > 0) ? h : defaultOpeningHeight(opening.category, opening.subType);
}

function round(v) { return Math.round(v); }

/** 採番グループの同一性キー（記号|種別|幅|高さ|窓台高さ）。 */
export function openingSignature(opening) {
  const symbol = fixtureSymbolOf(opening);
  const height = effectiveHeight(opening);
  const sill = opening.sillHeight;
  return `${symbol}|${opening.subType}|${round(opening.width)}|${round(height)}|${sill == null ? '-' : round(sill)}`;
}

// ----------------------------------------------------------------
// パス1: 収集
// ----------------------------------------------------------------

/**
 * graph.openings を project.openingNumberIndex（非永続・observable.map）に積む。
 * この関数だけでは opening のタグは確定しない（確定は assignOpeningNumbers/applyOpeningTags）。
 *
 * このplane分の寄与は毎回「洗い替え」する（memberNumbering.collectFloorGroups と同じ理由）:
 *   1. 収集前に、既存の全エントリからこのplaneの寄与（counts.delete(planeId)）を取り消す。
 *   2. このgraphの現在の開口を再収集する。
 *   3. counts.size===0（どの階からも参照されなくなった）グループを index から削除する。
 */
export function collectFloorOpeningGroups(graph, project) {
  const planeId = graph.plane.id;

  for (const group of project.openingNumberIndex.values()) {
    group.counts.delete(planeId);
  }

  const localCounts = new Map(); // signature → このgraphでの本数

  for (const opening of graph.openings) {
    const signature = openingSignature(opening);
    localCounts.set(signature, (localCounts.get(signature) ?? 0) + 1);
    if (!project.openingNumberIndex.has(signature)) {
      project.openingNumberIndex.set(signature, {
        symbol: fixtureSymbolOf(opening),
        subType: opening.subType,
        width: opening.width,
        height: effectiveHeight(opening),
        sillHeight: opening.sillHeight,
        counts: new Map(),
        tag: null,
        no: null,
      });
    }
  }

  // project.openingNumberIndex は deep な observable.map（core.js）のため、直前の set() に渡した
  // plain object はそのまま格納されず、MobXが別のobservableオブジェクトへ深変換した複製が格納される
  // （値渡しではなく複製）。以後 group.counts.set で変異する対象を「格納実体」に揃えるため、
  // 変異の直前に必ず get() して差し替える（構造側 memberNumbering.js:83-92 で再発したバグと同型。
  // 差し替えないとこのplaneにしか存在しない新規グループの counts が空のまま残り、末尾のゴースト掃除で
  // 直後に削除されタグがnullのままになる）。
  for (const [signature, n] of localCounts) {
    const group = project.openingNumberIndex.get(signature);
    group.counts.set(planeId, n);
  }

  for (const [signature, group] of project.openingNumberIndex) {
    if (group.counts.size === 0) project.openingNumberIndex.delete(signature);
  }
}

// ----------------------------------------------------------------
// パス2: 採番（純関数）
// ----------------------------------------------------------------

// 幅降順・高さ降順・窓台高さ昇順・signature昇順のタイブレークで比較する（負=aが先）。
// entry = { signature, group }
function compareGroupsDesc(a, b) {
  if (a.group.width !== b.group.width) return b.group.width - a.group.width;
  if (a.group.height !== b.group.height) return b.group.height - a.group.height;
  const sa = a.group.sillHeight ?? -Infinity, sb = b.group.sillHeight ?? -Infinity;
  if (sa !== sb) return sa - sb;
  return a.signature < b.signature ? -1 : (a.signature > b.signature ? 1 : 0);
}

/**
 * project.openingNumberIndex（建物全体、収集済み）から signature → { tag, no } の対応表を作る
 * 純関数。副作用なし（entity・index には触れない）。no は記号内の連番（数値）——タグ文字列
 * （`AW-10`等）は辞書順ソートだと`AW-2`より前に来てしまうため、number順に並べたいリスト側
 * （openingGroupsOnFloor）は tag ではなく no を比較に使う。
 */
export function assignOpeningNumbers(project) {
  const bySymbol = new Map(); // symbol → [{signature, group}]
  for (const [signature, group] of project.openingNumberIndex) {
    if (!bySymbol.has(group.symbol)) bySymbol.set(group.symbol, []);
    bySymbol.get(group.symbol).push({ signature, group });
  }

  const tags = new Map();
  for (const [symbol, entries] of bySymbol) {
    const sorted = [...entries].sort(compareGroupsDesc);
    sorted.forEach((entry, i) => tags.set(entry.signature, { tag: `${symbol}-${i + 1}`, no: i + 1 }));
  }
  return tags;
}

/** assignOpeningNumbers の結果を project.openingNumberIndex の各グループの .tag/.no へ書き戻す。 */
export function applyOpeningTags(project, tags) {
  for (const [signature, { tag, no }] of tags) {
    const group = project.openingNumberIndex.get(signature);
    if (group) { group.tag = tag; group.no = no; }
  }
}

/** opening のタグ（未確定なら null）。 */
export function openingTagOf(opening, project) {
  return project.openingNumberIndex.get(openingSignature(opening))?.tag ?? null;
}

/**
 * 自階だけ collect → assign → apply する即時反映用（構造の renumberMembers と同格）。
 * project.openingNumberIndex に既に積まれている他階分（直近の反映パスで得た情報）を使って
 * 番号を決める——他階が一度も反映されていない場合は自階だけの相対順位で決まり、次のモード境界の
 * 反映パス（App.jsx collectOpeningNumbersAllFloors）で建物全体の順位に補正される。
 */
export function renumberOpenings(graph, project) {
  collectFloorOpeningGroups(graph, project);
  const tags = assignOpeningNumbers(project);
  applyOpeningTags(project, tags);
}

/**
 * パネル用: アクティブ階の開口を、その記号別グループごとにまとめて返す（tag昇順）。
 * @returns {Array<{ tag: string|null, group: object, openings: object[] }>}
 */
export function openingGroupsOnFloor(graph, project) {
  const bySignature = new Map(); // signature → openings[]
  for (const opening of graph.openings) {
    const signature = openingSignature(opening);
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(opening);
  }
  const out = [];
  for (const [signature, openings] of bySignature) {
    const group = project.openingNumberIndex.get(signature);
    out.push({ tag: group?.tag ?? null, group, openings });
  }
  out.sort((a, b) => {
    if (a.tag == null && b.tag == null) return 0;
    if (a.tag == null) return 1;
    if (b.tag == null) return -1;
    // タグ文字列（`AW-10`等）の辞書順ソートだと`AW-2`より前に来てしまうため、
    // 記号は文字列比較・番号は数値比較の2段ソートにする（Finding 2 再発防止）。
    const symA = a.group?.symbol ?? '', symB = b.group?.symbol ?? '';
    if (symA !== symB) return symA < symB ? -1 : 1;
    return (a.group?.no ?? 0) - (b.group?.no ?? 0);
  });
  return out;
}
