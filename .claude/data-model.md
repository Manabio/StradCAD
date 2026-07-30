# データモデルの設計意図

クラス・フィールドの一覧は`core.js`を読めば分かるため省略する。ここには横断的な設計判断のみ記す。用語は`.claude/glossary.md`参照。

## CLが座標の源泉
Intersection・Shape・Wall・Opening・構造部材はすべて自前の座標を持たず、参照するCLの`effectiveValue`から導出する。CLを動かすと連鎖的に全図形が追従する。

## pendingDelta遅延評価とbake
ドラッグ中は`pendingDelta`(CL)/`pendingDX,DY`(Point)のみ更新し`value`は変えない。**reaction（chamferWalls等）は`effectiveValue`ではなく`value`を直接監視すること**——`effectiveValue`を監視するとドラッグ中の毎フレームで誤発火する。確定時`bakeCLValue`で`value`に書き込み`pendingDelta`を0に戻す。SpatialIndexもbake後（`value`変化時）にのみ自動再構築される。

## CL移動範囲は型非依存の随伴図形BFSで決定する（transform/followerGraph.js）
「movingCLと一体で動く図形」を`ANCHOR_RESOLVERS`（型ごとのルール）で不動点反復し収集する。新しい型（給排水・構造等）を随伴対象に加える場合はここに1エントリ追加するだけでよい。随伴連鎖が`MAX_DEPTH`(3)/`MAX_COUNT`(30)を超えると移動自体を開始させない——パフォーマンス上の限界ではなく「ユーザーが一目で確認できる範囲」という目安値。
通り芯（全フロア共有）の移動時のみ`FloorSwapManager.peek`で非アクティブな他フロアをIDBから読み取り専用の使い捨てグラフへ復元し、随伴BFS・障害物探査の対象に含める。center/auxのCLはフロア固有で他フロアから参照され得ないため対象外。

## Wallは自前のオフセットを持ち、ngraphに参加しない
軸CLからのオフセットで位置を持つ（shapeMapのみで管理）。`isRoomWall`の壁はchamferWallsの対象外（生成時のコーナーマップによるオフセットを固定値として保持）。

## 内周壁は仕上げ脱出境界で全削除・導出再生成する（下地オーナー壁＋仕上げ薄壁方式）
内周壁（`isRoomWall`かつ非外壁）は「部屋指定・内装・偏芯からの導出物」であり、壁自体に前回の解決結果を持ち越さない。`runFinishExitBoundary`は脱出のたびに全削除→部屋ごとに再生成する（順序非依存・冪等。2a=階段下部屋の壁のみ例外、下記）。同一CL上の下地（間柱帯）はスパン単位でオーナー1本だけを持つ——生成直後は軸オフセットの符号（＋側優先）、外周CLでは外壁がオーナーになる（`finish/wallGeneration.js`の`resolveBackingOwnership`/`applyBackingOwnership`）。オーナー以外は`backingDepth=0`の仕上げ薄壁として面ごとに独立描画される。階段ペアRoom（`feature=STAIR`）・階段吹抜け（`STAIR_VOID`）も通常のRoomと同じ経路で壁を持つ。階段下部屋（破れ線先セルに部屋指定された領域。通称「2a」）だけは例外——`generateStairUnderWalls`固有の偏芯式で一度生成したら不変・専用トリムを持つ別管理の壁のため、全削除・所有権解決・CL偏芯（`clEccentricity.js`）のいずれの対象にもならない。ただし2aの外周エッジのうち向こう側がユーザー指定の通常部屋（吹抜けVOID含む）で階段footprint境界上にあるものは、同一CL上に下地が2重にならないよう2a側では生成・claimせず通常の所有権解決（`resolveBackingOwnership`）へ委譲する（`isDelegatedEdge`。footprint外の区間は対をなす階段ペアRoom壁が無く2a側面が下地むき出しになるため委譲しない）。

