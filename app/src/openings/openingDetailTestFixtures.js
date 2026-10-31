// openings/ の部分詳細図（S3）テスト共通の図・記号の組み立て（テスト専用。製品コードからは引かない）。
// detail/ のテスト部品は引かない（openings/ が引く detail/ は detailPlacement.js だけ。importGraph.test.js）。
import {
  PenDir, DetailLenMode, DetailCategory, DetailView, DetailSubject, DetailDatumRole, DetailDatumKind, DetailAxis,
  DetailDash, DetailParam, DetailMaterialField, DETAIL_FIGURE_VERSION, DetailSlot, FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD,
} from '../core/constants.js';
import { CatalogKind } from '../catalog/catalogKinds.js';
import { setOverlay } from '../catalog/catalogRegistry.js';

const move = (dir, len) => ({ dir, len });
const stretchLen = mm => ({ mm, mode: DetailLenMode.STRETCH });
const paramLen = (param, mm) => ({ mm, mode: DetailLenMode.PARAM, param });
const proj = () => paramLen(DetailParam.FRAME_PROJECTION, 12);
const face = () => paramLen(DetailParam.FRAME_FACE_WIDTH, 20);

const DS0 = { id: 'ds0', role: DetailDatumRole.OPENING_OUTER, axis: DetailAxis.S, kind: DetailDatumKind.ORIGIN, offsetMm: 0 };
const DT0 = { id: 'dt0', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.ORIGIN, offsetMm: 0 };
const DT1 = { id: 'dt1', role: DetailDatumRole.WALL_FINISH_FACE, axis: DetailAxis.T, kind: DetailDatumKind.END, offsetMm: 0 };
const ANCHORS = [
  { datumId: 'ds0', strokeId: 'a', vertexIndex: 0 },
  { datumId: 'dt0', strokeId: 'a', vertexIndex: 0 },
  { datumId: 'dt1', strokeId: 'a', vertexIndex: 4 },
];
const LINE = { weightRole: 'medium', dashRole: DetailDash.SOLID };

/**
 * コの字の方立（平面。開）。頂点 v0(0,0) v1(0,-p) v2(fw,-p) v3(fw,0) v4(fw,T) v5(fw,T+p) v6(0,T+p) v7(0,T)
 * （s＝開口端からの見付方向・t＝壁の面を 0・T＝壁厚。p＝出幅・fw＝見付）。T は v3〜v4 の stretch 1 本が吸う。
 * 既定（見付20・出幅12・壁厚120）の v4 は (20, 120)。
 */
export function jambFigure(key, over = {}) {
  return {
    key, version: DETAIL_FIGURE_VERSION, label: 'テスト方立',
    category: DetailCategory.PAIRED, view: DetailView.PLAN, subject: DetailSubject.JAMB,
    strokes: [{
      id: 'a', closed: false, line: LINE,
      moves: [
        move(PenDir.UP, proj()), move(PenDir.RIGHT, face()), move(PenDir.DOWN, proj()),
        move(PenDir.DOWN, stretchLen(50)), move(PenDir.DOWN, proj()), move(PenDir.LEFT, face()), move(PenDir.UP, proj()),
      ],
    }],
    datums: [DS0, DT0, DT1], anchors: ANCHORS, provenance: null, note: null,
    ...over,
  };
}

/** 上枠（断面）。jamb と同じ形を閉じた図にしたもの（最後の U を書かない。閉じ辺は描画側が補う）。 */
export function headFigure(key, over = {}) {
  const j = jambFigure(key);
  return {
    ...j, label: 'テスト上枠', view: DetailView.SECTION, subject: DetailSubject.HEAD,
    strokes: [{ ...j.strokes[0], closed: true, moves: j.strokes[0].moves.slice(0, 6) }],
    ...over,
  };
}

/** 常に fit できない図（材の寸法への束縛。三方枠は材を供給しない＝UNRESOLVED_MATERIAL）。 */
export function materialBoundFigure(key, over = {}) {
  const j = jambFigure(key);
  const moves = j.strokes[0].moves.map((m, i) => (i === 1
    ? move(PenDir.RIGHT, { mm: 12.5, mode: DetailLenMode.MATERIAL, code: '101000000001', field: DetailMaterialField.THICKNESS })
    : m));
  return { ...j, label: '材束縛の方立', strokes: [{ ...j.strokes[0], moves }], ...over };
}

let symbolSerial = 0;
/** テストごとに一意な三方枠専用の建具記号キー（fit のメモがテスト間で漏れても影響しないように）。 */
export function uniqueSymbolKey() {
  symbolSerial += 1;
  return `TF${symbolSerial}`;
}

/**
 * user overlay に三方枠専用の建具記号と詳細図を立てる（呼び出し側が afterEach で clearOverlays する）。
 * @param {string} symbolKey
 * @param {{jamb?: object, head?: object}} figures slot → 図（キーは図の key）。無い slot は参照しない
 * @param {{profile?: string, installFigures?: boolean}} [opts] installFigures:false＝記号の参照だけ立てて図を入れない（参照切れ）。extraFigures＝記号が参照しない図（detailRefs 用）も入れる
 */
export function installFrameSymbol(symbolKey, figures, { profile = 'bent', installFigures = true, extraFigures = [] } = {}) {
  const refs = {};
  for (const slot of [DetailSlot.JAMB, DetailSlot.HEAD]) if (figures[slot]) refs[slot] = figures[slot].key;
  setOverlay(CatalogKind.FIXTURE_SYMBOL, {
    user: [{
      key: symbolKey, label: `${symbolKey}（試験用三方枠）`, category: 'fitting', mechanism: 'frameOnly', profile,
      ...(Object.keys(refs).length > 0 ? { [FIXTURE_SYMBOL_DETAIL_FIGURES_FIELD]: refs } : {}),
    }],
  });
  setOverlay(CatalogKind.DETAIL_FIGURE, { user: [...(installFigures ? Object.values(figures) : []), ...extraFigures] });
}
