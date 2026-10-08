/**
 * 平面の「床の穴」の注記（hole marks）を、穴（開口グループ）から導く純モジュール。
 * 注記＝吹抜け・昇降路の×（自階。一点鎖線）と、直下階に描く上階吹抜けの×・外形（破線・「上部吹抜け」）。
 * 切断面上の注記であり、解決器の遮蔽（柱・梁・壁の上下関係）は掛けない（伏図の×が梁で分割されるのとは違う）。
 *
 * ×の端点（innerRect）は開口グループの属性（`finish/stair/slabOpening.js floorOpeningGroups`。壁内4頂点＝faceRect）で、
 * 穴の切り出しと同じ場所にある単一供給源。切断の遮蔽物から縮めて導き直さない（部分壁・吹抜け縁の腰壁・対称壁・張り出す柱で結果が変わる）。
 *
 * 線幅のインセット（太線1本分）・ラベルの配置は viewport に依存するので、純関数は mm の矩形までを返し、
 * 描く側が `insetRect`・`labelPlacement` を使う。store.js / snap.js / *.jsx を import しない（node:test から単体 import 可）。
 *
 * 描画への写像は純関数 `planHoleMarkPrimitives`（線の座標・破線・ラベル位置まで）。レイヤ（PlanSolidsLayer）は Konva へ写すだけ。
 */
import { RoomFeature } from '@core';
import { floorOpeningCellRects, floorOpeningGroups } from '../finish/stair/slabOpening.js';
import { openingCrossDash } from '../renderer/dimensionStyle.js';
import { LodLevel } from '../viewport.js';

/**
 * 「上部吹抜け」（直下階に描く上階吹抜けの×・外形）の破線パターン（スクリーンpx）。
 * 平面の「見えない線」の破線パターンの供給源（階段の上り部分の破線 stairDownviewDashPx もこれを参照する）。
 */
export const UPPER_VOID_DASH_PX = [8, 4];

// 被覆判定の許容差(mm)。浮動小数の丸め誤差だけを吸収すればよい（cellRect はどちらも CL 値で壁を介さない）。
const CELL_RECT_EPS_MM = 1;

const LABEL_FULL = '上部吹抜け';
const LABEL_LINE1 = '上部';
const LABEL_LINE2 = '吹抜け';
// 全角のみのラベルなので「1文字=fontSize 幅」（RoomLabelsLayer の部屋名と同じ）。
const CHAR_WIDTH_RATIO = 1.0;

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

const isFiniteRect = r => !!r && [r.x1, r.y1, r.x2, r.y2].every(Number.isFinite);

/**
 * rect が rects（同一格子とは限らない矩形群）の和集合に eps 許容で覆われているか。rect を rects の境界値で
 * 小矩形に分割し、各小矩形の中心がいずれかの矩形に入るかで判定する。判定した小矩形が 0 件（rect 自体が退化）は覆われていない扱い。
 */
export function rectCoveredByUnion(rect, rects, eps = CELL_RECT_EPS_MM) {
  const xs = new Set([rect.x1, rect.x2]);
  const ys = new Set([rect.y1, rect.y2]);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  for (const o of rects) {
    if (o.x1 > rect.x1 && o.x1 < rect.x2) xs.add(o.x1);
    if (o.x2 > rect.x1 && o.x2 < rect.x2) xs.add(o.x2);
    if (o.y1 > rect.y1 && o.y1 < rect.y2) ys.add(o.y1);
    if (o.y2 > rect.y1 && o.y2 < rect.y2) ys.add(o.y2);
  }
  const xVals = [...xs].sort((a, b) => a - b);
  const yVals = [...ys].sort((a, b) => a - b);
  let checked = 0;
  for (let i = 0; i < xVals.length - 1; i++) {
    if (xVals[i + 1] - xVals[i] <= eps) continue;
    for (let j = 0; j < yVals.length - 1; j++) {
      if (yVals[j + 1] - yVals[j] <= eps) continue;
      const midX = clamp((xVals[i] + xVals[i + 1]) / 2, rect.x1, rect.x2);
      const midY = clamp((yVals[j] + yVals[j + 1]) / 2, rect.y1, rect.y2);
      const covered = rects.some(o =>
        o.x1 - eps <= midX && midX <= o.x2 + eps && o.y1 - eps <= midY && midY <= o.y2 + eps);
      if (!covered) return false;
      checked++;
    }
  }
  return checked > 0;
}

/** 直下階に「上部吹抜け」ラベルを付けるか。VOID だけ（昇降路は同じシャフトが続くだけなのでラベルなし）。 */
export function showsUpperVoidLabel(group) {
  return group?.feature === RoomFeature.VOID;
}

/**
 * 矩形の各辺を inset だけ内側へ縮める（「太線1本分内側」に対角線を描くため）。退化（幅・高さが 0 以下）は null。
 */
