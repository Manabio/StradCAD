// ================================================================
// 部分詳細図（DetailFigure）のデータ形の検証・正規化（純関数）。
//
// import は ../core/constants.js だけ（catalog/ が静的に引ける葉。catalog/catalogImports.test.js で固定）。
// 検証は例外にせず、理由を列挙して返す。形は 問題0.md §3 のとおり:
//   DetailFigure = { key, version, label, category, view, subject, strokes[], datums[], anchors[], provenance, note }
//   Stroke = { id, moves[], closed, line:{weightRole, dashRole} }
//   Move   = { dir:'U'|'D'|'L'|'R', len:LenSpec, edge? } | { dir:'V', dx:LenSpec, dy:LenSpec, ss?:1|-1, st?:1|-1, edge? }
//            'V' の ss は s 軸・st は t 軸の向き（省略時 +1。normalize が埋める）。dx/dy の mm は正のみ。
//            edge は DetailEdgeMark（'air'＝空気との境目。S8a）。印なしはキーを持たない（normalize は足さない）。
//   Datum  = { id, role, axis, kind, offsetMm }   Anchor = { datumId, strokeId, vertexIndex, offsetMm? }
//   Anchor.offsetMm は「頂点の位置＝基準の目標＋Datum.offsetMm＋Anchor.offsetMm」の第 3 項（既定 0。位置関係を保って写すため）。
//   normalize は offsetMm のキーを足さない（持たない図のバイト・比較を変えない）。
//   views（任意）= { front?, back?, left?, right?, ceiling? }（値＝別の詳細図キー）。平面の姿図（FIGURE・PLAN・PLACED_FIGURE_SUBJECTS）だけが持てる。
//   ここでは形だけ検証する（実在・分類の一致はカタログ層）。normalize は views のキーを足さない。
// closed の規約: 閉じ辺は描画側が補う。始点へ戻る手は書かない（mm で歩いた終点が始点に一致する closed は CLOSED_RETURNS_TO_START）。
// 既知の限界: CLOSED_RETURNS_TO_START は LenSpec.mm（プレビュー値）で判定する。param・material・stretch の closed は
// fit で解決した値では閉じ辺が 0 になる（またはならない）ことがあり、登録時には検出しない。
// 既知の限界: 寸法は 1 手（Move）の長さ単位。複数手にまたがる寸法は表せない。
// ================================================================

import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumKind, DetailAxis,
  DetailDatumRole, DetailParam, DetailMaterialField, DetailDash, DetailEdgeMark, DETAIL_VIEW_COMBOS,
  DetailPlacementView, PLACED_FIGURE_SUBJECTS, DETAIL_VIEWS_FIELD,
  DETAIL_FIGURE_VERSION, LINE_WEIGHT_MM, DETAIL_DEFAULT_WEIGHT_ROLE, DETAIL_FIT_EPS_MM,
  FittingPartRole, FITTING_PART_TARGETS, FITTING_PART_KEY_SEPARATOR,
} from '../core/constants.js';

