# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面に描く専用モード。平面・通り芯・寸法は出さず、
`viewport.scaleX/offsetX`（ズーム）には触れない——独自の固定倍率（`chooseElevationScale`）とスクロール量（`ElevationModeState`）だけで完結し、平面へ戻ると元のビューが保たれる（不変条件）。
純モジュールは`app/src/elevation/`に置き、`store.js`/`snap.js`/`*.jsx`/`react-konva`/`appViewport.js`を静的importしない（node:test単体実行のため。校正値は`viewport.js`から取るか呼び出し側=`App.jsx`が渡す）。

- 突入時の帯の一括構築（`_buildBands`。自階＋直上階／直下階のgraph）は`withGraphReadScope`で囲む。graphを変更しない読み取り専用処理で、囲まないとMobXのcomputedが観測者ゼロで毎回再計算され突入が十数秒かかる（実機12室で14.2秒→0.52秒。`.claude/implementation-policy.md` 方針8）。**この囲みは外さない**。
- 突入境界（`modeBoundaries.elevation.enter`）は帯構築より前に、自階と直上・直下の壁の鮮度判定（`refreshWallsForViewEntry`。`.claude/mode-system.md`）を行う。`ElevationModeState`は壁・鮮度キー・構造部材の変化でも帯を全再構築する（階切替で境界が再生成したとき・展開中のundo/redoで壁が戻るとき。アクティブ階が自分の階のときだけ）。
- 縦横スクロールは**クランプ方式**（循環しない。画面に収まる帯もminXへクランプし中央寄せしない＝全帯を左三角の位置で揃えるため）で、**書き込み時にクランプする**（読み出し側だけだと過剰ドラッグ分がスラックとして蓄積しデッドゾーンになる）。横スクロールの既定位置は左三角(`band.leftAnchorX`)から`LEFT_MARGIN_SCREEN_MM`（2パス換算）ぶん手前（`clampFaceOffset`の下限だけを`minX-marginMm`へ広げる）。
- 階別のビュー位置記憶・建具パネル連携は末尾の「ビュー位置の階別記憶・建具パネル連携」。

## 2つの描画エンジンの担当境界（新しい表現をどちらへ足すか）
1枚の帯へ**2つのエンジンが同時にプリミティブを流し込む**。

| | `buildFaceFigure`（`elevationFigure.js`） | 断面エンジン（`section/`） |
|---|---|---|
| 入力 | **1つの面**（1階分のグラフの、1部屋の境界1辺） | 世界座標の切断線＋**層スタック**（複数階） |
| 座標 | 面ローカル | 世界座標→列×z帯 |
| 見えるもの | `ctx.graph`＝**その階だけ** | 全層。遮蔽・奥行き・断面/見えがかりの判定を持つ |
| 仕事 | **図面の体裁**（床線・天井線・端の縦線・開口・巾木・壁材2段書き・寸法・通り芯丸・面ラベル・段差見付け面） | **壁の実体の輪郭**（壁断面・見えがかり・腰壁の天端と端部・袖壁の断面・アキの標記）と**構造材（梁・柱）の断面・見えがかり** |

**新しい表現を足すときの判断**: **壁・構造材の実体に属する表現は断面エンジンだけに書く**（腰壁の天端・端部、袖壁の断面枠、アキの標記、梁型・柱型はすべて`section/`が唯一の情報源）。自階で閉じる図面の体裁は`buildFaceFigure`。
かつて「実体に属する表現は両方に要る」という3列目があり、片方を忘れると**例外もログも出ない欠落**になった（腰壁天端が多層書きの上階分に出なかった）。`buildRoomBand`も共通経路を通すようにして解消した。
同じ実体の縁を両者が別の理由で描くのは正常（面端の縦線は体裁の「端の縦線」であり壁断面の縁でもある）。完全に同じ位置・同じ線種の線は帯を確定する1箇所（`finalizeBand`の`dedupeCoincidentLines`）で畳む。ただし**偶然の重複除去に頼らず「描かない理由」の側で決める**（線種を分けた瞬間に表面化した前例がある）。

### 依存の向きと所在（展開図リファクタ S1〜S7 後）
- **依存は一方向**（`elevation/importGraph.test.js`が固定）: 帯ビルダー（`elevationBand.js`・`elevationStair.js`・`elevationVoid.js`・`elevationStairSequence.js`）→面の体裁（`elevationFigure.js`・`elevationFaces.js`等）→`section/`→`space/`→補助（`elevationStyle.js`・`elevationPrimitives.js`）。`section/`・`space/`から親（`elevation/`直下）へ引いてよいのは補助の2本だけ（定数・変換の語彙で、帯や面の概念を持たない）。`elevation/`内に循環を作らない。`plan/planSolids.js`は`section/`を引かない。
- 断面エンジンが面の値を要るときは、面側の純関数を下位モジュールへ置くか、帯ビルダーが cut/opts で渡す。置き場: 面の幾何（`letterOf`・`DIR_SIGN`・`wallLessEndAt`・`perpFaceAt`・`perpWallCrossesFacePlane`）は`section/faceGeometry.js`、断面線プロファイルの合成・描画位置（`mergeFloorProfiles`・`drawnFloorProfileZAt`・`halfWallThicknessMm`・`collectRunBreaks`）は`section/floorProfileMath.js`。
- `facade/`（立面モード。`.claude/facade-model.md`）が引いてよい`elevation/`は`elevationPrimitives.js`・`elevationLayout.js`・`elevationStyle.js`の3本だけ。逆向き（`elevation/`が`facade/`を引く）は禁止（`facade/importGraph.test.js`）。
- 他ドメインの純関数の定義元: `parseBaseboardHeightMm`は`core/room.js`、`beamDepthMm`は`structural/sectionCatalog.js`、`kneeDropZRangesAt`は`finish/kneeDropWall.js`、`stairUnderReturnSoffit`は`ceiling/stairSoffit.js`（平面の立体と展開図が共有する単一の供給源。展開図側へ置くと`plan/`が`section/`を引く）。
- `localXOf`は2つある: 面版は`elevationFigure.js`、切断版（`localXOf(cut, …)`）は`section/sectionTypes.js`。
- **階段の断面の形**（踏面のジグザグ`stairRunProfile`・U字/折返しの区間長と段数と蹴上`resolveSwitchbackParams`・ささら`stringerPrimitives`/`stringerBandGeometry`・断面線が閉じるか`stairSectionIsClosed`）は`section/stairSectionProfile.js`が**唯一の供給源**で、帯ビルダー（`elevationStair.js`・`elevationStairSequence.js`）と断面エンジン（`section/sectionStair.js`・`cuts/`）の両方がそこを引く（階段の断面の形だけを持つ旧ファイルは S7 で解消し、親→子→親の交差を無くした）。`elevationStair.js`は帯の組み立て（面の選択・2層枠・フォールバックの折返しプリミティブ化）、`elevationStairSequence.js`は歩行順の面シーケンス（cut表と内容の組み立て）だけを持つ。

### 契約（S2）と入口
- 断面エンジンの入口は`section/sectionContent.js`の**`buildSectionFromLine(line, layers, opts)`**（面非依存）→`buildCutContent`。通常の部屋帯・上部吹抜けを持つ部屋帯・吹抜け帯（`appendBandCutContent`／`appendUpperStoreyOutline`）が共有する。階段帯だけは`switchbackCuts`/`straightCuts`が組んだcutを`buildCutContent`へ直接渡す（`ends`を持たない手組みcut＝face由来のフォールバック経路）。
- cutは**`makeSectionCut(spec)`（`section/sectionTypes.js`）が唯一の生成器**。必須キー（`line`・`viewSign`・`dirSign`・`layers`・`zRange`・`baseFloorZ`）が欠けたら投げ、**渡されていないキーを既定値で足さない**（`'ends' in cut`のような存在判定と`{...cut}`の展開で挙動が変わりうるため）。
- `opts`は読み手による4群の typedef で契約化されている: **CutSpec**（切断の定義）／**ProbeInputs**（層・探査）／**RenderStyle**（scale・lineWeightsPx・baseboardMm）／**BandInjections**（stairCut・gapBeamRects・gapFloorProfile・floorlessRanges・memberLayers・memberCeilZAt・memberSplitsGaps・memberFromRoomSide…）。形は平らなまま（群はキーの置き場ではない）。`sectionTypes.test.js`が関数ごとの`opts.*`の読み取りと typedef の一致を固定する。`SectionCut`の残骸キーは撤去済み（S2。経緯は履歴）。
- 帯ごとに違うのは**層スタックだけ**（通常の部屋帯＝自階1層、上部吹抜け＝自階＋上階、吹抜け帯＝自階＋直下階）。**層スタックを組む入口は`section/sectionBandLayers.js`の`buildBandLayers(selfGraph, {above, below, selfFloorZMm})`の1関数だけ**。帯ビルダー・階段のcut表・加算レイヤはこれを呼ぶか受け取るだけで、層のリテラルを書かない（階高が解決できない層で打ち切る）。例外は2箇所（`switchbackCuts.js`の self 1層の probeCtx と`elevationFaces.js`の面抽出の仮想断面オフセット用 self 層リテラル）で、増やさない。**層に問う入口は`section/sectionLayerStack.js`の4規則**（後述「層スタックの一般規則」）だけ。切断線の位置・探査延長・見えがかりの距離判定・アキはすべて共通経路が決める。
- 帯⇄エンジン間の専用チャネルは6本（`ceilProfile`／`floorZProfile`／`aboveCeilVisibleRanges`／`upperFloorCutEnds`／`upperOverhang`系／`stairCut`）。増やさず、列にしか無い情報が図に要るときはエンジンの答え（ZBandの付帯・ヒット列・`cut.ends`）を読む。

### 帯種別の分岐を足さない
共通経路（`buildCutContent`以降）に、通常／上部吹抜け／吹抜け／階段のどれかにしか効かない`if`を入れない。タイプ固有の処理（階段のささら・遮蔽）は返り値の部品に対して呼び出し側が後段で行う。層スタックとヒット列で表現できないなら設計を見直す。ここへ足した修正は階段にも吹抜けにも同時に効く、を不変条件とする。帯の違いは呼び出し側が opts（BandInjections）で注入する値として表す。既存の`cut.stairCut`判定（切断線が階段室の中にあり`viewSign`の規約が違うため。`sectionContent.js`の2箇所・`sectionHits.js`・`sectionEngine.js buildColumns`の farStair）は既知の例外で、増やさない。

## 修正手順（一般化を担保する）
展開図関連の修正はすべてこの手順に従う。
- **(a) 再現をデータで固定する**: 実データ（`D:/tatsuya/Download/*.stq`）に構成があればそれを、無ければ`makeKneeDropTest.mjs`の作法でテスト用.stqを作り、`dumpElevFigure.mjs`で帯のプリミティブをダンプして「何が違うか」を図の座標で言う。
- **(b) 判断の置き場所を決める**: 壁・構造材の実体・可視・奥行き・アキは断面エンジン（`section/`）だけ、図面の体裁は`buildFaceFigure`。「面ローカルで自階だけ見て決める」判断を新設しない。列にしか無い情報が図に要るなら、チャネルを増やさずエンジンの答えを読む。
- **(c) 帯種別の分岐を足さない**（上節。既存の`cut.stairCut`判定は既知の例外で、増やさない）。
- **(d) 「未知」を「アキ」にしない**: 探査が答えられない区間をopenに落として後段の除外条件で引く、を繰り返さない。答えられない理由（層の窓・深度上限・成分違い）をbandに残す。
- **(e) ゲートで守る**: 修正前に全golden（`elevGoldenGate.mjs`。後述）と突き合わせ、修正後の差分を1本ずつ説明できるものだけ採用する。意図的な差分はユーザー裁定→ゴールデン再採取→採取コミットを「採取履歴」へ記録。合成fixtureの単体テストは変異テストで赤化を確認してから提出。INV1〜3（`sectionProbeMultiLayer.test.js`）は必ず緑。
- **(f) 深度・座標系を疑う**: 出力不変が期待される置換で差分が出たら「モデル差」と言う前に、帯ローカル／絶対・floorOffset・深度の基準点（切断線か最も手前の壁面か）・全高壁の向こうでないかを実データで裏取りする。
- **(g) 定数は1箇所**: 深度上限・許容誤差は`elevationStyle.js`から取り、経路ごとに別の値を持たない。許容は意味ごとに別名（`GAP_EPS_MM`＝mmの幾何、`FLOAT_EPS`＝浮動小数の丸め、`SAMPLE_OFFSET_MM`＝境界の外側を評価する微小量、`COORD_EPS_MM`＝座標・高さの同一視）。線種名は`ElevationDash`。プリミティブの生成は`elevationPrimitives.js`のヘルパー（`line`・`polyline`・`text`・`dim`・`rect`・`circle`・`arc`・`tag`・`hit`・`miterTriangle`）で、`{ type: '...' }`リテラルを書かない。ヘルパーは渡したキーだけを持ち、既定値でキーを足さない（`dash: undefined`を足す変異はJSON.stringifyで消えるので、ゴールデンでは検出できず契約テストだけが止める）。新しい型を足すときは`translatePrimitive`・`mirrorPrimitiveX`・レンダラの分岐へも足す。
- 抽出・移動だけのリファクタの忠実さは、HEADと作業ツリーの trim 済み行の多重集合の差（関数ヘッダ・呼び出し・JSDoc・変数名だけが残れば移動のみ）とモジュール直下名のシャドウイング検査で確認した（S6）。

### クリーンアップで残したもの
**恒久的に残す**
- `unexploredBelowZOf`（`section/sectionHits.js`）: 残骸ではなく「層ごとの探査窓（`cut.layerRunWindows`）の外は未探査＝何も描かない」一般規則（(d)の実装）。削るとはり出し列のslabが地面まで伸びる。
- `stairOver`（階段下の部屋の帯）の「描いた線を後から書き換える」機構: `lowerFaceEndVertical`・`trimCeilingLineAt`・`appendStairOverContent`・`clipStairUnderCeiling`（`elevationBand.js`ほか）。踏面ジグザグのヒット列化（6b-1′）を採らないため残る。検出力は golden13系の1階「13」帯だけ。
- 階段由来の clip・隠れ線の作図慣行（`clipWallFloorEdgeUnderZigzag`・`clipWallEdgesInsideStairBodies`・`clipWallEndVerticalsByStairMass`・`clipContentInsideStairBody`・`clipContentBelowProfileInRanges`・`splitGapMarksByStair`・`dashHorizontalsBehindStair`・`dashLinesInsideRects`・`clipHiddenStepLines`・`joinToStairProfile`）は**現状維持**。U3（探査の選択に階段を入れて clip を置換する案）は、行数が差し引きで増え clip も消えきらないため見送った（2026-10-25裁定）。
- `removeLinesInsideRects`・`wallLineCuts`は dropped 部材（後述）のためだけに残る。dropped が無くなれば消える。
- `dedupeCoincidentLines`（共線の重複除去）と`joinLinesAtMemberEdges`（部材の端で割れた共線の連結）は帯を確定する`finalizeBand`の整理として残す。`withFlatLineSpans`・`clipContentAtHiddenEnds`は体裁／面の端の話。
- `stairOccluderRects`はテスト専用の参照実装（本番は`stairFaceOccluderRects`）。

**別課題**: 共通経路に残る階段帯専用の`cut.stairCut`判定（`sectionContent.js`2箇所・`sectionHits.js`・`buildColumns`の farStair。帯の違いを opts の注入値へ寄せる再設計は未着手。増やさない）。
**保留（実データが無く要望待ち）**: 3層以上つながる吹抜け・1帯に3層を積む図（入口は N 層対応済み）。

### 視覚回帰ゲート
- `elevationSectionGolden.test.js`が`buildRoomBand`/`buildVoidBand`の出力プリミティブ全体を正規化JSONで固定する（矩形・段差・腰壁・腰壁袖壁・アキ・開放スパンの各ケース。ここを通らないゴールデンは移行の差分を検知できない）。差分が出たら「増減した線を1本ずつ説明できること」を更新の条件にする。
- 実データ規模の基準は`app/scripts/probe/`の固定スナップショット（`golden`・`golden11`・`golden13`・`golden13-struct`・`golden-knee`・`golden-elev-ceiling`・`golden-elev-moku16`・`golden-elev-stairports`）。**全展開図golden（対象表はスクリプトの TARGETS）は`node scripts/probe/elevGoldenGate.mjs [--only <名>] [--test]`（cwd=app）で1コマンドで突き合わせる**。出力不変のステップは、着手前に`--out`で採ったダンプへ`--base <dir>`で前後比較する（既存のずれがあるgoldenでも「前後で一致」を言える）。個別比較は`diffElevGolden.mjs <基準> <新> [--merge]`（追加/削除/線種変更を数え、層境界での分割・合併は見た目不変の別カテゴリ。比較ロジックは純モジュール`elevGoldenDiff.mjs`）。
- スナップショットは**ユーザー裁定済みの意図的差分を取り込むときだけ**再採取し、採取時点のコミットと取り込んだ差分を「採取履歴」へ記録する（動かないゴールデンでなければ基準にならない）。採取元は`D:/tatsuya/Download/13.stq`・`11.stq`ほか。`golden13-struct`は`dumpElevFigure.mjs 13.stq --regen --struct`（壁再生成のあと全階の構造再計算を収束まで回す＝読込み時の再計算で生まれる部材〔踊り場受け梁 LG 等〕を含む本番同型）。構造部材を絡む変更は保存データのままの golden では LG が無く検出できないため、これで見る。
- **ゲート不変は仕掛けの有効性の証拠にならない**（梁の除外を外しても17/17のままだった前例）。部材・探査の変更は83文書全数の比較が要る。

## A/B/C/D の向きと不変条件
**展開記号は「その断面が見ている面」の幾何で決まる**: 手順1で必要な展開断面を抽出（向きは絶対）、手順2で階段の上り方向に並べかえる（順番は後）。各cutの`face`は必ず**その切断が視線の先に見ている平面**でなければならない。**面の選択はcuts表（`switchbackCuts.js`）が唯一の情報源**で、`elevationStairSequence.js`は`cutOf(seqNo).face`をそのまま使う（独自に`wOut1`/`wOut2`を選び直さない）。中心1の面は実壁が無くても作る（同位置の中心線を軸に`hasRealWall:false`で。CLが無いU字階段は仮想の面。後述）。不変条件: 全cutで`letterOf(isVertical, face.inward)`が`letterOf(line.isVertical, -cut.viewSign)`と一致する。

A＝平面の上側（北）を室内から見た面、B=右、C=下、D=左。時計回りA→B→C→D。隣接する面同士は同じ隅を世界座標で共有する（`buildRoomFaces`の最重要不変条件。letterでグループ化してから連結するとL字部屋の隅で世界座標が一致しなくなる。外周を実際に1周する順で組み立て、ラベルは出現順に振る）。外周エッジは`computeExternalEdgeParams`の結果を**axisCLIdごとに分けてから**`mergeSegments`する（一括だと別letterの面同士が誤ってマージされる）。

## 展開図では断面の中は描画しない
描けるのは**床断面線と天井断面線に挟まれた範囲**だけで、天井の向こう（天井裏・上階の躯体）には何も描かない。**特例（スラブ帯クリップ等）は、この一般判定で置換できるなら削除する**（ルールの多重化は一般化を阻害する）。

### 「断面の中」の判定は空気セルの連結成分で決める
断面の中＝**連続した断面線で切り取られた向こう側全て**（壁の中も、隣の部屋も、天井裏も）。判定は`section/sectionVisibility.js`に一本化: 列（`buildColumns`のx区間）×z区間を「実体が占めない＝空気」で切り出し、隣接列の空気はz区間が重なれば連結、帯の持ち主の空間を種にフラッドフィルして、到達できた空気だけが断面の外。遮蔽実体は`cut`/`cutAlong`（切断線を横切る／縦断する壁）だけで、`wall`（見えがかり）は切断面の**向こう**にあるので横の連結を遮らない。
- **「線の左右どちらが中か」を一次情報にしてはいけない**。側判定は断面線が図を床断面から天井断面まで完全に分断するときしか定義できない（腰壁は天端の上で、アキは穴で、段違い天井の壁は低い側の天井より下で、それぞれ左右がつながる）。側は線の属性ではなく連結性の結果。分断する線に限れば「左右の一方だけが到達可能」が成り立つので、独立検算として単体テストに置く（`sectionVisibility.test.js`）。腰壁越し・アキ越しに見える上階は自動的に描かれる。
- エンジン側の適用: `buildColumns`が全帯について列ごとの到達可能な空気を求め、`clipBandsToVisible`がそれで帯を切る。**天井断面より上を描く例外は1つだけ**＝「隣の列の到達可能な空気に面している切断壁」（段違い天井の境界に立つ壁も吹抜けに面した腰壁の天端もこれ1つから出る）。`sectionEmit.js`の`hiddenByCutWall`（背景の水平線が手前の切断壁に隠れるか）も同じ見方。
- 見えがかり壁の面が終わるxは、突き当たる切断壁の**向こう側**（`wallEndXAt`）。側縁は列の境界に立てるのが原則だが、その区間が隣接列の切断壁の天端から始まるときだけ切断壁の向こう側の面へ送る（隅では壁の実体が連続し、壁面が無くなる＝アキになるのは切断壁の向こう側から。手前に立てると線が断面の手前の縁から生えて見える）。天井断面の段差・上階床の小口は`drawnCeilingRiserX`の規約（天井が高い側へ半壁厚）で手前の面のまま＝別の規則で、揃えてはいけない。
- 上階の床の断面線は境界に立つ切断壁の断面の中を通さない（次の「輪郭」節）。壁のない端部のはね出しは上階ぶんの天井断面線にも掛ける（`appendUpperStoreyTrim`。面の端に一致する側だけ）。
- この判定に畳めない別の問い: `withinViewRoom`（視線方向＝奥行きの可視性で、3Dのセル分割が要る）、`uncoveredZRanges`・`splitByCutWall`（「壁がそこで終わるか」＝実体の連続性）。上階の床の断面線だけは判定材料が主cutに無いので`cut.aboveCeilVisibleRanges`として呼び出し側（`elevationVoid.js`）から受け取る。

### 打ち切りと2つの例外
- 描けるのは列ごとの天井断面（`cut.ceilProfile`）より下まで。**天井の有無をエンジン側で推測してはいけない**（層の実Room有無から導くと階段帯の見え方が変わる）。**天井断面線を実際に引いている値そのもの**を`cut.ceilProfile`（区間ごとの`{loX,hiX,ceilZ}`）として呼び出し側から受け取り、`buildColumns`が列を打ち切る。区間の境界は必ず列の境界にする（またぐ列は中点で1つの天井しか持てず片側が誤って切られる）。profile範囲外（壁のない端部の探査延長）は端の区間の値へクランプする（図側が天井線を端の値で延長している以上、打ち切りも同じ値）。`ceilProfile`未指定（階段帯）は打ち切らない。`emitColumns`のFL/CH判定も`col.ceilZ`を優先する。**床側には打ち切り自体が無い**（入れると「床断面下の細破線＝またぐ面」の確定仕様と衝突するため、指示があるまで入れない）。
- **例外1: 天端または下端が露出した切断壁（腰壁・垂れ壁。`isKneeDrop`）は打ち切らない**。露出した縁は吹抜け側の空間に面して実際に見えるため（判定は`sectionHits.js`の`isKneeDropRange`＝その壁のz範囲が層の床天井いっぱいでないか）。**見えがかり（'wall'）には適用しない**（天井の向こうの腰壁は見えない）。
- **例外2: 天井断面の高さが変わる境界に立つ切断壁**。天井の高さが変わる境界は必ず壁が受けており、その壁の断面は天井が終わっている面そのもので高い側から実際に見える。`sectionEngine.js`の`exposedAboveCeil`が、その壁が占める列の連なりを左右へたどって**連なりの外側の列**の到達可能な空気の上端（天井の高い方）を返し、`clipBandsToVisible`が低い側の天井から高い側の天井までを1つの断面として残す（壁は片面ずつのWallのため厚みが2列に割れうる。隣接1列だけを見ると片側しか残らない）。左右とも同じ高さなら従来どおり落とす。**描くのは見える側の面だけ**（`exposedSide`で片側の縁だけ。反対側は低い天井の裏に隠れる。ただし腰壁・垂れ壁は境界でも両縁＝壁厚を描く。天端の水平線が宙で終わるため）。**例外2は例外1より先に評価する**が、**帯のz範囲は壁の実体のまま**にする（1階天井〜上階FLは上階の床構造で、壁の帯として引き伸ばすと壁の向こう側の面まで下りて「断面の中」に線が入る）。
- 露出の判定は**全列ぶん先に済ませてから**打ち切る（`buildColumns`）。打ち切りながら進めると隣の列のz範囲が変わって同じ壁と認識できず、壁厚が2列に割れた壁の片側だけ処理から漏れる。
- **スラブ（床構造・天井懐）の厳密内部にある壁contentは描かない**（`section/sectionContent.js`の`clipInsideSlabSolids`）。ささらの見えがかりに掛けている一般判定（`sectionTypes.js`の`solidRectsOf`）と同じ矩形・同じ減算を`emitColumns`の出力にも掛ける。`cut`/`cutAlong`の矩形は対象外（腰壁天端の帯の下端`kneeCapUnderline`や建具断面は壁厚の中に意図して描く線）。矩形の辺上の線は厳密内部ではないので残る。
- 「切断壁に切られた帯」は**帯の下端が切断壁の天端に一致するもの**（`splitByCutWall`）。「天端が帯の下端以上の切断壁がこの列にあるか」で判定すると切断壁より下の別の帯まで巻き込む。

### 断面の中とその輪郭（`ceilStepSlabSection`）
1階天井と上階の床に挟まれた区間は**断面の中**＝躯体で、中には何も描かない。描くのは輪郭だけ（小口＝低い側の天井→上階の床／上階の床の断面線＝低い天井の側へ面の描画端まで／低い側の天井の断面線）。この輪郭が無いと1階天井の線と2階天井の線が繋がらず宙で終わる。上階の床とその上に載る腰壁・袖壁は1つの連続した切断面なので、**床の断面線は壁の向こう側の面から描き始め**（内部に引かない）、壁の向こう側の縁がそこで床の断面線へ折れる1本の輪郭になる。**小口は境界のまま動かさない**（小口と壁の手前の縁が1本につながるのがスラブと壁が一体の切断面であることの表現。壁の向こうへ送る案は実機で誤りと判明し撤回）。**右が開いた形でも「中」と判定できる**のが要点（低い天井と上階の床という2本の水平断面で決まる）。
- 上階の床が実在するかは層スタックの所有Roomで判定する（`sectionProbe.js`の`upperFloorZAt`）。**上に部屋が無い（吹抜けが続く）位置に床の断面線を描いてはいけない**（帯の形から推測すると上階の壁の断面が同じFLで始まるだけの位置まで拾う）。この規則が効くのは面の内側まで。面の外のはり出し区間では`upperFloorZAt`が答えられない（自階が層スタックから落ちる）ため、実在の判定は「面の端も層ごとに違う」節（上階graphの所有Roomを面端のCLの外側で直接引く）へ委ねる。規則そのものは共通で**床が無い位置に床の断面線を描かない**。
- 上階床断面線の**起点**は面の内側でもはり出しでも同じ「切断壁の**向こう側の面**」。違うのはそこから先の向き（面の内側は内へ、はり出しは外へ`wallLessEndExtendModelMm`ぶん張り出して終わる）。述語（列に上階FLから立ち上がる`cut`帯があるか）は共有。天井段差の位置（壁の手前の面）と上階の床が始まる位置（壁の向こうの面）は半壁厚ずれるため、低い天井が続くあいだ外側へ走査して最初に見つかった床レベルを使う。
- 上階の床との取り合いの担当は帯の種類ではなく**列のデータ**で決まる（S10-3・2026-10-25）: 実在する上階の床について、そのスラブの帯が列の可視範囲に残っていれば`slabEdgeCutWallJunction`（スラブの上面が実在の床〔`slabTopIsRealFloor`＝nearXにスラブ側から接する列の`upperFloorZ`が上面と一致、または自階の床構造〕・その上に切断壁・壁の向こうが探査済みの空気）、列の天井の向こうに打ち切られて隠れていれば`ceilStepSlabSection`（隣り合う列の天井の段差・低い側に`upperFloorZ`。`ceilClip`〔裏面〕の段差にも同じ規則で走る＝S10-3-3・2026-10-26 ユーザー裁定。実データ88本・ゲート22枚・合成7本で差分0＝実データの裏面の垂直の段35件はすべて低い側の床`upperFloorZ`が段の下にあり小口の条件に入らない）。両者は列ごとに排他なので両方を常に走らせる。上階が吹抜け・階段室で`upperFloorZ`がnullの列に載る「見かけだけのスラブ」（`sectionHits.js`が天井〜上階FLをslabに分類する）は取り合いにならない＝2Fの壁の半厚だけ吹抜け側へはみ出した小片（77.5〜150mm）の太線3本は出ない（ユーザー裁定 案B・9文書）。

