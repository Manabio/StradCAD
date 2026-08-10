import { useState, useEffect, useRef } from 'react';
import { figureBounds, chooseScale, scaleLabel, makeTransform } from './sectionGeometry.js';
import { NumPad } from '../../ui/NumPad.jsx';
import { LABEL_ID_SUFFIX } from './layoutStudy.js';

// 2つの figureBounds を内包する和（配置検討で欄外へ逃げた要素もキャンバスに収めるため）。
function unionBounds(a, b) {
  const minX = Math.min(a.minX, b.minX), minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX), maxY = Math.max(a.maxY, b.maxY);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// 選択中要素（または寸法数値ラベル ::label）の px 中心。auto-scroll で欄外要素を追いかけるのに使う。
function selectedCenterPx(primitives, t, selectedId) {
  if (selectedId.endsWith(LABEL_ID_SUFFIX)) {
    const dimId = selectedId.slice(0, -LABEL_ID_SUFFIX.length);
    const p = primitives.find(q => q.type === 'dim' && q.layoutId === dimId);
    if (!p) return null;
    const isH = p.dir === 'h';
    const ldx = p.labelDX ? t.sx(p.labelDX) : 0;
    const ldy = p.labelDY ? t.sx(p.labelDY) : 0;
    const x = (isH ? (t.tx(p.from) + t.tx(p.to)) / 2 : t.tx(p.at) + (p.labelSide === 'left' ? -8 : 8)) + ldx;
    const y = (isH ? t.ty(p.at) - 8 : (t.ty(p.from) + t.ty(p.to)) / 2) + ldy;
    return { x, y };
  }
  const sel = primitives.filter(p => p.layoutId === selectedId);
  if (sel.length === 0) return null;
  const b = figureBounds(sel);
  return { x: (t.tx(b.minX) + t.tx(b.maxX)) / 2, y: (t.ty(b.minY) + t.ty(b.maxY)) / 2 };
}

// ================================================================
// 断面図の自動縮尺SVGレンダラ（パネルの構造リスト用）。
//
// mm単位のジオメトリ（sectionGeometry.js）を受け、枠(maxWidth×maxHeight)に
// 収まる1/10刻みの縮尺を選んでSVG描画する。寸法線・通り芯/柱芯・GL/FL線付き。
// editable な寸法(dim)は SVG の上にクリック可能な四角（値表示）を重ね、クリックで NumPad を
// 開いて入力する（onEditDim(dim, 数値) で確定値を親へ通知。MobX側の更新→再描画は呼び出し元が担う）。
// ================================================================

const TICK = 6;        // 寸法線端のチック長(px)
const AXIS_DASH = '6 3 2 3'; // 一点鎖線（通り芯・柱芯）
const COLOR = { stroke: '#334155', dim: '#2563eb', axis: '#94a3b8', concrete: '#cbd5e1', steel: '#475569' };