/** 検証エラーの種類（detail/ 内部の語彙）。 */
export const DetailValidationError = Object.freeze({
  SHAPE:                   'shape',                // オブジェクト・配列・文字列などの型が違う
  VERSION:                 'version',              // version が DETAIL_FIGURE_VERSION でない
  EMPTY_KEY:               'emptyKey',             // key / id が空
  DUPLICATE_ID:            'duplicateId',          // stroke id・datum id の重複
  UNKNOWN_CATEGORY:        'unknownCategory',
  UNKNOWN_VIEW:            'unknownView',
  UNKNOWN_SUBJECT:         'unknownSubject',
  BAD_COMBO:               'badCombo',             // (category, view, subject) が組合せ表に無い
  UNKNOWN_DIR:             'unknownDir',
  UNKNOWN_MODE:            'unknownMode',
  UNKNOWN_PARAM:           'unknownParam',
  UNKNOWN_MATERIAL_FIELD:  'unknownMaterialField',
  BAD_MATERIAL_CODE:       'badMaterialCode',
  UNKNOWN_ROLE:            'unknownRole',
  UNKNOWN_KIND:            'unknownKind',
  UNKNOWN_AXIS:            'unknownAxis',
  UNKNOWN_WEIGHT:          'unknownWeight',
  UNKNOWN_DASH:            'unknownDash',
  BAD_LENGTH:              'badLength',            // mm が有限かつ正でない
  BAD_OFFSET:              'badOffset',            // Datum.offsetMm・Anchor.offsetMm（キーがあるとき）が有限でない
  NO_STROKES:              'noStrokes',
  EMPTY_MOVES:             'emptyMoves',
  CLOSED_TOO_FEW:          'closedTooFew',         // closed なのに頂点が 2 以下
  CLOSED_RETURNS_TO_START: 'closedReturnsToStart', // closed なのに mm で歩いた終点が始点に一致（閉じ辺は描画側が補う）
  BAD_VECTOR_SIGN:         'badVectorSign',        // 'V' の ss / st が 1 か -1 でない
  UNKNOWN_EDGE_MARK:       'unknownEdgeMark',      // Move.edge が未知の印（印なし＝キーが無い。S8a）
  ANCHOR_DATUM_MISSING:    'anchorDatumMissing',
  ANCHOR_STROKE_MISSING:   'anchorStrokeMissing',
  ANCHOR_VERTEX_MISSING:   'anchorVertexMissing',
  NO_ORIGIN_ANCHOR:        'noOriginAnchor',       // ストロークが軸の origin Anchor を持たない
  DUPLICATE_ANCHOR:        'duplicateAnchor',      // 同じストローク・軸・kind の Anchor が 2 つ以上
  ORIGIN_DATUM_COUNT:      'originDatumCount',     // origin の Datum が軸ごとに 1 つでない
  END_DATUM_COUNT:         'endDatumCount',        // end の Datum が軸ごとに 2 つ以上
  END_DATUM_UNUSED:        'endDatumUnused',       // end の Datum をどのストロークも Anchor にしていない
  STRETCH_COUNT:           'stretchCount',         // end の Anchor を持つストロークの stretch が軸ごとに 1 本でない
  STRETCH_WITHOUT_END:     'stretchWithoutEnd',    // stretch があるのに end の Anchor が無い
  STRETCH_OUT_OF_SPAN:     'stretchOutOfSpan',     // stretch の手が origin〜end の頂点の間に無い
  BAD_VIEWS:               'badViews',             // views の形・キー・値が不正、または views を持てない分類（読める図なので SUPPORT_BLOCKING には入れない）
  PARTS_EMPTY:             'partsEmpty',           // 建具一式の parts が 0 個（読める図）
  PART_DUPLICATE:          'partDuplicate',        // 建具一式の部品の id・role の重複（読める図）
  PART_UNKNOWN_ROLE:       'partUnknownRole',      // 建具一式の部品の role が語彙に無い（未知の語彙＝読めない図）
  PART_BAD_TARGET:         'partBadTarget',        // 部品本体の (category, view, subject) が role の表と違う（読める図）
  BAD_KEY_CHAR:            'badKeyChar',           // key に合成キーの区切り '#' を含む（読めないキー）
});
const E = DetailValidationError;

/** views を持てる分類か（平面の姿図＝FIGURE・PLAN・PLACED_FIGURE_SUBJECTS）。 */
export function canHaveDetailViews(fig) {
  return fig?.category === DetailCategory.FIGURE && fig.view === DetailView.PLAN && PLACED_FIGURE_SUBJECTS.includes(fig.subject);
}

const AXES = Object.freeze([DetailAxis.S, DetailAxis.T]);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEnum = (en, v) => Object.values(en).includes(v);
const isNonEmptyString = v => typeof v === 'string' && v.length > 0;
const asArray = v => (Array.isArray(v) ? v : []);

/**
 * 手 1 つが動かす (軸, 符号, LenSpec) の列。未知の dir・形が違うときは null。
 * U=t−・D=t+・L=s−・R=s+・V=(dx:ss 向き, dy:st 向き。省略時 +1)。
 */
