# 展開図処理の現行評価と一般化に向けた新設計（設計提案・裁定済み）

> 作成: 2026-09-11 / 対象: `app/src/elevation/` 全体 / 状態: **ユーザー裁定済み（2026-09-11）。Phase 1 から着手**

## ユーザー裁定（2026-09-11）
1. **和算方式（案A）を採用。**
2. **Phase 4 の奥の床線・天井線**: 「奥の壁に建具があれば、その見えがかりを描画する」と同値なら**不可**。
   切断面から奥行き方向に**深度**を設け、**一定寸法以上は描画せず「アキ」と判定する**処理を追加する。
   → 水平面ヒット（floorFace/ceilFace）にも深度上限を掛け、上限以上は `open`（アキ）に落とす。奥の壁の建具姿図は描かない。
   既存の壁の規則（`elevationStyle.js` `SIGHTLINE_DEPTH_LIMIT_MM`=800。ただし基準は「最も手前の壁面」からの相対距離 `sectionEngine.js:303-310`）と
   **基準点（切断面か・最も手前の壁面か）を揃えるかは Phase 4 着手時に diff を見せて再裁定**する。定数は1箇所に置く。
3. **垂れ壁入りのテスト用 .stq を作ることを承認**（13.stq に垂れ壁が無いため）。→ `D:/tatsuya/Download/knee-drop-test.stq`（生成: `app/scripts/probe/makeKneeDropTest.mjs`。コミット f54b6c5）。
4. **Phase 4 の受入基準（ユーザー実機確認 2026-09-11）**: knee-drop-test.stq の展開「A」面C（腰壁面。Bの天井高2400はAの3000より低い）では、
   腰壁の上の開口の中に **BのFL+2400 の天井見えがかり線**が描かれ、**「アキ」は腰壁天端(800)〜2400 の範囲**が正解。
   現行は 800〜3000 全体がアキで、これは Phase 4 で解消される見込み（Bの天井は切断面直後から始まる水平面＝深度上限内、
   Bの奥の壁と窓は 4000 奥＝上限超で描かない）。2400〜3000（Bの天井懐）はアキにしない。
   Phase 1 の結果を確認のうえ **Phase 2 へ進むことを承認**。
5. **空気ボリュームの階またぎ連結の定義（Phase 2 で実データ検証した結果のリード判断。2026-09-11。ユーザーの拒否権あり）**:
   当初の仮定「上が VOID/STAIR_VOID なら連結」（§6 未検証4）を 13.stq で検証したところ、**階段下の閉じた部屋「13」（天井を持ち全高壁で囲まれる）が階段吹抜けと同成分**になる反例が出た。
   定義を次に絞る: (i) VOID は**重なる吹抜けを下へたどった最下階の親部屋1室**（吹抜けが複数階にわたる場合は直下の VOID と連結して連鎖し、
   最下階で `findOverlappingRoom` の規約で親部屋1室に接続。**ユーザー裁定 2026-09-11「直下の親部屋」→「重なる吹抜けの最下階の親部屋」に修正**）とだけ連結、
   (ii) STAIR_VOID は**階段室**とだけ連結。階段下の部屋は連結しない。**他はユーザー承認済み。**
   同層の遮断は「境界区間を覆う壁が実在し腰壁・垂れ壁でない」で判定する（段差境界 STEP でも壁があれば遮断）。
> 本ファイルは設計提案の作業文書。裁定後は要点を `.claude/elevation-model.md` へ要約して移し、本ファイルは削除する（doc-policy の行数目安を超えるため索引には載せない）。
> 目的の一文: **展開図の「向こう側」表現の構造的限界を特定し、断面詳細図へ発展できる形へ最小の変更で移行する設計を決める。**
> done means: (1) 現行の優れた点／阻害要因が file:line 付きで列挙され、(2) 2案以上の比較の上で1案が推奨され、(3) 13.stq ゴールデンを段階ごとに一致確認できる移行計画と、意図的差分の予告がある。

## 0. 本書の証拠水準と制約

| ラベル | 意味 | 本書での使い方 |
|---|---|---|
| VERIFIED | 実際にファイルを読んで確認した内容（ファイル内容・行番号） | file:line の引用はすべてこれ |
| REASONED | 読んだ結果からの推論（挙動・因果） | 「〜だから表現できない」等 |
| ASSUMED | 未確認 | 明示的に ASSUMED と書く |

- **テスト・ビルドは未実行**（architect は読み取り専用）。実コマンドは `app/package.json:11` の `"test": "node --import ./scripts/testSetup.mjs --test"`、lint は `eslint .`、build は `vite build`（VERIFIED）。
- **`git show` は実行不可**（architect に Bash なし）。指定7コミットは `.git/logs/HEAD` の件名から取得し（VERIFIED）、現行コードの日付付きコメントへ対応付けた（REASONED）。§1.3 の「由来」列がそれ。
  - `57fd7f1` 見えがかり壁が吹抜けを登るのは上階にその壁が続いている間だけに是正
  - `b502bfc` アキのバツを踊り場で分割しないよう是正／基準床より下の区間は足元の線も描く
  - `811e3e3` 手前に別の部屋が挟まる建具の姿図を描かないよう是正(階段下の部屋の建具)
  - `67a5912` 階段下の部屋の展開・面端の壁断面・建具の断面描画を一連で是正
  - `151b4f0` 階段下の部屋の面を横切るレーンで、天井より上の階段を描かないよう是正
  - `9130007` 階段帯から階段下部屋の2a壁を見えなくし、レーンの1FL線をはり出しだけ残す
  - `519365c` 階段帯の断面線を折れ線輪郭にし、層ごとの探査窓で上階のはり出しを描く

---

## 1. 現行アーキテクチャの実態図（REASONED。引用行は VERIFIED）

### 1.1 2つのエンジンの担当と、そのあいだの情報の往復

`.claude/elevation-model.md:17-41` の担当境界表（`buildFaceFigure` = 図面の体裁／`section/` = 壁の実体）は実コードと一致（VERIFIED）。ただし**文書が書いていない第3の実態**がある: 両者は独立した2本のパイプではなく、**7本の専用チャネルで値をやり取りする相互依存**である。

| # | 方向 | 値 | 生成 | 消費 |
|---|---|---|---|---|
| 1 | 図→エンジン | `ceilProfile`（区間ごとの天井断面高さ） | `elevationBand.js:686` | `sectionEngine.js:59,87`（列の分割・打ち切り） |
| 2 | 図→エンジン | `floorZProfile`（同・床側） | `elevationBand.js:706` | `sectionContent.js:118`（下階窓の gate） |
| 3 | 図→エンジン | `aboveCeilVisibleRanges`（天井断面より上で描いてよい範囲） | `elevationVoid.js:671` | `sectionEmit.js:340`（`aboveCeilVisibleSpans`） |
| 4 | 図→エンジン | `openSpans`（遠側の床・天井） | `elevationBand.js:720-728` | `sectionEmit.js:1279-1297`（アキの上下端クランプ） |
| 5 | 図→エンジン | `drawFloorProfile`（断面線＝下側の輪郭） | `elevationStairSequence.js:417` | `sectionEmit.js:1211`（アキのセル下限） |
| 6 | エンジン→図 | `upperFloorCutEnds`（上階FL線の起点＝切断壁の向こう側の面） | `sectionContent.js:203` ← `columns` | `elevationFigure.js:436`（`upperFloorEdgeSpans`） |
| 7 | エンジン→図 | `upperOverhang`/`upperFloorZ`/`upperFloorEnds`（はり出し） | `sectionContent.js:111`, `elevationStairSequence.js:485` | `elevationBand.js:737`, `elevationFigure.js:436` |

チャネル6が逆流するため、**上部吹抜け帯だけはレイアウトを2回組んでいる**（`elevationVoid.js:650` で1回目→`:666` で content→`:681` で図だけ組み直し。VERIFIED）。「2つのエンジン」という説明は既に破綻しており、実態は**1つの処理を2つの座標系に分けて交互に走らせている**状態。

さらに、同じ「視線の符号」が2つの逆向きの定義で共存している（`elevationSolids.js:56-60`: 「二重定義だが**統一しない**——差し替えると `onNearSide` が反転して確認済みの挙動が壊れる」。VERIFIED）。

### 1.2 帯種別ごとのパイプライン（各1行）

1. **通常部屋帯** `buildRoomBand`（`elevationBand.js:839`）:
   `composeRoomFaces` → `layoutBandFaces`（面ごとに `buildFaceFigure`）→ `appendBandCutContent`（層＝自階1層）→ *（階段が上を通れば `stairOver` ブロック）* → `finalizeBand`。
2. **上部吹抜け帯** `buildRoomBandWithVoidAbove`（`elevationVoid.js:527`）:
   下階 faces と上階 voidFaces を `samePlane` で合成（`:547-566`）→ `dropFacesSeenAsSightline`→`mergeStepped`→`labelFaces`（`:571`）→ 面ごとのはり出し `overhangByFace`（`:583-606`）→ `layoutBandFaces`①（`:650`）→ `makeUpperStoreyContext`（上階の可視範囲＝空気連結。`:190`）→ `appendBandCutContent`（自階＋上階。`onFaceColumns` で起点を収穫。`:666`）→ `layoutBandFaces`②（`:681`）→ `appendUpperStoreyOutline`（上階を**自階1層とする別の cut** をもう1本。`:220`）→ `appendUpperStoreyTrim`（体裁。`:283`）→ `finalizeBand`。
