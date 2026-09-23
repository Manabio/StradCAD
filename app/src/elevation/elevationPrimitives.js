/**
 * 展開図: プリミティブ配列の共通操作（buildRoomBand・buildStairBand 共有）。
 * 設計意図は .claude/elevation-model.md 参照。
 *
 * translatePrimitive・collectGridCLs・部屋名枠の組み立ては、以前は elevationBand.js と
 * elevationStair.js にコピペで二重実装されており（QA指摘）、片方だけpolylineケースが
 * 抜ける・片方だけ部屋名枠を組み立てない、といった分岐が生じていた。両ビルダーはこのファイルの
 * 実装だけを使う。
 */
import { CenterLineType, isGridCenterLine } from '@core';
import { figureBounds } from '../structural/sectionFigure/sectionGeometry.js';
import {
  ElevationLineRole, weightForRole, DEFAULT_NAME_GAP_MM, GAP_EPS_MM as PRIM_GAP_EPS,
} from './elevationStyle.js';
import { graphList } from '../graphReadScope.js';

const NAME_BOX_H_MM      = 400;
const NAME_BOX_CHAR_W_MM = 350;
const NAME_BOX_MIN_W_MM  = 1200;

/**
 * 帯の中で**同じ位置・同じ線種の線が2本以上ある**とき1本にまとめる（先勝ち）。
 *
 * 1枚の帯には`buildFaceFigure`（図面の体裁＋端の縦線）と断面エンジン（壁の輪郭）の
 * 2経路からプリミティブが流れ込む。両者が同じ実体の縁を別の理由で描くこと自体は正常
 * （例: 面端の縦線は体裁としての「端の縦線」であり、同時に壁断面の縁でもある）——
 * 見た目は完全に同じなので、残しても描画結果は変わらないが、
 *   - 視覚回帰スナップショットに「経路が増えただけ」の差分が乗って本当の変化を隠す
 *   - 同じ線が2本あると、以後どちらを消してよいか判断できない
 * ため、帯を確定する1箇所（`finalizeBand`）で畳む。`section/sectionEmit.js`の`dedupeLines`と
 * 同じ考え方を、2経路の合流点へ広げたもの。
 *
 * **破線・一点鎖線は端点の順序まで一致する場合しか畳まない**——破線の位相は線の始点から
 * 刻まれるため、端点が逆向きの2本は同じ線分でも見た目が違う（「破線同士の角は必ず破線の
 * 交点」の既存配慮を壊さない）。実線は向きが見た目に出ないので順序を正規化して比較する。
 * 線以外のプリミティブ（rect/text/dim等）は対象外——同じ位置に重なること自体が意味を持つ
 * （アキの矩形と壁の縁など）ため、機械的に消すと情報が落ちる。
 * @param {object[]} primitives
 * @returns {object[]}
 */
// 太さの強さ（同じ位置に複数の経路から線が出たとき、どれを残すか）。
const WEIGHT_RANK = { thick: 3, medium: 2, thin: 1 };
const weightRank = w => WEIGHT_RANK[w] ?? 0;