export function moveParts(move) {
  if (!isObj(move)) return null;
  switch (move.dir) {
    case PenDir.UP:     return [{ axis: DetailAxis.T, sign: -1, len: move.len }];
    case PenDir.DOWN:   return [{ axis: DetailAxis.T, sign: 1, len: move.len }];
    case PenDir.LEFT:   return [{ axis: DetailAxis.S, sign: -1, len: move.len }];
    case PenDir.RIGHT:  return [{ axis: DetailAxis.S, sign: 1, len: move.len }];
    case PenDir.VECTOR: return [
      { axis: DetailAxis.S, sign: move.ss ?? 1, len: move.dx },
      { axis: DetailAxis.T, sign: move.st ?? 1, len: move.dy },
    ];
    default:            return null;
  }
}

/** ストロークの、指定軸にある stretch の部分 [{moveIndex, sign, len}]。 */
export function stretchPartsOf(stroke, axis) {
  const out = [];
  asArray(stroke?.moves).forEach((move, moveIndex) => {
    for (const p of moveParts(move) ?? []) {
      if (p.axis === axis && isObj(p.len) && p.len.mode === DetailLenMode.STRETCH) out.push({ moveIndex, sign: p.sign, len: p.len });
    }
  });
  return out;
}

/** 図の本体（strokes・datums・anchors）の既定値を埋める。label・provenance・note は足さない（建具一式の部品の figure にも使う）。 */
function normalizeBody(f) {
  return {
    ...f,
    strokes: asArray(f.strokes).map(s => {
      if (!isObj(s)) return s;
      return {
        ...s,
        moves: asArray(s.moves).map(m => (isObj(m) && m.dir === PenDir.VECTOR ? { ...m, ss: m.ss ?? 1, st: m.st ?? 1 } : m)),
        closed: s.closed ?? false,
        line: s.line == null
          ? { weightRole: DETAIL_DEFAULT_WEIGHT_ROLE, dashRole: DetailDash.SOLID }
          : isObj(s.line)
            ? { weightRole: s.line.weightRole ?? DETAIL_DEFAULT_WEIGHT_ROLE, dashRole: s.line.dashRole ?? DetailDash.SOLID }
            : s.line, // オブジェクトでない値はそのまま残し、検証（SHAPE）で弾く
      };
    }),
    datums: asArray(f.datums).map(d => (isObj(d) ? { ...d, offsetMm: d.offsetMm ?? 0 } : d)),
    anchors: asArray(f.anchors),
  };
}

/**
 * 省略可能な項目の既定値を埋める。形が壊れていても例外にしない（壊れた値はそのまま残して検証に任せる）。
 * parts（建具一式の部品）は配列のときだけ、各部品の figure の本体を埋める（label・provenance・note は足さない。parts の無い図にキーを足さない）。
 */
export function normalizeDetailFigure(plain) {
  const f = isObj(plain) ? plain : {};
  const body = normalizeBody(f);
  return {
    ...f,
    label: f.label ?? '',
    strokes: body.strokes,
    datums: body.datums,
    anchors: body.anchors,
    provenance: f.provenance ?? null,
    note: f.note ?? null,
    ...(Array.isArray(f.parts)
      ? { parts: f.parts.map(p => (isObj(p) ? { ...p, figure: isObj(p.figure) ? normalizeBody(p.figure) : p.figure } : p)) }
      : {}),
  };
}

/** 全手を LenSpec.mm（プレビュー値）で歩いた終点 {s, t}。dir が未知・mm が数値でない／非有限・符号が非有限なら null
 *  （0 や負の mm はそのまま歩き、BAD_LENGTH が別に出る）。 */
function walkEndByMm(moves) {
  let s = 0;
  let t = 0;
  for (const m of moves) {
    const parts = moveParts(m);
    if (parts === null) return null;
    for (const p of parts) {
      const mm = p.len?.mm;
      if (typeof mm !== 'number' || !Number.isFinite(mm) || !Number.isFinite(p.sign)) return null;
      if (p.axis === DetailAxis.S) s += p.sign * mm; else t += p.sign * mm;
    }
  }
  return { s, t };
}

