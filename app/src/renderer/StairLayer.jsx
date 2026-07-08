import { observer } from 'mobx-react-lite';
import { Group, Line, Text, Shape, Circle } from 'react-konva';
import { buildStairGeometry, LABEL_OUT } from '../finish/stair/stairGeometry.js';
import { outlineSegments } from '../finish/gridCells.js';

const STAIR_STROKE = '#1e293b';
const CHEVRON_ANGLE = Math.PI / 7; // 矢じり(^)の開き角
const CLIP_EPS = 1e-6; // 交点パラメータ(t/u)の許容誤差

// 線分 p1-p2 と p3-p4 の交点を返す（区間内でなければ null）。t は p1-p2 上のパラメータ(0..1)。
function segIntersect(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
  const d1x = p2x - p1x, d1y = p2y - p1y;
  const d2x = p4x - p3x, d2y = p4y - p3y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;
  if (t < -CLIP_EPS || t > 1 + CLIP_EPS || u < -CLIP_EPS || u > 1 + CLIP_EPS) return null;
  return { x: p1x + d1x * t, y: p1y + d1y * t, t };
}

// 矢印の経路 pts（フラット [x,y,x,y,...]。始点→終点の歩行順）を、始点側から順に
// clipSegs（自階 install 階段の破れ線。複数線分の配列）との最初の交点でクリップする。
// 交点以降（終点側）はそのまま残す。型（直進/U字/L字等）に依存しない汎用ロジック。
// 交点が見つからなければ null（呼び出し側は安全側で元の矢印のまま描く）。
function clipArrowStartAtBreak(pts, clipSegs) {
  if (!clipSegs || clipSegs.length === 0) return null;
  for (let i = 0; i <= pts.length - 4; i += 2) {
    const p1x = pts[i], p1y = pts[i + 1], p2x = pts[i + 2], p2y = pts[i + 3];
    let best = null;
    for (const seg of clipSegs) {
      const ip = segIntersect(p1x, p1y, p2x, p2y, seg.x1, seg.y1, seg.x2, seg.y2);
      if (ip && (!best || ip.t < best.t)) best = ip;
    }
    if (best) return [best.x, best.y, ...pts.slice(i + 2)];
  }
  return null;
}

// 矢印の経路 pts を、始点側から順に clipSegs との最初の交点でクリップし、
// [開始点…交点] を返す（終端側を切り捨てる。始点側＝到達点側はそのまま残す）。
// 交点が見つからなければ null。
function clipArrowEndAtBreak(pts, clipSegs) {
  if (!clipSegs || clipSegs.length === 0) return null;
  for (let i = 0; i <= pts.length - 4; i += 2) {
    const p1x = pts[i], p1y = pts[i + 1], p2x = pts[i + 2], p2y = pts[i + 3];
    let best = null;
    for (const seg of clipSegs) {
      const ip = segIntersect(p1x, p1y, p2x, p2y, seg.x1, seg.y1, seg.x2, seg.y2);
      if (ip && (!best || ip.t < best.t)) best = ip;
    }
    if (best) return [...pts.slice(0, i + 2), best.x, best.y];
  }
  return null;
}

// フラット点列 [x,y,x,y,...] を (x,y) ペア単位で逆順にする。
function reversePointPairs(pts) {
  const rev = [];
  for (let i = pts.length - 2; i >= 0; i -= 2) rev.push(pts[i], pts[i + 1]);
  return rev;
}

// 点 (px,py) が矩形群（cellsBeyondBreak の破れ線先セルを cellBoundsList 相当で解決した
// ワールド矩形の配列）のいずれかに含まれるか。
function pointInBounds(boundsList, px, py) {
  return boundsList.some(cb => cb.x1 <= px && px <= cb.x2 && cb.y1 <= py && py <= cb.y2);
}

// 踏面線分 s が breakSegs（install の破れ線。複数線分の Z 字ジョグ）のいずれかと交差する
// 最初の交点を返す（s.x1,y1 側から見て最も近いもの）。交差しなければ null。
function findBreakCrossing(s, breakSegs) {
  if (!breakSegs || breakSegs.length === 0) return null;
  let best = null;
  for (const seg of breakSegs) {
    const ip = segIntersect(s.x1, s.y1, s.x2, s.y2, seg.x1, seg.y1, seg.x2, seg.y2);
    if (ip && (!best || ip.t < best.t)) best = ip;
  }
  return best;
}

