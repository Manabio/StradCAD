# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面に
描く専用モード。平面・通り芯・寸法は一切出さず、`viewport.scaleX/offsetX`（ズーム）には
一切触れない——独自の固定倍率（`chooseElevationScale`）とスクロール量（`ElevationModeState`）
だけで完結し、平面へ戻ったときに元のビューが保たれることを保証する不変条件。純モジュールは
`app/src/elevation/` に置き、`store.js`/`snap.js`/`*.jsx`/`react-konva`/`appViewport.js`
（DOM依存の`window`参照を持つ）を静的 import しない（node:test 単体実行のため。校正値が
要る箇所はDOM非依存の`viewport.js`から値を取るか、呼び出し側=`App.jsx`が解決して渡す）。

縦横スクロールは**クランプ方式**（循環しない。上端＝先頭帯の最上端が画面上端、下端＝
末尾帯の最下端が画面下端）。**書き込み時にクランプする**こと（`scrollBy`が読み出し側の
`clampedScrollY`だけに頼ると、過剰ドラッグ分が内部状態に見えないスラックとして蓄積し、
逆方向ドラッグがそのぶん効かないデッドゾーンになる。横方向`faceScroll`と同じ規律）。
マウスホイールは縦スクロール（`scrollBy(0, -deltaY/scale)`）に接続する——ドラッグとは
符号が逆（ドラッグはコンテンツを指でつまむ操作、ホイールは視点を動かす操作）。ズームは
展開モードに存在しないため、`usePointerInteraction.js`のホイール分岐は`viewport.zoomAt`を
一切呼ばない。

## A/B/C/D の向きと不変条件
A＝平面の上側（北）を室内から見た面、B=右（東）、C=下（南）、D=左（西）。時計回りに
A→B→C→D。隣接する面同士は同じ物理的な隅を世界座標で共有する（`buildRoomFaces` の
最重要不変条件。テストは `elevationFaces.test.js` I2）。

L字部屋では同じletterが複数面に分かれる（例: B1/B2）。letterでグループ化してから連結すると
L字の隅で世界座標が一致しなくなるため、`buildRoomFaces` は外周を実際に1周する順（隅=軸CLの
一致で次面へ辿るチェーン）で面配列を組み立て、ラベル番号はこの実周回順の出現順に振る。

外周エッジは `computeExternalEdgeParams` の結果を **axisCLIdごとにグループ化してから**
`mergeSegments` する。一括で渡すと「終端CL id＝次の始端CL id」だけで結合判定されるため、
L字の隅で別letterの面同士が誤って1本にマージされる。

## プリミティブ語彙と `tag`/`miterTriangle` の逸脱
既存の「図」プリミティブ語彙を再利用し、`line`/`rect`/`polyline`に`weight`を追加しただけ。
建具記号丸（`tag`）と部屋範囲の留め三角（`miterTriangle`。輪郭線のみ・塗りつぶさない）は
スクリーン固定サイズ（ズーム非依存の見た目サイズ。`renderer/OpeningTagLayer.jsx`と同じ考え方）
が必要なため、mm座標に焼き込まずアンカー点だけを持つ専用プリミティブにし、実際のpx幾何計算は
レンダラ側で校正値（`screenPxPerMm`）を掛けて初めて行う——先にmm換算して焼き込むと、帯の
初期化後にwindowがリサイズされ`scale`が変わったときに見た目サイズが狂う。

## 面の配置・注記は「壁中心線」基準（`faceBoundaryLocalX`）
帯内で面を横に並べる基準・壁芯間寸法は、`face.lo/hi`（壁の室内側仕上げ面）ではなく
`faceBoundaryLocalX`（両端の壁中心線=CLのローカル位置）を使う（本体の壁面線=CUTは従来どおり
仕上げ面基準）。面間ギャップ・部屋名枠の上余白・留め三角のアンカーオフセット（いずれも実画面mm
指定）はどれもモデルmmへ換算するのに倍率(scale)が要り、倍率は帯の高さ（これらに非依存）から
決まるため、`ElevationModeState.init()`は2パス構築で循環参照を避ける（1パス目=仮値で倍率確定、
2パス目=確定した倍率で実値を`screenMmToModelMm`換算）。

