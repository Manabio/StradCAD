# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面に描く専用モード。平面・通り芯・寸法は出さず、
`viewport.scaleX/offsetX`（ズーム）には触れない——独自の固定倍率（`chooseElevationScale`）とスクロール量（`ElevationModeState`）だけで完結し、
平面へ戻ると元のビューが保たれる不変条件。純モジュールは`app/src/elevation/`に置き、`store.js`/`snap.js`/`*.jsx`/`react-konva`/`appViewport.js`
（DOM依存）を静的importしない（node:test単体実行のため。校正値は`viewport.js`から取るか呼び出し側=`App.jsx`が渡す）。

縦横スクロールは**クランプ方式**（循環しない・画面に収まる帯もminXへクランプし中央寄せしない——全帯を左三角の位置で揃えるため）で
**書き込み時にクランプする**（読み出し側だけだと過剰ドラッグ分がスラックとして蓄積しデッドゾーンになる）。横スクロールの既定位置は
左三角(`band.leftAnchorX`)から`LEFT_MARGIN_SCREEN_MM`（2パス換算）ぶん手前——`clampFaceOffset`の下限だけを`minX-marginMm`へ広げて実現する
（上限はminXのまま）。

## A/B/C/D の向きと不変条件
A＝平面の上側（北）を室内から見た面、B=右、C=下、D=左。時計回りA→B→C→D。隣接する面同士は同じ隅を世界座標で共有する（`buildRoomFaces`の
最重要不変条件——letterでグループ化してから連結すると、L字部屋の隅で世界座標が一致しなくなる。外周を実際に1周する順で組み立てラベルは
出現順に振る）。外周エッジは`computeExternalEdgeParams`の結果を**axisCLIdごとに分けてから**`mergeSegments`する
（一括だと別letterの面同士が誤ってマージされる）。

## プリミティブ語彙とスクリーン固定サイズ要素
既存の「図」語彙に`weight`を追加しただけ。建具記号丸（`tag`）・留め三角（`miterTriangle`。輪郭線のみ）はスクリーン固定サイズが必要なため、
mm座標に焼き込まずアンカー点だけを持つ専用プリミティブにし、pxはレンダラ側で校正値（`screenPxPerMm`）を掛けて算出する
（焼き込むとscale変化で見た目サイズが狂う）。

## 面の配置・注記帯
面配置・壁芯間寸法は`face.lo/hi`（仕上げ面）ではなく`faceBoundaryLocalX`（壁中心線）基準（壁面線=CUTのみ仕上げ面基準）。
**実画面mm指定の量（面間ギャップ・部屋名枠余白・留め三角アンカー・注記帯の各段位置・左スクロール余白）は倍率換算に2パス構築を要する**
（1パス目=仮値で帯の高さ→倍率を確定、2パス目=`screenMmToModelMm`で実値換算。倍率決定が先でないと循環参照）。

水平寸法は寸法線足を出さず、壁中心線・通り芯自体の一点鎖線を寸法線位置まで下ろし交点に塗り丸(`dim.dot`)を置く（CH寸法の足のみ残す）。
寸法値は寸法線の**上側**。床線から下へ①tag②ROW1(壁芯間)③ROW2(通り芯間)④通り芯丸+面ラベル(同じ段)の順。通り芯・壁中心線は天井線より上へも
`GRID_LINE_ABOVE_CH_MM`突き出す。通り芯丸は背景色(`CANVAS_BG_COLOR`。定義は`renderer/canvasStyle.js`——展開モード以外からも参照する
汎用値のためrenderer/配下に置き、`elevationStyle.js`はre-export。index.cssの`#root`と2箇所手動同期)で塗り一点鎖線の上に描く
（`tag`は背景透明のまま対象外）。CH寸法値だけ寸法線の左側で反時計回り90°回転する。

**注記帯の全ての段位置はスクリーンmm基準の独立定数**（tag行/ROW1/ROW1〜ROW2〜丸行の3つ。tag・通り芯丸のスクリーン固定半径ぶん、
モデルmm固定だと縮尺次第で床線・寸法行・寸法値テキストに重なるため）。3つは互いに独立に調整する——一方をもう一方の倍数として式で導出すると
値が機械的に動き、承認済みの見た目を踏み外す。面ラベルと通り芯丸が同じ段で近いと重なるため、`avoidGridCollisionX`が「通り芯＋面境界の並びで
最も広い区間の中点」へ面ラベルを退避させる（1回の走査で決定的。旧・一段固定シフト方式は密な通り芯で別の丸に重なり直す不具合があった）。

