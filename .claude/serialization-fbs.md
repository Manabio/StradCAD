# FlatBuffersシリアライズの境界線

正確なフィールド一覧は`schema/graphFbs.js`が単一の正（読めば分かる）。ここには変更時に必ず守るべき境界線のみ記す。

## フィールドindexは位置的な契約——既存indexの再利用・並び替え禁止
新しいフィールドは必ず末尾に追加する。既存indexを別の意味に転用したり欠番を詰めたりすると、保存済みデータ（IndexedDB・エクスポート済みファイル）の復元が壊れる。

## GraphSnapshotは1つのルートテーブルをper-floor/project-levelで共有する
フィールド集合は互いに重複しない前提（per-floor用フィールドはproject blobで常に空、逆も同様）。新しいproject全体データを追加する場合もこの使い分けを維持する。

## サブタイプ別フィールドはJSON.stringify/parseを使わずkeys[]/vals[]のペア配列で表現する
`structural/fieldPacking.js`の`packExtraFields`/`unpackExtraFields`が規約。1段ネストはドット記法キーでフラット化する。

## restoreGraphは復元順序に依存する箇所がある
CL→壁→開口→部屋→境界エッジ等の順で解決する。新しいテーブルを追加する際は`applySnapshot`の既存ステップ順と参照関係を確認すること。

## decode入力はUint8Array/ArrayBuffer/plain object（旧JSON、後方互換）の3形態を受理する
ファイル先頭バイトが`0x7B`('{')ならJSONテキストとして扱う。新規コードでJSON経路を追加しない。

## 列挙フィールドを利用者の拡張に開くときは列挙を広げず文字列フィールドを足す
列挙に無い値のときだけ末尾に追加した文字列フィールドへ書く（例`OP.FIXTURE_TYPE_STR`）。既存バイトは不変（既知の値は省略）、読むときは文字列優先、旧ビルドは既定値に落ちる。

## Roomの屋根の仕様（`RM.ROOF_SPEC`→`RS`テーブル）はfeature=roofの部屋だけが持つ
屋根でない部屋はフィールド自体を書かない（屋根の無い文書のバイト列は不変）。`RS`の項目集合は`core/roofSpec.js`の`ROOF_SPEC_KEYS`が唯一の定義で、読み書きは plain の`toData()`形をそのまま通す。`HIGH_SIDE=9`（片流れの高い側）・`RIDGE_DIRECTION=10`（切妻の棟木の向き）は文字列で、null（自動）のとき文字列もフィールドも書かず、読みは無ければnull（旧データ・使わない文書のバイト列は不変）。`COLUMN_THROUGH=11`（柱貫通）はint8でtrueのときだけ書き、無ければ読みはfalse（同じくバイト列は不変）。軒裏4項目（`SOFFIT_MATERIAL=12`・`SOFFIT_BACKING=13`・`SOFFIT_ORIENTATION=14`・末尾の`SOFFIT_NOTE=15`）も空・nullのときは文字列もフィールドも書かない（無ければ読みは空文字／向きはnull）。形状null（自動）は空文字、出幅0は正当な値なのでHASフラグを持たず読み側で既定へ読み替えない（正規化は復元側の`RoofSpec.fromData`）。

## Roomの天井区画（`RM.CEILING_ZONES=31`→`CZ`テーブルのvector）は区画のある部屋だけが書く
区画の無い部屋は空のvectorも作らない（区画の無い文書のバイト列は不変。`FloorSwapManager`のバイト列比較にも響くため）。項目集合は`core/ceilingZone.js`の`CEILING_ZONE_KEYS`が唯一の定義。`HEIGHT`はfloorLevelと同じHAS方式（null＝部屋のCH）、`SHAPE`は`'flat'`以外のときだけ文字列を書き（無ければflat）、`DIMS`（float64のvector）は空でないときだけ書く。float64のvectorは本ファイルで初めて使う（`writeF64Vec`/reader`f64Vec`）。読みはplainのまま返し、正規化（壊れた値・重複キー・空区画）は復元側の`restoreCeilingZones`。`CZ.DETAIL_KEYS=6`/`DETAIL_VALS=7`（部分詳細図の割当て。天井の段差。startObject 6→8）は割当てがあるときだけ書く（無ければ末尾の枠が無いので区画ありの既存文書もバイト列不変。旧ビルドで開いて保存すると消える片方向互換）。