## CL偏芯（clEccentricities）はレコードと導出結果を分離する
`PlanGraph.clEccentricities`（clId→`{mode:'value'|'face', value, side, backing}`）は「何を指定したか」だけを保持し、Wall側（axisOffset/wallFinish/backingOffset/backingDepth/finishSide）へは`finish/clEccentricity.js`の`applyCLEccentricity`が導出した結果のみを書き込む——値を直接Wallへ書くと下地材変更時に再計算できず不整合が固定化する。`backing=''`は「per-floor既定（`interiorWallBacking`）に従う」という明示的なフォールバック合図であり、未指定と同義に扱わない。適用点は操作確定時とモード境界（`runFinishExitBoundary`ステップ2b）の両方で、前回の適用結果に依存せず現在のspecと現材から毎回フル再計算する（冪等）——材未ロード・下地コード未解決時は黙って既定値へ潰さず適用自体をスキップする。

## CL偏芯は階段・吹抜けに面するCLで階をまたいで連動する
階段に面する壁の偏芯は設置階〜最上階、吹抜け（`feature=VOID`）に面する壁の偏芯はその階と直下階の間で共通にする（`finish/eccentricityFloorSync.js`の`propagateCLEccentricities`）。連動先はグラフの現在状態（隣接Roomのfeature）から呼び出しのたびに導出し保存しない——階段吹抜けへの転用や吹抜けの追加・削除で対象は自動的に変わる。方式は`stairFloorSync.js`と同じレコード複製パターン（peek→set/removeCLEccentricity→applyCLEccentricity→saveFloor）に乗り、CL対応付け（`finish/floorCLMap.js`の`translateCLId`。stairFloorSync.jsと共用）が解決できない階は安全側でスキップする（CLを勝手に追加しない）。階段の描画幅（`stairGeometry.js`の`insetStairBounds`）・吹抜けの×（`finish/voidGeometry.js`）は`finish/wallFaces.js`の`faceRect`で実壁面を都度解決するため、偏芯変更後の再描画で自動的に取り合う。編集直後の連動（`handleEccConfirm`）はundoエントリへ合成するが、モード境界（仕上げモード突入時の`pullCLEccentricities`・脱出時の`runFinishExitBoundary`ステップ4c）が行う自動再伝播はundo対象外。ステップ4bが内壁指定消失を理由にレコードを削除した場合、その削除自体は連動先へ伝播しないため、連動先に孤児レコードが残り、その階が次回仕上げモードを脱出する際にステップ4c（push）で連動先へ再伝播され、消したはずの偏芯指定が復活しうる（既知の限界。4bの条件は緩めない設計判断）。

## OpeningはWallを直接参照しない
外壁・部屋境界壁は仕上げモード往復のたびに全削除→再生成されるため、Wall参照を持つと迷子になる。Wallと同じ「CL+オフセット」の自己完結アンカーを持ち、表示時に`findHostWall`で都度再発見する。壁ギャップ判定（`findOpeningsOnWall`）はホスト解決と異なり`wallSide`の符号を無視する——部屋境界には符号違いの壁が複数本生成されるため。実記号描画は`IMPLEMENTED_MECHANISMS`（SWING/SLIDE_DOUBLE）のみ実装、新規機構追加時はそこに追加した上で`OpeningsLayer.jsx`に描画関数を追加する。

## Edge・boundaryMasterは判定ロジックをEdge自体に持たせない
境界の分類・選定は`finish/edgeClassify.js`の純関数に置く。Edgeはキャッシュ(`masterType`)と個別上書き(`overrides`)のみ持つ。

## Roomの内外区分は kind × feature の2軸（旧voidは読込時移行）
`kind`（屋内/屋外）と`feature`（階段/吹抜け/なし）は独立。外壁・footprint等の内外判定は**kind軸のみ**を見る（featureを混ぜない）。旧データの`kind='void'`は読込時に「屋内+吹抜け」へ移行するが、デコード経路はFlatBuffers・plain object・undoスナップショットの**3系統**あり、移行を1箇所に足しても他が漏れる——変更時は3経路すべてを揃えること。