// study: 部材リスト配置検討モード。{ selectedId, onSelectId } を渡すと layoutId 単位でクリック選択でき、
// 選択中の要素群を矩形でハイライトする（移動は親が矢印キーで overrides を更新）。
// boundsPrimitives: 枠・倍率を決める基準プリミティブ（既定は primitives）。配置オフセットで枠や倍率がブレないよう
// “オフセット適用前”のジオメトリを渡す（位置調整は枠内で要素のみ動く）。
export function AutoScaledFigure({ primitives, boundsPrimitives, maxWidth = 320, maxHeight = 340, onEditDim, study = null, scale: scaleProp = null }) {
  // 倍率は基準ジオメトリ（移動前）で固定。配置検討では移動後を内包する和でキャンバスを広げ、欄外要素も
  // スクロールで追いかけられるようにする（倍率は不変・原点は和の最小＝負座標を作らない）。
  // scaleProp 指定時はその縮尺を使う（スクリーン空間注記：生成側が形状基準で決めた縮尺をそのまま使い、
  // 注記の隙間が px 一定になるよう仕込まれた図を、同じ縮尺で描く）。
  const baseBounds = figureBounds(boundsPrimitives ?? primitives);
  const scale = scaleProp ?? chooseScale(baseBounds.width, baseBounds.height, maxWidth, maxHeight);
  const frameBounds = study ? unionBounds(baseBounds, figureBounds(primitives)) : baseBounds;
  const t = makeTransform(frameBounds, scale);

  const scrollRef = useRef(null);

  // onEditDim が無い（read-only）ときは図上編集オーバーレイを出さず、寸法はSVGテキストで静的表示する。
  // 配置検討モード中は寸法編集オーバーレイ（クリックでNumPad）を出さない（クリック＝要素選択に使うため）。
  const interactive = !!onEditDim && !study;
  const editableDims = interactive ? primitives.filter(p => p.type === 'dim' && p.editable) : [];

  // 配置検討モード：選択中 layoutId のプリミティブ群の bbox（px）をハイライト矩形にする。
  const selPrims = study?.selectedId ? primitives.filter(p => p.layoutId === study.selectedId) : [];
  const selBox = selPrims.length > 0 ? figureBounds(selPrims) : null;

  // 選択中（または移動中）の要素が欄外なら、スクロールして中央へ寄せる＝欄外要素を追いかける。
  useEffect(() => {
    if (!study?.selectedId || !scrollRef.current) return;
    const c = selectedCenterPx(primitives, t, study.selectedId);
    if (!c) return;
    const el = scrollRef.current;
    const margin = 24;
    if (c.x < el.scrollLeft + margin || c.x > el.scrollLeft + el.clientWidth - margin) {
      el.scrollLeft = c.x - el.clientWidth / 2;
    }
    if (c.y < el.scrollTop + margin || c.y > el.scrollTop + el.clientHeight - margin) {
      el.scrollTop = c.y - el.clientHeight / 2;
    }
  }); // 毎レンダー（選択・移動の都度）追従

  const figureBody = (
    <div style={{ position: 'relative', width: t.pxWidth, height: t.pxHeight }}>
      <svg width={t.pxWidth} height={t.pxHeight} style={{ display: 'block' }}>
        {primitives.map((p, i) => {
          const el = renderPrimitive(p, i, t, interactive);
          if (study && p.layoutId) {
            const sel = p.layoutId === study.selectedId;
            return (
              <g key={i} onClick={e => { e.stopPropagation(); study.onSelectId(p.layoutId); }}
                 style={{ cursor: 'pointer' }} opacity={sel ? 1 : 0.9}>{el}</g>
            );
          }
          return el;
        })}
        {selBox && (
          <rect x={t.tx(selBox.minX) - 4} y={t.ty(selBox.minY) - 4}
            width={t.sx(selBox.width) + 8} height={t.sx(selBox.height) + 8}
            fill="none" stroke="#2563eb" strokeWidth={1.2} strokeDasharray="4 2" pointerEvents="none" />
        )}
        {/* 配置検討モード：各寸法の数値ラベルを線とは独立に選択・移動できるハンドル（破線枠）。 */}
        {study && dimLabelHandles(primitives, t, study)}
      </svg>
      {/* 縮尺ラベル */}
      <div style={{ position: 'absolute', right: 2, bottom: 0, fontSize: 10, color: '#94a3b8' }}>{scaleLabel(scale)}</div>
      {/* 図上の寸法編集（SVGテキストは編集不可のためHTMLを重ねる） */}
      {editableDims.map((dim, i) => (
        <EditableDimLabel key={`ed${i}`} dim={dim} t={t} onCommit={onEditDim} />
      ))}
    </div>
  );

  // 配置検討モードはスクロール可能な枠に収め、欄外へ逃げた要素を追いかけられるようにする。
  if (study) {
    return (
      <div ref={scrollRef} style={{ maxWidth, maxHeight, overflow: 'auto' }}>
        {figureBody}
      </div>
    );
  }
  return figureBody;
}