### 壁のない端部の2層取り合い
上階の床スラブが吹抜けの開口縁（CL）で終わり、そこに上階の腰壁・袖壁が載る構成（左CL上に腰壁、上階の床がそのCLで終わる）は、「1F天井→腰壁の立上り→天端→壁厚ぶん外→2FL床→外へ延長」というZ字プロファイルになる。3規則:
- **上階床スラブの端に切断壁が載っている取り合い**は`slabEdgeCutWallJunction`が組む。下階天井(`slab.z0`)→袖壁の向こう側（階段側）の面→**上へ立ち上げて**上階床(`slab.z1`)へつなぎ、袖壁の断面線と交点で取り合わせる。**立上りが要**（無いと天井線が壁の面で宙に終わる）。
- **小口が立つのは、壁の向こう側に探査済みの空気があるスラブだけ**（`sectionTypes.js`の`slabJunctionOf`のgate）。壁のある端では自階の壁＋床構造が自階の窓の外＝未探査のまま、上階の腰壁だけがはり出し列に立つ。そこへ「スラブが腰壁の向こう側まで延びる」と仮定して描くと壁断面の内部に線が入る。判定は「farXの先の列で、スラブのz範囲**全体**が空気の帯（`isAirBand`＝open/farVoid/wall/見えがかり由来のhidden）で覆われているか」。列が無い（未知）は空気ともスラブとも言わない（(d)）。一部だけ空気なら小口ではない。`hidden`は出自`hiddenOf`（'cut'＝断面の中／'wall'＝見えがかり由来＝手前は空気）で区別し、出自の無いhiddenは見えがかり由来とみなす。`solidRectsOf`のスラブ延長も同じ関数で決める。
- **取り合いの3本（下階天井・立上り・上階床）はすべて断面＝CUT（太線）**。スラブは仮想断面が実際に切っている躯体で、輪郭は壁の断面縁と同格。下階天井の線はスラブの走り全体を1本で描き、走りの中で見えがかり側が出す同じ高さの中線は抑止する（`ownedBySectionSlab`。同じ線を2種類の線種で重ねない）。小口の無いスラブの縁は中線のまま。
- **背景側の水平線は手前の切断壁の断面線でトリムする**（`hiddenByCutWall`）。その列に`cut`帯があり水平線が壁の天端以下なら列ごとの縁は描かない（取り合い線が代わりに1本で通す）。天端より上は対象外。却下した案: 「向こう側の面まで伸ばすだけ」（立上りなしで宙で終わる）／「手前の面で止める」（CLの外で止まる）。正解は向こう側の面まで進めてそこに立上りを描いて接合する。
- **切断壁の天端は`cut`帯からCUT水平線を壁ごとに1本**描く（`cutWallTopEdges`。列は壁と無関係な断点でも割れるので列ごとに描くと複数本になる）。見えている天井より下で終わる壁（腰壁・袖壁）が対象。壁は片面ずつのWallの2枚なので天端も2本の線分が突き合わさる（見た目は1本）。
- 凹み側面線は同じ層(`layerRole`)の壁どうしでしか成立しない（層が違えば凹みではなく見えている壁が別の層のものへ入れ替わっただけ）。切断壁（`cut`帯）の縦線は「同じ壁が隣接列に続くなら描かない」（`band.wall`参照で判定。列境界ごとに両縁を描くと1枚の壁の断面の内部に分割線が出る）。

## 見えがかりの奥行き判定
- **見えがかりとして描くのは「その切断で最も手前の壁面（＝主な描画対象）から測った奥行きが`SIGHTLINE_DEPTH_LIMIT_MM`(=800)未満」のものだけ**。それ以上奥の壁面は凹み（ニッチ・袖壁の脇）ではなく**別の空間**なので見えがかりにせずアキにする（`sectionEngine.js`の`buildColumns`で`wall`帯を`open`帯へ置き換える。基準距離は線種の階調と同じ`nearestSightlineDistMm`）。構造材の見えがかりも同じ判定を通す（梁・柱は`nearMm`で壁と競う）。
- **見えがかりは「見えるもの」だけ**。上階に実床があれば自階の天井で終わる（`sectionLayerStack.js`の`resolveSightlineTopZ`）。天井裏（自階の天井〜上階FL）にも壁の実体はあるが天井に隠れて見えないので、`probeColumn`が天井懐（`slab`・非描画）に分類する。上が吹抜けで壁が見え続ける場合は上階天井まで続く。
- **その空間の天井の縁は中線**（天井は切断面のすぐ手前から奥へ広がる面で、縁までの奥行きは0）。`sectionEmit.js`では2経路が同じ高さの線を出しうるので両方で中線を選ぶ: 見えがかり壁の上端（すぐ上に天井懐が接し、その層の`ceilZ`がその高さに一致する場合）と、slab/openの境界。
- **寸法の鎖は「見えがかりの奥行きが変わる位置」でも割る**（`elevationDimSplit.js`のS6）。面の平面に壁が無い区間では先の壁が見えがかりとして描かれ、壁の端に縦線が立つ。図に線がある位置なので寸法もそこで割る（分割を担うのは実体）。対象は面と平行で視線方向にあり、見えがかりとして描かれる奥行き（800未満）の壁。**割る位置は壁の端の中心線**（寸法の分割点は常にCL）。判定は`face.spans`ではなく面の軸上の壁を直接引く（`spans`は合成前の面のもので吹抜けと合成して伸ばした区間を持たない）。
- **壁のない端部のはね出し（探査延長）にはアキを描かない**（`emitOpenGapMarks`）。延長は線を図の外へ延ばすために探査範囲を広げたぶんで、そこは面の外。面自身の範囲は`cut.line.lo/hi`（延長を含まない）で決まり、アキのセルはその範囲へクリップする。条件は床側だけでよい。
- **他の面の見えがかりとして描かれる面は、独立したパネルにしない**（`elevationFaceList.js`の`dropFacesSeenAsSightline`。同じ壁面を2枚に描かないため）。条件は4つ: 同じ向きを見る平行な面／奥行きが上限未満／手前の面の走り範囲が奥の面の全長を覆う／手前の面の平面にその範囲と重なる壁が無い。奥行きは符号付きなので相互に取り込み合わない。**適用は面リスト確定後＝`composeRoomFaces`の`labelFaces`の直前**（落とした結果で採番をやり直すため）。上部吹抜けの2層帯だけは合成の後にもう一度掛ける（取り込む側の面は吹抜けと合成して走り範囲が伸びた後でなければ奥の面を覆えない）。
- **実画面で「ア キ」を置けない幅の区間は、アキ標記（バツ＋文字）ごと省略する**（`emitOpenGapMarks`）。判定は`GAP_LABEL_WIDTH_PX`(=30)を`scale`で実寸へ戻した値。**`scale`未指定（単体テスト・ゴールデン）では判定しない**。`scale`は帯の2パス目でのみ確定するので`appendBandCutContent`→`buildSectionFromLine`→`buildCutContent`→`emitCtx`と渡す。

## 線種は「断面か／どの奥行きか」だけで決まる
- **切断壁の縁は常に太線（CUT）。降格しない**。断面は隣に何が見えていようと断面であり、線種が隣接列の状態で変わってはいけない。
- **その他の見えがかりは奥行きで2段**: その切断で最も手前＝直近が中線（SILHOUETTE）、それより奥は細線（DETAIL）。「直近」は列ごとではなく**その切断（1枚の図）全体**で決める（`nearestSightlineDistMm`。列ごとに最小を取ると奥まった凹みもその列では最前面なので中線になり奥行きの表現が失われる）。
- **「断面より下・向こう側は細破線」への最終降格は`emitLine`1箇所だけ**で適用する（`.claude/elevation-redesign.md`§5.6の最終フィルタ。各所に個別の破線判定を持たせない）。`neverDowngrade`を渡した線（ささら12×300矩形・踊り場床CUT線・踊り場桁の見返り矩形・踊り場桁枠の見えがかり帯）は降格しない。降格が残るのは踏面梯子（正面視で`flight.baseZ<cut.baseFloorZ`のとき明示dash）と壁断面の見えがかり（'wall'/'cut'/'cutAlong'）だけ。
- **見えがかり線が存在するのは「仮想断面からの距離が変わるところ」だけ**。同じ距離が続く境界は1枚の連続面で線は無い。距離が変わる境界は**手前の面がその輪郭を持つ**（`ownsBoundary`。両方が描くと同じ位置に線種の違う線が2本出る）。相手がアキ・床スラブ・範囲外ならこちらが描く。
- 天井裏の面も「壁」扱いする（`resolveSightlineTopZ`が上限を上階のFLにする）。これで「CHの上が天井裏なら同じ壁が同じ距離で続く」ため、一般規則だけで**CHに見えがかり線が立たない**。逆に「CH下がアキ・上が壁」は距離が変わるので線が出る。**FLと帯自身のCHには見えがかりの水平線を描かない**（床・天井はその位置に断面線を持つ。FLは層の属性なので「帯自身・各層・床スラブ」のFLを集めるが、CHは帯自身が描く天井`emitCtx.ceilZ`だけ。帯の上端より上はモデルに無いのでここだけ明示的に落とす）。
- **切断壁の手前にある境界へ見えがかりの凹み側面線を重ねない**（壁は切断壁の裏へ続いており凹んでいない）。同様に、手前の腰壁（`cut`帯）に遮られて**その列だけ下端が持ち上がった**見えがかり壁の帯の側縁の縦線は描かない（水平線側は`hiddenByCutWall`、縦線側は`uncoveredZRanges`が隣接列の`cut`帯を「覆う」側に数える。同じ「手前の切断壁に切られただけ」の判定を水平/垂直の両方に適用する。片方だけだと再発した）。
- 縦線の抑止規則2つは**隣にアキ（`open`）があるなら効かせない**（アキは「その面の平面に壁が無い」ことそのもので、境界の縦線が要る）: `uncoveredZRanges`の「同じ壁面がキャップの違いだけで高さを変える境界には縦線を出さない」は境界に切断壁が立っていれば天端までしか効かせない／`splitByCutWall`の「切断壁に切られて持ち上がった帯の側縁は描かない」は隣接列がアキのときだけ外す。
- **同じ壁面がキャップ（天井高・上階セルの有無）の違いだけで高さを変える境界には縦線を描かない**（セル境界は描画対象ではない）。壁の同一性は参照一致でなく軸CL＋材の面位置で判定する。腰壁・垂れ壁は本物の高さ差なので対象外。**切断壁に切られた帯の側縁は面の端では効かせない**（前提の「隣接列で同じ壁が1本の帯として続く」が面の端には無い。端に壁が有るかの唯一の情報源は`openEndLo/Hi`＝`face.hasWallAtLocal0/Run`）。**`cut.line`の枠(lo/hi)は必ず`cut.face`の枠と一致させる**（ずれるとcontent全体が面に対して平行移動する）。階段の見えがかりは「蹴上材を裏から見ているか」でも決まる（階段帯の節）。

## アキ（バツ・「ア キ」）の標記
- **輪郭の矩形は描かない**: バツ（一点鎖線の対角2本）＋「ア キ」テキストだけ。輪郭は定義上つねに周囲の実体（壁の断面・床/天井の断面線・腰壁の天端・面端の縦線）と一致するので、矩形を描くと必ず二重になり、中線の矩形が断面＝太線という線種情報を上書きしてしまう。「ア キ」を置くのは、建具の開口を含まず・外接矩形どおりの形（L字に食い込まない）で・床断面より上にある連結成分だけ。断面エンジン側は`emitOpenGapMarks`、面図側（段差見付け面・開放スパン）は`appendGapMark`で同じ規則を持つ。
- **4点は空き面の実際の隅**（連結成分がL字なら、左右それぞれの端にあるセルのz範囲からその端での実際の上下を取る。矩形なら外接矩形と一致）。**腰壁と交差する区間はクリップ**（`obstructionRects`＋`subtractRectsFromLine`）。**手前に実体がある区間は破線**（`splitGapMarksByStair`。破線範囲は基準線の左右では決まらず「想定したバツに対して描画面＋所定距離までレイキャストして隠れた部分」。矩形との重なりを取るだけ）。
- **面を横切る切断壁の天端の上の空気を含めない**（アキはその面の平面に壁が無い範囲の標記で、直交する壁を越えた先の空間はこの面の穴ではない。混ぜると連結成分が壁の断面の中へL字に食い込む）。面の平面にある腰壁の天端の上（本当のアキ）は下が`wall`帯なので影響しない。
- **建具の姿の前にバツは出さない**: `openingPassThrough`の帯はアキ扱いにしない（姿図が描く場所。アキのセルに入れると真上の上階アキと連結して対角のバツが姿図の上を通る）。
- **アキを出さない場合**: 踊り場前縁の切断（折返し階段 seq1・seq3。`openGapMarks:false`）／レーン境界の実壁（隔て板）の面 seq2（隔て板の上・端の先は同じ階段室の空気。実壁が無い鉄骨等は従来どおり）／**抜けの先が階段室（`Room.feature===STAIR`）の抜け**（階段室への通路。`buildColumns`が向こう側のセルを引いて`open`帯に`farStair`を付け、部屋名は見ない。階段帯`cut.stairCut`は対象外）／壁のない端部のはね出し／実画面で置けない幅／部屋自身が回り込んでいる区間（回り込んだ先の壁は同じ帯の別パネルとして描かれる）。壁のない辺（階段の上り口）の開口には標記する。
- **開放スパンの中に見える直交壁（隔て板）の両面は中線の縦線**で描く（`emitOpenSpanEdgeOnWalls`。面に端を接して奥へ延びる自階の壁を同じ軸CLで1組にして外面2本。z範囲は`open`帯∩壁の存在z〔`sectionHits.js`の`edgeOnWallZRanges`〕。面を横切る壁・面の端壁・階段帯は対象外）。
### アキのz範囲は「下端＝遠側床・上端＝低い方の天井」
（高低差の裁定）アキは**断面エンジンだけが描く**。図側（`buildFaceFigure`）は**無条件で描かない**（面ごとに切り替える条件付き抑止は同期し続けるべき第2の機構を増やすだけ）。値の単一情報源は断面エンジンの探査（`sectionHits.js`の`farFaceAnnotation`→`sectionEngine.js`の`splitOpenByFarFace`が`open`帯自身のz0/z1を書き換える）。`emitOpenGapMarks`は帯のz0/z1をそのまま読むだけ。上端は近側/遠側の天井の低い方で止まる。**下端＝区間の内部に遠側床があれば常にそこで止める**（同値でも縮める）。区間の外（この列自身の探査下限`cut.zRange.loZ`より下）にあれば伸ばす（`extendedFromZ`を残す。腰壁のように区間の下に別の実体がある列は対象外）。その位置の実際の床は探査が既に見つけているので、引けない値を「帯の床(0)」で埋めたり引けた0や一段下のfar値で上書きしたりすると下端が床から浮く。「ア キ」の中心もクランプ後の範囲で採る。列ごとに遠側が違っても各列は自分の探査値を使う（補間は不要）。

  | 実機 | far | 探査が見つけた床 | 正しい下端 |
  |---|---|---|---|
  | 「11'」A2左（1FLの破線あり） | −100 | z=0 | z=−100（その破線の高さ） |
  | 「10」D1（遠側床線なし・近側の床が部分指定で下がる） | 0 | z=−50 | z=0 |
  | 遠側床が帯の床より高い構成 | +300 | z=0 | z=+300（下は遠側スラブで塞がれる） |
- **アキの下端は`open`帯自身が決める**（輪郭クランプは撤去済み）。**階段帯だけ例外**: 断面線があれば`gapFloorProfile`でセルの下限を持ち上げる（Xの形が崩れるので線を後から切らずセルの段階で持ち上げる。量はセルのx範囲での輪郭の最大。部屋帯・吹抜け帯は渡さない）。実体（`hidden`）・遮蔽（`stairFace`）・体裁は別チャネルで、実体の解決はband自身（探査）に一本化する。
- **バツの線種は対角ごと・線分ごと**: `baseFloorZ`で対角を分割し両片を一点鎖線で渡すと、下片は`emitLine`の最終フィルタが破線へ降格する（成分全体を1値で塗る旧実装より実高さに忠実）。「下片が破線」は`baseFloorZ`分割＋降格が決めており遮蔽由来ではない（階段の占有形状が`baseFloorZ`と一致しない構成は遮蔽チャネル側の分岐が別途要る＝未対応）。
- **部屋帯では手前の梁がアキを塞ぐ**: 帯が持つ梁（memberCutは`obstructionRects`で、memberFaceの帯は既定でアキを割る。階段帯だけ`gapPass`で素通し）は帯がアキを割る。帯が持たない部材（dropped）の矩形だけは`elevationSolids.js`の`beamBlockerRectsForFace`→`appendBandCutContent`の`gapBeamRectsOf`→`emitCtx.gapBeamRects`で`emitOpenGapMarks`へ渡す（面の平面上・空中の梁`split:true`はセルから抜く＝梁の上下で別の連結成分。断面`split:false`はセルを割らずバツの線から切り抜くだけ）。渡すのは`buildRoomBand`・`buildRoomBandWithVoidAbove`（solids指定時）だけ。階段帯は梁でアキを割らない（R5。`memberSplitsGaps:false`）。
- **階段室の開口越しに階段を見る**: (1) 面の向こうが階段室で天端が階段の裏面との取り合い（`junction`＝復路下の壁）の壁は、部屋の包絡矩形・奥行き上限(800)を掛けず壁の帯（`viaStair`。最初の1枚だけ）で見通す。天端の線は細線（`junctionTop`）で線種の階調（直近）に数えない。復路下の壁の天端は直上の層が無い単層の部屋帯でも付く（`probeCtx.floorHeightMm`）。(2) 開口越しの階段は`sectionContent.js`の`farStairViewPrimitives`が細線で描く（視点から遠ざかって上るflightの段鼻と、視点側を向く回転部の蹴上。`farSideSilhouettePrimitives`をレーンを横切る切断へ一般化）。(3) 遮蔽は列の手前の壁・断面と隔て板の端面（`emitOpenSpanEdgeOnWalls`が返す矩形の厳密内部）。階段の断面・階段帯・階段下の帯には触れない。(4) **巾木**: 階段下スペースは帯の部屋（ホール）の一部なので、`viaStair`の壁の足元と隔て板の小口（背後に`viaStair`の壁がある小口だけ）に帯の部屋の巾木高さの細線を引く（足元が床の高さの帯・端面だけ。階段帯・吹抜けの上階側・巾木なしは引かない）。

## 仮想断面線をどこへ置くか（`section/sectionCutPlane.js`）
**規則: 描画対象の面の壁の中心線から、室内側（`face.inward`方向）へ下がる。** 下がる量は「面の壁の中心線→壁仕上げ面」「その面に現れる柱型の室内側への出」「面の前の造作家具の出（ドメインモデル未実装。フックのみ）」の最大値を1mm単位で切り上げ。**多層帯は全ての層について同じ評価を行い最大を採る**（層ごとに面の走り範囲も壁厚も違うため、自階だけ見ると上階の柱型に切断面が食い込む）。
- 切断面が壁の中を通ると (a)見えがかり候補が全て室外の壁になり`withinViewRoom`に落ち (b)所有Roomの1点プローブが室の外へ落ちて`room=null`になり床スラブ・天井懐の分類ごと消える＝面が丸ごと`open`になる。`sectionCutPlaneExtraction.test.js`が offset=0 と正規のオフセットを並べてこの症状を凍結する。
- `faceCutLine`は`lo/hi/dirSign`を動かさない（断面ローカルxと面ローカルxが同値である`sectionTypes.js`の不変条件）。面の軸との照合は`cut.face?.axisCL?.effectiveValue ?? cut.line.axisValue`。視線の符号は`faceViewSign`（=-inward）が唯一の定義（過去に経路ごとに符号が食い違った）。`faceSectionCut`（部屋帯の梁の cut）の viewSign は`-faceViewSign(face)`で、柱型判定の「室内側を正」規約との反転は意図的に残している（完全統一は柱型の挙動「4」Bが変わるので見送り）。

## 切断1本→contentの共通経路（`section/sectionContent.js`）
階段帯と吹抜けの多層帯は「切断を1本立てて断面エンジンへ渡す」同じ処理なので、`buildCutContent`を唯一の共通経路にし、**ここへ足した修正は階段にも吹抜けにも同時に効く**を不変条件とする（かつて階段帯にあるものが吹抜け帯に無い差が静かに溜まった）。
- `buildSectionFromLine`は切断線と層スタックを主語にcutを組む薄い層。`face`は必須ではなく**opts の「面由来の値の供給元」**。面固有の値（`viewSign`/`dirSign`/`zRange`（必須。エンジンで導出しない＝導出すると帯種別の分岐が生える）/`baseFloorZ`/`ceilProfile`/`stairCut`/`bandRoomBounds`/`probeCtx`…）は呼び出し側が渡す。
- **面述語の導出は`SectionCut.ends`（`{openLo,openHi,wallLessLo,wallLessHi}`）1箇所**（`withProbeExtension`と`emitCtxForCut`が読む。`ends`の無い手組みcut＝階段cut表だけ従来のface導出へフォールバック）。**face-lessの縮退規則**: 層ごとの探査窓（`layerRunWindowsOf`。壁の中心線の平面が要る）は作らない／`bandRoomBounds`は渡さず深度上限800だけで絞る（`withinViewRoom`は帯＝1部屋前提の特例で多室横断では成立しない）。`cut.face`を直読みする箇所（`layerRunWindowsOf`・`sectionStructure.js`・`elevationStairSequence.js`）はface-lessで窓なし／許容0／`line.axisValue`へ縮退する。範囲外: 斜めの切断線・多室横断での`baseFloorZ`・`ceilProfile`の意味づけ。
- **`cut.bandRoomBounds`（帯のRoomの包絡矩形）は自階graphで一度だけ求めて全レイヤーで使う**（層ごとに引くと上階レイヤーでは自階Roomのセルキーが解決できず制限なしになる）。見えがかり壁の探索は帯自身の部屋の広がりまで（`withinViewRoom`）。帯のRoomは列によらず一定でなければならない。
- 面の描画範囲の外には断面を出さない（`cutDrawRange`が単一情報源。`cut.line.lo..hi`＋探査延長`probeExtendLo/HiMm`）。構造梁と階段のCUT断面矩形の両方に効かせる。

## 層スタックの一般規則（`section/sectionLayerStack.js`）
`SectionCut.layers`は「どの階のgraphを絶対zのどこへ置くか」の並びでしかないのに、かつてはrole名（'self'/'above'/'below'）と配列順で引いており、2層固定なら偶然正しく3層以上で静かに壊れた。**層に関する問いは4つの一般規則（所有層`layerOwningZ`／帯自身の階`baseLayerOf`／上位層`layersAboveOf`／優先順位`compareLayerPriority`）だけで答え、role文字列は`ZBand.layerRole`（隣接列の同一性判定の識別子）としてのみ残す**。意味を持つのは並び（floorZMm）であって名前ではない。
- 層を**組む**のは`sectionBandLayers.js`の`buildBandLayers`、層に**問う**のは本モジュール。生の`cut.layers`から自階の直上の層を引く`layerDirectlyAboveSelf`は`baseLayerOf`＋`layersAboveOf`の薄いアダプタ。
- 帯自身の階を「z原点に最も近い層」と定義できるのは`sectionTypes.js`の契約「高さは絶対z・設置階FL=0基準」があるため（崩すとbaseLayerOfの定義も崩れる）。見えがかり壁のz上限も「実Roomに出会うまで上へ登り、その手前の層の天井を上限にする」（`resolveSightlineTopZ`）へ一般化済み。
- **「修正が他の図面にも効くか」は不変条件で担保する**（`sectionProbeMultiLayer.test.js`）: **INV1** bandsはzRangeを隙間・重なりなく覆う／**INV2** `cut.layers`の並び順を変えても結果が完全に一致する（役割名にも配列順にも依存しない実行可能な証明）／**INV3** 同じ入力の再プローブは同じ結果。層まわりの新しい分岐を足すときはまずこの3本を通す。

## 空間セル索引とヒット列（`space/spaceModel.js`・`section/sectionHits.js`）
床天井の式は`space/spaceModel.js`の`buildSpaceIndex`に集約（唯一の置き場所）。`sectionProbe.js`の`makeProbeContext`はこの索引を内包する薄いラッパ。

### 不変条件: 帯のローカル z=0 ≡ その帯の部屋の実効FL
`finalizeBand`は部屋の実効FLぶん帯全体を平行移動する（`bandFloorOffsetMm`）。断面エンジンの床解決（`makeProbeContext`の`floorZOf`＝`spaceModel.js`の`floorZFor`）が階のdatum基準のままだと、実効FL≠0の部屋の帯で床zがfloorOffsetぶん過大になり、床断面線と重ならない中線・アキの誤った下端として現れる。**式は1箇所（`bandFloorOffsetMm`）に置き、finalizeBandとプローブの両方がそこを読む**（2箇所に分かれると再び食い違う）。`layer.floorZMm`（階のdatum差）には触れない（壁・断面のzまで動く）。above層にも同じ差し引きが効く。

### 探査の流れとヒット列の確定規約
- 探査は列ごとに**候補（ヒット列）を深度昇順で積み**（`probeColumnHits`）、**選択して帯にする**（`visibleBandsOf`）。`probeColumn`はヒット列を従来と同値に畳み込む薄い合成。候補の種類: `cut`/`cutAlong`（切断壁）・`wallFace`（見えがかり壁）・`floorFace`/`ceilFace`（視線の先の別室の床天井）・`slabFace`（自室の床構造・天井懐）・`stairFace`（階段の占有形状）・`memberCut`/`memberFace`（梁・柱。後述）。
- 深度は切断線から視線方向へ測った正値で、壁の`distMm`と同一基準。同深度のタイは垂直面（cut/cutAlong/wallFace）が水平面（floorFace/ceilFace）より先（`kindRank`）。floorFace/ceilFaceは単一zの縮退面で、厚みを持つのは`slabFace`だけ。視線の先の天井高が解決できないときは`ceilZ:null`（床線は出るが天井線は出ない）。深度の0は3種（cut/cutAlongの定義値・slabFaceの番兵・stairFaceの切断平面への接触）を区別する。
- 水平面ヒット（floorFace/ceilFace）は`open`帯へ、**区間の内部にある最も近いもの**を`farFloorZ`/`farCeilZ`/`farDepthMm`として付帯し、`splitOpenByFarFace`が壁と同じ基準（最も手前の壁面からの距離・800）で上限を適用する。上限内なら区間を`[farVoid?, open(floorZ..ceilZ), farVoid?]`へ分割（`farVoid`＝床天井より向こうの天井懐・床構造は非描画）。**床と天井は別々に深度判定する**（`farFloorDepthMm`/`farCeilDepthMm`。近い部屋の床の深度が遠い部屋の天井の上限判定に貸されて誤採用された前例がある）。奥の壁の建具姿図は描かない。
- `stairFace`（`stairFaceHits`）は`coverableHits`で除外され**選択に参加しない**（遮蔽は`stairFaceOccluderRects`・clip群が担う。U3見送りで現状維持）。
- **空気ボリュームの連結**（`componentOf`/`componentAt`）: 同一層は全高の壁で仕切られない限り連結（腰壁・垂れ壁は連結を切らない）。階またぎは、VOIDは**重なる吹抜けの最下階の親部屋1室**（直下に重なるVOIDがある限り連鎖し、最下階で親部屋と連結）、STAIR_VOIDは直下の**階段室1室**（feature===STAIR）とだけ連結する単一マッチ（bboxが重なるだけの他の部屋、階段下の閉じた部屋は連結しない）。本番の消費者は`isHiddenWall`。`cellsAlong`は`cellAt`の一般形で、視線方向へ格子セル単位に進みroom変化点（と天井の面が変わる所）で区切った区間を近い順に返す。

### 壁の天端プロファイル（関所の一般の引数。隔て壁 S4-1）
壁のz範囲の関所`finish/kneeDropWall.js kneeDropZRangesAt`（cut・cutAlong・wallFaceの3経路が共有）に省略可能な引数`wallTop`（`{zAt(along)→絶対z}`）を持たせた。あれば腰壁・垂れ壁より先に判定し`[床, min(天井, zAt(pointCoord))]`を返す（天端≦床なら空）。`probeCtx.wallTopProfileFor(layer)`が層ごとに1回だけ`Map<壁id, {zAt}>`を作る。供給元は在来木造の折返し階段の隔て壁の天端（`finish/stair/stairPartition.js partitionTopZAt`が単一情報源。最上層＝斜め、続く層・直上の層なし・階高/蹴上が決まらない・非在来＝プロファイルなし＝フルハイト）。**壁の種類を関所へ持ち込まず「天端が位置の関数」という一般の引数だけを足した**（特例を増やさない裁定）。
### 天端が斜めの帯（`topEdge`。S4-2）
斜めの天端は「帯の上端が水平」という前提を崩す一般の概念として、ZBandに`topEdge`（天端の線の両端の高さ）を持たせて扱う（壁の種類を描画側へ持ち込まない）。
- **列の境界**: プロファイルが`crossings(zLevels)`で斜線が水平線の高さを横切るalongを返し、`collectCutBreaks`が各層のFL・切断の床/上端・斜線を頭打ちにする天井の高さで列を割る（列の中で斜線が水平線をまたがない）。
- **帯の上端は高い側に倒す**: `probeColumnHits(…, span)`は列の幅の両端の高い方を上端にする（遮る範囲を広めに＝隠すべきものを描かない側。逆だと斜線の下に奥の線が漏れる）。上限（上階の床等）で頭打ちなら`topEdge`を付けない。`topEdge`は上端に届いている帯だけが持つ。probe直後は世界のlo/hi側、列の帯は図のx0/x1側。
- **描画**: 天端は列の両端の高さを結ぶ斜線。壁の端の縦線は**その端の天端の高さまで**。斜線では水平線との重なり判定を行わない。隣の列との継ぎ目の縦線・奥の壁の下端の水平線は、端の縦線の天端トリムと`ownsBoundary`で出ない（専用の抑止規則は足していない）。
- **アキ**: 斜線の上の連結成分は、全セルの上辺が水平で下辺が1本の直線なら台形として扱う（×は台形の対角・「ア キ」は台形の中心）。下辺が1本の直線でない成分は従来どおり外接の隅へ×を引き文字なし。遮蔽は台形（`subtractRectsFromLine`の`poly`）。**笠木なし**: 天端プロファイルの壁（`profiledTop`）は腰壁の天端の帯を描かない。
- **cut/cutAlong経路のクランプ**: プロファイルを持つ壁は部屋のCHではなく視線の上限（`resolveSightlineTopZ`）で切る（階段室の吹抜けにはCHの天井が無く、天端〔仕様2600〜3800〕がCH2400で止まるのは誤り）。この上限クランプは**リードの既定で裁定待ち**（旧仕様は部屋のCH）。プロファイルの無い壁は従来どおりCH。
### 隔て板の天端は物理端まで続く（旧 S4b「埋込み柱の立ち上がり」の撤回）
天端プロファイルは`zAt`/`crossings`だけを持ち、柱は斜めの天端より上へ出ない（裁定: 隔て板回転部側柱型の出っ張りは誤り。斜めの天板と回転部側縦線が取り合うのが正解）。斜めの天端は設計上の端（`entryEnd`/`landingEnd`）の外へも同じ勾配で延長し（`partitionTopZAt`・`partitionTopCrossings`）、壁の物理端（柱包みのはね出し）まで続いて端の縦線と取り合う。
- **縦線**: `uncoveredZRanges(col, band, side)`は、隣接列の帯が`topEdge`を持つとき境界での天端の高さまでしか覆わない（`side`＝'prev'/'next'）。**cut経路**: 同じ軸CLの切断壁が隣接列で高さだけ違うとき、隣の断面に覆われた高さの縦線は壁の内部なので引かない。
- **cut経路の天板の見え掛かり**: 幅方向に隔て板を横切る切断（seq1）で斜めの天端が切断面より視線側で上がるとき（最上階の隔て板。視線が上り口側）、切断帯の天端から視線側の壁の端での天端（天井の打ち切りまで）まで、両縁の立ち上がりと遠端の天端の水平を細線で描く（`cut`ヒットの`topBeyondZ`。壁ごとに1組）。天端が天井に届く壁・踊り場側を見る切断・続きの階段がある階（フルハイト）には出ない。
- N+1 の部屋帯からは下階の隔て壁は見えない（2026-10-25 に moku4-3・moku4 の2階全帯で実測＝下階の隔て板のヒット0）。根拠は専用のフィルタではなく**通常の部屋帯の層スタックが自階1層だけ**（`roomBandLayers`）であること。下階の層を積むのは吹抜けの独立帯（`buildVoidBand` の orphan 経路）だけで、そこでは隔て板を落とすフィルタは無く、切断線を横切る面なら候補になりうる（現データでは幾何的に当たらない）。隔て壁は下階Nの階段帯が自階の層で描き、上階の隔て壁は下階の階段帯の above 層で拾う。上り口側の短い束も壁に隠れるので描かない。

