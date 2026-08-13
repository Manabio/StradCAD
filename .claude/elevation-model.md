# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面に
描く専用モード。平面・通り芯・寸法は一切出さず、`viewport.scaleX/offsetX`（ズーム）には
一切触れない——独自の固定倍率（`chooseElevationScale`）とスクロール量（`ElevationModeState`）
だけで完結し、平面へ戻ったときに元のビューが保たれる不変条件。純モジュールは
`app/src/elevation/` に置き、`store.js`/`snap.js`/`*.jsx`/`react-konva`/`appViewport.js`
（DOM依存）を静的 import しない（node:test 単体実行のため。校正値は`viewport.js`から値を
取るか、呼び出し側=`App.jsx`が解決して渡す）。

縦横スクロールは**クランプ方式**（循環しない・画面に収まる帯はminXへクランプし中央寄せしない
——全帯を左三角の位置で揃えるため）で、**書き込み時にクランプする**（読み出し側だけでクランプ
すると過剰ドラッグ分がスラックとして蓄積し、デッドゾーンになる）。マウスホイールは
`scrollBy(0, -deltaY/scale)`で縦スクロールに接続する（ズームは呼ばない）。

## A/B/C/D の向きと不変条件
A＝平面の上側（北）を室内から見た面、B=右（東）、C=下（南）、D=左（西）。時計回りに
A→B→C→D。隣接する面同士は同じ物理的な隅を世界座標で共有する（`buildRoomFaces`の最重要
不変条件）。L字部屋は同じletterが複数面に分かれる（例: B1/B2）——letterでグループ化して
から連結するとL字の隅で世界座標が一致しなくなるため、外周を実際に1周する順（隅=軸CLの
一致で次面へ辿るチェーン）で面配列を組み立て、ラベル番号はこの実周回順の出現順に振る。
外周エッジは`computeExternalEdgeParams`の結果を**axisCLIdごとにグループ化してから**
`mergeSegments`する（一括で渡すとL字の隅で別letterの面同士が誤って1本にマージされる）。

## プリミティブ語彙と `tag`/`miterTriangle`
既存の「図」プリミティブ語彙に`weight`を追加しただけ。建具記号丸（`tag`）と部屋範囲の
留め三角（`miterTriangle`。輪郭線のみ・塗りつぶさない）はスクリーン固定サイズが必要なため、
mm座標に焼き込まずアンカー点だけを持つ専用プリミティブにし、実際のpx幾何計算はレンダラ側で
校正値（`screenPxPerMm`）を掛けて行う——先に焼き込むとwindowリサイズで`scale`が変わったとき
見た目サイズが狂う。留め三角のアンカー（左＝天井高寸法線の外側、右＝一番右の壁中心線の外側、
それぞれ実画面10mm）は例外的にモデルmmへ2パス変換で焼き込む（`leftAnchorX`/`rightAnchorX`。
アンカー位置自体はレイアウト量＝面の配置に効くため）。`band.leftAnchorX`は
`ElevationModeState.faceOffsetFor`の水平スクロール既定値にも使い、全帯の左三角の画面位置を揃える。

## 面の配置・注記は「壁中心線」基準（`faceBoundaryLocalX`）
帯内の面配置・壁芯間寸法は`face.lo/hi`（仕上げ面）ではなく`faceBoundaryLocalX`（壁中心線）を
使う（本体の壁面線=CUTは仕上げ面基準のまま）。面間ギャップ・部屋名枠の上余白・留め三角の
アンカーオフセット（すべて実画面mm指定）は倍率(scale)換算が要り、倍率は帯の高さ（これらに
非依存）から決まるため、`ElevationModeState.init()`は2パス構築で循環参照を避ける（1パス目=
仮値で倍率確定、2パス目=`screenMmToModelMm`で実値換算）。

水平寸法（壁芯間・通り芯間）は寸法線足を出さず、壁中心線・通り芯自体の一点鎖線を寸法線位置
まで下ろして交点に塗り丸(`dim.dot`)を置く（CH寸法の足のみ従来どおり残す）。寸法値は寸法線の
**上側**に載せる。通り芯の一点鎖線は天井線より上へも少し突き出す（`GRID_LINE_ABOVE_CH_MM`）。
床線から下へ①壁芯間寸法②通り芯間寸法③通り芯丸番号＋面ラベル(A/B/C/D等、同じ段に統合)の順で
3段に分ける。通り芯丸は背景色(`CANVAS_BG_COLOR`。index.cssの`#root`背景色と2箇所手動同期。
変更時は両方更新すること)で塗り、一点鎖線より後に描いて線を隠す（建具記号丸=`tag`は対象外・
背景透明のまま）。天井高寸法（縦dim）のラベルだけ寸法線の左側で反時計回り90°回転する。
通り芯丸と面ラベルが同じ段になったため、通り芯が面の壁芯間中心付近にあると重なる——
`avoidGridCollisionX`（buildFaceFigure内）が両者の距離を閾値（`ctx.faceLabelAvoidThresholdModelMm`。
`FACE_LABEL_AVOID_THRESHOLD_SCREEN_MM`から他の実画面mm値と同じ2パスで換算。未指定時は
`DEFAULT_FACE_LABEL_AVOID_THRESHOLD_MM`）以下で検出し、退避先を「通り芯＋面境界(boundary.lo/hi)
を昇順に並べたときの最も広い区間の中点」に置く——1回の走査で決定的に決まり、再チェック不要
（旧実装は衝突時に閾値の2倍ぶん一段だけ固定シフトしていたが、910mm等間隔グリッド等の密な
通り芯では退避後に別の通り芯丸へ重なり直す不具合があった）。閾値自体は「動かすか否か」の
衝突判定にのみ使い、退避先の座標計算には使わない。