// 配置検討モード：各寸法の数値ラベル位置に、線とは独立に選択・移動できるハンドル（破線枠）を重ねる。
// ラベル位置は renderDim の静的テキストと同じ算式（labelDX/labelDY 反映済み）。
function dimLabelHandles(primitives, t, study) {
  return primitives.filter(p => p.type === 'dim' && p.layoutId).map((p, i) => {
    const isH = p.dir === 'h';
    const labelLeft = p.labelSide === 'left';
    const ldx = p.labelDX ? t.sx(p.labelDX) : 0;
    const ldy = p.labelDY ? t.sx(p.labelDY) : 0;
    const lx = (isH ? (t.tx(p.from) + t.tx(p.to)) / 2 : t.tx(p.at) + (labelLeft ? -8 : 8)) + ldx;
    const ly = (isH ? t.ty(p.at) - 8 : (t.ty(p.from) + t.ty(p.to)) / 2) + ldy;
    const id = `${p.layoutId}${LABEL_ID_SUFFIX}`;
    const sel = study.selectedId === id;
    const w = 30, h = 16;
    const bx = isH ? lx - w / 2 : (labelLeft ? lx - w : lx);
    return (
      <rect key={`lh${i}`} x={bx} y={ly - h / 2} width={w} height={h} rx={2}
        fill={sel ? 'rgba(37,99,235,0.18)' : 'transparent'}
        stroke={sel ? '#2563eb' : '#cbd5e1'} strokeWidth={1} strokeDasharray="3 2"
        style={{ cursor: 'pointer' }}
        onClick={e => { e.stopPropagation(); study.onSelectId(id); }} />
    );
  });
}

