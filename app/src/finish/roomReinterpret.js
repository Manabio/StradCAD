// ================================================================
// floorplanモードでのCL追加・削除・延長・短縮・移動を経てfinishモードへ
// 再突入した際、各Room.cells（＝前回脱出時点の状態）を現在のCLトポロジーと
// 突き合わせて再解釈する。
//
// 判定は旧セルの内部代表点が属する現在の「連結領域」（regionCellsAt。
// 短縮でL字化していれば構成セル群）単位で行う:
//   0辺喪失               : 何もしない（既存 refreshCells の細分化追従に任せる）
//   関与する部屋が1つのみ   : 部屋の同一性は変えず、セルを現在の分割に置き換えるだけ
//                            （内部間仕切りの消失・無名領域への拡張はこちらに含まれる）
//   2部屋にまたがり1辺喪失 : セル数が少ない方の部屋が多い方の部屋の部分指定になる
//                            （両方の cells に新セルを追加し、少ない方の referenceRoomIds に追加）
//   2部屋にまたがり2辺以上喪失: セル数が少ない方から旧部屋名を削除し、多い方へ完全吸収する
//                            （少ない方の cells が空になれば部屋自体を削除）
// ================================================================

import { Room, RoomFeature, isShaftFeature, isRoofFeature } from '@core';
import {
  lostSides, cellInteriorPoint, regionCellsAt, refreshCells, cellBoundsFromKey, worldToCell,
  gridIndexOf, isActiveAcrossRange,
} from './gridCells.js';

function isEarlierInOrder(graph, idA, idB) {
  const order = graph.roomOrder;
  return order.indexOf(idA) < order.indexOf(idB);
}

// clId削除前のセルキーからCLを引く（shapeMap→structGraph.shapeMapの順。lostSides/cellInteriorPoint
// と同じ解決順序——既にダングリング（旧データ）のidはnullを返す）。
function getCLById(graph, id) {
  return graph.shapeMap.get(id) ?? graph._structGraph?.shapeMap.get(id) ?? null;
}

/**
 * 「失う辺」の生き残った反対側（refValue）から見て、その辺の外側方向（direction<0なら
 * refValueより小さい側、>0なら大きい側）に、直交範囲（orthoLo〜orthoHi）で有効な同軸の
 * 分割CLがもう1本あるか。worldToCellのbracketing（finish/gridCells.js の microInterval・
 * isActiveAcrossRange）と同じ規則を使う——これが1本も無ければ、cellInteriorPointが作る
 * 代表点（refValueからINTERIOR_EPS分だけ内側に寄せた点）は削除後の格子の外に出てしまい、
 * regionCellsAt が空になる（S1・2026-09-27実測: V0/4000/8000×H0/4000の左端セルでV0
 * （グリッド最外郭）を削除すると、右辺(4000)からEPS分内側の点が新しい最小値(4000)を
 * 下回り worldToCell が null を返す）。同じ判定規則を再実装せず gridIndexOf 経由で共有する
 * ことで、worldToCell 自体の挙動が変わってもここだけがズレる事故を防ぐ。
 * orthoLo/orthoHi が null（直交側の境界CL自体も既に解決不能）の場合は、lostSides の alive()
 * と同じく存在チェックのみに倒す（範囲不明の生半可な比較で誤判定しない）。
 */
function hasDividerBeyond(graph, isVertical, refValue, direction, orthoLo, orthoHi, excludeId) {
  const idx = gridIndexOf(graph);
  const dividers = isVertical ? idx.verticals : idx.horizontals;
  for (const d of dividers) {
    if (d.id === excludeId) continue;
    const beyond = direction < 0 ? d.value < refValue : d.value > refValue;
    if (!beyond) continue;
    if (orthoLo == null || orthoHi == null || isActiveAcrossRange(d, orthoLo, orthoHi)) return true;
  }
  return false;
}

// reinterpretRoomsOnEntry・findUnresolvableCells の両方が使う「再解釈対象外の部屋」判定
// （階段・階段吹抜け・未定義・昇降路・屋根の部屋。上記コメント参照）。
// 昇降路（isShaftFeature）は階段と同じ扱い（ユーザー裁定2026-09-29）: 全階同位置・器具単位で
// 矩形という前提があり、隣の部屋と統合すると床開口が広がり階またぎの整合が崩れるため対象外にする。
function isReinterpretExempt(room) {
  return room.feature === RoomFeature.STAIR || room.feature === RoomFeature.STAIR_VOID
    || room.feature === RoomFeature.UNDEFINED || isShaftFeature(room.feature)
    || isRoofFeature(room.feature); // 屋根も固定セル（屋内部屋の洪水に奪われず、屋根も屋内を吸わない）
}

