# Shorts除外の調査

- 調査日: 2026-10-29
- 対象: 他人の登録チャンネルの公開動画を、YouTube Data API v3の公開仕様で分類できるか

## 結論

今回確認した公式APIリファレンスには、動画がShortsかどうかを返す公開フィールドや、Shortsだけを除外する検索条件は見当たらない。
そのため、現在の公開APIの範囲では、通常の短い動画を残しながらShortsだけを正確に除外できるとは判断できない。
試作では再生時間3分以下の除外を初期値として維持し、分単位の閾値とオン・オフを設定可能にする。

これは公式仕様を確認した上での実装上の判断であり、APIに将来も機能が追加されないという断定ではない。

## 確認した内容

### 動画リソース

[YouTube Data API: Videos](https://developers.google.com/youtube/data/reference/rest/v3/videos) の公開プロパティ一覧に、`isShort` のようなShorts判定項目は確認できない。
`contentDetails.duration` は長さを表すため、時間による近似的な除外に利用できる。

`fileDetails.videoStreams` に幅・高さ・アスペクト比はあるが、`fileDetails` は動画所有者だけが取得できる。
本人の登録チャンネルだからといって、その投稿動画の所有者権限を持つわけではない。
また、サムネイル画像の幅・高さは動画本体の縦横比とは異なるため、Shorts判定の根拠にしない。

### 検索条件

[YouTube Data API: Search.list](https://developers.google.com/youtube/data/reference/rest/v3/search/list) の `videoDuration=short` は「4分未満」を意味し、YouTube Shortsという形式を指定する条件ではない。
`videoDimension` も2D/3Dの条件であり、縦動画・横動画の区別ではない。
この目的のためにチャンネルごとの `search.list` 呼び出しへ切り替えない。

### YouTube側の分類

[YouTube公式ヘルプ: 3分間のShorts](https://support.google.com/youtube/answer/15424877?hl=en) では、通常チャンネルについて、2024-10-15以降の正方形または縦長で3分以下の投稿をShortsに分類すると説明されている。
公式アーティストチャンネルには別の日付条件もある。
長さだけでは正確な形式判定にならないことが分かる。

## 採用する仕様

- 設定名は「短い動画の除外」とし、Shortsだけを見分ける機能だと誤認させない。
- 初期値はオン・3分以下。通常の短い動画も除外されると表示する。
- UIは分単位。既存データを保つため、内部の閾値は秒単位のまま保存する。
- 動画単位の非表示機能も引き続き利用できる。
- タイトルの `#Shorts` の有無だけによる確定判定、画像からの断定、非公開APIやYouTubeページの解析には依存しない。
- Google認証・実際の登録チャンネル取得は未実装のため、今回の調査結果は公式公開資料に基づく。実APIでの実データ照合は行っていない。