function renderPrimitive(p, key, t, interactive) {
  switch (p.type) {
    case 'rect': {
      const x = t.tx(p.x), y = t.ty(p.y), w = t.sx(p.w), h = t.sx(p.h);
      // rx(mm): 角丸半径（レバーハンドルのカプセル形等）。未指定時は従来どおり角丸なし。
      const rx = p.rx != null ? t.sx(p.rx) : undefined;
      return (
        <g key={key}>
          <rect x={x} y={y} width={w} height={h} rx={rx}
            fill={p.fill ?? 'none'} stroke={p.stroke ?? COLOR.stroke} strokeWidth={1} />
          {p.hatch === 'concrete' && concreteHatch(x, y, w, h, key)}
        </g>
      );
    }
    case 'circle':
      // rPx指定時は縮尺に関わらず常に同じpx半径で描く（交点マーカー等の目印用。実寸の丸はrをmmで指定）。
      return <circle key={key} cx={t.tx(p.cx)} cy={t.ty(p.cy)} r={p.rPx ?? t.sx(p.r)}
        fill={p.fill ?? 'none'} stroke={p.stroke ?? COLOR.stroke} strokeWidth={1} />;
    case 'line':
      return <line key={key} x1={t.tx(p.x1)} y1={t.ty(p.y1)} x2={t.tx(p.x2)} y2={t.ty(p.y2)}
        stroke={p.stroke ?? COLOR.stroke} strokeWidth={p.width ?? 1}
        strokeDasharray={p.dash === 'center' ? AXIS_DASH : p.dash === 'dashed' ? '4 3' : undefined} />;
    case 'polyline':
      return <polyline key={key} points={p.points.map(([x, y]) => `${t.tx(x)},${t.ty(y)}`).join(' ')}
        fill={p.closed ? (p.fill ?? 'none') : 'none'} stroke={p.stroke ?? COLOR.stroke} strokeWidth={1} />;
    case 'hSection':
      return renderHSection(p, key, t);
    case 'text':
      return <text key={key} x={t.tx(p.x)} y={t.ty(p.y)} fontSize={p.size ?? 11}
        textAnchor={p.anchor ?? 'middle'} dominantBaseline={p.baseline ?? 'alphabetic'} fill={p.fill ?? '#1e293b'}>{p.text}</text>;
    case 'arrow': {
      // 走行矢印（始点丸＋線／折れ線＋矢じり＋ラベル）。階段の模式図で U/D の昇り方向を示す。
      // points があれば折れ線U字矢印（折返し/回り階段）。なければ x1,y1→x2,y2 の直線。
      const flat = p.points ?? [p.x1, p.y1, p.x2, p.y2];
      const sx = [], sy = [];
      for (let i = 0; i < flat.length; i += 2) { sx.push(t.tx(flat[i])); sy.push(t.ty(flat[i + 1])); }
      const last = sx.length - 1;
      const x1 = sx[0], y1 = sy[0], x2 = sx[last], y2 = sy[last];
      const dx = x2 - sx[last - 1], dy = y2 - sy[last - 1], len = Math.hypot(dx, dy) || 1; // 最終区間で矢じり向き
      const ux = dx / len, uy = dy / len;          // 走行方向 単位
      const nx = -uy, ny = ux;                     // 法線 単位
      const HEAD = 6, SPREAD = 3;                  // 矢じり長・広がり(px)
      const hx = x2 - ux * HEAD, hy = y2 - uy * HEAD;
      const stroke = p.stroke ?? COLOR.stroke;
      const linePts = sx.map((x, i) => `${x},${sy[i]}`).join(' ');
      return (
        <g key={key} stroke={stroke} fill={stroke}>
          <circle cx={x1} cy={y1} r={1.6} />
          <polyline points={linePts} fill="none" strokeWidth={1} />
          <line x1={x2} y1={y2} x2={hx + nx * SPREAD} y2={hy + ny * SPREAD} strokeWidth={1} />
          <line x1={x2} y1={y2} x2={hx - nx * SPREAD} y2={hy - ny * SPREAD} strokeWidth={1} />
          {p.label && <text x={t.tx(p.labelX)} y={t.ty(p.labelY)} fontSize={10}
            textAnchor="middle" dominantBaseline="middle" stroke="none">{p.label}</text>}
        </g>
      );
    }
    case 'axisV': {
      // 通り芯/柱芯の一点鎖線（縦全域）。ラベルは呼び出し側が text プリミティブで mm 配置する
      // （px固定だと変位寸法と重なるため。位置制御を geometry 側へ委ねる）。
      const x = t.tx(p.x);
      return (
        <g key={key}>
          <line x1={x} y1={2} x2={x} y2={t.pxHeight} stroke={COLOR.axis} strokeWidth={1} strokeDasharray={AXIS_DASH} />
          {p.label && <text x={x} y={9} fontSize={10} textAnchor="middle" fill="#94a3b8">{p.label}</text>}
        </g>
      );
    }
    case 'levelLine': {
      const y = t.ty(p.y);
      return (
        <g key={key}>
          <line x1={FIGURE_X0} y1={y} x2={t.pxWidth} y2={y} stroke={COLOR.axis} strokeWidth={1} />
          {/* noLabel: ラベルを別の text プリミティブで持つ場合（GLを通り芯のように独立移動させる）は描かない。
              below: 線の下側から押さえるレベル記号（△CH等。既定は線の上側から▽）。 */}
          {!p.noLabel && (p.below
            ? <text x={FIGURE_X0} y={y + 11} fontSize={10} textAnchor="start" fill="#94a3b8">△{p.label}</text>
            : <text x={FIGURE_X0} y={y - 3} fontSize={10} textAnchor="start" fill="#94a3b8">▽{p.label}</text>)}
        </g>
      );
    }
    case 'dim':
      return renderDim(p, key, t, interactive);
    default:
      return null;
  }
}

const FIGURE_X0 = 2;

// 通り芯/柱芯（axisV）は図の縦全域に伸ばすため y1 既定値を 0 とする簡便化。
// （厳密な上端は呼び出し側が line で個別指定してもよい）
function renderHSection(p, key, t) {
  const x = t.tx(p.x), y = t.ty(p.y), w = t.sx(p.w), h = t.sx(p.h);
  const tf = Math.max(t.sx(p.flange), 1.2); // フランジ厚(px)
  const tw = Math.max(t.sx(p.web), 1.2);    // ウェブ厚(px)
  const fill = p.fill ?? COLOR.steel;
  return (
    <g key={key} fill={fill} stroke={fill}>
      <rect x={x} y={y} width={w} height={tf} />               {/* 上フランジ */}
      <rect x={x} y={y + h - tf} width={w} height={tf} />       {/* 下フランジ */}
      <rect x={x + w / 2 - tw / 2} y={y + tf} width={tw} height={Math.max(h - 2 * tf, 0)} /> {/* ウェブ */}
    </g>
  );
}

