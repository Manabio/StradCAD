import { useState } from 'react';
import { figureBounds, chooseScale, scaleLabel, makeTransform } from './sectionGeometry.js';
import { NumPad } from '../../ui/NumPad.jsx';

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

export function AutoScaledFigure({ primitives, maxWidth = 320, maxHeight = 340, onEditDim }) {
  const bounds = figureBounds(primitives);
  const scale = chooseScale(bounds.width, bounds.height, maxWidth, maxHeight);
  const t = makeTransform(bounds, scale);

  // onEditDim が無い（read-only）ときは図上編集オーバーレイを出さず、寸法はSVGテキストで静的表示する。
  const interactive = !!onEditDim;
  const editableDims = interactive ? primitives.filter(p => p.type === 'dim' && p.editable) : [];

  return (
    <div style={{ position: 'relative', width: t.pxWidth, height: t.pxHeight }}>
      <svg width={t.pxWidth} height={t.pxHeight} style={{ display: 'block' }}>
        {primitives.map((p, i) => renderPrimitive(p, i, t, interactive))}
      </svg>
      {/* 縮尺ラベル */}
      <div style={{ position: 'absolute', right: 2, bottom: 0, fontSize: 10, color: '#94a3b8' }}>{scaleLabel(scale)}</div>
      {/* 図上の寸法編集（SVGテキストは編集不可のためHTMLを重ねる） */}
      {editableDims.map((dim, i) => (
        <EditableDimLabel key={`ed${i}`} dim={dim} t={t} onCommit={onEditDim} />
      ))}
    </div>
  );
}

function renderPrimitive(p, key, t, interactive) {
  switch (p.type) {
    case 'rect': {
      const x = t.tx(p.x), y = t.ty(p.y), w = t.sx(p.w), h = t.sx(p.h);
      return (
        <g key={key}>
          <rect x={x} y={y} width={w} height={h}
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
          <text x={FIGURE_X0} y={y - 3} fontSize={10} textAnchor="start" fill="#94a3b8">▽{p.label}</text>
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
    // 材に足が接すると見づらいため、材側1/3を空けて寸法線側2/3だけ引く（材から離す）。
    const FOOT_GAP = 1 / 3;
    if (isH) {
      const footY = t.ty(p.foot);
      feet = [
        [a.x1, footY + (a.y1 - footY) * FOOT_GAP, a.x1, a.y1],
        [a.x2, footY + (a.y2 - footY) * FOOT_GAP, a.x2, a.y2],
      ];
    } else {
      const footX = t.tx(p.foot);
      feet = [
        [footX + (a.x1 - footX) * FOOT_GAP, a.y1, a.x1, a.y1],
        [footX + (a.x2 - footX) * FOOT_GAP, a.y2, a.x2, a.y2],
      ];
    }
  }
  const ticks = (hasFoot || p.noTick) ? [] : (isH
    ? [[a.x1, a.y1 - TICK, a.x1, a.y1 + TICK], [a.x2, a.y2 - TICK, a.x2, a.y2 + TICK]]
    : [[a.x1 - TICK, a.y1, a.x1 + TICK, a.y1], [a.x2 - TICK, a.y2, a.x2 + TICK, a.y2]]);
  return (
    <g key={key} stroke={COLOR.dim}>
      <line x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} strokeWidth={1} />
      {ticks.map((tk, i) => <line key={`t${i}`} x1={tk[0]} y1={tk[1]} x2={tk[2]} y2={tk[3]} strokeWidth={1} />)}
      {feet.map((tk, i) => <line key={`f${i}`} x1={tk[0]} y1={tk[1]} x2={tk[2]} y2={tk[3]} strokeWidth={1} />)}
      {/* 編集オーバーレイが出るのは editable かつ interactive のときのみ。それ以外は静的テキスト。 */}
      {!(p.editable && interactive) && (
        <text
          x={isH ? (a.x1 + a.x2) / 2 : (labelLeft ? a.x1 - 8 : a.x1 + 8)}
          y={isH ? a.y1 - 8 : (a.y1 + a.y2) / 2}
          fontSize={11} textAnchor={isH ? 'middle' : (labelLeft ? 'end' : 'start')} dominantBaseline="middle" fill={COLOR.dim} stroke="none">
          {p.label}
        </text>
      )}
    </g>
  );
}

// 図上の編集可能な寸法ラベル。クリック可を示す四角の中に値を表示し、クリックで NumPad を開いて入力する。
function EditableDimLabel({ dim, t, onCommit }) {
  const isH = dim.dir === 'h';
  const labelLeft = dim.labelSide === 'left';
  const px = isH ? t.tx((dim.from + dim.to) / 2) : t.tx(dim.at) + (labelLeft ? -6 : 6);
  const py = isH ? t.ty(dim.at) - 19 : t.ty((dim.from + dim.to) / 2) - 8;
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
        />
      )}
    </>
  );
}