## 2.5D立体の加算レイヤ（`elevationSolids.js`）と構造材（梁・柱）の描き方
**現状（U1b B6 以降）**: 構造梁・柱は断面エンジンの探査の帯（`memberCut`・`memberFace`。`sectionHits.js`）が描き、遮蔽も壁と同じ奥行き比較で決める。加算レイヤ（`droppedMemberPrimitivesForFace`・階段帯の`structuralPrimitivesForCut`・`beamBlockerRectsForFace`・`wallLineCuts`）が描くのは**帯が持たない部材（dropped＝`droppedMemberKeysOf`）だけ**。`buildFaceFigure`は加算を積まない。`visibleBeamPieces`は`opts.memberCuts`を渡した呼び出しなら dropped だけを返す（本番は必ず渡す。省略＝全部返すのは単体テストの道具）。
**dropped の定義と、加算経路が恒久に残る理由（R7）**: 列の端を捨てた列（`{ceil, zone, wtpSight}`の3条件）の部材・z範囲に掛からない部材・探査の範囲の外・切断線が内側を厳密に通る柱。部材の端で列を割ると、斜めの天井断面・斜めの天端・天伏の天井高さ場の列は`mergeColumns`/`bandsEqual`が併合せず共線の線が割れ、天井高が列の中点1点で決まるため割れた列の天井が変わる。端を足す位置をこの3条件で限定して出力を保つ（QAアブレーションで必要十分）代わりに、その列の部材は帯に乗らず加算のまま残る。**ユーザー裁定R7: 粗さ維持**（継ぎ目は列の境にしない）。

### 探査の帯としての部材
- **候補収集**（`addMemberHits`）: `memberCut`（切断線が切る梁・柱。切断線が平行な梁の幅の帯を通る梁は`along:true`）と`memberFace`（視線側の平行な梁・空中の梁・柱）。入力の層は`cut.memberLayers`、無ければ`cut.layers`。**部屋帯は自階1層なので上階の梁（梁型）が候補に無い**ため、帯ビルダーが`memberLayersOf`（`elevationSolids.js`）で作って opts で渡す（`makeSectionCut`は足さない）。配列は`ElevationModeState`が1回の組み立ての中で全部屋で共有する（共有しないと`memberSolidsMemo`〔層の配列の同一性で立体を覚える〕が部屋の数だけ立体を作り直す＝落とし穴）。上部吹抜け帯にも梁が出る（ユーザー裁定「吹抜け帯にも梁を出す」）。`memberLayers`が無い帯は`cut.layers`で解く。壁に埋まった梁（`beamWallEmbedding`の fullyEmbedded、切断位置が`embedding.along`の中）は積まない＝**「壁の中か」は候補段階だけが答え、選択は奥行き比較だけ**（`hidden`で積むと壁の断面より先に選ばれて消える危険）。zは列の自階の床・天井で切る（床の穴は床で切らない・memberCutは天井で切らない・層スタック外の層も積む。部屋帯は自階FLで下を切る）。
- **選択**: `coverableHits`から部材を外す。`frontMatch`の順位は cut→cutAlong→memberCut（alongも同格）、`wallMatch`は wallFace＋memberFace。**部材が絡む列は全候補を手前の面までの奥行き`nearMm`で比べる**（壁＝materialRangeの手前の縁、梁＝|芯距離|−半幅、柱＝`depthNearMm`。面の通りの梁・壁芯上の柱は芯の距離が壁と同点になり壁が勝って消えるため）。同点は`kindRank`（memberCut 1.5・memberFace 2.2。同距離は wallFace が先）→層。壁だけの列は従来どおり distMm→層。深度上限（800）は部材の帯にも適用する（`splitOpenByFarFace`・`wallBandToOpen`・`memberFaceToOpen`）。上限を超えた梁・梁の後ろがアキの梁は、**梁が無かったときの帯**（`memberlessBands`。部材の候補をすべて除いた選択）へ戻し、付帯情報はそこから取る（梁の中に「ア キ」を出さない）。slabの中の梁はslab帯を割らず`members`に片で添える。
- **候補段階のフィルタ**（`faceStateOf`ほか）: 帯の部屋の中・断面線より下に浮かない・柱包み・規則A（手前の全高の壁が覆う区間。`wallCoveredSpans`。壁が探査の候補にならなくても遮蔽は効く。腰壁・垂れ壁越しは実高さで隠す）・面に掛かる・描画範囲（`drawnRanges`）・階段帯は天井裏（`memberCeilZAt`）。階段帯の側壁が覆う断面は部材ごとに1回判定する。
- **線種は候補が付ける`memberClass`で決める**（`sightRole`＝直近が中線では「面の通りは細線」の裁定と食い違うため）: memberFace側の値は`facePlane`→DETAIL／`airborne`→SILHOUETTE／`column`→SILHOUETTE（memberCutの`along`〔切断線が平行な梁の幅の帯を通る梁〕は別の印で、DETAIL）。**規則1: 同じ奥行きで実体の違う member 帯と wall 帯の境は DETAIL で引く**（無いと壁面と同じ面の梁型の細線が消える）。
- **列の分割**（`collectCutBreaks`）: 部材の端（直交梁＝芯±半幅・平行梁＝スパン両端・柱＝run方向の辺）を層の探査窓でクランプして足す（`nearMembersOf`・`addMemberEdge`）。足さない列は上記 dropped の3条件。**記録: 継ぎ目で天伏の面・階段裏面の足元の縁を列の境にする案（精度向上）は出力が変わるため裁定でR7に含めて見送り**。
- **描画**（`sectionEmit.js`）: memberCutは帯の縁を引かず、部材の最初の列で`sectionOutline`（H形鋼＝フランジ・ウェブの実形状12辺／鋼管＝外形＋肉厚の内側輪郭／矩形＝外形4辺。RC丸柱は外接矩形のまま）を1回描く（出所の印`MEMBER_PRIM`。階段帯の壁線の後加工から外し、構造材の経路〔`dashLinesInsideRects(behindRects)`→`clipContentBelowProfileInRanges`〕へ流す）。部材の端で割れた共線の水平線は`finalizeBand`が`joinLinesAtMemberEdges`で1本に戻す（部材の端が絡む包含の重複も畳む。部材の端と無関係な既存の分割には触れない。一般の連結は見た目不変でもバイトが変わるので採らない）。アキ: memberFaceの帯は既定でセルを割り（階段帯だけ`gapPass`で素通し）、memberCutは割らない（`obstructionRects`）。階段帯は`memberSplitsGaps:false`で割らせない。
- **柱**: memberFace（`column`・nearMm＝`depthNearMm`）。切断線が柱の幅の内側を**厳密に**通る柱だけmemberCut扱い（edgeDropped＝加算。縁が接するだけなら`cutPlaneOffsetMm`が出をmmに切り上げるのでmemberFace nearMm 0で遮蔽が効く）。縦線は見付けの両端を床〜柱の上端まで、天地の線は断面線の高さでないときだけ。柱の上端は梁と同じ天井の取り方（その位置の部屋の天井〔CH〕では切らず部屋帯は帯の天井断面が切る。柱の階の上の床〔その位置に実の部屋のある階だけ〕か帯の上端まで。階段帯だけ裏面`cut.memberCeilZAt`で止める）。slab内の片は`siblingPieceAt`で兄弟を隣に添える。

### 裁定 R1〜R7（現行規則）
R1 柱型の線種は中線のまま／R2 airborne（部屋の真ん中の梁）は中線で描く（「面の通りの梁＋切断面を横切る梁」を物差しにしつつ、空中に横断する材は天地を中線で描く2026-08の裁定を維持）／R3 独立柱・壁越しの柱が出るのを受け入れる（入口条件`onFaceWall||straddles`を落とす。壁が手前・同じ奥行きなら壁が勝つ）／**R4 部屋帯の断面は天井で切り詰める**（梁の幅に掛かる列の天井の最小値で輪郭の上端を切り、梁の下端以下なら輪郭なし。天井の段の継ぎ目の梁は低い側の天井線より上へ出ない）／R5 階段帯のアキは梁で割らない／**R6 壁の断面の縁は梁の断面に接する高さでも描く**（途切れない。`wallLineCuts`の図側の用途は別物として残る）／R7 粗さ維持（上記）。

### 梁の「壁の中」判定は`beamWallEmbedding`1関数（`sectionStructure.js`。S3）
旧3判定（1枚の壁／合併帯／同一CL）の食い違いが前セッションで判定の不一致を生んだため1関数に統合した。**全規則が同じ壁集合・同じ帯・同じ層の述語を見る**ことが価値。
- 規則: 同じ (graph, 軸CL) で**隙間なく連なる**壁の材（`wallConcealRange`＝`materialRange∪backingRange`。`boundaryMaterialRange`で合併）の**和集合**に梁の幅全体が収まる区間が「壁の中」。**壁と壁の隙間（開口）は橋渡ししない**。材厚の許容（`wallSpanTolMm`）は梁スパンの両端だけ（隅の端は柱包みの規則Bが担う）。壁は**全高の壁だけ**（隔て板は除く）。**腰壁は真下の床梁、垂れ壁は真上の天井懐の梁**（範囲＝床＋天井高−下端寸法〜直上の床。最上階は下端より上すべて。高さは`kneeDropZRangesAt`）に対して全高の壁と同じ（腰壁の天端より上の梁は隠さない。垂れ壁は床梁を隠さない）。
- **層の述語**（`beamTopInStorey`は1箇所）: 梁の天が「その壁の層の床−梁成」〜直上の床にある壁だけ（壁が立つ床の下の床梁まで。在来木造の横架材は再計算で天端FL−100になる`conformWoodBeamLevels`ので床ちょうどでは取りこぼす）。2階の床梁は2階の壁にも1階の壁にも関係する。z を見ないと3階の壁が2階の高さの途中の梁を隠した前例がある。
- 出力: `along`（梁の長さ方向の区間ごとの embedded／exposed／free）・`alongTol`（隅の許容を足した版）・`crossBands`（直交して覆う壁の帯）・`fullyEmbedded`。`structuralContribution`は fullyEmbedded で立体を落とし、`embedding`1フィールドを持つ。平行は along、直交の断面は切断位置が along の内部に無く（端ちょうどは内部でない）、室内側へ続く残り（直交壁の帯・柱包み・`alongTol`を引く）があるときだけ描く。壁の線の分断（`wallLineCutRect`）の`bandsAt`は芯で判定（`boundaryMaterialRange`の合併帯）。
- 梁が柱で分割されているか（部材の切れ目）で描画が変わらないようにする（スパンの一部だけ壁が覆う梁は壁の足元の区間だけ見え掛かりから引く）。層の判定には元の天端・成（`layerTopZ`・`layerDepthMm`）を使う（`clipBeamsToBand`が`topZ`/`depthMm`を帯へ切り詰めても同じ層で数える）。失敗系は例外を投げず描く側に倒す（壁なし→全区間free／梁が層外→その壁を数えない／幅0→芯の1点／非有限→free）。
- **面の通りの梁**（`opts.facePlane`。`cut.face`があれば既定true、帯種別によらない）: 切断線が帯の外でも細線のparallel。天井裏・描画範囲・規則Aは airborne と共有（`drawnRanges`・`wallCoveredSpans`）。面の軸と切断線の両方が梁の帯の中なら面の通りを優先。**`fromRoomSide`**（部屋帯だけ。断面の続きを室内側で見る`sectionVisibleInRoom`）は部屋帯だけが向きを変える既存の差で、解消は別課題。部屋帯の梁は階段帯と同じ室内側へ下がった仮想断面（pcut。`elevationSolids.js`の`faceBeamCut`）で解く（柱型・`clipBeamsToBand`・`clampPrimsToRun`は従来どおり。柱型の照合は壁芯基準）。

### 加算レイヤの規則（dropped の部材にも効く）
- `faceSectionCut`が face を SectionCut へ写す（断面ローカルxと面ローカルxが同値）。高さ基準は帯そのもの（baseFloorZ=0・zRange=0..CH）で、layersは自階（floorZMm=0）＋上階（`buildBandLayers`）。**帯のz範囲へクリップすることが「梁型だけが出る」建築的に正しい挙動を与える**（自階の床梁は床より下で全消し、上階の梁は梁成が「階高−CH」を超えて天井から降りる分だけ残る）。x方向は`[0, run]`へクランプ。
- **壁の材厚に埋まる梁・柱は描かない**。通り芯の交点には自動補完で柱が立つので、外壁に納まる管柱まで柱型にすると壁面の途中に実在しない縦線2本が出る。壁より太い柱・梁は室内へ出るので描く。**隠す材は`wallConcealRange`（`finish/columnWrap.js`）が柱・梁・断面の埋没判定の唯一の供給源**（外壁は`backingDepth`未指定の対称壁で軸〜外面の片側しか返さず、通り芯中心の柱が収まらず出隅・入隅で柱型が出ていた。構造種別によらず外壁生成は共通なので種別分岐にしない）。**柱の判定はその柱が立つ階の壁だけ**（平面`columnWrapSolids`のhiddenと同じ入力。全層で判定すると1階に壁の無い大部屋の独立柱が真上の2階間仕切りに収まって消える）。包みの接続索引`wallAxes`だけは全層で解く。厚み方向は完全に収まることを要求し、スパン方向は壁厚ぶんの食い違いを許容する（梁はCL間を張り壁は隅で`chamferWalls`が半壁厚詰める）。
- **見え掛かりの梁は壁・柱包みに隠れる区間を描かない**（固定mm閾値でなく構造上の述語）: (A) 空中横断は切断線と梁の間に立つ梁と同じ向きの全高の壁がスパンを覆う区間（壁のz範囲が梁のz範囲を**完全に覆う**壁だけ。腰壁・垂れ壁・隔て板・面自身の壁は使わない）。(B) 梁の厚み方向の帯が柱の包み込み外形（素の外形ではない）に完全に収まり、zが柱の層の直上の床までに重なるとき、柱のスパン範囲を描かない。断面（直交）は切断位置から室内側へ梁が実際に続き、その続きが壁の材厚と柱包みに隠れずに残るときだけ。**空中を横断する梁は天地2本をSILHOUETTE（中線）**、輪郭の縦線は持たせない。
- **自階の床（スラブ）は構造部材の見え方を隠す一般の遮蔽物**（`occludeByFloor`）: 床がある列では自階のFL**以下**（天端がFLちょうどの鉄骨梁も含む）を、部材の種類・描き方を問わず`structuralPrimitivesForCut`の全プリミティブの線のzとxだけで切る（部材名指しの特例にしない）。床の無い列（下階の階段の吹抜け。`floorlessRangesOfCut`）は切らない。階段帯の構造寄与だけが`floorOcclusion`を渡す（部屋帯は`clipBeamsToBand`が同等で、形が違うので統一していない）。**断面（閉じた輪郭）は輪郭1つの単位で判定**（開いた半分を残さない）: 床なし区間に収まれば丸ごと描く／重ならなければ線ごとに切る／**穴の縁をまたぐ**ときは階段側の壁が断面を覆っていなければ丸ごと描く（鉄骨梁を見せる設計。覆う＝梁の芯から階段側の壁の面までの距離＞梁の芯から断面の端までの距離。等号は覆わない。同じ軸CLの複数壁は`boundaryMaterialRange`で合併した1枚の帯）。丸ごと描く輪郭には`WHOLE_OUTLINE`の印を付け、階段帯の列の断面線クリップで切り直さない。
- **壁の断面線の分断**（`wallLineCuts`。dropped の部材の分）: 切断位置で梁を内に持つ壁の面のうち、描いた断面のx範囲の厳密な内側に入るもの（梁が壁の面から出ている）について、その面に立つ縦線だけを梁のz範囲で上下2片に分ける（梁の断面が壁の線の手前に描かれる。通り芯は切らない）。階段帯ではその矩形を帯に集まる全ての縦線に掛ける（`elevationStair.js`が面ローカル→帯のxへ平行移動して`finalizeBand`の dedupe の前に適用。図側の面端の太線も分けないと太線が断面を横切る）。切断位置に平行な壁が無い梁は分けない。
- **柱は仕上げ材で覆った外形で描く**（幾何は`finish/columnWrap.js`＝展開図の柱型と平面図の柱が共有する単一の情報源。構造と仕上げの境界の値なのでどちらかの層に埋めない。構造モードの伏図には渡さない）。外形は①カタログ断面 ②鋼管柱のダイヤフラム出（`diaphragmProjection`。調整口は`DIAPHRAGM_PROJECTION_MM`1箇所）③仕上げの包み。包みは**4面それぞれ独立**。3規約: (1) **柱は原則、仕上げ材で覆う**。厚みはその面に向き合う壁の「下地材＋壁仕上げ材」で、**壁自身の`backingRange`/`wallFinish`から取り、部屋の内装マスターを引き直さない**（二系統の情報源になる）。仕上げのみの薄壁（`backingRange===null`）は同じ軸CL上でスパンが重なるオーナー壁から下地厚を採る（`wallBackingMm`。柱に面するのは薄壁側で、薄壁だけ見ると包みが仕上げ12.5mmへ潰れる）。(2) **覆った柱の表面と内壁仕上げの隙間が`TRIM_GAP_MM`(150)以下ならトリム**（包みを壁の仕上げ面まで伸ばして壁と接続したものとして扱い、展開図はその壁の面に柱型を出す。150超は接続しない）。(3) **壁内は下地材・仕上げ材ともになし**（柱の面が壁の材厚の中なら覆わない）。壁埋まり判定は包む前の外形で行う。
- **平面図の柱と壁の取り合い**: **トリムで壁に接続した辺は外形・境界線とも柱側で描かない**（壁側は`columnWallCuts`が返す区間を壁の描画計画`renderer/wallDrawPlan.js`が既存のT字取り合いの切り欠きと同じ区間の差し引きへ合流させて落とす＝切り欠きの仕組みを二系統にしない）。区間は層ごとに違う（仕上げ面線＝外形幅、境界線と下地＝外形−仕上げ厚×2）。下地の削除は「その下地に乗る仕上げ材が他に残っていないこと」が条件（`canRemoveBacking`。オーナー壁の下地は両側の部屋の仕上げが乗る共有の下地。判定は壁単位）。
- **柱がどの面に現れるかは「接続した壁の軸CL（`wallAxes`）と面の軸CLの照合」で決める**。柱の断面が切断線をまたぐかで判定してはいけない（実データの壁は材厚が壁芯から室内側にあり、柱芯オフセットで壁からわずかに離れるため、壁のすぐ内側の柱が全部落ちた）。接続＝トリム150以下または壁への食い込み。壁を持たない位置の柱は断面が切断線をまたぐかで拾う。`wallAxes`は覆い厚0の壁（手動壁）でも積む。**線種は中線**（柱型は仕上げ面の見えがかり）。柱型は見付け幅の両端縦線2本のみで上下端の水平線は持たない（`topLevel`の信頼できる情報源が無く、柱は床から天井まで通しが常態）。
- **柱型の`onNearSide`（壁の向こう側の柱は描かない）の例外**: その面の通りに柱のrun範囲と重なる壁が1枚も無い区間では柱は素通しで見える。遮蔽判定は持ち込まず、切断面からの絶対奥行き＜800と「一部でも壁が重なれば描かない」で保守的に絞る。遮蔽を数える壁は帯と同じ高さに立つ層（自階）のもの（柱の接続`wallAxes`を作っているのはまさに上階の壁なので全層で数えると柱型が出ない）。
- **基礎・基礎梁・杭は描かない**（`structuralContribution`/`structuralColumnContribution`が`role==='foundation'`を除外する唯一の情報源。1平面に基礎伏図＋1階伏図が乗るので1階のgraph.beamsに基礎梁が同居しており、除外しないと床下に基礎梁が細破線で出る）。
- **有効化は`ctx.solids`の明示指定のみ**（`ElevationModeState`→`buildRoomBand`・`buildRoomBandWithVoidAbove`だけが渡す。既定=未指定で出力完全不変）。階段帯は`contentForCut`経由で同じ`sectionStructure.js`から構造材を描く。未実装: 作り付け家具（ドメインモデル未実装）・独立柱／面より手前の立体の遮蔽・斜め回転柱の見付け幅。

## プリミティブ語彙とスクリーン固定サイズ要素
既存の「図」語彙に`weight`を追加しただけ。建具記号丸（`tag`）・留め三角（`miterTriangle`。輪郭線のみ）はスクリーン固定サイズが必要なため、mm座標に焼き込まずアンカー点だけを持つ専用プリミティブにし、pxはレンダラ側で校正値（`screenPxPerMm`）を掛けて算出する（焼き込むとscale変化で見た目サイズが狂う）。破線が要る線は必ず`line`プリミティブで出す（レンダラのpolylineはdash非対応。レンダラは改修しない）。

**生成元は語彙ごとに別**：展開図（Konva）のプリミティブは`elevationPrimitives.js`、SVG（建具モード姿図・構造断面図）のそれは`structural/sectionFigure/svgFigurePrimitives.js`。両者の`dim`は引数順（と生成キー順）が違う別物なので、同じ呼び出し側で混ぜない（キー順の違いはそのまま出力差になる）。

### L字の角の外角を閉じる（`renderer/figureLineJoin.js`）
canvasのlineCapはbutt（未指定）のままにし、Konvaへ渡す直前のpx座標だけを角の2点に限って動かしてすき間を閉じる。**モデルmm座標・ゴールデンテストには一切触らない**。対象はモデルmmの端点が厳密一致する「ちょうど2本」の角のみ（3本以上・T字・破線・同一直線上・細線同士は対象外）。角度・延長量の計算はpx変換後の座標で行う（変換にy反転や不等倍がありうる）。
- 共通の判断を1つの純関数に寄せ、レンダラ（`.jsx`）は返り値を描くだけにする（判断をレンダラに残すと変異テストで守れない）。適用先: 展開図（`renderer/figurePrimitivesKonva.jsx`）・敷地モードの境界線（`site/siteLineJoinPrimitives.js`）・階段レイヤ（`finish/stair/stairLineJoinPrimitives.js`）・構造レイヤの柱の仕上げ包み（`structural/columnWrapLineJoin.js`。柱単位で解決し他の柱の包み辺とはマージしない。壁と取り合う辺は壁側に任せる）・平面の段差断面レイヤ（`finish/stepSectionLineJoin.js`）・SVGレンダラ（`structural/sectionFigure/svgFigureLineJoin.js`。効果は階段模式図に限られる）。
- 敷地・階段・柱包みのようにKonvaの親Groupのscale/offsetへ変換を委ねるレイヤは、join計算を実スクリーンpx空間で行う（しきい値・延長量がpx前提）。往復（worldToScreen→join→screenToWorld）は`renderer/planLineJoin.js`に切り出し済み: strokeScaleEnabled未指定（Group拡縮継承）のレイヤは`resolvePlanLinePointsMmScaledStroke`（strokeWidthは世界mm相当なのでviewport.scaleXで往復換算し、最終的な見た目は変えない）、実px直指定のレイヤは`resolvePlanLinePointsMm`と呼び分ける。
- 柱壁は細線が既定で実1.0pxにfloorされ「細線同士は延長しない」規則により既定ズーム（scale<=4）ではL字延長が発火しない。1/1より拡大（scale>4）で発火する（延長量は相手半幅固定）。**この挙動のまま受け入れる**（ユーザー決定）。

## 面の配置・注記帯
- 面配置・壁芯間寸法は`face.lo/hi`（仕上げ面）ではなく`faceBoundaryLocalX`（壁中心線）基準（壁面線=CUTのみ仕上げ面基準）。`buildRoomBand`/`buildStairBand`の面配置ループ・帯確定処理は`elevationBand.js`の`layoutBandFaces`/`finalizeBand`へ一本化済み（共有先を`elevationPrimitives.js`にしないのは、同ファイルが`elevationFigure.js`からimportされており`buildFaceFigure`を使う帯レイヤを置くと循環importになるため）。
- **実画面mm指定の量（面間ギャップ・部屋名枠余白・留め三角アンカー・注記帯の各段位置・左スクロール余白）は倍率換算に2パス構築を要する**（1パス目=仮値で帯の高さ→倍率を確定、2パス目=`screenMmToModelMm`で実値換算。倍率決定が先でないと循環参照）。
- 水平寸法は寸法線足を出さず、壁中心線・通り芯自体の一点鎖線を寸法線位置まで下ろし交点に塗り丸(`dim.dot`)を置く（CH寸法の足のみ残す）。**CH寸法の足はCLに触れず、CLから実画面3mm（`DIM_FOOT_GAP_SCREEN_MM`）手前で止める**（足の終点は必ずその寸法自身の側のCLの手前になり、階段展開図で反対側のCLまで伸ばさないも同じ1規則で満たす）。寸法値は寸法線の**上側**。床線から下へ①tag②寸法の鎖③通り芯丸+面ラベル(同じ段)の順。
- **寸法は1行だけ**（ROW2の独立行は廃止し、通り芯を鎖の分割点として統合。「壁幅が通り芯をまたぐ場合は通り芯から」も、両端＝壁中心線・内部の分割点＝通り芯というこの鎖1本で満たす）。通り芯丸は背景色(`CANVAS_BG_COLOR`。`renderer/canvasStyle.js`。index.cssの`#root`と手動同期)で塗り一点鎖線の上に描く。
- **通り芯の縦線は寸法行で2本に分ける**: 上は一点鎖線・下（寸法行〜丸番号）は**実線**（1本の一点鎖線で丸まで通すと寸法行が破線のすき間に当たって交点が消え、丸の手前で破線が切れて丸とCLが離れて見える）。**一点鎖線の位相**: canvasの破線は始点から位相が始まり端や交点がすき間に当たるため、プリミティブに`dashAnchor`（寸法行のy）を持たせ、レンダラがその点を長い破線の中央へ合わせる（`renderer/dashPhase.js`。react-konva非依存の純関数）。
- **面に乗る通り芯の判定範囲は`face.lo/hi`ではなく面の両端の壁中心線（boundary）**（`face.lo/hi`は直交壁の室内側仕上げ面へ詰めた端なので面端の通り芯が常に除外されていた）。範囲は`face.lo/hi`とboundaryの和集合**ちょうど**（それ以上は広げない）。
- **中心線は寸法の鎖を割らない**（中心線は壁を伴わない作図補助。分割を担うのは実体と通り芯だけ）。**「通り芯か」の判定は`isGridCenterLine`（`core/centerLine.js`）に一本化**（`cl.labeled`単独は不可。`labeled:true`のまま残った中心線がありうる。`core/clQuery.js`の系統A〔discipline不問のグリッド軸〕と系統B〔通り芯〕は別物）。
- **注記帯の全ての段位置はスクリーンmm基準の独立定数**（tag行/ROW1/ROW1〜丸行の3つ。モデルmm固定だと縮尺次第で重なる）。3つは互いに独立に調整する（一方を他方の倍数として式で導出すると承認済みの見た目が機械的に動く）。面ラベルと通り芯丸が近いと`avoidGridCollisionX`が最も広い区間の中点へ面ラベルを退避させる。`layoutBands`の`placement.topMm`は`band.bounds.minY`に対応する（`bandContentOriginMm`。取り違えると天井線がはみ出す）。

## FL高さ（floorOffset）: bounds は floorOffset=0 のときの描画範囲
`Room.floorLevel`由来の`floorOffset`は帯内の全プリミティブをy方向へ平行移動するが、**bounds は floorOffset 適用前の描画範囲を表す**（シフト後の座標で計算すると、帯スロットの上端を帯自身のbounds.minYへ再アンカーする`bandContentOriginMm`が一様シフトを打ち消し、見た目に一切効かなくなる）。隣接帯との実すき間はfloorOffset差だけ縮むため、積み上げ専用の`heightMm`/`topMarginMm`（`layoutBands`消費）で対処する。両者は排他（floorOffsetの符号で片方にしかせり出さない）なので`heightMm`に`Math.max(0,-floorOffset)`、`topMarginMm`に`Math.max(0,floorOffset)`を加える（一律`Math.abs`だと使わない側が過剰予約）。段差高さ自体の寸法線は描かない（`floorOffset`は部屋帯全体の階基準ズレで、壁際の段差とは別物）。

