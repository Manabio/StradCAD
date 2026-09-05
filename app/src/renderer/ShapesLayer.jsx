import { observer } from 'mobx-react-lite';
import { Group, Line, Rect, Circle, Path } from 'react-konva';
import { ShapeType } from '@core';
import { isEndpointAt } from '../transform/centerLineExtend.js';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { buildWallDrawPlan } from './wallDrawPlan.js';
import { ENDPOINT_EPS } from './wallJunctionResolve.js';
import { graphComputed } from './graphDerived.js';

const DASH = {
  solid:     undefined,
  dashed:    [8, 4],
  center:    [12, 4, 2, 4],
  dimension: [4, 4],
};

// 壁下地（間柱）のピッチ表現(mm)。LOD詳細描画でのみ使用。
const WALL_BACKING_PITCH = 450;
// 壁下地の角材を通り芯方向に描く際の見かけ幅(mm)。実材の長手方向寸法は壁データに
// 持たないため、間柱の標準的な厚み（□-90×45 の 45 側）を描画上の固定値として使う。
const WALL_STUD_WIDTH = 45;

function strokeProps(shape, scaleX, scaleY) {
  return {
    stroke:      shape.color,
    strokeWidth: resolveStrokeWidth(shape.lineWeight, Math.min(scaleX, scaleY)),
    dash:        DASH[shape.lineType],
    listening:   false,
  };
}

