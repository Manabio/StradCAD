// 中心線（labeled:false の「中心」「補助線」）の結合処理。
//
// 「重複拒否」（App.jsx の OVERLAP_TOL=0.5mm、同じ位置に重なって存在するのを防ぐガード）とは
// 別の概念。こちらは「重ならず端点が一致して隣接する」中心線を1本に統合する。
//
// 判定は型（VERTICAL/HORIZONTAL）を分岐せず、線分の始点・終点座標に対する
// 共線判定＋端点一致判定という純粋な2Dベクトル演算1本で行う（RADIALは getCenterLineSegment
// が null を返すため自動的に対象外になる。将来ジオメトリが定義されればそこに分岐を足すだけでよい）。
import { CenterLineType, centerLineKind } from '@core';

// 重複拒否(OVERLAP_TOL=0.5mm、緩い判定)とは別の、端点厳密一致用の許容誤差
export const CL_MERGE_EPS_MM = 1e-6;

// CenterLine（または未生成の仮想候補 {centerLineType, value, extentLoRef, extentHiRef, extentLo, extentHi}）
// を、ワールド座標の始点・終点を持つ線分として解決する。RADIAL、または extentLo/extentHi の
// いずれかが未確定・ゼロ長の場合は null（結合判定の対象外）。
export function getCenterLineSegment(cl) {
  const { centerLineType, value, extentLo, extentHi } = cl;
  if (centerLineType === CenterLineType.RADIAL) return null;
  if (extentLo == null || extentHi == null || extentLo === extentHi) return null;
  if (centerLineType === CenterLineType.VERTICAL) {
    return { p1: { x: value, y: extentLo }, p2: { x: value, y: extentHi } };
  }
  if (centerLineType === CenterLineType.HORIZONTAL) {
    return { p1: { x: extentLo, y: value }, p2: { x: extentHi, y: value } };
  }
  return null;
}

// segA の乗る直線に対する点 p の垂線距離（型非依存の2Dベクトル演算）
function pointToLineDistance(segA, p) {
  const dx = segA.p2.x - segA.p1.x;
  const dy = segA.p2.y - segA.p1.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - segA.p1.x, p.y - segA.p1.y);
  // 外積 |d × (p - p1)| / |d| = 点と直線の距離
  const cross = dx * (p.y - segA.p1.y) - dy * (p.x - segA.p1.x);
  return Math.abs(cross) / len;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// segA・segB が同一直線上にあり、かつどちらか一方の端点だけが厳密に一致するか（隣接判定）。
// 一致箇所が0組なら不一致（少しでも座標がズレていれば結合しない）、2組以上一致（重複・ゼロ長等の
// 異常系）は安全側で不一致として扱う。
// @returns {{touchA:'p1'|'p2', touchB:'p1'|'p2'}|null}
export function segmentsCollinearTouching(segA, segB, eps = CL_MERGE_EPS_MM) {
  if (pointToLineDistance(segA, segB.p1) >= eps) return null;
  if (pointToLineDistance(segA, segB.p2) >= eps) return null;

  const pairs = [
    ['p1', 'p1'], ['p1', 'p2'], ['p2', 'p1'], ['p2', 'p2'],
  ];
  const touching = pairs.filter(([a, b]) => dist(segA[a], segB[b]) < eps);
  if (touching.length !== 1) return null;
  const [touchA, touchB] = touching[0];
  return { touchA, touchB };
}

// owner（実CL または仮想候補 {extentLoRef, extentHiRef, extentLo, extentHi}）の lo/hi 側の
// 「参照 or 静的値」記述子を取り出す。実CLは _extentLo/_extentHi（内部フォールバック値）、
// 仮想候補は extentLo/extentHi（プレーンな解決済み数値）を見る点だけが違い、以降の処理は共通。
function loDescriptor(owner) {
  const ref = owner.extentLoRef ?? null;
  return { ref, staticValue: ref ? null : (owner._extentLo ?? owner.extentLo ?? null) };
}
function hiDescriptor(owner) {
  const ref = owner.extentHiRef ?? null;
  return { ref, staticValue: ref ? null : (owner._extentHi ?? owner.extentHi ?? null) };
}

// centerLineType・kind が一致し labeled:false な既存中心線から、segment と隣接（共線・端点一致）
// するものを1つ探す。excludeIds は連鎖中に自分自身を除外するために使う。
export function findCenterLineMergeMatch(graph, segment, centerLineType, kind, excludeIds = []) {
  for (const cl of graph.centerLines) {
    if (cl.centerLineType !== centerLineType || cl.labeled) continue;
    if (excludeIds.includes(cl.id)) continue;
    if (centerLineKind(cl) !== kind) continue;
    const candidateSeg = getCenterLineSegment(cl);
    if (!candidateSeg) continue;
    const touch = segmentsCollinearTouching(segment, candidateSeg);
    if (touch) return { candidate: cl, touch };
  }
  return null;
}