## 展開図の対象部屋（selectElevationRooms）
- **無名でも階段室（feature=STAIR）は展開図の対象**（旧仕様は無名を一律除外し、名前を付けない階段室の展開図が出なかった）。通常部屋・吹抜け（VOID）は有名のみ、STAIR_VOID・屋外・部分指定は対象外。見出し・失敗通知・ログの表示名は`elevationRoomDisplayName(room)`（`elevationFaces.js`）が唯一の供給源（無名の階段室は既定名「階段」＝`finish/roomNamingOptions.js`の`DEFAULT_STAIR_ROOM_NAME`）。`room.name`を直接読まない（`elevationRoomName.wiring.test.js`で固定）。吹抜け帯の上階の部屋の拾い（`elevationVoid.js`の`upperFaceRooms`）にも無名の階段室が入る。
- **部分指定（`referenceRoomIds`非空）は対象から除外する**（独自の帯を持たず親の帯の中で段差プロファイルとして表現される。除外しないと同じ壁面が重複して展開される）。

## 床の段差プロファイル（部分指定）
部分指定Room（`referenceRoomIds`で親を参照）が親の壁際セルの一部を占め`floorLevel`が異なる場合、床線は段差付きの階段状polylineになる。`elevationFloorProfile.js`の`wallAdjacentFloorSegments(face, parentRoom, graph)`が、面に接する親自身のセル（`finish/gridCells.js`の`refreshCells`/`cellBoundsFromKey`を再利用）を壁沿いに拾い、部分指定のセル集合に含まれていればその`effectiveFloorLevel`差分、含まれなければ0を割り当てて区間配列にする（同値の隣接区間は結合）。
- **極小(<`GAP_EPS`)幅の区間はfloorDeltaMmが前後と異なっていても前（無ければ次）の区間へ強制的に吸収してから通常のdelta一致マージへ進む**。CLの昇格/降格・再スナップで「同じ位置のはずの別CL」を参照すると隣接セル境界に極小の誤差が生じ、「子→親(極小)→子」という見た目上の1往復になる。epsilonはこの吸収処理1箇所に一本化（gap-fill・末尾判定側には持たせない。生成される極小区間は結局ここで除去されるため）。
- **欠測区間**（自室セルの境界がface側で粗く、touching配列に隙間ができる）は無条件に親扱い(floorDeltaMm:0)へフォールバックしない。`probeGapOwners`（`collectRunBreaks`/`findRunCLAt`と共に`elevationFloorProfile.js`へ統合）が欠測区間をrunの伸びる方向のCLで刻んで個別に`worldToCell`プローブし実際の所有Roomを求める（所有者が見つからない区間だけ従来通り親扱い）。
- `buildRoomBand`/`buildStairBand`が`ctx.floorSegments`として渡し（未指定時はフラット1区間）、床線は区間ごとの水平線＋段差の縦線（すべてCUT。寸法は描かない）になる。両端の出隅縦線もこの区間配列の先頭/末尾から実際の床・天井高さを読む。段差がある面(`segs.length>1`)は図の右側にも左と同じ様式でCH寸法を追加する（値=右端区間の実際の床〜天井距離）。
- **直前の面の右端区間と次の面の左端区間で床・天井の起点が変わる継ぎ目では、次の面の左側にもCH寸法を描く**（`segEndProfile`＋`layoutBandFaces`の持ち回り比較）。**端区間は素の（描かれるまま）先頭/末尾区間を読む**（入隅に挟まる半壁厚程度のgap-fill区間も実際に床として描かれる。幅閾値の読み飛ばしは実機と逆で撤回）。**段差見付け面も継ぎ目判定に参加する**（床=`baseFloorDeltaMm`・天井=`ceilAbsMm`。除外するとC1の左CH寸法が出ない）。右へ`CH_DIM_OFFSET_MM`ぶん描画範囲が伸びるため、隣接面の間隔(`gapModelMm`)は壁中心線間ではなく「前の面の右CH寸法込みの右端」〜「次の面自身のboundary.lo」で確保する（`prevRightExtent`。左側は帯先頭面にしか左CH寸法が付かないため対象外）。面自身の壁のない端の延長ぶん（`faceWallLessExtents`。`buildRoomBand`/`buildStairBand`共有の純関数）も加味する。
- **段差位置の描画x**: 段差の描画位置（区間水平床線の端x・段差縦線x・巾木・壁2段書きの障害物区間の4箇所）は寸法・CL一点鎖線が使う`segs[i].hiX`（オフセット前）そのものではなく、`drawnRiserX(segs,i,halfWallMm)`＝「床が低い側へ半壁厚ずらした位置」を使う（寸法線・CL一点鎖線と別の値として持つ設計。重なって見づらくなるのを避ける）。段差見付け面のROW1境界は両端の直交壁面（`perpFaceAt`で求めたloFace/hiFace）自身のaxisCL.idを`startCLId`/`endCLId`に使う（段差自身のaxisCL.idを両端に詰めると`faceBoundaryLocalX`が幅0の退化した境界を返す）。

## 天井高さの解決（フォールバック・部分指定の段差調整）と区間別天井断面線
`finish/roomMetrics.js`の`roomCeilingHeight(graph, room)`が仕上げ表・展開図共通の唯一の情報源。数値化できない自由入力（傾斜天井のレンジ表記）は`graph.defaultCeilingHeight`で作図しラベルは原文。部分指定が自身のCH指定（非数値の明示指定も含む）を持たない場合、天井の絶対高さを親と揃えるようCHを段差ぶん増減する（部分指定CH = 親CH − (部分FL − 親FL)。**FLが親と同一でも親CHへ揃える**＝そうしないとFL同一の部分指定が既定CHへ落ちて偽の天井段差になる。親を再帰的に解決・循環ガードあり。自身の明示指定は常に優先）。**計算結果が0以下なら物理的に不可能としてgraph.defaultCeilingHeightへフォールバック**（isFallback:true）。

**天井断面線は区間（エリア）ごとに「その区間の床断面からその区間のCHの距離」に描く**。segsが床(`floorDeltaMm`)と対で`chMm`（区間所有Roomの解決済みCH）を持ち、区間結合もfloorDelta+chMmの両方一致が条件。CLをまたいで天井の絶対高さ(FL+CH)が異なる境界は縦線（CUT）になり、描画xは「低い方からみてCLの向こう側」＝天井が高い側へ半壁厚ずらした位置（`drawnCeilingRiserX`。床の`drawnRiserX`と対の規約）。自CH指定なしの部分指定は天井絶対高さが親と揃うので水平1本＝天井段差は明示CH指定時のみ現れる。端の縦線・開放スパンのアキ上端／境界縦線・右CH寸法・左CH寸法（帯先頭面。左端区間が帯自身のときのみ原文ラベル）・袖壁断面の高さ・注記一点鎖線の突き出し上端（面内最高天井基準）も区間別天井に追従する。`chMm`未指定のsegs（単体テスト等）は帯CHの水平天井へフォールバック。
- **高低差のある、階の異なる天井断面線どうしは結ばない**: 区間が持つ`ceilFloorZMm`（その区間の天井が属する階の床レベル。既定0。上部吹抜けの多層書きだけが上階の値を入れる）が違えば、段差の縦線を描かず境界の描画xも半壁厚ずらさない。別の階の天井どうしを1本の輪郭で結ぶと、境界に立つ壁の断面（エンジンが壁厚の両縁として描く）と二重の縦線になり、結び線は壁厚を持たないため「何の線か」読み取れない。
- **床断面下・天井断面上の破線（向こう側の断面）は「壁の向こう側に部分指定関係のある部屋がある面（またぐ面）のみ」**: `familyCeilingSegments`は面のaxisCLのfar側を区間ごとにworldToCellプローブし、部屋ファミリー（親＋部分指定の子）が所有するセルがある区間だけ返す（`ctx.beyondCeilings`。全セルのrun軸投影方式は、同じ室内の別エリアがrun座標上で重なるだけで外周面にも破線が出たため撤回）。描画は論理区間（segs）の天井断面と比較し、断面より上のみ細線の破線（描画済みrun範囲との比較だと論理境界一致面で半壁厚の偽スリバーが出る）。開放スパン区間は同じ高さのfar天井線の管轄のため差し引く。bcごとの断片は接する区間をマージして1本で積む（破線位相の分割防止）。断面と同高・断面より下のエリアは描かない（類似規則への拡張は明示指示がある場合のみ）。far天井線・far床線の端xは論理span境界のまま（天井段差の±半壁厚オフセットとは半壁厚ずれる。床側と同一の既知挙動）。

**天伏の平面（flat）の区画**（`elevation/space/zoneCeiling.js`が点問い合わせの唯一の入口）: 式は「区画の`chMm` ?? 部屋のCH」の1つだけ（床段差込みの`zMm`は使わない。エンジンの`floorZFor+ch`・体裁の`floorDeltaMm+chMm`が床段差を足すので二重加算になる）。エンジン（`spaceModel.js`の`cellAt.ceilZ`・`buildLayerStack`）と体裁（`wallAdjacentFloorSegments`）は同じ点（切断線＋視線方向の探査点／区間の中央）で引く。区画の境界は天井芯の上で壁が無いので区間を境界で割り、その小口（`zoneCeilEdgeHi`）は`drawnCeilingRiserX`/`drawnRiserX`ともずらさない。他の部屋の面は部屋のCHに落とす。遠側の天井（cellsAlong・開放スパンの`farCeilAbsMm`・家族の破線）も同じ式で区画に追従する。
**傾斜・円弧・ドーム（E3a/E3b/E4）は自室の天井だけ追従する**。
- 傾斜: 体裁の区間が両端の高さ`chMm`（loX側）・`chHiMm`（hiX側。傾いた区間だけ）を持ち、`ceilProfileFromSegments`が`ceilZHi`に写してエンジンの壁の帯が斜線に沿う。**天井の斜線は体裁が引く**（傾いた区間は隣と結合しない独自のrun。区間の外〔壁の無い端の延長・上階のはり出し・境界の半壁厚ずれ〕は端の値で水平な別の線＝延長の端から反対の端まで1本で結ぶと勾配がずれる）。**評価する奥行きは壁の仕上げ面（`face.faceValue`。実壁が無い面は芯）**（芯で評価すると奥の壁際の天井が実際より高く出る）。層スタック（`cellAt.ceilZ`）は既定では面の最高点（`zoneCeilingChTopAt`）で、打ち切りの正確な高さは体裁の`ceilProfile`が担う。**例外: `cut.ceilProfile`を持たない切断（階段帯）の層スタックは、列の幅を切断線の深さで評価した傾斜の最大値**（階段帯では層スタックの`ceilZ`が帯の上端と天井の段を決めるため、最高点だと傾斜の部屋を壁越しに見る列の段が実高さより上に出る）。`ceilProfile`を持つ切断は`span`を渡さない。
- 円弧・ドーム: 開始点・頭頂点・終了点の3点を通る円弧で描く（供給源は`zoneCeilingChAlong`の`includeCurved:true`。既定nullのまま遠側は部屋のCH）。体裁の区間は頭頂`ceilArc:{alongX, chMm}`を持ち1面＝1片。円は`ceilArcSection.js`が求め円弧プリミティブ1本を引く。**エンジンは円弧を弦で受ける**（`ceilProfileFromSegments`が頭頂を節とする弦の列〔鉛直差1mm以下・4〜64本〕へ展開し、`ceilEdge`機構がそのまま動く）。
- 遠側（開放スパンの`farCeilAbsMm`・エンジンの`cellsAlong`）: 視線の先の傾斜は**同じ面が続く範囲の奥の端**の高さで描く（`zoneCeilingFarEdge`が唯一の入口。奥の端に面と平行な中心線〔天井芯は除く〕があればその壁の仕上げ面、無ければ座標）。**向きで分担する**: 勾配が奥行き方向なら遠側は奥の端の高さの水平線1本、走り方向なら体裁だけが斜線1本（`farCeilAbsMm`〔loX側〕と`farCeilHiAbsMm`〔hiX側〕）で**エンジンの`cellsAlong`はその片の`ceilZ`をnullにする**（階段状にしない）。部分指定の子を覗く場合は体裁とエンジンが両方通るため**同じ値**であることが二重線を防ぐ条件。`cellsAlong`は同じ部屋でも天井の面が変わる所で割り（`zoneCeilingDepthEdges`）、`nearestFaceInRange`が範囲内で最も手前の`ceilFace`を選ぶ。**奥の端の探索と壁を探す幅は片の走り範囲全体**（中央の点だけで探すと範囲の端にしか無い壁を取りこぼす）。**壁との重なりが`SHORT_WALL_IGNORE_MM`（100mm）未満なら壁無し**（出隅の72.5mmだけで片が割れ数mm違う高さの破線が出るのを防ぐ。走り範囲そのものが100mmより狭い問い合わせは範囲いっぱいを必要な重なりとする）。
- 家族の破線の傾斜追従: 破線は壁の向こうの天井の**断面**なので、評価点は見えがかりの仕上げ面ではなく**壁の外側の仕上げ面**（`outerWallFaceAt`。実壁が無い区間は芯）。傾いた片は斜線1本とし、近側の天井断面との差が正になる部分だけを描く。傾いた`bc`は同じ直線の遠側天井線を持つ開放スパンの区間を差し引く。右CH寸法は区間が1つでも両端の高さが違えば立つ（`hasRightChDim`）。
- **傾斜天井の受け口（断面エンジン）**: `cut.ceilProfile`の区間は任意の`ceilZHi`を持てる（**1区間1線分**。円弧は折れ線へ刻んで渡す。列ごとの天井サンプリングは採らない）。傾いた列は`ceilZ`＝低い側に加えて`ceilEdge`（隔て壁の`topEdge`とは別の意味なので流用しない）を持つ。**打ち切りは低い側で水平が原則で、例外は「低い側より下から高い側まで届く切断壁」だけ**（その壁の帯は上端が高い側・`ceilEdge`付きで天端と側縁が斜線に沿う。天端の斜線はエンジンが引かない）。段違い天井の例外は、傾いた列では隣の空気の上端が壁の連なりの露出側の端での斜線の高さ以下なら適用しない。
- **打ち切り専用の受け口`cut.ceilClip`**（階段帯の裏面のための口）: `ceilProfile`と同形で**打ち切りだけ**に効く（`ceilClipProfileOf`＝`ceilProfile ?? ceilClip`経由で、列の分割・列の天井・斜線を頭打ちにする列境界の3か所だけが読む）。**帯の性格判定は`ceilProfile`のまま**（`slabEdgeCutWallJunction`/`ceilStepSlabSection`の分岐・探査窓gate・`cellAt`の`span`分岐）。`ceilProfile`を付けると階段帯全体の性格が変わるので口を分けた。ceilClipで列に`ceilZ`が付くと`clipBandsToVisible`が天井より上のslab/openの帯を落とすため、階段帯のslabの輪郭は打ち切り後の列には残らない。

## 開口（建具）の展開図表現
- 開口は`openings/openingElevationFigure.js`の`buildOpeningElevation`（建具モード編集用姿図と同一の純関数）を`includeDims:false, includeMotionArrows:false, includeLevelLine:false`で再利用し、枠・吊元表示・機構表現・レバーハンドルだけ残す（両モジュールともFL=y0・上方向負で座標系が一致するため配置は`(x,0)`平行移動のみ）。建具記号丸は開口の中心ではなく姿が見える図の下（tag行）へ。
- **`openingsOnFace`は`wallSide`で絞らない**: 開口は物理的にその場所の壁すべてを貫通するため、共有壁の建具は両側の部屋の面に出る（`findOpeningsOnWall`と同じ考え方。クリックした側にだけ出す旧仕様は反対側に建具が出ない実機不具合の原因）。**姿図の正準向きは「世界座標昇順＝図のx昇順」**（吊元`hingeSide<0`＝`coord1`側＝図のx=0。平面記号の`hingeAlong`と同じ世界アンカー）なので、世界順とローカル順が反転する面（`dirSign<0`。裏側から見る面を含む）では`mirrorPrimitiveX`で左右反転してから置く（しないと吊元・親子扉の子・レバーハンドル等の非対称要素が逆端に描かれる）。
- **床に高低差がある面（`floorSegments`）では、建具・直交壁の建具断面ともその位置の実際の床に乗せる**（開口中心位置の区間の床yへ平行移動`floorDyAt`。窓の`sillHeight`も「その区間の床からの高さ」になる。段差をまたぐ開口は開口中心の区間を採る）。
- 直交壁（隣・次の面）の建具が切断位置（面端）にかかる場合、`openingsReachingCorner`（隣接面自身の隅=0/runに開口スパンが届くか）で対象を選び、`openingSectionPrimitives`が[枠(CUT)][扉(SILHOUETTE)][枠(CUT)]の3rectを面の両端の帯に描く（`buildRoomBand`/`buildStairBand`が`faces[(i∓1+n)%n]`をprevFace/nextFaceとして渡す）。帯は**直交壁の材の範囲（`wallMaterialRangeForOpening`）の上に置く**（枠は材の範囲±`FRAME_OVERHANG_MM`。面端から部屋の内側へ伸ばさない。壁が引けない合成faceだけ既定の見込で面端の外側）。面端の縦線は、この隅の建具断面を描く建具の開口範囲では描かない（窓台〜上端を引いた残り。sectionEmitのopeningPassThroughと同じ規則）。床まで達する建具（窓台のある窓を除く。巾木と同じ述語）の隅断面がある端では、**区間の床断面線を断面の外縁まで伸ばす**（扉の下で床が隣室へ続く。天井線・巾木・面端の縦線・`drawnX0/Run`は伸ばさない。`floorSpanX`のクランプ後に適用し`lowerOverhang`とは遠い方を採る）。
- **三方枠（機構 FRAME_ONLY。S10-10・2026-10-25）の断面**は描き方`frameOnly`（`openingSection.js`。判定は記号ではなく機構＝姿図と同じ）: 上枠の断面（見付＝`frameOnlyInnerRect`の fw〔開口幅の半分で頭打ち〕・見込＝**壁全体の面から面`wallFaceRange`＋2×出幅**＝平面の方立・建具モードの見込み欄と同じ式。木製 solid は閉じた矩形・鋼板 bent は開いたコの字を縦にした polyline。CUT）＋竪枠の見え掛かりの縦線2本（上枠の下端〜床。細線）。扉・下枠は描かない。片開き戸の「当該部屋側の壁1枚」は三方枠には適用しない（枠は壁を包む）ので、切断壁の帯には`band.openingWallRange`、隅は`openingSectionWallRange`で壁全体の範囲を渡し、帯の始点は`openingSectionOverhangMm`（三方枠＝実効の出幅・他は12のまま）。隅の床線の延長は rect だけでなく polyline の x 範囲も見る。実データに切られる三方枠は無く（14.stq の WF 1件は隅にも掛からない）、基準は合成文書`golden-elev-opening/frame-only-section-test`（`makeFrameOnlySectionTestDoc.mjs`。隅の経路だけ。切断壁の経路は`sectionProbe.test.js`の合成テスト）。見付に1px保証は付けない（LODで分岐しない方針）。

## 腰壁の天端・端部の見えがかり
- 天端は壁の上端から下への帯（`.claude/data-model.md`参照）なので、面自身が腰壁のときは**上端＝天端を中線・下端を細線**の水平2本で描く。**見付は実厚(`CAP_THICKNESS`=30)ではなく`KNEE_CAP_FACE_MM`(=50)**（実厚のままだと2本線が縮尺で潰れるため作図上だけ広げる。モデルの寸法は実厚のまま）。端部（端部抑え）も端に縦の中線＋内側`KNEE_CAP_FACE_MM`の縦細線（天端の出`CAP_OVERHANG`は厚み方向だけなので端部の中線は壁端に立つ）。**描かない端**: 面端でクランプされた端（縦線は`hasWallAtLocal0/Run`が描く）／同じ軸上に壁が続く端（連続する壁は同面）。直交する腰壁が断面枠（`partitionCutAtLocal0/Run`）として出る側は枠の上辺が天端なので帯の下端の細線だけ足す。天井まで届く袖壁（`topHeightMm=null`）には天端が無い。
- **断面エンジン側にも同じ天端が要る**（`sectionEmit.js`の`kneeCapUnderline`。下階の帯へ多層書きされた上階の腰壁は`buildFaceFigure`のグラフに無い）。天端の水平線を描く3経路（`cut`の`cutWallTopEdges`／`cutAlong`の上端／`wall`の上端）それぞれに帯の下端の細線を足す。条件は「その上端を実際に描いたとき」かつ「上端が天井より下＝天端が露出」（垂れ壁は下端側が露出するので自然に外れる）。
- **腰壁レコードは「その壁が区間の構成壁」であるときだけ効かせる**（`kneeDropRecordsAtPointOnWall`）。壁端は隅の取り合いで隣区間へ半壁厚(57.5)食い込むため、列の点クエリだけだと全高の壁の端57.5mmだけが隣区間の腰壁の高さになる（腰壁の残骸とCL上のエッジの2症状）。平面（`resolveKneeDropOverlays`）が同じ隅を同じ閾値（`SPAN_OVERLAP_EPS`=150）で除外済みなので、同じ判定を片方の消費者にだけ入れない。区間に丸ごと収まる150未満の短い壁は構成壁として扱う。**逆に壁自身が区間の構成壁のときは、隅の食い込み部でも腰壁指定を効かせる**（点クエリが0件かつpointCoordが壁自身の端から`CORNER_OVERHANG_EPS_MM`(=150)以内のときだけ検索窓を広げて再クエリ。**壁自身の端から150mm以内に限る**。区間境界どうしの間隔で絞ると結合された長い壁の区間境界手前を拾う誤爆になる）。
- 「腰壁の上に縦線を出さない」は上の「線種」節（`hiddenByCutWall`と`uncoveredZRanges`を水平/垂直の両方に適用）。

## 壁の無い辺は展開図の面にしない
面は部屋の輪郭の辺から作られるため、壁が1本も生成されていない辺（階段の上り口・下り口。`generateRoomWallsFromOutline`が`stairOpenings`でスキップした辺）にも面ができる。`innerWallFaceAt`がnullを返した面は`hasRealWall=false`（`faceValue`はCL芯へフォールバック）になる。**それを面リストから落とす**のは`composeRoomFaces`の最後（隅のスナップ・開放スパンの延長・袖壁分割をすべて済ませた後。残る面の端の情報を変えないため）。**例外は階段帯のみ**（`keepWallLessFaces:true`）: 上り口の面はレーン範囲の算出（`switchbackCuts`のwEntry）に使うので落とすと切断表が組めない。**幾何の入力と描画の面リストは分ける**（`buildStairBand`の`composedFaces`／`drawableFaces`。フォールバック経路で`composedFaces`をそのまま描くと同じ不具合が階段帯側で再発する）。

### 不変条件: 部屋の展開図の面は必ず平面の実壁に対応する
「ここに壁面がある」と主張する面の生成箇所は次の4つだけで、部屋帯へ流れるのは上2つ。新しい生成経路を足すときはこの表に追記し、平面照合の根拠を明示する。

| 生成箇所 | 照合根拠 | 部屋帯へ流れるか |
|---|---|---|
| `buildRoomFaces`（部屋の輪郭の辺） | `innerWallFaceAt`が実壁を見つけたか＝`hasRealWall` | ○（falseは落とす） |
| `insertStepFaces`（段差見付け面） | 部分指定Room間の床レベル差（床の段差そのもの） | ○（`kind:'step'`として別扱い） |
| `buildMidWallFace`（階段の往復間） | `hasRealWall:!!wall`。壁が無ければレーン境界の切断面で壁面ではない | ×（階段帯のみ） |
| `faceFromCut`（断面エンジン） | 主対象壁が無ければ`hasRealWall:false`＝見返り・到達端の切断面 | ×（階段帯のみ） |

下2つは「壁ではない切断面を意図的に切る」階段固有の概念。部屋帯の面が実壁と対応しない状態になったら不具合。

**修正済み**: `buildMidWallFace`（合成面）の`lo/hi`は`loWorld/hiWorld`の大小に関わらず（`travelSign<0`だと`loWorld>hiWorld`になりうる）`Math.min/max`で正規化し、対応するCLId（`startCLId/endCLId`）も入れ替える（未ソートだと`run`が負値になる）。

## 面端の不変条件・壁2段書き
### 面端と壁のない端部
- 面端の縦線（見えがかりエッジ）は`x=0`/`run`（`face.lo/hi`＝直交壁の仕上げ面。`snapFaceEndsToCorners`の隅詰め結果）に描く。壁中心線（`boundary.lo/hi`。ROW1壁芯間寸法・通り芯一点鎖線の別の基準）とは異なる既に正しい基準。面端は「壁のない端部」と「出隅」を区別する。**壁のない端部**（`hasWallAtLocal0/Run`がfalse）は「続きがある」建築表現として床線・天井線を`WALL_LESS_END_EXTEND_SCREEN_MM`（2パス換算）ぶん図の外側へ延長し、縦線は描かない。**出隅**（壁がある通常の面端）の縦線はSILHOUETTE（中線。切断面ではなく壁が折れて隣の面へ続くだけの見えがかりの角。床線・天井線・段差の縦線・直交壁建具断面の枠は部屋の輪郭そのものなのでCUT）。
- **この延長は図形側（`drawnX0`/`drawnXRun`）だけでなくcontent（断面のレイキャスト）側にも効く。方式は「出来上がった線を後から引き伸ばす」のではなく「探査範囲そのものを外へ広げる」**（A案裁定。面の外は探査されておらず腰壁の外側面の位置〔壁厚〕が分からずZ字プロファイルを組めない）。階段帯は`stairFaceSequence`が`wallLessEndExtendModelMm`を`withProbeExtension`へ流し、`hasWallAtLocal0/Run`がfalseの側だけ`cut.line.probeExtendLoMm/HiMm`（world側のlo/hi）を立てる。`collectCutBreaks`は広げた範囲で断点を集め、**面の端（`line.lo/hi`）自体も列境界として必ず残す**（面の内と外が1列に融合しないため）。`cut.line.lo/hi`は変えない（`cutOriginWorld`が動かない）。`emitColumns`側には延長処理を置かない（二重に伸びる。回帰ガードは`sectionEmit.test.js`の「【裁定A案】」）。
- **壁のない端部の判定は「隅に直交面が存在するか」ではなく「その隅に実壁があり、かつその壁がこの面の切断面を室内側へ横切っているか」**（`realWallAtCorner`＋`perpWallCrossesFacePlane`。閉じた部屋の面ループでは隅に直交面自体は必ず存在する）。**実壁の有無は「隅の局所プローブ」で見る**（`innerWallFaceAt`へ渡すスパンを面の仕上げ面を挟む±100mmの窓へ絞る。直交面の面全体のフラグを流用すると遠い側にだけ壁がある構成で何も無い隅に線が出る）。**窓は面の両側に取る**（実壁が向こう側へ折れて続く角のエッジを落とさないため）。実壁が面の向こう側だけにある端は壁のない端部として扱い、延長に加えて**見えがかりエッジ**（`edgeAtLocal0/Run`）の縦線（中線）も描く。端座標は直交面のfaceValue（壁の実端）へ詰める。開放スパンの延長端（`resolveEnd`）も同じ規則。壁生成スキップで発動する典型は階段の上り口辺・下り口辺。
- **面端の壁は「この帯で実体として数える壁」に限る**: 階段室が自身は壁を持たない辺で階段下部屋の2a壁を隅の実壁と誤検出しないよう、階段帯は`composeRoomFaces`へ`wallFilter`（`stairBandWallFilter`。`isHiddenWall`と同じ判断）を渡し、除外された壁が実在する端は`face.hiddenWallAtLocal0/Run`として公開する。**真に壁のない端部は単一情報源`wallLessEndAt(face, end)`**（`!hasWallAt && !hiddenWallAt`）で判定し、体裁の延長に関わる全箇所がこれを呼ぶ（hidden端が体裁の延長を受けると2F床の小口が広がる）。**例外は探査窓**（`withProbeExtension`）: 探査は`hasWallAt*=false`だけで広げ続ける（締めるとその壁を手掛かりにする描画が列ごと消える）。**「探査は広げる・描画は締める」**。hidden端の延長区間にcontentが描く水平線は`clipContentAtHiddenEnds`が真の境界へクリップする。
- **面端縦線の担当範囲はこの帯自身の実壁の高さまで**: 2層帯で、その端に実際に上階FLの断面線（`upperFloorEdgeSpans`）が1本引かれる場合に限り、天井まで伸ばさず上階FLとこの面の天井の低い方で止め、先は上階の床のはり出し・壁の縁に任せる（`capsAtUpperFloor`。gateは`upperFloorEdgeSpanAt`と同じ関数を共有する。`ctx.upperFloorEnds`の有無だけ見ると線が1本も引かれない端でも縦線の上端が宙で途切れる）。隣接面の間隔（`gapModelMm`）は右CH寸法に加え壁のない端の延長ぶん（`faceWallLessExtents`）も加味する。
- **面端の隅で建具断面を描く建具の開口範囲では、面端の凹み側面線（`recessLo/Hi`）を描かない**（面の端の列だけ。面図の面端の太線と同じ入力`cornerOpeningZRanges`→`ends.cornerOpeningZLo/Hi`）。階段帯は対象外（限界）。
- **`buildRoomFaces`の隅マッチングは「同じaxisCLIdを持つ複数面」を区別する**（張り出しで1本の壁面が開口を挟み複数区間に分かれると`Map<axisCLId,Face>`は後勝ちで片方が消える。`groupByAxisCLId`+`findCornerNeighbor`が隅を実際に共有する1件だけを選ぶ）。

