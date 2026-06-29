// ================================================================
// 部材リスト配置検討モード
//
// 断面図プリミティブの「配置（位置）だけ」を layoutId 単位の {dx,dy}(mm) オフセットで上書きする仕組み。
// 構造（rect の実寸・寸法値）には触れず、寸法線・ラベル・補助図形の置き場所を詰めるための土台。
//
// 「指示すると則反映できる仕組み」:
//   ・MEMBER_LAYOUT_OVERRIDES … 検討で確定した配置を焼き込む“テストコード”。ここを編集すると本番の
//     断面図（MemberListTab の図）へ即反映される（リロードで再シード）。
//   ・layoutOverrides(store) … 配置検討モードUIが触る実行時ストア（MobX）。UIの移動が本番図へ即時反映される。
//     UIで詰めた値（JSON出力）を MEMBER_LAYOUT_OVERRIDES へ貼れば恒久化される。
//
// 配置検討ボタンの表示はスコープ単位で制御する（STUDY_ENABLED_SCOPES）。既定は空＝どの図にもボタンを出さない。
// 「<図>の検討モード」と指示されたら、該当スコープをここに追加して該当図の横にボタンを出す。
// ================================================================

import { observable, runInAction } from 'mobx';

// ----------------------------------------------------------------
// 【運用】配置検討モードの使い方
//
// 1. 有効化：下の STUDY_ENABLED_SCOPES に対象図のスコープ文字列を足すと、その図の構造リストカード横に
//    「配置検討」ボタンが出る（既定は空＝どの図にもボタンを出さない＝通常運用）。
//    スコープは layoutScopeFor(mapName, entity) が返す値。現状は基礎梁＝'foundationBeam' のみ。
//      例) new Set(['foundationBeam'])
// 2. 配置を詰める：ボタン→オーバーレイで、要素クリック=選択／↑↓←→=1mm移動（Shift=10mm）／
//    Delete=解除。寸法の数値ラベルは線とは別に動かせる（破線ハンドル）。移動は本番図へ即時反映。
// 3. 確定：図の余白をクリック（または閉じる）すると全要素の位置が**コンソールへ JSON 出力**される。
//    それを下の MEMBER_LAYOUT_OVERRIDES.<scope> に貼れば恒久化（リロード後も再現）。
// 4. 撤去：通常運用に戻すときは STUDY_ENABLED_SCOPES を空に戻すだけ（コードは残す）。
// ----------------------------------------------------------------

// 配置検討ボタンを出す図スコープの集合（指示で追加する）。空＝ボタンなし。
export const STUDY_ENABLED_SCOPES = new Set([]);

/** その図スコープで配置検討ボタンを表示するか。 */
export function isStudyEnabled(scope) {
  return scope != null && STUDY_ENABLED_SCOPES.has(scope);
}

// 検討で確定した配置オフセット（“テストコード”。scope → layoutId → {dx,dy} mm）。
export const MEMBER_LAYOUT_OVERRIDES = {
  // 基礎梁断面図の配置（配置検討モードで確定。dx/dy=0 の要素は効果がないため省略）。
  foundationBeam: {
    'text:axisLabel':           { dx: 0,    dy: -162 }, // 通り芯ラベル
    'text:glLabel':             { dx: -314, dy: 0 },    // ▽ GL ラベル
    'dim:beamWidth::label':     { dx: 0,    dy: -30 },  // 基礎梁幅 数値
    'dim:beamDepth::label':     { dx: -335, dy: 0 },    // 基礎梁成 数値
    'dim:rise::label':          { dx: -385, dy: 0 },    // 立ち上がり 数値
    'dim:embed::label':         { dx: -383, dy: 0 },    // 地中部 数値
    'dim:matTopAboveGL::label': { dx: -126, dy: -232 }, // べた基礎天端 数値
  },
  // S造梁断面図の配置（配置検討モードで確定。dx/dy=0 の要素は効果がないため省略）。
  steelBeam: {
    'text:columnAxisLabel':    { dx: 0, dy: -51 }, // 柱芯ラベル
    'text:materialAxisLabel':  { dx: 0, dy: -50 }, // 材芯ラベル
    'dim:eccentricity::label': { dx: 0, dy: -6 },  // 偏芯量 数値
  },
};

// ---- 実行時ストア（UIの移動を本番図へ即時反映する。MEMBER_LAYOUT_OVERRIDES からシード）----
const layoutOverrides = observable.map();
for (const [scope, ov] of Object.entries(MEMBER_LAYOUT_OVERRIDES)) {
  layoutOverrides.set(scope, { ...ov });
}