3. **吹抜け帯** `buildVoidBand`（`elevationVoid.js:423`）:
   `composeRoomFaces` → `faceOverride` で床を下階FLへ下げる（**下階に同じ壁がある区間だけ** `splitSegByCover`。`:452-477`）→ `layoutBandFaces` → `appendBandCutContent`（自階＋直下階。`:486-496`）→ `finalizeBand`。
4. **階段帯** `buildStairBand`（`elevationStair.js:119`）:
   `composeRoomFaces(keepWallLessFaces)`（`:141`）→ `stairFaceSequence`（`elevationStairSequence.js:552`）→ `switchbackCuts` が cut 表7本を作る（`switchbackCuts.js:432-499`）→ 各 cut で `contentForCut`（`buildCutContent` ＋**階段固有の後処理6段**。`elevationStairSequence.js:407-461`）→ `layoutBandFaces` に `faceOverride` で `floorSegments`/`ceilingProfile`/`floorProfile`/`chDimChains`/`upperOverhang`… を差し込む（`elevationStair.js:163-191`）→ content を `xCursor` へ載せる（`:194-196`）→ `finalizeBand`。
   （STRAIGHT系は `straightCuts`→`buildSectionFigure` の汎用経路、扇形は常に null→フォールバック。`elevationStairSequence.js:529-535,556-558`）

**共通経路は確かに1本**（`appendBandCutContent`→`buildCutContent`。`elevationBand.js:730`）で文書の主張どおり（VERIFIED）。しかし**共通経路に入る前後がすべて帯種別に固有**で、前処理と後処理の量がまったく違う。

### 1.3 「状況判定」の散在マップ

| 判断 | 実装箇所 | 由来（推定） |
|---|---|---|
| 断面の中か（x-z の連結） | `sectionVisibility.js:84`（`reachableAirByColumn`）→ `sectionEngine.js:318,325`（`clipBandsToVisible`） | 2026-08 |
| 天井より上でも見える切断壁 | `sectionEngine.js:135`（`exposedAboveCeil`。壁の連なりの**外側の列**の空気を見る） | 2026-08 |
| 見えがかりの奥行き上限 | `sectionEngine.js:303-310`（`SIGHTLINE_DEPTH_LIMIT_MM`=800 で `wall`→`open`） | 2026-08 |
| 見えがかりが見える部屋の範囲 | `sectionProbe.js:232`（`withinViewRoom`。帯部屋の**包絡矩形**） | 2026-08 |
| 見えがかり壁のz上限 | `sectionLayerStack.js:147`（`resolveSightlineTopZ`）＋`sectionProbe.js:362`（`wallContinuesOnLayer`） | **57fd7f1** |
| 側縁を描くか（壁が途切れたか） | `sectionEmit.js:119`（`uncoveredZRanges`。内部にさらに「境界に切断壁が立てば天端まで」特例 `:148-160`） | 2026-08 |
| 側縁を立てるx | `sectionEmit.js:201`（`wallEndXAt`。切断壁の**向こう側の面**へ送る） | 2026-08 |
| 手前の切断壁に隠れる水平線 | `sectionEmit.js:176`（`hiddenByCutWall`） | 2026-08 |
| 切断壁に切られて持ち上がった帯の側縁 | `sectionEmit.js:776`（`splitByCutWall`）＋アキ例外 `:783`＋面端例外 `:791-793` | 2026-08/09 |
| 腰壁がスラブに同面で載る | `sectionEmit.js:719`（`flushOnSlab`）＋`:465`（`flushKneeStopX`。反対側からの重複防止） | 2026-08 |
| 上階床との取り合い（帯種別分岐） | `sectionEmit.js:869-873`（`ceilProfile` の有無で `ceilStepSlabSection`／`slabEdgeCutWallJunction` を**排他選択**） | 2026-08 |
| アキの成立条件（9重） | `sectionEmit.js:1175-1336`（面外クリップ`:1203`／切断壁天端の上を除く`:1196`／開口を除く`:1202`／断面線で下端を持ち上げ`:1211`／同一列のz接続`:1219-1234`／連結成分`:1236-1248`／幅で省略`:1254`／L字なら文字なし`:1323`／far値クランプ`:1279-1297`／実体でクリップ`:1309`） | **b502bfc** ほか |
| 階段下部屋の2a壁を消す | `switchbackCuts.js:61-84`（`stairUnderInfo`→`hiddenWallIds`。`:499` で全 cut へ）→ `sectionProbe.js:503`（`isHiddenWall`）を `:531`（列分割）と `:674`（候補収集）の**両方**で | **9130007** |
| 階段下部屋の帯に階段を重ねる | `elevationBand.js:743-820`（`stairOver`。`crossFlight`／`stairHiddenByCeil:759`／`lowerFaceEndVertical:800`／天井線をどちら側で止めるかを**重心**で決める `:805-819`） | **151b4f0 / 67a5912** |
| 手前に別室が挟まる建具の姿図 | `elevationFigure.js:1070`（`openingBelongsToFaceRoom`。図側だけの判定） | **811e3e3** |
| 面の端は層ごとに違う（はり出し） | `sectionContent.js:70`（`planeOverhangForFace`）／`:111`（`layerRunWindowsOf`）／`sectionProbe.js:146`（`withinLayerWindow`）／`:599`（`unexploredBelowZOf`）／`elevationStairSequence.js:485`（`upperOverhangOf`）／`elevationFigure.js:436`（`upperFloorEdgeSpans`） | **519365c** |
| 階段のささら遮蔽 | `sectionStair.js:230`（`isBlockedByWall`。**z<2000 のマジック閾値** `:229`）／`:574`（`stairOccluderRects`）→ `sectionEmit.js:981,1023`（バツ・水平線の破線化）／`:1070`（`clipStairDetailInSlabBand`。P3で削除）／`:1134`（`joinToStairProfile`） | 2026-08 |
| 階段断面と天井の取り合い | `elevationStairSequence.js:349`（`withFlatLineSpans`）／`:375`（`clipWallFloorEdgeUnderZigzag`）／`sectionStair.js:1093`（`clipStairUnderCeiling`） | **519365c** |

**個別対症が最も濃い3箇所**:

1. **`elevationBand.js:743-820`（`stairOver`）** — 断面エンジンの外側で、階段プリミティブを生成し、天井でクリップし、面端の縦線を下げ、天井線を**重心で選んだ側**まで縮める。エンジンの可視判定と一切共有していない78行。
2. **`sectionEmit.js:1175-1336`（`emitOpenGapMarks`）** — 「アキ」の定義が実機指摘ごとに1条件ずつ足され、現在9条件。うち3条件（`:1196` 切断壁の天端の上／`:1202` 開口／`:1211` 断面線より下）は「アキではないものを除く」＝**モデルが本来 open と言うべきでない場所を後から引く**処理。
3. **`sectionEmit.js:119-208`（`uncoveredZRanges` + `wallEndXAt`）** — 「壁が途切れたか」の判定に、層の同一性・キャップ差・切断壁の天端・隣接列のアキ・面の端、の5つの条件が入れ子。

---

## 2. 優れている点の評価（「一般化後も残す価値」を高/中/低で採点）

| # | 点 | 実装 | 価値 | 理由 |
|---|---|---|---|---|
| S1 | **「断面の中」を空気セルの連結成分で決める** | `sectionVisibility.js:84-121` | **高** | 「線の左右どちらが中か」を一次情報にしない判断（`:14-18`）は幾何的に正しく、次元を上げてもそのまま成り立つ。セル＆ポータルと同型で、3D化してもアルゴリズムを書き直さずに済む。 |
| S2 | **層スタックの一般規則（role名を見ない）** | `sectionLayerStack.js:48-116` | **高** | 「意味を持つのは並び（floorZMm）であって名前ではない」（`:16`）。INV2（層の並び順を変えても結果が完全一致）という**実行可能な証明**を持つ。 |
| S3 | **切断1本→content の共通経路が1つ** | `sectionContent.js:245`（`buildCutContent`） | **高** | 断面詳細図もこの入口を共有できる。**新設計の入口はこれをそのまま使う。** |
| S4 | **線種は「断面か／どの奥行きか」だけで決まる** | `sectionEmit.js:527`（`nearestSightlineDistMm`）, `:545`（`visibleDepthMm`）, `:569`（`ownsBoundary`） | **高** | 「見えがかり線が存在するのは距離が変わるところだけ」＝**深度不連続でエッジを立てる**という深度バッファ法の出力規則そのもの。方式を変えても捨てるところがない。 |
| S5 | **探査範囲そのものを外へ広げる（線を後から伸ばさない）** | `sectionContent.js:156`（`withProbeExtension`）, `sectionProbe.js:129`（`cutProbeRange`） | **高** | 「出来上がった線を引き伸ばす」方式では腰壁の外側面が作れない、という実測に基づく裁定（`elevationStairSequence.js:390-398`）。**モデルを増やして図を出す**という正しい方向。 |
| S6 | **単一情報源の徹底と不変条件テスト** | `sectionTypes.js:87`（`hasCutWallStandingOn`）, `elevationBand.js:43`（`bandFloorOffsetMm`）, `sectionContent.js:33`（`endZOf`）, `sectionProbeMultiLayer.test.js` の INV1-3 | **高** | 移行時にこの規約を守る限り、退行の検出可能性が保たれる。 |
| S7 | **ゴールデンゲート** | `elevationSectionGolden.test.js`, `app/scripts/probe/dumpElevFigure.mjs` | **高** | 「差分が出たら増減した線を1本ずつ説明できること」（`elevation-model.md:322-327`）。**この資産が無ければ今回の移行は不可能。** |
| S8 | **図面の体裁の確定仕様の集積** | `buildFaceFigure`（`elevationFigure.js:580`）＋注記帯（`:1320`） | **高（分離が条件）** | 巾木・壁2段書き・寸法の鎖・通り芯丸・建具姿図は図面としての価値そのもの。幾何エンジンとは別の関心事なので作り直してはいけない。ただし現在は幾何（`floorSegments`/`flatLineSpanX`/`upperFloorEnds`）と癒着しており、そこは剥がす。 |
| S9 | **加算レイヤ（遮蔽に参加しない）という割り切り** | `elevationSolids.js:1-16`, `sectionStructure.js` | **中** | 低リスクで柱型・梁型を足せた実績。ただし「独立柱・面より手前の立体の見えがかり」が defer（`elevation-model.md:1400-1404`）で、断面詳細図では遮蔽が必須になるため恒久解ではない。 |
| S10 | **面ローカルxと断面ローカルxを同値に保つ不変条件** | `sectionCutPlane.js`, `sectionTypes.js:98-122` | **中** | 座標の往復が要らない利点。ただし「面」概念を一般化するとき制約にもなる（P7）。 |