### 「その面のどこに壁があるか」は1つの述語
`elevationFigure.js`の`wallLessRunsOnFace`＝壁の実体が無い区間＝開放スパン(描画基準)＋多層合成で延長された範囲＋**実壁（graph.walls）の被覆の隙間**（`elevationFaces.js`の`wallCoverageGapsOnFace`。第3の源。`face.spans`の'wall'区間は部屋の連続性由来で、その内側に壁が生成されていない区間があっても'wall'のままなので実壁の被覆が要る）。**面の端(0/run)に接する側は、`hasWallAtLocal0/Run`が真（壁のある端＝出隅）の側では常に報告し、偽（壁のない端部）側は幅`END_ARTIFACT_TOL_MM`(=150)以下なら報告しない**（壁のない端部では面の境界がCLのまま残り実壁の仕上げ面は半壁厚ぶん内側から始まるので幅わずか〔57.5mm程度〕の見かけの隙間が必ず生じる。巾木の面端クランプと二重になるだけ。階段口・大開口のように上限を超える隙間は壁のない端部に接していても報告する）。巾木（壁のないところに巾木はない）と壁2段書き（壁仕上げは壁の中央）が同じ述語を読む。面の端に接する区間は外側へ開いたまま返し、呼び出し側が自分の基準でクリップする（巾木は面の範囲、壁2段書きは壁中心線区間）。

### 壁2段書き（壁仕上げラベル）
- **壁の実体がある区間ごとに1つ・その区間の中央**。**基準は壁中心線区間(boundary)のまま**で壁の無い区間を差し引く（面の範囲run基準へ変えると全面のラベルが半壁厚動き、壁芯間寸法との中心合わせの根拠も失う）。**開口・床の段差は区間を割らない**（開口は壁に開いた穴＝避ける障害物のまま）。退避（`avoidObstacleRangesX`。`avoidGridCollisionX`と同系の最広ギャップ方式）も省略判定も区間ごと。障害物から開放スパンは外す。上階ぶん（`appendUpperStoreyTrim`）は「その位置の2階の部屋の面がある範囲ごと」で同じ規則。壁中心線間の描画長さがラベル幅の概算×2未満なら省略する（1パス目は判定しない）。**テキスト幅概算は文字クラス別**（`estimateWallLabelWidthPx`。半角ASCII=0.5×fontSize・全角=1.0×fontSize。変換後ラベルは半角主体で、全角一律だと過剰に省略される）。壁材・壁仕上げ材は表示専用に`formatMaterialLabel`で言い換える（「せっこうボード」→「PB」、`t=<数値>`→`ア)<数値>`。材マスターは変更しない）。壁2段書きにも吹抜け合成範囲の過剰が同種にあるが未対応（同じ`selfLocal`を障害物区間へ足せば直る見込み）。

### 巾木
- **巾木は壁のある範囲だけに引く**（壁面に沿う部材）。壁のある端は面の端（ローカル0/run）で止め、**止めるのは面の端であって壁中心線（CL）ではない**（CLで止めるとはね出した床線との間に段が付く）。区間端は描画基準（`drawnX0`/`drawnXRun`）のまま面の範囲へクランプする（`Math.max`/`Math.min`。狭める方向のクランプで階段帯の`floorSpanX`を壊さない）。**壁のない端部では、面の壁が面の端の外へ実際に続く範囲だけ**はね出しへ伸ばす（`wallContinuationBeyondFaceEnd`。同じ通りの壁を結合し、面の端を含む区間が端の外へ出ている長さ。上限は端部の延長量）。続かない端は面の端で止まる。**床線・天井線のはね出しは従来どおり**（巾木だけが対象）。
- **多層帯で合成により延長された範囲には自階の巾木を描かない**: 吹抜け合成（`elevationVoid.js`）は`lo=min/hi=max`で走り範囲を伸ばすが、伸びた先に自階の壁があるとは限らない。`withVoidRanges`が「自階の面が実在する範囲」を`face.voidAbove.selfLocal`として載せ、巾木ブロックはその**補集合**を既存の`floorGaps`へ足す（区間水平線のクリップと段差縦線の抑止が同時に効く＝別機構を作らない）。判別子は「吹抜けの下か」ではなく「**自階の壁があるか**」。`selfLocal`は**合成後の座標系**で作る（`withVoidRanges`は`originWorld`を貼り替える）。上階だけの面は空配列。ギャップの内側の端は自階の面の端ちょうどで内部境界でははね出させない。以上で**「巾木は自階の壁が実在する範囲だけ」という1原理**に統一される。
- **巾木は床の段差にも追従する**: 床断面線（区間水平線＋段差縦線）をhだけ上へ平行移動した連続ポリライン（水平方向にはオフセットしない。段差縦線を開口がまたぐ場合は床側同様に途切れさせる）。床まで達する開口の区間は巾木線を途切れさせる。**巾木の途切れ区間は描画基準（`drawnSpanRanges`）**（CL基準だとCLと壁面の間に巾木の無い隙間ができる）。
- 巾木初期値（`木製出幅木`/`h=60`）は**ユーザーがRoomを新規作成する経路でのみ**適用する（`applyDefaultBaseboard`）。`RoomFinish`コンストラクタでは設定しない（復元経路は「新しいRoomを作ってから空でないフィールドだけ上書き」なので、既定値を非空にするとクリア済み`''`が復元のたびに巻き戻る）。展開側は`parseBaseboardHeightMm`（`core/room.js`）が`"h=<数値>"`表記だけ解釈し、解釈不能なら非描画。

### 見付の1px保証
見付（2本線の間隔）は実画面で潰れると1本に見える。表示倍率scale(px/mm)から**描画限界**を1つ定め（`elevationStyle.js`の`drawLimitMm`/`faceGapLimitMm`/`visibleFaceMm`。`MIN_FACE_PX`が唯一の「指定px」）、それ未満の見付だけ限界まで広げる（限界以上は自然縮尺）。**限界は中心間距離ではなく「2本の線の間の余白が1px」**（線幅ぶん重なって1本に見えるため）。限界px＝1＋(線A幅＋線B幅)/2で、線幅は描画側と同じ表（`viewport.lineWeightsPx`＝`resolveLineWeightsPx(校正px/mm)`）を`ElevationModeState`が2パス目に`lineWeightsPx`として`scale`と一緒に帯→面ctx／断面エンジン`emitCtx`へ渡す。scale不明（1パス目・単体テスト・ゴールデン）は限界0＝モデル寸法のまま。「どちらの線が寸法を守るか」は見付ごとに決める: 三方枠は**細線（外周＝指定寸法）を守り中線（内法）を内側へ**（`openingElevationFigure.js`の`frameOnlyInnerRect`の`minFaceMm`引数。アキ標記の範囲も同じ内法に追随）、腰壁天端は**中線（天端＝腰壁高さ）を守り細線を下へ**（`kneeCapFaceMm`/`kneeCapBottomMm`）。`KNEE_CAP_FACE_MM=50`は1px保証で不要になりうる特例だが承認済みなので据え置く（実厚30へ戻すかは別途裁定）。

## 面リストの合成（composeRoomFaces）・段差見付け面・ROW1寸法のCL分割
`buildRoomFaces`（壁面ループ・隅共有不変条件）の上に`elevationFaceList.js`の`composeRoomFaces()`を**面リストの唯一の供給源**として重ねる（`buildRoomBand`/`buildStairBand`はこちらを呼ぶ）。合成順は`buildRoomFaces`→`extendFacesWithOpenSpans`→`splitFacesAtPartitionWalls`＋`clipSpans`→`insertStepFaces`→`filter(run>=MIN_FACE_RUN_MM)`→（壁の無い面を落とす。階段帯は除く）→`dropFacesSeenAsSightline`→`mergeSteppedFacesIntoPanel`（階段帯は除く）→`labelFaces`再採番で**固定**（段差見付け面の挿入位置判定は分割済みの面配列を前提にする）。段差見付け面（`kind:'step'`）を挟んでも実質的な隣接関係は変わらないので、`prevFace`/`nextFace`の取得は`neighborWallFace(faces, i, dir)`（`kind!=='step'`の最初の面）。

**段差見付け面（`elevationStepFace.js`）**: 部分指定の子Roomが親の壁際に接する箇所（`wallAdjacentFloorSegments`が担当）とは別に、**壁の無い部屋内部**の境界でFLが異なる区間に「段差の見えがかり」を専用の面として挿入する。`stepRiserSegments`が親Room自身の未指定セル＋各部分指定の子をFLごとにグループ化し、外形から「自分より低い隣に接する区間」だけを抽出する（相手FL>=自分のFLは重複排除で捨てる＝低い側からは生成しない）。`buildStepFaces`が通常面と同じ`letterOf`/`DIR_SIGN`規則で面オブジェクト化し（`lo/hi`は両端の直交壁面の`faceValue`へ詰める）、`insertStepFaces`が「見付け面の始点を含む壁面Wの直後」（無ければ末尾）へ挿入する。`buildFaceFigure`は`kind==='step'`を早期分岐し、低い側床線・両端縦線（実際に切断される壁の断面）・天井線をCUT、高い側床線（見付け上端。段差の向こうの床の見えがかり）をSILHOUETTE（中線）で描く。**天井断面は帯CHではなく低い側エリア自身の天井**`ceilAbsMm`（低い側FL＋低い側の解決済みCH。見付け面は低い側エリアを見込む展開図のため）。高い側エリアの天井`beyondCeilAbsMm`が断面より上なら細線の破線で重ねる。両端縦線は`floorY`（低い側床）から天井(`-CH`)まで（見付け上端で止めない。壁自体は天井まで続く）。見付け上端〜天井には常にアキ（`appendGapMark`。腰壁・垂れ壁の穴と共用）を乗せる。開口・巾木・壁2段書きはスキップし、注記帯は`appendAnnotationRows`で通常面と共通合流する。**段差見付け面との相互排除**（`subtractOpenSpanCoverage`）: 同一`(isVertical, axisCL.value, inward)`の面のopenスパンが覆う区間を差し引く（面平面上の段差はopenスパン側が表現を担う）。差し引いた残りが`MIN_FACE_RUN_MM`未満なら捨てる。差し引き前にriserをmatchingFacesの合計描画範囲へ丸める（riserは生CL値基準・面は仕上げ面基準で壁厚ぶんズレるため）。

**ROW1寸法のCL分割（`elevationDimSplit.js`）**: ROW1（壁芯間寸法）は`boundary.lo`〜`hi`を1本で通さず、`collectRow1SplitPoints`が集める源で分割した「寸法の鎖」にする。源: S1段差CL（`floorSegments[i].hiCLId`）／S2面へ到達する直交壁（`perpendicularWallsOnFace(face,graph,'far')`のaxisCL）／S3面に届く非通り芯中心線／S4`spans[i].hiCLId`が非nullの内部境界（`spans[i].hiCLX`で）。通り芯はROW2と二重になるため対象外。分割点は`boundary.lo/hi`ちょうど（±`SPLIT_MERGE_EPS_MM`=1）を除外し、通り芯と同位置の一点鎖線は重複させない。**S2の`far`では`isRoomWall`を除外しない**（面の向こう側に立つ壁は定義上どこかの部屋の外周生成壁。`near`〔袖壁＝面を分割する自立壁〕では除外する。自室の壁は`reach`/`project`判定で落ちる）。段差位置のCLオフセット・巾木障害物は「床の段差プロファイル」節。

**袖壁・腰壁の面分割（`splitFacesAtPartitionWalls`）**: `perpendicularWallsOnFace(face, graph, 'near')`が返す袖壁を面のローカルx（昇順・`SPLIT_MERGE_EPS_MM`以内は併合）で並べ、面を断片化する（`kind:'step'`は素通り）。各断片は元面を継承しつつ分割端だけ`startCLId/endCLId`=袖壁CLのid（隣接断片が同じCLを参照＝境界が厳密に一致）・`lo/hi`=袖壁の仕上げ面（断片は自分自身の`originWorld`を持ち直す）・`hasWallAtLocal0/Run`=false（壁のない端部処理を流用）・`partitionCutAtLocal0/Run`={thicknessMm, topHeightMm|null}（`graph.kneeDropWalls`をaxisCLId一致＋スパン重なりで直読み。指定が無ければnull=天井まで）へ差し替える。`buildFaceFigure`は`partitionCutAtLocal0/Run`があれば分割端に`thicknessMm`幅・`0..-(topHeightMm??CH)`のCUT枠rectを重ねる。

**同値・別延長のCLと隅の同定**（`finish/wallGeneration.js`の`externalSubIntervals`）: 外周エッジの端点idは、セルキー由来（端点・隣接スパン＝実際にセルを画しているCL）が**権威**であり、`dividerCLsBetween`で上書きしてはならない。値が同じで延長だけ違うCLが2本あると隅が「その位置に届いていない方」のidを指し、`buildRoomFaces`のチェーン探索（CLの**id**で隣の面へ辿る）が繋がらず面が1枚も残らない。同値の候補が複数あるときは、その辺の軸位置まで延長が届いているCL（`isActiveAcrossRange`。±1mmの窓）を優先する。

## 開放スパン（elevationOpenSpan.js）
面の範囲を「壁のあるアウトラインエッジ」から「同一axisCL平面上でnear側に自室セルが連続する最大区間」へ拡張する仕組み（D1/B1のような「壁区間＋壁のない開放区間を1枚の連続面として描く」）。`kind:'wall'|'open'`の`spans`を持つ。

**座標系（意図的な混在。統一しない）**: **描画**（床線・あき・エッジ縦線）は実壁の隅=仕上げ面スナップ・壁のない内部境界=生CL値、**寸法（ROW1）**はboundary（面の壁芯間）とS4分割点（`spans[i].hiCLX`=CL位置）。このため描画run（実測1285=342.5+942.5）とROW1の合計（1000+400=1400）は一致しない（既存仕様どおり）。

**抽出**（`extendFacesWithOpenSpans`/`clipSpans`）: room自身の登録セル（`refreshCells`。extent解決は`worldToCell`に委譲）のうち面のnear側に接するもの全件を列挙し、各セルのfar側を1点プローブしてwall/open分類する（**微小刻みでface.lo/hiの外側へプローブする方式は、直交壁の厚み帯の内側を誤って「壁あり」と拾い続けるため採用しない**）。面自身の既知区間を含む連続クラスタだけを採用し、延長した端だけ`perpFaceAt`で隅スナップする。延長していない端は元のhasWallAtLocal0/Runを引き継ぐ。`dirSign<0`の面はworld順とlocal順が反転するため、`spans[i].hiCLId`・「末尾=hiCLId null」の判定は**ソート後のlocal順配列で行う**。**近側セルは「軸に接する」ものに加え「軸を跨ぐ」ものも拾う**（`cellStraddlesFace`。CLがその位置まで延長されていない帯では自室のセルが割れず面を跨ぐ。跨ぎ由来は`straddle`で区別し`mergeSameKind`の結合キーに含める＝正当な小区間と融合させない）。床の段差プロファイルは跨ぎ対象外。**粗いセル境界での1点プローブ誤分類の回避**（原則）: 他室区間を挟んだ延長は`runHi===次のrunLo`で実際に連続する範囲だけ延長／見付け面のriserはmatchingFacesの範囲へ丸める／自室側のセル境界がfar側の部屋境界より粗いときはrunの伸びる方向のCLで刻んで区間ごとに個別プローブ（`collectRunBreaks`/`findRunCLAt`）。いずれも区間境界の同定という同じ土台の不備で、同定ロジック自体を直す（片方だけ直す対症療法にしない）。

**延長する端の取捨**（規則0→1→2→2.5→3。`dropEnd`。「出口側の隅だけが担う。情報を全く持たない所〔アキ・バツだけ〕が描画延長の1/4を超えたら延長しない」）: 連続する区間を貪欲に取り込んだあと**端の区間**を取捨する。落とした端は「壁断面のない端部」（床・天井線を図の外へ延長）で終わる。
0. **wall区間**は、そこまでの全てのopen区間が「niche」（跨ぎでなく`SIGHTLINE_DEPTH_LIMIT_MM`**以下**の奥の同向き平行面が覆う凹み＝アルコーブ）のときだけ規則1〜3に進む（1つでもnicheでなければ呑まない＝別の空間への開口の先の壁は別の壁）。深さ比較は`<=`（アルコーブ奥行きちょうど800のM1確定挙動が根拠）で、エンジンの「見えがかりとして描くか」(`<`800)とは**別の問い**なので統一しない。
1. `informative`な区間は常に残す（`collectNearCellSegments`がnear/far双方の所有Roomの実効FL・解決済みCHを比べて立てるフラグ。差があれば遠側床線・遠側天井線という実体が現れる）。
2. 情報ゼロでも、**出口側の隅**（ローカルrun端＝chainで次の面へ渡る隅。`dirSign>0`ならworld hi）を越える延長で近側セルが軸に接しているなら残す（入隅は必ず2面で共有されるので見通しは出口側の面だけが担えば過不足がない）。
2.5. **「その先を同室の平行・同向き・より奥の壁面が覆っているなら取り込まない」**（同じ向きの壁が別の平面で続いているだけで、その平面の面が同じ世界x区間を壁として描く。取り込むと「壁」と「アキ」で二重になる）。**規則1・2より先に置いてはいけない**（承認済みの役割分担を覆し、実機2階22のA1〔跨ぎ由来の942〕とRoundF room2の中心3面が消える）。跨ぎ由来の区間も対象外。覆い判定には「奥の面がこの面と並走していない（走り範囲が重ならない）」条件が要る（無いと部屋の反対側の壁まで覆いと見なす）。
3. それ以外（入口側 or 跨ぎ由来）は区間長が図全体の**1/4以下**のときだけ残す。**比は「実際に描かれる長さ」で採る**（延長した端は`resolveEnd`が直交壁の仕上げ面へ詰めるため生のセル区間長と桁違いになりうる。端の確定を取捨ループの**内側**に置く）。

**不変条件「spansを持つ面はspansがrunをちょうど覆う」と重複解消の包含限定**: `composeRoomFaces`出力までの面は`spans[0].loX≈0`・`spans末尾.hiX≈run`・区間が連続（許容GAP_EPS）を満たす。保証は構成的（生成点は`extendFaceWithOpenSpans`と`clipSpans`のみ・`dedupeOverlappingFaces`はspans/lo/hiを編集しない）で実行時assertは持たない（テスト側の独立検算`assertSpansCoverRun`が門番）。重なる面の片側のlo/hiだけ広げてspansを据え置く「包絡」はこの不変条件を破りROW1に負の寸法を出した。現在は**包含関係に限定**（o⊇fはスキップ・f⊇oはcontainerを丸ごと採用・部分重なりはマージしない）。`elevationVoid.js`の多層合成後はspansが延長域を持たない既知の別規約で対象外。

**描画**（`buildFaceFigure`のspans処理）: 通常面の床線・天井線・両端縦線の直後にopen区間ごと処理する。
1. 遠側床線: `nearDeltaAt(x)`で求めた近側の床yと`farFloorDeltaMm`が異なる場合だけSILHOUETTE水平線を追加（floorSegmentsが追従できていない場合の保険。重複描画は起きない）。
2. 上部あき: `appendGapMark`で天井から近側床（見上げ方向は遠側床）までの矩形を描く。**ただし開放スパンが「壁のない端部」に接している場合は描かない**（床線・天井線の延長で「続きがある」を表現済み。`appendGapMark`は矩形の中線の輪郭も積むのでその辺が面端の縦線に見える。この「通り芯上のエッジ線」の正体は1個のアキ標記だった。切り分けは推測でなく全面の診断ログで行う）。反対側が壁で閉じている開放スパンは描く。見下ろし方向は近側床でクランプ（遠側床まで伸ばすと矩形外形の実線が床断面下の細破線を覆う）。アキ廃止は明示指示がある場合のみ行う。
3. 境界エッジ: open区間の両端のうち隣がwall側ならSILHOUETTE縦線。**内部境界の描画xは「壁厚×1/2だけ開放側」**（`drawnSpanRanges`。実際の抜けは壁の面から始まる。`innerWallFaceAt`で実壁の面〔偏芯込み〕を引き、**境界に実壁が無ければオフセットしない**。面端はずらさない。寸法・CL一点鎖線はオフセット前の`spans[i].hiCLX`のまま。描画側とテストは`drawnSpanRanges`を共有）。直交壁が無く、面沿いの壁の端が柱包み（在来木造の自由端。`applyFreeEndProtrusion`）で境界CLから開放側へ出ているときは、その壁端（直交壁が最優先、CLより引っ込んだ端は採らない）。
4. 巾木・壁2段書き障害物にopen区間を追加。`extendedAtLocal0/Run`端では隣接面由来の建具断面を描かない。

**見下ろし方向は破線**（ユーザー明示指示の一般規則化。類似規則への拡張は明示指示がある場合のみ）: 開放先(far側)の床がnear側より低い場合、遠側床線・境界エッジの縦線を`dash:'dashed'`にする。**床断面より下・天井断面より上の向こう側の断面は細線の破線**: 床断面より下に見える遠側床線は破線かつ細線（床〜天井の間に見える見上げ方向の遠側床線は中線の実線）。床断面〜far床の端部の縦線も同じ細線の破線で継ぎ足し、端点をfar床線と厳密に一致させる。天井断面より上も同規則（`farCeilAbsMm`がnear天井断面より高ければ細線の破線＋端部縦線、低ければ床〜天井の間の見えがかりとしてSILHOUETTE実線。アキ矩形の上端もfar天井が低い場合はそこまでクランプ）。

## パネル統合: 段差でしか分かれていない面を1枚のパネルにする
室の境界が段差を1つ挟んで一続きになっている壁（返し壁で継がれた壁）は、面としては平面ごとに分かれるが**壁としては1枚**であり、2つのパネルに割ると同じ壁が2回・別々のラベルで現れる。`mergeSteppedFacesIntoPanel`（`elevationFaceList.js`）が共通の`panelId`と**接合端のフラグ2つ**（壁断面の有無・見えがかりエッジ）だけを書き込む。
- **面を1つに合成しない**のが要点: `face`は`axisCL`/`faceValue`/`inward`を各1つ持つ前提で、開口・直交壁・床/天井区間・ROW1分割・`elevationVoid`のsamePlane合成まで全てが`face.axisCL`を鍵にしている。「面の端に壁断面が現れるかを面単位ではなく**パネル単位**で評価する」という1つの意味づけから、はね出しの停止・探査延長の停止・接合部の縦線が相手の壁断面の縁と一致して1本に畳まれる、の3つが同時に正しくなる。
- **呼ぶ位置は`dropFacesSeenAsSightline`の後・`labelFaces`の前**（この順序固定。配線は`composeRoomFaces`と`buildRoomBandWithVoidAbove`の2箇所）。前者の後でなければあいだに残った見えがかり面のせいで「面リスト上の隣接」が成立せず、後者の前でなければパネル単位の採番ができない。階段帯（`keepWallLessFaces`）では適用しない（`switchbackCuts`が面を並べ替えるため帯順に依存する規則が成立しない）。
- **接合端の一致判定（条件5）は天井側だけを見る**: 面オブジェクトはFLを持たないため接合端のFL差は面単体から引けない（graphを引数に足す案は検証できず純関数の引数面を広げるので不採用）。帰結として部分指定でFLが変わる段差も統合されるが、各メンバーは自分の`floorSegments`で床を描くので段差は継ぎ目に段として現れる。**常に真の比較をこの述語に残さない**（誤った安全感を与える）。
- **接合の向きは「2枚目が先頭メンバーの+ローカルx側」に限る**（帯の配置式とパネル全幅の算出がこの前提）。**暴発の安全弁は「面リスト上で隣接する2枚だけを見る」**こと（室の反対側どうしが偶然接する組を1枚にしない）。奥行きの上限は設けない。代わりに「重ならず隙間200以下で接する」「接合端の床・天井の起点が一致する」「接合部にどちらか一方の壁断面がある」を要求する。
- **帯での配置**（`layoutBandFaces`）: パネル内2枚目以降はギャップ・壁のない端部の延長・CH寸法オフセットを使わず**世界x整合**（`originWorld`の差×`dirSign`）で置く（展開図は正投影なので段差の返し壁は見付けの線1本で幅を持たない。世界x↔ローカルxのアフィン写像が通り芯丸・一点鎖線・寸法・開口・切断線の全ての前提）。面ラベルはパネルで1つ（先頭メンバーがパネル全幅の中心に描く）。

## 階をまたぐ2層帯（階段・吹抜け）
**共通基盤**: 多層帯は`finalizeBand`の`heightUnits`（既定1）で宣言し、`normalizeBandHeightUnits`（`elevationLayout.js`）が帯スロット高さを「全帯中の最大unitHeightMm×整数」へ切り上げる。**1層帯（heightUnits<2）は一切動かさない**（天井高の異なる階で1層帯まで最大帯高へ引き上がる副作用を避ける）。`chooseElevationScale`の予算基準は`unitHeightMm ?? heightMm`（2層帯が混ざっても縮尺は1層基準）。boundsには触れない。`layoutBandFaces`の`ctx.faceOverride(face,i,defaults)`はfaceCtxへの差し込みフックで、**`hasLeftChDim`の継ぎ目判定より前に適用する**（後だと階段帯の面ごとCH寸法が出ない）。`buildFaceFigure`の`ctx.ceilingProfile`（区分線形`[[localX,ceilAbsMm],..]`）は天井解決を`ceilAbsAtX`に集約して勾配天井をCUTのpolyline1本で描く（端縦線上端・袖壁断面・アキ上端・注記突き出しも追従）。範囲外のxは端点値へクランプし、カバレッジ条件は持たない（旧「描画範囲を覆わなければフォールバック」契約は壁のない端部の延長で描画範囲が広がるだけで勾配天井が常にフラット化するバグの原因だった）。

### 2層帯は「1階と2階の展開を上下に並べた図」（上部吹抜けの多層書き。方針C）
上部吹抜けの多層書きは**吹抜けを通して上を覗いた図**ではなく、**1階の展開と2階の展開を上下に並べた図**として組む。上階ぶんは`elevationVoid.js`の`appendUpperStoreyOutline`（輪郭。断面エンジンを上階だけの1層としてもう1本）と`appendUpperStoreyTrim`（体裁。天井断面線・巾木・壁2段書き・天井高寸法）が担当する。
- 範囲は次の2条件の**積**（`upperStoreySegments`。吹抜けの範囲は下の断面が既に上階天井まで描いているので引く）: (1) その面の平面が上階に存在する範囲（`upperPlaneLocal`。同じ通りに上階の壁が1枚でもあれば最初の壁から最後の壁まで）／(2) その上階の空気が、吹抜けを通して下階の空間とつながっている範囲（「断面の中」の判定）。(1)は平面の存在確認であって可視判定ではなく、(2)が無いと方針Cの上階パスは断面の中だけを描くことになる。
- 上階を**それ自身が自階である1層の断面**として組むのが要点（上階の壁・アキ・エッジが通常の1層帯と同じ処理で出る）。断面ローカルxはcutごとに`line.lo/hi`から決まるため、面ローカルxへ戻す平行移動を掛ける。
- **体裁の値の出どころはすべて2階の部屋**（1階の巾木高さ・壁材を2階へ転用しない）。巾木・壁2段書きは「その位置の2階の部屋の面がある範囲」だけに出る。**横方向の寸法（壁芯間・通り芯丸・面ラベル）は増やさない**（上下階で同じ位置なので重なるだけ）。増やすのは縦の天井高寸法（上階ぶん1本）。
- 結果: **天井の高さが変わる境界に立つ壁は、上階を描く範囲では壁厚（両縁）で出る**（同じ壁が上階の切断壁として普通に扱われるため）。上階を描かない範囲では見える側の1縁だけ。
- **上階の天井高寸法は「その端に上階の断面がある面」の左に立てる**（`appendUpperStoreyTrim`。先頭面の左が「断面の中」だと図中に該当する断面が無い寸法になる。1階の左CH寸法が「左端区間の実際の床〜天井」を測るのと同じ規約を上階にも適用）。
- 多層帯（`buildRoomBandWithVoidAbove`）にも`ctx.solids`を渡す（渡し漏れで柱型・梁型が丸ごと欠けた前例）。

### 吹抜け帯・多層書きの組み立て
- **吹抜け帯**（`elevationVoid.js`の`buildVoidBand`。`selectElevationRooms`がfeature=VOIDを採用）: 「設置階下階のFLから設置階の天井高さまで」を**自階の面を下へ延長する**方式で描く（下階の面リストを積まない。吹抜けの壁は下階FL〜設置階天井まで連続し設置階FL位置に床断面は現れない）。faceOverrideでsegsを`floorDeltaMm-=drop, chMm+=drop`と変換すると`ceilAbs=floorDelta+chMm`不変で床だけ下がり、端縦線・左CH寸法・建具床合わせが既存機構のまま追従する。世界座標は全階共通なのでCLは自動的に揃う。`lowerGraph`/`floorHeightBelow`（`stairDimensions.js`）が無ければ1層フォールバック（例外を投げない）。
- **どの階の展開図に載せるか**: 吹抜けRoomは床の無い上階に置かれるが、帯の下端のCUT床線＝床断面は**直下階のFL**にある。独立した帯にはせず、**直下階の「吹抜けが落ちている部屋」の帯へ多層書きする**（`buildRoomBandWithVoidAbove`）。落ちる先が見つからない／その部屋が帯として出ない場合だけ独立した2層帯（`buildVoidBand`）へ回す。
- **多層書きの組み立て**: 面の対応は「軸CLの世界座標＋見る向き」で取る。走り方向の範囲が食い違っていても同一面なら1枚に統合する。統合で走り範囲を広げたら**端のCLも引き直す**（`faceBoundaryLocalX`は`startCLId`/`endCLId`からパネル幅を決めるため、上階のCL idのままだと下階graphで引けずパネルが隣と重なる。lo側かは値の近さで選ぶ）。区間ごとの高さは`floorSegments`で表す。**吹抜けには天井断面まで水平断面が無い**（見えがかりは存在する）ので、吹抜けの範囲でも床断面は下階のFLのまま1本で通り上階の床位置に断面線は立たない。区間は「吹抜けの範囲外＝下階の床〜天井」「吹抜けの範囲＝下階の床〜上階の天井」の2通りだけで、**下階にその面の壁があるかどうかは断面の有無を左右しない**（吹抜け側だけ床を2FLへ上げると1F床断面が面の端まで届かず端の壁断面と取り合わなくなる）。
- **壁断面・見えがかりは階段展開と同じ断面エンジンを共有する**: 吹抜けを持つ面ごとにSectionCutを1本立て階段帯と同じ`buildColumns`→`emitColumns`を通す（層は self=下階・above=上階、zRangeは下階FL〜上階天井、`viewSign = -face.inward`）。床線・天井線・端の縦線・巾木・建具は`buildFaceFigure`の責務。落とし穴: **直交壁は面の壁に突き当たって室内側の面で終わる**ため素の`isCutWall`では腰壁等の断面が丸ごと落ちる。`line.buttToleranceMm`（面の壁の半厚）で「その厚みの中で終わる壁は切断線を横切る」とみなす（階段帯は未指定=0で従来と同値）。

