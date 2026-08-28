import { useEffect, useRef } from 'react';

/**
 * 「選択・展開された行/カードをスクロール領域内へ運ぶ」共通フック。返した ref を対象要素に付ける。
 *
 * 各モードのリストは、キャンバス側の操作（部屋タップ・建具タップ・部材タグタップ）や一覧側の
 * 操作結果（構造の部材分割で追加される新番号のカード）によってプログラム的に選択状態が変わる。
 * このとき対象がスクロール外にあると「反応しなかった」ように見えるため、選択が立った要素を
 * その場で可視域へ寄せる。構造・仕上げ・建具の3モードが共有する。
 * ui/SiteInfoPanel.jsx は同じ意図・同じオプションの scrollIntoView を独自に持つが、あちらは
 * 「パネルに1つのrefを選択中の行だけに付ける」形（行がコンポーネント化されていない）ため
 * 統合していない——このフックは行/カードごとに呼ぶ前提で、SiteInfoPanel を合わせるには
 * 行の分解が要る。同じ挙動を増やす場合はこのフック側に寄せること。
 *
 * block/inline とも 'nearest'：既に見えている要素は動かさず（＝ユーザー操作でその場を展開した
 * ときに画面が跳ねない）、外にあるものだけ最小移動で寄せる。
 *
 * @param {boolean} active 選択・展開されているか（false→true の変化で発火）
 * @param {*} token 同じ要素を選び直したときにも再度寄せたい場合の再発火キー（例: focusRequest。
 *                  参照が変わるたびに発火する。不要なら省略）
 */
export function useScrollIntoViewWhenActive(active, token) {
  const ref = useRef(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, token]);
  return ref;
}