**採点の集計: 高7・中2**（S8 は条件付き高）。判断基準「優れている点の相対評価が高ければ和算」に照らし、**和算が妥当**。

---

## 3. 一般化を阻む問題点（構造的／実装的）

### 3.1 構造的（＝現行方式に固有。対症では終わらない）

**P1. 層の床・天井が「切断面のすぐ向こうの1点」からしか解決できない**
`probeOwnerRoom`（`sectionProbe.js:198-211`）は `line.axisValue + viewSign*PROBE_EPS_MM` の**1点**で所有Roomを引き、`buildLayerStack`（`:564-577`）がその Room の FL/CH をその層の床天井として確定する。**1つの列に対し、1つの層につき床と天井は1組しか存在できない。**
- 腰壁の**向こう側の床**は「腰壁の厚みの向こう」にあるので、この1点では引けない。
- 開放スパンの遠側床・遠側天井は**探査から得られないので外から注入**されている（`elevationBand.js:716-728` の `openSpans`）。文書自身が「移すには**モデルの追加**が要る」と書いている（`elevation-model.md:271-279`）。

**P2. (列 × z) に実体が1つしか残らない＝奥行き方向の第2ヒットが無い**
`probeColumn`（`sectionProbe.js:746-821`）は z 区間ごとに `cut`/`cutAlong` → 最短距離の `wall` → `slab`/`open` の優先順位で**1つだけ**選ぶ。奥に何があったかは捨てられる。
- 「腰壁の天端の上に、奥の部屋の床と天井が見える」＝同じ(列,z)に複数の面が重なる構成を保持できない。
- `SIGHTLINE_DEPTH_LIMIT_MM`（`sectionEngine.js:303-310`）は「800mmより奥は `open`」だが、**奥に床や天井があっても消える**。

**P3. 見えがかりの候補が「壁」しかない**
候補収集は `graphList(layer.graph, 'walls')` の走査のみ（`sectionProbe.js:673`）。`isSightlineShape`（`:160`）は「切断線と平行な shape」を拾う判定で、**水平面（床・天井スラブ）は候補にならない**。`slab` 帯は「帯自身の階に所有Roomがある列」でしか作られない（`:798-817`）＝自分の足元と頭上だけ。
→ P1・P2・P3 は**同じ1つの欠落（向こう側の水平面）の3つの現れ方**。

**P4. 「アキ」が2つの意味を兼ねており、既定が危険側**
`probeColumn` は候補ゼロの列を `{kind:'open'}` にし（`:820,825`）、`emitOpenGapMarks` はそれをアキとして**作図する**。(a) 平面に壁が無い（建築的アキ）と (b) モデルが答えられなかった（未知）が同じ `open` になり、(b) が図に出る。だから「アキではないものを引く」条件が9個積まれた。はり出し列で `unexploredBelowZOf`（`sectionProbe.js:599`）が**帯そのものを作らない**特別扱いも同じ問題への個別対応。

**P5. 「面ローカル・自階のgraph」と「世界座標・層スタック」の2系統**
§1.1 の7チャネルとレイアウト2回組みがその代償。影響: (1) 同じ問いを2箇所が別々に答える危険（腰壁天端の無音の欠落 `elevation-model.md:32-36`）、(2) 図がcontentより先に走る順序制約のせいで、列にしかない情報を使う表現が入るたびに逆流チャネルが増える、(3) 符号・基準の二重定義が残る。**新しい表現を1つ足すたびにチャネルが1本増える**構造で、実装コストが逓増する。

**P6. 可視判定が3系統に分かれている**
(i) x-z の連結（`sectionVisibility.js`）、(ii) 奥行きの包絡矩形（`withinViewRoom`）、(iii) 奥行きのスカラー閾値800。加えて階段専用の遮蔽が4つ。文書も「畳むには奥行きを含む3Dのセル分割が要る」と明記（`elevation-model.md:261-265`）。**設計の答えは既に文書の中にある。**

**P7. 「面＝部屋の輪郭の1辺」という固定**
階段帯では `reorientFace`（`switchbackCuts.js:193`）、`buildMidWallFace`（`:220`）、seq2 の「枠は wOut1 のまま・同定だけ中心1へ差し替える」（`:422-427`）という綱渡り。断面詳細図は**任意の切断線**が主語なので、この固定は将来の障害。

**P8. 帯の層構成が帯種別で固定**（軽度）
4通りを4つのビルダーが別々にリテラルで組む（`elevationBand.js:846` / `elevationVoid.js:666-669` / `:486-492` / `switchbackCuts.js:330-331`）。層スタックの規則は一般化済み（S2）なのに入口が3層以上を作れない。

### 3.2 実装的（＝方式を保ったまま整理できる）

- **P9. 例外の入れ子**: `uncoveredZRanges` 内の5条件（`sectionEmit.js:119-164`）、`splitByCutWall` の3つの打ち消し条件（`:776-793`）。
- **P10. 帯種別の排他分岐がエンジン内**: `sectionEmit.js:869-873`。「共通経路にタイプ固有の分岐を持ち込まない」（`sectionContent.js:11-13`）への違反。
- **P11. マジック閾値**: `STRINGER_VISIBILITY_Z_HI_MM = 2000`（`sectionStair.js:229`）、`MID_WALL_TOL_MM = 300`（`switchbackCuts.js:32`）、`FOOTPRINT_EDGE_TOL_MM = 150`（`:36`）。
- **P12. 建具が2系統**: 断面は `openingPassThrough`（`sectionProbe.js:403`）、姿図は図側（`elevationFigure.js:1070`）。「手前に別室が挟まる」判定が図側にしかない（811e3e3 が図側だけに入った理由）。
- **P13. 階段の後処理が content の外**: `contentForCut` の6段と `elevationBand.js:743-820` の78行。

### 3.3 問いへの直接の回答

**「列×z帯の1次元プローブ」が表現できないもの**＝「切断面から見て最初の実体より奥にあるもの」全般:
1. 腰壁の天端の上に見える奥の床（P1+P3）
2. 垂れ壁の下に見える奥の天井（同上）
3. 手前の壁の凹み・開口の向こうの2枚目以降の壁面（P2）
4. 800mmより奥にある実体（P2）
5. 多層の見えがかり（1階から吹抜け越しに2階の腰壁とその向こうの2階床を同時に見る）

**1点プローブの限界**: 「向こう側」はその1点が属する部屋の属性でしか答えられない。腰壁・垂れ壁の厚みの向こうの別空間、1つの面が2室に面する構成、そして**同じ平面位置に高さで別の空間が積まれる階段下**は表現できない。層スタックは階単位でしか積めない（`floorZMm` は階FL）ため、「同じ階の中の階段下と階段上」を別層として扱えず、`hiddenWallIds` と `stairOver` の**2本の手動リンク**で辻褄を合わせている。

---

## 4. 設計案の比較と決定

- **案A（和算）**: 断面エンジンに「奥行きの解像度（ヒット列）」と「空間セル索引」を足す。可視判定は空気連結＋同一空気ボリュームへ一本化。`buildFaceFigure` は残し幾何値だけ段階的に差し替える。
- **案B（新設計）**: 空気ボリュームを2.5Dブロックで組み、切断面交差で断面線、深度バッファで見えがかりを得て既存語彙へ変換。
- **案C（現状維持）**: 対症を続ける。

| 観点 | A（和算） | B（全面新設計） | C |
|---|---|---|---|
| 13.stq ゴールデン維持 | **◎** 各段で完全一致を要求できる | **×** ラスタライズ由来の座標は mm 単位で一致せず、全帯の全線を再承認 | ◎ |
| 腰壁の向こうの床等 | ◎ ヒット列に floorFace/ceilFace | ◎ | × |
| 階段下の部屋 | ○ 空気ボリューム連結で `hiddenWallIds`/`stairOver` を規則へ置換 | ◎ | × |
| 断面詳細図への発展性 | **◎** `SectionCut` は既に「切断線が主語」（`sectionTypes.js:27-51`）で面非依存の入口を足すだけ | ◎ | × |
| 体裁の保全 | ◎ `buildFaceFigure` を触らない | × 作り直しか結局2系統 | ◎ |
| 実装量 | 中。新規 ~400行＋置換 ~600行 | 大。~3000行＋体裁再実装 | 0 |
| リスク | 中。Phase 4 以降で裁定が要る差分 | 高。承認済みの見た目を全部失う | 高（終わりが見えない） |
| 「他図面にも効くか」判定 | ○ INV1-3 を維持・拡張 | △ 不変条件を1から | × |

