// ================================================================
// 断面マスター（柱・梁の断面形状・寸法カタログ）
//
// openings/openingCatalog.js と同じ位置づけの静的データ（core.js非依存）。
// 強度計算用の詳細プロパティは対象外、平面描画（StructuralLayer.jsx）と
// 構造リストタブの断面図（sectionFigure/）に必要な最小限の寸法のみ持つ。
//
// 規格鋼材（H形鋼・角形鋼管）は数が多いため、規格表記文字列から展開する
// ビルダー（buildHSections / buildSquarePipes）で生成する。木・RCは点数が
// 少ないため従来どおり明示エントリで持つ。
// ================================================================

export const SectionShape = Object.freeze({
  SQUARE_PIPE: 'squarePipe', // 角形鋼管
  H_SECTION:   'hSection',   // H形鋼
  ROUND_PIPE:  'roundPipe',  // 丸形鋼管
  RECT:        'rect',       // 木角材/RC矩形
  ROUND:       'round',      // RC丸柱
});

// --- 規格鋼材ビルダー ----------------------------------------------------------

// H形鋼の規格表記（H-成×幅×ウェブ厚×フランジ厚）。記号 × は U+00D7。
const H_SECTION_SPECS = `
H100×100×6×8 / H125×125×6.5×9 / H148×100×6×9 / H150×150×7×10 / H175×175×7.5×11 / H194×150×6×9 / H200×100×5.5×8 / H200×200×8×12 / H244×175×7×11 / H250×250×9×14 / H294×200×8×12 / H300×150×6.5×9 / H300×300×10×15 / H340×250×9×14 / H344×300×10×16 / H350×175×7×11 / H350×350×12×19 / H390×300×10×16 / H394×400×11×18 / H400×200×8×13 / H400×400×13×21 / H440×300×11×18 / H446×199×8×12 / H450×200×9×14 / H482×300×11×15 / H488×300×11×18 / H496×199×9×14 / H500×200×10×16 / H582×300×12×17 / H588×300×12×20 / H596×199×10×15 / H600×200×11×17 / H692×300×13×20 / H700×300×13×24 / H792×300×14×22 / H800×300×14×26 / H890×299×15×23 / H900×300×16×28
`;

// 角形鋼管の規格表記（□-辺×辺×板厚）。同一辺寸法でも板厚違いがあるためキーに板厚を含める。
const SQUARE_PIPE_SPECS = `
□50×50×2.3 / □50×50×3.2 / □60×60×2.3 / □60×60×3.2 / □75×75×2.3 / □75×75×3.2 / □90×90×3.2 / □90×90×4.5 / □100×100×3.2 / □100×100×4.5 / □100×100×6.0 / □125×125×4.5 / □125×125×6.0 / □150×150×4.5 / □150×150×6.0 / □150×150×9.0 / □175×175×6.0 / □175×175×9.0 / □200×200×6.0 / □200×200×9.0 / □200×200×12.0 / □250×250×6.0 / □250×250×9.0 / □250×250×12.0 / □300×300×9.0 / □300×300×12.0 / □300×300×16.0 / □350×350×12.0 / □350×350×16.0 / □350×350×19.0 / □400×400×12.0 / □400×400×16.0 / □400×400×19.0 / □400×400×22.0 / □450×450×16.0 / □450×450×19.0 / □450×450×22.0 / □500×500×16.0 / □500×500×19.0 / □500×500×22.0 / □550×550×19.0 / □550×550×22.0 / □600×600×19.0 / □600×600×22.0 / □600×600×25.0
`;

// 規格表記リスト（"A / B / C ..."）を要素文字列の配列に分解する。
function splitSpecs(specs) {
  return specs.trim().split('/').map(s => s.trim()).filter(Boolean);
}

// "H300×150×6.5×9" → H形鋼エントリ。成=height, 幅=width。
function buildHSections() {
  return splitSpecs(H_SECTION_SPECS).map(spec => {
    const [height, width, web, flange] = spec.replace(/^H/, '').split('×').map(Number);
    return {
      key: `STEEL-H${height}x${width}`,
      materialType: 'STEEL', shape: SectionShape.H_SECTION,
      width, height, webThickness: web, flangeThickness: flange,
      label: `H-${height}×${width}×${web}×${flange}`,
    };
  });
}

// "□200×200×9.0" → 角形鋼管エントリ。板厚はキー・描画（中空表現）の両方で使うため文字列・数値とも保持。
function buildSquarePipes() {
  return splitSpecs(SQUARE_PIPE_SPECS).map(spec => {
    const [w, h, t] = spec.replace(/^□/, '').split('×');
    const width = Number(w), height = Number(h);
    return {
      key: `STEEL-SQ${width}x${height}x${t}`,
      materialType: 'STEEL', shape: SectionShape.SQUARE_PIPE,
      width, height, wallThickness: Number(t),
      label: `□-${width}×${height}×${t}`,
    };
  });
}

// --- カタログ本体 --------------------------------------------------------------

export const SECTION_CATALOG = [
  // 木造（角材）
  { key: 'WOOD-105x105', materialType: 'WOOD', shape: SectionShape.RECT, width: 105, height: 105, label: '105×105' },
  { key: 'WOOD-120x120', materialType: 'WOOD', shape: SectionShape.RECT, width: 120, height: 120, label: '120×120' },
  // S造（規格鋼材）
  ...buildHSections(),
  ...buildSquarePipes(),
  { key: 'STEEL-PIPE150', materialType: 'STEEL', shape: SectionShape.ROUND_PIPE, width: 150, height: 150, wallThickness: 6, label: 'φ-150×6' },
  // RC造
  { key: 'RC-300x300',  materialType: 'RC', shape: SectionShape.RECT,  width: 300, height: 300, label: 'RC 300×300' },
  { key: 'RC-ROUND350', materialType: 'RC', shape: SectionShape.ROUND, width: 350, height: 350, label: 'RC丸 φ350' },
];

export function findSectionEntry(sectionDefId) {
  return SECTION_CATALOG.find(s => s.key === sectionDefId) ?? null;
}

// CFT柱（鋼管＝角形/丸形）のダイヤフラム出寸法 e（柱外面から外側への飛び出し量, mm）。
// スキンプレート厚 t（＝鋼管の板厚 wallThickness）に応じる（問題.md）：t<28 で 25、それ以外 30。
// 鋼管以外は 0（ダイヤフラムを持たない）。断面図・描画域・梁端の停止位置の三者が同じ e を使う単一実装。
export function diaphragmProjection(section) {
  if (!section || (section.shape !== SectionShape.SQUARE_PIPE && section.shape !== SectionShape.ROUND_PIPE)) return 0;
  return (section.wallThickness ?? 0) < 28 ? 25 : 30;
}