// RCコンクリートの簡易ハッチ（45°斜線）。clipPath で矩形内に限定。
function concreteHatch(x, y, w, h, key) {
  const id = `hatch-${key}`;
  const step = 6;
  const lines = [];
  for (let o = -h; o < w; o += step) {
    lines.push(<line key={o} x1={x + o} y1={y + h} x2={x + o + h} y2={y} stroke={COLOR.concrete} strokeWidth={0.6} />);
  }
  return (
    <g clipPath={`url(#${id})`}>
      <defs><clipPath id={id}><rect x={x} y={y} width={w} height={h} /></clipPath></defs>
      {lines}
    </g>
  );
}

// 寸法線（足 or チック端＋ラベル）。editable なものはラベルを EditableDimLabel が重ねるため
// ここではラベルを描かない（線・足/チックのみ）。
// 足（寸法補助線）＝寸法線から材まで。p.foot（材側の座標）がある寸法のみ描き、寸法線の
// 外側（材と反対方向）へは出さない。foot が無い寸法（通り芯⇄柱芯の変位量など）は従来のチック端。
function renderDim(p, key, t, interactive) {
  const isH = p.dir === 'h';
  const labelLeft = p.labelSide === 'left';
  const a = isH ? { x1: t.tx(p.from), y1: t.ty(p.at), x2: t.tx(p.to), y2: t.ty(p.at) }
                : { x1: t.tx(p.at), y1: t.ty(p.from), x2: t.tx(p.at), y2: t.ty(p.to) };
  const hasFoot = p.foot != null;
  let feet = [];
  if (hasFoot) {
    // footLen(mm) 指定時は足を一定長で描く（寸法線を断面から離しても足は伸ばさず、材との間に空きを作る）。
    // 未指定時は従来どおり「材側1/3を空けて寸法線側2/3だけ引く」比率方式。
    const footPx = p.footLen != null ? t.sx(p.footLen) : null;
    // 足の開始点（寸法線→材方向へ length だけ。材を越えない範囲）。
    const start = (dimPx, matPx) => {
      if (footPx == null) return matPx + (dimPx - matPx) * (1 / 3);
      const dir = Math.sign(dimPx - matPx) || 1; // 材→寸法線の向き
      const s = dimPx - dir * footPx;
      return dir > 0 ? Math.max(s, matPx) : Math.min(s, matPx); // 材を越えない
    };
    if (isH) {
      const footY = t.ty(p.foot);
      feet = [
        [a.x1, start(a.y1, footY), a.x1, a.y1],
        [a.x2, start(a.y2, footY), a.x2, a.y2],
      ];
    } else {
      const footX = t.tx(p.foot);
      feet = [
        [start(a.x1, footX), a.y1, a.x1, a.y1],
        [start(a.x2, footX), a.y2, a.x2, a.y2],
      ];
    }
  }
  const ticks = (hasFoot || p.noTick) ? [] : (isH
    ? [[a.x1, a.y1 - TICK, a.x1, a.y1 + TICK], [a.x2, a.y2 - TICK, a.x2, a.y2 + TICK]]
    : [[a.x1 - TICK, a.y1, a.x1 + TICK, a.y1], [a.x2 - TICK, a.y2, a.x2 + TICK, a.y2]]);
  // labelVertical: 縦寸法の値を-90度回転（文字の天が画面左向き＝下から上へ読む）で寸法線上に描く。
  const vlx = a.x1 + (p.labelDX ? t.sx(p.labelDX) : 0);
  const vly = (a.y1 + a.y2) / 2 + (p.labelDY ? t.sx(p.labelDY) : 0);
  return (
    <g key={key} stroke={COLOR.dim}>
      <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} strokeWidth={1} />
      {ticks.map((tk, i) => <line key={`t${i}`} x1={tk[0]} y1={tk[1]} x2={tk[2]} y2={tk[3]} strokeWidth={1} />)}
      {feet.map((tk, i) => <line key={`f${i}`} x1={tk[0]} y1={tk[1]} x2={tk[2]} y2={tk[3]} strokeWidth={1} />)}
      {/* dot: 寸法線端（足との交点）の塗りつぶし丸端末記号 */}
      {p.dot && <circle cx={a.x1} cy={a.y1} r={2} fill={COLOR.dim} stroke="none" />}
      {p.dot && <circle cx={a.x2} cy={a.y2} r={2} fill={COLOR.dim} stroke="none" />}
      {/* 編集オーバーレイが出るのは editable かつ interactive のときのみ。それ以外は静的テキスト。
          数値ラベルは labelDX/labelDY(mm) だけ線から独立に動かせる（配置検討モードの ::label オフセット）。 */}
      {!(p.editable && interactive) && (
        p.labelVertical && !isH ? (
          <text x={vlx} y={vly} transform={`rotate(-90 ${vlx} ${vly})`}
            fontSize={11} textAnchor="middle" dominantBaseline="middle" fill={COLOR.dim} stroke="none">
            {p.label}
          </text>
        ) : (
          <text
            x={(isH ? (a.x1 + a.x2) / 2 : (labelLeft ? a.x1 - 8 : a.x1 + 8)) + (p.labelDX ? t.sx(p.labelDX) : 0)}
            y={(isH ? a.y1 - 8 : (a.y1 + a.y2) / 2) + (p.labelDY ? t.sx(p.labelDY) : 0)}
            fontSize={11} textAnchor={isH ? 'middle' : (labelLeft ? 'end' : 'start')} dominantBaseline="middle" fill={COLOR.dim} stroke="none">
            {p.label}
          </text>
        )
      )}
    </g>
  );
}

