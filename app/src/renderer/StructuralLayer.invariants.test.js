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

test('【不変条件・z-order修正2026-09-17】StructuralLayer.jsx: 柱グループは framingColumnGroups の配列を renderColumnGroup(g) で描く（resolveCategory(group.category) の graph・group.symbol・colorOverride・group.outline をすべて橋渡しし、diaphragm は columnMap 判定で渡す）。柱グループの描画はrenderColumnGroupへ関数化されている——QA指摘4（伏図で梁上の管柱タップが梁カードを開いてしまう）の修正で、pick対象（自階柱□・pickColumns）だけ梁の後に描く2箇所描画になったため（下のz-orderテストで固定）', () => {
  const src = readSource();
  const defMatch = /const\s+(\w+)\s*=\s*framingColumnGroups\(/.exec(src);
  assert.ok(defMatch, 'framingColumnGroups(...) の呼び出し・代入が見つからない（柱グループの判断が structural/framingDrawing.js に無い＝回帰）');
  const groupsVar = defMatch[1];
  // 1グループぶんの描画は renderColumnGroup(g) に一本化されているはず（z-order修正で描画位置が
  // 2箇所に分かれたための関数化。二重実装を避ける——旧テストは columnGroups.map( の直接呼び出しを
  // 見ていたが、その形はもう存在しない。関数定義から itemVar を取る形へ最小限更新した）。
  const renderFnMatch = /const renderColumnGroup = (\w+) => \{/.exec(src);
  assert.ok(renderFnMatch, 'renderColumnGroup(g) の定義が見つからない（柱グループ描画の関数化が崩れている）');
  const itemVar = renderFnMatch[1];
  // z-order修正（下のQA指摘4テスト）が backColumnGroups/frontColumnGroups へ絞り込む元配列も
  // 同じ groupsVar（framingColumnGroups の代入先）でなければならない——別配列を作って絞り込みだけ
  // 差し替える回帰（下階柱×まで巻き込む等）を防ぐ。
  const filterFromGroupsVarRe = new RegExp(`${groupsVar}\\.filter\\(`);
  assert.ok(filterFromGroupsVarRe.test(src), `backColumnGroups/frontColumnGroups が ${groupsVar}.filter(...) から絞り込まれていない`);
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

test('【不変条件・QA指摘4】StructuralLayer.jsx: 柱タップ対象（columnMapSelf かつ pickColumns）だけbackColumnGroupsから除いてfrontColumnGroupsとし、梁本体（beamDrawSpans）より後（前面）に描く——非pick（下階柱×・非在来）はbackColumnGroupsのまま梁より前で不変', () => {
  const src = readSource();
  const backMatch = /const backColumnGroups\s*=\s*columnGroups\.filter\(\s*(\w+)\s*=>\s*!\(pickColumns\s*&&\s*\1\.category\s*===\s*'columnMapSelf'\)\)/.exec(src);
  assert.ok(backMatch, "backColumnGroups が columnGroups.filter(g => !(pickColumns && g.category === 'columnMapSelf')) 相当になっていない");
  const frontMatch = /const frontColumnGroups\s*=\s*columnGroups\.filter\(\s*(\w+)\s*=>\s*pickColumns\s*&&\s*\1\.category\s*===\s*'columnMapSelf'\)/.exec(src);
  assert.ok(frontMatch, "frontColumnGroups が columnGroups.filter(g => pickColumns && g.category === 'columnMapSelf') 相当になっていない");
  assert.ok(/\{backColumnGroups\.map\(renderColumnGroup\)\}/.test(src), 'backColumnGroups.map(renderColumnGroup) の描画が見つからない');
  assert.ok(/\{frontColumnGroups\.map\(renderColumnGroup\)\}/.test(src), 'frontColumnGroups.map(renderColumnGroup) の描画が見つからない');
  // frontColumnGroups（pick対象の自階柱□）は梁本体（beamDrawSpans.flatMapのGroup）より後に描かれる
  // ——梁が柱より後に描かれる既存z-orderのままだと、梁上に乗る管柱の中心タップが梁カードを開いてしまう
  // （QA指摘4・実機観測）。
  const beamBodyIdx = src.indexOf('beamDrawSpans.flatMap(');
  const frontRenderIdx = src.indexOf('{frontColumnGroups.map(renderColumnGroup)}');
  assert.ok(beamBodyIdx > 0, '梁本体の描画（beamDrawSpans.flatMap）が見つからない');
  assert.ok(frontRenderIdx > 0, 'frontColumnGroups.map(renderColumnGroup) の描画が見つからない');
  assert.ok(beamBodyIdx < frontRenderIdx,
    'frontColumnGroups（pick対象の自階柱□）の描画が梁本体（beamDrawSpans）より前にある（QA指摘4の回帰: 梁上の管柱タップが梁カードを開いてしまう）');
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

test('【不変条件】StructuralLayer.jsx: 土台帯（sillBandSpec/sillHalf）は現れない——土台はrole:sillの実体梁として一般の帯描画に乗る（2026-09-18裁定）', () => {
  const src = readSource();
  assert.ok(!/sillBandSpec/.test(src), 'sillBandSpec への参照が残っている（土台専用の帯描画が復活している回帰）');
  assert.ok(!/sillHalf|sillStrokeWidth|sillColor/.test(src), '土台専用の帯パラメータ（sillHalf/sillStrokeWidth/sillColor）が残っている');
});

test('【不変条件・B-3】StructuralLayer.jsx: beamDrawSpansはresolveBeamJunctionSpans(の結果を通り、bandCapLineはends[...].cappedでゲートされている', () => {
  const src = readSource();
  assert.ok(/from '\.\.\/structural\/beamJunction\.js'/.test(src) && /resolveBeamJunctionSpans/.test(src),
    'structural/beamJunction.js から resolveBeamJunctionSpans を import していない');
  // baseSpans（spanForColumns由来）→ junctions（resolveBeamJunctionSpans）→ beamDrawSpans（junctionsで
  // 上書き）という3段構成——resolveBeamJunctionSpansの結果を経由せずbeamDrawSpansを組み立てる回帰
  // （実体スパンをそのまま描画に使ってしまい、在来木造の交点処理が効かなくなる）を検出する。
  const junctionsMatch = /const\s+(\w+)\s*=\s*resolveBeamJunctionSpans\(\s*figureRules\.drawing\s*,/.exec(src);
  assert.ok(junctionsMatch, 'resolveBeamJunctionSpans(figureRules.drawing, ...) の呼び出し・代入が見つからない');
  const junctionsVar = junctionsMatch[1];
  const beamDrawSpansMatch = new RegExp(`const beamDrawSpans = baseSpans\\.map\\(\\w+ => \\{[\\s\\S]*?${junctionsVar}\\.get\\(`).exec(src);
  assert.ok(beamDrawSpansMatch, `beamDrawSpans が baseSpans.map(...) の中で ${junctionsVar}.get(...) を参照していない（交点処理の結果で上書きしていない回帰）`);
  // 梁本体の描画（bandLines分岐）でends（beamDrawSpansの分割代入）を受け取り、cappedな端だけ
  // bandCapLine(を呼んでいるか。1分岐でも落とすと検出できる形で固定する。
  assert.ok(/beamDrawSpans\.flatMap\(\(\{\s*beam:\s*b,\s*coord1,\s*coord2,\s*ends\s*\}\)/.test(src),
    'beamDrawSpansのflatMapがendsを分割代入していない（交点処理の結果を読んでいない回帰）');
  const capMatch = /const capLines = \(ends \?\? \[\]\)\.flatMap\(\(e, i\) => \(e\?\.capped[\s\S]{0,120}?bandCapLine\(/.exec(src);
  assert.ok(capMatch, 'capLines が e?.capped でゲートされたbandCapLine(呼び出しになっていない（capped=falseの端に誤ってキャップ線を描く／すべての端に描く回帰）');
  assert.ok(/\.\.\.capLines,/.test(src), 'capLinesがbandLines分岐の描画配列に含まれていない');
});

test('【不変条件・QA指摘1・ステップ4】StructuralLayer.jsx: 柱の当たり判定（ColumnsLayerのhitProps）はpick時のみlistening:true・fillEnabled:false・hitStrokeWidthがMath.max(とcolumnRenderSize(を含み、非pick時はモジュール定数COLUMN_HIT_PROPS_NONE（{ listening: false }）で、<ColumnSymbol>へhitProps={hitProps}として渡される', () => {
  const src = readSource();
  const propsMatch = /const hitProps = pick\s*\n\s*\?\s*\{([^}]*)\}\s*\n\s*:\s*(\w+);/.exec(src);
  assert.ok(propsMatch, 'hitProps（pick=trueのprops）の定義が見つからない');
  const pickProps = propsMatch[1];
  const elseVar = propsMatch[2];
  assert.ok(/listening:\s*true/.test(pickProps), 'pick時のhitPropsにlistening: trueが無い');
  assert.ok(/fillEnabled:\s*false/.test(pickProps), 'pick時のhitPropsにfillEnabled: falseが無い（外形の外までヒット域が広がる回帰）');
  assert.ok(/hitStrokeWidth:\s*Math\.max\(/.test(pickProps), 'hitStrokeWidthがMath.max(を使っていない');
  assert.ok(/columnRenderSize\(/.test(pickProps), 'hitStrokeWidthの算出式がcolumnRenderSize(を含んでいない（柱記号の実寸辺長を見ていない回帰）');
  // 非pick時は毎レンダー新規オブジェクトにしない（ColumnSymbolはobserverでReact.memo相当。QA指摘6）
  // ——モジュールスコープ定数を参照しているかを変数名の定義自体で確認する。
  const constMatch = new RegExp(`const\\s+${elseVar}\\s*=\\s*\\{\\s*listening:\\s*false\\s*\\};`).exec(src);
  assert.ok(constMatch, `非pick時のhitPropsが{ listening: false }のモジュール定数（例:COLUMN_HIT_PROPS_NONE）を参照していない（変数=${elseVar}）`);
  assert.ok(/<ColumnSymbol[\s\S]{0,300}?hitProps=\{hitProps\}/.test(src), '<ColumnSymbol>へhitProps={hitProps}が渡されていない');
});