/**
 * CL削除の事前判定（先読み）: clId をまだ削除する前に、削除後どの部屋セル・スラブセルが
 * reinterpretRoomsOnEntry / reinterpretSlabsAfterCLRemoval で救えない状態になるかを返す。
 * 対象は次の3種類（いずれも「削除後は永久にダングリングidのまま残る」という同じ結果になるため
 * 区別せず同じ配列に含める。呼び出し側は長さ（0件か否か）だけを見る）:
 *   1. 対辺2本同時喪失（左右とも、または上下とも）——cellInteriorPoint が null を返す条件と同じ。
 *      **先読みの喪失条件はcellInteriorPointのnull条件と完全に一致させる**: 「そのCLがgraphに
 *      存在しない」ことだけを喪失とみなす（M1・2026-09-27是正。13.stq実測: L字の正規キーで
 *      使われる「区間外だが実在するCL」の識別子——worldToCellのJSDoc「L字の内部分割位置に接する
 *      辺では、その区間で非アクティブなCLが識別子として使われる」参照——をlostSides()ベースで
 *      喪失扱いすると、それ自体は壊れたデータではないのに対辺2本喪失の誤検出が起き、無関係な
 *      内部間仕切りの削除まで拒否してしまう）。lostSides()（非アクティブも「再解釈が必要か」の
 *      起動条件として拾う）とは別物のため、ここでは使わない——clId自身の辺は削除後に存在しなく
 *      なるものとして扱い、残り3辺は getCLById（存在するかどうかのみ）で判定する。加えて、
 *      片辺のみの喪失でも、生き残った反対側のさらに外側（セルの外方向）に、直交範囲で有効な
 *      同軸の分割CLが1本も無ければ同様に復元不能とする（hasDividerBeyond。部屋・スラブの外周
 *      セルで対辺2本喪失に至らないまま代表点が格子外に出る退化——S1・2026-09-27実測）。
 *   2. 再解釈除外部屋（isReinterpretExempt＝階段・階段吹抜け・未定義・昇降路・屋根）のセル辺が clId を持つ場合。
 *      reinterpretRoomsOnEntry はこれらの部屋を常に素通りする（対辺の喪失数によらず一切変更しない）
 *      ため、辺の一つでも削除されるとRoom.cellsのダングリングidが未来永劫解消されない。
 *   3. スラブ（StructuralSlab.cells）で対辺2本同時喪失になるセル。スラブには部屋のような
 *      「再解釈除外」概念（feature）が無いため、上記1と同じ判定のみを行う（H2・2026-09-27）。
 *   4. 階段（Stair.cells）のセル辺が clId を持つ場合。Stair.cellsはRoom.cellsとは別持ちの
 *      フィールドで、それ自体を再解釈する経路が無い。設置階に
 *      ペアRoom（feature===STAIR）がある通常経路では、変換時にRoom.cellsのコピーとして
 *      作られて以後どちらも変更されない（isReinterpretExempt・本番コードにstair.setCells
 *      呼び出しが無いことをgrep実測）ため両者は常に同一集合になり、上記2のRoom側判定で
 *      間接的に守られるが、ペアRoomを一時的に失った旧データ（core/stair.js「旧データ・上階
 *      自動設置分」・ensureStairRooms参照）はRoomが無くこの判定を素通りしてしまう——階段は
 *      部屋のように「未定義化して残す」救済先も無いため、Room判定に頼らずStair.cells自体も
 *      直接・常に判定する（ペアRoomがある通常経路との二重判定はSetで自然に重複排除される）。
 * @param {import('@core').FloorGraph} graph
 * @param {string} clId これから削除しようとしているCLのid
 * @returns {string[]} 復元不能になるセルキーの配列（重複なし）
 */