// survivor（実CL）に loser（実CL）を吸収させる。loser を削除する前に、削除すると壊れる外部参照
// （壁・柱・梁・他の中心線のextent参照等）がないかを確認し、あればブロックする。
// @returns {{blocked:true}|{blocked:false, undo:Function, redo:Function}}
export function absorbCenterLine(graph, survivor, loser, touch) {
  if (graph.hasExternalCenterLineReferences(loser.id)) return { blocked: true };

  const survivorSide = touch.touchA === 'p1' ? 'lo' : 'hi';
  const loserFarSide = touch.touchB === 'p1' ? 'hi' : 'lo'; // loserの触れた側の反対
  const farDescriptor = loserFarSide === 'lo' ? loDescriptor(loser) : hiDescriptor(loser);
  const beforeDescriptor = survivorSide === 'lo' ? loDescriptor(survivor) : hiDescriptor(survivor);

  const loserSnapshot = {
    id: loser.id,
    centerLineType: loser.centerLineType,
    value: loser._value,
    props: {
      labeled: loser.labeled,
      lineType: loser.lineType,
      discipline: loser.discipline,
      trim: loser.trim,
      ...(loser.refId != null ? { refId: loser.refId, refOffset: loser.refOffset } : {}),
      ...(loser.extentLoRef != null ? { extentLoRef: loser.extentLoRef } : {}),
      ...(loser.extentHiRef != null ? { extentHiRef: loser.extentHiRef } : {}),
      ...(loser._extentLo != null ? { extentLo: loser._extentLo } : {}),
      ...(loser._extentHi != null ? { extentHi: loser._extentHi } : {}),
    },
  };

  const apply = (desc) => graph.setCenterLineExtentRef(survivor, survivorSide, desc.ref, desc.staticValue);

  apply(farDescriptor);
  graph.removeCenterLine(loser.id);

  return {
    blocked: false,
    undo: () => {
      graph.addCenterLine(loserSnapshot.centerLineType, loserSnapshot.value, loserSnapshot.props, loserSnapshot.id);
      apply(beforeDescriptor);
    },
    redo: () => {
      apply(farDescriptor);
      graph.removeCenterLine(loserSnapshot.id);
    },
  };
}

// subject（実CLまたは仮想候補）を起点に、隣接する中心線を連鎖的に1本へ統合する。
// - subject が仮想候補（id なし、まだ追加されていない）で最初のマッチが見つかった場合は、
//   マッチした既存CLをそのまま延伸するだけで、新規追加も削除も発生しない。
// - subject が実CLの場合は、マッチした既存CLを absorbCenterLine で吸収する。
// 両端で上記を繰り返し、これ以上マッチしなくなるかブロックされるまで続ける（多段連鎖対応）。
// @returns {{merged:false}|{merged:true, survivorId:string, undo:Function, redo:Function}}
export function mergeCenterLineChain(graph, initial, { kind, maxHops = 64 }) {
  const centerLineType = initial.centerLineType;
  let subject = initial;
  const steps = [];

  for (let hop = 0; hop < maxHops; hop++) {
    const segment = getCenterLineSegment(subject);
    if (!segment) break;
    const excludeIds = subject.id ? [subject.id] : [];
    const match = findCenterLineMergeMatch(graph, segment, centerLineType, kind, excludeIds);
    if (!match) break;
    const { candidate, touch } = match;

    if (!subject.id) {
      // 仮想候補: candidate(既存CL)を延伸するだけで済ませる
      const side = touch.touchB === 'p1' ? 'lo' : 'hi';
      const far = touch.touchA === 'p1' ? hiDescriptor(subject) : loDescriptor(subject);
      const before = side === 'lo' ? loDescriptor(candidate) : hiDescriptor(candidate);
      graph.setCenterLineExtentRef(candidate, side, far.ref, far.staticValue);
      steps.push({
        undo: () => graph.setCenterLineExtentRef(candidate, side, before.ref, before.staticValue),
        redo: () => graph.setCenterLineExtentRef(candidate, side, far.ref, far.staticValue),
      });
      subject = candidate;
      continue;
    }

    const result = absorbCenterLine(graph, subject, candidate, touch);
    if (result.blocked) break;
    steps.push({ undo: result.undo, redo: result.redo });
  }

  if (steps.length === 0) return { merged: false };
  return {
    merged: true,
    survivorId: subject.id ?? null,
    undo: () => { for (let i = steps.length - 1; i >= 0; i--) steps[i].undo(); },
    redo: () => { for (let i = 0; i < steps.length; i++) steps[i].redo(); },
  };
}

// mergeCenterLineChain の結果を、呼び出し元のベース操作（bake/add）のUndo・Redoに合成する。
// 呼び出し側は `undoManager.push(...composeUndoWithMergeChain(baseUndo, baseRedo, chainResult))`
// とするだけでよく、連鎖しても undoManager に積まれるエントリは1つだけになる。
export function composeUndoWithMergeChain(baseUndo, baseRedo, chainResult) {
  if (!chainResult?.merged) return [baseUndo, baseRedo];
  return [
    () => { chainResult.undo(); baseUndo(); },
    () => { baseRedo(); chainResult.redo(); },
  ];
}
