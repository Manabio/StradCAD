---
name: team-lessons
description: Project-specific lessons learned — failure-catalog entries accumulated via the learning loop. Owned by this project; ccteams never overwrites this file.
---

# Team Lessons (this project)

Durable, project-specific additions to the active team's playbook. ccteams
scaffolded this file once and will never touch it again — it survives team
switches and package updates.

Entries arrive via the learning loop: when a mistake surfaces that the
playbook did not predict, the orchestrator proposes an entry here in the
standard format. Keep it lean — before adding, check whether an existing
entry (here or in the playbook) already covers the case and sharpen that
instead. If a lesson is universal to the stack rather than specific to this
project, contribute it upstream to the team's playbook in the ccteams repo.

## Failure catalog — symptom → wrong instinct → correct move

### 描画レイヤの幾何バグに対する回帰テストがトートロジー化する（2026-08-10 建具バリエーション追加で発生）

- **症状**: レンダラ（`renderer/*.jsx`）のバグ修正に対し、幾何を純モジュールへ抽出して
  テストを追加したが、テストはヘルパを直接呼んで「正しい引数を渡せば正しい結果になる」
  ことだけを確認していた。本番の呼び出し側が正しい引数を渡すかは検証されておらず、
  バグを1文字戻しても全テストが緑のままだった。
- **誤った直感**: 「JSXはテストできない」（→ テスト0本で提出）。および「純関数に
  切り出してテストを書いた＝回帰は防げる」。
- **正しい動き**:
  1. 本リポジトリには角度・座標計算を純モジュールへ抽出して `node:test` で検証する
     確立パターンがある（`openings/openingTagPlacement.js` ⇄ `renderer/OpeningTagLayer.jsx`、
     `renderer/clMoveMath.test.js`）。抽出モジュールは react-konva / store.js / snap.js /
     .jsx を静的に引かないこと。
  2. 抽出の単位は「計算式」ではなく「**呼び出し側が下していた判断**」にする
     （例: どのleafをどの符号で描くか＝`*LeafSpecs` がレンダラの唯一の供給源）。
  3. テストが本番経路を守っているかは、**バグを1文字戻して `npm test` が赤になるか**
     （変異テスト）で必ず確認し、その出力を報告に貼る。緑のままなら、そのテストは
     存在しないのと同じ。レビュー側も変異テストを自分で再実行して合否を判定する。
  4. `openingGeometry.js` のように符号規約がコメントで明文化されている場合
     （`perpDir = (isVertical?1:-1)*swingSide*hingeSide`）、それは新コードが満たすべき
     テスト可能な不変条件として読むこと。

### PowerShell のテキスト置換で UTF-8 ソースの日本語が非可逆破損する（2026-08-19 変異テスト実施中に発生）

- **症状**: 変異テストのために `Get-Content -Raw | -replace | Set-Content` で `floorOps.js` を
  書き換えたところ、日本語コメントが文字化けし、改行まで巻き込まれて構文エラー化した。
  PowerShell 5.1 の `Get-Content` は BOM 無し UTF-8 を ANSI(cp932) として誤読し、
  マルチバイト列が改行バイトを喰う many-to-one 変換のため**逆変換でも復元できない**。
- **誤った直感**: 「ASCII 部分の1語置換だから安全」「壊れても逆のエンコード変換で戻せる」。
  さらに最初の変異ラン赤化を「テストが守っている証拠」と解釈したが、実際は
  ファイル全体の parse エラーによる赤で、検証としても無効だった。
- **正しい動き**:
  1. ソースの機械的書換え（変異注入・復元を含む）は必ず **Edit ツール**で行う。
     PowerShell/シェルのテキスト置換パイプは UTF-8 ソースに対して使用禁止。
  2. 変異テストの赤化確認は「**狙ったテストだけ**が落ちたか」まで見る。テストファイル
     全体の ✖ や件数の減少（例: 722→695）は parse エラーのサインで、検証無効。
  3. 破損に気付いたら即座に `git diff --stat` で被害範囲を特定する。未コミットの
     変更を含むファイルは `git checkout` で戻せないため、HEAD 版の復元
    （`git show HEAD:path > path`）＋把握済み差分の再適用で再構築し、
     差分が想定どおりか（追加のみ・行数一致）とフルテストで検証する。

### 描画ディテールの指示を「関連描画の全面見直し」に拡大解釈する（2026-08-18 展開図の開放スパンで発生）

- **症状**: ユーザーの指示「境界のエッジ縦線が期待と異なる」に対し、builder が指示されていない
  「アキ」マークの全廃まで実施した。ユーザーから「出力は前回の方が良かった。指示以外の処理を
  する前に承認をとって」と差し戻された。
- **誤った直感**: 「期待図に描かれていない要素は消すのが正しい」「同じコードパスの周辺も
  一緒に直すのが親切」。
- **正しい動き**:
  1. 描画ディテールの指示は**列挙された項目のみ**を変更する。期待図に無い要素の削除・
     周辺挙動の変更は「指示以外の処理」であり、実装前にコーディネータ経由でユーザー承認を得る。
  2. 迷ったら「指示された最小差分」と「ついでに直したい候補」を分けて報告し、後者は
     提案に留める（実装しない）。
  3. ユーザー承認済みの描画状態はテストで固定されるため、拡大解釈の変更はテスト書き換えを
     伴う——**承認済み挙動のテストを書き換える必要が生じたら、それは拡大解釈のサイン**。