### 決定: **案A（和算）を推奨**
1. 優れている点の相対評価が高い（高7・中2）。S1・S2・S4 は新設計でも同じものを書くことになる部品。
2. 骨格は既に「切断線が主語」で断面詳細図と一致（`buildCutContent(cut, probeCtx)` は面を要求しない。`sectionContent.js:245`）。壊れているのは**「向こう側」の解像度だけ**。
3. 文書自身が同じ結論に到達している（`elevation-model.md:264`, `:276-278`）。
4. 13.stq ゴールデンを維持する唯一の現実的な道。

---

## 5. 推奨案の設計

### 5.1 コアの考え方
**「列」を「z帯の1次元列」から「視線方向の奥行きを持つヒット列」へ拡張し、床天井を1点プローブではなく空間セル索引から引く。** 可視・線種・アキの規則は変えず、規則の入力の解像度だけを上げる。

### 5.2 モジュール境界（新規は2つだけ。新規依存ゼロ）
```
app/src/elevation/
├── space/spaceModel.js        ★新規: 空間セル索引 (層, x, y) → {room, floorZ, ceilZ, componentId}
└── section/
    ├── sectionHits.js         ★新規: 列のヒット列（奥行き順）と ZBand[] への畳み込み
    ├── sectionProbe.js        probeColumn を sectionHits の上へ載せ替え（対外契約は不変）
    ├── sectionEngine.js       変更小
    ├── sectionEmit.js         Phase 4 以降のみ変更（水平面のヒットを描く）
    └── sectionVisibility.js / sectionLayerStack.js / sectionContent.js  変更なし
```
空間セルの材料は既存の純関数（`finish/edgeClassify.js` `buildCellToRoom`、`finish/gridCells.js`、`finish/roomMetrics.js`、`graph.effectiveFloorLevel`）で、`sectionProbe.js:11-19` が既に import 済み＝純モジュール制約を満たす。

### 5.3 データ構造
- **空間セル索引** `buildSpaceIndex(layers)` → `cellAt(layer,x,y)` / `cellsAlong(cut, mid, from, to)` / `componentOf(layer, room)`。`floorZ`/`ceilZ` の式は `makeProbeContext` の `floorZOf`/`chOf`（`sectionProbe.js:452-469`）を**移設**する（2箇所に置かない。`floorOffsetMm` の差し引きは帯の不変条件）。`componentId` は同層で全高の壁に遮られずに隣接するセルの連結成分。階またぎは上が VOID/STAIR_VOID なら連結（ASSUMED）。
- **ヒット列** `probeColumnHits(cut, mid, ctx)` → `SurfaceHit[]`（深度昇順。kind: cut/cutAlong/wallFace/floorFace/ceilFace/openingFace/slabFace）。候補収集は現行 `probeColumn`（`sectionProbe.js:669-724`）をそのまま使い、「z区間ごとに1つ選ぶ」（`:746-821`）だけをやめる。追加するのは水平面ヒットだけ。`visibleBandsOf(hits)` は「深度最小だけ残し水平面を落とす」＝**現行と完全同値**に作る。これが Phase 2-3 の出力不変を担保する仕掛け。
- **出力語彙**: 変更なし（`elevationPrimitives.js`）。
- **永続データ**: FlatBuffers スキーマ・graph は一切変更しない。**13.stq の変換は不要。**

### 5.4 既存コードの扱い
| 分類 | 対象 |
|---|---|
| 残す（無変更） | `sectionVisibility.js` / `sectionLayerStack.js` / `sectionContent.js` / `sectionTypes.js` の座標規約 / `elevationFigure.js`（体裁） / `elevationPrimitives.js` / `elevationLayout.js` / `elevationStyle.js` / ゴールデンテスト一式 |
| 載せ替え（契約不変） | `sectionProbe.js:650-827`（`probeColumn`）／`:429-472`（`makeProbeContext`） |
| 置き換え候補（Phase 4以降・要裁定） | `sectionEngine.js:303-310`（800閾値）／`sectionProbe.js:232`（`withinViewRoom`）／`elevationBand.js:720-728`（`openSpans` 注入） |
| 規則へ吸収（Phase 6） | `switchbackCuts.js:61-84`＋`sectionProbe.js:503`（`hiddenWallIds`）／`elevationBand.js:743-820`（`stairOver`）／`sectionStair.js:229-244`（z<2000） |
| 削る（対症が不要になったら） | `sectionProbe.js:599-607`（`unexploredBelowZOf`）／`sectionEmit.js:869-873` の帯種別排他分岐 |

### 5.5 段階的移行計画（各段のゲート＝13.stq ダンプの前後 diff）
| Phase | 内容 | ゲート | 規模 |
|---|---|---|---|
| 0 | ゴールデン基盤（13.stq 全帯の prims、増減を1本ずつ出せる diff） | 基準生成が2回とも同一 | 既存 |
| 1 | `space/spaceModel.js` 追加。`makeProbeContext` が内部で使うが呼ぶのは従来と同じ1点だけ（1点プローブ `ownerRoomAtOffset` も索引経由にする） | diff 空＋test 緑 | +200 |
| 2 | **冒頭で `componentId`/`componentOf`（空気ボリュームの連結成分）を入れ、13.stq の連結成分をプローブで出して階またぎ連結の定義（未検証4）を先に検証する**（R4 の緩和策。Phase 1 では「全高の壁で仕切られているか」を答える既存関数が無く実装コストが見合わないため、消費者が現れる直前のここへ移した。2026-09-11 リード判断）。続いて `sectionHits.js` 追加。`probeColumn = visibleBandsOf(probeColumnHits(...))`。水平面ヒットはまだ作らない。**注意: `SpaceCell` の room=null の `ceilZ` は null で、本番 `buildLayerStack` の `fallbackCeilZ`（cut 依存）と一致しない。素朴に差し替えると room=null 列の天井上限が消える** | diff 空＋INV1-3 緑 | +250 |
| 3 | 水平面ヒットを追加。`visibleBandsOf` は落とす | diff 空。単体で「腰壁の向こうに floorFace」を検証 | +150 |
| 4 | ★初めて出力が変わる。`open` 区間のうち水平面ヒットがある位置を見えがかり水平線に。同区間はアキから外れる | diff を1本ずつ説明→ユーザー裁定 | ~150 |
| 5 | `openSpans` 注入を探査の答えへ差し替え。「アキの下端＝遠側床」の3点規約（`elevation-model.md:303-310`）を回帰で確認 | diff 空（一致しなければ Phase 4 が誤り＝検算） | ~100 |
| 6 | 階段下の部屋。`hiddenWallIds` と `stairOver` を空気ボリューム判定へ置換 | 「13」「6」の帯の差分を1本ずつ説明 | ~200 |
| 7 | 帯の層構成を1関数へ統合。3層以上を許す | 既存4種がビット一致（diff 空） | ~120 |
| 8（発展） | `buildSectionFromLine(line, layers)`（面非依存の入口） | diff 空（新規パス） | +150 |

**Phase 4 と 5 は必ずこの順で**。逆にすると外部注入を外した瞬間にアキの下端が壊れ切り分け不能になる。

### 5.6 「概ね維持」からの意図的差分の予告（★＝ユーザー裁定要）
1. ★腰壁の天端の上・垂れ壁の下: 現在アキの位置に奥の床線／天井線が出る。**アキが減り線が増える。**
2. ★800mmより奥の床・天井: 既定は「壁と同じ800を掛ける」＝差分最小。空気ボリューム判定への置換は別件。
3. 階段下の部屋の帯（Phase 6）: `stairHiddenByCeil`（`elevationBand.js:759`）は1点判定なので、勾配の途中で天井を跨ぐ構成で結果が変わりうる。実機「13」C で確認。
4. 階段帯の2a壁（Phase 6）: `FOOTPRINT_EDGE_TOL_MM=150` 依存の判定が空気ボリューム判定になると際どい壁で変わりうる。
5. `unexploredBelowZOf` の削除: diff 空を確認してからのみ。
6. **変わらないと約束するもの**: 図面の体裁（巾木・壁2段書き・寸法・通り芯丸・面ラベル・建具姿図・部屋名枠）、線種規則、面の配置・レイアウト・縮尺、A/B/C/D の向き、データ形式（13.stq 変換不要）。

---

### 5.7 Phase 3 で確定した規約（2026-09-11 リード決定）
- ヒット列の `depthMm` は**切断線（室内側へ下げた位置）から視線方向へ測った正値**で、壁の `distMm` と同一基準。Phase 4 の深度上限は既存規則どおり「その切断で最も手前の壁面からの相対」で掛ける（`sectionEngine.js` の `nearestSightlineDistMm`）。`slabFace` の `distMm:0` は番兵で測定値ではない。
- **同深度のタイは垂直面（遮蔽物）が水平面より先**: `kindRank` = cut 0 / cutAlong 1 / wallFace 2 / floorFace・ceilFace 3 / slabFace 4。腰壁 wallFace と向こうの部屋の floorFace は壁芯＝セル境界のため必ず同深度になる。
- floorFace/ceilFace は単一 z の縮退面。厚みを持つのは slabFace（床構造・天井懐）だけ。
- floorFace/ceilFace の発生は切断線オフセット > 0 に依存（自室セグメントをスキップするため）。実データ全108面で offset > 0。
- 視線の先の部屋の天井高が解決できない（`getFinishInfo` 例外）ときは `ceilZ:null` で積む＝床線は出るが天井線は出ない説明可能な縮退。