### 2層帯は「下階にも同じ壁がある」と暗黙に仮定してはいけない
階段帯・吹抜け帯は2層にまたがり、「上の層の見え方をそのまま下へ延ばす」実装に寄りやすく、**下階／上階に同じ壁が無い区間**で実在しない輪郭を描く同型の不具合を起こしていた。2層帯を触るときは常に「その層に実際にその壁があるか」を層ごとに引き直す。
- 階段帯（section層）: 隣接列との連続判定は**z区間ごとの被覆**（`uncoveredZRanges`）で行う（`matchingBand`で重なる帯が1つでもあれば連続としてband全体に一括適用すると、隣接列の壁が途中までしか無い場合に側縁が丸ごと消える）。被覆とみなすのは「同層・同距離＝そのまま続く壁」と「別層＝見えている壁が入れ替わっただけ」の2通りで、残る「同層・別距離」だけが凹みの側面として縦線になる。
- 吹抜け帯（面の引き伸ばし方式）: 下階に同じ軸CL・同じ向きの壁が実在する区間だけを下へ延ばす。壁の無い区間は設置階の床のまま残し、境界は既存の段差床線で縦の折れとして出る。CLは階ごとに別オブジェクトなので、idではなく世界座標で突き合わせる。

### 面の端も層ごとに違う
自階の面は自階の壁で終わるが、**同じ通りの上階の壁はその先へ続きうる**。探査範囲は層ごとに決め（`sectionContent.js`の探査窓`layerRunWindowsOf`）、面の外は平面が続いている層だけを描く。平面が届いていない層は壁候補だけでなく**床天井の分類からも外す**（残すと面の外に所有Room不明の空間＝アキが生まれる）。対象は**壁のある端だけ**（壁のない端の外は体裁のはり出しで平面照合の話ではない）。はり出しは上＝上階の天井断面線・下＝上階のFL断面線・外端＝壁エッジで閉じ、自階の床線・面端の縦線は面の端のまま。はり出してよい量の上限は`UPPER_PLANE_OVERHANG_LIMIT_MM`で、超えたら**全か無か**で描かない（途中で切ると壁が終わっていない位置に端部の縦線が出る）。列の範囲が面の描画範囲（`cutDrawRange`）を超えうるので、階段の作図が列からx範囲を得る箇所はそちらでクランプする。
- 吹抜けの帯にも同じ規則を適用する（上限も同じ）。ただし**その層の空間がその端で見えている端だけ**（gateが無いと開いていない端で層の平面だけが外へ伸び、閉じる線の無い突起になる）。判定は上下対称: 上部吹抜けを持つ部屋帯は「その端の帯の**天井**断面が上階の**床**より上（＝吹抜けが面の端に達している）」、下階を積む吹抜け帯は鏡像で「その端の帯の**床**断面が下階の**天井**より下」。gateの材料を渡さない帯（階段帯）は素通り。下階のはり出しは上＝下階の天井断面線・外端＝壁エッジ（エンジンのcontent）と、下＝下階のFL断面線（図側で床線だけを外へ延ばす）で閉じる（下階の天井から自階の床までは床構造＝断面の中なので線を引かない）。**下階はり出しの上辺は「下階の天井」で確定**（自階の床ではない）。
- 上のはり出しの「上＝上階の天井断面線／下＝上階のFL断面線」は上部吹抜けを持つ部屋帯にも当てはまる。**上階FLの線の起点は端の姿で決まる**: (a) はり出しの外端に**切断壁**（上階の腰壁）が立つ端は、壁の**向こう側の面**からさらに外へ`wallLessEndExtendModelMm`ぶん張り出して終わる（壁の下には引かない＝「断面の中は描かない」と同じ1つの見方。天井断面線は壁の外側の面で終わる）。(b) 立たない端（全高の見えがかり壁）は、階段帯は断面線（`floorProfile`）が上階FLを下回る位置で止め、断面線を持たない帯は面端のCLより向こう側だけに引く（**はり出し区間の外へ絶対に出ないようクランプする**。破るとはり出し0の面〔通常の部屋帯のほぼ全面〕にCLまでの偽の水平線が生える）。
- 「切断壁か見えがかり壁か」は**contentの列にしか無い**情報なので、図側で壁を引き直さず探査の結果をそのまま渡す（導出は`sectionContent.js`の`upperFloorCutWallEndsOf`ただ1つ）。上部吹抜けを持つ部屋帯だけは図がcontentより先に走るため、レイアウトを組んでcontentを**1度だけ**走らせ、収穫した起点を載せて**図を組み直す**（contentを2度走らせない）。
- 上階FL断面線を引く端は、さらに「はり出しの向こうに上階の床が実在する端」へ絞る（CLの外側の世界座標で上階graphの所有Roomを引き、実Room〔VOID/STAIR_VOIDでない〕の端だけ許す。はり出し量は上階の壁の伸びしか見ないので、2階でも吹抜けが続き境界に腰壁だけが立つ構成では床の無い位置に線が出る）。落とすのは床の断面線だけで天井断面線・壁エッジのはり出しは残す。**このgateは上部吹抜けを持つ部屋帯と階段帯で同じ1つの関数**（`elevationFaces.js`の`upperFloorEndsOf`）から供給する。はり出し量の算出（帯ごとに別）とgate（共通）を分けて考える（階段帯は`floorProfile`ベースの分岐を持つため一度gateを配線し忘れた）。

### 階段帯（2.5D断面エンジン方式）
階段帯の面コンテンツは「切断定義（薄い表）＋タイプ非依存の断面エンジン」の3層構成（`app/src/elevation/section/`）。描画範囲は設置階FL(y=0)〜上階天井`-(floorHeight+CH_upper)`。CH_upperの解決優先順＝(a)`stairPortEdges(['arrival'])`辺中点のfar側`worldToCell`所有Roomの`roomCeilingHeight` (b)重なるVOID/STAIR_VOID Room (c)`upperGraph.defaultCeilingHeight`。
1. **第1層 切断定義（`section/cuts/`）**: タイプ別に「どこを・どちらを向いて・どう切るか」の表だけを持つ。`switchbackCuts.js`（SWITCHBACK/WINDING＝U字系）・`straightCuts.js`（STRAIGHT/STRAIGHT_LANDING）・`fanCuts.js`（L_TURN/FLARED/OPEN_WELL。区分線形モデルで表せないため常にnull）。返り値は`SectionCut[]`。往復間の壁・踊り場壁のような「区間を横断する実壁」は`graph.walls`を位置のCL座標で直読みして検出し、実在しなければ該当seqを挿入しない（合成面`kind:'stairMid'`。壁厚は`wall.materialRange`から求める）。往復間の壁は2F（`opts.upperGraph`。純モジュール不変条件のためoptsで素通し）の壁を見る。SWITCHBACK以外・stair.cellsが空・floorHeight未確定・面分類不能はnullを返し、`buildStairBand`は従来の`composeRoomFaces`＋2層枠へフォールバックする。**CLの無いU字階段（`midCL`が引けない）のseq2の面はレーン境界（`midAcross`）の仮想の面**（`midOutFace`。axisCLは`sectionFace.js`の合成面と同じ疑似`{id:null,effectiveValue,value}`。背後の外壁`wOut1`への退避は廃止。null軸CLを下流へ流すと半壁厚が面の位置になる不具合と建具ありのTypeErrorが出たので疑似CLで組む）にする。
2. **第2層 断面エンジン**（`sectionProbe.js`/`sectionEmit.js`/`sectionEngine.js`）: 列ごとのz区間を「切断壁(cut)／縦断された壁(cutAlong)／見えがかり壁面(wall)／アキ(open)／床スラブ(slab・非描画)」へオクルージョン優先順位（cut/cutAlong＝最前面 > wallは距離最小 > 無ければ視線先の床天井位置でslab/openを判定）で分類する。`isRoomWall`（部屋の外周壁）はcutAlong判定から除外する（自壁までcutAlongにすると`isSightlineShape`の意図的な自壁除外が壊れる）。線種は`sectionEmit.js`の表が唯一の情報源（cutAlongは天井際CUT水平線＋両端CUT縦線の3線＝塗り無しの輪郭のみ）。開口は描画を貫通させず、そのz範囲に`ZBand.openingPassThrough`が付く。
3. **第3層 階段幾何（`sectionStair.js`）**: 階段の3D的な寄与をタイプ非依存の区分線形モデル（Flight[]＝直進区間・Landing[]＝踊り場。区間ごとの直線で表す）で表す。第1層がどの区間を渡すかを決め、第2層は「切断線がレーンを縦断＝段鼻のジグザグ」「横切る＝正面視の梯子」「踊り場を縦断＝床のCUT水平線」を切断線とFlight/Landingの幾何関係だけから導出する。
- **踏面ピッチは「区間長 ÷ (段数−1)」**（`stairRunProfile`）: 区間長は「1段目の位置〜次区間（踊り場・上階床）の床の位置」で、その間の踏面は steps−1 枚（最終段の踏面は次区間の床が兼ねる）。`endX = startX + dir*区間長`は不変。
- **向きに関する値は必ずmakeFrame経由で導出し、部屋のbounds等から直接計算しない**（`stairContribution`のacrossLo/acrossHiも`stair.flip`を反映する。`f.pt(0,s)`でs=0/s=1の世界座標を直接求める。`reorientFace`と同種の不変条件）。

#### 切断線の位置・図の向き
- SWITCHBACKのseq2/4の切断線は**往路レーンの中央**（`acrossCoordAt(0.25)`）、seq5は**復路レーンの中央**（`acrossCoordAt(0.75)`）。往復間に壁が無ければ復路直進部のささらが見えるので、切断線はレーンの中を通り視線はもう一方のレーン側へ向く（`outboundLaneLine`/`inboundLaneLine`・`towardS1`/`towardS0`）。seq2は視線が復路側、seq4は往路の外側で、両者は同じ`outboundLaneLine`を向きだけ逆に共有する。**B/Dは各1本**（旧seq2.5/4.5は切断線・視線・向き・層・z範囲がseq2/4と同一の重複だったので廃止。往復間の壁は`seq2.face.hasRealWall`・`axisCL`で表す）。往復間の壁は通常の見えがかり壁（SILHOUETTE）として検出される（cutAlongのCUT太線ではない）。
- **seq3は踊り場前縁から`LANDING_CUT_INSET_MM`（100mm）だけ踊り場側で切り、踊り場レベルより上だけ描く**（踊り場は平場で隔て板が無い。前縁で切ると前縁のCLで終わる隔て壁・階段下壁が柱包み〔物理範囲±57.5mm〕で踊り場側へ回り込み切断面にかかって断面になる）。入れる量は柱包みの回り込み(57.5)・柱の半幅(45)より大きく踊り場の奥行き以下（超えれば前縁のまま）。前提は木造・薄壁（RC厚壁や150角超の柱では再びかかりうる）。seq3は階段下の部屋の有無によらず踊り場レベルより下を描かない。seq1は前縁のまま（隔て壁は階段側にある）。直進階段の踊り場壁seq3は実在する踊り場壁そのものを切る別構造で対象外。
- **seq5（D2）の面はwOut2の全長**（踊り場ぶんを含む）で向きはseq2側（踊り場が右）、寄与は復路＋踊り場。**seq3にも踊り場の寄与を渡す**（`landingOnly`。踊り場の床断面線・桁枠は必要）。`stairPrimitivesForCut`の`stairIsVertical`はflightsが空でも踊り場のside辺から取る（切断線の向きへフォールバックするとlengthwise/crossingの判定が反転する）。
- **seq6**（復路レーンの中から隔て板側を見る面）: 自階の往復間の壁が木造の隔て板（`isStairPartitionWall`）のときだけ切断定義表に足す（seq5と同じ切断線を逆向きtowardS0に見るseq2の復路版。面はseq2と同じ中心1の面をseq4の向きに直したもの）。組み立て（復路下の仕上げ空間・裏面・床区間）はseq5と共通の`returnLaneEntryOf`。展開記号はseq4と同じD1/D2。階段下の部屋の壁などが往復間に立つだけの構成は従来の5面。
- **展開記号は`cut.viewSign`（視線の向き）だけで決まる**（`letterOf(cut.line.isVertical, -cut.viewSign)`）。dirSignは歩行方向で決まる**作図順**であって視線ではない（seq2とseq5は同じ`towardS1`なのにdirSignが違う。dirSign基準は実機で否定された）。階段の展開記号が階段ごとに変わるのはこの逆引きの結果であり例外規則ではない。labelは`stairFaceSequence`の末尾で`labelFaces`により**歩行順**に採番し直す（コンパス順で採番済みのlabelを持ち込むとreorient後のletterと食い違う）。合成面（`buildMidWallFace`）にもletter/labelを持たせる。SWITCHBACKのseq4は往路(outbound)の鏡像（`stairCut`は`flights[0]`）で復路ではない（復路をそのまま描くと「左から右へ下る」実機の見え方と矛盾する）。
- **図の左右（dirSign）は仮想断面の視線の向きだけで決める**: 全cut（U字系seq1〜5・直進seq1〜5）とも`DIR_SIGN[letterOf(isVertical, −viewSign)]`（展開記号の採番と同じ方位規則）で face を`reorientFace`する（歩行方向決め打ちは「6」でたまたま一致していただけで、逆回転では鏡像になった）。`desiredDirSign`はfloorSegments/ceilingProfile（face基準）とcontent（cut.dirSign基準）の**両方に同じ値を使う**。歩行順に依存する下流（seq2/4の床区間の並び・CH寸法の鎖の踊り場側の端）は切断定義表が面ごとに宣言する`landingEnd`から決め、「seq2は踊り場が右」を持たない。直進のseq2はs=0側の壁、seq4はs=1側を見る。合成fixtureは「6」と同じ回転（flip=true）を既定にし、逆回転はupDirection×flipの全8通りのテストで固定する。
- 階段の面の選択はcuts表が唯一の情報源（A/B/C/Dの節）。

#### 側面視・正面視・ささら
- **側面視（切断面がFlightの中を縦断する）**: 段鼻のジグザグ自体をCUT（太線）で描く（踏面は切断線で切られている）。手前側（切断面と視線の間）のささらは切り取られるため描かず、**切断面の向こう側にある自レーン自身のささら**の輪郭をDETAIL（細線）で重ねる。視線前方にもう一方のレーンがあり往復間に見えがかり壁が無ければ、**他レーンの近い側のささら**も重ねる（`secondaryFlights`。seq2のみ。壁があれば`isBlockedByWall`が遮る）。**手前のささらによる遮蔽**: seq2の切断は往路レーンの中を通るので視線の手前に往路のささらがあり、その上端より下は奥の復路のささらが見えない。遮蔽の外形は「往路ささらの上端線」1本（その端から先は端点の高さで水平延長＝踊り場桁枠の上端）で、`clipPolylineAboveOccluder`がささら輪郭をその上側だけへ切る。
- **正面視（切断面がFlightに直交＝レーンを横切る）**: ささら自体が切断されるため、両側にささらの断面矩形（`flightStringerFrontPrimitives`）をCUT（太線）で描く。**上端は段鼻＋巾木高さ**（側面視と同じ基準）。内側のささら（梯子状の壁断面が無い方の端＝`innerAcrossWorld`。`ladderAcrossRange`がLANE_GAPを片側だけ詰めるのと同じ基準）の見えがかりは一定xの縦線1本（`innerStringerSilhouette`）。踊り場より下まで達するレーンの端面は縦の細破線（`stringerEndCapPrimitives`。STEEL限定。seq1では往路だけが該当）。**踊り場の床断面線は正面視でもCUT**（`landingCutPrimitives`。x範囲は壁から壁までの全幅）。
- 木造（`structure!==STEEL`）はささら無し（段部のジグザグをそのまま描く）。
- **鉄骨階段のささら**（`structure===STEEL`限定）: 板厚`STEEL_STRINGER_THICKNESS_MM=12`・せい`STEEL_STRINGER_DEPTH_MM=300`（作図既定値。`section/stairSectionProfile.js`）。**上端線は段鼻の勾配線＋巾木高さ**（最後の段鼻の高さは踊り場床そのものなので、踊り場桁枠side辺の上端と踊り場の縁で自動的に一致し、直進部の斜めささらと踊り場ささらが取り合う）。**下端側はミトレでトリム結合し、交点は`stringerBandGeometry`という同じ関数から斜めささらと桁枠側の両方が取る**（別々に計算すると1本の取り合いが2つの位置に分裂する）。トリム端の上端は踊り場桁枠の上端まで伸ばし（復路は最初の段鼻が踊り場より1リザー上にあるので段鼻列だけだと桁枠に届かない）、z範囲のクリップはトリム端でだけ緩める（FL側は厳格。法線オフセットの突き出しはFL側で起きる）。トリム結合する端では上端と下端を結ぶ端の線（せい300）を描かない。**取り合い部（`kind==='front'`の辺）に踊り場桁枠の断面は描かない**（内側の踊り場ささらは往路・復路の間だけにあり、直進部のささらが来る位置には存在しない。back辺は描く）。踊り場桁枠のside辺（走行軸に平行）は「踊り場床断面線+巾木高さ」を上端、`landingFrameDepthMm`(300)下げた線を下端とする帯で描き（巾木高さは`parseBaseboardHeightMm`、解釈不能は`DEFAULT_BASEBOARD_HEIGHT`='h=60'）、front/back辺の帯の基準も同じ「踊り場面＋巾木」で統一する。flight側の端には縦の閉じ線を描かない。`stringerPrimitives`はオフセット後の多角形を`zBounds`でFLにクリップする（`flightZBounds`が`clipStringerToAnchors`と共有の単一情報源）。
- **蹴込**（`Stair.nosing`。既定20mm）: **蹴上は蹴込ぶん傾いた「斜めの断面」1本**（足元〔段鼻+蹴込〕から段鼻へ斜線。最終段も同じループで例外なし）。蹴込は踏面でクランプする（超えると輪郭が自己交差）。蹴上を斜線1本にしたので点列の刻みは蹴込の有無に依らず一定（段鼻＝奇数index）で、`stairRunProfile`は`noses`も明示的に返す（推測に頼らない。「垂直な蹴上＋水平な蹴込」の実装は刻みが変わって段鼻抽出を壊した）。**階段の描画範囲は flight の始端まで広げる**（1段目の段鼻が面端の外に出るとき。`flightStartOuterBound`。範囲に収めると1段目が面端の垂直線に潰れる）。
- **在来木造の段板30・蹴込板垂直**: `stairRunProfile`の一般概念「段板の厚み」`treadThicknessMm`（既定0＝斜めの蹴上のまま。鉄骨・RCは不変）。>0かつ蹴込k>0なら1段の輪郭は蹴込板の足元→(垂直)踏面板の下面→(水平・k)段鼻面の下端→(垂直・厚み)段鼻→踏面。**段鼻`noses`は従来と同じ位置**。最終段は蹴込板を床の高さまで垂直に上げて終える。適用は`stairContribution`が`stair.structure===WOOD`のflightに30（`WOOD_TREAD_THICKNESS_MM`）を載せる（階段自体の材種で判定。建物構造では区別しない。裁定待ち）。**床の輪郭`stairCutFloorProfile`は歩行面のまま**（`surfaceOnly`。下面の切欠きを床線・遮蔽に混ぜない）。
- **踊り場の床の端＝登り出すflightの蹴込板の足元**: 踊り場から登り出すflight（折返しの復路）を縦断する面では、踊り場の床線（`landingFloorSpanX`。`landingCutPrimitives`と`stairCutFloorProfile`が共有）を段鼻位置ではなく足元（段鼻+蹴込k）まで延ばす。
- **1層＝1溶接ユニット（StairUnit）**: 鉄骨階段は「両側ささら＋踊り場周囲の桁枠＋上下FLでの躯体取り合い」を1つのユニットとして扱う。`stairContribution`が返す`unit`（板厚・ささら成・桁枠成・`anchorZs`＝躯体と取り合う高さの単一情報源）を`landingFramePrimitives`/`clipStringerToAnchors`が共有し、ささらは必ずFLで水平に終わる（`anchorZs`へ強制）。**踊り場桁枠**（`landing.frame.edges`＝front/back/side）は鉄骨・RC造階段（`hasLandingFrame`）が対象。見る向き（broadside＝帯輪郭／end-on＝断面矩形）は「cut.lineの向きが辺の向きと一致=lengthwise、不一致=crosses」という第2層の一般規則を踊り場全体に適用する。

#### 階段下・2a壁・断面線の外
- **階段下に部屋があるか・ないかで踊り場下の表現が変わる**: `switchbackCuts`が`underFloorZ`（部屋あり:`landingAbs`／なし:0）を1箇所で決め、**cutの`baseFloorZ`と帯のfloorSegmentsの床**の両方がこれを使う（同じ値にするだけで「1FL断面線を描画」「左右の壁断面線を1FLまで延長」が自動的に満たされ専用の描画分岐は持たない）。判定は`cellsBeyondBreak`×`stairUnderRoomsOf`（仕上げモードの階段下壁生成と同じ単一情報源）へ委譲し、**判定不能なら「部屋あり」へ倒す**。ただし木造・RCで部屋なしは断面線で止まる（下記）。上の段落は鉄骨・部屋なしの話。
- **階段下部屋の2a壁は、階段の帯からは実体ごと見えない**: `switchbackCuts`が階段室自身（`cut.airRoom`）と階段下に指定された部屋の集合（`cut.underRooms`）を全cutへ載せ、`sectionHits.js`の`isHiddenWall`が壁ごとに判定する: 壁の両側のセルが指すRoomを見て、**片側だけが`underRooms`に含まれ**、かつ**その反対側が`airRoom`の連結成分（`componentOf`）と一致し**、かつ**壁自身が部屋の生成壁（`isRoomWall`）**である壁だけを非可視にする（isRoomWall条件は往復間の壁のような自立した間仕切りを誤って対象にしないための保険）。非隠蔽のまま残るのは反対側が階段室と非連結の部屋か片側が建物の外の壁。階段下の空間の壁の展開は階段下部屋自身の帯（「13」A〜D）が描く。平面図が破れ線より階段踏面側で2a壁を描かないのと同じ規約（`finish/stair/stairUnderClip.js`）。
- `isHiddenWall`該当の壁は`probeColumnHits`から消えず`hidden:true`を付けて候補に残り、選ばれれば付帯情報を持たない**`hidden`帯**（独立kind。アキ・見えがかり線のどちらの対象にもならない）になる。旧方式（候補ごと消す）は「その先の列が奥行き上限を超えて`open`になりアキのバツが誤って出る」副作用があった。**列の分割（`collectCutBreaks`）は`isHiddenWall`を判定しない**（面C自身の右端がこの壁自身のmaterialRange境界に依存しており、割らないと隣接CLの位置へずれて壊れる）。その代わり副作用は`sectionEmit.js`側の2箇所で個別に抑える: `uncoveredZRanges`（隣接列が`hidden`帯なら`cut`帯と同じく「覆う」側）／`ownsBoundary`（z方向で隣接する帯が`hidden`ならその境界の天端/下端線を描かない）。`cut.airRoom`/`underRooms`が帯の全cutで共有されるため、同じ2a壁が無関係な別の面（D1・A・D2等）でも非可視候補になり別の実体の縁線が生える回帰を防ぐ。
- **断面線の外は描画しない**: **断面線は1本の折れ線（FloorProfile。`elevationFloorProfile.js`）で表す**＝帯の床（floorSegmentsのステップ関数）と、**その切断が縦断する**階段寄与（`stairCutFloorProfile`）のmax（2FL断面→復路の階段断面→踊り場断面→壁断面と続く閉じた輪郭はステップ関数では表せない。規約は天井側の`ceilingProfile`の双子）。**分岐は2条件の論理和**: (a) 階段下部屋がある（`hasRoomUnder`。鉄骨はこれだけ）、または (b) その切断が縦断する階段寄与があり**断面線が繋がっている**（`stairSectionIsClosed(stair)`。蹴込板で階段下が閉じる＝現状は木造・RC。RCは斜スラブで下面まで繋がる）。どちらでもなければ輪郭を渡さない（＝下限なし＝設置階FLまで。部屋が無ければ帯の床は0なので下に何も無い）。縦断する寄与の無い面（seq1/seq3）は渡さない。将来Stairに「蹴込板なし」属性が入ったら、それが立つ階段は(b)がfalseになり下を描く（属性は未追加）。**(c) 直下階に階段があり、その破れ線先セル（`cellsBeyondBreak`。U字では踊り場より上側のレーンだけ）の上は自階の床が無い**——次節「下階に階段がある階の階段帯」。
- **縦断していない寄与は輪郭に入れない**（横切るレーンは切っていない＝断面線ではなく、`secondaryFlights`は見えがかり）。**短い寄与の端点値を面の全長へ延ばさない**（踊り場の1点が面全体を覆うと階段の勾配を飲み込む）。**対象は壁の断面・見えがかり・アキ・建具の姿だけ**（`clipContentAboveDrawnProfile`。`contentForCut`が`stairContent`/`structuralContent`を通さない）。階段自身の断面・階段の見えがかり（正面視の破線梯子・1FL足元線・ささらの端面）・構造梁は断面線そのもの／階段の一部で「描く」側（ただし**天が輪郭より梁成以上離れた梁は落とす**。階段下に浮く設置階FLの梁断面。踊り場受け梁〔role:'landing'〕と天が梁成以内で輪郭に届く梁は残す）。**水平線は輪郭より下のときだけ落とす**（床断面線そのものを巻き添えにしないため非対称）。
- **アキのバツは線を後から切らずセルの段階で輪郭まで持ち上げる**（`gapFloorProfile`。階段帯だけ）。**面端の縦線の下端も輪郭**（`ctx.floorProfile`。部屋帯・吹抜け帯は不変）。**区間の床線は「輪郭＝その区間の床高さ」の範囲だけ**（`floorSegments[].flatLineSpanX`。輪郭から導出する`withFlatLineSpans`ので断面線と床線が食い違いようがない。階段下に部屋があるとき、レーンの1FL線は上り口の外側〔壁のない端部のはり出し〕にだけ残り、踊り場の床線はジグザグの最下点が終点）。**床線が境界まで来ていない区間には段差の縦線も引かない**（階段の下＝断面の中に線が生える）。
- **設置階FL・上階FLの断面線のはね出し**: 初段の足元が面の端の外にあっても（木造の1段目は隔て板の柱の前縁＝通り芯−57.5から立ち上がる）、端の区間の1FL線は壁のない端部の延長から足元まで残す。最終段の天端がある端に壁が無ければ、上階FLの断面線（CUT）を天端の外側の点から壁のない端部の延長まで引く（`upperFloorEndLines`。端に壁があれば足さない。直進階段はこの経路を通らない）。
- **構造梁・柱**は階段帯でも同じ`sectionStructure.js`の探査の帯が描く（「2.5D立体の加算レイヤ」）。階段帯の構造寄与は`floorOcclusion`を渡す。
- **階段の断面ジグザグの向こうの壁の縁**: レイキャストは階段自体の占有形状を知らないため、seq2/seq4のレーン区間に「階段の向こうに見える壁」のz=0の輪郭線が全幅で描かれる。`clipWallFloorEdgeUnderZigzag`が断面ジグザグと重なるz=0の壁縁線を後処理で取り除く（**レイキャストを階段形状で塞ぐ一般化ではない対症療法**）。
- **往復間の壁の芯の一点鎖線**（`ctx.extraCenterLineXs`）: 往復間の壁は面の裏側へ伸びるため`collectRow1SplitPoints`の直交壁検出に掛からない。`cutTable.wall`の芯を面に直交する面だけに載せ、**一点鎖線だけを描く（寸法の鎖は割らない）**。
- **階段の断面プロファイルとの取り合い**（`joinToStairProfile`）: 下階天井の断面線は階段断面と交わるxで終え、上り切りの点からは上階床の断面線を近い側の描画端まで張り出す（プロファイルの実座標から求め、面やレーンの幾何を作図側で再構成しない）。**ささらの見えがかり（`isStringer`）は、実体で囲まれた矩形の厳密内部を描かない**（`isSolidBand`/`solidRectsOf`。囲む実体＝列の`slab ∪ cut ∪ cutAlong`。slabの矩形はその上に立つcut壁の向こう側の面まで延ばす〔`slabJunctionOf`と同じ規則・同じgate〕。`hidden`/`wall`は囲まない。対象はささらだけ。旧「固定z帯でカット」の特例は一般ルールに置換して削除）。**上階床スラブの断面線はスラブ自身から描く**（`slabEdgeCutWallJunction`。遠い壁の下端縁に頼ると壁が探索対象から外れた途端に線ごと消える）。
- **2F腰壁（往復間の壁がkneeDrop.knee指定）はseq1で上端水平線のみ・両端縦線なし**（`kneeWallCapContent`。天端はその後`cutWallTopEdges`へ移管済み）。**2FL水平線（above層の床端＝slab/open境界）は上階に実Roomが無ければ描かない**: `probeColumn`は`above.room`の有無でなく`isRealRoom(room)`（VOID/STAIR_VOID以外）で判定する（VOID/STAIR_VOIDは'open'）。**見えがかり壁のz上限は「上階に実Roomがあるか」で決める**（`resolveSightlineTopZ`＝実Roomに出会うまで上へ登り、その手前の層の天井を上限にする。常に自層CHで切ると上が吹抜けでも1F天井高さの水平キャップ線が出る。上階が吹抜けなら上階の天井まで拡張される。この拡張で同一の壁が他の層のzBreaksで内部分割されうるので`mergeAdjacentZBands`がz方向の隣接bandを併合する。ただし`cut.baseFloorZ`の境界は併合しない＝「下側だけ破線」を再現するため）。
- **レーン面の天井は「上階に実床があるか」の実測が唯一の情報源**（`buildLaneFloorAndCeiling`＋`aboveRoomSegmentsOnFace`）: 面に沿って区間ごとに上階のRoom（VOID/STAIR_VOIDは実床無し）を1点プローブし、**床あり＝1F天井高さ`ceilLowAbs`／床なし＝上階天井`ceilTopAbs`**を割り当てて`stepCeilingProfile`で段にする。勾配天井リテラルは`aboveLayer`が無く判定できないときだけのフォールバック（「実Room有無がface全体で一様なら実測を捨てる」短絡は誤りと判明して削除）。**「上階が最上階なら往路上の天井を1F天井高さでキャップする」旧仕様は廃止**（成立条件が弱い推測で、天井は常に`chUpperAbsMm`に揃える。回帰テスト`elevationStair.test.js`の「【最上階キャップ廃止】」）。
- ゴールデンゲート: 通常部屋帯・吹抜け帯はエンジン導入の影響を一切受けない（`elevationSectionGolden.test.js`）。階段帯は一般規則を優先し手書き出力との一致度は問わないが、ユーザーが実機で確認した意味論（歩行順1〜5・見返りの梯子破線・往復間の壁の断面・アキXの配置・B/D面の鏡像関係・2FLの中線・CH寸法の2FL分割・踊り場床CUT線など）は`elevationStairSequence.test.js`の意味論アサーションが保存する（落ちたときに実機で困る変化かどうかが仕分けの基準）。**意図的差分**: 往復間の壁・踊り場壁の断面は塗り矩形から3線（天井際CUT水平線＋両端CUT縦線の輪郭のみ）へ変更し、seq1の壁2縁の線種は一般規則（切断壁の縁は常にCUT）に置換した。
- 帯の縦CH寸法線を2FLで分割: `layoutBandFaces`のi===0ブロックに`faceOverride`経由の`chDimSplitAbsYs`フック。SWITCHBACKのseq1は`[floorHeight]`（=2FL）を設定し左CH寸法が「踊り場床→2FL」「2FL→2F天井」の2本になる。`buildFaceFigure`の`ctx.floorSpanX?:{lo,hi}`（腰壁越しに向こう側の床・天井断面線を壁位置で打ち切るフック）は透過の準備だけで往復間の壁・踊り場壁が腰壁のときの値の供給は未接続。