export function insetRect(r, inset) {
  const x1 = r.x1 + inset, y1 = r.y1 + inset, x2 = r.x2 - inset, y2 = r.y2 - inset;
  if (!(x2 - x1 > 0 && y2 - y1 > 0)) return null;
  return { x1, y1, x2, y2 };
}

/**
 * 「上部吹抜け」ラベルの配置（×の上側三角領域で自身の対角線と重ならない位置）。
 * 1行「上部吹抜け」→ 入らなければ2行「上部」「吹抜け」→ それでも入らなければ中心から H/4 上へ1行をクランプ。
 * 退化矩形は null。
 * @returns {{lines:string[], cx:number, y:number, widths:number[], lineHeight:number}|null}
 */
export function labelPlacement(r, fontSize, gap, margin) {
  const W = r.x2 - r.x1, H = r.y2 - r.y1;
  if (!(W > 0 && H > 0)) return null;
  const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
  const slope = H / W;

  const fits = (halfW, height) => {
    const dy = (halfW + margin) * slope + margin;
    return dy + height <= H / 2 - margin ? dy : null;
  };

  const w1 = estimateTextWidth(LABEL_FULL, fontSize);
  const dy1 = fits(w1 / 2, fontSize);
  if (dy1 != null) {
    return { lines: [LABEL_FULL], cx, y: cy - dy1 - fontSize, widths: [w1], lineHeight: fontSize };
  }

  const w2a = estimateTextWidth(LABEL_LINE1, fontSize);
  const w2b = estimateTextWidth(LABEL_LINE2, fontSize);
  const w2 = Math.max(w2a, w2b);
  const h2 = fontSize * 2 + gap;
  const dy2 = fits(w2 / 2, h2);
  if (dy2 != null) {
    return { lines: [LABEL_LINE1, LABEL_LINE2], cx, y: cy - dy2 - h2, widths: [w2a, w2b], lineHeight: fontSize };
  }

  return { lines: [LABEL_FULL], cx, y: cy - H / 4 - fontSize / 2, widths: [w1], lineHeight: fontSize };
}

/**
 * 自階の「吹抜け・昇降路の穴」のセル矩形（種類 void・shaft だけ。階段吹抜け・破れ先は含めない）。
 * 直下階の上部吹抜け破線を出すかの被覆判定に使う。セルを畳む前に source を絞るので、階段吹抜けと重なるセルも落ちない
 * （室のセルから求め、器具行は見ない）。
 * @param {object|null} graph
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
export function selfVoidHoleRects(graph) {
  return floorOpeningCellRects(graph, { stairFilter: () => false, sources: ['void', 'shaft'] })
    .map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }));
}

const isCrossGroup = g => (g?.kind === 'void' || g?.kind === 'shaft') && isFiniteRect(g.innerRect);

/**
 * 穴の注記を列挙する。
 *   - 自階の×（role 'cross'・dashKind 'openingCross'）: selfGroups の void・shaft で innerRect が解決できたもの。
 *   - 上階の破線（role 'upperVoid'・dashKind 'upperVoid'・outline・VOID だけ label）: aboveGroups の void・shaft のうち、
 *     cellRect が selfVoidCells（自階の吹抜け・昇降路のセル矩形の和）に覆われないもの。上階の床の穴の縁を示す表示記号で、
 *     穴の遮蔽規則とは別。
 * 不正なグループ（innerRect なし・非有限）は捨てる。出力順は cross（入力順）→ upperVoid（入力順）。
 * @param {{
 *   selfGroups?: Array<object>|null  自階の floorOpeningGroups
 *   selfVoidCells?: Array<{x1:number,y1:number,x2:number,y2:number}>|null  selfVoidHoleRects(自階)
 *   aboveGroups?: Array<object>|null|undefined  上階の floorOpeningGroups。null＝上階なし・undefined＝未解決（どちらも上階分なし）
 * }} args
 * @returns {Array<{key:string, role:'cross'|'upperVoid', rect:{x1:number,y1:number,x2:number,y2:number},
 *   cellRect:object|null, dashKind:'openingCross'|'upperVoid', outline:boolean, label:boolean,
 *   source:{kind:string, id:string, feature:string|null}}>}
 *   rect＝innerRect（壁内4頂点）。cellRect＝上階の被覆判定に使った CL 値の矩形（cross は null 可）。
 */
export function planHoleMarks({ selfGroups, selfVoidCells, aboveGroups } = {}) {
  const marks = [];
  for (const g of selfGroups ?? []) {
    if (!isCrossGroup(g)) continue;
    marks.push({
      key: `cross:${g.id}`, role: 'cross', rect: { ...g.innerRect }, cellRect: g.cellRect ? { ...g.cellRect } : null,
      dashKind: 'openingCross', outline: false, label: false,
      source: { kind: g.kind, id: g.id, feature: g.feature ?? null },
    });
  }
  const owns = selfVoidCells ?? [];
  for (const g of aboveGroups ?? []) {
    if (!isCrossGroup(g) || !isFiniteRect(g.cellRect)) continue;
    if (owns.length > 0 && rectCoveredByUnion(g.cellRect, owns, CELL_RECT_EPS_MM)) continue;
    marks.push({
      key: `upper:${g.id}`, role: 'upperVoid', rect: { ...g.innerRect }, cellRect: { ...g.cellRect },
      dashKind: 'upperVoid', outline: true, label: showsUpperVoidLabel(g),
      source: { kind: g.kind, id: g.id, feature: g.feature ?? null },
    });
  }
  return marks;
}

