// ================================================================
// 在来木造の梁の交点処理（B-3・ユーザー裁定2026-09-17）。
//
// 「通しの梁（両側に続く梁）が勝ち、T字で突き当たる梁が負け（勝者の面で止まる）」「出隅（L字）は
// 長い方が勝ち、同長ならX方向」——このルールは場面によらず一律に適用する。実体スパン
// （core/structuralEntities.js の spanForColumns。下階柱面での止め）はここでは一切書き換えない
// ——ここが返すのは描画専用の追加トリム（勝者面での止め・L字の角閉じ）で、renderer/StructuralLayer.jsx
// が spanForColumns の結果を上書きして使う（設計意図は .claude/structural-model.md「在来木造の梁は
// 交点で『通しが勝つ』」節）。
//
// 同一直線上で両側の断面（成）が異なる交点は現行どおり柱面で止める（sectionBreak＝「梁成が変わる
// 交点は描画上そう解釈する」）。
//
// 参加集合は role==='primary' のみ（QA裁定・2026-09-17）。床梁・小梁（core/structuralEntities.js
// PIN_ROLES）は既にホスト梁の縁で止まる（clearance 0）ため対象外。基礎梁（foundation）は
// renderer/StructuralLayer.jsx の woodFoundationBands が別系統（土台・ベース帯）で処理するため対象外。
// 軒桁（eaves）・屋根材（roof）は小屋伏図の別ステップ（3f以降）で裁定するため今回は対象外——
// いずれも将来 primary 相当の交点処理が要る場面が出ても、この関数の対象role集合を広げる形で
// 個別に裁定してから追加する（「primary以外はまとめて対象外」を今の唯一の境界線にする）。
//
// core.js非依存の純モジュール（node:testから単体importできる。team-lessons「抽出モジュールは
// node:testから単体import可能に保つ」）。import は CL_OVERLAP_TOL_MM のみ。
// ================================================================
import { CL_OVERLAP_TOL_MM } from '../core/constants.js';

// 方向キー。StructuralBeam.isVertical=true は通り芯X（垂直材＝coord1/2がY座標）に沿う——
// 「X方向」＝isVertical=false（水平材。coord1/2がX座標）、「Y方向」＝isVertical=true。
const dirKey = isVertical => (isVertical ? 'Y' : 'X');
const otherDir = d => (d === 'X' ? 'Y' : 'X');

// 点群を tol でクラスタリングする（mergeWallIntervals/dedupCoords と同じ「隣接をtolでまとめる」発想の
// 2次元版）。貪欲法——チェーン状に少しずつずれる病的な入力での完全性は保証しないが、実データの
// 交点間隔（数百mm〜）に対しtol=0.5mmは十分に小さく実用上問題ない。
function clusterPoints(points, tol) {
  const clusters = [];
  for (const pt of points) {
    let cluster = clusters.find(c => Math.abs(c.x - pt.x) < tol && Math.abs(c.y - pt.y) < tol);
    if (!cluster) {
      cluster = { x: pt.x, y: pt.y, sumX: 0, sumY: 0, count: 0, items: [] };
      clusters.push(cluster);
    }
    cluster.items.push(pt);
    cluster.sumX += pt.x;
    cluster.sumY += pt.y;
    cluster.count += 1;
    cluster.x = cluster.sumX / cluster.count;
    cluster.y = cluster.sumY / cluster.count;
  }
  return clusters;
}

/**
 * 在来木造の梁の交点処理（drawing.beamJunction==='throughWins' のときだけ動作）。
 * @param {{beamJunction?: string}|null|undefined} drawing - structureRules.js の rulesFor(structure).drawing
 * @param {Array<{id:string, role:string, isVertical:boolean, axisValue:number, end1:number, end2:number,
 *   base1:number, base2:number, halfWidth:number, sectionKey:string|null}>} beams
 *   end1/end2＝clStart/clEnd.effectiveValue（AXIS・未トリム）。base1/base2＝spanForColumns の結果
 *   （下階柱面でのトリム済み）。halfWidth＝beamRenderWidth(b,lod)/2（単線LODは0）。sectionKey＝sectionDefId。
 * @param {{tol?: number}} [opts]
 * @returns {Map<string, {coord1:number, coord2:number, ends:[{kind:string,capped:boolean},{kind:string,capped:boolean}]}>}
 *   変化した梁（少なくとも片端が base 以外になった梁）だけを収める。'columnFace'/未知値/undefined は
 *   常に空Map（恒等の根拠をここに置く——呼び出し側は分岐しない）。
 */