### 階段帯の天井は階段の裏面（E5）
木造で、直上階に同じ足元の続き階段があるときだけ（U字系・直進系とも。E5-2＝2026-10-25。型の絞りは`buildStairBand`の関門ではなく`stairUndersideSurface`がL_TURN等でnullを返すことで足りる）。供給源は`space/stairSoffitCeiling.js`（式は`ceiling/stairSoffit.js`の`stairSoffitSolids`が唯一。天伏の見上げと同じ述語`matchingStairBelow`・同じ引数なので同じ立体）。`buildStairBand`が自階の層に`layer.stairSoffit`を載せ、**評価する奥行きは切断線`cut.line.axisValue`**。
- **体裁の`ceilingProfile`とエンジンの`cut.ceilClip`は同じ区間列から作る**（`applyStairSoffitToCut`。節＝切断線の深さを含む矩形の辺・折れ目〔前縁・対角線・x=pv〕との交点・足元の途切れ。節の間は厳密に直線）。足元の外・途切れは各seqの既存の天井（seq2/4=NのCH／上階天井の階段状、seq1/3/5=上階天井）でつなぎ、境目で値が違えば垂直の段。値は部屋FL基準のch（`cellAt`だけが`floorZFor`〔床段差込み〕に足す＝供給源で足すと二重）。`cellAt`は階段室のセルだけ層スタックの天井を裏面にする（列の幅の最大）。切断壁の天端と笠木の下線（`cutWallTopEdges`）は壁の連なりが覆う列の打ち切り値`col.ceilZ`の最小と比べて決める（帯全体の`hiZ`と比べると、列で裏面に打ち切られた壁に天端が二重に出る）。
- **隔て板（往復レーンの境界の壁。上階の隔て板の材の範囲＝`partitionStripOf`）の帯をはさんで裏面の高さが違う幅方向の切断（seq1/seq3）では、低い側の天井を帯の向こう面まで水平に延ばし、立下りを高い側の面に置く**（`extendLowerCeilingAcrossStrip`。仕上げ材は隔て板を包むので断面は中心から部屋側に寄る。切断線と平行な壁には掛けない）。**壁のない端（上り口。`face.hasWallAtLocal0/Run`=false）で裏面の端がその端の既存の天井（base。seq2/4だけが持つ）より高いときは、斜めの天井断面を端から隔て板の壁厚/2（57.5）入ったbaseの高さの点で終え、端まではbaseの水平**（`endSoffitAtOpenEndCeiling`。入りは復路下の仕上げ空間の天井線と同じ量。幾何の交点ではなく置き換え）。
- **隔て板が上階へ続く切断（seq1。木造U字階段の最上階以外。`cut.continuousWallAcross`）では隔て板は床から天井断面線までの1本の断面**（`sectionEngine.js`の`mergeContinuousWallBands`が自階と上階の壁の帯を合併し、継ぎ目の天端・笠木・天井裏の帯を落とす。段違い天井の境界に立つ壁の見えない側の縁も低い側の天井〔列の打ち切り値〕より下は描く）。切断線が内部を横切るflightの本体（裏面〜切られている段板の天端。`crossingFlightBodySections`）は裏面の切断を太線で描き、本体に接する壁の縁はその区間を空ける（`clipWallEdgesInsideStairBodies`）。木造階段の最上階は除く（従来どおり天板〔隔て板の天端〕の見え掛かり）。
- **空中を横断する梁の見えがかりは、その位置の天井より梁の下端が上なら描かない**（`opts.ceilZAtWorld`。供給源は階段室の裏面だけ。裏面の無い階段帯〔鉄骨・上階が吹抜け〕は部屋のCHで判定しない。評価点は梁の芯から切断線側へ1mm寄せる。**判定は区間の全か無かではなく、天井の状態が変わる所で区間を割り天井より上の部分だけ描かない**＝`splitRangeByPredicate`。裏面の天井は復路レーンの上だけで、両レーンにまたがる1本の梁を3点で見ると復路の上まで全長が出る）。
- **壁のない上り口の辺を見るseq1（`face.hasRealWall===false`。往復レーンの境界の仮想の面は含めない）の隠れ線と開口**: 切断線が横切るflightの矩形（`flightHiddenRects`）のうち、**天端が切断面にある＝視線の向きへ下るflight（蹴上材を裏から見る）だけが切断面上の線も隠す**（`planeHides`。壁の断面の縁・構造梁の見えがかりと、図側の床線・面端の縦線〔`elevationStair.js`が`entry.occludedRects`で同じ矩形を当てる〕を細線破線に。上辺＝段板の断面線・踊り場の床線は見えている）。初段が切断面にあるflightと内部を横切るflightは向こうの線だけを隠す。面の向こうの部屋（ホール）へ開く区間には、向こうの部屋の天井の縁（中線）と床〜その天井のアキのバツ（`openingPanelPrimitives`）を描く。**辺の上に立つ壁の帯（壁の軸CLが面の軸CLと同じ。上階の層も同じ述語）は、列ごとに床〜天井から差し引いた残りだけが開口**（フルハイトなら無し・腰壁なら上・垂れ壁なら下）。向こうの部屋があるかだけで決めると上階の辺にフルハイトの壁がある区間にもバツが出る。壁の軸で見るのは、向こうの部屋の奥の壁を開口の閉じと取り違えないため。「踊り場前縁・回転部にアキは標記しない」は壁のある辺を見る面の話で、壁のない辺の開口には標記する。
- `cut.zRange.hiZ`は裏面の最高点まで広げる（**頭打ちしない**。復路の到達側は上階天井を超える）。CH寸法は踊り場側の端の上端だけその端の裏面の実測値（四捨五入）。
- **階段下の部屋の帯の天井＝自階の階段の裏面**（S8-4-2・2026-10-25 ユーザー裁定）: 自階の階段の足元に掛かる階段室以外の部屋の帯は、その階段が「仕上げ」（`ceiling/stairSoffit.js stairSoffitFinished`＝木造または`soffitFinish:'finished'`）のとき天井＝min(区画/部屋の天井, 裏面)。供給源は階ごとに1回の`elevationSolids.js underStairSoffitsOf`（`stairFootSurfaces`の面。`ElevationModeState`と`elevBandDump.mjs`の solids）。注入は帯ビルダー側だけ: `buildRoomBand`が`ctx.faceOverride`を合成して`minCeilingSegmentsWithSoffits`（`space/stairSoffitCeiling.js`。面の位置`face.faceValue`で評価・区間を裏面の節と交点で割り`chMm`/`chHiMm`を min に・項目を保つ）を`floorSegments`に掛ける＝図の天井線・CH寸法・エンジンの`cut.ceilProfile`（`appendBandCutContent`が`faceRuns[].floorSegments`から作る）が同じ区間列になる。この帯には`stairOver`（階段の見え掛かりの機構）を渡さない＝一般規則が特例を置き換える。「あらわし」（鉄骨の既定）の階段の下は従来どおり（CHの天井＋stairOverの見え掛かり）。実データ83本に「仕上げの階段の下の部屋」は無く、基準は合成文書 ceiling-wood-stair-under-test（鉄骨の対照 ceiling-steel-stair-under-test は不変）。**壁・柱型の天端**（S8-4-5）: 柱型の縦線は断面エンジンの帯ではなく加算レイヤ（`droppedMemberPrimitivesForFace`→`structuralColumnPrimitivesForCut`。傾いた天井の列では柱の端が`edgeDropped`に落ちる）が`hiZ`まで引くので、`opts.topZAt`＝天井線と同じ点・同じ式（`underStairSoffitTopAt`）で止める。壁は帯の天井＝裏面が止めるので、足元の天端（footCap＝`wallFootTopProfile`。評価は面の位置〔部屋に面する帯の縁〕・`layer.underStairSoffits`から作り再計算しない）は**天井断面より低い壁にだけ**付ける（天井に届く壁に付けると列が割れて段ごとの縦線が出る）。切断壁と面に直交して奥へ延びる壁には使わない（長さ方向1点の水平線が傾いた天井の下で厚みの中で食い違う）。注入が無い帯（階段帯・吹抜け帯・あらわし）は従来どおり。既知の限界: 上部吹抜け付きの階段下の部屋（`buildRoomBandWithVoidAbove`）には配線していない（階段の下に吹抜けがある形は現実的でない）。区間の割れ目には`zoneCeilEdgeHi`（壁の無い境目）を付け、図側が半壁厚ずらさないようにする。裏面の高さの基準は階段室の実効FL（datum ではない）。
- **直進系**（E5-2）: `buildStraightFaceSequence`が各cutに同じ`applyStairSoffitToCut`を通す（baseはnull＝直進系の既存の天井は上階天井の水平だけ。足元の外は`cut.zRange.hiZ`でつなぐ）。裏面の最終rampはU字系と同じ規則で上階天井zCapで頭打ち（`straightSoffitFromLayout`。交点で斜面を終え折れ目1本、以降は平ら。見上げも同じ立体）。seq1（上り口の壁の面）の天井は階段室のCHまで下がり、その上はceilClipで打ち切られる（帯のはね出し150が消え端の壁は面端の縦線＝太線になる。裁定R2）。U字系専用の後処理（隔て板の帯・soffitEnds・CH寸法の鎖）は通さない＝先頭面の左のCH寸法（部屋のCH）が裏面の上り口の高さと一致する。

### 復路下の仕上げ空間
木造階段の復路の下は仕上げられた空間で、天伏ではその天井は復路の裏面（`.claude/data-model.md`「復路下の壁」）。復路レーンを縦断するseq5で、その階段に復路下の壁（`stairUnderReturnLines`/`isStairUnderReturnWall`）が立ち切断線がその壁と交差するなら、壁の踊り場と反対側（到達辺側）から壁の**仕上げ空間側の面**までを仕上げ空間とみなす（`underReturnSpaceOf`。壁の厚みは含めない＝壁の断面線は階段下スペース側の面の縦線だけ）。壁・裏面の立体は壁の天端（`addUnderReturnTops`）と**同じ供給源**`ceiling/stairSoffit.js stairUnderReturnSoffit`から引く。
1. 断面線（`floorProfile`）はその範囲を**床（階段室の床）に置き換える**（`floorProfileWithFloorOn`。壁の厚みを含む。境目は垂直の段）。床線（`withFlatLineSpans`）が壁まで伸び、壁の断面がクリップされなくなる（この範囲でも復路の段板の裏を断面線の下限にすると仕上げ空間を丸ごと落とす）。階段下に部屋があって帯の床が踊り場でも、この空間の床区間は階段室の床。
2. 天井＝復路の裏面を切断線の深さで評価した折れ線を**天井仕上げの断面線（中線）**として足す（`underReturnCeilingPrimitives`）。到達辺側の端は**Y4＋壁厚/2（裏面の始まり＝最上段の段板の前縁）とFL+CHの交点**（裏面の実高ではなくCHから壁へ下る1本の線。垂直の段は無い。天井の段を到達辺でなく裏面の始まりに置くのは裏面の立体がそこから始まるため）。壁側の端は裏面が壁の仕上げ空間側の面に出会う点で、壁の面の縦線をそこまで太線で延ばす。
3. 復路の**本体の中**（裏面〜段板の上面＝床へ下げる前の断面線）にある壁の断面・見えがかり・アキは落とす（`clipContentInsideStairBody`。`clipContentAboveDrawnProfile`をz反転で裏面より下、そのままで本体より上に2回掛ける。範囲は裏面の節列が覆うxだけ。本体の上〔復路の上の空間〕は残す）。
4. 上階FLのはね出し（`upperFloorEndLines`）は床へ下げる前の断面線（`entry.stairFloorProfile`）で最終段の天端を探す。
5. 輪郭の垂直な段の上に載る縦線（壁の断面の面が段の位置に一致）は両側のうち低い方の輪郭で切る（`clipSegmentAboveProfile`）。段板の裏（ジグザグ）は階段自身の断面として残る。
6. **巾木**: 階段帯は巾木を描かない（`skipBaseboard`）が、この空間だけは**到達辺の外側の部屋**（到達辺から面の外へ100mmの点を`probeCtx.cellAt`で引く）の`RoomFinish.baseboardHeight`（`parseBaseboardHeightMm`）で床＋hの細線を引く（`underReturnBaseboardPrimitives`）。到達辺側の面の端に壁が無いときだけ外側の部屋を見る（壁があれば外側は壁の向こう）。解釈できなければ引かない。到達辺に壁が無く面の壁が到達辺の外へ続くなら小口まで伸ばす（`wallContinuationBeyondFaceEnd`）。
鉄骨・下階に続き階段がある（復路下の壁が立たない）・seq5以外の面・直進系は不変。

### 下階に階段がある階の階段帯（`section/lowerStairVoid.js`）
直下階に階段があり、その破れ線先セル（`cellsBeyondBreak`）の上は自階の床が無い。**その列では切断面にある自分の段板の天端（端ちょうどに立つ切断はその端の歩行面）が断面線**。その下は下階の階段が上がってくる吹抜け＝下階の階段帯の空間で、2FLの床線・隔て板や壁の断面の縁・段板の下辺・開口のバツはこの帯の内容ではない。判定は材質・階段タイプによらずセルと切断線の幾何だけ。この列に限り階段自身・構造・アキ・開口も断面線より下を落とす（対象は吹抜けの区間のうち切断面の段板がある所だけ。縦断する切断〔seq5/6〕の断面線は勾配の近似なので階段自身のジグザグは切らない。区間の境界に立つ縦線は輪郭の段の低い側ではなく区間の内側の高さで切る）。**区間の境界が自階の切断壁（隔て板）の材の中に落ちるときは、壁の断面の縁は壁の吹抜け側の面から上、床線と階段自身・構造・開口は壁の手前の面で止める**（`lo/hi`と`floorLo/floorHi`の2境界。吹抜けの縁に立つ壁の下に床線や2FLの床梁の見えがかりを通さない。面の端の外壁は端がその手前の面なので寄らない）。直下階は`buildStairBand`の`ctx.lowerGraph`（展開モードの直下階peek。probeも同じ）。**自階の上り口の開口（天井の縁＋アキのバツ）もこの区間には描かない**（敷居がこの帯の床ではなく、その開口は下階の階段帯が上階の開口として描く）。上り口の面の開口は辺の上に立つ壁の帯を差し引いた残りだけ。往路側（自階の床がある）・1階・seq5/6は不変。

## 回り階段（WINDING）の展開
- 回転部（回り段 w マス）は、平面の段の多角形（`stairTreadFootprints`のinstallの扇形セル。`stairContribution`が`turnCells`に持つ）を**切断線ごとに切った**Landing（`turnCellSlices.js`の`sliceTurnCells`。公開の入口で`withCutLandings`が足す）で描く。高さ＝往路の段数×蹴上＋(段番号−最初の回転段)×蹴上。レーン線は走行方向の区間に、seq1/seq3は幅方向の区間になる。
- 線が辺（放射線・前縁）に乗るときは回転部の奥（+t）側のセルを採る。辺（頂点）から0.5mm以内は乗っているものとして扱い、寄せ先は**全セルの全頂点から1回だけ**決めて全セルで共有する（セルごとに決めると隣り合うセルの縁が食い違い蹴上が落ちる）。
- 隣り合うセルは放射線を共有するので、蹴上は`landingStepRisers`がCUTの縦線で足し（平面の放射線とレーン線の交点に一致）、床の輪郭は`stairCutFloorProfile`のmax合成で段状になる。復路の足元は回転部の最後の段（折返しは踊り場1枚）。`switchbackCuts`に通すので`LANDING_CUT_INSET_MM`も効く。seq1（frontA）は、往路側は frontA が回転部の最初のセルの前縁に乗るのでそのセル（奥側）の床を引き、復路側は踊り場でなく復路の初段の段板を切るので段板の断面（CUT）になる。
- 区間長・段数は`resolveUTurnSpanLengths`（`stairClassify.js`。折返し＋回りの唯一の供給源）。**構造側（`resolveSwitchbackSpanLengths`・`landingRect`・`landingZ`）は折返し専用のまま閉じる**（開くと`structuralAutoFill`が回り階段にも踊り場受け梁を作る）。展開図は型判定なしの`uTurnTurnRect`で矩形だけ借りる。`fanCuts`はL_TURN/FLARED/OPEN_WELLだけ。
- **U字系の展開図は平面のinstall枠を共有する**（`uTurnPlanLayout`）。走行方向の位置（往路・復路の端、踊り場の前縁・奥）はCL区間長から再計算せず、`stairContribution`が平面の解決値だけから取る。外縁は壁の面、内縁はレーン中央（鉄骨のあき100は`ladderAcrossRange`）。柱のある木造は往路側の前縁（frontA）と復路側の前縁（front）が分かれ、踊り場は本体＋往路側の延長矩形（同じ高さ）の2枚、seq1はfrontA（復路側は復路の初段を物理的に切る。切断線がflightの内部にあるときはその位置の段板の天端にCUT＝木造は厚30の矩形）、seq3はfrontから奥へ。切断線がflight・踊り場の端から`STAIR_RUN_TOL_MM`(0.5mm)以内なら両側を含む。踊り場が浅く前縁が奥を越えるときは前縁を奥に揃える。直進部の蹴上は平面の踏面線と一致する。段板の断面の幅は、隔て板があるとき内縁を隔て板の面で止める（梯子の内縁はレーン中央のまま）。
- 階段下の部屋の帯（`elevationBand`）は、切断線がflightの内部にあっても段板の断面を出さない（`treadSection:false`。「階段の高さ」細線を保つ）。**「階段下の部屋」の判定（`flightsOverRoom`）は部屋の実セルで行う**（flightと実セルの交差が覆う領域に`STAIR_OVER_ROOM_MIN_OVERLAP_MM`を両方向で超える矩形が収まるか。包絡矩形で見るとL字の部屋の切り欠きの階段室で包絡矩形だけが階段と重なり面の全幅に「階段の高さ」の細線が出る。`cut.bandRoomBounds`は従来どおり包絡矩形）。
- 隔て板がある階段室の面は6枚になり、レーン境界（s≈0.5）の実壁の面が外壁側の面と同じ側に入る。`classifyFaces`は同じ側に外壁側の面があればそれを除く（実壁でない2a壁の面は従来どおり）。
- **L字の部屋（不等長の U 字階段。S10-7 S1・2026-10-25）**: 面の分類は「部屋の外形は矩形で上り口の辺は1本」を仮定しない。`classifyFaces`は平面の解決値（`contribution.frame`。`stairContribution`を先に呼ぶ）があれば、直交する面を**踊り場の前縁`frontA`を越えて奥側なら踊り場・それ以外は上り口**で振り分け（矩形の部屋＝直交する面が t=0/1 だけなら t の近さと同じ結果）、`mergeFaces`の基準面は理想位置に最も近い面（同点は並び順。S1 では上り口・踊り場だけ、S2 で out1/out2 も）。往復間の壁（隔て板・2a壁）は`findMidWall`が**レーン境界の座標`acrossCoordAt(0.5)`**で探し、候補が複数なら踊り場前縁まで届く壁を先に採る（切り欠きの縦壁と隔て板が同じ軸CLに並ぶ構成）。実データの真の不等長は moku1-4/5/6 の WINDING 3件だけ（`|baseA−baseB|`は木造の柱の面で 90/115mm ずれるので等長の判定には`measureStairSpans().lengths`を使う）。seq6（隔て板の面）は`stairHasPartition`（構造の規則: 木造＝あり／鉄骨＝なし）×`isStairPartitionWall`（座標照合）の AND で出す＝壁リストの並び順に依らない。この結果、構造なし（鉄骨扱い）の basement-test-null/rc 1階「6」では座標照合だけで出ていた seq6（B1/B2）が無くなり B の 1 面になる（2026-10-25 の全数比較で判明。規則どおりだが目視未）。検証データは stair-ports-test8〜11（`makeStairPortsTestDoc.mjs`）。S2（2026-10-25）: 上り口の面は**平面の往路の基端 `run.baseA` に最も近い面**（復路が長い L 字では包絡の辺ではない。baseA に面が無い＝切り欠きに壁が無い構成は最寄りの面のまま＝受容）、out1/out2 も理想位置（|s|・|s−1| 最小）に最も近い面（2a 壁の面が先頭に来る構成で外壁が正しく wOut1 になる）、**不等長のときだけ** seq2・seq6 の枠（face と cut.line の lo/hi）を wOut1・wOut2 の走行範囲の和集合（`unionLaneFace`。端の状態はその端に届く面から・両方届けば wOut1 優先）にして復路の flight を枠に収める。等長は実データ 83 本では出力不変（組に除外壁〔2a〕の面が先頭で並ぶ構成では等長でも wOut1 が外壁に変わる＝単体 fixture で確認。実データに該当なし）。変わるのは合成 test9（上り口 −7280→−7900・seq2/6 の枠 [−9027.5,−7280]）と test10（wOut1 が 2a 壁→往路外側の壁）だけ。`diffStairElevPlan` の「展開図だけ 1 本」（seq5/6）は等長でも出る既存の差で未調査。
- **回転部の向こう側の段の見えがかり**（`farSideSilhouettePrimitives`）: 縦断する切断で、切断面の奥にあり視線から遠ざかって立ち上がる段（低い側のセルが視点側にある共有辺）を細線で描く。段鼻の水平線と両端の縦線（切断面で切れた端は切断の蹴上が太線で描く）、視線と平行な辺は縦線1本、全体が奥にある復路の蹴込みは縦線。手前の壁・断面に隠れる部分は描かない（斜めの天端は交点で分ける。列の境界上の縦線は両隣がともに覆う高さだけ隠す）。階段下の部屋の展開には出さない。壁の端の柱と取り合う端（隔て板の回転部側の端）に蹴上が集まる縦線も細線で引く。壁の端の縦線（recess）は端面に突き当たる回転部のセルの天端より下を落とす（`clipWallEndVerticalsByStairMass`）。折返し（回転部なし）の復路は描かない。
- **蹴上材を裏から見る面（材質によらない手順）**: 横断の切断が回転部のセルを切る面（seq3）は、切断面の向こうで段が視線から遠ざかって下る＝蹴上材を裏から見ており、蹴上の向こう側の踏面と壁に取り合う蹴上線は蹴上材に隠れる。**断面線（切断面上のスライスの床線・蹴上）は太線のまま変えない**（階段の断面線を破線にしてはいけない）。それとは別に「断面線と壁の間にある踏面」（各セルの切断面の向こう側の幅の範囲に、そのセルの高さの水平線。断面の床線と重なる範囲は除く）と「壁と取り合う蹴上線」（隣り合うセルの共有辺の向こう側の端に、低い段から高い段までの縦線）を細線で足す（`hiddenTurnStepPrimitives`）。描かれた断面線で上下に分ける（`clipHiddenStepLines`/`clipHiddenSegmentBelowProfile`・`clipHiddenSegmentAboveProfile`）: **断面線より下＝断面の後ろに隠れた区間は細線破線**（視線の向きへ下る側の踏面・壁に取り合う蹴上の縦線は断面の床の後ろ）、**上＝断面の前の空間で見える区間は細線実線**（上る側の踏面の線が断面の段から壁まで）。縦線は段の上（断面の蹴上）と面の端（壁の縦線）には出さない。面の断面線は段状の天端（`crossingLandingFloorProfile`）で、閉じた断面図形の外に太線を残さない。基準のスライスが切断の基準床と違う面（seq1）は帯の床のまま。同じ理由で正面視の梯子（`flightLadderPrimitives`）は視線の向きへ下るflight（seq1の往路）を材質・階段下の部屋によらず破線にする。切断線の手前にあるflight（直進のseq1は上り口辺に立ちflightを背にする）は対象外。
- 限界は末尾「既知の限界」。

## 取りつき区画（側面の上り口 e 段・到達口 a 段）の展開
- 区画の位置・番号・高さは平面の解決値（`uTurnPlanLayout`＋`stairTreadFootprints(…,'install')`のセル多角形）だけから取る。回り段と同じく`sliceTurnCells`で切断線ごとに切り、`withCutLandings`が回転部・上り口区画・到達口区画を別領域として寄せる（区画を平行な踏面で等ピッチに割る旧`Flight.leadSteps/leadMm`は扇形のセルと食い違うので廃止）。
- 番号の唯一の供給源は layout の`entryNumbers`（1..e）／`arrivalNumbers`（S+e..S+e+a−1。最後＝totalSteps−1、到達辺の先が上階床）。展開図で数え直さない。
- 平場（e=0／a=0で側面の口）は矩形Landing（上り口z=0、到達口z=上階床）。外縁の段差は`edgeRiser`の縦線（上り口辺の床→最初の段、到達辺の最後の段→上階床）で足す。レーンを縦断する切断で外縁に接するセルだけに付け、横断・平場には付けない。
- 往路flightは`underSteps`(=e)、最後のflightは`overSteps`(=a)で、正面視（seq1）の梯子の段数と足元の高さを区画ぶん補う。走行端の口は区画を持たず従来どおりflightが口まで続く。

## 直進系（STRAIGHT／STRAIGHT_LANDING）の展開
- U字系と同じく走行方向の位置は平面の解決値`straightPlanLayout`（設置階のinstall枠）だけから取り、通り芯の枠・CL区間長からは再計算しない（通り芯の枠は面の分類にだけ使う）。側面の口の区画は上の節と同じ仕組み。
- seq1（上り口の壁）は上り口辺＝install枠の基端（壁仕上げ面）に立ち、側面の上り口でも基端のまま（区画はseq2/4のレーン線で切れる）。到達端の面（seq3/seq5）はinstall枠の終端。踊り場壁の探索中心は踊り場の手前の縁land1。切断線のlo/hiは`faceFromCut`と同じく直交壁の面へ寄せる。直進系にささら・桁枠・蹴込・段板厚は付けない（U字系との差。付けるかは裁定待ち）。直進系の帯の content は U字系と同じ`buildCutContent`へ載せ、上階のはね出し（`upperOverhangOf`）も図側へ（`buildSectionFigure`の2本目の経路は削除済み）。