水平寸法（壁芯間・通り芯間）は寸法線足を出さない——代わりに壁中心線・通り芯自体の一点鎖線を
寸法線の位置まで下ろし、交点に塗り丸(`dim.dot`)を置く（CH寸法の足は従来どおり残す）。寸法値は
寸法線の**上側**に載せる（`horizontalDimLabelBox`）。床線から下へ①壁芯間寸法②通り芯間寸法
③通り芯丸番号④面ラベル(A/B/C/D等)の順で4段に分ける（同居させない）。天井高寸法（縦dim）の
ラベルだけ寸法線の左側で反時計回り90°回転する（`verticalDimLabelBox`。横方向の寸法は回転しない）。

留め三角は`preBounds`ではなく明示アンカー（左＝天井高寸法線の外側、右＝一番右の壁中心線の外側、
それぞれ実画面10mm）に置く（`appendRoomNameFrame`の`leftX`/`rightX`）。左アンカーは
`band.leftAnchorX`として帯オブジェクトに残し、`ElevationModeState.faceOffsetFor`が
水平スクロール未設定時の既定値として使う——全帯が同じ規則（CH寸法線からの一定オフセット）で
決まるため、この既定値のままなら帯を切り替えても左三角の画面上位置が揃う。

## 帯の縦位置（画面mm空間）の不変条件
`layoutBands` が返す `placement.topMm` は、帯のプリミティブ座標 y=0（床線）ではなく
`band.bounds.minY`（帯の実描画範囲の上端）に対応する（`bandContentOriginMm`）。取り違えると
天井線・壁材ラベルが画面外へはみ出す。

## 天井高さのフォールバック
`finish/roomMetrics.js` の `roomCeilingHeight(graph, room)` が唯一の情報源。数値化できない
自由入力は `graph.defaultCeilingHeight` で作図しつつ、ラベルには原文をそのまま出す。

## 階段帯: 縦2層分の描画範囲・折返し階段の断面
`elevationStair.js` の直上階（吹抜けクリップ）表現は、上階FL線を重ねて引くだけの簡易実装。
直上階グラフの取得（`floorSwapManager.peek`）は純モジュールでは行えないため
`ElevationModeState.init()` が非同期で解決し、`buildStairBand` へ引数で渡す。
描画範囲は「床→設置階の階高→さらに設置階上階の階高」の縦2層分にする（`floorHeightAbove`を
設置階のplaneと直上階のplaneそれぞれに呼ぶ）。上階のそのまた階高が不明（3階分の情報が無い）
ときは1層分（floorHeightまで）にとどめる。

折返し階段（`StairType.SWITCHBACK`）は側面の断面プロファイル（往路・踊り場・復路の
ジグザグ線）を`elevationStairSection.js`が生成する。区間長は`measureStairSpans`
（finish/stair/stairClassify.js。stair-model.mdの「実測優先・合成フォールバック」と同じ規約）
の実測値、往路・復路の段数は`stair.sections`の該当要素（無ければtotalStepsを均等2分と仮定）
を使う——プランビューの階段描画（stairGeometry.js/stairFigure.js）の内部形状は使わず、
測定済みの長さと段数だけを再利用する側面プロファイルの独自生成である点に注意。SWITCHBACK
以外（WINDING等、扇形の段になるタイプ）は対応スコープ外で空配列を返す（defer）。

## 巾木の初期値・解釈
初期値（`木製出幅木`/`h=60`）は**ユーザーがRoomを新規作成する経路でのみ**適用する
（`applyDefaultBaseboard`。呼び出し元は`FinishModeState`の部屋指定確定処理のみ）。
`RoomFinish`コンストラクタでは絶対に設定しない——復元/デシリアライズ経路は「新しいRoomを
作ってから空でないフィールドだけ上書きする」実装のため、コンストラクタ既定値を非空にすると
ユーザーがクリアした`''`が復元のたびに既定値へ巻き戻る（生きたデータ整合性バグ）。
展開側は`parseBaseboardHeightMm`が`"h=<数値>"`表記だけを解釈し、解釈できなければ非描画
（巾木は自由入力欄という既存の性格を壊さない）。床まで達する開口の区間は巾木線を途切れさせる。

## defer（未実装）
傾斜天井の作図・開口の内法寸法線・巾木見切り目地・家具設備電気・屋外部屋・展開図上の編集・
印刷/PDF・SWITCHBACK以外の階段断面（WINDING/L_TURN/FLARED/OPEN_WELL）。