export function resolveBeamJunctionSpans(drawing, beams, { tol = CL_OVERLAP_TOL_MM } = {}) {
  const result = new Map();
  if (drawing?.beamJunction !== 'throughWins') return result;
  const primaries = (beams ?? []).filter(b => b.role === 'primary');
  if (primaries.length === 0) return result;

  // 全参加梁の両端点を集めてクラスタリング（交点候補）。
  const points = [];
  for (const b of primaries) {
    const p1 = b.isVertical ? { x: b.axisValue, y: b.end1 } : { x: b.end1, y: b.axisValue };
    const p2 = b.isVertical ? { x: b.axisValue, y: b.end2 } : { x: b.end2, y: b.axisValue };
    points.push({ ...p1, beam: b, endIndex: 0, dir: Math.sign(b.end2 - b.end1) || 1, along: b.end1 });
    points.push({ ...p2, beam: b, endIndex: 1, dir: Math.sign(b.end1 - b.end2) || 1, along: b.end2 });
  }
  const clusters = clusterPoints(points, tol);

  // 端ごとの解決結果を id -> [end0, end1] へ積む（両端が別の交点で解決されうるため先に用意する）。
  const perBeam = new Map();
  for (const b of primaries) perBeam.set(b.id, [null, null]);

  for (const cluster of clusters) {
    const armsByDir = { X: [], Y: [] };
    for (const item of cluster.items) armsByDir[dirKey(item.beam.isVertical)].push(item);

    // 通過する梁（passing。role==='primary'限定・スパン内部を厳密に通過。勝者候補のみ）。
    const passingByDir = { X: [], Y: [] };
    for (const b of primaries) {
      const lo = Math.min(b.base1, b.base2), hi = Math.max(b.base1, b.base2);
      if (b.isVertical) {
        if (Math.abs(b.axisValue - cluster.x) < tol && cluster.y > lo + tol && cluster.y < hi - tol) passingByDir.Y.push(b);
      } else if (Math.abs(b.axisValue - cluster.y) < tol && cluster.x > lo + tol && cluster.x < hi - tol) {
        passingByDir.X.push(b);
      }
    }

    const continuous = {}, sectionBreak = {};
    for (const d of ['X', 'Y']) {
      const plus = armsByDir[d].filter(a => a.dir === 1);
      const minus = armsByDir[d].filter(a => a.dir === -1);
      const matched = plus.some(p => minus.some(m => p.beam.sectionKey === m.beam.sectionKey));
      continuous[d] = passingByDir[d].length > 0 || (plus.length > 0 && minus.length > 0 && matched);
      sectionBreak[d] = plus.length > 0 && minus.length > 0 && !matched;
    }

    // 勝者決定（この順で1回）。
    let winner = null;
    if (continuous.X && !continuous.Y) winner = 'X';
    else if (continuous.Y && !continuous.X) winner = 'Y';
    else if (continuous.X && continuous.Y) winner = 'X'; // 十字は既定X
    else if (!sectionBreak.X && !sectionBreak.Y) {
      // どちらも連続でなく、断面違いの衝突（sectionBreak）も無い＝出隅（L字）。両方向に実際にarmが
      // あるときだけ材長（各方向の最大値。同一方向に複数armがあっても代表は最長のもの）で比べる。
      const xArms = armsByDir.X, yArms = armsByDir.Y;
      if (xArms.length > 0 && yArms.length > 0) {
        const xLen = Math.max(...xArms.map(a => Math.abs(a.beam.end2 - a.beam.end1)));
        const yLen = Math.max(...yArms.map(a => Math.abs(a.beam.end2 - a.beam.end1)));
        winner = Math.abs(xLen - yLen) <= tol ? 'X' : (xLen > yLen ? 'X' : 'Y');
      }
    }
    if (winner == null) continue; // 勝者なし＝この交点は何もしない（baseのまま）

    // 勝者側の実描画半幅（passing・勝者方向armの最大値。共線ペアなら2本のmax）。
    const winnerHalfWidth = Math.max(
      0,
      ...passingByDir[winner].map(b => b.halfWidth),
      ...armsByDir[winner].map(a => a.beam.halfWidth),
    );

    for (const d of ['X', 'Y']) {
      for (const arm of armsByDir[d]) {
        const b = arm.beam;
        let kind, coord, capped;
        if (d === winner && continuous[winner]) {
          // 通し（連続成立）——勝ち方向armで連続が成り立っている＝pで貫通させたまま。
          kind = 'through';
          coord = arm.along;
          capped = false;
        } else if (d === winner) {
          // L字の勝者（連続不成立）——敗者側armの最大半幅ぶん控えて角を閉じる。
          const loserArms = armsByDir[otherDir(winner)];
          const loserHalf = Math.max(0, ...loserArms.map(a => a.beam.halfWidth));
          kind = 'cornerClose';
          coord = arm.along - arm.dir * loserHalf;
          capped = true;
        } else {
          // 負け方向arm——勝者の面（実描画半幅ぶん）で止める。
          kind = 'winnerFace';
          coord = arm.along + arm.dir * winnerHalfWidth;
          capped = false;
        }
        perBeam.get(b.id)[arm.endIndex] = { kind, capped, coord };
      }
    }
  }

  for (const b of primaries) {
    const [e0, e1] = perBeam.get(b.id);
    if (!e0 && !e1) continue; // 両端とも交点処理の対象外＝base（出力しない）
    // base側の座標は必ず base1/base2（spanForColumns済みの実体スパン）を使う——end1/end2（AXIS・
    // 未トリム）を使うと、柱面トリムを無視して下階柱を突き抜けた座標を返してしまう（beamJunction.test.js
    // (l)がこの取り違えを検出する）。
    const end0 = e0 ?? { kind: 'base', capped: false, coord: b.base1 };
    const end1 = e1 ?? { kind: 'base', capped: false, coord: b.base2 };
    result.set(b.id, {
      coord1: end0.coord,
      coord2: end1.coord,
      ends: [
        { kind: end0.kind, capped: end0.capped },
        { kind: end1.kind, capped: end1.capped },
      ],
    });
  }
  return result;
}
