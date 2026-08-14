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
床線から下へ①建具記号丸(tag)②壁芯間寸法(ROW1)③通り芯間寸法(ROW2)④通り芯丸番号＋面ラベル
(A/B/C/D等、同じ段に統合)の順で段に分ける。通り芯丸は背景色(`CANVAS_BG_COLOR`。index.cssの
`#root`背景色と2箇所手動同期。変更時は両方更新すること)で塗り、一点鎖線より後に描いて線を隠す
（建具記号丸=`tag`は対象外・背景透明のまま）。天井高寸法（縦dim）のラベルだけ寸法線の左側で
反時計回り90°回転する。

**注記帯の各段の位置は全てスクリーンmm基準（QA C1→D1/D2）。** tag(半径16px)・通り芯丸
(半径11px)・面ラベル(13px)はスクリーン固定サイズのため、段位置をモデルmm定数のまま固定すると
縮尺（例: 1/50・1/100）で床線・上下の寸法行に重なる。`OPENING_TAG_ROW_SCREEN_MM`(tag行)・
`DIM_ROW_GAP_SCREEN_MM`(ROW1)・`GRID_ROW_GAP_SCREEN_MM`(ROW1→ROW2、ROW2→丸行の共通ギャップ)
という3つの独立したスクリーンmm定数を他の実画面mm値と同じ2パス機構で換算し、`ctx`経由で
`buildFaceFigure`へ渡す（`openingTagRowModelMm`/`dimRowGapModelMm`/`gridRowGapModelMm`。
未指定時=単体テスト等はそれぞれ`DEFAULT_OPENING_TAG_ROW_MM`/`DEFAULT_DIM_ROW_GAP_MM`/
`DEFAULT_GRID_ROW_GAP_MM`）。**3つは互いに独立**——一方をもう一方の倍数として式で導出する
設計は一度採用したが（QA C1）、値を機械的に押し上げユーザーが調整済みの見た目を踏み外したため
撤回した（QA D2）。値は「不変条件（各段がスクリーン固定要素の半径+余裕ぶん離れる。1/20・1/50・
1/100で検証）を満たす最小限」かつ「旧承認済みの見た目（1/20換算でtag=15px/ROW1=30px/
ROW2=45px/丸行=60px）にできるだけ近い」の両立点として選定した（実測: 新値はtag=30px/
ROW1=60px/ROW2=83px/丸行=106px。旧比おおよそ1.8〜2倍。DEFAULT_PX_PER_MM≈3.78px/mm換算）。
通り芯丸と面ラベルが同じ段になったため、通り芯が面の壁芯間中心付近にあると重なる——
`avoidGridCollisionX`が両者の距離を閾値（`ctx.faceLabelAvoidThresholdModelMm`。他の実画面mm値と
同じ2パスで換算）以下で検出し、退避先を「通り芯＋面境界(boundary.lo/hi)の並びで最も広い区間の
中点」に置く（1回の走査で決定的・再チェック不要。旧実装の一段固定シフトは密な通り芯で別の
通り芯丸に重なり直す不具合があった）。閾値は衝突判定にのみ使い、退避先の座標計算には使わない。

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

## 開口（建具）の展開図表現
展開図の開口は`openings/openingElevationFigure.js`の`buildOpeningElevation`（建具モード編集用
姿図と同一の純関数）を`includeDims:false, includeMotionArrows:false, includeLevelLine:false`で
再利用し、枠・吊元表示・機構表現・レバーハンドルだけ残す（寸法・動作線=矢印・編集用FL基準線は
出さない。両モジュールともFL=y0・上方向が負で座標系が一致するため、開口位置への配置は
`(x, 0)`平行移動だけでよい）。建具記号丸(`tag`)は開口の中心ではなく、姿が見える図の下
（tag行。位置の決め方はスクリーンmm基準——上の「面の配置・注記」節参照）へ描く。

直交壁（隣・次の面）の建具が切断位置（面端）にかかる場合、`openingsReachingCorner`（隣接面自身の
隅=0/runに開口スパンが届いているかで判定。壁センターライン側では開口が届く条件が実質発生しない
ため仕上げ面ベースの隅を使う）で対象を選び、`openingSectionPrimitives`が
[枠(CUT)][扉(SILHOUETTE)][枠(CUT)]の3rectを面の両端の帯（`SECTION_STRIP_MM`幅）に描く
（`buildRoomBand`/`buildStairBand`が`faces[(i∓1+n)%n]`をprevFace/nextFaceとしてctxに渡す）。
壁中心線（面両端の落し線）も通り芯線と同じ`GRID_LINE_ABOVE_CH_MM`ぶん天井線より上まで延ばす。

## 階段帯: 縦2層分の描画範囲・折返し階段の断面
`elevationStair.js`の直上階（吹抜けクリップ）表現は上階FL線を重ねて引くだけの簡易実装。直上階
グラフ（`floorSwapManager.peek`。純モジュールでは行えず`ElevationModeState.init()`が解決）を使い、
描画範囲は「床→設置階の階高→さらに設置階上階の階高」の縦2層分（`floorHeightAbove`を設置階・
直上階のplaneそれぞれに呼ぶ。上階のそのまた階高が不明なら1層分にとどめる）。

折返し階段（`StairType.SWITCHBACK`）は側面の断面プロファイルを`elevationStairSection.js`が生成する
（区間長=`measureStairSpans`、段数=`stair.sections`。プランビューの階段描画は再利用しない独自
生成）。SWITCHBACK以外（WINDING等）はスコープ外で空配列。

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