### 5.8 Phase 5 の検算結果（2026-09-11）
外部注入 `cut.openSpans` を撤去して探査の答えへ一本化したところ、13.stq/11.stq「11'」A2 左の開放スパンで**アキ上端が自室天井から 100mm 下がり天井線が出る**差分が出た。
builder は「外部注入の簡易値と探査値のモデル差＝要裁定」と説明したが、QA の実データ裏取りで **Phase 5 の誤り**と判明:
floorFace と ceilFace が `farDepthMm` を共有していたため、近い床（57.5）が全高壁の向こう 1000mm 先の部屋10の天井を深度上限の外から引き入れていた。
床・天井それぞれの深度で上限判定するよう修正すると3ファイルとも完全一致（設計 §5.5「一致しなければ Phase 4 の実装が誤り＝良い検算」が機能した実例）。
**教訓**: 検算ゲートが落ちたら「モデル差」と説明する前に、深度・座標系（帯ローカル／絶対、floorOffset）を実データで裏取りする。
`--no-horizontal-faces` は Phase 5 以降「水平面由来の表現をすべて止めた素の探査結果」で、Phase 4 以前の基準とも一致しない（テストの on/off 切替用にのみ残す）。

### 5.9 ユーザー指示（2026-09-11）: 旧実装の削除と、一般化を担保する修正手順
1. **旧実装の不要なコード・記述は最終的に削除する**（各 Phase で置換したものはその Phase で削除。残りは Phase 7〜8 の後に**クリーンアップ Phase** を設けて一掃: `hiddenWallIds`/`stairOver`/`openSpans` 注入の残骸、`--no-horizontal-faces` の要否、`elevationOpenSpan.js` の far 値の図側経路、`sectionEmit.js` の帯種別排他分岐、`unexploredBelowZOf`、doc の旧方式の記述）。
2. **今後の展開関連の修正で一般化を担保する手順**（`.claude/elevation-model.md` へ正式版を置く。下書き）:
   - **(a) 再現をデータで固定する**: 実データ（`D:/tatsuya/Download/*.stq`）に構成があればそれを、無ければ `makeKneeDropTest.mjs` の作法でテスト用 .stq を作り、`dumpElevFigure.mjs` で帯のプリミティブをダンプして「何が違うか」を図の座標で言う。
   - **(b) 判断の置き場所を決める**: 壁の実体・可視・奥行き・アキは**断面エンジン（`section/`）だけ**、図面の体裁は `buildFaceFigure`。「面ローカルで自階だけ見て決める」判断を新設しない。列にしか無い情報が図に要るなら、チャネル（図⇄エンジンの専用受け渡し）を増やさず、**エンジンの答え（ZBand の付帯・ヒット列）を読む**。
   - **(c) 帯種別の分岐を足さない**: 通常／上部吹抜け／吹抜け／階段のどれかにしか効かない `if` を `buildCutContent` 以降に入れない。層スタック（`sectionLayerStack.js`）とヒット列で表現できないなら設計を見直す。
   - **(d) 「未知」を「アキ」にしない**: 探査が答えられない区間を open に落として後段の除外条件で引く、を繰り返さない。答えられない理由（層の窓・深度上限・成分違い）を band に残す。
   - **(e) ゲートで守る**: 修正前に `golden13`／`golden-knee` との diff を取り、修正後の差分を1本ずつ説明できるものだけ採用（`diffElevGolden.mjs --merge`）。意図的な差分はユーザー裁定→ゴールデン再採取→採取コミットを doc に記録。合成 fixture の単体テストは**変異テストで赤化を確認**してから提出。INV1-3（`sectionProbeMultiLayer.test.js`）は必ず緑。
   - **(f) 深度・座標系を疑う**: 出力不変が期待される置換で差分が出たら「モデル差」と言う前に、帯ローカル／絶対・floorOffset・深度の基準点（切断線か最も手前の壁面か）・全高壁の向こうでないかを実データで裏取りする。
   - **(g) 定数は1箇所**: 深度上限・許容誤差は `elevationStyle.js` から取り、経路ごとに別の値を持たない。

### 5.10 Phase 6 前半の結果（2026-09-11）
- リンク1（`hiddenWallIds`）を「壁の両側の Room を `cellAt` で見て、片側だけが階段下の部屋（`stairUnderRoomsOf` と同じ単一情報源）で反対側が階段室の空気成分（`componentOf`）と一致し、かつ `isRoomWall`」の規則へ置換。`FOOTPRINT_EDGE_TOL_MM`/`insideFootprint`/`stairUnderInfo` は削除。
- 13.stq「6」面Cに差分: 旧は部屋13の2a壁6枚のうち y=−3500 の2枚を取りこぼしていた（軸CL値だけで footprint 外接矩形の辺と比べる副作用。階段室6は y=−3500 に壁を持たない）。新方式は6枚を隠し、アキが帯内 x 0〜1505→0〜2885 に広がり、z=2400 破線・z=3000 線が 2885 まで伸びる。QA 判定「新が正しい（旧はアーティファクト）」。**ユーザー裁定→golden13 再採取**。
- `componentOf` は Phase 6 で本番の消費者（`isHiddenWall`）を得た。所要時間は劣化なし。
- **ユーザー裁定（2026-09-11）「6」面Cのバツ（アキ）の正解**（旧も新も不成立）:
  - 1本目: 始点＝**1階天井の見えがかり線と X3 側の壁の交点**、終点＝**往路の破線梯子の右下（1FL）**。
  - 2本目: 始点＝**1階天井の見えがかり線と復路ささらの交点**、終点＝**X3 側の往路の破線梯子の左下（1FL）**。
  - 意味: このバツは「階段を上りはじめる Y2 から 3500 の方を見て、空いて見えるところ」を示す。**復路の向こう側には「13」の壁が立っている**ので、復路ささらより向こうはアキではない（現状のバツ＝x 0〜2885 全幅は不成立）。
  - 「その辺（y=−3500）は階段室自身の壁」という旧解釈は誤りで、正しくは**階段下部屋（13）の壁**。
  - → 2a 壁を「隠す／隠さない」の二値ではなく、**階段の占有形状（復路ささら）が遮蔽物として視線に参加し、その向こうに 13 の壁が見える**という表現が必要（Phase 6b-1 の `stairFace` ヒット化が前提）。golden13 の「6」は旧のまま据え置き（旧も正解ではない）。
- **裁定の補足（2026-09-11）**: バツは z=0（1FL）〜2400 の**1枚**として扱う。線種は**視線を遮るものが無いところは一点鎖線、遮るもの（往路の梯子など）があるところは破線**。「復路ささら」＝`innerStringerSilhouette` が描く x=1492.5 の縦線で正しい。座標: 1本目 (0,2400)→(1392.5,0)、2本目 (1492.5,2400)→(0,0)。**Phase 6b-1 へ進むことを承認。**
### 5.11 Phase 6b-2 の設計（architect 2026-09-11。案C「実体の三分類＋遮蔽チャネル」を採用）
- **因果**: 「6」面C のバツが x 0〜2885 になる主因は `isHiddenWall` が 13 の壁を**候補から消す**ため列が `open`（＝アキ）に化けること（P4 の再来）。復路ささらの不在は主因ではない。z 下端 1500 は `baseFloorZ` ではなく**断面線（`cut.drawFloorProfile`＝面全幅フラット 1500）のクランプ2段**（`sectionEmit.js` の `drawnFloorProfileZMax` と `elevationStairSequence.js` の `clipContentAboveDrawnProfile`）。上端 2400 は Phase 4 の ceilFace。
- **決定的な発見 D3**: 裁定の2本は右端 x が食い違う（1392.5 と 1492.5）。現行のバツ式（頂点を x0/x1 に固定）では**どんな band を作っても出ない**。頂点を「空き面の頂点集合の極値（argmin/argmax of x+z と x−z）」へ一般化すると、列A(0〜1392.5: open z0..2400)／列B(1392.5〜1492.5: open zStep..2400)／列C(≥1492.5: 13 の壁＝実体) の L 字から裁定の4点が出る。矩形成分では現行と一致。
- **規則（3チャネル）**: 実体（band: cut/cutAlong/wall/slab/**hidden**/farVoid/open）がアキの成否・断面線・見えがかり線を決める。遮蔽（stairFace 等）は**線種の降格（破線）と端点のトリムだけ**を決める。体裁は不変。
  - C-1 `isHiddenWall`＝「候補から消す」→「**描かない実体 `kind:'hidden'`**」（列分割にも参加、`overCutWall` に当たらない独立 kind、下流は何も描かない）。**列ごと・深度付きへ変える必要は無い**。
  - C-2 アキの下端の輪郭クランプ2段を撤去（下端は band が決める）。前提 A2（踊り場より下の向こう側が階段室6自身）。
  - C-3 `splitGapMarksByStair` の入力を `stairOccluderRects` から `stairFace`（tread/landingFrame。stringer は幅0で除外）へ（出力不変。突き合わせテスト済み）。
  - C-4 バツの頂点を最大対角へ一般化。
  - C-5 バツの様式は**線分ごと**: 対角を `baseFloorZ` で分割し両片 `center` で `emitLine` に渡す（下片は §5.6 フィルタが破線へ降格）。`extendedFromZ` の例外は維持。「ア キ」文字は L 字なので出ない（現状規則）。
