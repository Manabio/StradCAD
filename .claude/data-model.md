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

## OpeningはWallを直接参照しない
外壁・部屋境界壁は仕上げモード往復のたびに全削除→再生成されるため、Wall参照を持つと迷子になる。Wallと同じ「CL+オフセット」の自己完結アンカーを持ち、表示時に`findHostWall`で都度再発見する。壁ギャップ判定（`findOpeningsOnWall`）はホスト解決と異なり`wallSide`の符号を無視する——部屋境界には符号違いの壁が複数本生成されるため。実記号描画は`IMPLEMENTED_MECHANISMS`（SWING/SLIDE_DOUBLE）のみ実装、新規機構追加時はそこに追加した上で`OpeningsLayer.jsx`に描画関数を追加する。

## Edge・boundaryMasterは判定ロジックをEdge自体に持たせない
境界の分類・選定は`finish/edgeClassify.js`の純関数に置く。Edgeはキャッシュ(`masterType`)と個別上書き(`overrides`)のみ持つ。

## floorDatum/floorLevel・templateKey/customOverridesは「共有基準＋疎な例外」
床レベルは階のfloorDatumを基準に逸脱する部屋のみfloorLevelを持つ。壁材・壁仕上げ・天井高さは内装マスター（templateKey）参照+個別上書き（customOverrides、マスタ値と同値なら自動的に空に戻す）。同じパターンを`PlanGraph.structureOverride`（主構造の階例外）でも使う。

## SiteLine.redPointIdは生成時に1度だけ決定する
画面表示用の赤/青端点をviewport基準で都度再計算するとパン/ズームで入れ替わるため、線分生成時に固定し以後再計算しない。

## 近傍検出の優先順位は「画面距離が最も近い1件」で解決する
交点・CL・開口・壁の近傍判定（8px圏内）は固定優先順位にすると常に同じ種別が勝つ（部屋の壁は軸CLから近いため）。`App.jsx updateSnap`が3者を独立に検出した上で画面距離が最も近い1件を選び、残りをnullにしてから`detectContext`に渡す。交点のみ常に最優先。

## 線の太さは2系統の変換方法を意図的に残している
`LINE_WEIGHT_MM`という1つのmm定義から、実体を伴う図形は`resolveStrokeWidth`（ズーム追従）、画面注記（通り芯・寸法線等）は`viewport.lineWeightsPx`（校正値ベース固定px）の2方法でpx化する。対象の性質（ズームで太さが変わるべきか）で決まる正しい設計のため統合しない。