## 階設定表の値（`PLN.TOP_STORY_HEIGHT=12`・`GS.GL_BELOW_1FL_MM=54`）は0＝未設定で、既定への読み替えは読み側（`floorHeights.js`）が持つ
どちらもfloat64で、0のときはバイト列に出ない（既存文書は不変）。readerは0のまま返す（`planCutHeightMm`のように復元側で既定へ化けさせない）——最上階の階高の既定は構造（在来木造2900・他3000）に依るため、読む時点で解決する。`GL_BELOW_1FL_MM`は`PLANES`と同じplane一覧チャネル（`serializePlanes`/`decodePlanes`）でだけ運ぶproject単位の値で、per-floorのblobには書かない。Planeのフィールドを足すときは`collectPlaneMetas`/`applyPlaneMetas`/`planeMetasEqual`（undoの列挙）と`store.js restorePlanesFromIDB`も同時に足す。

## 地階構造（`SI.BASEMENT_STRUCTURE=14`）は値があるときだけ書く
`StructuralInfo.basementStructure`（`'RC造(ラーメン)'｜'RC造(壁式)'｜null`）は`SI`テーブル末尾の文字列フィールド。nullのときは何も書かない（末尾のフィールドはvtableで切り詰められるため、地階構造を使わない文書のバイト列は1バイトも変わらない）。読みは`normalizeBasementStructure`を通し、フィールドが無い旧データ・未知の文字列・空文字はnull。`graphSnapshot`の採取（`buildStructSnapshot`）と復元（`restoreStructCLs`）にも足してあり、CL操作のundo・文書読込み・階操作のundoで保たれる。`StructuralInfo`に項目を足すときは、ここに加えて`FloorSwapManager`のdirty追跡（足し忘れると、その項目だけの変更で未保存の印が付かない）と階操作のundoの列挙（`collectProjectLevels`等）も同時に足す。設計意図は`.claude/structural-model.md`。

## S造スラブの共通仕様（`SI.STEEL_SLAB_KEYS=15`・`STEEL_SLAB_VALS=16`）は既定のとき書かない
`StructuralInfo.steelSlabSpec`（`structural/steelSlabSpec.js`）を`toPairs`の文字列ペア（並列vector）で持つ。`graphSnapshot.buildStructSnapshot`が`isDefaultSteelSlabSpec`（全項目比較）で既定なら空配列にし、`writeStructuralInfo`は空のときvectorも作らない（使わない文書のバイト列は不変）。読みは`setSteelSlabSpec`（正規化）を通し、無い・壊れた対は項目の既定へ。材料コードは`fieldPacking`の`coerce`で数値に化けるため、正規化が`String()`で戻す。スラブの個別仕様`SteelSlab.steelSpec`は新フィールドを足さず、スラブの`extraKeys/extraVals`の`steelSpec.*`で運ぶ（nullなら書かない）。

## S造スラブ小梁の枠の除外集合（`GS.EXCLUDED_SLAB_BEAM_SLOTS=55`）は空のとき書かない
`PlanGraph.excludedSlabBeamSlots`（キーは`slab:<ベイ4辺のCL id>:<X|Y>:<n>:<i>`の文字列vector）。座標キーの`excludedWallBeamAxes`（GS 44）とは別のフィールドにしてある——あちらは追従・張り替えが座標キー前提で、CL idを含むこちらを混ぜると壊れる。空集合のときはvectorも作らない（末尾のフィールドはvtableで切り詰められ、枠を使わない文書のバイト列は1バイトも変わらない）。読みは無ければ空。CL削除時はキー内のCL idで掃除する（`removeDependentsOfCenterLine`）。

## 建具の部分詳細図の上書き（`OP.DETAIL_KEYS=28`・`DETAIL_VALS=29`）は上書きのある建具だけが書く
`Opening.detailRefs`（`{[slot]: 詳細図キー}|null`。正規形は`core/detailRefs.js`＝空文字・非文字列を捨て、キー昇順、空なら null）を slot 名と図キーの並列 vector で持つ。null・空のときは 2 フィールドとも書かない（上書きの無い文書のバイト列は不変。13.stq・moku4 の全階で HEAD と一致を実測）。読みは無ければ null。新 .stq を旧ビルドで開いて保存すると detailRefs は黙って消える片方向非互換（`OP.FIXTURE_TYPE_STR` と同型）。枝番（`openingSubSignature`）には含めない（R15）。

## 部屋の取り合いの割当て（`RM.DETAIL_KEYS=32`・`DETAIL_VALS=33`）は割当てのある部屋だけが書く
`Room.detailRefs`（`{floorWall?, wallCeiling?}|null`。正規形は建具と共用の`core/detailRefs.js`）を slot 名と図キーの並列 vector で持つ。null・空のときは 2 フィールドとも書かない（13.stq・moku4 の全階で HEAD と sha256 一致を実測）。読みは無ければ null。旧ビルドで開いて保存すると黙って消える片方向非互換（`OP 28/29` と同型）。

