import { buildCatalogPreview } from './catalogPreview.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import { FIGURE_FRAME_BY_MAP } from '../structural/memberCatalog.js';

// 断面（columnMap）用の表示枠をそのまま流用する（QA指摘Major-1・2026-09-23）: memberFigure は
// frame指定時に annotatedFigure で注記の隙間を px 一定（GAP_BASE_PX）にするため、枠が狭すぎると
// 最大スケールでも収まらず最小1/500へ落ちる（builtin断面が軒並み潰れて見えなくなる）。柱の断面図は
// 寸法線・ラベルが密集し縮尺が選定しにくいため他より広めに確保されている枠（memberCatalog.js:66-72）
// と同じものを使う——独自の固定枠を二重定義しない。
const PREVIEW_FRAME = FIGURE_FRAME_BY_MAP.columnMap;

/**
 * カタログ保守（ReadonlyKindTab）の選択行に対する作図プレビュー。描くだけ——
 * プリミティブ生成は ui/catalogPreview.js の登録表（buildCatalogPreview）経由に一本化し、
 * memberFigure/buildOpeningElevation を本コンポーネントで直書きしない。読み取り専用パネルのため
 * AutoScaledFigure へ onEditDim/study は渡さない（EccentricityDialog.jsxと同じ読み取り専用の使い方）。
 */
export function CatalogPreview({ kind, entry }) {
  let result;
  try {
    result = buildCatalogPreview(kind, entry, { frame: PREVIEW_FRAME });
  } catch (e) {
    return <div className="catmnt-preview-error">作図プレビューでエラーが発生しました: {e.message}</div>;
  }
  if (!result.ok) {
    return <div className="catmnt-preview-empty">{result.reason}</div>;
  }
  return (
    <div className="catmnt-preview">
      <AutoScaledFigure
        primitives={result.primitives}
        maxWidth={PREVIEW_FRAME.maxWidth}
        maxHeight={PREVIEW_FRAME.maxHeight}
        scale={result.scale ?? undefined}
      />
    </div>
  );
}
