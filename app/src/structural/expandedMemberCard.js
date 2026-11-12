// ================================================================
// 構造リストの「開いているカード」を部材の id で覚え、番号（タグ）は表示のたびに引き直す純モジュール
// （react/konva/store 非依存・import なし。node:test から単体 import 可能）。
// 出典: ユーザー裁定2026-11-12 案A（R1〜R7）。従来は `${mapName}:${部材番号}` で覚えていたため、部材の追加などで
// 番号がずれると別グループのカードが開いた扱いになった。
//  R1 覚えるのはグループの全部材の id＋「主 id」（タップ・操作した部材）。
//  R2 グループが割れたら主 id の側。主 id が無ければ覚えている部材を多く含む側（同数は一覧で上のカード）。
//  R4 覚えている部材がすべて消えたら閉じる。undo で戻っても開き直さない。
//  R7 伏図タップでどのカードにも一致しなければ閉じる。
// graph・部材オブジェクトは受け取らず、id（文字列）とタグ（文字列）だけを扱う。入力は変更しない。
// ================================================================

/** @typedef {{ mapName: string, ids: string[], primaryId: string|null, tag: string|null }} CardAnchor 覚えている「開いているカード」 */
/** @typedef {{ sectionKey: string, mapName: string, cards: { tag: string, ids: string[] }[] }} ListingSection 一覧の 1 セクション（描画順） */

const isNonEmptyString = v => typeof v === 'string' && v !== '';

/** カードのトグル・分割の確定で使う。 */
export function anchorForCard(mapName, ids, primaryId = null) {
  if (!isNonEmptyString(mapName)) throw new Error('anchorForCard: mapName が空でない文字列ではありません');
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('anchorForCard: ids が空でない配列ではありません');
  if (primaryId !== null && typeof primaryId !== 'string') throw new Error('anchorForCard: primaryId が null でも文字列でもありません');
  return { mapName, ids: [...ids], primaryId, tag: null };
}

/** 伏図の部材タップ（{ mapName, tag, fieldKey, entityId }）から。mapName・tag が無ければ null。 */
export function anchorForFocus(focusRequest) {
  if (!(focusRequest?.mapName && focusRequest.tag)) return null;
  const { mapName, tag, entityId } = focusRequest;
  const id = entityId ? entityId : null; // 空文字も「id なし」（ids が空なのに主 id だけ残る形を作らない）
  return { mapName, ids: id ? [id] : [], primaryId: id, tag };
}

/** 「この部材を主にする」。同じ mapName なら ids・tag を保ち主だけ差し替える。 */
export function withPrimaryMember(anchor, mapName, id) {
  if (!isNonEmptyString(mapName)) throw new Error('withPrimaryMember: mapName が空でない文字列ではありません');
  if (!isNonEmptyString(id)) throw new Error('withPrimaryMember: id が空でない文字列ではありません');
  if (anchor && anchor.mapName === mapName) {
    const ids = anchor.ids.includes(id) ? [...anchor.ids] : [...anchor.ids, id];
    return { mapName, ids, primaryId: id, tag: anchor.tag };
  }
  return { mapName, ids: [id], primaryId: id, tag: null };
}

/** アンカーが指すカードを一覧から探す。→ { sectionKey, mapName, tag, ids } | null */
export function resolveExpandedCard(anchor, sections) {
  if (!Array.isArray(sections)) throw new Error('resolveExpandedCard: sections が配列ではありません');
  if (!anchor) return null;
  const found = (section, card) => ({ sectionKey: section.sectionKey, mapName: section.mapName, tag: card.tag, ids: [...card.ids] });
  const targets = sections.filter(s => s.mapName === anchor.mapName);
  // 1. 主 id を含むカード
  if (anchor.primaryId != null) {
    for (const s of targets) for (const c of s.cards) if (c.ids.includes(anchor.primaryId)) return found(s, c);
  }
  // 2. 覚えている id を最も多く（1 つ以上）含むカード。同数は一覧順で先
  const remembered = new Set(anchor.ids);
  let best = null, bestCount = 0;
  for (const s of targets) {
    for (const c of s.cards) {
      let n = 0;
      for (const id of c.ids) if (remembered.has(id)) n++;
      if (n > bestCount) { best = found(s, c); bestCount = n; }
    }
  }
  if (best) return best;
  // 3. id が 1 枚も当たらないときだけ tag
  if (anchor.tag != null) {
    for (const s of targets) for (const c of s.cards) if (c.tag === anchor.tag) return found(s, c);
  }
  return null;
}

/** 描画後の取り直し。resolved は resolveExpandedCard(resolvedFrom, sections) の結果。 */
export function reconcileAnchor(current, resolvedFrom, resolved) {
  if (current !== resolvedFrom) return current;
  if (current === null || current === undefined) return null;
  if (!resolved) return null;
  const ids = [...resolved.ids];
  const primaryId = current.primaryId != null && ids.includes(current.primaryId) ? current.primaryId : null;
  // resolved は current から引いた結果なので mapName は必ず同じ（比べない）。
  const same = current.tag === null
    && current.primaryId === primaryId
    && current.ids.length === ids.length
    && current.ids.every((id, i) => id === ids[i]);
  if (same) return current;
  return { mapName: current.mapName, ids, primaryId, tag: null };
}

/** MemberListTab の [{ sectionKey, mapName, tagGroups: [[tag, members], ...] }] → ListingSection[]。 */
export function cardListing(sections) {
  if (!Array.isArray(sections)) throw new Error('cardListing: sections が配列ではありません');
  return sections.map(s => ({
    sectionKey: s.sectionKey,
    mapName: s.mapName,
    cards: s.tagGroups.map(([tag, members]) => ({ tag, ids: members.map(m => m.id) })),
  }));
}