export function findUnresolvableCells(graph, clId) {
  const result = new Set();
  // 対辺2本同時喪失、または片辺のみの喪失でもその外側にbracketできる分割CLが無い場合に
  // 復元不能と判定する（部屋・スラブ共通の判定関数。S1・2026-09-27で一般化。M1・2026-09-27で
  // 「喪失」の条件をcellInteriorPointと同じ「CLが存在しない」だけに絞る）。
  const isUnresolvableAfterLoss = (key) => {
    const ids = key.split(':');
    const sideIdx = ids.indexOf(clId);
    if (sideIdx === -1) return false; // このセルの辺に clId は無い
    const [leftId, topId, rightId, bottomId] = ids;
    // sideIdxの位置はclId自身の辺——削除後は必ず存在しなくなるためnull固定。他の3辺は
    // 「今graphに存在するか」だけで判定する（lostSidesの「非アクティブ」は見ない。M1）。
    const left   = sideIdx === 0 ? null : getCLById(graph, leftId);
    const top    = sideIdx === 1 ? null : getCLById(graph, topId);
    const right  = sideIdx === 2 ? null : getCLById(graph, rightId);
    const bottom = sideIdx === 3 ? null : getCLById(graph, bottomId);

    if ((!left && !right) || (!top && !bottom)) return true; // 対辺2本同時喪失

    const orthoLoV = top?.value ?? null, orthoHiV = bottom?.value ?? null; // left/right側の直交範囲
    const orthoLoH = left?.value ?? null, orthoHiH = right?.value ?? null; // top/bottom側の直交範囲

    if (!left && !hasDividerBeyond(graph, true, right.value, -1, orthoLoV, orthoHiV, clId)) return true;
    if (!right && !hasDividerBeyond(graph, true, left.value, 1, orthoLoV, orthoHiV, clId)) return true;
    if (!top && !hasDividerBeyond(graph, false, bottom.value, -1, orthoLoH, orthoHiH, clId)) return true;
    if (!bottom && !hasDividerBeyond(graph, false, top.value, 1, orthoLoH, orthoHiH, clId)) return true;
    return false;
  };

  for (const room of graph.rooms) {
    const exempt = isReinterpretExempt(room);
    for (const key of room.cells) {
      if (key.split(':').indexOf(clId) === -1) continue; // このセルの辺に clId は無い
      if (exempt) {
        // 再解釈対象外の部屋は救済経路自体が無いため、辺を1つでも失えば即・復元不能。
        result.add(key);
        continue;
      }
      if (isUnresolvableAfterLoss(key)) result.add(key);
    }
  }
  for (const slab of graph.slabs) {
    for (const key of slab.cells) {
      if (isUnresolvableAfterLoss(key)) result.add(key);
    }
  }
  for (const stair of graph.stairs) {
    for (const key of stair.cells) {
      // 階段はペアRoom（feature===STAIR。isReinterpretExempt）と同じ理由で救済経路が無いため、
      // 辺を1つでも参照していれば即・復元不能（ペアRoomの有無によらずStair.cells自体を判定する）。
      if (key.split(':').indexOf(clId) !== -1) result.add(key);
    }
  }
  return [...result];
}

/**
 * 復元不能セル集合の直接判定（M2・2026-09-27）: findUnresolvableCells（削除前の先読み・
 * hasDividerBeyondによる近似判定）と違い、これは「今の graph の状態で実際に復元不能かどうか」を
 * cellInteriorPoint・regionCellsAt で直接判定する純関数。非除外の部屋・全スラブの各セルについて、
 * cellInteriorPoint が null を返す、または regionCellsAt が空になるものを集める（近似を挟まない
 * ため取りこぼしが無い——ただし全セルを実際に評価するため、先読みの代わりに削除確定前のガードに
 * 使うにはコストが高い。用途は deleteCenterLineWithUndo の安全網: 削除前後でこの関数を呼び、
 * 差分（後始末後に新規に増えた分）だけを見ることで、領域が削除CLの向こう側へ延びて**clIdを
 * 含まないキー**のセルが新たに復元不能になるケースも含めて拾える——key.includes(clId)によるフィルタ
 * では取りこぼす。除外部屋（isReinterpretExempt）はfindUnresolvableCellsと違い「辺を1つでも失えば
 * 即復元不能」という特別ルールを持たないため対象外——これらの部屋は元からreinterpretRoomsOnEntryの
 * 対象外で、cellInteriorPoint/regionCellsAtの実測とは無関係にダングリングidを持ち歩く設計であり、
 * 「今のgraphで実際に復元不能か」という物理的な判定にはそぐわない）。
 * @param {import('@core').FloorGraph} graph
 * @returns {Set<string>} 復元不能なセルキーの集合（部屋・スラブ問わず。重複除去）
 */
export function collectUnresolvableCells(graph) {
  const result = new Set();
  const isUnresolvable = (key) => {
    const pt = cellInteriorPoint(key, graph);
    return !pt || regionCellsAt(pt.x, pt.y, graph).length === 0;
  };
  for (const room of graph.rooms) {
    if (isReinterpretExempt(room)) continue;
    for (const key of room.cells) {
      if (isUnresolvable(key)) result.add(key);
    }
  }
  for (const slab of graph.slabs) {
    for (const key of slab.cells) {
      if (isUnresolvable(key)) result.add(key);
    }
  }
  return result;
}