function checkLen(len, path, push) {
  if (!isObj(len)) { push(E.SHAPE, 'LenSpec がオブジェクトでない', path); return; }
  if (!isEnum(DetailLenMode, len.mode)) push(E.UNKNOWN_MODE, `未知の mode: ${String(len.mode)}`, path);
  if (typeof len.mm !== 'number' || !Number.isFinite(len.mm) || len.mm <= 0) push(E.BAD_LENGTH, `mm が有限かつ正でない: ${String(len.mm)}`, path);
  if (len.mode === DetailLenMode.PARAM && !isEnum(DetailParam, len.param)) push(E.UNKNOWN_PARAM, `未知の param: ${String(len.param)}`, path);
  if (len.mode === DetailLenMode.MATERIAL) {
    if (!isNonEmptyString(len.code)) push(E.BAD_MATERIAL_CODE, 'material の code が空', path);
    if (!isEnum(DetailMaterialField, len.field)) push(E.UNKNOWN_MATERIAL_FIELD, `未知の material field: ${String(len.field)}`, path);
  }
}

/**
 * 建具一式の検証（最上位の形と部品）。部品本体は合成キー '<key>#<role>' の図として validateDetailFigure で検査し、path に parts[i].figure. を前置する。
 * 戻り値は errors に積むだけ（push を受け取る）。
 */
function validateFittingSet(fig, input, push) {
  const isEmptyList = v => v == null || (Array.isArray(v) && v.length === 0);
  if (!isEmptyList(input.strokes) || !isEmptyList(input.datums) || !isEmptyList(input.anchors)) {
    push(E.SHAPE, '建具一式の最上位に strokes・datums・anchors は持てない（部品が持つ）', 'strokes');
  }
  if (fig[DETAIL_VIEWS_FIELD] != null) push(E.BAD_VIEWS, '建具一式は views を持てない', DETAIL_VIEWS_FIELD);
  if (!Array.isArray(fig.parts)) { push(E.SHAPE, 'parts が配列でない', 'parts'); return; }
  if (fig.parts.length === 0) { push(E.PARTS_EMPTY, '部品が 0 個', 'parts'); return; }
  const ids = new Set();
  const roles = new Set();
  fig.parts.forEach((part, i) => {
    const pp = `parts[${i}]`;
    if (!isObj(part)) { push(E.SHAPE, '部品がオブジェクトでない', pp); return; }
    if (!isNonEmptyString(part.id)) push(E.EMPTY_KEY, '部品の id が空', `${pp}.id`);
    else if (ids.has(part.id)) push(E.PART_DUPLICATE, `部品の id が重複: ${part.id}`, `${pp}.id`);
    else ids.add(part.id);
    const roleOk = isEnum(FittingPartRole, part.role);
    if (!roleOk) push(E.PART_UNKNOWN_ROLE, `未知の部品の role: ${String(part.role)}`, `${pp}.role`);
    else if (roles.has(part.role)) push(E.PART_DUPLICATE, `部品の role が重複: ${part.role}`, `${pp}.role`);
    else roles.add(part.role);
    if (!isObj(part.figure)) { push(E.SHAPE, '部品の figure がオブジェクトでない', `${pp}.figure`); return; }
    if (roleOk) {
      const want = FITTING_PART_TARGETS[part.role];
      const f = part.figure;
      if (f.category !== want.category || f.view !== want.view || f.subject !== want.subject) {
        push(E.PART_BAD_TARGET, `部品 ${part.role} の分類が (${want.category}, ${want.view}, ${want.subject}) でない: (${String(f.category)}, ${String(f.view)}, ${String(f.subject)})`, `${pp}.figure`);
      }
    }
    const body = validateDetailFigure(
      { key: `${String(fig.key)}${FITTING_PART_KEY_SEPARATOR}${String(part.role)}`, version: fig.version, label: '', ...part.figure },
    );
    for (const e of body.errors) push(e.code, e.message, `${pp}.figure.${e.path ?? ''}`.replace(/\.$/, ''));
  });
}

