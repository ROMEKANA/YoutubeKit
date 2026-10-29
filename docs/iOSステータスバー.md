# iOSのステータスバー指定

調査・変更日: 2026-10-29 / v1.0.4

## 調査結果

- Appleのアーカイブ資料では、`apple-mobile-web-app-status-bar-style` はホーム画面のWebアプリ向けで、`apple-mobile-web-app-capable=yes` が前提。`black` は黒背景、`black-translucent` はコンテンツがステータスバーの背後まで広がる指定として説明されている。通常のSafariへ同じ効果を保証するものではない。
- Safari 15の公式発表には `theme-color` による着色がある。ただし、その説明だけから現在のiOSの全環境で動作すると判断することはできない。
- WebKitの不具合管理には、iOS 26系でホーム画面版のステータスバー領域やページ上端の色参照が変化する報告がある。これらは不具合報告であり、全バージョンの確定仕様や、この端末の原因を証明する情報ではない。
- したがって、メタタグだけで確実に黒へ変更できるとは結論付けない。PWAの再起動・インストール状態・iOSのバージョンによっても確認が必要。

## 今回の変更

- 初期HTMLで `black-translucent`、`theme-color=#000000` を指定する。
- HTML・body・Manifestの起動背景を黒にし、アプリ本体は従来の明るい背景を保つ。
- ヘッダー上端のsafe-area領域も黒く描画する。メタタグだけに依存せず、背後の実際の色を揃える。
- `safe-area-inset-top` が0になる環境やOS側が別の色を選ぶ不具合まで、Web側で完全に制御できる保証はない。iPhoneの表示成功は実機未確認。
- v1.0.2・1.0.3の作業では公開配備を行っていなかった。今回はv1.0.4を実際に公開するため、旧版を見ていた可能性も切り分ける必要がある。

## 公式資料・一次情報

- [Apple: Supported Meta Tags（アーカイブ）](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html)
- [WebKit: New WebKit Features in Safari 15](https://webkit.org/blog/11989/new-webkit-features-in-safari-15/)
- [WebKit Bug 301994: iOS 26.1のホーム画面Webアプリのステータスバー報告](https://bugs.webkit.org/show_bug.cgi?id=301994)
- [WebKit Bug 305546: 背景色参照の変化とtheme-colorが効かない報告](https://bugs.webkit.org/show_bug.cgi?id=305546)