/**
 * CL削除の自階後始末（H2・2026-09-27）: reinterpretRoomsOnEntry のスラブ版。
 * 各スラブの各セルについて lostSides が非空（＝この削除で辺を失う）なら、cellInteriorPoint→
 * regionCellsAt で現在の領域セル群を求め、旧キーをその領域のキー群に置き換える。
 *
 * Room と違いスラブには「部分指定・親子（referenceRoomIds）」の概念が無いため、同一スラブ内で
 * 複数の旧キーが同じ領域へ吸収される場合は単純に union する。CLの消失で複数スラブが同じ領域へ
 * 吸収される事態（例: スラブ間の仕切りCLの削除）は、Roomの「セル数が少ない方を吸収」と同じく
 * 併合を採用する（S2・2026-09-27裁定）——決定的な順序（graph.slabs の並び＝生成順）で先着の
 * スラブが併合セルを領有し、後発のスラブは吸収されて完全に消える。優劣の根拠（面積・厚み等）が
 * スラブには無いため「先着」をタイブレークにする点はH2から変わらないが、旧実装は後発スラブを
 * 0セルのまま残していた——0セルのスラブは実体として無意味であり、放置すると「復元不能の亜種
 * （空だが存在するだけの残骸）」を残すため、併合の結果0セルになったスラブは graph から削除する
 * （Roomの完全吸収＝graph.removeRoomと同じ扱い）。
 *
 * 貫通孔（PenetrationSleeve。hostType==='slab'）の追従（H2追補・S2で移籍対応に拡張。
 * 2026-09-27。持ち越し不可の裁定）: スリーブは絶対座標を持たず、localX/localYは
 * 「hostCellKeyのセルからのローカルオフセット」（core/structuralEntities.js）——セルが
 * 再解釈で置き換わるとオフセットの基準ごと失われるため、スリーブ自身の座標の代わりに、
 * そのセルの再解釈で使った代表点（cellInteriorPoint）をスリーブの位置の代役として使い、
 * その点で worldToCell を引いた新セルへ hostCellKey を付け替える（localX/localYは元の値の
 * まま——このアプリではどこからも読まれておらず（grep実測。梁ホストのlocalPos/heightOffsetと
 * 違い描画・構造計算の消費側が無い）、意味付けを新設せず現状維持する）。新セルがどのスラブの
 * セルでもない場合（格子外・regionCellsAt空）だけホスト先を失うため削除する。新セルが**別の
 * スラブ**（併合セルの領有先）のものになった場合は、Roomの部屋間吸収と同じ考え方でそちらへ
 * 移籍する（hostSlabId・hostCellKeyを付け替え）——旧実装は「自スラブのセルでなくなったら削除」
 * だったが、セル自体は消えておらず単に領有先が変わっただけなので、スリーブを黙って消すのは
 * 過剰（S2・2026-09-27是正）。付け替えはslab.removeSlabより先に行う——removeSlabは残った
 * hostSlabId一致のスリーブを道連れ削除する仕様のため、順序を誤ると移籍前に消えてしまう。
 * @param {import('@core').FloorGraph} graph
 * @returns {{ unresolved: string[] }} 復元不能（現状維持にした）セルキーの配列
 */
export function reinterpretSlabsAfterCLRemoval(graph) {
  const slabs = graph.slabs;
  if (slabs.length === 0) return { unresolved: [] };

  const unresolved = new Set();
  // 領有マップ: セルキー → 領有中のスラブid。「辺を失っていない（＝現在も有効な）セル」を
  // 先に登録しておくことで、他スラブの再解釈結果がそのセルへ重複侵入するのを防ぐ。
  const claimedBy = new Map();
  for (const slab of slabs) {
    for (const key of slab.cells) {
      if (lostSides(key, graph).length === 0) claimedBy.set(key, slab.id);
    }
  }

  // このパスで実際に処理した（lostKeysが非空だった）スラブのidのみを完全吸収の削除候補にする
  // ——最初から0セルだった無関係なスラブまで巻き込まないため。
  const processedSlabIds = new Set();
  // スリーブの付け替え/移籍先の確定は全スラブのnextCellsが出そろってから行う——別スラブへの
  // 移籍先（claimedBy）が、そのスラブの処理順によって未確定/確定済みのどちらもありうるため。
  const sleeveReanchors = []; // { sleeve, pt }

  for (const slab of slabs) {
    const lostKeys = [...slab.cells].filter(key => lostSides(key, graph).length > 0);
    if (lostKeys.length === 0) continue;
    processedSlabIds.add(slab.id);

    const nextCells = new Set(slab.cells);
    for (const oldKey of lostKeys) {
      const pt = cellInteriorPoint(oldKey, graph);
      // 復元不能（対辺2本同時喪失の退化ケース）はreinterpretRoomsOnEntryと同じ「現状維持」
      // 方針——oldKeyをnextCellsから消さずに残す（unresolvedへは記録する。findUnresolvableCells
      // が事前に拒否するため実運用ではここに来ない想定だが、防御的に現状維持で扱う）。
      if (!pt) { unresolved.add(oldKey); continue; }
      const region = regionCellsAt(pt.x, pt.y, graph);
      if (region.length === 0) { unresolved.add(oldKey); continue; }

      nextCells.delete(oldKey);
      for (const c of region) {
        const owner = claimedBy.get(c.key);
        if (owner && owner !== slab.id) continue; // 別スラブが既に領有→重複キーはこのスラブから外す
        claimedBy.set(c.key, slab.id);
        nextCells.add(c.key);
      }

      for (const sleeve of graph.sleeves) {
        if (sleeve.hostType === 'slab' && sleeve.hostSlabId === slab.id && sleeve.hostCellKey === oldKey) {
          sleeveReanchors.push({ sleeve, pt });
        }
      }
    }
    slab.setCells(nextCells);
  }

  for (const { sleeve, pt } of sleeveReanchors) {
    const newCell = worldToCell(pt.x, pt.y, graph);
    const ownerId = newCell ? claimedBy.get(newCell.key) : null;
    if (!newCell || !ownerId) {
      // どのスラブのセルでもなくなった（格子外・regionCellsAt空）→ホスト先を失うため削除。
      graph.removeSleeve(sleeve.id);
    } else if (ownerId === sleeve.hostSlabId) {
      sleeve.setHostCellKey(newCell.key); // 自スラブ内での併合セルへの付け替え
    } else {
      // 別スラブ（併合セルの領有先）へ移籍する——removeSlabより先に張り替える。
      sleeve.setHostSlabId(ownerId);
      sleeve.setHostCellKey(newCell.key);
    }
  }

  // 併合の結果0セルになったスラブは完全吸収されたものとして削除する（Roomの完全吸収と同じ扱い。
  // removeSlabは残ったhostSlabId一致のスリーブを道連れ削除するが、上のループで先に付け替え済み
  // なので、ここに残っているスリーブがあれば本当にこのスラブがホスト先のまま——通常は無い）。
  for (const id of processedSlabIds) {
    const slab = graph.slabMap.get(id);
    if (slab && slab.cells.size === 0) graph.removeSlab(id);
  }

  return { unresolved: [...unresolved] };
}