// SVG arc パス文字列 (ワールド座標 mm)
export function arcPathD(cx, cy, radius, startAngleDeg, includedAngleDeg) {
  const toRad = (d) => (d * Math.PI) / 180;
  const sa    = toRad(startAngleDeg);
  const ea    = toRad(startAngleDeg + includedAngleDeg);
  const x1    = cx + radius * Math.cos(sa);
  const y1    = cy + radius * Math.sin(sa);
  const x2    = cx + radius * Math.cos(ea);
  const y2    = cy + radius * Math.sin(ea);
  const large = Math.abs(includedAngleDeg) > 180 ? 1 : 0;
  const sweep = includedAngleDeg > 0 ? 1 : 0;
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${large} ${sweep} ${x2} ${y2}`;
}

// 2a壁の描画クリップ（stairUnderClip.js の stairUnderWallClips が返すサブパス配列）を
// Konva の Group clipFunc へ渡す。clipFunc はグループの絶対変換込みで呼ばれるため
// （Konva Container._drawChildren）、座標変換は不要——ワールドmm座標のまま moveTo/lineTo する。
function makeClipFunc(subpaths) {
  return (ctx) => {
    for (const sp of subpaths) {
      if (sp.length === 0) continue;
      ctx.moveTo(sp[0].x, sp[0].y);
      for (let i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
      ctx.closePath();
    }
  };
}

export const ShapesLayer = observer(({ graph, viewport, stairUnderClips = null }) => {
  if (!graph) return null;
  const { scaleX, scaleY, lodLevel } = viewport;

  // 壁をまたぐ派生値（下地の重複防止・T字取り合い・腰壁垂れ壁・柱の仕上げ包み・壁ごとの開口）は
  // wallDrawPlan.js に集約し、graphComputed で graph 単位にキャッシュする。これらは graph が変わらない
  // 限り同じ結果だが、このレイヤーは observer なのでパン・ズーム・ポインタ移動のたびに再レンダー
  // される——毎回総当たりし直すと実測約30ms/レンダーで、60fps の予算を一回で使い切る
  // （平面モードのカクつきの主因）。
  // LOD ごとに結果が違うため lodLevel をキーに含める（graphDerived.js の約束）。
  const { deferredBackingIds, wallJunctions, kneeDropOverlays, columnCuts, wallLines } =
    graphComputed(graph, `wallDrawPlan:${lodLevel}`, () => buildWallDrawPlan(graph, lodLevel));

  return graph.generalShapes.map((shape) => {
    const sp = strokeProps(shape, scaleX, scaleY);

    switch (shape.type) {

      case ShapeType.VERTICAL:
        return (
          <Line
            key={shape.id}
            points={[shape.x, shape.y1, shape.x, shape.y2]}
            {...sp}
          />
        );

      case ShapeType.HORIZONTAL:
        return (
          <Line
            key={shape.id}
            points={[shape.x1, shape.y, shape.x2, shape.y]}
            {...sp}
          />
        );

      case ShapeType.DIAGONAL:
        return (
          <Line
            key={shape.id}
            points={[shape.nodeA.x, shape.nodeA.y, shape.nodeB.x, shape.nodeB.y]}
            {...sp}
          />
        );

      case ShapeType.WALL: {
        // 3通り（略図の単線／標準の帯／詳細の下地・仕上げ要素）の描画結果を1変数へ集約し、
        // 2a壁（階段下部屋の偏芯壁）は末尾で1回だけ描画クリップ（stairUnderClips）を適用する
        // （破れ線より階段踏面側の部分を描かない。.claude/stair-model.md 参照）。
        const out = (() => {
        // 壁1本分の描画ライン（開口分割・仕上げ面線・内側線・キャップ抑止）は
        // wallDrawPlan.js の resolveWallLines に判断を集約済み——ここは写像するだけ
        // （そちらのJSDoc参照。開口・T字/コーナー取り合い・柱の仕上げ包みを
        // buildWallDrawPlan内でまとめて解決している）。
        const plan = wallLines.get(shape.id);
        const { segments, faceSegments, finSegments, finBoundary, finVisible, capLoSuppressed, capHiSuppressed } = plan;
        const lo = Math.min(shape.coord1, shape.coord2), hi = Math.max(shape.coord1, shape.coord2);

        if (lodLevel === LodLevel.SCHEMATIC) {
          // 略図: 軸オフセット位置の単線（厚み表現なし）
          return segments.map(([a, b], i) => (
            <Line
              key={`${shape.id}:${i}`}
              points={shape.isVertical
                ? [shape.axisValue, a, shape.axisValue, b]
                : [a, shape.axisValue, b, shape.axisValue]
              }
              {...sp}
            />
          ));
        }

        // 腰壁・垂れ壁: 平面切断高さ以下の腰壁／壁本体を貫かない垂れ壁は、通常の壁帯描画の
        // 代わりに天板幅（faceLo-出幅 〜 faceHi+出幅）の輪郭を実線（腰壁）/破線（垂れ壁）で描く
        // （resolveKneeDropOverlays が優先順位込みで解決済み。開口による区間分割はそのまま使う）。
        const kneeDrop = kneeDropOverlays?.get(shape.id) ?? null;
        if (kneeDrop) {
          const dash = kneeDrop.mode === 'knee' ? DASH.solid : DASH.dashed;
          return segments.map(([a, b], i) => (
            <Rect
              key={`${shape.id}:kdcap:${i}`}
              x={shape.isVertical ? kneeDrop.capLo : a}
              y={shape.isVertical ? a : kneeDrop.capLo}
              width={shape.isVertical ? kneeDrop.capHi - kneeDrop.capLo : b - a}
              height={shape.isVertical ? b - a : kneeDrop.capHi - kneeDrop.capLo}
              fill="transparent"
              stroke={sp.stroke}
              strokeWidth={sp.strokeWidth}
              dash={dash}
              listening={false}
            />
          ));
        }

        // 標準・詳細: 軸CL(柱芯) 〜 face(仕上げ面) の帯で実厚を表現
        // 中心線は CenterLinesLayer が別途描画するため、ここでは重複させない
        // （仕上げ面の長辺 + 両端の妻線のみを描き、軸CL上の長辺は描かない）
        const faceV = shape.axisValue;

        // 妻線(cap)・端点はねだし部木口(ecap)の描画範囲: 既定（backingDepth未指定=null）は
        // axisV〜faceV（下地帯が通り芯位置から始まる対称壁の想定。従来どおり変更なし）。
        // backingDepth を明示する偏芯壁（階段下部屋の薄壁等）は、通り芯〜面材間に逃げ空隙を
        // 持ちうるため、実際に材が存在する範囲（下地帯 ∪ 仕上げ帯）に限定する
        // （decisional・LOD非依存）。式は core.js の Wall.materialRange と共有する
        // （階段下壁のコーナートリム stairUnderWalls.js でも同じ式を使う）。
        const { lo: capLo, hi: capHi } = shape.materialRange;

        const faceLines = faceSegments.map(([a, b], i) => (
          <Line
            key={`${shape.id}:face:${i}`}
            points={shape.isVertical
              ? [faceV, a, faceV, b]
              : [a, faceV, b, faceV]
            }
            {...sp}
          />
        ));
        // cap線（妻線）: 抑止するかどうかの判断（capLoSuppressed/capHiSuppressed）は
        // wallDrawPlan.js の resolveWallLines に集約済み——ここは自壁の物理両端
        // （最初のセグメントのa＝lo端／最後のセグメントのb＝hi端）でのみ適用して写像するだけ
        // （開口で分割された中間セグメント境界は対象外）。
        const capLines = segments.flatMap(([a, b], i) => {
          const line = [];
          if (!(i === 0 && capLoSuppressed)) {
            line.push(
              <Line
                key={`${shape.id}:capA:${i}`}
                points={shape.isVertical ? [capLo, a, capHi, a] : [a, capLo, a, capHi]}
                {...sp}
              />,
            );
          }
          if (!(i === segments.length - 1 && capHiSuppressed)) {
            line.push(
              <Line
                key={`${shape.id}:capB:${i}`}
                points={shape.isVertical ? [capLo, b, capHi, b] : [b, capLo, b, capHi]}
                {...sp}
              />,
            );
          }
          return line;
        });
        const rects = [...faceLines, ...capLines];

        // 詳細のみ: 仕上げ面〜下地境界の平行線 + 下地（間柱断面）450mmピッチ配置
        // wallFinish は generateRoomWallsFromOutline/generateExteriorWalls 生成時のみ確定（手動壁は null）
        if (lodLevel !== LodLevel.DETAIL || shape.wallFinish == null) {
          return rects;
        }

        const elems = [...rects];

        // 内側線（fin線）の位置(finBoundary)と可視性(finVisible)は wallJunctionResolve.js の
        // resolveFinVisibility（唯一の供給源。パス2の候補判定=makeViewと同じ関数）が
        // wallDrawPlan.js経由で解決済み——ここは写像するだけ（旧: capLo/capHi/axisVを使う
        // 同じ式をこの.jsx側にも重複して持っており、ENDPOINT_EPSの定義ドリフトを含め
        // 実バグの一因だった）。
        if (finVisible) {
          elems.push(...finSegments.map(([a, b], i) => (
            <Line
              key={`${shape.id}:fin:${i}`}
              points={shape.isVertical
                ? [finBoundary, a, finBoundary, b]
                : [a, finBoundary, b, finBoundary]
              }
              {...sp}
            />
          )));
        }

        // 端点はねだし部の木口: 仕上げ厚の見切り線を妻線の内側に加えて2重線にする
        // （他の仕上げ線と同様、詳細のみ）。端点判定は軸CLの線分範囲越え＋交点消失で導出する
        if (shape.wallFinish > 0) {
          const axisCL = shape.axisCL;
          const tips = [
            { side: 'lo', beyond: axisCL.extentLo != null && lo < axisCL.extentLo - ENDPOINT_EPS, capV: lo + shape.wallFinish },
            { side: 'hi', beyond: axisCL.extentHi != null && hi > axisCL.extentHi + ENDPOINT_EPS, capV: hi - shape.wallFinish },
          ];
          for (const t of tips) {
            if (!t.beyond || !isEndpointAt(graph, axisCL, t.side)) continue;
            if (!segments.some(([a, b]) => t.capV > a && t.capV < b)) continue;
            elems.push(
              <Line
                key={`${shape.id}:ecap:${t.side}`}
                points={shape.isVertical
                  ? [capLo, t.capV, capHi, t.capV]
                  : [t.capV, capLo, t.capV, capHi]
                }
                {...sp}
              />,
            );
          }
        }

        // 下地（間柱）断面: 通り芯(axisCL)上の実材厚。式は core.js の Wall.backingRange と
        // 共有する（backingRange===null は「下地なし＝仕上げのみの薄壁」で描画しない）。
        // T字取り合いで自壁が突き当たり側（A）の場合、baseExtend の端まで下地の描画範囲を
        // 延ばす（通し壁の仕上げ層を貫通して相手の下地近位面まで到達する見た目にする。
        // 仕上げ関連要素＝faceSegments とは独立に扱う。baseExtend/colCuts.backing は
        // resolveWallLines の対象外——下地断面はfin/face線とは別の描画要素のため、
        // ここは従来どおりwallJunctions/columnCutsを直接参照する）。
        const baseExtend = wallJunctions?.get(shape.id)?.baseExtend ?? {};
        const colCuts = columnCuts?.get(shape.id) ?? null;
        const backingBand = shape.backingRange;
        if (backingBand && !deferredBackingIds.has(shape.id)) {
          const backingDepth = backingBand.hi - backingBand.lo;
          const halfDepth = backingDepth / 2, halfWidth = WALL_STUD_WIDTH / 2;
          const backingCenterV = (backingBand.lo + backingBand.hi) / 2;
          const extended = segments.map(([a, b], i, arr) => [
            i === 0 && baseExtend.lo != null ? Math.min(a, baseExtend.lo) : a,
            i === arr.length - 1 && baseExtend.hi != null ? Math.max(b, baseExtend.hi) : b,
          ]);
          // 柱壁に取られた区間の下地は削除する（ユーザー指示2026-08「不要になった壁下地材は削除」）。
          // ただし**その下地に乗る仕上げ材が他に残っていれば削除しない**（反対側の部屋の壁など。
          // 判定は columnWallCuts の canRemoveBacking が持ち、`backing` として区間を返す）。
          const studCuts = colCuts?.backing ?? [];
          const backingSegments = studCuts.length === 0 ? extended
            : extended.flatMap(([a, b]) => subtractIntervals(a, b, studCuts));
          for (const [a, b] of backingSegments) {
            let p = lo + Math.ceil((a - lo) / WALL_BACKING_PITCH) * WALL_BACKING_PITCH;
            if (p - halfWidth < a) p += WALL_BACKING_PITCH;
            for (; p + halfWidth <= b; p += WALL_BACKING_PITCH) {
              elems.push(
                <Rect
                  key={`${shape.id}:stud:${p}`}
                  x={shape.isVertical ? backingCenterV - halfDepth : p - halfWidth}
                  y={shape.isVertical ? p - halfWidth : backingCenterV - halfDepth}
                  width={shape.isVertical ? backingDepth : WALL_STUD_WIDTH}
                  height={shape.isVertical ? WALL_STUD_WIDTH : backingDepth}
                  fill="transparent"
                  stroke={sp.stroke}
                  strokeWidth={sp.strokeWidth}
                  listening={false}
                />,
              );
            }
          }
        }

        return elems;
        })();

        const clip = stairUnderClips?.get(shape.id);
        return clip ? <Group key={shape.id} clipFunc={makeClipFunc(clip)}>{out}</Group> : out;
      }

      case ShapeType.ARC:
        return (
          <Path
            key={shape.id}
            data={arcPathD(
              shape.center.x, shape.center.y,
              shape.radius,
              shape.startAngle,
              shape.includedAngle,
            )}
            fill="transparent"
            {...sp}
          />
        );

      case ShapeType.CIRCLE:
        return (
          <Circle
            key={shape.id}
            x={shape.center.x}
            y={shape.center.y}
            radius={shape.radius}
            fill="transparent"
            {...sp}
          />
        );

      default:
        return null;
    }
  });
});
