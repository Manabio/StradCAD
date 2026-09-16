// renderer/StructuralLayer.jsx のソース走査による不変条件テスト（QA指摘F1回帰の再発防止）。
// StructuralLayer.jsx は react-konva に依存するため import して実行できず、node:test から直接
// 検証できるのはソーステキストの構造だけ——「材種色の直接参照が colorOf 経由に統一されているか」
// 「柱グループの描画が framingColumnGroups の配列駆動になっているか」を、実装を1文字戻したら
// 検出できる形でここに固定する（team-lessons「抽出モジュールは呼び出し側もテストで守る」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource() {
  return fs.readFileSync(path.resolve(import.meta.dirname, 'StructuralLayer.jsx'), 'utf8');
}

// 行コメントを落として判定する（コメント中の言及を「コード上の参照」と誤検知しないため。
// structureRules.test.js の scanOffenders と同じ簡易化方針）。
function codeLines(src) {
  return src.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, ''));
}

test('【不変条件】StructuralLayer.jsx: COLOR_BY_MATERIAL[ の直接参照は ColumnsLayer 本体の材種色フォールバックと colorOf の2箇所だけ、かつ colorOf は framingColor を経由する', () => {
  const lines = codeLines(readSource());
  const hits = [];
  lines.forEach((code, i) => { if (/COLOR_BY_MATERIAL\[/.test(code)) hits.push({ line: i + 1, code }); });
  assert.equal(hits.length, 2, `COLOR_BY_MATERIAL[ の直接参照が2箇所以外になっている:\n${hits.map(h => `${h.line}: ${h.code}`).join('\n')}`);
  const colorOfHit = hits.find(h => /colorOf/.test(h.code));
  assert.ok(colorOfHit, 'colorOf の定義行が見つからない（COLOR_BY_MATERIAL[ の2箇所目のはず）');
  assert.ok(/framingColor\(/.test(colorOfHit.code), 'colorOf が framingColor を経由していない（恒等化の回帰・QA指摘E相当）');
});

test('【不変条件】StructuralLayer.jsx: 柱グループは framingColumnGroups の配列を map して描く（resolveCategory(group.category) の graph・group.symbol・colorOverride・group.outline をすべて橋渡しし、diaphragm は columnMap 判定で渡す）', () => {
  const src = readSource();
  const defMatch = /const\s+(\w+)\s*=\s*framingColumnGroups\(/.exec(src);
  assert.ok(defMatch, 'framingColumnGroups(...) の呼び出し・代入が見つからない（柱グループの判断が structural/framingDrawing.js に無い＝回帰）');
  const groupsVar = defMatch[1];
  const mapMatch = new RegExp(`${groupsVar}\\.map\\(\\s*\\(?\\s*(\\w+)`).exec(src);
  assert.ok(mapMatch, `${groupsVar}.map(...) の呼び出しが見つからない（配列をmapして描いていない）`);
  const itemVar = mapMatch[1];
  const resolveRe = new RegExp(`resolveCategory\\(\\s*${itemVar}\\.category\\s*\\)`);
  assert.ok(resolveRe.test(src), `resolveCategory(${itemVar}.category) 相当の呼び出しが見つからない（カテゴリごとの解決を配列に委ねていない）`);
  // resolveCategory(...) の代入先変数（graph の取得元）を捕まえる——ハードコードした別変数（例: 常に
  // columnMap側の resolved を使い回す）へ取り違えていないかを、実際に使われている変数名で確認する。
  const resolvedMatch = new RegExp(`const\\s+(\\w+)\\s*=\\s*composition\\.resolveCategory\\(\\s*${itemVar}\\.category\\s*\\)`).exec(src);
  assert.ok(resolvedMatch, `composition.resolveCategory(${itemVar}.category) の代入先変数が見つからない`);
  const resolvedVar = resolvedMatch[1];
  const outlinePropRe = new RegExp(`outline=\\{\\s*${itemVar}\\.outline\\s*\\}`);
  assert.ok(outlinePropRe.test(src), `outline={${itemVar}.outline} が渡されていない（輪郭強制の可否を配列から props へ橋渡ししていない）`);
  // QA指摘F6: graph・framingSymbol・colorOverride も group（resolveCategoryの結果・framingColorOverrideの
  // 代入先）からそのまま橋渡ししているかをソース走査で固定する。
  const graphPropRe = new RegExp(`graph=\\{\\s*${resolvedVar}\\?\\.graph\\s*\\}`);
  assert.ok(graphPropRe.test(src), `graph={${resolvedVar}?.graph} が渡されていない（下階柱・自階柱で異なるグラフを解決した結果を使っていない回帰）`);
  const framingSymbolPropRe = new RegExp(`framingSymbol=\\{\\s*${itemVar}\\.symbol\\s*\\}`);
  assert.ok(framingSymbolPropRe.test(src), `framingSymbol={${itemVar}.symbol} が渡されていない（記号の選択を配列から橋渡ししていない）`);
  const colorOverrideDefMatch = /const\s+(\w+)\s*=\s*framingColorOverride\(/.exec(src);
  assert.ok(colorOverrideDefMatch, 'framingColorOverride(...) の呼び出し・代入が見つからない');
  const colorOverrideVar = colorOverrideDefMatch[1];
  const colorOverridePropRe = new RegExp(`colorOverride=\\{\\s*${colorOverrideVar}\\s*\\}`);
  assert.ok(colorOverridePropRe.test(src), `colorOverride={${colorOverrideVar}} が渡されていない`);
  // QA指摘F7: diaphragm は「配列の先頭」という位置ではなく category==='columnMap'（下階柱）で判定する。
  const diaphragmPropRe = new RegExp(`diaphragm=\\{\\s*${itemVar}\\.category\\s*===\\s*'columnMap'\\s*&&`);
  assert.ok(diaphragmPropRe.test(src), `diaphragm が ${itemVar}.category === 'columnMap' で判定されていない（配列の位置(index===0)依存の回帰）`);
});

// QA指摘F1（ブロッカー・非在来の回帰）の再発防止: ColumnsLayer 自身の outline 判定が framingSymbol
// （記号の有無。非在来でも 'section' という非null値を持つ）を見てはならない——輪郭強制は必ず
// 呼び出し側が渡す outline props（framingColumnGroups 由来）だけで決める。
test('【不変条件・F1回帰】StructuralLayer.jsx: ColumnsLayer の輪郭線判定（outline算出）は framingSymbol を参照しない', () => {
  const lines = codeLines(readSource());
  const outlineDefLine = lines.find(l => /^\s*const outline = /.test(l));
  assert.ok(outlineDefLine, 'ColumnsLayer 内の `const outline = ...` 定義行が見つからない');
  assert.ok(!/framingSymbol/.test(outlineDefLine),
    `outline の算出が framingSymbol を参照している（非在来の下階柱にも 'section'（非null）が渡り輪郭が強制される回帰）: ${outlineDefLine.trim()}`);
});

test('【不変条件】StructuralLayer.jsx: 非正角材の標記は beamDepthMarks( の戻り値を map して描き、梁本体（beamDrawSpans）と同じ描画スパンを読む', () => {
  const src = readSource();
  // 梁本体の帯・継手記号を描く flatMap が beamDrawSpans を読んでいる（spanForColumns を1つ上へ
  // 持ち上げた結果を1箇所に集約——非正角材の標記と食い違わせないため）。
  assert.ok(/beamDrawSpans\.flatMap\(/.test(src),
    '梁本体の描画が beamDrawSpans.flatMap(...) を経由していない（spanForColumnsの二重計算・食い違いの回帰）');
  const defMatch = /const\s+(\w+)\s*=\s*beamDepthMarks\(/.exec(src);
  assert.ok(defMatch, 'beamDepthMarks(...) の呼び出し・代入が見つからない（非正角材の標記の判断が structural/framingDrawing.js に無い＝回帰）');
  const marksVar = defMatch[1];
  // beamDepthMarks(...) への入力が beamDrawSpans から作られている（梁本体と同じスパン）ことを確認する。
  const inputMatch = new RegExp(`beamDepthMarks\\([^;]*beamDrawSpans\\.map\\(`, 's').exec(src);
  assert.ok(inputMatch, 'beamDepthMarks(...) の第3引数が beamDrawSpans.map(...) 由来になっていない（梁本体と別のスパンを見る回帰）');
  const mapMatch = new RegExp(`${marksVar}\\.flatMap\\(\\s*(\\w+)`).exec(src);
  assert.ok(mapMatch, `${marksVar}.flatMap(...) の呼び出しが見つからない（beamDepthMarksの戻り値をmapして描いていない）`);
});

test('【不変条件・QA2026-09-16】StructuralLayer.jsx: ColumnsLayer の outlineStrokeWidth は props の outlineWeight から決め、graph 自前の drawing から framingColumnLineWeight を引かない', () => {
  const src = readSource();
  const match = /const outlineStrokeWidth = resolveStrokeWidth\(\s*\n\s*(.+),\s*scale,/.exec(src);
  assert.ok(match, 'ColumnsLayer 内の `const outlineStrokeWidth = resolveStrokeWidth(...)` が見つからない');
  const arg = match[1];
  assert.ok(!/framingColumnLineWeight\(/.test(arg),
    `ColumnsLayer 内で framingColumnLineWeight( を呼んでいる（下階柱グループの非アクティブな graph の drawing が権威になる回帰）: ${arg}`);
  assert.ok(/outlineWeight/.test(arg),
    `outlineStrokeWidth の算出が outlineWeight props を経由していない: ${arg}`);
  assert.ok(!/LINE_WEIGHT_MM\.medium/.test(arg),
    `outlineStrokeWidth の算出に LINE_WEIGHT_MM.medium の直書きが残っている: ${arg}`);
  // StructuralLayer本体側: <ColumnsLayer ...> へ渡す outlineWeight は主題階（figureRules.drawing）から
  // framingColumnLineWeight で解決したものでなければならない（下階柱グラフのdrawingではない）。
  const propRe = /outlineWeight=\{\s*framingColumnLineWeight\(\s*figureRules\.drawing\s*,/;
  assert.ok(propRe.test(src),
    'outlineWeight props が framingColumnLineWeight(figureRules.drawing, ...) から渡されていない（主題階の権威が壊れている）');
});

test('【不変条件・ステップ4第3単位③】StructuralLayer.jsx: 非正角材の標記Textは mark.label の rotation を渡し、offsetX/offsetYはestimateTextWidthとフォントサイズ+ギャップ（寸法線見立て）から求める', () => {
  const src = readSource();
  assert.ok(/rotation=\{\s*mark\.label\.rotation\s*\}/.test(src),
    'rotation={mark.label.rotation} が渡されていない（回転が固定値になっている回帰）');
  const offsetXMatch = /offsetX=\{\s*estimateTextWidth\(\s*mark\.label\.text\s*,\s*(\w+)\s*\)\s*\/\s*2\s*\}/.exec(src);
  assert.ok(offsetXMatch, 'offsetX={estimateTextWidth(mark.label.text, <fontSize>)/2} が見つからない');
  const fontSizeVar = offsetXMatch[1];
  // ユーザー裁定2026-09-16: 標記は寸法線に見立てる——文字の下端が平行線からgap分だけ離れる
  // （寸法線のnormalNumCoordと同じ関係）。offsetY={fontSize}（gap無し）は回帰。
  const offsetYMatch = new RegExp(`offsetY=\\{\\s*${fontSizeVar}\\s*\\+\\s*(\\w+)\\s*\\}`).exec(src);
  assert.ok(offsetYMatch, `offsetY={${fontSizeVar} + <gap>} が見つからない（寸法線見立てのgapが抜けている回帰）`);
});

test('【不変条件・ステップ4第3単位③】StructuralLayer.jsx: 非正角材の標記の文字サイズ・ギャップ・線幅は dimensionStyle.js の NUM_FONT_PX/TEXT_GAP_PX/DIMENSION_LINE_WEIGHT 由来で、専用定数(BEAM_DEPTH_LABEL_FONT_SIZE_PX)は残っていない', () => {
  const src = readSource();
  assert.ok(!/BEAM_DEPTH_LABEL_FONT_SIZE_PX/.test(src),
    'BEAM_DEPTH_LABEL_FONT_SIZE_PX が残っている（寸法線メトリクス共有への一本化が未完了）');
  assert.ok(/from '\.\/dimensionStyle\.js'/.test(src) && /NUM_FONT_PX/.test(src) && /TEXT_GAP_PX/.test(src),
    'dimensionStyle.js から NUM_FONT_PX・TEXT_GAP_PX を import していない');
  assert.ok(/NUM_FONT_PX \/ viewport\.scaleX/.test(src), 'フォントサイズが NUM_FONT_PX 由来になっていない');
  assert.ok(/TEXT_GAP_PX \/ viewport\.scaleX/.test(src), 'ギャップが TEXT_GAP_PX 由来になっていない');
  const strokeMatch = /const\s+(\w+)\s*=\s*resolveStrokeWidth\(\s*\n\s*LINE_WEIGHT_MM\[DIMENSION_LINE_WEIGHT\]/.exec(src);
  assert.ok(strokeMatch, '非正角材の標記の線幅が LINE_WEIGHT_MM[DIMENSION_LINE_WEIGHT] から解決されていない');
  const strokeVar = strokeMatch[1];
  const usageRe = new RegExp(`points=\\{mark\\.parallel\\}[^/]*strokeWidth=\\{${strokeVar}\\}`);
  assert.ok(usageRe.test(src), `平行線のstrokeWidthが${strokeVar}（DIMENSION_LINE_WEIGHT由来）を使っていない`);
});

test('【不変条件・ステップ4第3単位①】StructuralLayer.jsx: 梁の当たり判定は pickMembersOnFigure( でゲートし、fillEnabled:falseかつhitStrokeWidthがMath.max(と梁幅を含む式になっている', () => {
  const src = readSource();
  assert.ok(/const pickBeams = onMemberClick && pickMembersOnFigure\(/.test(src),
    'pickBeams が pickMembersOnFigure(...) の否定（onMemberClick 有無との論理積）でゲートされていない');
  const propsMatch = /const pickShapeProps = pickBeams\s*\n\s*\?\s*\{([^}]*)\}/.exec(src);
  assert.ok(propsMatch, 'pickShapeProps（pickBeams=trueのprops）の定義が見つからない');
  const props = propsMatch[1];
  assert.ok(/fillEnabled:\s*false/.test(props), 'fillEnabled: false が無い（Rect内部までヒット域が広がる回帰）');
  assert.ok(/hitStrokeWidth:\s*Math\.max\(/.test(props), 'hitStrokeWidth が Math.max( を使っていない');
  assert.ok(/width\s*\?\?\s*0/.test(props), 'hitStrokeWidth の算出式が梁幅(width)を含んでいない');
});

test('【不変条件・QA指摘F4】StructuralLayer.jsx: pickBeams時の<Group name="beam-symbol">はbeamId={b.id}を持ち、onClick/onTapは持たない（クリック判定はusePointerInteraction.js側に委ねる）', () => {
  const src = readSource();
  assert.ok(/name="beam-symbol"/.test(src), '<Group name="beam-symbol"> が見つからない');
  const groupMatch = /<Group\s+key=\{b\.id\}\s+name="beam-symbol"([\s\S]*?)>/.exec(src);
  assert.ok(groupMatch, '<Group key={b.id} name="beam-symbol" ...> が見つからない');
  const groupProps = groupMatch[1];
  assert.ok(/beamId=\{b\.id\}/.test(groupProps), 'beamId={b.id} が渡されていない（usePointerInteraction.jsのbeamAtKonvaTargetが解決できない回帰）');
  assert.ok(!/onClick=/.test(groupProps), 'onClick が残っている（QA指摘F4: Konvaのonclick/onTapは移動閾値・長押し状態を見ないため使わない）');
  assert.ok(!/onTap=/.test(groupProps), 'onTap が残っている（QA指摘F4: 同上）');
  const wrapMatch = /const wrapPick = els => \(pickBeams\s*\n([\s\S]*?)\n\s*: els\)/.exec(src);
  assert.ok(wrapMatch, 'wrapPick(els) が pickBeams ? [...Group...] : els の三項でない（偽なら配列をそのまま返していない）');
});

test('【不変条件・QA指摘F2】StructuralLayer.jsx: 梁本体の3分岐（単線Line・ピン閉矩形Rect・bandLines）がすべてpickShapePropsを受け取る（1分岐でも落とすと検出できる）', () => {
  const src = readSource();
  assert.ok(/<Line key=\{b\.id\} points=\{\[p1\.x, p1\.y, p2\.x, p2\.y\]\}[^/]*\{\.\.\.pickShapeProps\}/.test(src),
    '単線（width==null）分岐のLineが{...pickShapeProps}を受け取っていない');
  assert.ok(/<Rect key=\{b\.id\} \{\.\.\.bandRect\(b, lo, hi, width \/ 2\)\}[\s\S]*?\{\.\.\.pickShapeProps\}/.test(src),
    'ピン接合（isPinJoint）分岐のRectが{...pickShapeProps}を受け取っていない');
  assert.ok(/bandLines\(`beam:\$\{b\.id\}`,[^)]*,\s*pickShapeProps\)/.test(src),
    '既定（bandLines）分岐がpickShapePropsを渡していない');
});

test('【不変条件】StructuralLayer.jsx: 土台帯のhalf・線幅は sillBandSpec(foundationRules) から解決し、bandLines へそのまま渡す', () => {
  const src = readSource();
  const specMatch = /const\s+(\w+)\s*=\s*sillBandSpec\(\s*foundationRules\s*\)/.exec(src);
  assert.ok(specMatch, 'sillBandSpec(foundationRules) の呼び出し・代入が見つからない（土台帯のhalf・線幅算出がStructuralLayer.jsxに直書きされている回帰）');
  const specVar = specMatch[1];
  const halfRe = new RegExp(`sillHalf:\\s*${specVar}\\.half\\s*,`);
  assert.ok(halfRe.test(src), `sillHalf: ${specVar}.half, の受け渡しが見つからない（半端な加工（倍率等）を挟まず素通ししているか）`);
  const weightRe = new RegExp(`LINE_WEIGHT_MM\\[\\s*${specVar}\\.weight\\s*\\]`);
  assert.ok(weightRe.test(src), `LINE_WEIGHT_MM[${specVar}.weight] の参照が見つからない（線幅キーをsillBandSpec経由で解決していない）`);
  assert.ok(/bandLines\(`sill:\$\{b\.id\}`,\s*b\.isVertical,\s*b\.axisValue,\s*sillHalf,/.test(src),
    'bandLines(...) 呼び出しが sillHalf を使っていない（土台帯のhalfが食い違う回帰）');
});