export function dedupeCoincidentLines(primitives) {
  // 鍵は**太さを含めない**（幾何と線種の様式だけ）——同じ位置に太さ違いの線が出たら
  // **太い方だけを残す**（ユーザー明示指示2026-09で面端の縦線をCUT（壁断面）にしたところ、
  // 断面エンジンが同じ端へ出す凹み側面線（中線）と二重になった。従来は図側も中線だったため
  // 完全一致で重複除去されて表に出ていなかった）。断面（太線）が中線に上書きされてはいけない、
  // という線種の規則（sectionEmit.jsのアキ矩形の議論と同じ）をこの1箇所で担保する。
  const keyOf = p => {
    const dash = p.dash ?? '';
    const ends = dash
      ? [p.x1, p.y1, p.x2, p.y2, p.dashAnchor ?? '']
      : [Math.min(p.x1, p.x2), Math.min(p.y1, p.y2), Math.max(p.x1, p.x2), Math.max(p.y1, p.y2)];
    // 実線側は端点を昇順へ正規化するが、それだけでは (x1,y1)-(x2,y2) と (x1,y2)-(x2,y1)
    // （同じ外接矩形の別の対角線。アキのバツがまさにこれ）が同一視されてしまうため、
    // 傾きの符号も鍵に含める。
    const slopeSign = dash ? '' : Math.sign((p.x2 - p.x1) * (p.y2 - p.y1));
    return `${dash}|${slopeSign}|${ends.join(',')}`;
  };
  const best = new Map();
  for (const p of primitives) {
    if (p.type !== 'line') continue;
    const key = keyOf(p);
    const rank = weightRank(p.weight);
    if (!best.has(key) || rank > best.get(key)) best.set(key, rank);
  }
  const seen = new Set();
  const out = [];
  for (const p of primitives) {
    if (p.type !== 'line') { out.push(p); continue; }
    const key = keyOf(p);
    if (weightRank(p.weight) < best.get(key)) continue; // 同位置に太い線がある＝そちらを残す
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * 帯内の全プリミティブ種を一律 (dx,dy) だけ平行移動する（xCursor配置・floorOffset適用の共通処理）。
 * mirrorPrimitiveX と対を成す幾何変換——両関数は同じプリミティブ型集合を扱うこと
 * （片方にだけ型を追加すると、その型だけ移動/反転されない無言バグになる）。
 */
export function translatePrimitive(p, dx, dy) {
  switch (p.type) {
    case 'line':
    case 'arrow':
      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'rect':
    case 'hit': // 展開図の建具ドラッグ起点の透明矩形（elevationFigure.js）。rect と同形
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'text':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'circle':
    case 'tag':
      return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case 'miterTriangle':
      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'polyline':
      return { ...p, points: p.points.map(([x, y]) => [x + dx, y + dy]) };
    case 'dim':
      return p.dir === 'h'
        ? { ...p, from: p.from + dx, to: p.to + dx, at: p.at + dy, foot: p.foot != null ? p.foot + dy : p.foot }
        : { ...p, from: p.from + dy, to: p.to + dy, at: p.at + dx, foot: p.foot != null ? p.foot + dx : p.foot };
    default:
      return p;
  }
}

/**
 * プリミティブを x=0..width の範囲内で左右反転する（x → width − x。yは不変）。
 * 開口の姿図（openings/openingElevationFigure.js）は「世界座標昇順＝図のx昇順」の
 * 正準向きで生成される（吊元 hingeSide<0＝coord1側＝図のx=0。平面記号
 * openings/openingPlanSymbol.js swingPrimitives の hingeAlong と同じ世界アンカー）ため、
 * 世界順とローカル順が反転する面（dirSign<0）ではこの反転を掛けてから配置する——
 * 掛けないと吊元・親子扉の子・レバーハンドル等の非対称要素が逆端に描かれる。
 * translatePrimitive と対を成す幾何変換——両関数は同じプリミティブ型集合を扱うこと。
 * @param {object} p - 姿図プリミティブ（line/arrow/rect/text/polyline/circle/tag/miterTriangle/dim）
 * @param {number} width - 反転の基準幅（開口幅）
 */
export function mirrorPrimitiveX(p, width) {
  const m = (x) => width - x;
  switch (p.type) {
    case 'line':
    case 'arrow':
      return { ...p, x1: m(p.x1), x2: m(p.x2) };
    case 'rect':
    case 'hit':
      return { ...p, x: m(p.x + p.w) };
    case 'text': {
      const anchor = p.anchor === 'start' ? 'end' : p.anchor === 'end' ? 'start' : p.anchor;
      return { ...p, x: m(p.x), anchor };
    }
    case 'circle':
    case 'tag':
      return { ...p, cx: m(p.cx) };
    case 'miterTriangle':
      return { ...p, x: m(p.x), dir: -p.dir };
    case 'polyline':
      return { ...p, points: p.points.map(([x, y]) => [m(x), y]) };
    case 'dim':
      // 水平dimは区間[from,to]を反転、縦dimはat（x位置）と補助線foot（同じくx位置）を反転する
      // （translatePrimitive の縦dimが at/foot 両方を平行移動するのと同じ対応関係）
      return p.dir === 'h'
        ? { ...p, from: m(p.to), to: m(p.from) }
        : { ...p, at: m(p.at), foot: p.foot != null ? m(p.foot) : p.foot };
    default:
      return p;
  }
}

/**
 * 面軸に直交するグリッド通り芯（labeled struct CL）表示用に、graph全体の通り芯一覧を集める。
 * RADIAL（放射CL。value=角度deg）は座標軸を持たずgeometry未対応のため除外する
 * （structural/structuralAutoFill.js の secondaryBeamSpansFor と同じガード）。
 * 通り芯かどうかの判定は`isGridCenterLine`（core/centerLine.js）へ一本化する
 * ——`labeled`だけでは旧データの中心線（`labeled:true`かつ`discipline:ARCH`の組合せ。
 * isGridCenterLineのJSDoc参照）まで拾ってしまう。
 */
export function collectGridCLs(graph) {
  return (graphList(graph, 'centerLines') ?? []).filter(cl =>
    isGridCenterLine(cl) && cl.centerLineType !== CenterLineType.RADIAL);
}

/**
 * 引出線の留め三角（直角三角形。外側の辺が垂直、底辺が引出線上、斜辺が内側へ下る）。
 * 高さ・底辺幅はスクリーン固定サイズ（TRIANGLE_HEIGHT_SCREEN_MM・TRIANGLE_ANGLE_DEG。
 * elevationStyle.js）のため、ここではmm座標に焼き込まずアンカー点(px,py=引出線の端点)と
 * 向き(dir)だけを持つ専用プリミティブにする——figurePrimitivesKonva.jsxが描画時に
 * 校正値(screenPxPerMm)でpx換算する（tagのrPxと同じ考え方。.claude/elevation-model.md参照）。
 * @param {number} px - アンカーx（引出線の外側の端点＝三角の垂直辺の位置）
 * @param {number} py - アンカーy（引出線のy＝三角の底辺の位置）
 * @param {1|-1} dir - 底辺が内側(部屋名枠側)へ伸びる向き（+1=右へ、-1=左へ）
 */
function miterTriangle(px, py, dir) {
  return { type: 'miterTriangle', x: px, y: py, dir };
}

/**
 * 部屋名枠＋左右引出線＋留め三角を primitives の末尾へ追加する（破壊的。図群中心下側に配置）。
 * primitives が空（面が1つも無い）ときは何もしない。buildRoomBand・buildStairBand共有。
 * @param {object[]} primitives
 * @param {string} roomName
 * @param {{nameGapModelMm?:number, leftX?:number|null, rightX?:number|null}} [opts]
 *   nameGapModelMm - 部屋名枠の上余白（モデルmm）。QA G5: 実画面NAME_GAP_BELOW_SCREEN_MMを
 *   ElevationModeState.initがscreenMmToModelMmで換算した値を渡す。未指定時はDEFAULT_NAME_GAP_MM。
 *   leftX/rightX - 左右の留め三角・引出線の水平アンカー（モデルmm。項目9: 左＝天井高寸法線の外側、
 *   右＝一番右の壁中心線の外側、それぞれ実画面10mm）。呼び出し側(buildRoomBand/buildStairBand)が
 *   算出して渡す。未指定時はfigureBounds(primitives)のminX/maxX（このモジュール単体テスト・
 *   面0件以外の呼び出し向けフォールバック）。
 */
export function appendRoomNameFrame(primitives, roomName, opts = {}) {
  if (primitives.length === 0) return;
  const nameGapModelMm = opts.nameGapModelMm ?? DEFAULT_NAME_GAP_MM;
  const preBounds = figureBounds(primitives);
  const leftX  = opts.leftX  ?? preBounds.minX;
  const rightX = opts.rightX ?? preBounds.maxX;
  const cx = (leftX + rightX) / 2;
  const boxW = Math.max(NAME_BOX_MIN_W_MM, (roomName?.length ?? 1) * NAME_BOX_CHAR_W_MM);
  const labelTop = preBounds.maxY + nameGapModelMm;
  const labelCY  = labelTop + NAME_BOX_H_MM / 2;
  primitives.push({ type: 'rect', x: cx - boxW / 2, y: labelTop, w: boxW, h: NAME_BOX_H_MM });
  primitives.push({ type: 'text', x: cx, y: labelCY, text: roomName, anchor: 'middle', baseline: 'middle' });

  const leaderWeight = weightForRole(ElevationLineRole.DETAIL);
  if (leftX < cx - boxW / 2) {
    primitives.push({ type: 'line', x1: leftX, y1: labelCY, x2: cx - boxW / 2, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(leftX, labelCY, 1));
  }
  if (rightX > cx + boxW / 2) {
    primitives.push({ type: 'line', x1: cx + boxW / 2, y1: labelCY, x2: rightX, y2: labelCY, weight: leaderWeight });
    primitives.push(miterTriangle(rightX, labelCY, -1));
  }
}

/**
 * プリミティブ配列をx範囲[range.lo, range.hi]へ切り詰める（buildRoomBand・buildStairBandの
 * 面端クリップ・展開図一般化Phase 6b-2「一体設計」の階段描画範囲クリップが共有する単一実装）。
 * 元は elevationBand.js の clipContentToFace/clipPolylineX（以前は帯ビルダー専用のつもりで
 * 実装されていたが、階段自身の幾何（section/sectionStair.js）の終端クリップにも同じ処理が要る
 * ことが判明したため移設した。以前の2重実装コピペ（collectGridCLs等の教訓）を再発させないよう、
 * ここへ一本化する）。
 *
 * 対応する型: line/polyline は範囲外を補間クリップ、text/rectはアンカー点が範囲内かで残すか
 * 判定、他の型はそのまま通す（範囲の意味を持たないため）。
 * @param {object[]} prims
 * @param {{lo:number, hi:number}} range
 * @returns {object[]}
 */
export function clipPrimitivesToXRange(prims, range) {
  const inX = x => x >= range.lo - PRIM_GAP_EPS && x <= range.hi + PRIM_GAP_EPS;
  const out = [];
  for (const q of prims) {
    if (q.type === 'line') {
      const lo = Math.min(q.x1, q.x2), hi = Math.max(q.x1, q.x2);
      if (hi < range.lo - PRIM_GAP_EPS || lo > range.hi + PRIM_GAP_EPS) continue;
      if (lo >= range.lo - PRIM_GAP_EPS && hi <= range.hi + PRIM_GAP_EPS) { out.push(q); continue; }
      if (Math.abs(q.x1 - q.x2) < PRIM_GAP_EPS) continue; // 縦線は範囲外なら落とすだけ
      const at = t => [q.x1 + (q.x2 - q.x1) * t, q.y1 + (q.y2 - q.y1) * t];
      const tOf = x => (x - q.x1) / (q.x2 - q.x1);
      const t0 = Math.min(Math.max(tOf(range.lo), 0), 1), t1 = Math.min(Math.max(tOf(range.hi), 0), 1);
      const [ta, tb] = t0 <= t1 ? [t0, t1] : [t1, t0];
      if (tb - ta < 1e-9) continue;
      const [x1, y1] = at(ta), [x2, y2] = at(tb);
      out.push({ ...q, x1, y1, x2, y2 });
    } else if (q.type === 'polyline' && Array.isArray(q.points)) {
      for (const pts of clipPolylineToXRange(q.points, range.lo, range.hi)) out.push({ ...q, points: pts });
    } else if (q.type === 'text' || q.type === 'rect') {
      if (inX(q.x)) out.push(q);
    } else {
      out.push(q);
    }
  }
  return out;
}

// 線分(x1,y1)-(x2,y2)が軸並行矩形の内側にある媒介変数区間[t0,t1]（Liang-Barsky。交わらなければ
// null）。矩形は呼び出し側の座標系のまま（y方向は呼び出し側で変換済みのものを渡す）。
// **辺上（p≈0の分岐）は内側と判定する**——矩形をGAP_EPS等だけ内側へ縮めるかどうかは呼び出し側の
// 責務（展開図一般化Phase 6b-2 設計(d)。sectionTypes.jsのisSolidBand/solidRectsOf参照）。
export function segmentInsideRect(x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const ps = [-dx, dx, -dy, dy];
  const qs = [x1 - r.xLo, r.xHi - x1, y1 - r.yLo, r.yHi - y1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    const p = ps[i], q = qs[i];
    if (Math.abs(p) < 1e-9) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

// 媒介変数区間の集合を昇順・非重複へ統合する。
export function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

// 「残す価値のある長さか」の判定用の許容差（展開図一般化Phase 6b-2 P2是正・QA是正2026-09-13
// F5で係数を見直し）。GAP_EPSだけ内側へ縮めた矩形（sectionTypes.jsのsolidRectsOf）を勾配のある
// 線分に適用すると、縮めた分（GAP_EPS）が勾配の浅い軸へ増幅されたサブミクロン〜ミクロン級の
// 「点に近いが完全な点ではない」区間が生じうる——媒介変数tの差(`>1e-9`)ではこれを弾けない。
// 増幅率は線分の勾配（軸ごとの伸び幅の比）に依存し、実測した最悪ケース（面D2の裁定済み線分。
// GAP_EPS《1e-6mm》の約1.14倍＝約1.1e-6mm）よりさらに浅い勾配の線分では、GAP_EPSの数百倍
// まで増幅されうる——QAレビューで1e-4〜1e-3mm程度のアーティファクトが理論上あり得ると
// 指摘された（F5）。GAP_EPSの2000倍（2e-3mm=2ミクロン）を取れば、この観測範囲に2倍以上の
// 余裕で収まり、なお実務上の作図スケール(mm)からは隔絶した数ミクロンであり、意図した出力
// （数mm〜数十mm単位の差分）には影響しない（展開モジュール群で次に大きい既存の許容差は
// SPLIT_MERGE_EPS_MM=1mm。elevationStyle.js。使用は elevationDimSplit.js 等）。
// 8.33e-4mmの根拠は合成fixture（elevationPrimitives.test.jsのF5テスト）由来——実データ
// 13.stq/11.stq/knee-drop-test.stqの全2643線分に2e-3mm未満の実線分は無く最短は8mm
// （QA実測2026-09-13）。golden一致（diffElevGolden.mjs）でも確認済み。
const SLIVER_EPS_MM = PRIM_GAP_EPS * 2000;
function farEnough(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) > SLIVER_EPS_MM;
}

// QA是正2026-09（Phase 6b-2 C-1後の実機回帰の副次修正・B。2026-09-13第2ラウンドで
// section/sectionEmit.jsから移設し単一情報源化）: 長さゼロの線分（x1===x2かつy1===y2）か。
// 列の境界が縮退する構成（例: hidden帯の材の面がちょうど別の列境界と一致し、col.x0===col.x1に
// なる等）では`emitLine`/`subtractRectsFromLine`が実質「点」のプリミティブを生んでしまうことが
// ある——実害（見えない点が描画されるだけ）は小さいが、diffツールや将来のレンダラで意図しない
// 挙動を招くため、出口（`dedupeLines`＝`emitColumns`の集約点・`subtractRectsFromLine`＝
// クリップの出口）でまとめて捨てる。GAP_EPSではなく極小固定値（浮動小数の丸め誤差ぶんだけを
// 許容）を使う——GAP_EPSは面のmm単位の許容差で、ここでは「本当に同一点か」だけを見たいため。
export function isZeroLengthLine(p) {
  return p.type === 'line' && Math.abs(p.x1 - p.x2) < 1e-9 && Math.abs(p.y1 - p.y2) < 1e-9;
}

// 線分から矩形の和に入る区間を取り除き、残った区間だけの線分列にする。
// QA是正2026-09・B: 入力自体が長さゼロ（縮退した列の境界等から生成された「点」）なら
// 素通りさせず捨てる——素通りさせると矩形と重ならない限り点のまま最終出力へ残ってしまう。
export function subtractRectsFromLine(p, rects) {
  if (isZeroLengthLine(p)) return [];
  if (!rects.length) return [p];
  const cut = mergeIntervals(rects
    .map(r => segmentInsideRect(p.x1, p.y1, p.x2, p.y2, r))
    .filter(Boolean));
  if (!cut.length) return [p];
  const at = t => ({ x: p.x1 + (p.x2 - p.x1) * t, y: p.y1 + (p.y2 - p.y1) * t });
  const out = [];
  let cursor = 0;
  for (const [c0, c1] of cut) {
    const a = at(cursor), b = at(c0);
    if (farEnough(a, b)) out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    cursor = Math.max(cursor, c1);
  }
  const a = at(cursor), b = at(1);
  if (farEnough(a, b)) out.push({ ...p, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  return out;
}

// polyline版のsubtractRectsFromLine: 矩形の内部に入る区間を落とし、残った区間だけの
// 連続run（複数本になりうる）を新しいpolylineとして返す（元のline版と同じアルゴリズムを
// 頂点間の各線分に適用し、矩形内部へ入るたびにrunを打ち切る）。
function subtractRectsFromPolyline(p, rects) {
  const out = [];
  let run = [];
  const pushPt = ([x, y]) => {
    const last = run[run.length - 1];
    if (!last || farEnough({ x: last[0], y: last[1] }, { x, y })) run.push([x, y]);
  };
  // QA是正2026-09-13第2ラウンド: flush側での総延長チェック（F5当初案）は削除した——`pushPt`が
  // 連続する2点間に`farEnough`（>SLIVER_EPS_MM）を要求するため、`run.length>1`ならその時点で
  // 少なくとも1辺がSLIVER_EPS_MMを超えており、run全体の総延長も必ずSLIVER_EPS_MMを超える
  // （恒真、到達不能なガードだった。ガードを外しても全テスト緑）。「残す価値のある長さか」の
  // 唯一の関所は`farEnough`（区間ごと）であり、ここに重ねて別の関所を持たない。
  const flush = () => { if (run.length > 1) out.push({ ...p, points: run }); run = []; };
  for (let i = 0; i + 1 < p.points.length; i++) {
    const [x1, y1] = p.points[i], [x2, y2] = p.points[i + 1];
    const at = t => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    const cut = mergeIntervals(rects
      .map(r => segmentInsideRect(x1, y1, x2, y2, r))
      .filter(Boolean));
    let cursor = 0;
    for (const [c0, c1] of cut) {
      const a = at(cursor), b = at(c0);
      if (farEnough({ x: a[0], y: a[1] }, { x: b[0], y: b[1] })) { pushPt(a); pushPt(b); }
      flush(); // 矩形の内部に入る＝runを打ち切る（区間の手前が無くても打ち切りは要る）
      cursor = Math.max(cursor, c1);
    }
    const a = at(cursor), b = at(1);
    if (farEnough({ x: a[0], y: a[1] }, { x: b[0], y: b[1] })) { pushPt(a); pushPt(b); }
  }
  flush();
  return out;
}

/**
 * プリミティブ配列から、渡された矩形群（呼び出し側の座標系。line/polylineと同じxy）の内部に
 * 入る区間を取り除く（展開図一般化Phase 6b-2 P1で`section/sectionEmit.js`から移設。
 * `mergeIntervals`/`segmentInsideRect`/`subtractRectsFromLine`は元々`splitGapMarksByStair`
 * （アキのバツの階段による隠れ判定）専用だったが、階段自身の幾何（DETAILのpolyline＝
 * ささらの見えがかり）を同じ規則で切るP2のために、polyline対応を追加してここへ一本化する）。
 * line/polyline以外の型はそのまま通す（矩形減算の対象ではないため）。
 * **矩形を内側へ縮めるかどうかは呼び出し側の責務**（辺上は内側と判定される。P1では既存の
 * `splitGapMarksByStair`用途に合わせ縮めない＝出力不変）。
 * @param {object[]} prims
 * @param {Array<{xLo:number, xHi:number, yLo:number, yHi:number}>} rects
 * @returns {object[]}
 */
export function subtractRectsFromPrimitives(prims, rects) {
  if (!rects?.length) return prims;
  const out = [];
  for (const p of prims) {
    if (p.type === 'line') { out.push(...subtractRectsFromLine(p, rects)); continue; }
    if (p.type === 'polyline' && Array.isArray(p.points) && p.points.length > 1) {
      out.push(...subtractRectsFromPolyline(p, rects));
      continue;
    }
    out.push(p);
  }
  return out;
}

// 点列をx範囲[lo,hi]でクリップし、連続する残り区間ごとの点列を返す（範囲の境界では補間する
// ——点の取捨だけだと、範囲を跨ぐ2点の線分がまるごと消える）。
function clipPolylineToXRange(points, lo, hi) {
  const out = [];
  let run = [];
  const push = pt => {
    const last = run[run.length - 1];
    if (!last || Math.abs(last[0] - pt[0]) > 1e-9 || Math.abs(last[1] - pt[1]) > 1e-9) run.push(pt);
  };
  const flush = () => { if (run.length > 1) out.push(run); run = []; };
  for (let i = 0; i + 1 < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    const at = t => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    let ta = 0, tb = 1;
    if (Math.abs(x2 - x1) < 1e-9) {
      if (x1 < lo - PRIM_GAP_EPS || x1 > hi + PRIM_GAP_EPS) { flush(); continue; }
    } else {
      const t0 = (lo - x1) / (x2 - x1), t1 = (hi - x1) / (x2 - x1);
      ta = Math.max(0, Math.min(t0, t1));
      tb = Math.min(1, Math.max(t0, t1));
      if (tb - ta < 1e-9) { flush(); continue; }
    }
    push(at(ta)); push(at(tb));
    if (tb < 1 - 1e-9) flush(); // 線分の途中で範囲外へ出た＝ここで途切れる
  }
  flush();
  return out;
}