- **段階**: 6b-2-0 測定（M1 列と bands／M2 踊り場下の向こう側の Room／M3 隠れた壁の z 範囲／M4 STEEL か・x=1492.5 の縦線の有無）→ 6b-2a C-3（不変）→ 6b-2b C-4（不変期待）→ 6b-2c C-1（「6」のみ差分）→ 6b-2d C-2＋C-5（「6」のみ）→ 6b-2e 実機確認・裁定・golden13 再採取。
- **stairOver（6b-3）**: 判断8個のうち答えられる＝#1 横切るレーン(stairFace)／#7 面端縦線(遮蔽チャネル)／#8 天井線の側(cellAt)／#2 天井より上(列ごと。出力が変わりうるので最後)。残す＝#3 階段プリミティブ生成／#4 天井クリップ／#6 踊り場水平線。順序 6b-3a #5 共有化→3b #1→3c #7→3d #8→3e #2。`elevationBand.js` の行は 734-811（本文書の 743-820 は行ずれ）。
- **ASSUMED**: A1 13.stq が非STEEL で「復路ささら x=1492.5」が実機に無い可能性／A2／A3 列B の zStep／**A4 帯内 x 1492.5 が 13 の壁の材範囲と一致するか**（前段の診断では 13 の壁は帯内 x 1505 から。12.5mm ずれるなら「アキの右端は13の壁か復路ささらか」をユーザーに1問）。
- Open: A9 バツだけ z0 まで下ろし、床線・面端縦線・壁断面は 1500 のまま（最小差分）。
- **6b-2-0 測定結果（2026-09-11）**: A1 否定（「6」は STEEL、x=1492.5 のささら線は実在）／A2 一致／A4 一致（x=1492.5 は 2a 壁本体ではなく、その手前の **13⇔6 の間仕切り壁**（垂直、z0〜2400 連続）の室内側面。2a 壁本体は 1505〜）／A3 不一致（x 1392.5〜1492.5 に段は無く z0〜2400 が開いている）／M5 で断面線クランプ2段を外すと下端が 0 になることを実証。
- **ユーザー裁定の訂正（2026-09-11）**: 往路と復路の桁のあいだの隙間（x 1392.5〜1492.5、z 0〜1500）は壁が無く見通せる、という解釈が正しい。**バツの終点はどちらも x=1492.5 の復路ささら面**。→ アキは **x 0〜1492.5 × z 0〜2400 の長方形**、対角 (0,0)→(1492.5,2400)・(0,2400)→(1492.5,0)。**C-4（頂点の極値化）は本件に不要**（矩形なので現行式で出る。将来の一般化候補として保留）。実装は C-3（不変）→ C-1 → C-2＋C-5。
- **リンク2（`stairOver`）は未着手**。QA の助言: `stairHiddenByCeil` は列ごとの1点判定で、断面エンジンが答えられるのは階段の占有形状と帯の天井高まで。勾配の途中で天井を跨ぐ列の可否はヒット列に階段踏面の面が無いため答えられない。着手するなら先に `stairContribution` の占有形状を `SurfaceHit`（`stairFace` 等）としてヒット列へ載せ、`visibleBandsOf` の選択に参加させる段（Phase 6b-1）を置き、その後に `stairOver` の判断を1つずつ外す（Phase 6b-2）。