// 終点の矢じりを、黒三角ではなく鋭く尖った "^"（開いた山形）の2点で返す。
// pts は矢印本体の points 配列（[x1,y1,x2,y2,...]）。終点側の進行方向へ向けて尖らせる。
function chevronPoints(pts, len) {
  const n = pts.length;
  const tip = { x: pts[n - 2], y: pts[n - 1] };
  const prev = { x: pts[n - 4], y: pts[n - 3] };
  const dx = tip.x - prev.x, dy = tip.y - prev.y;
  const d = Math.hypot(dx, dy) || 1;
  const bx = -dx / d, by = -dy / d; // 進行方向の逆（尖端から広がる向き）
  const cos = Math.cos(CHEVRON_ANGLE), sin = Math.sin(CHEVRON_ANGLE);
  const w1 = { x: bx * cos - by * sin, y: bx * sin + by * cos };
  const w2 = { x: bx * cos + by * sin, y: -bx * sin + by * cos };
  return [
    tip.x + w1.x * len, tip.y + w1.y * len,
    tip.x, tip.y,
    tip.x + w2.x * len, tip.y + w2.y * len,
  ];
}

/**
 * 階段を描画する。entries は描画用に解決済みの配列:
 *   { id, stair, bounds:{x1,y1,x2,y2}, riser:number|null, spans:{lengths:number[]}|null,
 *     view:'install'|'upper', selectable:boolean,
 *     cellBounds:Array<{x1,y1,x2,y2}>|undefined,  // 実セル占有（選択ヒット・枠用。省略時は bounds）
 *     suppressNumbers?:boolean, clipAgainstId?:string }
 *   suppressNumbers/clipAgainstId/beyondBreakBounds は、footprint が自階 install 階段と重なる
 *   upper エントリ（下階階段の見下げが自階の自動設置階段と同じ位置に表示される場合）に
 *   App.jsx が付与する。段数字を全部抑止し、矢印は clipAgainstId が指す install エントリの
 *   破れ線（実 polyline）でクリップして到達点側だけを残し、踏面線は beyondBreakBounds
 *   （install 階段の cellsBeyondBreak をワールド矩形へ解決したもの。stairGeometry.js で
 *   全タイプ単一ソース判定済み）に中点が入るものだけ残す（破れ線を跨ぐ踏面は破れ線交点で
 *   部分線分にクリップする）。下階階段の踏面番号・矢印先端・重複踏面が破れ線手前に
 *   残って見える不良の対策。
 * install/upper の両ビュー（設置階・設置上階）を同じ経路で描く。
 * bounds・spans は呼び出し側でワールド座標に解決済みのため、上階（peek した非アクティブ階）でも描ける。
 */
