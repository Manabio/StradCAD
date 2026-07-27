import { observer } from 'mobx-react-lite';
import { Line, Rect, Circle, Path } from 'react-konva';
import { ShapeType } from '@core';
import { findOpeningsOnWall } from '../openings/openingGeometry.js';
import { isEndpointAt } from '../transform/centerLineExtend.js';
import { LodLevel, resolveStrokeWidth } from '../viewport.js';
import { subtractIntervals } from '../finish/stair/stairGeometry.js';
import { resolveWallTJunctions } from './wallJunctionResolve.js';

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
// 端点はねだし判定の座標許容誤差(mm)
const ENDPOINT_EPS = 0.5;

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

export const ShapesLayer = observer(({ graph, viewport }) => {
  if (!graph) return null;
  const { scaleX, scaleY, lodLevel } = viewport;

  // 下地（間柱）描画の重複防止: 同一axisCL上で範囲が重なる正負オフセットの壁ペア
  // （部屋境界の内外両側）は通り芯上の同じ構造材を指すため、正(+)側のみ描画する。
  // 偏芯壁（backingOffset指定あり）は下地帯が通り芯に対して対称でない＝相手側と共有する構造材
  // ではないため、この重複防止の対象外（自分の下地は常に描画・相手側の判定にも使わない）。
  // 新モデル（finish/wallGeneration.js の resolveBackingOwnership/applyBackingOwnership）で
  // 生成された壁は backingOffset を必ず明示（オーナーは0・非オーナーは薄壁でbackingDepth=0）
  // するため、この判定（backingOffset==null）の対象に自然に入らない——ここは旧データ
  // （backingOffset未設定の対称壁ペア）の表示互換のためのフォールバックとして残す。
  const deferredBackingIds = new Set();
  if (lodLevel === LodLevel.DETAIL) {
    const wallShapes = graph.generalShapes.filter(s =>
      s.type === ShapeType.WALL && s.wallFinish != null && s.backingOffset == null);
    for (const w of wallShapes) {
      if (w.axisOffset >= 0) continue;
      const wLo = Math.min(w.coord1, w.coord2), wHi = Math.max(w.coord1, w.coord2);
      const hasPositiveOverlap = wallShapes.some(o =>
        o !== w && o.axisCL === w.axisCL && o.axisOffset > 0 &&
        Math.min(o.coord1, o.coord2) < wHi && Math.max(o.coord1, o.coord2) > wLo,
      );
      if (hasPositiveOverlap) deferredBackingIds.add(w.id);
    }
  }

  // 壁のT字取り合い（突き当たり）解決: 詳細LODでのみ、ジオメトリを変えずに描画時だけ反映する
  // （wallJunctionResolve.js。resolveStairSideLines と同じ「描画ルールを幾何モジュールに
  // 集約しレンダラは写像するだけ」というパターン）。壁全般が対象——手動壁・部屋壁・外壁・
  // 階段下壁を区別しない。
  // 上の deferredBackingIds と同様、useMemo 等の追加メモ化はせず壁配列を毎レンダー走査する
  // （このファイルの既存慣習に合わせる。過剰最適化はしない——壁数が増えて気になる場合は
  // 将来 useMemo 化を検討）。
  const wallJunctions = lodLevel === LodLevel.DETAIL ? resolveWallTJunctions(graph.walls) : null;

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
        // ホストされた開口がある区間を除いた複数の区間に分割する
        const openings = findOpeningsOnWall(shape, graph)
          .slice().sort((a, b) => a.coord1 - b.coord1);
        const lo = Math.min(shape.coord1, shape.coord2), hi = Math.max(shape.coord1, shape.coord2);
        const segments = [];
        let cursor = lo;
        for (const o of openings) {
          if (o.coord1 > cursor) segments.push([cursor, o.coord1]);
          cursor = Math.max(cursor, o.coord2);
        }
        if (cursor < hi) segments.push([cursor, hi]);

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

        // 標準・詳細: 軸CL(柱芯) 〜 face(仕上げ面) の帯で実厚を表現
        // 中心線(axisV)は CenterLinesLayer が別途描画するため、ここでは重複させない
        // （仕上げ面の長辺 + 両端の妻線のみを描き、軸CL上の長辺は描かない）
        const axisV = shape.axisCL.effectiveValue;
        const faceV = shape.axisValue;

        // 妻線(cap)・端点はねだし部木口(ecap)の描画範囲: 既定（backingDepth未指定=null）は
        // axisV〜faceV（下地帯が通り芯位置から始まる対称壁の想定。従来どおり変更なし）。
        // backingDepth を明示する偏芯壁（階段下部屋の薄壁等）は、通り芯〜面材間に逃げ空隙を
        // 持ちうるため、実際に材が存在する範囲（下地帯 ∪ 仕上げ帯）に限定する
        // （decisional・LOD非依存）。式は core.js の Wall.materialRange と共有する
        // （階段下壁のコーナートリム stairUnderWalls.js でも同じ式を使う）。
        const { lo: capLo, hi: capHi } = shape.materialRange;

        // 壁のT字取り合い（wallJunctionResolve.js）: 自壁が「突き当たり側（A）」の場合は
        // baseExtend、「通し壁（B）」の場合は finishCuts が入る（両方同時に持つ壁もありうる）。
        // 詳細LOD以外（wallJunctions=null）は常に空——標準・略図の描画は一切変えない。
        const junction    = wallJunctions?.get(shape.id);
        const baseExtend  = junction?.baseExtend ?? {};
        const finishCuts  = junction?.finishCuts ?? [];
        // 仕上げ面線・仕上げ境界線（fin線）専用のセグメント: 直交する通し壁側からの
        // finishCuts があれば、その区間だけ切り欠く（cap線・下地には適用しない——
        // cap線は自壁の物理端点の断面、下地は baseExtend で別途扱う）。
        const finishSegments = finishCuts.length === 0 ? segments
          : segments.flatMap(([a, b]) => subtractIntervals(a, b, finishCuts));

        const faceLines = finishSegments.map(([a, b], i) => (
          <Line
            key={`${shape.id}:face:${i}`}
            points={shape.isVertical
              ? [faceV, a, faceV, b]
              : [a, faceV, b, faceV]
            }
            {...sp}
          />
        ));
        // cap線（妻線）: 自壁がT字の突き当たり側（A）としてその端で baseExtend を持つ場合、
        // その端は下地がB内部へ食い込む取り合いになり、そこで壁が「終わる」断面線は不要
        // なため描画を抑止する（自壁の物理両端＝最初のセグメントのa・最後のセグメントのb
        // でのみ判定。開口で分割された中間セグメント境界は対象外）。
        const capLines = segments.flatMap(([a, b], i) => {
          const line = [];
          if (!(i === 0 && baseExtend.lo != null)) {
            line.push(
              <Line
                key={`${shape.id}:capA:${i}`}
                points={shape.isVertical ? [capLo, a, capHi, a] : [a, capLo, a, capHi]}
                {...sp}
              />,
            );
          }
          if (!(i === segments.length - 1 && baseExtend.hi != null)) {
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

        // dir: 仕上げ面が向く側。CL偏芯の「仕上げ面合わせ」で面がCL上に一致し（axisOffset===0
        // → faceV===axisV）sign(faceV-axisV) が不定になるケースは finishSide の明示値を
        // 優先する（Wall.finishSide のドキュメント参照）。境界判定も axisV〜faceV の対称範囲
        // （axisOffset===0で潰れる）ではなく、実際に材が存在する範囲 materialRange
        // （capLo/capHi。backingDepth等の偏芯を反映）で行う。
        // 境界の等号は含める（<= / >=）: backingDepth===0（下地なし＝仕上げのみの薄壁。階段下
        // レーン間薄壁・CL偏芯の非オーナー薄壁）は capLo===boundary または capHi===boundary に
        // ちょうど一致するため、厳密不等号だと線が消える（QA回帰）。ただし axisV に一致する
        // （=下地帯が無い対称壁で仕上げ厚が壁厚と同値になる退化ケース）は境界線として無意味なため
        // ENDPOINT_EPS で除外する。
        const dir      = shape.finishSide ?? (Math.sign(faceV - axisV) || 1);
        const boundary = faceV - dir * shape.wallFinish;
        if (shape.wallFinish > 0 && boundary >= capLo && boundary <= capHi && Math.abs(boundary - axisV) > ENDPOINT_EPS) {
          elems.push(...finishSegments.map(([a, b], i) => (
            <Line
              key={`${shape.id}:fin:${i}`}
              points={shape.isVertical
                ? [boundary, a, boundary, b]
                : [a, boundary, b, boundary]
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
        // 仕上げ関連要素＝finishSegments とは独立に扱う）。
        const backingBand = shape.backingRange;
        if (backingBand && !deferredBackingIds.has(shape.id)) {
          const backingDepth = backingBand.hi - backingBand.lo;
          const halfDepth = backingDepth / 2, halfWidth = WALL_STUD_WIDTH / 2;
          const backingCenterV = (backingBand.lo + backingBand.hi) / 2;
          const backingSegments = segments.map(([a, b], i, arr) => [
            i === 0 && baseExtend.lo != null ? Math.min(a, baseExtend.lo) : a,
            i === arr.length - 1 && baseExtend.hi != null ? Math.max(b, baseExtend.hi) : b,
          ]);
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