/**
 * @param {import('@core').FloorGraph} graph
 * @returns {{ unresolved: string[] }} 復元不能（現状維持にした）セルキーの配列
 */
export function reinterpretRoomsOnEntry(graph) {
  const rooms = graph.rooms;
  if (rooms.length === 0) return { unresolved: [] };

  const unresolved = new Set();

  // 不変条件: 固定セル（再解釈除外部屋＝isReinterpretExempt＝階段・階段吹抜け・未定義・
  // 昇降路・屋根のセルと、Stair.cellsのセル）の所有は動かさない——他の部屋の洪水先（領域の
  // flood-fill）としてこれらを奪わないだけでなく、固定セル自身をoldKeyとして持つ通常の
  // 部屋（階段下部屋＝2a。破れ先セルを正規に持つのが設計上正しい。stairUnderRoomsOfの
  // 前提）からも動かさない。開口（区間内で非アクティブな分割CL）を挟んで隣の部屋の連結領域が
  // 固定セルへ延びると、二重所有により2a判定（finish/stair/stairUnderRooms.js
  // stairUnderRoomsOf）が誤発火する（moku2-1 2階実測・2026-10-01。QA指摘1・2026-10-01で
  // 「奪わない」から「所有は動かさない」へ言い直し: 固定セルをoldKeyとして持つ通常の部屋も
  // 洪水対象から外すことで、そのセル自身が固定セルである場合に現状維持できるようにした）。
  const fixedCells = new Set();
  for (const room of rooms) {
    if (!isReinterpretExempt(room)) continue;
    for (const key of refreshCells(room.cells, graph)) fixedCells.add(key);
  }
  for (const stair of graph.stairs) {
    for (const key of refreshCells(stair.cells, graph)) fixedCells.add(key);
  }

  // 1. 影響を受けるセルを収集し、現在の分割上での連結領域（正準ID）でグルーピングする
  const groups = new Map(); // regionId -> { cells, entries: [{ room, oldKey, lostCount }] }
  for (const room of rooms) {
    // 階段Room（feature===STAIR）は再解釈しない。フットプリントは階段設置時に確定済みで、
    // 吸収/削除されると Stair.roomId が孤児化するため（フェーズ2以前は階段はRoomでなく対象外だった＝従来挙動を維持）。
    // 階段吹抜け（STAIR_VOID）も同様に対象外（自動管理 Room。同期側が footprint を管理する）。
    // 未定義の部屋（UNDEFINED）も対象外（外壁線維持のための残置セル。命名/削除でのみ変化する）。
    // 昇降路（isShaftFeature）も対象外（階段と同じ扱い。ユーザー裁定2026-09-29）: 全階同位置・
    // 器具単位で矩形という前提があり、隣の部屋と統合すると床開口が広がり階またぎの整合が崩れる。
    if (isReinterpretExempt(room)) continue;
    for (const oldKey of room.cells) {
      const lost = lostSides(oldKey, graph);
      if (lost.length === 0) continue;

      // oldKey自身が固定セル（現在の分割へrefreshした結果のいずれかがfixedCellsに含まれる。
      // 未細分化ならoldKey自身を含む）なら、洪水させず現状のまま残す（上記不変条件。
      // QA指摘1・2026-10-01: 物入=階段の破れ先セル(bot)を正規に持つ通常の部屋が、botを
      // fixedCells扱いで奪われて廊下の部分指定に化け、廊下のcellsが空になる不良の修正）。
      const refreshedOld = refreshCells(new Set([oldKey]), graph);
      // unresolved へは加えない: 2a部屋が破れ先セル（固定セル）を持つのは正規の状態で、復元不能ではないため。
      if ([...refreshedOld].some(k => fixedCells.has(k))) continue;

      const pt = cellInteriorPoint(oldKey, graph);
      if (!pt) { unresolved.add(oldKey); continue; } // 退化ケース（対辺2本同時消失）→ 復元不能なので今回は現状維持

      // 洪水先の領域から、除外部屋・Stair.cellsのセル（fixedCells）を奪わないよう除く
      // （上記不変条件）。除いた結果が空なら復元不能として現状維持する。
      const region = regionCellsAt(pt.x, pt.y, graph).filter(c => !fixedCells.has(c.key));
      if (region.length === 0) { unresolved.add(oldKey); continue; }

      const regionId = region.map(c => c.key).sort().join('|');
      if (!groups.has(regionId)) groups.set(regionId, { cells: region, entries: [] });
      groups.get(regionId).entries.push({ room, oldKey, lostCount: lost.length });
    }
  }

  // 2. グループごとに解決
  for (const { cells, entries } of groups.values()) {
    const roomIds = new Set(entries.map(e => e.room.id));

    if (roomIds.size <= 1) {
      const room = entries[0].room;
      for (const e of entries) room.removeCell(e.oldKey);
      for (const c of cells) room.addCell(c.key);
      continue;
    }

    // セル数最多の部屋を親（dominant）とする。同数なら仕上げ表の並び順が先の方。
    let dominant = entries[0].room;
    for (const e of entries) {
      const r = e.room;
      if (r.id === dominant.id) continue;
      if (r.cells.size > dominant.cells.size ||
          (r.cells.size === dominant.cells.size && isEarlierInOrder(graph, r.id, dominant.id))) {
        dominant = r;
      }
    }

    // 先に全エントリのoldKeyを消してから親・子へセルを足す（1部屋グループと同じ「消してから
    // 足す」順序）。消す前に足すと、親が足したばかりのセルを自分のoldKeyの削除で直後に
    // 消してしまう（QA指摘2・2026-10-01: oldKeyが洪水先の領域cellsに残っていると、親の
    // セルが意図せず減る既存不良の修正）。
    for (const e of entries) e.room.removeCell(e.oldKey);

    for (const c of cells) dominant.addCell(c.key);

    // 部分指定か吸収かはエントリ単位でなく部屋単位で決める（全oldKey先消しで、2辺喪失エントリの
    // 時点で他のoldKeyも消えて空に見えるため）。HEADと同じ結果: 1辺喪失が1件でもあれば部分指定／
    // 全件2辺以上かつ空なら吸収削除／2辺以上でも他のセルが残れば何もしない。
    const byRoom = new Map(); // roomId -> { room, hasSingleLoss }
    for (const e of entries) {
      if (e.room.id === dominant.id) continue;
      const slot = byRoom.get(e.room.id) ?? { room: e.room, hasSingleLoss: false };
      if (e.lostCount === 1) slot.hasSingleLoss = true;
      byRoom.set(e.room.id, slot);
    }
    for (const { room, hasSingleLoss } of byRoom.values()) {
      if (hasSingleLoss) {
        // 1辺喪失 → 部分指定化（子の同一性・仕上げ情報は維持したまま親の内訳になる）
        for (const c of cells) room.addCell(c.key);
        room.referenceRoomIds.add(dominant.id);
      } else if (room.cells.size === 0) {
        // 2辺以上喪失 → 旧部屋名を削除し、親へ完全吸収（屋外部屋の連動行も孤児化させず削除）
        graph.removeExteriorRowsByRoomId(room.id);
        graph.removeRoom(room.id);
      }
    }
  }

  return { unresolved: [...unresolved] };
}