### 5.12 ユーザー指摘（2026-09-12）: 「6」でゴールデンと一致しているが誤っている6点（一般解として修正）
- **C-1**: 「6」C: 2階 Y3 の壁断面が腰壁の上から 2F 天井断面まで到達している → **腰壁天端で終了**が正解。2階天井断面は **Y3 の外まではり出し**が正解。
- **C-2**: 「6」C: 断面の中は描かないので、2階 Y3 の 1F 天井見えがかりは**断面線より左は描かない**。2階腰壁の Y3 左側の見えがかり（細線）は **2FL 断面線より下は描かない**。
- **D1-1**: 「6」D1: 断面の中は描かないので、2階床断面・腰壁（階段側）断面・1階天井断面の**中**（階段復路のささら）は描かない。
- **D2-1**: 「6」D2: 2階、階段復路の最終段は **2階床断面のはり出し**が正解。腰壁（階段側壁相当）の位置にある **2階床から 2階天井まで伸びる断面線は描かない**。
- **D2-2**: 「6」D2: 2階階段の最終段は、鉄骨階段の場合、蹴上も鉄板なので**蹴込を付ける**。
- **D2-3**: 「6」D2: 踊り場断面・階段断面・2階床断面で展開の断面線が完結したので、**その断面線より下にあるささら（下）は描かない**。
- 指示: 現在の判定の仮定を追跡し、判定ミスの仮定を精査し、根本的問題を**一般解**として修正する。説明根拠に反する可能性が高い場合はユーザーに確認。修正で出力が変わる箇所は分かりやすく報告。
- 6b-2 の面C（アキ矩形）はこの指摘の前提として採用扱い（golden13/golden11 の「6」は本件の修正後に再採取）。
- **診断結果（2026-09-12）— 3つの根本**:
  - **根本A**: 階段帯は `cut.ceilProfile` を持たず、`clipBandsToVisible` が `ceilZ` 非有限で丸ごとバイパス＝「断面の中は描かない」判定（`reachableAirByColumn`＋`exposedAboveCeil`）が階段帯で構造的に発火しない。→ C-1 前半・C-2 前半・D2-1 後半。一般解: 列ごとの実効天井を空間セル索引から解決して階段帯にも与え、同じ判定を通す（P10 の帯種別排他分岐の解消にも直結）。
  - **根本B**: 階段自身の幾何（`stairContent`＝ささら見えがかり・桁枠断面）は「断面の中」クリップの対象に一度も入らない（`contentForCut` が意図的に除外。`stringerBandGeometry` のトリム端緩和が 2FL 側でも同じ式で効き腰壁・床構造の内部まで伸びる）。→ D1-1・D2-1 前半の縦線・D2-3。一般解: `clipContentAboveDrawnProfile` の天井側の対を追加し、根本A の共通境界で `stairContent` もクリップ（「緩めて描画→共通境界でクリップ」の2段）。
  - **根本C（B の派生）**: `computeFlightProfile` の `clamp` が `fullColumnsXRange` へ**点を切り詰める**ため、最終段の蹴込オフセットが失われ斜め線が垂直に潰れる。→ D2-2。一般解: 点の切り詰めを線分の交差クリップへ。既存仕様「最終段も同じループで処理、例外なし」からの逸脱＝バグ。
    - **訂正（2026-09-12 QA 実測）**: クランプ前の頂点列では最終段の蹴込（dx=30）は**描画範囲の外**（「6」D2 相当: 踏面 2147.5〜2427.5、蹴込 2427.5→2397.5、hiX=2295）。範囲で正しく切ると踏面が水平に切れて終わり z=3000 に達しない。「点を寄せて畳む」実装は「13」で踏面を斜面に化けさせる回帰、線分交差クリップでも「13」の先頭頂点・面端縦線の高さ・木造テストが変わる。**根本C の変更は全て revert**。D2-2 の本質は**描画範囲（`cutDrawRange`＝`cut.line.lo/hi`±探査延長）が階段の実体の終端（最終段の蹴込＋2FL）を含まない**こと。D2-1（x=15645 の天井までの閉じ線）の発生元は `emitLine`・`elevationStair.js:227-232`・`elevationFigure.js` の ceilRuns では0件＝未特定。次: seq5 の範囲の根拠と D2-1 の発生元を確定してから、D2-1/D2-2/D2-3 を「最終段の上端の断面の閉じ方」として一体で設計する。
    - **確定（2026-09-12 QA、push フックで特定）**: D2-1 の縦線は **`elevationFigure.js:923-926` `buildFaceFigure` の「面端の縦線」**（`hasWallAtLocal0` で CUT 太線。上端＝区間の天井 5400、下端＝その位置の断面線＝階段輪郭）。x=15645 は**面D2 の端（local 0 ＝ `cut.line.hi` ＝ world y −3602.5）**。復路 flight の最終段の踏面は帯内 15792.5→15512.5（面内は 15645 まで）、**蹴込 15512.5→15542.5 と 2FL 到達点 15542.5（world −3500）は面の外（102.5〜132.5mm）**。一方、図側の `upperFloorEdgeSpans` は既に面の外（15485〜15542.5）に 2F 床のはり出し線を描いており、終点 15542.5 は階段が 2FL に到達する点そのもの。＝「断面線の外は描画しない」規約が、はり出しでは破られ階段輪郭では守られている**二重基準**が D2-1/D2-2 の根。
    - **設計案（裁定待ち）**: (a) 階段帯では**描画範囲を階段の実体の終端（2FL 到達点）まで広げる**（はり出し線と同じ終点に揃える。設計 S5）→ 最終段の蹴込が描かれる（D2-2）。(b) その端では**面端の縦線を上階 FL より上に描かない**（2F 床のはり出しと 2F 壁の縁で閉じる。`elevationFigure.js:884-885` の「外端の壁エッジは content が描く」宣言に揃える）→ D2-1。(c) ささら系（`stringerPrimitives`/`stringerBandGeometry`/`innerStringerSilhouette`）を既存の `clipContentAboveDrawnProfile(cut.drawFloorProfile)` の対象に加える（アキは Phase 6b-2 で意図的に対象外＝doc に明記）→ D2-3/D1-1。ただし「直進部ささらと踊り場ささらのトリム結合」（確定仕様）と同じ端を2規則で切るため優先順位の裁定が要る。
    - **ユーザー裁定（2026-09-12）**: (a) **面端の外は content 側に渡す**（図側は面の外を描かない。案2）。(b) x=15645 の縦線: **「D2 のこの近傍に断面を作る『面』は存在しない」**。他の線分には根拠があるがこの縦線だけ無い→「面」判定（`hasWallAtLocal0`/`edgeAtLocal0`）の不備を疑い、線分の根拠を明らかにする（先に報告）。(c) **トリムを先にしてからクリップ。トリム端・非トリム端を問わずクリップ**。順序: (b) の結果報告→修正→コミット→次フェーズ。
    - **(b) の結果（2026-09-12 QA 実測）**: `hasWallAtLocal0=true` の根拠は **13 の 2a 壁 `10ff7970`（H@−3500、面 −3602.5、下地オーナー壁）**。図側の面端判定（`elevationFaces.js:132-142 realWallAtCorner`→`wallFaces.js:67 innerWallFaceAt`）が CL 上の全壁を**所有者・可視性を見ずに**数え、断面エンジンが hidden とする他室壁を面端の壁と誤認。副作用: 面D2 の端が −3500→−3602.5 へスナップ／その端に CUT 縦線（天井まで）。反対端（x=18985）は6自身の外壁が根拠で正しい。一般解: (1) 面リスト構築に「この帯で実体として数えない壁」の述語（`isHiddenWall` と同じ判断）を通す、(2) 図側の面端縦線は自階の実壁の高さ（上階FL）までに限り、上階は content とはり出し線に任せる（裁定(a)）。
    - **実装の経過（3ラウンド、2026-09-12）**: 案1 `wallFilter`（`wallFaces.js`→`elevationFaces.js`→`elevationFaceList.js`、供給 `switchbackCuts.js` `stairBandWallFilter`、判定は `sectionHits.js` `isWallHiddenForBand` を `isHiddenWall` と共有＝13.stq で同じ6枚）。案2 `capsAtUpperFloor`＝上端 `min(天井, 上階FL)`、gate は `upperFloorEdgeSpanAt(end)`（はり出し線が引かれる端だけ）。第2ラウンドで「壁のない端部」の定義が分裂（`drawnX0`/`faceWallLessExtents` が hidden を見ず、2F 床の小口 57.5→207.5、面D2 +150 平行移動）→第3ラウンドで述語 `wallLessEndAt(face,end)=!hasWall&&!hiddenWall` に集約（**探査窓 `withProbeExtension` だけは旧定義のまま＝探査は広げ描画は締める**。締めると recessLo が全滅）、`clipContentAtHiddenEnds`（hidden 端で面の境界を越える content の水平線を落とす）。結果（HEAD 基点）: 面C x=0 の縦線 5400→3800（cap 3000＋2F 腰壁 cutEdgeHi）、D2-1 の縦線消滅、最終段の踏面が面端 −3500 まで、新面端に垂直の蹴上、84mm 片・ささら頂点移動。「5」は x=6085 のみ（天井<上階FL の cap）。
    - **QA 最終判定（第3ラウンド）**: 集約・C-1/C-2・D2-1・小口 57.5・変異は合格。**次ステップへ切り出し（「最終段の上端の閉じ方」の一体設計）**: (1) D2-2: 最終段の鼻は world −3470（面端 −3500 の **30mm 外**、2F 床側）、2FL 到達点 −3500。`sectionStair.js:427-431` の clamp が鼻を潰し踏面 280→250・蹴上が垂直。正しい図: (−3750,2863.6)→(−3470,2863.6)→(−3500,3000)。修正案は**階段自身の幾何の描画範囲だけ**を終端で `nosingMm` ぶん広げる（clamp を線分クリップに替える案は「13」で回帰＝不採用）。2F 床の小口（−3500..−3442.5）は不変で、蹴込はその下に潜る。(2) 84mm 片（world −4385..−4500 の 1F 天井見えがかり 115mm を階段輪郭が 84mm に削った断片。案1由来。HEAD には無い）: 見えるべきか階段の中で消すべきか要判定。(3) 内側ささら上端が HEAD −3454（2F 壁 footprint 内）→ −3356（向こう側の面 −3442.5 を 56mm 越え、run の外）: **終端の定義を「上階壁の向こう側の面で止める」に整備**（`clipContentAtHiddenEnds` は polyline を素通し）。テスト案: 最終段は蹴込を持つ／ささら上端は上階壁の向こう側の面を越えない。
    - **一体設計（architect 2026-09-12）**: 規則 `stairDrawRange(cut, ext) = cutDrawRange ± ext`、`ext`＝その切断の `upperOverhang`（上階の平面が面端より外へ続く量。エンジン自身の答え）。階段自身の幾何（踏面 CUT・ささら見えがかり・桁枠）は**生成時にこの範囲でクランプ、出口で同じ範囲へクリップ**。`cutDrawRange`／`withProbeExtension` は不変、`fullColumnsXRange` に第3引数 `ext`（既定0＝現行同値）、`columnsXRangeOverlapping`（踊り場線等）には渡さない。`contentForCut` が `upperOverhangOf` を先に計算して `stairPrimitivesForCut(..., {drawExtend})` へ（`cut` は生のまま。`pcut` に変えると壁のない端で150伸びる）。「13」の stairOver は渡さないので不変。面D2 では範囲 [−57.5, 3442.5]＝帯内 15485..18985 → 鼻 −30 は範囲内（蹴込成立）、ささら角 −144 は −57.5 で切れる。ささらの終端は `stairPrimitivesForCut` の出口クリップ1箇所（`stringerBandGeometry`/`clipStringerToAnchors` は触らない。順序: ミトレ→辺落とし→z クリップ→x 終端クリップ＝裁定(c)）。「断面線より下のささら」は `contentForCut` でささら系（`sectionEmit.js:1157` の `isStringer` を export して単一情報源化）だけを `clipContentAboveDrawnProfile(drawFloorProfile)` に通す（`clipWallFloorEdgeUnderZigzag`/`joinToStairProfile` より後、アキ・桁枠・踏面・梯子・端面は対象外）——ただし D2 では下ささらが全長消えるため 2026-08 承認表現と衝突の可能性＝**P3 の図を見て裁定**。84mm 片は見えがかり壁の上端（`sectionEmit.js:763-765`、階段の向こうの1F天井）で、消すなら案A（`stairFace` を選択に参加）＝別フェーズ。段階: P0 測定→P1 `clipPrimitivesToXRange` 抽出（不変）→P2 蹴込→P3 ささら終端→P3.5 裁定→P4（任意）→P5 84mm→P6 doc/golden。
    - 確認事項（P3 後）: Q1 P4 の適用範囲（断面線より下の下ささらを全長落とすか）、Q2 終端上限＝`upperOverhang` の外端で良いか（はり出し0の端は面端で止まる）、Q3 84mm 片は見えるべきか。
    - **P1〜P3 実装（2026-09-12、QA 最終確認中）**: P1 `clipPrimitivesToXRange` を `elevationPrimitives.js` へ移設（出力不変）。P2/P3 `stairDrawRange(cut, outerBound)`（**面ローカル x の絶対値**契約。増分ではない）、`fullColumnsXRange` 第3引数、`stairPrimitivesForCut(..., {outerBound, slabBand})` 出口で x 終端クリップ、`clipStairDetailInSlabBand` は**出口クリップの前**に `stairPrimitivesForCut` 内へ統合（分割後の同一部材が上下ささら対と誤認されるのを防ぐ。3呼び出し元で順序統一）。`upperOverhangOf` に `stairOverhangOuter`（絶対）を追加。`stringerEndCapPrimitives` の端面は壁芯（−57.5）ではなく描画範囲端へ**クランプ**（消さない。QA: 「x=−57.5 artifact」の最後の生産者）。結果（HEAD 基点、「6」のみ）: D2 最終段 (15792.5,2863.6)→(15512.5,2863.6)→(15542.5,3000)＝踏面280・蹴込30、小口 15485..15542.5 不変、D2 ささら上端 15485 で終端、D1 ささらの腰壁内部への突入（3648.8,2796.6）は消えたが**下ささらの 2FL より下（z 2749.6）は HEAD 由来で残る＝P4（Q1）待ち**。QA 最終（条件付き合格）: P4 の根本は `sectionEmit.js:1167-1171 isLower` が「別の polyline で meanZ が高く x が重なる相手」を要求するのに、ささらの見えがかりは上辺と下辺を**1本の閉じた輪郭**で出すため相手が無く恒久的に false（閉じた輪郭では発火しない）→ **P4 は上辺/下辺を polyline 単位でなく辺単位（または明示ロール）で判定する形**。また x 終端クリップで閉じた輪郭が面端で2本の開いた run になり、境界に縦の閉じ線が無い（D1 で 281.7mm、D2 で 204.9mm の切れ目）＝**ユーザー確認事項（許容しないなら階段輪郭にだけ境界で閉じる処理）**。
    - **ユーザー裁定（2026-09-13。P3 後の「ささら切れ目」確認に対して）**: 現行HEADのダンプで切れ目を再確認（D1 帯内x=3792.5 z 2718.3〜3000、D2 帯内x=15485 z 2749.6〜2954.6。どちらもスラブ帯 2400〜3000 の内側）。裁定: **2026-08承認「下ささらは1F天井〜2F床の間だけカット」（`slabBand`/`clipStairDetailInSlabBand`/`isLower`）は、階段下に部屋がない場合に指定した一般ルール「断面内部は描画しない」の特例**だった。新しい処理で「断面で囲まれる→描画不要」を正しく判定できるなら**特例は削除**（P4＝isLower の辺単位化は特例内の改良なので不採用）。判定できないなら「断面で囲まれる」判定を再考して一般化を担保する。**ルールの多重化が一般化を阻害している。確認事項には必ず根拠（条件の出自）を併記する。** → 次: stairContent への「断面内部は描かない」一般判定の設計（architect）。
    - **P0 実測（2026-09-13。`stairPrimitivesForCut` 冒頭に一時計装→13.stq ダンプ→revert）**: 「6」D1(seq2, 帯内x=local+3792.5)は local −150..0 が `slab[2400..3000]`、**0..57.5 は `hidden[0..3000]`（13⇔6 の壁）、57.5..2512.5 は `hidden[0..5400]`**＝x>0 に slab は無い。D2(seq5, 帯内x=local+15542.5)は −57.5..0 が `slab[2400..3000]`、0..102.5 は `hidden[1500..2400]`+`wall[2400..5400]`。seq2/seq5 に `open` 帯は0本。「13」stairOver 経路の3 cut は `wall` のみ。hidden band に出自（cut/見えがかり）の情報は無い。→ 案α{slab/cut/cutAlong}では D1 の切れ目は不変、D2 は 15542.5 へ移るだけ＝解消しない。slab を主張しない根本は `sectionHits.js:1037-1048`（所有Roomのある列のみ）だが、階段帯の該当列は全 z が壁ヒットで埋まり slab/open 分岐に到達しないため、slab 主張の一般化(a)は「6」に no-op（他帯にだけ副作用）＝却下。
    - **設計(d)（architect 2026-09-13。採用）**: 囲む実体＝`slab ∪ cut ∪ cutAlong` の矩形。ただし **slab の矩形は、その上（下）に立つ `cut` 壁の向こう側の面 farX まで延ばす**（`slabEdgeCutWallJunction` `sectionEmit.js:501-521` が小口の縦線を立てる x と同一＝既存規則の再利用）。対象は **`isStringer`（DETAIL polyline）のみ**（踏面 CUT を対象にすると D2 最終段の蹴込 (−30,2863.6)→(0,3000) が slab 内で消え D2-2 が回帰する。実測）。判定は**厳密内部**（矩形を GAP_EPS インセット。`segmentInsideRect` は辺上を内側と判定するため、面C x=1492.5 の裁定線を守る）。`hidden`/`wall` は囲まない（§5.10）。入力は `columns` のみ（新チャネル無し）。置き場所: `isSolidBand`/`solidRectsOf`→`sectionTypes.js`、`subtractRectsFromPrimitives`→`elevationPrimitives.js`（`sectionEmit.js:993-1050` の `mergeIntervals`/`segmentInsideRect`/`subtractRectsFromLine` を移設、`splitGapMarksByStair` は移設先を呼ぶ）、`isStringer` を export。削除: S1 `clipStairDetailInSlabBand`+`isLower`、S3 `opts.slabBand` と順序制約、S4 の slabBand 用途、テスト4本。段階: P1 移設（不変）→P2 置換（「6」のみ3本: D1 下ささら始点 3792.5→3850(z2686.9)、D2 下ささら始点 15485→15542.5(z2718.3)、D2 上辺の (15509.8,3000)-(15485,2954.6) 片消滅）→P3 特例削除（不変）→P4 ささら系を `clipContentAboveDrawnProfile` の対象に（D2 下ささら全長消滅）。
    - **ユーザー裁定（2026-09-13）**: **D1 は下ささらを 2F床の小口 x=3850（z2400..3000 の中線）に着地させて閉じる**（D1-1「断面の中は描かない」の厳密適用。小口より右 3850〜4376 の吹抜け越しの区間は残す＝旧特例は過剰削除だった）。**D2 の下ささらは D2-3 のとおり全長描かない**（根拠: D2 の小口位置 15485..15542.5 の上に立つのは見えがかり壁で切断壁でないため、小口の縦線は図も content も描かず「閉じるべき断面が無い」。整合する解は描かないこと）。→ (d) の P1〜P4 へ進む。
  - 根拠の照合: C-1 前半・D1-1・D2-1 後半・D2-2・D2-3 は「そのとおり」。C-1 後半（2F 天井断面のはり出し）は既存はり出し経路で自動的に出るか要確認（Q1）。C-2 後半（細線）は該当する thin 線がダンプに無く対象未確定（Q2）。D2-1 前半（2階床断面のはり出し）は `joinToStairProfile` の既存機構で出るはず（Q3）。D2-1 と D2-3 が同じプリミティブか（Q4）。ユーザー原文「Y3」はコード表示では「X3」（帯内 x=0 側）。
  - 出力が変わる見込み: 階段帯が関与する全帯（13/11 の「6」。他室・2階・knee は不変のはず）。鉄骨折返し階段の別実データが無いため、必要ならテスト用 .stq を追加。
  - **根本A の訂正（2026-09-12）**: 「階段帯に ceilProfile を与える」実装は HEAD 基点で出力を1本も変えず revert。x=0 の z 3800〜5400 の縦線の実体は 2階の壁（軸 y=−3000、深度 2250、above 層）の見えがかり縁と builder は読んだが、**ユーザー指摘: その壁も 2FL+800 の腰壁なので 3800 より上に見えがかりは無い／問題の線は太線に見える**。→ **再診断で確定（2026-09-12）**: 太く見えるのは面C 自身の左端輪郭（thick、z1500〜5400）と `recessHi`（medium、3800〜5400）の重なり。真因は**腰壁レコードの区間（X2→X3=0）を壁の実ジオメトリが隅の取り合いで 57.5mm 超えており、その食い込み区間で見えがかり候補の点クエリ（`kneeDropRecordsAtPointOnWall`、許容 0.5mm）が腰壁指定を取り逃して全高（capZ=5400）にフォールバック**すること。graph の取り違えではない。`cut` 側は切断面位置の固定クエリのため偶然罹患しない。一般解（実装済み・QA 合格）: 点クエリが0件のとき、**点が壁自身の端から 150mm 以内**（`CORNER_OVERHANG_EPS_MM`＝`SPAN_OVERLAP_EPS` と同値）に限り探索窓を ±150mm へ広げて再クエリ（`kneeDropRecordForWallSpan` への全面置換は `mergeSegments` の混成壁で遠い区間を拾って壊れるため不採用。壁端限定は区間境界の手前 150mm が腰壁高さに落ちる誤爆を防ぐため）。**出力の変化**: 「6」面C x=0 の中線 3800〜5400 が消える／「5」の同型2本が消える／**2F「22」で腰壁自身の端の 57.5mm 片が全高→腰壁天端になり、アキが隣の成分と連結して「ア キ」が4→1に減る**（腰壁レコードの構成壁3枚の食い込み部のみ。A1×X2 の裁定は保持）。深度基準（切断面 vs 最も手前の壁面）の裁定は**この不備の解消後**に改めて判断。