帯の描画範囲の上端には`BAND_TOP_MARGIN_MM`の余白を確保する。`layoutBands`の`placement.topMm`は`band.bounds.minY`（帯の実描画範囲の上端）に
対応する（`bandContentOriginMm`。取り違えると天井線がはみ出す）。

## FL高さ（floorOffset）: bounds は floorOffset=0 のときの描画範囲
`Room.floorLevel`由来の`floorOffset`は帯内の全プリミティブをy方向へ平行移動するが、**bounds は floorOffset 適用前の描画範囲を表す**
（シフト後の座標から計算すると、帯スロットの上端を帯自身のbounds.minYへ再アンカーする仕組み=`bandContentOriginMm`が一様シフトを
打ち消してしまい見た目に一切効かなくなる、という過去の不具合があったため）。

そのぶん隣接帯との実すき間はfloorOffset差だけ縮む。boundsは動かせないため、積み上げ専用の`heightMm`/`topMarginMm`（`layoutBands`消費）で
対処する——両者は排他（floorOffsetの符号で片方にしかせり出さない）なので`heightMm`に`Math.max(0,-floorOffset)`、`topMarginMm`に
`Math.max(0,floorOffset)`を加える（両方に一律`Math.abs`を加えると使わない側が過剰予約になる）。段差高さ自体の寸法線は描かない
（この`floorOffset`は部屋帯全体の階基準ズレで、次節の壁際の段差とは別物）。

## 床の段差プロファイル（部分指定）
部分指定Room（`referenceRoomIds`で親を参照。`.claude/glossary.md`）が親の壁際セルの一部を占め`floorLevel`が異なる場合、床線は段差付きの
階段状polylineになる。`elevationFloorProfile.js`の`wallAdjacentFloorSegments(face, parentRoom, graph)`が、面に接する親自身のセル
（`finish/gridCells.js`の`refreshCells`/`cellBoundsFromKey`を再利用）を壁沿いに拾い、部分指定のセル集合に含まれていればその
`effectiveFloorLevel`差分、含まれなければ0を割り当てて区間配列にする（同値の隣接区間は結合）。`buildRoomBand`/`buildStairBand`が
`ctx.floorSegments`として渡し（未指定時はフラット1区間）、床線は区間ごとの水平線＋段差の縦線（すべてCUT。寸法は描かない）になる。
両端縦線も区間の床yへ追従、天井線は次節のCH調整により水平のまま。段差がある面(`segs.length>1`)は図の右側にも左のCH寸法と同じ様式
（縦書き値・端部塗り丸）でCH寸法を追加する（値=CH−右端区間floorDeltaMm）。これにより右へ`CH_DIM_OFFSET_MM`ぶん描画範囲が伸びるため、
隣接面の間隔(`gapModelMm`)は壁中心線間ではなく「前の面の右CH寸法込みの右端」〜「次の面自身のboundary.lo」で確保する
（`buildRoomBand`/`buildStairBand`の`prevRightExtent`。左側は帯先頭面にしか左CH寸法が付かないため対象外）。

## 天井高さの解決（フォールバック・部分指定の段差調整）
`finish/roomMetrics.js`の`roomCeilingHeight(graph, room)`が仕上げ表・展開図共通の唯一の情報源。数値化できない自由入力
（傾斜天井のレンジ表記）は`graph.defaultCeilingHeight`で作図しラベルは原文。部分指定が自身のCH指定
（レンジ表記のような非数値の明示指定も含む）を持たず親と`floorLevel`が異なる場合、天井の絶対高さを親と揃えるようCHを段差ぶん増減する
（部分指定CH = 親CH − (部分FL − 親FL)。親を再帰的に解決、循環ガードあり。自身の明示指定は常に優先＝既存のcustomOverrides/master優先の
慣習をそのまま適用）。**計算結果が0以下（子FLが親CH以上）なら物理的に不可能な値としてgraph.defaultCeilingHeightへフォールバックする**
（isFallback:true）。展開図では前節の段差床と組み合わさり、天井線は水平のまま床だけ段差になる。