## 平面との照合の関門と階段の暫定事項
- **到達辺**: 木造U字系の復路の到達辺はN+1の床梁の外面＋壁仕上げ（`stair-model.md`）。展開図は層スタックの直上の層のgraph（`opts.upperGraph`・`above.graph`・`solids.upperGraph`）を`stairContribution`／自階の裏面／復路下の壁の天端へ渡して平面と同じ面を使う。
- 暫定・裁定待ち: (1) 到達口の平場の高さと到達辺の縦線（実データに側面の到達口が無く合成テストだけで決めた。上階スラブの小口と重なる見込み） (2) 詳細LODの平面の踏面線は±nosing 20だが展開図はセル境界のまま（寄せるかは未裁定） (3) 直進系に蹴込・桁枠・段板厚を付けるか。別件: 両口とも側面で隔て板の柱がある構成では、平面側の上り口セルと到達口セルが幅方向に重なる（平面の既存挙動。展開図はそのまま写す）。
- **関門probe** `scripts/probe/diffStairElevPlan.mjs`: 展開図の階段のジグザグの段鼻・回り段/区画の縦線を世界座標へ戻し、平面の踏面線との交点に両方向で照合する。**縦断の段鼻だけ**を見る（横断seq1/seq3と面の両端は未検査）。テスト用.stqは`makeStairPortsTestDoc.mjs`（stair-ports-test1〜5）。

## 階段の高さ寸法（CH寸法）の記入ルール
規則は2つだけ: **(1)寸法は「床断面・踊り場断面・天井断面のいずれかから、いずれかまで」を1本とする** **(2)帯の左から端を順に見て、前の端と高さが変わったときだけ記入する**（先頭の端は必ず記入）。面の左右の端ごとに断面プロファイルが決まる: **踊り場スラブが切れる端**は`[1FL→踊り場][踊り場→上階天井]`（階段下に部屋があるときは踊り場より下が別室で帯の床が踊り場になるため`[踊り場→2FL][2FL→2F天井]`）、**切れない端**は壁の向こうの通常断面`[1FL→1F天井][2FL→2F天井]`。踊り場側がどちらの端かは面の向きで決まる（幅方向に横断するseq1/seq3は両端とも踊り場側、走行方向のseq2/4/5は片端＝切断定義表の`landingEnd`）。
判断は`elevationStairSequence.js`の`stairChDimChains`が**一括で持つ**（踊り場スラブ・壁の向こうの部屋の断面が要るため帯レイアウト側では判定できない）。`layoutBandFaces`は`faceOverride.chDimChains`（{left,right}）を受け取ったら**それだけを描き**、既定の「先頭面の左CH寸法」「継ぎ目のhasLeftChDim」は使わない。`buildFaceFigure`も`ctx.chDimChains`があれば面ごとの右CH寸法を描かない（二重に出る）。階段の裏面（E5）があるとき、踊り場側の端の鎖の上端（上階天井）はその端の裏面の実測値（四捨五入。`h.soffitEnds`）。壁の向こうの通常断面の端は変えない。

## ビュー位置の階別記憶・建具パネル連携
`ElevationModeState`はモジュールレベルの`Map<floorId, {...}>`（セッション内のみ。IDB永続化なし）で階ごとのscrollY・faceScroll・表示中の部屋を記憶し、同じ階への再突入（`dispose()`→`init()`）で復元する。記憶した部屋が消滅していれば、記憶時点で1つ前だった部屋（`graph.rooms`順）の帯位置へフォールバックする。floorIdは構築時（`project.activePlane.id`）に一度だけキャプチャする（dispose()時点では`project.activePlane`が既に次の階を指している場合がある）。

展開図の建具記号丸（`tag`プリミティブの`openingId`）はクリック可能。`ElevationModeState.selectedOpeningId`/`selectOpening()`は`OpeningModeState`と同じAPI名にしてあり、建具モードの`OpeningPanel.jsx`をelevationモード中（appModeは切り替えない）でも再利用する。**パネル表示中も展開図のドラッグ・ホイールスクロールは自由に行える**（規制は一度入れたが撤廃した）。パネルでの編集はMobX reactionで`graph.openings`の各Openingの表示に効くフィールド（committed値。確定のたびに1回だけ発火）を監視し、変更があれば帯を全再構築して即時反映する。クリック対象は建具記号丸のみ（姿図は複数の生プリミティブへ分解済みで個別の建具IDを持たない。defer）。

## 既知の限界
**受容（直さない）**
- 帯の再構築の署名は id と鍵だけを見る。id が同じで中身だけ変わる変更（構造スナップショットの undo で柱寸だけ変わる等）は検出しない。
- 天井: 円弧・ドームの遠側は部屋のCH／頭頂を含まない片（面の端寄り）は弦＝直線／上限64本に当たる半円に近い巨大な円弧は等角に刻み鉛直差が1mmを超える／別の階の下階延長で covered が分割されると端の高さが傾斜と同じくずれる／`beyondCeilings`の破線は円弧の片では頭頂より上だけ／階段帯は円弧未対応／ドームの壁面断面は放物線だが3点円で近似（数〜10mm級）。アキ越しの別室の走り方向の傾斜は遠側の天井線が出ずアキの上端は近側の天井。奥の端の探索は64矩形で打ち切って null（部屋のCHに落とす）。傾斜区画内の垂れ壁の下端は最高点基準。
- 斜めの天端・斜線: 斜線の途中にある壁（斜線の高い側に届かない壁）は低い側で水平に打ち切るため側縁（中線）が斜線より数mm上に出ることがある。斜線と帯の上端（高い側）の間の三角の奥は隠す側に倒すので、奥の壁の端の縦線が斜線の下端から帯の上端まで欠ける（上り口側の列で最大1列ぶん）。`profiledTop`の壁が cutAlong経路に来るのは自立壁だけ（隔て壁は`isRoomWall`で来ない）。
- **体裁の開放スパンは遠側の最初の片だけ**（`farCeilAbsMm`は入口の面の値。奥の別の区画は出ない。エンジンの cellsAlong は面ごと）。統合案U4は採らないので受容。
- 帯CH基準のまま: 上部吹抜けの上階ぶん（voidCH 1値）・段差見付け面（その上部アキの上端も。両側の実天井へのクランプは未対応）・垂れ壁のアキ・壁2段書きの縦中心(-CH/2)・階段帯の上階クリップ縦線。壁から約60mm以内で平行な天井芯。区画の境界で床線・巾木も区間ごとに割れる（同一直線上の実線2本。見た目は不変・golden では差分に数える）。
- 左右反転した同型のL字（段差が出口側に来る配置）では開放スパンの規則2.5が掛からず重複区間が残り、パネル統合の条件3も不成立で面は2枚のまま。実機で該当が出たら規則2「見通しは出口側の面が担う」との優先関係を裁定で決め直す。
- 回転部の細線（向こうの段の見え掛かり）が隔て板の帯の x 範囲を通る（moku4-3 1階 B1。`farSideSilhouettePrimitives`の扇の段鼻＋端の縦線、帯内 x 852.5〜1308.6・z 1200/1400）。線の奥行き 247〜397.5 は隔て板の面 410 より**手前**で幾何的に正しい線（遮蔽の不具合ではない）。消すには「壁面に取り合う線は壁の x 範囲で描かない」という非物理の規則が要り B2・2階に副作用が出るため、**2026-10-25 ユーザー裁定で現行のまま＝仕様**。
- 遠側（隣室の帯から見える階段室の天井）は平らな部屋の CH のままで上階の階段の裏面にしない（E5-3。**2026-10-25 裁定で受容**）。実データ 83 本の全数走査で、続きの階段がある階段室 36 室に対し隣室の CH が階段室より高い構成は 0 件・吹抜け帯が接するのは wood-void-test の 1 件だけ＝裏面（最低点＝階段室の CH）は隣室の帯の上端より上で見えない。やるなら`cellsAlong`本体（`cellAt`を通らない・階段室は家族でないので体裁の`face.spans`には効かない）。
- 階段由来の clip（`clipContentInsideStairBody`ほか）: 範囲の中の rect は復路の本体より上の部分も落ちる／範囲の端ちょうどの縦線は「段の低い側」の規則で切らない／範囲の端から GAP_EPS×3 の帯では本体より上の線も落ちる（mm未満）。U3（探査の選択に階段を入れて clip を置換）は見送りのため現状維持。
- 階段の細部: 復路の到達側の拡張域（面の外）には上階天井の線と裏面の天井線の2本が出る／端の壁厚の中でも裏面を評価するため約58mmの縦線が出る／あき（レーン間）では天井線が上階天井まで切り欠く／回り階段の下の部屋の展開図にも階段が出る（`stairContributionOverRoom`の既存規則の帰結）。
- 上階の床の取り合いの関門`slabTopIsRealFloor`（S10-3）: 見る列の`upperFloorZ`は`mergeColumns`が統合条件に含めず先頭の列の値を引き継ぐ（実データ全数の計数で、関門で落ちた95件・通った109件とも統合由来の食い違いは0）／条件(2)は最初の実在の上階FLとだけ照合するので、3層の帯で2Fの天井懐（z1=3FL）に3Fの切断壁が載る構成では小口が立たない（実データに無し）／`farXOfCutOnSlab`はxの隣接を要求せず、見る列が無い（離れた壁）ときは従来どおり素通し。
- `4 (1).stq`の1階の梁3本（z990〜1190）はHの端7.5mmが壁の面に食い込むが、梁の芯が壁の帯の外にあるため「壁内の梁」ではなく分断の対象外（芯が合併帯の中のまま保つ方針。重なり判定に変えると壁の線が分断される）。
- 図側（`face.spans`の`farFloorDeltaMm`/`farCeilAbsMm`。遠側床線・遠側天井線）と探査側（ヒット列。アキの範囲）の2系統が残るため両者の値が食い違う余地がある。どちらが正かを決める規則は無い（削ると遠側床線・天井線が消えるので要裁定）。
- 2026-09-13に全キャンセルした6点指摘の残り（下ささらのクリップ・84mm片ほか）は意図的に残した不備。階段の最終段上端の閉じ方（内側ささらの上端が上階壁の向こう側の面で止まる終端定義が未整備）・1F天井の見えがかり断片（中線）が階段輪郭で切られて残る件も同様。
- ROW1の分割源S3（面に届く非通り芯中心線）は`extent`の有無だけで判定し、CLの位置的な近さは見ない（extent無制限の中心線が無関係な面の軸でも「届く」と判定される既存の別件仕様）。
- 柱: RC丸柱は外接矩形のまま。柱壁のL字延長は scale>4 で発火（受け入れ済み）。独立柱／面より手前の立体の遮蔽・斜め回転柱の見付け幅・作り付け家具は未実装。
- 階段帯の裏面（E5-2・直進系。2026-10-25 棚卸しで受容へ）: 上階の階段の1段目が自階の到達辺の真上に来る逆向きの重なりは判定せず（`matchingStairBelow`は外接矩形の一致）、段板より下に天井ができる。seq1の切断線は上階のinstall枠の基端が足元の辺ちょうどに乗る前提（ずれると足元の外＝seq1だけ従来の上階天井に戻る）。実データに直進の続き階段は無く、基準は合成文書 stair-ports-test6/7 だけ。下階がL_TURN等のときの失敗系テストは帯が層の裏面を読まないため変異の検出力が無い（述語の読解で担保）。
- `slabJunctionOf`（スラブの縁と切断壁の取り合いの断面線）は隣接を要求せず、スラブのz1と切断壁のz0が一致すれば面の反対端まで結ぶ（E5-2で受容。test6/7の旧goldenの「天井2050の線が階段室の空気を横切る太線」はこの副産物で、裏面の`ceilClip`で消えた）。
- `stairOver`（「あらわし」の階段下の部屋の帯）の機構（`lowerFaceEndVertical`・`trimCeilingLineAt`・`appendStairOverContent`）は踏面ジグザグのヒット列化（U3）を採らないため恒久に残す（「仕上げ」の帯は天井＝裏面の一般規則が担う）。

**個別課題（別途直す。未着手）**
- 階段帯: 区画・形状の傾斜天井の斜線を引く者がいない（エンジンは天井の斜線を引かない規約で、階段帯の体裁の`ceilingProfile`フックは平面の天井しか持たない。裏面だけは`ceilClip`で受ける）／奥の壁との交線は描かない／鉄骨の裏面は`soffitFinish:'finished'`のときだけ対象（あらわし＝既定は対象外。`stairSoffitFinished`）。
- 階段帯: seq5の到達辺の外（面の端〜到達辺）は切断面の段板が無く帯の床0のままで、2Fホールの壁・天井線（0〜2400）が残る。直進系の帯にU字系専用の後処理（下階の階段の吹抜けなど）を持ち込んでいない。階段室の`floorLevel≠0`では階段帯の`makeProbeContext`に floorOffset が渡らず、`ceilClip`が層スタックの天井より床段差ぶん低く、`switchbackCuts`の`underFloorZ`が0のまま、仕上げ空間の床区間だけが床段差込みになる。
- N+1の階段の裏面の到達辺（N+2の床梁の外面＋仕上げ）: 展開図の階段帯は S10-6 S2（2026-10-25）で`ElevationModeState`が N+2 を peek し`buildStairBand`の`ctx.upperUpperGraph`→`stairSoffitAbove({aboveGraph})`へ渡す（層スタックには積まない。部屋帯・吹抜け帯には渡さない。probe は`dumpFloorBands`の第5引数）。実データ33本の1階の階段帯で到達辺の端が 15〜27.5mm 動いた（golden は moku4-3 だけ）。天伏の見上げは S3（2026-10-25）で`App.jsx`が見上げのときだけ N+2 を並行 peek して渡す（`ceiling-model.md`）。階段帯の probeCtx（N+1の層の復路下の壁の天端）には渡さない（実データで天端が付く経路は0件）。
- 階段下の部屋の帯（S8-4 で天井＝裏面にした後の残り）: 「あらわし」の階段の下は従来どおり（CHの天井＋stairOverの見え掛かり。壁・柱は天井まで）。足元の壁の天端（footCap）を「仕上げ」の帯に限らず階段帯にも入れると、階段の実体を帯の探査で塞ぐものが無い（U3 見送り）ため背後の壁の天端線が現れる（basement-test 地下1階「6」で実測）＝階段帯の隠れ壁は天井まで立つのが現状。上部吹抜け付きの階段下の部屋（`buildRoomBandWithVoidAbove`）は未配線。
- 階段帯の隅の建具の開口で中線が残る（階段cutの端の縦線は断面線から立つ別規則で、隅の建具の開口zを床の高さの足し込みでは図と揃えられず太線だけ止まる。`cut.ends`が足場）。
- 回り階段: CH寸法の鎖は踊り場の高さ（往路の終端）のまま／桁枠は回転部のセルに付けない（鉄骨の回り階段でトリム結合もしない）。
- 階段の暫定・裁定待ち（直進系の蹴込・桁枠・段板厚、到達口の平場の高さ、踏面線のnosing寄せ）は「平面との照合の関門と階段の暫定事項」。

**部材（U1b 後の現状）**
- **edgeDropped の列（`{ceil, zone, wtpSight}`）の部材は帯を持てず加算のまま**（R7）。遮蔽は描く側のクリップ。規則Aの全高仮定は dropped の梁だけ。`elevationSolids.js`は全部は消えない。
- 壁の中の柱（`isColumnInsideWall`）は包みを持たず、その柱に収まる空中横断の梁の端が規則A・Bで隠れない（面の途中に直交壁がある構成だけ。帯の候補は柱の素の矩形が遮蔽するので消える見込み＝REASONED・実データ未確認。dropped 側は残りうる）。
- 部屋帯で仮想断面より手前（室内側）の空中の梁は描かない（旧実装は壁の仕上げ薄壁の遮蔽に掛かり実データでは出ていなかった。83文書の差分は plan-solids-test の2帯だけ）。`fromRoomSide`（断面の続きを室内側で見る）の向き依存の解消は別課題。
- 壁が探査の候補にならない場合は柱が加算より多く見える。切断線が柱の内側を通る柱（memberCut）を選択に入れる恒久策は、実データに切られる柱が出たとき。

**未実装（defer）**: 開口の内法寸法線・巾木見切り目地・家具設備電気・展開図上の編集・印刷/PDF・L_TURN/FLARED/OPEN_WELLの階段断面・展開図の建具「姿」クリックでのパネル連携（記号丸のみ）・他階の建具の2層帯への描画（吹抜け帯の下階建具・階段帯の上階建具）・3層以上つながる吹抜けの描画。

## 履歴
本文は現行規則だけを書く。以下は日付・コミット・要旨の1行形式。設計提案と当初の裁定は`.claude/elevation-redesign.md`（節番号はコードが参照するため維持）。

### 採取履歴（golden の再採取）
基準は`app/scripts/probe/`の固定スナップショット。再採取は裁定済みの意図的差分を取り込むときだけ。
- 2026-09-11（5943d89／裁定後＝5c81741）Phase 4裁定前（水平面ヒット由来の見えがかり線・アキ分割が既定off）→裁定後（既定on）。
- 2026-09-13（9b36c33直後・裁定「6点指摘の残りはキャンセル」）: golden13/11の「6」（2a壁非表示の是正・アキ矩形・面端の壁判定・最終段の蹴込・ささら）・「5」・2F「22」（5d2ef84＝腰壁・垂れ壁の隅の食い込み）。golden11は初回＝8e8e1e6（Phase 6b-1着手前）。
- 2026-10-09（`golden/`・`golden11/`・`golden13/`を`--regen`なし）: 面端の縦線medium→thick・アキの二重描画解消・折返し階段「6」のB/C/D面（b49b929・6b5909f・cb89fed・998e5ed）・隔て板（e0ea531ほか）・建具のhit/tag（07ee813・fa1c8f4・5d32b2a）。
- 2026-10-09〜（`--regen`）: `golden-elev-moku16` S2a=eaa6046（直進部・踊り場・seq1/seq3をinstall枠に揃え復路初段の段板CUT追加）／S2b=498cd91（回転部を扇形セルの切断線スライスに）／T1=0ab36cb（取りつき区画）。`golden-elev-stairports`新設 T2-2=8e9afd7（stair-ports-test1〜5）。
- 2026-10-17（2d54f94＝`--struct`追加。採取コミットは不明）`golden13-struct`新設（梁の見え掛かりの遮蔽の採取時点）: 規則A・Bの再採取＝moku16（梁の端12.5短縮）・ceiling-steel-stair-test（床梁の両端127.5短縮）。
- 2026-10-22 stair-ports-test1〜3（S2=bf22201。ユーザー裁定「採用」）: 直進系の階段帯のcontentをU字系と同じ`buildCutContent`へ載せ替え、上階のはね出しも図側へ。1階の階段帯だけtest1/2 追加24・削除5、test3 追加35・削除9。
- 2026-10-22 golden13・golden11・golden13-struct の elevfig-*（ユーザー目視OK）: 1階「6」（階段帯）が68ad689（上り口の開口から辺の上に立つ壁の帯を差し引く）でずれていたのを確定（親804f6b6は一致）。`golden-knee`を再採取して追跡に入れた（建具ドラッグのhit〔07ee813〕1個の差）。
- 2026-10-23 リファクタS0（ゲート`elevGoldenGate.mjs`導入＝6617e17。後始末f5593b9）: HEAD 6617e17とずれていた4枚をユーザー裁定で再採取（`golden/`・`ceiling-steel-stair-test`・`ceiling-wood-stair-test`・`moku4-3`）。以後HEADと一致。
- 2026-10-23 S3b-1（梁の「壁の中」判定を合併帯＋全高の壁だけに統一。ユーザー裁定1〜3。badc2f9）: ceiling-steel-stair-test 1・2階の階段帯で各−26（縦の床梁 axis 3000・幅100が薄壁＋オーナー壁の合併帯に収まり壁の中になった）。golden外: opening-test 踊り場梁が同理由で消え、moku4_kd 2階階段帯に腰壁の上の3階床梁が+12。他82本は不変。
- 2026-10-24 S4（CLの無いU字階段のseq2を仮想の面で組む。ユーザー裁定(b)。60c1841）: ceiling-wood-stair-test 1階階段帯D1の踊り場床断面線の左端が15mm（半壁厚72.5→既定57.5）。
- 2026-10-24 S3b-2（面の通りの梁を階段帯にも細線で。ユーザー裁定「細線で」。724f370）: moku16 1階階段帯seq1・ceiling-steel 1・2階（中線→細線）・ceiling-wood 1・2階。位置・長さは不変で線種だけ。部屋帯は不変。
- 2026-10-24 U1b B3-1（梁の断面memberCut。8b84eae）: golden/golden11/golden13/golden13-struct の「5」（上部吹抜け帯に上階の床梁のH断面 +24）・moku16 +8・ceiling-steel 1・2階階段帯（R6）・moku4-3。golden外: 上部吹抜け帯・階段帯・天井ゾーンの梁断面（天井が高い区画は天井まで、段をまたぐ梁は低い側で切る）。
- 2026-10-24 U1b B3-2（梁の見え掛かりmemberFace。1326299）: 「5」（上部吹抜け帯に2F床梁の下端の中線）・手前の梁が奥の梁の線を隠す・同位置の太線の下の細線が消える。moku4_kd 2階階段帯B2面の踊り場の上のアキを閉図形どおり（x 10905〜11705・z 1500〜2400。ユーザー裁定(c)）。
- 2026-10-24 U1b B3-3（柱memberFace。691d93c）: 「22」の部屋帯で柱の幅だけアキ・腰壁の線が隠れる／「5」上部吹抜け帯で柱が上の階の床まで1本／階段帯に柱型が初めて出る／面端延長部由来の孤立した71mmの天端線が消える（受容）／stair-ports-test1〜5の2階帯0のアキが柱で左右に分かれる。
- 2026-10-24 U1b B4・B6・2026-10-25 S5〜S7（出力不変。golden採取なし）。83文書はHEADとバイト一致。
- 2026-10-25 S10-3（帯種別排他分岐の解消。`slabJunctionOf`の関門に`slabTopIsRealFloor`・`slabEdgeCutWallJunction`を全帯で。ユーザー裁定 案B）: 実データ9本（2026・2026模試(1)〜(4)・moku1・moku2・moku2-5・moku2_col105）の階段帯で、2Fの壁の半厚だけ吹抜け側へはみ出した小片の太線3本（1F天井150・立上り・2FL 77.5。x 9807〜9957と2447〜2525）が見え掛かりの中線に置き換わる。golden は stair-ports-test6/7 の2階の階段帯で (8780,-3000)-(8857.5,-3000) が thick→medium の1本だけ採り直し。golden13の「6」帯（2026-09-13裁定の取り合い）は不変。
- 2026-10-25 S10-4 E5-2（直進系の裏面。S2-0=4b35915で`golden-elev-stairports/stair-ports-test6/7`新設〔2階に続きの直進階段。E5-2前の姿〕→S2-3で1階の階段帯だけ採り直し: test6 +74 -77 ~1・test7 +78 -82。seq2/4（test7はseq2/3）が上り口CH 2400からzCap 5400へ上る斜線＋折れ目、seq1は天井がCH 2400に下がり端の壁が太線。他17枚・実データ83本は不変）。

### 裁定履歴
- 2026-08（コミット不明）断面エンジン導入（階段帯）: 壁・構造材の実体に属する表現は断面エンジンだけが書く。通常部屋帯・吹抜け帯はゴールデンで凍結。断面の中は描かない（例外は腰壁・垂れ壁と天井断面の高さが変わる境界の壁）。切断壁の縁は常に太線・見えがかりは奥行き2段。見えがかりの奥行き上限800。仮想断面線は壁芯から室内側へ下がる。
- 2026-08〜09（コミット不明）アキ: 輪郭の矩形は描かない／床断面延長端・壁のない端部のはね出しには描かない／建具の姿の前にバツ不要（09）／下端＝遠側床・上端＝低い方の天井（09-11。同値でも縮める）。
- 2026-08（コミット不明）階段: 蹴込20（30→20）・ささら上端は踏面先端で巾木同寸・鉄骨の踊り場桁枠・切断線は往路/復路レーン中央（08-23に全面訂正）・「断面線の外は描画しない」（09〜10-08）。
- 2026-09-11（9c972cb・5c81741ほか）案A（和算）採用・Phase 4の水平面ヒットを実機確認の上採用・空気ボリュームの階またぎ連結（VOIDは最下階の親部屋1室・STAIR_VOIDは階段室1室）。
- 2026-09-13（9b36c33・d6eea37ほか）特例は一般判定で置換できるなら削除／6点指摘の残りは全キャンセルして当初計画（Phase 7・8・クリーンアップ）を優先／`stairOver`は出力不変の3点のみ置換／面非依存の入口は`bandRoomBounds`を渡さず深度上限800のみ／ささらの見えがかりは実体で囲まれた矩形の厳密内部を描かない。
- 2026-09（コミット不明）面の端も層ごとに違う（上階FLの線の起点は端の姿で決まる）／巾木は壁のある範囲だけ（10-15に改訂＝壁のない端部は壁が続く範囲だけはね出し）／壁2段書きは区間ごと／見付1px保証／天井断面線は区画ごと・高低差のある階の異なる天井断面線どうしは結ばない／無名の階段室は展開図の対象（10-07）。
- 2026-10-07（コミット不明）踊り場前縁・回転部にアキは標記しない／B/Dは各1本／在来木造の段板30・蹴込板垂直／壁の材厚に埋まる梁・柱は`wallConcealRange`1箇所（外壁の通り芯中心の柱）。
- 2026-10-08（コミット不明）階段の断面線の外は描画しない（階段下部屋の有無＝鉄骨／断面線が繋がっているか＝木造・RC）／seq3は踊り場前縁から100mm踊り場側で切る／隔て壁の天端プロファイルは「天端が位置の関数」という一般の引数だけを関所へ足す（特例を増やさない）。
- 2026-10-09（eaa6046・498cd91・0ab36cb）回り階段は案A「回転部を段付きの踊り場で描く」／展開図の階段位置を平面のinstall枠に揃える／取りつき区画を平面のセルで／直進系も平面の解決値で。
- 2026-10-13（コミット不明）`SHORT_WALL_IGNORE_MM`=100（出隅の短い壁で片を割らない）。
- 2026-10-14（コミット不明）隔て板: 回転部側の柱型の出っ張りは誤り＝斜めの天端は物理端まで続き縦線と取り合う／隔て板の面にバツ不要／抜けの先が階段室ならアキではない／階段室の開口越しに階段を見る（旧S4。リファクタのS4とは別）／回転部の向こう側の段を細線で。
- 2026-10-15（コミット不明）蹴上材を裏から見る面（断面線は太線のまま、踏面と取り合い蹴上線を細線）／図の左右は仮想断面の視線の向きだけで決める（dirSign）／復路下の仕上げ空間／階段帯の天井は裏面（E5）／天井の裏面の終わりの取り合い・巾木・隔て板を包む仕上げ。
- 2026-10-16（コミット不明）U字階段の到達辺はN+1の床梁の外面＋壁仕上げ。
- 2026-10-19（コミット不明）下階に階段がある階の階段帯は下階分の断面を書かない／穴の縁は隔て板の面／上り口の開口は辺の上に立つ壁の帯を差し引く／空中の梁の見えがかりは天井の状態が変わる所で区間を割る。
- 2026-10-22（bf22201・14dfa81）直進系の階段帯を共通経路へ統合し`buildSectionFigure`を削除（U字系専用の後処理は持ち込まない）／アキを梁で割らない（階段帯）／棚卸しで`unexploredBelowZOf`・`stairOver`の2機構は恒久に残す（`hiddenWallIds`はPhase 6で空気ボリューム判定へ吸収済み）。
- 2026-10-23（badc2f9ほか）自階の床（スラブ）は構造部材の見え方を隠す一般の遮蔽物（床梁を隠す。常に一般解）／穴の縁をまたぐ断面は輪郭1つの単位／壁の断面線の分断は壁内の梁が部屋側から見える場合だけ／S3b-1: 壁の中＝隙間なく連なる壁の材の和集合に梁の幅全体が収まる区間（腰壁は真下の床梁・垂れ壁は真上の天井懐の梁に対して全高の壁と同じ）／部屋帯の手前の梁がアキを塞ぐ（旧S4）。
- 2026-10-24（60c1841・724f370・1108142〜312a423）S4（CLの無いU字階段のseq2は仮想の面。viewSignの統一は柱型判定の規約が変わるので見送り）／S3b-2（面の通りは細線）／U1b R1〜R7（柱型は中線のまま・airborneは中線・独立柱が出る・R4部屋帯の断面は天井で切る・R5階段帯のアキは割らない・R6壁の縁は梁の高さでも描く・R7粗さ維持）／moku4_kd のアキは閉図形どおり（(c)）。
- 2026-10-25（判断のみ・コミット無し。続く実装は 9540626〜4335d85）U3（階段を探査の選択に入れる案）は見送り（行数が差し引きで増え clip も消えきらない。回転部の細線は別の層の問題）／S8の棚卸し結果は「階段由来の clip・隠れ線慣行・`stairOver`機構は現状維持、梁・柱の描く側クリップは探査側へ移って解消」。
- 2026-10-23〜25（S3a=1f5ed12・S2=5f7a0ee・U1b B1〜B6・S5〜S7。下行のコミット）解消した既知の限界: 「梁が探査に参加しない」（U1b B1〜B3）・「規則Aの全高仮定」（帯の候補は腰壁・垂れ壁の実高さで隠す）・「roomFaceCutの2規則が部屋帯専用」（`facePlane`と`fromRoomSide`へ分割）・「`SectionCut`の残骸キー」（S2）・「viewSignの二重定義」（`faceSectionCut`の符号を`-faceViewSign`へ寄せ定義1箇所。柱型判定の規約の反転だけが意図的に残る）。
- 展開図リファクタの実施コミット（2026-10-23〜25。出力不変は83文書のバイト一致で確認）: S0=6617e17（ゲート）・S1=a127863（逆向きimport13本と循環2本の解消）・S2=5f7a0ee（`SectionCut`の残骸キー`hiddenWallIds`・`openSpans`の撤去と opts の4群 typedef 化）・U2-lite=e888bfe・S3a=1f5ed12・S3b-1=badc2f9・S4=60c1841・S3b-2=724f370・U1b B1=1108142・B2=4ed2189・B3-1=8b84eae・B3-2=1326299・B3-3=691d93c・B4=bdc81e0・B6=312a423・S5=9540626〜80ee447・S6=cf49ca4〜17a5719・S7=4335d85。









