import { CatalogKind } from '../catalog/catalogKinds.js';
import { buildCatalogPreview } from './catalogPreview.js';
import { AutoScaledFigure } from '../structural/sectionFigure/AutoScaledFigure.jsx';
import { FIGURE_FRAME_BY_MAP } from '../structural/memberCatalog.js';

// 断面（columnMap）用の表示枠をそのまま流用する（QA指摘Major-1・2026-09-23）: memberFigure は
// frame指定時に annotatedFigure で注記の隙間を px 一定（GAP_BASE_PX）にするため、枠が狭すぎると
// 最大スケールでも収まらず最小1/500へ落ちる（builtin断面が軒並み潰れて見えなくなる）。柱の断面図は
// 寸法線・ラベルが密集し縮尺が選定しにくいため他より広めに確保されている枠（memberCatalog.js:66-72）
// と同じものを使う——独自の固定枠を二重定義しない。
const PREVIEW_FRAME = FIGURE_FRAME_BY_MAP.columnMap;

// buildCatalogPreview の1件分の結果をSVGへ描くか、理由文だけを描く（姿図・平面記号で共通に使う）。
function renderPreviewResult(result) {
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

/**
 * カタログ保守（ReadonlyKindTab・建具記号タブ）の選択行に対する作図プレビュー。描くだけ——
 * プリミティブ生成は ui/catalogPreview.js の登録表（buildCatalogPreview）経由に一本化し、
 * memberFigure/buildOpeningElevation/buildOpeningPlanSymbol を本コンポーネントで直書きしない。
 * 読み取り専用パネルのため AutoScaledFigure へ onEditDim/study は渡さない
 * （EccentricityDialog.jsxと同じ読み取り専用の使い方）。
 *
 * 建具種別（OPENING_SUB_TYPE）は姿図（既定view）に加えて平面記号（view:'plan'）も姿図の下に
 * 並べて描く（ステップ11f）。建具記号（FIXTURE_SYMBOL）は平面記号のみ持つ（ステップ12f。姿図に
 * 相当するビューが無いため既定viewの呼び出しはしない）。壁厚導出に使う materialList は呼び出し側
 * （CatalogMaintenancePanel.jsx）が動的importで読み込んだ builtin 一覧をそのまま渡す（未指定なら
 * ui/catalogPreview.js 側の既定壁厚に落ちる。境界マスターは使わない——QA指摘・2026-09-23裁定Aで廃止）。
 */
export function CatalogPreview({ kind, entry, materialList }) {
  let result = null;
  if (kind !== CatalogKind.FIXTURE_SYMBOL) {
    try {
      result = buildCatalogPreview(kind, entry, { frame: PREVIEW_FRAME });
    } catch (e) {
      return <div className="catmnt-preview-error">作図プレビューでエラーが発生しました: {e.message}</div>;
    }
  }

  let plan = null;
  if (kind === CatalogKind.OPENING_SUB_TYPE || kind === CatalogKind.FIXTURE_SYMBOL) {
    try {
      plan = buildCatalogPreview(kind, entry, { frame: PREVIEW_FRAME, view: 'plan', materialList });
    } catch (e) {
      plan = { ok: false, reason: `平面記号プレビューでエラーが発生しました: ${e.message}` };
    }
  }

  return (
    <>
      {result && renderPreviewResult(result)}
      {plan && renderPreviewResult(plan)}
    </>
  );
}