/**
 * 自階の graph から注記を求める（レイヤが毎レンダーで呼ぶ経路）。graphComputed の外に置く: 自階の×は通り芯ドラッグ中も
 * 追従する（CL の effectiveValue＝pendingDelta 込みを読む）ので、memo も「ドラッグ中は前回のまま」も掛けない。
 * ×は void・shaft だけ使うので階段系（破れ先の蹴上が要る）は求めない（stairFilter: () => false）。
 * @param {object|null} graph
 * @param {Array<object>|null|undefined} aboveGroups 上階の floorOpeningGroups（null＝上階なし・undefined＝未解決）
 */
export function planHoleMarksOf(graph, aboveGroups) {
  if (!graph) return [];
  return planHoleMarks({
    selfGroups: floorOpeningGroups(graph, { stairFilter: () => false }),
    selfVoidCells: aboveGroups?.length ? selfVoidHoleRects(graph) : [],
    aboveGroups,
  });
}

const LABEL_FONT_SIZE_PX = 12;// 「上部吹抜け」のスクリーン上表示サイズ(px)
const LABEL_MARGIN_PX = 2;     // ×の斜線・矩形端からの余白(px)
const LABEL_GAP_PX = 2;        // 2行表示時の行間(px)

/**
 * dashKind → 破線パターン（スクリーンpx）の写像（唯一の場所）。
 * 'openingCross'＝一点鎖線（renderer/dimensionStyle.js openingCrossDash が供給源。線幅 d 基準）、'upperVoid'＝UPPER_VOID_DASH_PX。
 */
export const HOLE_MARK_DASH = Object.freeze({
  openingCross: thinPx => openingCrossDash(thinPx),
  upperVoid: () => UPPER_VOID_DASH_PX,
});

/**
 * planHoleMarks の出力を描画プリミティブ（mm 座標の線・文字）へ写す。
 *   - 線: 矩形を「太線1本分内側」（thickPx/scale mm）へ縮めた対角2本。upperVoid は外形（閉じた矩形）も同じ破線で。
 *     縮めて退化（幅・高さ 0 以下）する矩形は何も出さない。
 *   - 文字: label のある mark だけ「上部吹抜け」（1行／2行／クランプ。labelPlacement）。LOD SCHEMATIC では出さない（線は全 LOD で出す）。
 * 線幅はすべて thin（レイヤが viewport.lineWeightsPx.thin を渡す）。
 * @param {ReturnType<typeof planHoleMarks>} marks
 * @param {{thickPx:number, thinPx:number, scale:number, lod:string}} view
 * @returns {Array<
 *   {kind:'line', key:string, points:number[], dash:number[], closed:boolean} |
 *   {kind:'text', key:string, x:number, y:number, text:string, fontSize:number, offsetX:number}>}
 */
export function planHoleMarkPrimitives(marks, { thickPx, thinPx, scale, lod }) {
  const out = [];
  const inset = thickPx / scale;
  const fontSize = LABEL_FONT_SIZE_PX / scale;
  const gap = LABEL_GAP_PX / scale;
  const margin = LABEL_MARGIN_PX / scale;
  for (const m of marks ?? []) {
    const r = insetRect(m.rect, inset);
    if (!r) continue; // 退化矩形 → 描画スキップ（座標が交差した×を描かない）
    const dash = HOLE_MARK_DASH[m.dashKind](thinPx);
    out.push({ kind: 'line', key: `${m.key}:d1`, points: [r.x1, r.y1, r.x2, r.y2], dash, closed: false });
    out.push({ kind: 'line', key: `${m.key}:d2`, points: [r.x2, r.y1, r.x1, r.y2], dash, closed: false });
    if (m.outline) {
      out.push({ kind: 'line', key: `${m.key}:outline`, points: [r.x1, r.y1, r.x2, r.y1, r.x2, r.y2, r.x1, r.y2], dash, closed: true });
    }
    if (m.label && lod !== LodLevel.SCHEMATIC) {
      const label = labelPlacement(r, fontSize, gap, margin);
      if (label) {
        label.lines.forEach((text, i) => {
          out.push({
            kind: 'text', key: `${m.key}:label${i}`, x: label.cx, y: label.y + i * (label.lineHeight + gap),
            text, fontSize, offsetX: label.widths[i] / 2,
          });
        });
      }
    }
  }
  return out;
}