帯の描画範囲の上端には`BAND_TOP_MARGIN_MM`ぶんの余白を確保する（`bounds.minY`をさらに
上へ広げるだけ）。`layoutBands`が返す`placement.topMm`はこの`band.bounds.minY`（帯の実描画
範囲の上端）に対応する（`bandContentOriginMm`）——取り違えると天井線がはみ出す。

## FL高さ（floorOffset）: bounds は floorOffset=0 のときの描画範囲
`Room.floorLevel`由来の`floorOffset`（`effectiveFloorLevel-floorDatum`）は帯内の全プリミティブを
y方向へ平行移動するが、**bounds（`minY`/`height`）は floorOffset 適用前＝floorOffset=0 のときの
描画範囲を表す**——シフト後の座標から計算すると、帯スロットの上端を帯自身の`bounds.minY`へ
再アンカーする仕組み（`bandContentOriginMm`）が一様シフトを常に打ち消してしまい、floorOffsetが
床線の見た目位置に一切効かなくなる（過去に発覚した不具合。elevationBand.js/elevationStair.js共通）。
つまりfloorOffset分のシフトは意図的に`bounds`の外側で起きる。

そのぶん、隣接帯との実際のすき間はfloorOffset差だけ縮む（最悪`BAND_GAP_MM`を超えて重なりうる）。
`bounds`自体はfloorOffset非依存のまま動かせないため、積み上げ専用の`heightMm`（この帯が下へ
せり出しても次の帯へ食い込まない）と`topMarginMm`（この帯が上へせり出しても手前の帯に食い込
まれない。`layoutBands`が「この帯を置く直前に追加で空ける量」として消費する）で対処する——
`bounds.minY`を直接広げる方式は上記の打ち消し問題が再発するため使えない。
両方向は互いに排他（floorOffsetの符号でどちらか一方にしか実際にはせり出さない）ため、
`heightMm`には`Math.max(0, -floorOffset)`（下へせり出す量）、`topMarginMm`には
`Math.max(0, floorOffset)`（上へせり出す量）をそれぞれ加える——両方に一律`Math.abs(floorOffset)`
を加えると、使わない側の方向が過剰予約になり実すき間が無駄に広がる（例: floorOffsetが負でも
topMarginMmを積むと、上には全くせり出していないのに手前の帯との間隔だけ無駄に広がる）。
段差高さ自体の寸法線は描かない。

## 天井高さのフォールバック
`finish/roomMetrics.js`の`roomCeilingHeight(graph, room)`が唯一の情報源。数値化できない自由入力は
`graph.defaultCeilingHeight`で作図しつつ、ラベルには原文をそのまま出す。

## 階段帯: 縦2層分の描画範囲・折返し階段の断面
`elevationStair.js`の直上階（吹抜けクリップ）表現は上階FL線を重ねて引くだけの簡易実装。
直上階グラフの取得（`floorSwapManager.peek`）は純モジュールでは行えないため
`ElevationModeState.init()`が非同期で解決し引数で渡す。描画範囲は「床→設置階の階高→さらに
設置階上階の階高」の縦2層分（`floorHeightAbove`を設置階・直上階のplaneそれぞれに呼ぶ。
上階のそのまた階高が不明なら1層分にとどめる）。

折返し階段（`StairType.SWITCHBACK`）は側面の断面プロファイルを`elevationStairSection.js`が
生成する。区間長は`measureStairSpans`（finish/stair/stairClassify.js。実測優先・合成フォール
バックはstair-model.mdと同じ規約）、往路・復路の段数は`stair.sections`の該当要素（無ければ
totalStepsを均等2分と仮定）——プランビューの階段描画の内部形状は再利用せず、測定済みの長さと
段数だけを使う独自生成である点に注意。SWITCHBACK以外（WINDING等）はスコープ外で空配列。

## 巾木の初期値・解釈
初期値（`木製出幅木`/`h=60`）は**ユーザーがRoomを新規作成する経路でのみ**適用する
（`applyDefaultBaseboard`。呼び出し元はFinishModeStateの部屋指定確定処理のみ）。
`RoomFinish`コンストラクタでは設定しない——復元経路は「新しいRoomを作ってから空でない
フィールドだけ上書きする」実装のため、コンストラクタ既定値を非空にするとユーザーがクリア
した`''`が復元のたびに巻き戻る。展開側は`parseBaseboardHeightMm`が`"h=<数値>"`表記だけを
解釈し、解釈できなければ非描画。床まで達する開口の区間は巾木線を途切れさせる。

## defer（未実装）
傾斜天井の作図・開口の内法寸法線・巾木見切り目地・家具設備電気・屋外部屋・展開図上の編集・
印刷/PDF・SWITCHBACK以外の階段断面（WINDING/L_TURN/FLARED/OPEN_WELL）。