/** 検証。{ ok, errors:[{code, message, path?}] }。例外にしない。 */
export function validateDetailFigure(input) {
  const errors = [];
  const push = (code, message, path) => errors.push(path === undefined ? { code, message } : { code, message, path });
  if (!isObj(input)) {
    push(E.SHAPE, 'DetailFigure がオブジェクトでない');
    return { ok: false, errors };
  }
  const fig = normalizeDetailFigure(input);

  if (fig.version !== DETAIL_FIGURE_VERSION) push(E.VERSION, `version が ${DETAIL_FIGURE_VERSION} でない: ${String(fig.version)}`, 'version');
  if (!isNonEmptyString(fig.key)) push(E.EMPTY_KEY, 'key が空', 'key');
  else if (fig.key.includes(FITTING_PART_KEY_SEPARATOR)
    // 例外: 建具一式の部品から作った単独の図（fittingPartFigure・部品本体の検査。key が '<一式のキー>#<role>'）は fit に渡すので通す
    && !(fig.category !== DetailCategory.FITTING && parseFittingPartKey(fig.key) !== null)) {
    push(E.BAD_KEY_CHAR, `key に ${FITTING_PART_KEY_SEPARATOR} は使えない（建具一式の部品を指す合成キーの区切り）: ${fig.key}`, 'key');
  }
  const catOk = isEnum(DetailCategory, fig.category);
  const viewOk = isEnum(DetailView, fig.view);
  const subOk = isEnum(DetailSubject, fig.subject);
  if (!catOk) push(E.UNKNOWN_CATEGORY, `未知の category: ${String(fig.category)}`, 'category');
  if (!viewOk) push(E.UNKNOWN_VIEW, `未知の view: ${String(fig.view)}`, 'view');
  if (!subOk) push(E.UNKNOWN_SUBJECT, `未知の subject: ${String(fig.subject)}`, 'subject');
  if (catOk && viewOk && subOk && !DETAIL_VIEW_COMBOS.some(c => c.category === fig.category && c.view === fig.view && c.subject === fig.subject)) {
    push(E.BAD_COMBO, `組合せ表に無い (${fig.category}, ${fig.view}, ${fig.subject})`, 'category');
  }
  // 建具一式は最上位に形を持たない（strokes 無し・基準無し）。以降の本体の検査は部品ごとに validateFittingSet が行う
  if (fig.category === DetailCategory.FITTING) {
    validateFittingSet(fig, input, push);
    return { ok: errors.length === 0, errors };
  }

  // ---- views（平面の姿図だけが持てる。壊れていても図自体は読める＝SUPPORT_BLOCKING に入れない）----
  const views = fig[DETAIL_VIEWS_FIELD];
  // null は省略と同値（リポジトリの規約）
  if (views != null) {
    if (!canHaveDetailViews(fig)) push(E.BAD_VIEWS, `views を持てない分類 (${String(fig.category)}, ${String(fig.view)}, ${String(fig.subject)})`, DETAIL_VIEWS_FIELD);
    if (!isObj(views)) push(E.BAD_VIEWS, 'views がオブジェクトでない', DETAIL_VIEWS_FIELD);
    else {
      for (const [name, value] of Object.entries(views)) {
        if (!isEnum(DetailPlacementView, name)) push(E.BAD_VIEWS, `未知の views のキー: ${name}`, `${DETAIL_VIEWS_FIELD}.${name}`);
        else if (!isNonEmptyString(value)) push(E.BAD_VIEWS, `views の値が非空文字列でない: ${String(value)}`, `${DETAIL_VIEWS_FIELD}.${name}`);
        else if (value === fig.key) push(E.BAD_VIEWS, `views が自分自身を指している: ${name}`, `${DETAIL_VIEWS_FIELD}.${name}`);
      }
    }
  }

  // ---- ストローク ----
  if (!Array.isArray(input.strokes) && input.strokes !== undefined) push(E.SHAPE, 'strokes が配列でない', 'strokes');
  if (fig.strokes.length === 0) push(E.NO_STROKES, 'ストロークが 0 本', 'strokes');
  const strokeById = new Map();
  fig.strokes.forEach((s, si) => {
    const sp = `strokes[${si}]`;
    if (!isObj(s)) { push(E.SHAPE, 'Stroke がオブジェクトでない', sp); return; }
    if (!isNonEmptyString(s.id)) push(E.EMPTY_KEY, 'stroke id が空', `${sp}.id`);
    else if (strokeById.has(s.id)) push(E.DUPLICATE_ID, `stroke id が重複: ${s.id}`, `${sp}.id`);
    else strokeById.set(s.id, s);
    if (typeof s.closed !== 'boolean') push(E.SHAPE, 'closed が真偽値でない', `${sp}.closed`);
    if (s.moves.length === 0) push(E.EMPTY_MOVES, '手が 0 個', `${sp}.moves`);
    if (s.closed === true && s.moves.length + 1 <= 2) push(E.CLOSED_TOO_FEW, `closed なのに頂点が ${s.moves.length + 1} 個`, sp);
    if (s.closed === true && s.moves.length + 1 > 2) {
      const end = walkEndByMm(s.moves);
      if (end && Math.abs(end.s) <= DETAIL_FIT_EPS_MM && Math.abs(end.t) <= DETAIL_FIT_EPS_MM) {
        push(E.CLOSED_RETURNS_TO_START, 'closed なのに終点が始点に一致（閉じ辺は描画側が補うので、始点へ戻る手は書かない）', sp);
      }
    }
    if (!isObj(s.line)) push(E.SHAPE, 'line がオブジェクトでない', `${sp}.line`);
    else {
      if (!Object.hasOwn(LINE_WEIGHT_MM, s.line.weightRole)) push(E.UNKNOWN_WEIGHT, `未知の weightRole: ${String(s.line.weightRole)}`, `${sp}.line.weightRole`);
      if (!isEnum(DetailDash, s.line.dashRole)) push(E.UNKNOWN_DASH, `未知の dashRole: ${String(s.line.dashRole)}`, `${sp}.line.dashRole`);
    }
    s.moves.forEach((m, mi) => {
      const mp = `${sp}.moves[${mi}]`;
      if (!isObj(m)) { push(E.SHAPE, 'Move がオブジェクトでない', mp); return; }
      const parts = moveParts(m);
      if (parts === null) { push(E.UNKNOWN_DIR, `未知の dir: ${String(m.dir)}`, `${mp}.dir`); return; }
      if (Object.hasOwn(m, 'edge') && !isEnum(DetailEdgeMark, m.edge)) {
        push(E.UNKNOWN_EDGE_MARK, `未知の edge: ${String(m.edge)}`, `${mp}.edge`);
      }
      if (m.dir === PenDir.VECTOR) {
        for (const key of ['ss', 'st']) {
          if (m[key] !== 1 && m[key] !== -1) push(E.BAD_VECTOR_SIGN, `${key} が 1 か -1 でない: ${String(m[key])}`, `${mp}.${key}`);
        }
      }
      parts.forEach(p => checkLen(p.len, m.dir === PenDir.VECTOR ? `${mp}.${p.axis === DetailAxis.S ? 'dx' : 'dy'}` : `${mp}.len`, push));
    });
  });

  // ---- 基準 ----
  const datumById = new Map();
  fig.datums.forEach((d, di) => {
    const dp = `datums[${di}]`;
    if (!isObj(d)) { push(E.SHAPE, 'Datum がオブジェクトでない', dp); return; }
    if (!isNonEmptyString(d.id)) push(E.EMPTY_KEY, 'datum id が空', `${dp}.id`);
    else if (datumById.has(d.id)) push(E.DUPLICATE_ID, `datum id が重複: ${d.id}`, `${dp}.id`);
    else datumById.set(d.id, d);
    if (!isEnum(DetailDatumRole, d.role)) push(E.UNKNOWN_ROLE, `未知の role: ${String(d.role)}`, `${dp}.role`);
    if (!isEnum(DetailAxis, d.axis)) push(E.UNKNOWN_AXIS, `未知の axis: ${String(d.axis)}`, `${dp}.axis`);
    if (!isEnum(DetailDatumKind, d.kind)) push(E.UNKNOWN_KIND, `未知の kind: ${String(d.kind)}`, `${dp}.kind`);
    if (typeof d.offsetMm !== 'number' || !Number.isFinite(d.offsetMm)) push(E.BAD_OFFSET, `offsetMm が有限でない: ${String(d.offsetMm)}`, `${dp}.offsetMm`);
  });
  const datumsOn = (axis, kind) => fig.datums.filter(d => isObj(d) && d.axis === axis && d.kind === kind);
  for (const axis of AXES) {
    const n = datumsOn(axis, DetailDatumKind.ORIGIN).length;
    if (n !== 1) push(E.ORIGIN_DATUM_COUNT, `軸 ${axis} の origin の Datum が ${n} 個（1 つ必要）`, 'datums');
    const ne = datumsOn(axis, DetailDatumKind.END).length;
    if (ne > 1) push(E.END_DATUM_COUNT, `軸 ${axis} の end の Datum が ${ne} 個（1 つまで）`, 'datums');
  }

  // ---- Anchor ----
  // stroke id → 軸 → kind → [vertexIndex]。参照が揃った Anchor だけ集める。
  const found = new Map();
  fig.anchors.forEach((a, ai) => {
    const ap = `anchors[${ai}]`;
    if (!isObj(a)) { push(E.SHAPE, 'Anchor がオブジェクトでない', ap); return; }
    // 明示した undefined は「キーが無い」と同じ（JSON 往復でキーが消えても判定が変わらない）。null は BAD_OFFSET のまま（作る経路が無いので厳しい側）。
    if (Object.hasOwn(a, 'offsetMm') && a.offsetMm !== undefined && (typeof a.offsetMm !== 'number' || !Number.isFinite(a.offsetMm))) {
      push(E.BAD_OFFSET, `Anchor の offsetMm が有限でない: ${String(a.offsetMm)}`, `${ap}.offsetMm`);
    }
    const d = datumById.get(a.datumId);
    const s = strokeById.get(a.strokeId);
    if (!d) push(E.ANCHOR_DATUM_MISSING, `Anchor の datumId が無い: ${String(a.datumId)}`, `${ap}.datumId`);
    if (!s) push(E.ANCHOR_STROKE_MISSING, `Anchor の strokeId が無い: ${String(a.strokeId)}`, `${ap}.strokeId`);
    if (!d || !s) return;
    if (!Number.isInteger(a.vertexIndex) || a.vertexIndex < 0 || a.vertexIndex > s.moves.length) {
      push(E.ANCHOR_VERTEX_MISSING, `Anchor の vertexIndex が頂点に無い: ${String(a.vertexIndex)}（頂点 0〜${s.moves.length}）`, `${ap}.vertexIndex`);
      return;
    }
    if (!isEnum(DetailAxis, d.axis) || !isEnum(DetailDatumKind, d.kind)) return;
    const slot = ((found.get(a.strokeId) ?? found.set(a.strokeId, {}).get(a.strokeId))[d.axis] ??= {});
    (slot[d.kind] ??= []).push(a.vertexIndex);
  });

  // ---- ストロークごと・軸ごとの規則 ----
  const endAnchored = { [DetailAxis.S]: false, [DetailAxis.T]: false };
  fig.strokes.forEach((s, si) => {
    if (!isObj(s) || !strokeById.has(s.id)) return;
    const sp = `strokes[${si}]`;
    for (const axis of AXES) {
      const slot = found.get(s.id)?.[axis] ?? {};
      const origins = slot[DetailDatumKind.ORIGIN] ?? [];
      const ends = slot[DetailDatumKind.END] ?? [];
      if (origins.length === 0) push(E.NO_ORIGIN_ANCHOR, `ストローク ${s.id} が軸 ${axis} の origin の Anchor を持たない`, sp);
      if (origins.length > 1) push(E.DUPLICATE_ANCHOR, `ストローク ${s.id} の軸 ${axis} の origin の Anchor が ${origins.length} 個`, sp);
      if (ends.length > 1) push(E.DUPLICATE_ANCHOR, `ストローク ${s.id} の軸 ${axis} の end の Anchor が ${ends.length} 個`, sp);
      const stretches = stretchPartsOf(s, axis);
      if (ends.length >= 1) {
        endAnchored[axis] = true;
        if (stretches.length !== 1) {
          push(E.STRETCH_COUNT, `ストローク ${s.id} の軸 ${axis} の stretch が ${stretches.length} 本（end の Anchor があるので 1 本必要）`, sp);
        } else if (origins.length >= 1) {
          const lo = Math.min(origins[0], ends[0]);
          const hi = Math.max(origins[0], ends[0]);
          const i = stretches[0].moveIndex;
          if (!(lo <= i && i < hi)) push(E.STRETCH_OUT_OF_SPAN, `ストローク ${s.id} の軸 ${axis} の stretch（手 ${i}）が頂点 ${lo}〜${hi} の間に無い`, sp);
        }
      } else if (stretches.length > 0) {
        push(E.STRETCH_WITHOUT_END, `ストローク ${s.id} の軸 ${axis} に stretch があるのに end の Anchor が無い`, sp);
      }
    }
  });
  for (const axis of AXES) {
    if (datumsOn(axis, DetailDatumKind.END).length === 1 && !endAnchored[axis]) {
      push(E.END_DATUM_UNUSED, `軸 ${axis} の end の Datum をどのストロークも Anchor にしていない`, 'anchors');
    }
  }

  return { ok: errors.length === 0, errors };
}