export const StairLayer = observer(({
  entries = [],
  viewport,
  detail = false,
  selectedStairId = null,
  onSelectStair = null,
}) => {
  const px = (w) => w / viewport.scaleX; // ズーム非依存の線幅

  // 1パス目: 全エントリの幾何を先に計算する（矢印クリップで他エントリ＝自階installの
  // breakLine を参照するため、レンダーの前に install 分を含め解決しておく必要がある）。
  const resolved = entries.map((e) => {
    const { stair, bounds: b, riser, spans, view } = e;
    if (!b || ![b.x1, b.y1, b.x2, b.y2].every(Number.isFinite) || b.x2 <= b.x1 || b.y2 <= b.y1) {
      return null;
    }
    return { e, geom: buildStairGeometry(stair, b, { view, detail, riser, spans }) };
  });
  const installGeomById = new Map(
    resolved.filter(r => r && r.e.view === 'install').map(r => [r.e.id, r.geom]),
  );

  const groups = resolved.map((r) => {
    if (!r) return null;
    const { e, geom } = r;
    const { id, bounds: b, view, selectable, cellBounds, hitCellBounds } = e;
    const isSel = id === selectedStairId;

    const lineProps = { stroke: STAIR_STROKE, strokeWidth: px(1.5), listening: false };

    // 段数字を抑止するエントリ（自階 install と footprint が重なる upper）は、対応する install
    // の幾何（breakLine）を使って矢印を破れ線基準に調整する。install が見つからない/破れ線が
    // 退化している場合は安全側で調整せず全描画する（外周・破れ線シンボル自体は常に geom の
    // まま＝変更しない）。
    const installGeom = e.suppressNumbers && e.clipAgainstId
      ? installGeomById.get(e.clipAgainstId)
      : null;
    const installBreakLine = installGeom?.breakLine;

    // 踏み面は線種の共通定義（LINE_WEIGHT_MM）の thin を参照する。
    // 重なる upper エントリ（suppressNumbers 付き）は、install の破れ線先セル（beyondBreakBounds。
    // cellsBeyondBreak で全タイプ単一ソース判定済み）に中点が入る踏面だけを残し、install が描く
    // 手前側と重複する踏面を間引く。install エントリ自身も beyondBreakBounds を持つ（重なる upper
    // へ渡すため）ので、suppressNumbers でガードしないと自階の手前踏面まで間引かれてしまう。
    // 破れ線（install の実 polyline）を跨ぐ踏面はセル粒度の中点判定だけでは全幅のまま手前側へ
    // はみ出すため、install の breakLine と交差する踏面だけは「破れ線交点〜先側端点」の部分
    // 線分にクリップする（先側＝両端点のうち beyondBreakBounds に入る方。両端点とも内包/
    // 非内包で先側を決められない場合は安全側で中点判定にフォールバック）。交差しない踏面は
    // 従来どおり中点判定のまま（挙動を変えない）。
    // beyondBreakBounds が空/未提供（cellsBeyondBreak が導出不能で空 Set を返した場合を含む）
    // なら安全側でフィルタなし（現状どおり全描画。二重線は残るが破綻しない）。
    const treadSegs = e.suppressNumbers && e.beyondBreakBounds?.length > 0
      ? geom.treads.reduce((acc, s) => {
          const crossing = findBreakCrossing(s, installBreakLine);
          if (crossing) {
            const p1In = pointInBounds(e.beyondBreakBounds, s.x1, s.y1);
            const p2In = pointInBounds(e.beyondBreakBounds, s.x2, s.y2);
            if (p1In !== p2In) {
              acc.push(p1In ? { ...s, x2: crossing.x, y2: crossing.y } : { ...s, x1: crossing.x, y1: crossing.y });
              return acc;
            }
            // 両端点とも同じ内外判定 → 先側を決められない。中点判定へフォールバック（下に続く）
          }
          const mx = (s.x1 + s.x2) / 2, my = (s.y1 + s.y2) / 2;
          if (pointInBounds(e.beyondBreakBounds, mx, my)) acc.push(s);
          return acc;
        }, [])
      : geom.treads;
    const treads = treadSegs.map((s, i) => (
      <Line key={`t${i}`} points={[s.x1, s.y1, s.x2, s.y2]} {...lineProps} stroke="#000000" strokeWidth={viewport.lineWeightsPx.thin} />
    ));
    const outline = geom.outline.map((s, i) => (
      <Line
        key={`o${i}`}
        points={[s.x1, s.y1, s.x2, s.y2]}
        {...lineProps}
        strokeWidth={s.thin ? viewport.lineWeightsPx.thin : px(2)}
        dash={s.dashed ? [px(40), px(30)] : undefined}
      />
    ));
    const breakLine = (geom.breakLine ?? []).map((s, i) => (
      <Line key={`b${i}`} points={[s.x1, s.y1, s.x2, s.y2]} {...lineProps} />
    ));

    // 矢印を install の破れ線位置でクリップする。塗り丸＝到達点側（下から登ってきた階段の
    // 最大段位置）はそのまま残し、矢じりだけ破れ線交点側に来るようにする（下階階段の「降り」
    // 表現：到達点に立って破れ線方向へ降りる）。全タイプで view!=='install' の矢印は
    // 始点(pts[0])が到達点側になるよう構築されている（stairGeometry.js 確認済み）ため、
    // 通常は終端側だけをクリップすれば足りる（反転不要）。念のため beyondBreakBounds で
    // 実際にどちら側が到達点（先側）かを確認し、型によって逆順の場合は始点側クリップ＋反転に
    // 切り替える（型非依存で統一的に扱う）。交点が求まらなければ安全側でフル矢印のまま。
    const resolvedArrows = (geom.arrows ?? []).map((a) => {
      if (!installBreakLine?.length) return a;
      const pts = a.points ?? [a.x1, a.y1, a.x2, a.y2];
      const bounds = e.beyondBreakBounds;
      const startIsBeyond = !(bounds?.length > 0) || pointInBounds(bounds, pts[0], pts[1]);
      const endIsBeyond = bounds?.length > 0 && pointInBounds(bounds, pts[pts.length - 2], pts[pts.length - 1]);
      let clippedPts;
      if (!startIsBeyond && endIsBeyond) {
        // このタイプは終点側が到達点（先側）→ 始点側をクリップしてから反転する
        const clipped = clipArrowStartAtBreak(pts, installBreakLine);
        clippedPts = clipped ? reversePointPairs(clipped) : null;
      } else {
        // 既定: 始点が到達点（先側）→ 終端側だけをクリップする（反転不要）
        clippedPts = clipArrowEndAtBreak(pts, installBreakLine);
      }
      if (!clippedPts) return a; // 交点なし → 安全側でフル矢印のまま
      const [nx, ny, nx2, ny2] = clippedPts;
      const dx = nx - nx2, dy = ny - ny2;
      const len = Math.hypot(dx, dy) || 1;
      return {
        ...a,
        x1: nx, y1: ny,
        x2: clippedPts[clippedPts.length - 2], y2: clippedPts[clippedPts.length - 1],
        points: clippedPts,
        labelX: nx + (dx / len) * LABEL_OUT, labelY: ny + (dy / len) * LABEL_OUT,
      };
    });

    const arrows = resolvedArrows.map((a, i) => {
      const pts = a.points ?? [a.x1, a.y1, a.x2, a.y2];
      return (
        <Group key={`a${i}`}>
          {/* 始点: 寸法線と同じ塗り丸 */}
          <Circle x={a.x1} y={a.y1} radius={px(2)} fill={STAIR_STROKE} listening={false} />
          {/* 矢印本体（折れ線U字矢印は points で複数点） */}
          <Line points={pts} stroke={STAIR_STROKE} strokeWidth={px(1.5)} listening={false} />
          {/* 終点の矢じり: 黒三角ではなく鋭く尖った "^" */}
          <Line
            points={chevronPoints(pts, px(10))}
            stroke={STAIR_STROKE} strokeWidth={px(1.5)}
            lineCap="round" lineJoin="round" listening={false}
          />
          {a.label && (
            <Text
              x={a.labelX} y={a.labelY}
              text={a.label} fontSize={200}
              fill={STAIR_STROKE} offsetX={60} offsetY={100} listening={false}
            />
          )}
        </Group>
      );
    });
    const stepNumbers = e.suppressNumbers ? [] : geom.stepNumbers.map((n, i) => (
      <Text
        key={`n${i}`}
        x={n.x} y={n.y} text={n.text} fontSize={120}
        fill={STAIR_STROKE} offsetX={40 * n.text.length} offsetY={60} listening={false}
      />
    ));

    // 選択ヒット領域・ハイライトは実セル占有形状で描く。包絡矩形で描くと
    // L字（矩折・曲がり）や中空きなど非矩形占有のタイプで空きマスまで矩形に
    // 選択されてしまう。塗りは1パス（部屋選択と同方式）、枠は共有辺を打ち
    // 消した外周線分で描く。cellBounds 未解決時は包絡矩形にフォールバック。
    const outlineBounds = cellBounds?.length > 0 ? cellBounds : [b];
    // クリックヒット領域は破れ線先セルを除外した hitCellBounds を優先する（下階階段の見下げ
    // クリック・階段下エリアの部屋ドラッグは Stage 側の startDrag に一本化しているため、
    // ここで自階階段の onClick を発火させない）。未指定時は選択枠と同じ領域を使う。
    const hitBounds = hitCellBounds?.length > 0 ? hitCellBounds : outlineBounds;

    return (
      <Group key={`${view}:${id}`}>
        {selectable && onSelectStair && (
          <Shape
            sceneFunc={(ctx, shape) => {
              ctx.beginPath();
              for (const cb of hitBounds) ctx.rect(cb.x1, cb.y1, cb.x2 - cb.x1, cb.y2 - cb.y1);
              ctx.fillStrokeShape(shape);
            }}
            fill={isSel ? 'rgba(37,99,235,0.10)' : 'transparent'}
            onClick={() => onSelectStair(id)}
            onTap={() => onSelectStair(id)}
          />
        )}
        {isSel && outlineSegments(outlineBounds).map(seg => (
          <Line
            key={`sel${seg.isVertical ? 'v' : 'h'}${seg.value}:${seg.lo}`}
            points={seg.isVertical
              ? [seg.value, seg.lo, seg.value, seg.hi]
              : [seg.lo, seg.value, seg.hi, seg.value]}
            stroke="#2563eb"
            strokeWidth={px(2)}
            listening={false}
          />
        ))}
        {treads}
        {outline}
        {breakLine}
        {arrows}
        {stepNumbers}
      </Group>
    );
  });

  return <Group>{groups}</Group>;
});