/** scope の全オフセット（{layoutId:{dx,dy}}）。observer から読むと移動で再描画される。 */
export function getLayoutOverrides(scope) {
  return layoutOverrides.get(scope) ?? {};
}

/** layoutId のオフセットを設定する（配置検討UIから）。 */
export function setLayoutOverride(scope, layoutId, dxdy) {
  runInAction(() => {
    const cur = { ...(layoutOverrides.get(scope) ?? {}) };
    if (!dxdy || (dxdy.dx === 0 && dxdy.dy === 0)) delete cur[layoutId];
    else cur[layoutId] = { dx: Math.round(dxdy.dx), dy: Math.round(dxdy.dy) };
    layoutOverrides.set(scope, cur);
  });
}

/** scope のオフセットを MEMBER_LAYOUT_OVERRIDES の初期値へ戻す。 */
export function resetLayoutOverrides(scope) {
  runInAction(() => layoutOverrides.set(scope, { ...(MEMBER_LAYOUT_OVERRIDES[scope] ?? {}) }));
}

// 寸法の「数値（ラベル）」を線とは独立に動かすための副ID（layoutId に付ける接尾辞）。
export const LABEL_ID_SUFFIX = '::label';

/** 図ジェネレータ用：プリミティブ群に layoutId を付ける（既に付いていれば維持）。 */
export function withLayoutId(layoutId, prims) {
  return prims.map(p => (p.layoutId ? p : { ...p, layoutId }));
}

/** プリミティブ1個を (dx,dy) mm 平行移動した新しいプリミティブを返す（配置のみ・実寸は不変）。 */
export function translatePrimitive(p, dx, dy) {
  switch (p.type) {
    case 'rect':      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'circle':    return { ...p, cx: p.cx + dx, cy: p.cy + dy };
    case 'text':      return { ...p, x: p.x + dx, y: p.y + dy };
    case 'axisV':     return { ...p, x: p.x + dx };
    case 'levelLine': return { ...p, y: p.y + dy };
    case 'line':      return { ...p, x1: p.x1 + dx, y1: p.y1 + dy, x2: p.x2 + dx, y2: p.y2 + dy };
    case 'hSection':  return { ...p, x: p.x + dx, y: p.y + dy };
    case 'polyline':  return { ...p, points: p.points.map(([x, y]) => [x + dx, y + dy]) };
    case 'dim': {
      // dim は dir で軸が決まる: 'h'→from/to=x・at/foot=y、'v'→from/to=y・at/foot=x。
      const isH = p.dir === 'h';
      const shiftMain = isH ? dx : dy;
      const shiftAt   = isH ? dy : dx;
      const out = { ...p, from: p.from + shiftMain, to: p.to + shiftMain, at: p.at + shiftAt };
      if (p.foot != null) out.foot = p.foot + shiftAt;
      return out;
    }
    default:          return p;
  }
}

/** プリミティブ群へ overrides（{layoutId:{dx,dy}}）を適用した新しい配列を返す。
 *  寸法(dim)は本体の移動(layoutId)に加え、数値ラベルだけを `${layoutId}::label` のオフセットで
 *  独立に移動できる（labelDX/labelDY mm として付与。renderDim / EditableDimLabel が反映する）。 */
export function applyLayoutOverrides(primitives, overrides) {
  if (!overrides || Object.keys(overrides).length === 0) return primitives;
  return primitives.map(p => {
    if (!p.layoutId) return p;
    const o = overrides[p.layoutId];
    let out = o ? translatePrimitive(p, o.dx ?? 0, o.dy ?? 0) : p;
    if (p.type === 'dim') {
      const lo = overrides[`${p.layoutId}${LABEL_ID_SUFFIX}`];
      if (lo) out = { ...out, labelDX: (out.labelDX ?? 0) + (lo.dx ?? 0), labelDY: (out.labelDY ?? 0) + (lo.dy ?? 0) };
    }
    return out;
  });
}

/** 図の種類（mapName + entity）から配置検討のスコープを返す。対象外は null。 */
export function layoutScopeFor(mapName, entity) {
  if (mapName === 'beamMap' && entity?.role === 'foundation') return 'foundationBeam';
  if (mapName === 'beamMap' && entity?.materialType === 'STEEL') return 'steelBeam';
  return null;
}