## 開口（建具）の展開図表現
開口は`openings/openingElevationFigure.js`の`buildOpeningElevation`（建具モード編集用姿図と同一の純関数）を
`includeDims:false, includeMotionArrows:false, includeLevelLine:false`で再利用し、枠・吊元表示・機構表現・レバーハンドルだけ残す
（両モジュールともFL=y0・上方向負で座標系が一致するため配置は`(x,0)`平行移動のみ）。建具記号丸は開口の中心ではなく姿が見える図の下（tag行）へ。
直交壁（隣・次の面）の建具が切断位置（面端）にかかる場合、`openingsReachingCorner`（隣接面自身の隅=0/runに開口スパンが届くかで判定）で
対象を選び、`openingSectionPrimitives`が[枠(CUT)][扉(SILHOUETTE)][枠(CUT)]の3rectを面の両端の帯に描く
（`buildRoomBand`/`buildStairBand`が`faces[(i∓1+n)%n]`をprevFace/nextFaceとしてctxに渡す）。

## 階段帯・巾木・defer
`elevationStair.js`の直上階（吹抜けクリップ）表現は上階FL線を重ねて引くだけの簡易実装。直上階グラフ（`floorSwapManager.peek`。
純モジュールでは行えず`ElevationModeState.init()`が解決）を使い、描画範囲は「床→設置階の階高→さらに上階の階高」の縦2層分
（上階のそのまた階高が不明なら1層分）。折返し階段は側面の断面プロファイルを`elevationStairSection.js`が独自生成する
（プランビューの階段描画は再利用しない）。SWITCHBACK以外（WINDING等）はスコープ外で空配列。

巾木初期値（`木製出幅木`/`h=60`）は**ユーザーがRoomを新規作成する経路でのみ**適用する（`applyDefaultBaseboard`）。
`RoomFinish`コンストラクタでは設定しない——復元経路は「新しいRoomを作ってから空でないフィールドだけ上書きする」実装のため、
既定値を非空にするとクリア済み`''`が復元のたびに巻き戻る。展開側は`parseBaseboardHeightMm`が`"h=<数値>"`表記だけ解釈し、
解釈不能なら非描画。床まで達する開口の区間は巾木線を途切れさせる。**巾木は床の段差にも追従する**——床断面線（区間水平線＋段差縦線）を
hだけ上へそのまま平行移動した連続ポリラインとして描く（水平方向にはオフセットしない。段差縦線を開口がまたぐ場合は床側同様に途切れさせる）。

## 面端の不変条件・壁2段書き
面端は「壁のない端部」と「出隅」を区別する。**壁のない端部**（`snapFaceEndsToCorners`が付与する`hasWallAtLocal0`/`hasWallAtLocalRun`が
false）は「続きがある」建築表現として床線・天井線を`WALL_LESS_END_EXTEND_SCREEN_MM`（2パス換算）ぶん図の外側へ延長し、縦線は描かない。
**出隅**（hasWallAtLocal0/hasWallAtLocalRunがtrue＝壁がある通常の面端。部屋の凸角で、視線方向に壁が折れて向こうへ続く角）は縦線を
SILHOUETTE（中線）で描く——切断面ではなく壁が折れて隣の面へ続くだけの見えがかりの角のため、CUT（太）は使わない（QA修正。床線・天井線・
段差の縦線・直交壁建具断面の枠は部屋の輪郭そのもの／明示指示に基づくためCUTのまま）。
**壁のない端部の判定基準は「隅に直交面が存在するか」ではなく「その直交面に実壁(`graph.walls`)があるか」**（`buildRoomFaces`の
`hasRealWall`。QA修正——閉じた部屋の面ループでは隅に直交面自体は必ず存在するため、面の有無だけでは常にtrueになり発動しない。実壁の有無は
`innerWallFaceAt`のnullフォールバック＝faceValueがCL芯になったかで判定する）。実際に発動する典型例は階段の上り口辺・下り口辺——
`generateRoomWallsFromOutline`の`stairOpenings`引数（`finishBoundary.js`が`stairPortEdges`を渡す）でその辺の壁生成自体がスキップされる。