### 展開図の端の位置を「世界座標のhi/lo」で報告し、図の左右と食い違う（2026-09-10 階段帯Cの上階はり出しで発生）

- **症状**: builder が「hi側（世界座標で東）」と報告した変化を、リードが「右端」とユーザーへ伝えた。
  C面はローカルxが東→西へ走るため図では**左端（X3通り）**で、ユーザーから「なぜ右端なのか」と差し戻された。
- **誤った直感**: 世界座標の大小＝図の左右。
- **正しい動き**: ユーザー向けの位置は必ず**図の座標**（帯内x・面ローカルx・通り芯名）で言う。
  面の `dirSign` が負なら世界の hi 側は図の左。報告に世界座標を書くときは「図では左端（X3）」を併記する。

### 実データに無い構成の描画規則は、合成テストだけで確定させない（2026-09-11 純粋な吹抜け帯のはり出しで発生）

- **症状**: 純粋な吹抜け帯（下階を積む帯）のはり出しの閉じ方を合成テストだけで実装し、
  ユーザーは「状況が読めないので、テストデータを作成してもらって、結果を見てから判断したい」と判断を保留した。
- **誤った直感**: 合成 fixture で緑なら裁定文言どおり。
- **正しい動き**: 実データに構成が無いときは、`loadDoc.mjs` の逆（`serializeGraph`/`serializeStructCLs`/
  `serializePlanes`→`buildDocumentJson`）で**テスト用 .stq を作って実機で見てもらう**。
  往復テスト（既存 .stq を読み→書き→読みで部屋・壁のダイジェスト一致）を先に通すこと。

### 面ローカルで生成した新しいプリミティブ型が帯レベルの変換で無言に置き去りになる（2026-09-14 展開図の建具ドラッグで発生）

- **症状**: `elevation/elevationFigure.js` に新型 `type:'hit'`（建具ドラッグの透明ヒット矩形）を追加したが、
  `elevation/elevationPrimitives.js` の `translatePrimitive`（面ごとの `xCursor` 平行移動）に case が無く
  `default: return p` に落ちて、2面目以降のヒット矩形が面ローカルxのまま帯に置かれた。1面目の空白を
  押すと別面の建具が（別面の dirSign で逆向きに）動く事故。関数コメントが「両関数は同じ型集合を
  扱うこと」と自ら警告していたのに、追加時に読んでいなかった。
- **誤った直感**: 面ローカルの `buildFaceFigure` に対するテスト（座標・属性の一致）で十分と考えた。
  「hit は rect と同形だから既存経路で動く」と型名の追加を忘れた。
- **正しい動き**:
  1. プリミティブ型を追加したら `translatePrimitive` と `mirrorPrimitiveX` の**両方**へ同時に case を
     足し、`elevationPrimitives.test.js` で移動・反転を固定する（同じ型集合の不変条件）。
  2. 面ローカルのテストに加えて、**帯レベル（`buildRoomBand`。`xCursor` が乗る側）**で「同じ建具の
     既存プリミティブ（姿図の枠 rect 等）と同じ位置にある」ことを検証する（`elevationBand.test.js`
     「4面すべての建具で hit 矩形が…」）。複数面を持つ部屋でないと1面目の偶然一致で緑になる。
  3. 新しい型を消費する側（Konva 描画・SVG 出力・境界計算）が `default` で握りつぶす設計のときは、
     「握りつぶされて困る型か」を追加時に一度自問する。

### 実データ検証の probe が実アプリの前処理を省き、機能の発火を両方向に誤判定する（2026-09-17 外壁面固定・帯シフトで発生）

- **症状**: `scripts/probe/dumpPlanRegen.mjs` が `regenerateWalls` の前に走るべき `conformWoodBacking`
  （壁下地材を柱同寸にそろえる）を通していなかったため、moku1.stq の2/3階が「柱寸120＋保存下地材90」
  という実アプリでは起きない状態で測られていた。builder はそこで出た差分を「機能が効いた証拠」と
  報告し（実際は bandShift=0 で何も効いていない）、同時に「梁芯CL・柱が不変」も bandShift=0 の
  空振り比較で報告した。各階柱寸法を明示設定した途端、梁芯CLが 5→7本・柱が 37→39本に増える
  Blocker が出た。過去の golden-regen/moku1 も同じ人工状態で採取されていた。
- **誤った直感**: 「probe は再生成関数を呼んでいるので実アプリと同じ」「既存 .stq を通せば機能の
  検証になる」（既存 .stq は全て各階柱寸法 null＝既定120で、発火条件を満たしていなかった）。
- **正しい動き**:
  1. probe は**境界処理と同じ関数列**（`wallRefresh.js`／`finishBoundary.js` の順序: conform→再生成→
     梁芯追従→構造再計算）を通す。1つでも省くなら「省いた理由と影響」を probe のコメントに書く。
  2. 機能の**発火条件**（今回は各階柱寸法 105/90）は既存データに含まれない前提で、probe 内で
     明示設定してから測る。「差分ゼロ」の報告には「発火条件が成立していた証拠（設定値・shift量）」を
     必ず添える。
  3. golden の mismatch が出たら、まず「ベースコミット＋probe 修正のみ」で同じ mismatch が出るかを
     確かめ、golden 採取時の前処理不足と機能変更を切り分けてから再採取する。