## 6. リスクと未検証事項

| # | リスク | 緩和 |
|---|---|---|
| R1 | ヒット列化で性能が落ちる（突入 12室0.52秒） | `probeColumn` 呼び出し回数は不変。`buildSpaceIndex` は層ごと1回。Phase 1・2 で実測（ASSUMED） |
| R2 | Phase 4 の差分が予想より大きい | Phase 3 までを先に固定。Phase 4 はフラグで on/off できる形にし diff を先に見せる |
| R3 | `floorZOf` 移設で帯の床基準がずれる（実効FL≠0「11'」） | 式は移設であって書き直しではない。「11'」を Phase 1 の重点確認 |
| R4 | 空気ボリュームの階またぎ連結が実データと合わない | Phase 1 では `componentId` を誰も読まない状態で入れ、実データダンプで妥当性を先に確認 |
| R5 | Phase 5 で「アキの下端」3点規約が回帰 | 3点を専用の回帰テストとして先に固定 |
| R6 | `dumpElevFigure.mjs` が 13.stq で例外 | 帯ごと try/catch。error 行が出たら Phase 0 未完 |

**未検証（ASSUMED。潰す順）**
1. 13.stq に「腰壁の向こうに床」「垂れ壁の向こうに天井」構成が実在するか。無ければテスト用 .stq を先に作る（教訓 `stq-test-document-generation`）。Phase 0 で確認するのが最も安い。
2. `npm test` の現状が緑か（base-commit チェック）。
3. `buildSpaceIndex` のコストが `buildCellToRoom` と同オーダーか（R1）。
4. 階またぎ連結の定義「上が VOID/STAIR_VOID なら連結」で良いか。
5. 断面詳細図が要求する**材の層構成（下地／仕上げの厚み内訳・断熱・床の層構成）は本設計の範囲外**。本設計は「面の位置と可視」まで。Phase 8 の前に別途スコープを切る必要がある。
6. 指定7コミットの実差分は未読（件名と現行コードの対応付けで代替）。

---

## 付録: 一文まとめ
現行方式の骨格（切断線＋層スタック＋列×z帯＋深度不連続でエッジを立てる線種規則＋空気の連結で断面の中を決める）は**正しく、断面詳細図の方向とも一致している**。壊れているのは「切断面から見て最初の実体より奥」の解像度だけで、その結果として (a) 向こう側の床天井を外から注入する7本のチャネル、(b) 「アキ」が未知と兼用されることによる9条件の除外、(c) 階段下部屋の2本の手動リンク、が積み上がった。**したがって別方式への全面移行ではなく、プローブを「奥行き順のヒット列」へ、床天井の解決を「空間セル索引」へ拡張する和算**を採り、Phase 3 までを出力完全不変で入れてから、Phase 4 以降の意図的差分をユーザー裁定にかける。