**`buildRoomFaces`の隅マッチングは「同じaxisCLIdを持つ複数面」を区別する**（QA修正・根本原因）。張り出し（アルコーブ等）で1本の壁面が
開口を挟み2区間以上に分かれると、両区間とも同じaxisCLId（壁の通り位置そのもの）を持つ——単純な`Map<axisCLId,Face>`は後勝ちで片方が
消え、その面がchainに一切現れない「抽出漏れ」になる（張り出し脇の短い返し壁で典型的に発生）。`groupByAxisCLId`+`findCornerNeighbor`
（`elevationFaces.js`）が「同じ壁通りの複数区間」から、隅を実際に共有する1件（候補のstartCLId/endCLIdが自分自身のaxisCLIdと一致する
もの）だけを選ぶ。

壁2段書き（壁材・壁仕上げ材の2行）は表示専用に`formatMaterialLabel`で言い換える（「せっこうボード」→「PB」、`t=<数値>`→`ア)<数値>`。
材マスター自体は変更しない）。位置は原則、面の壁中心線区間の中心・天井高の中央(`-CH/2`)。開口・アキ・段差縦線と重なる場合は
`avoidObstacleRangesX`（`avoidGridCollisionX`と同系の最広ギャップ方式。障害物が区間を持つ点だけが違う）で最も広い空き区間へ退避する
（巾木は面のほぼ全幅を覆うため対象外）。壁中心線間の描画長さがラベル幅の概算×2未満なら描画自体を省略する（倍率決定用の1パス目は
scale未確定のため省略判定を行わない）。**テキスト幅概算は文字クラス別**（`estimateWallLabelWidthPx`。半角ASCII=0.5×fontSize・
全角(CJK等)=1.0×fontSize）——変換後ラベルは半角主体になるため、全角一律の概算だと幅を過大評価し通常サイズの面でも過剰に省略される
（QA G1）。

隣接面の間隔（`gapModelMm`）は、右CH寸法（前述）に加え、面自身の壁のない端（`hasWallAtLocal0/hasWallAtLocalRun`）の延長ぶんも
加味する（`faceWallLessExtents`。`buildRoomBand`/`buildStairBand`が共有する純関数）——延長された床線・天井線が隣の面と実間隔を
詰めないようにするため（QA G2）。

## ビュー位置の階別記憶・建具パネル連携
`ElevationModeState`はモジュールレベルの`Map<floorId, {...}>`（セッション内のみ。IDB永続化なし）で階ごとのscrollY・faceScroll・
表示中の部屋を記憶し、同じ階への再突入（`dispose()`→`init()`）で復元する。記憶した部屋が消滅していれば、記憶時点で1つ前だった部屋
（`graph.rooms`順）の帯位置へフォールバックする。floorIdは構築時（`project.activePlane.id`）に一度だけキャプチャする——dispose()時点
では`project.activePlane`が既に次の階を指している場合があるため。

展開図の建具記号丸（`tag`プリミティブの`openingId`）はクリック可能——`ElevationModeState.selectedOpeningId`/`selectOpening()`は
`OpeningModeState`と同じAPI名にしてあり、建具モードの`OpeningPanel.jsx`をそのままelevationモード中（appModeは切り替えない）でも
再利用する。**パネル表示中も展開図のドラッグ・ホイールスクロールは自由に行える**（規制は一度入れたが撤廃した。QA修正）。
パネルでの編集はMobX reactionで`graph.openings`の各Openingの表示に効くフィールド（committed値。CLのようなpending/committed分離を
持たないため確定のたびに1回だけ発火）を監視し、変更があれば帯を全再構築して即時反映する。クリック対象は建具記号丸のみ
（姿図は現状複数の生プリミティブへ分解済みで個別の建具IDを持たないため対象外。defer）。

defer（未実装）: 傾斜天井の作図・開口の内法寸法線・巾木見切り目地・家具設備電気・屋外部屋・展開図上の編集・印刷/PDF・
SWITCHBACK以外の階段断面（WINDING/L_TURN/FLARED/OPEN_WELL）・展開図の建具「姿」クリックでのパネル連携（記号丸のみ対応）。
