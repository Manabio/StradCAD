# 展開モード（室内展開図）設計意図

`appMode==='elevation'`。アクティブ階の各部屋を「1段＝1帯」の固定倍率図として全画面
（描画エリア＋ガター全域）に描く専用モード。平面・通り芯・寸法は一切出さず、
`viewport.scaleX/offsetX`（ズーム）には一切触れない——展開図は独自の固定倍率
（`elevation/elevationLayout.js` の `chooseElevationScale`）と縦横スクロール量
（`ElevationModeState`）だけで完結し、平面へ戻ったときに元のビューが保たれることを
保証するための不変条件。純モジュールは `app/src/elevation/` に置き、
`store.js`/`snap.js`/`*.jsx`/`react-konva` を静的 import しない（node:test 単体実行のため）。

## A/B/C/D の向きと不変条件
A＝平面の上側（北）を室内から見た面、B=右（東）、C=下（南）、D=左（西）。時計回りに
A→B→C→D。各面は `dirSign`（ローカルx+方向が指す世界座標の向き）と `originWorld`
（ローカルx=0の世界座標）を持ち、隣接する面同士は同じ物理的な隅を世界座標で共有する
（`buildRoomFaces` の最重要不変条件。テストは `elevationFaces.test.js` I2）。

L字部屋では同じletterが複数面に分かれる（例: B1/B2）。これは矩形の1角を欠くと
必ず隣接する2方向（例: 北と東）がそれぞれ2分割され、実際の外周を歩くと
A→B→A→B→C→D のように**letterが交互に現れる**ため——`buildRoomFaces` はletterで
グループ化してから連結するのではなく、外周を実際に1周する順（隅=軸CLの一致で次面へ
辿るチェーン）で面配列を組み立て、ラベル番号（B1/B2）はこの実周回順の出現順に振る。
letterでグループ化して連結すると、L字の隅で隣接面が世界座標で一致しなくなる
（過去の実装ミスとその修正過程は `elevationFaces.js` のコメント参照）。

外周エッジは `computeExternalEdgeParams` の結果を **axisCLIdごとにグループ化してから**
`mergeSegments` する（`wallGeneration.js` の各生成関数と同じ手順）。グループ化せず
全エッジを一括で渡すと、`mergeSegments` が「終端CL id＝次の始端CL id」だけで結合判定する
ため、L字の隅で別letterの面同士が誤って1本にマージされる。

## プリミティブ語彙と `tag` の逸脱
既存の「図」プリミティブ語彙（`structural/sectionFigure/sectionGeometry.js`）を再利用し、
`line`/`rect`/`polyline` に任意の `weight`（`thick`/`medium`/`thin`）を追加しただけ。
唯一の逸脱は建具記号丸で、設計では circle+line+text×2 の4プリミティブ分解だったが、
実装では `tag`（円+直径線+上下2段テキストの合成）という1プリミティブにした——記号丸は
`rPx`（スクリーン固定px、ズーム非依存の見た目サイズ。`renderer/OpeningTagLayer.jsx` と
同じ考え方）を使うため、線・テキストをmm座標のまま分解すると帯ごとに異なる倍率のもとで
見た目サイズが一定にならない。`renderer/figurePrimitivesKonva.jsx` だけが解釈する
（`AutoScaledFigure.jsx` は使わないため無視で問題ない）。

## 帯の縦位置（画面mm空間）の不変条件
`layoutBands` が返す `placement.topMm` は、帯のプリミティブ座標 y=0（床線）ではなく
`band.bounds.minY`（帯の実描画範囲の上端）に対応する（`bandContentOriginMm`。唯一の消費者は
`ElevationLayer.jsx`）。ここを取り違えると天井線・壁材ラベルが画面外へはみ出す。

## 天井高さのフォールバック
`finish/roomMetrics.js` の `roomCeilingHeight(graph, room)` が唯一の情報源。
自由入力（傾斜天井のレンジ表記等）が数値化できないときは `graph.defaultCeilingHeight`
で作図しつつ、ラベルには原文をそのまま出す。`finish/kneeDropWall.js` の
`effectiveCeilingHeight` もこれに移行済み（`finish/FinishTable.jsx` の同型フォールバックは
未移行——公開UIの表示崩れリスクがあるため今回のスコープ外）。

## 階段2層帯の簡略化
`elevation/elevationStair.js` の直上階（吹抜けクリップ）表現は、上階FL線を重ねて引くだけの
簡易実装にとどめている（複雑階段の上層クリップ精度はセル粒度で可、という合意の範囲内）。
直上階グラフの取得（`floorSwapManager.peek`）は純モジュールでは行えないため
`ElevationModeState.init()` が非同期で解決し、`buildStairBand` へ引数で渡す構成にした。

## defer（未実装）
傾斜天井の作図・開口の内法寸法線・巾木見切り目地・家具設備電気・屋外部屋・展開図上の編集・
印刷/PDF。