/**
 * 部分指定の面積が親の残余面積（親セル − 全部分指定セル）を上回ったら親子を入れ替える。
 * 部屋の主従は「支配的な方（面積の大きい方）が親」であるべきで、部分指定が残余を
 * 上回ったまま放置すると、外周壁の帰属・天井高の継承・展開図の帯（いずれも親基準）が
 * 小さい方の部屋にぶら下がり続けてしまう。
 * なお部屋名ラベルの重なり防止そのものは配置ルール側が担う（roomLabel.js の
 * roomNameAnchor: 親の自動配置は部分指定に奪われていないセルから選ぶ）。
 *
 * 入れ替えの内容（面積最大の部分指定が残余より大きい場合のみ。同値は現状維持）:
 *   勝った子: 親の全セルを引き継いで参照元（referenceRoomIds 空）になる
 *   旧親    : 残余セルだけの部分指定へ降格し、勝った子を参照する
 *   他の子  : 参照先を旧親から勝った子へ付け替える
 *   生成壁  : 外周壁は親が担う（glossary「部分指定」）ため帰属を入れ替える
 *   表示順  : roomOrder 上の位置も入れ替える（部分指定は親の後に並ぶ挿入規則を保つ）
 * 各セルの実効床レベルは「そのセルを持つ部分指定 ＞ 親」の優先で解決されるため、
 * セル集合と参照方向を同時に入れ替えれば見た目・段差の意味は変わらない。
 * @param {import('@core').FloorGraph} graph
 */