## 腰壁・垂れ壁の部分詳細図の割当てと表の側（`KDW.DETAIL_KEYS=5`・`DETAIL_VALS=6`・`FRONT_SIDE=7`）は値のある記録だけが書く
記録（`GS.KNEE_DROP_WALLS`の要素。`startObject`は 5→8）の`detailRefs`（`{kneeTop?, dropBottom?}`。正規形は`core/detailRefs.js`と`core/kneeDropRecord.js`）を slot 名と図キーの並列 vector で持つ。null・空のときは 5/6 を書かず、`frontSide`（0＝roomNeg〔既定〕・1＝roomPos）も既定なら書かない（割当ても表の側の変更も無い文書のバイト列は不変。13.stq〔記録 4 件〕・moku4 の全階で HEAD と再エンコードの sha256 一致を実測）。読みは無ければ null・既定。旧ビルドで開いて保存すると黙って消える片方向非互換（`OP 28/29`・`RM 32/33` と同型）。

## 主屋根（`GS.MAIN_ROOF_SPEC=53`→同じ`RS`テーブル）は既定値のとき書かない
最上階の階ごと設定（`PlanGraph.mainRoofSpec`）。`graphSnapshot.buildSnapshot`が`isDefaultRoofSpec`で既定値なら`null`にし、`encode`は`null`のとき何も書かない（フィールド自体を省く）ので、主屋根を編集していない文書のバイト列は1バイトも変わらない（読み側は無ければ`restoreGraph`の`clear()`の既定値）。`RS`の読み書きは下屋と共用（`writeRoofSpec`/`readRoofSpec`）。

## 屋根区画（`GS.ROOF_ZONES=56`→`RZ{ID,CELLS,SPEC}`の vector。SPEC は同じ`RS`）は区画があるときだけ書く
最上階の階ごと設定（`PlanGraph.roofZones`。2026-10-30）。区画はユーザーがセルを指定した意図そのものなので **spec は既定値でも書く**（主屋根と逆）。vector は0件のとき省くので区画の無い文書のバイト列は変わらない（13・moku4・moku4-3 の全階で A/B 一致を実測済み）。読み側の正規化は`core/roofZone.js restoreRoofZones`の1か所（不正 id・空セルを捨て、同 id・重なりセルは先勝ち。SPEC が無ければ既定の`RoofSpec`）で、FBS・plain・仕上げ undo（`finishUndo`のキー`roofZones`）が共用する。セルキーは生のまま保存し、線 id の振り直し（`lineIdRemap`）は文字列の全置換なので自動で追従する。

## 姿図の配置（`GS.PLACED_FIGURES=57`→`PF{ID,FIGURE_KEY,X,Y,ROT,MIRROR,Z,NOTE}`の vector）は配置があるときだけ書く
階ごとの実体（`PlanGraph.placedFigures`。2026-11-05。設計は`detail-figure-model.md`「姿図の配置（S10）」）。X・Y・Z・ROT は f64、MIRROR は int8、NOTE は空なら書かない。vector は0件のとき省くので配置の無い文書のバイト列は変わらない。配列順＝FBS 順。読み側の正規化は`core/placedFigure.js restorePlacedFigures`の1か所（不正を捨て同 id 先勝ち）で、FBS・plain・仕上げ undo が共用する。旧ビルドは未知フィールドを無視して読め、保存し直すと配置が消える（`roofZones`と同じ片方向）。

## 敷地の長方形（`SITE.RECTS=5`→`SRCT{ID,X,Y,W,H}`の vector）はSiteテーブルの末尾追加
`Site.rects`（敷地モードの長方形入力。2026-11-07。設計は`data-model.md`「敷地の長方形入力」）。旧データはフィールドが無く空配列として読む。外周は保存せず読込み後に導出する。`SRCT.ROAD_SIDES=5`（int8ビット N=1,E=2,S=4,W=8。`RECT_SIDE_BIT`）は道路指定の辺で末尾追加。旧データ（フィールド無し）は0＝指定なし。snapshot（`serializeSite`/`restoreSite`）にも同じ項目を持つ。

## 敷地の配置（`SITE.PLACEMENT=6`→`SPLC`テーブル）はSiteテーブルの末尾追加
`Site.placement`（敷地の配置図上の配置。2026-11-09。設計は`data-model.md`「敷地の配置図は…」）。`SPLC{ROTATION_DEG:0,TX:1,TY:2,V1X:3,V1Y:4,V2X:5,V2Y:6,CENTER_LINE_ID:7,DISTANCE:8,FLAGS:9}`（float64＋文字列1＋int8）。FLAGSはビット集合（`PLACEMENT_FLAG_BIT`: rotationFlipped=1,sideFlipped=2。readerにboolが無いため`RECT_SIDE_BIT`と同形）。placementがnullなら書かない。旧データ（フィールド無し）は読み側でnull。snapshot（`serializeSite`/`restoreSite`）はdeep copyし、inputの無い壊れたデータはnullとして復元する。