## 階段はRoomを残したままStairと相互リンクする
階段化でRoomを消すと外壁生成（graph.rooms走査）から階段エリアが消えるため、`feature=STAIR`のRoomを保持し`Stair.roomId`でリンクする。不変条件: 削除は必ず双方向道連れ（片側だけ消すと孤児化）、階段Roomは部屋再解釈（roomReinterpret）の対象外（吸収されるとリンクが壊れる）、内周壁生成・仕上げ表内部タブ・キャンバス部屋塗りからは除外する。roomIdなしのStair（旧データ）は上階自動設置（syncUpperFloors）・仕上げモード突入時にRoomを自動補完する（ensureStairRooms）。補完できないのはフットプリントが既存Roomと重なる場合のみで、そのときはRoomなしで動く互換経路に残る（既に「屋内」なので外壁判定に実害なし）。

## 最上階の屋内階段footprintは階段吹抜け（feature=STAIR_VOID）で表す
最上階には階段実体を置かない（階段は次階への到達手段）が、footprintを「屋内」として外壁生成・境界分類に参加させる必要があるため、自動管理Room（`feature=STAIR_VOID`・無名・kind=INTERIOR）を自動指定する（syncUpperFloors／仕上げモード突入時のensureTopStairVoid。屋外階段は対象外）。ユーザー指定の吹抜け（`feature=VOID`）とは描画・操作の扱いが異なる: STAIR_VOIDは塗り・仕上げ表・部屋ドラッグ・内周壁・部屋再解釈のすべてから除外し、一切描画しない。階追加で旧最上階が中間階になると、階段吹抜けはそのままペアRoomへ転用される（ensureStairRoomsのfootprint一致判定。転用できない残骸は同期時に削除）。自動同期による指定・転用・削除はいずれもundo対象外。

## floorDatum/floorLevel・templateKey/customOverridesは「共有基準＋疎な例外」
床レベルは階のfloorDatumを基準に逸脱する部屋のみfloorLevelを持つ。壁材・壁仕上げ・天井高さは内装マスター（templateKey）参照+個別上書き（customOverrides、マスタ値と同値なら自動的に空に戻す）。同じパターンを`PlanGraph.structureOverride`（主構造の階例外）でも使う。

## CL端点の「端点ルール」（交点を失った端は固定・はねだし）
中心線の端は通常、直交CLとの交点上に乗る（延長・短縮も交点間で動く）。線分編集で交点が失われた端（参照先CL削除・直交CLの短縮）は「端点」となり、(1)座標をその場に固定（削除時は`detachFromCenterLine`がextent参照を静的化）、(2)延長・短縮の対象外（`isEndpointAt`で導出判定。保存フラグは持たない——直交CLの短縮による端点化は参照が生きたまま起きるため、状態保存では追従できない）、(3)壁は端点ノードに壁があったと想定した分（下地偏芯量＋仕上げ厚＝`|axisOffset|`）だけはね出して止める。壁側の適用は3経路：CL削除時の既存壁の端繰り上げ（core.js）、壁生成時の軸CL線分範囲クリップ（wallGeneration.js。交点消失後もセル分割は列全体を割り続けるため、生成セグメントが線分範囲を越え得る）、詳細LODの木口2重線（ShapesLayer.jsx）。補助線は静的端点（オーバーハング付き）が正規状態のため端点ルールの対象外。

## SiteLine.redPointIdは生成時に1度だけ決定する
画面表示用の赤/青端点をviewport基準で都度再計算するとパン/ズームで入れ替わるため、線分生成時に固定し以後再計算しない。

## 近傍検出の優先順位は「画面距離が最も近い1件」で解決する
交点・CL・開口・壁の近傍判定（8px圏内）は固定優先順位にすると常に同じ種別が勝つ（部屋の壁は軸CLから近いため）。`App.jsx updateSnap`が3者を独立に検出した上で画面距離が最も近い1件を選び、残りをnullにしてから`detectContext`に渡す。交点のみ常に最優先。

## 線の太さは2系統の変換方法を意図的に残している
`LINE_WEIGHT_MM`という1つのmm定義から、実体を伴う図形は`resolveStrokeWidth`（ズーム追従）、画面注記（通り芯・寸法線等）は`viewport.lineWeightsPx`（校正値ベース固定px）の2方法でpx化する。対象の性質（ズームで太さが変わるべきか）で決まる正しい設計のため統合しない。