// 「読めるか」だけを決める誤り（版・未知の語彙・長さ・型）。Anchor や伸縮の規則違反は読めるが登録できない図。
const SUPPORT_BLOCKING = new Set([
  E.SHAPE, E.VERSION, E.UNKNOWN_CATEGORY, E.UNKNOWN_VIEW, E.UNKNOWN_SUBJECT, E.UNKNOWN_DIR, E.UNKNOWN_MODE, E.UNKNOWN_PARAM,
  E.UNKNOWN_MATERIAL_FIELD, E.UNKNOWN_ROLE, E.UNKNOWN_KIND, E.UNKNOWN_AXIS, E.UNKNOWN_WEIGHT, E.UNKNOWN_DASH, E.BAD_LENGTH,
  E.BAD_VECTOR_SIGN, E.UNKNOWN_EDGE_MARK, E.PART_UNKNOWN_ROLE, E.BAD_KEY_CHAR,
]);

/**
 * 建具一式の部品を指す合成キー '<一式のキー>#<role>' を分ける。最初の区切りで分け、両側が空でなく role が語彙にあるときだけ
 * { setKey, role }、それ以外は null（例外にしない）。
 */
export function parseFittingPartKey(key) {
  if (typeof key !== 'string') return null;
  const i = key.indexOf(FITTING_PART_KEY_SEPARATOR);
  if (i <= 0) return null;
  const setKey = key.slice(0, i);
  const role = key.slice(i + FITTING_PART_KEY_SEPARATOR.length);
  return role.length > 0 && isEnum(FittingPartRole, role) ? { setKey, role } : null;
}

/**
 * 建具一式 entry の role の部品を、単独の詳細図（合成キー '<key>#<role>'・label '<label>（<role>）'）として返す。
 * entry が建具一式でない・その role の部品が無いときは null。
 */
export function fittingPartFigure(entry, role) {
  if (!isObj(entry) || entry.category !== DetailCategory.FITTING || !Array.isArray(entry.parts)) return null;
  const part = entry.parts.find(p => isObj(p) && p.role === role && isObj(p.figure));
  if (!part) return null;
  return {
    ...part.figure,
    key: `${entry.key}${FITTING_PART_KEY_SEPARATOR}${role}`,
    version: entry.version,
    label: `${entry.label ?? ''}（${role}）`,
  };
}

/** この版で読める図か（version・全語彙が既知・全 LenSpec の mm が有限かつ正・線の役割が既知）。例外にしない。 */
export function isSupportedDetailFigure(plain) {
  if (!isObj(plain)) return false;
  return !validateDetailFigure(plain).errors.some(e => SUPPORT_BLOCKING.has(e.code));
}