export function normalizePartialDominance(graph) {
  const rooms = graph.rooms;
  const parents = rooms.filter(r => r.referenceRoomIds.size === 0 && r.feature === null);
  for (const parent of parents) {
    const children = rooms.filter(r => r.referenceRoomIds.has(parent.id));
    if (children.length === 0) continue;

    const areaOf = (cells) => {
      let area = 0;
      for (const key of cells) {
        const b = cellBoundsFromKey(key, graph);
        if (b) area += (b.x2 - b.x1) * (b.y2 - b.y1);
      }
      return area;
    };

    const fullCells = refreshCells(parent.cells, graph);
    const childCells = new Map(children.map(c => [c.id, refreshCells(c.cells, graph)]));
    const remaining = new Set(fullCells);
    for (const cells of childCells.values()) for (const key of cells) remaining.delete(key);
    if (remaining.size === 0) continue; // 退化ケース（部分指定が親全域を覆う）は現状維持

    // 入れ替え候補は通常の部分指定（feature なし・参照先が親のみ）に限る。
    // 面積同値なら先勝ち（roomOrder 順）＝現親優先で入れ替えない。
    let winner = null, winnerArea = areaOf(remaining);
    for (const c of children) {
      if (c.feature !== null || c.referenceRoomIds.size !== 1) continue;
      const a = areaOf(childCells.get(c.id));
      if (a > winnerArea) { winner = c; winnerArea = a; }
    }
    if (!winner) continue;

    // 勝った子は親の全セルを引き継ぐ。自前の生キーも保持する——refreshCells 由来の
    // 集合だけに置き換えると、親に含まれないセル（reinterpretRoomsOnEntry の
    // 1辺喪失経路では 親⊉子 がありうる）や解決不能キーを黙って失う。
    // 粒度の違う重複キーは使用側の refreshCells が正規化する。
    winner.setCells(new Set([...winner.cells, ...fullCells]));
    winner.referenceRoomIds.delete(parent.id);
    // 旧親は残余セルの部分指定へ降格。解決不能な生キー（CL削除の退化ケース）は
    // reinterpretRoomsOnEntry の現状維持方針に合わせて捨てずに残す。
    const unresolved = [...parent.cells].filter(key => !cellBoundsFromKey(key, graph));
    parent.setCells(new Set([...remaining, ...unresolved]));
    parent.referenceRoomIds.add(winner.id);
    for (const c of children) {
      if (c.id === winner.id) continue;
      c.referenceRoomIds.delete(parent.id);
      c.referenceRoomIds.add(winner.id);
    }

    const demotedWalls = new Set(winner.generatedWallIds);
    winner.generatedWallIds = new Set(parent.generatedWallIds);
    parent.generatedWallIds = demotedWalls;

    const order = [...graph.roomOrder];
    const pi = order.indexOf(parent.id), wi = order.indexOf(winner.id);
    if (pi >= 0 && wi >= 0) {
      order[pi] = winner.id;
      order[wi] = parent.id;
      graph.reorderRooms(order);
    }

    // 明示ラベル位置が新しいセル集合の外に出た場合は自動配置へ戻す
    for (const room of [parent, winner]) {
      const p = room.namePosition;
      if (!p) continue;
      const inside = [...room.cells].some(key => {
        const b = cellBoundsFromKey(key, graph);
        return b && p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2;
      });
      if (!inside) room.namePosition = null;
    }
  }
}

function cellSetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * ペア Room を持たない Stair（旧データ・上階自動設置分）へ feature=STAIR の Room を補完し、
 * 相互リンク（Stair.roomId）を回復する（不変条件は `.claude/data-model.md`。Room が無いと
 * 外壁生成・境界分類が階段エリアを「無名屋外」とみなし、隣接部屋の周囲に誤った外壁ができる）。
 * footprint が一致する階段吹抜け（STAIR_VOID。旧最上階の自動指定分）があれば、新規作成せず
 * その Room をペア Room へ転用する（階追加による中間階への移行。セル集合と Room 同一性を保つ）。
 * フットプリントが既存 Room のセルと重なる場合は補完しない（その領域は既に「屋内」で
 * 症状が出ず、セルの二重割当を避けるため）。
 * @param {import('@core').FloorGraph} graph
 * @returns {{stair, room, prevRoomId}[]} 補完した組（undo 用。呼び出し側で roomId を戻す。
 *   room.feature の巻き戻しは rooms スナップショット側が担う）
 */