// 図上の編集可能な寸法ラベル。クリック可を示す四角の中に値を表示し、クリックで NumPad を開いて入力する。
function EditableDimLabel({ dim, t, onCommit }) {
  const isH = dim.dir === 'h';
  const labelLeft = dim.labelSide === 'left';
  const ldx = dim.labelDX ? t.sx(dim.labelDX) : 0;
  const ldy = dim.labelDY ? t.sx(dim.labelDY) : 0;
  const px = (isH ? t.tx((dim.from + dim.to) / 2) : t.tx(dim.at) + (labelLeft ? -6 : 6)) + ldx;
  const py = (isH ? t.ty(dim.at) - 19 : t.ty((dim.from + dim.to) / 2) - 8) + ldy;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // 編集開始時に最新値を draft へ取り込む（effectでの同期を避け cascading render を防ぐ）。
  function startEdit() { setDraft(String(dim.label ?? '')); setEditing(true); }

  function commit() {
    setEditing(false);
    const v = Number(draft);
    if (!Number.isNaN(v) && onCommit) onCommit(dim, v);
  }

  // 横方向の寸法値は線の中央に重ねるが、縦方向は線と重ならないよう左右どちらかへ片寄せする
  // （labelSide:'left' なら寸法線の左へ、既定では右へ。translateX(-50%)中央寄せでは線を跨いでしまうため）。
  const transform = isH ? 'translateX(-50%)' : (labelLeft ? 'translateX(-100%)' : 'translateX(0)');

  return (
    <>
      <button
        type="button"
        onClick={startEdit}
        title="クリックで編集"
        style={{
          position: 'absolute', left: px, top: py, transform,
          fontSize: 11, lineHeight: 1.4, color: '#2563eb', whiteSpace: 'nowrap',
          background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: 3,
          padding: '1px 4px', cursor: 'pointer',
        }}
      >
        {dim.label}
      </button>
      {editing && (
        <NumPad
          value={draft}
          label="寸法"
          onChange={setDraft}
          onConfirm={commit}
          onCancel={() => setEditing(false)}
          keyboard
          cancelOnOutside
          selectOnStart
        />
      )}
    </>
  );
}