export function ensureStairRooms(graph) {
  const changes = [];
  const orphans = graph.stairs.filter(s => !s.roomId || !graph.roomMap.has(s.roomId));
  if (orphans.length === 0) return changes;

  const assigned = new Set();
  for (const room of graph.rooms) {
    for (const key of refreshCells(room.cells, graph)) assigned.add(key);
  }
  for (const stair of orphans) {
    const cells = refreshCells(stair.cells, graph);
    if (cells.size === 0) continue;

    // 旧最上階の階段吹抜けが footprint と一致すればペア Room へ転用
    const voidRoom = graph.rooms.find(r =>
      r.feature === RoomFeature.STAIR_VOID && cellSetsEqual(refreshCells(r.cells, graph), cells));
    if (voidRoom) {
      voidRoom.setFeature(RoomFeature.STAIR);
      const prevRoomId = stair.roomId;
      stair.setField('roomId', voidRoom.id);
      changes.push({ stair, room: voidRoom, prevRoomId });
      continue;
    }

    if ([...cells].some(key => assigned.has(key))) continue;

    const room = graph.addRoom(cells);
    room.setFeature(RoomFeature.STAIR);
    const prevRoomId = stair.roomId;
    stair.setField('roomId', room.id);
    for (const key of cells) assigned.add(key);
    changes.push({ stair, room, prevRoomId });
  }
  return changes;
}

// ----------------------------------------------------------------
// undo/redo 用スナップショット（reinterpretRoomsOnEntry は部屋の削除も
// 行うため、単なる cells/referenceRoomIds の差分ではなく Room 一覧全体を
// 対象にする。plain object での往復に留め、FlatBuffers化はしない
// —— snapshotWall/snapshotEdges と同じ「単発操作の巻き戻し」用途のため）
// ----------------------------------------------------------------

export const FINISH_FIELDS = [
  'floorMaterial', 'baseboardMaterial', 'baseboardHeight', 'dadoMaterial',
  'dadoHeight', 'ceilingMaterial', 'cornice', 'note',
];

/** graph.rooms の全フィールドをスナップショットする。 */
export function snapshotRoomsState(graph) {
  return {
    roomOrder: [...graph.roomOrder],
    rooms: graph.roomOrder.filter(id => graph.roomMap.has(id)).map(id => {
      const r = graph.roomMap.get(id);
      return {
        id: r.id, name: r.name, cells: [...r.cells], referenceRoomIds: [...r.referenceRoomIds],
        kind: r.kind, feature: r.feature, templateKey: r.templateKey, floorLevel: r.floorLevel,
        exteriorSlope: r.exteriorSlope, exteriorLevelRef: r.exteriorLevelRef, exteriorLevel: r.exteriorLevel,
        namePosition: r.namePosition ? { x: r.namePosition.x, y: r.namePosition.y } : null,
        generatedWallIds: [...r.generatedWallIds],
        customOverrides: [...r.customOverrides],
        finish: Object.fromEntries(FINISH_FIELDS.map(f => [f, r.finish[f]])),
      };
    }),
  };
}

/** snapshotRoomsState の結果から graph.rooms を復元する（undo/redo 用）。 */
export function restoreRoomsState(graph, snap) {
  graph.roomMap.clear();
  graph.roomOrder.clear();
  for (const d of snap.rooms) {
    const room = new Room(d.id, d.name, new Set(d.cells), new Set(d.referenceRoomIds), d.kind, d.templateKey, d.feature ?? null);
    room.generatedWallIds = new Set(d.generatedWallIds);
    if (d.floorLevel != null) room.setFloorLevel(d.floorLevel);
    if (d.exteriorSlope != null) room.setExteriorSlope(d.exteriorSlope);
    if (d.exteriorLevelRef) room.setExteriorLevelRef(d.exteriorLevelRef);
    if (d.exteriorLevel != null) room.setExteriorLevel(d.exteriorLevel);
    if (d.namePosition) room.setNamePosition(d.namePosition.x, d.namePosition.y);
    for (const [k, v] of d.customOverrides) room.customOverrides.set(k, v);
    for (const [k, v] of Object.entries(d.finish)) if (v) room.finish.setField(k, v);
    graph.roomMap.set(room.id, room);
  }
  graph.roomOrder.replace(snap.roomOrder.filter(id => graph.roomMap.has(id)));
}
