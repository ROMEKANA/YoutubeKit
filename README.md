# YoutubeKit

観たい動画を選び、選んだ分だけ再生する、個人用YouTubeキューアプリです。

**v1.0.0** / [公開アプリ](https://youtube-kit.tokana2212.workers.dev/) / [スマホでの使い方](docs/スマホでの使い方.md)

登録チャンネルの動画からキューを作り、最後の動画で再生を終了します。PCを閉じても公開アプリを使用できます。動画の取得・再生にはインターネット接続が必要です。

## 使い方

1. Safari・Chrome・Edgeなどの通常のブラウザで開き、自分のGoogleアカウントに接続します。
2. 右上の更新で、登録チャンネルと動画を取得します。
3. サムネイルをタップしてキューへ追加します。数字が再生順で、再タップすると削除します。
4. 下の再生キュー、または横長画面のキュー枠を押して並べ替え・削除します。
5. 「再生開始」で選んだ動画を連続再生し、最後で終了します。保存キューは再生後も残ります。

- 再生開始の左にあるごみ箱は、キューの全削除です。確認でキャンセルできます。
- タイトル側を押すと非表示・復元などのメニューを開きます。目のアイコンで非表示動画も表示できます。
- 設定で表示密度、表示件数、短い動画の除外分数を変更できます。初期値は3分以下を除外します。Shortsだけを正確に判別する機能ではありません。
- シアターモードは更新と目の間のアイコンで即座に開始します。明るさは設定で1〜100%から選択でき、再生中も設定を開けます。通常タップをガードし、トリプルタップで一時停止、3秒長押しで解除します。
- シアターの明るさはアプリ表示の調整です。本体の輝度やブラウザのアドレスバーは変わりません。バックグラウンド・画面ロック中の連続再生には対応しません。
- iPhoneではSafariの共有から「ホーム画面に追加」して使えます。

キュー・非表示・表示設定は端末／ブラウザ内へ自動保存します。端末間同期はありません。サイトデータを削除すると保存内容も消えます。

## 自分用の環境を作る

**1つの配備につき利用者は1人です。** この公開アプリには所有者のアカウント制限があります。他の人が使う場合は、ソースを自分のフォルダへ用意し、各自のGoogle Cloud・Cloudflare・D1で配備してください。複数人が同じURLへ自由に登録するサービスではありません。

必要なものはNode.js 24 LTS、Googleアカウント、公開する場合はCloudflareアカウントです。秘密値をチャットやGitへ貼らないでください。

他の人へソースを渡すときは `.dev.vars`、`wrangler.production.jsonc`、`.wrangler/` を含めず、その人自身の認証情報で設定してください。

### 1. インストールとGoogle設定

プロジェクトのフォルダで実行します。Windows PowerShellでは `npm.cmd` を使えます。

```powershell
npm.cmd ci
npm.cmd run secrets:init
```

`.dev.vars` がなければ作成し、32バイトの暗号鍵を自動生成します。既存ファイルは上書きしません。

1. [Google Cloud Console](https://console.cloud.google.com/) で自分用のプロジェクトを作成し、YouTube Data API v3を有効にします。
2. Google Auth Platformでアプリ情報・連絡先を設定します。個人用なら対象ユーザーをExternal、公開状態をTestingにし、テストユーザーへ自分のメールを追加します。
3. データアクセスに `openid`、`email`、`https://www.googleapis.com/auth/youtube.readonly` を設定します。書き込み権限や別のYouTube APIキーは不要です。
4. OAuthクライアントを **ウェブアプリケーション** として作成します。承認済みリダイレクトURIへ `http://127.0.0.1:5173/auth/callback` を登録します。
5. 公開URLが決まったら、そのURLに `/auth/callback` を付けたURIも同じクライアントへ追加します。

`.dev.vars` を手元のエディターで編集します。

| 項目 | 内容 |
| --- | --- |
| `GOOGLE_CLIENT_ID` | 作成したWeb用OAuthクライアントのID |
| `GOOGLE_CLIENT_SECRET` | 同じクライアントのSecret |
| `TOKEN_ENCRYPTION_KEY` | 自動生成した値を維持。保存トークンの復号に必要 |
| `ALLOWED_GOOGLE_EMAIL` | 使用する自分のGoogleメールアドレス |
| `ALLOWED_GOOGLE_SUB` | 初回は空欄。指定する場合はメールより優先 |

初回ログインでGoogleの不変ID（sub）をDBへ固定します。後からメール設定だけを変えても、別人への切り替えはできません。

### 2. PCで起動

```powershell
npm.cmd run db:migrate
npm.cmd run worker:dev
```

別のターミナルで実行します。

```powershell
npm.cmd run dev
```

[ローカルアプリ](http://127.0.0.1:5173/) を通常のブラウザで開き、設定からGoogleへ接続して更新します。認証にはCodex等の内蔵ブラウザを使わないでください。

- `.dev.vars` を変更したらバックエンドを停止・再起動します。
- `localhost` と `127.0.0.1` は混在させず、アクセス先・APP_ORIGIN・Googleの登録URIを揃えます。
- Google未設定またはバックエンド未起動のローカル環境はサンプルモードです。
- PCのローカルURLはスマホから開けません。PCを閉じて使うには次の公開配備を行います。

### 3. 自分のCloudflareへ公開

ここは**新しく自分用の環境を作る場合**の手順です。既に公開済みの環境を更新するだけなら次節へ進んでください。

```powershell
npx.cmd wrangler login
npx.cmd wrangler whoami
npx.cmd wrangler d1 create youtube-kit
```

表示された自分のアカウントIDとD1のdatabase_idを控えます。[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages) で自分のworkers.devサブドメインも確認・設定します。

配備プロファイルを作る前に、`wrangler.jsonc` の **env.production** を自分の値へ変更してください。既存の開発者のaccount_id・database_idをそのまま使わないでください。

| 場所 | 設定 |
| --- | --- |
| `account_id` | 自分のCloudflareアカウントID |
| `name` | 公開するWorker名。例: `youtube-kit` |
| `vars.APP_ORIGIN` | 公開URL。例: `https://youtube-kit.自分のサブドメイン.workers.dev` |
| `d1_databases[0].database_name` | 作成したD1名 |
| `d1_databases[0].database_id` | 作成したD1のID |
| `vars.ALLOW_DEMO` | `false` のまま |

Google Cloudの承認済みリダイレクトURIへ **自分の公開URL + `/auth/callback`** を追加して保存します。プライバシーポリシーのURLは公開URLの `/privacy.html` です。

以下の `YOUR_SUBDOMAIN` と `YOUR_D1_ID` は実際の値へ置き換えます。末尾の `/` は付けません。

```powershell
npm.cmd run deploy:configure -- --origin https://youtube-kit.YOUR_SUBDOMAIN.workers.dev --database-id YOUR_D1_ID
npm.cmd run deploy:check
npm.cmd run deploy:secrets
npm.cmd run db:migrate:production
npm.cmd run deploy
```

Worker名を変えた場合は、上の公開URLの先頭もその名前に合わせてください。

`deploy:configure` はGit対象外の `wrangler.production.jsonc` を作ります。既存ファイルは上書きしません。作成後の公開設定は、このファイルを手元で編集してください。

`deploy:secrets` は `.dev.vars` からGoogle Client ID・Secret・暗号鍵・許可メールまたはsubだけを読み、Workers Secretsへ送ります。秘密値をコマンドの引数やログへ出しません。通常の再配備でSecretsを登録し直す必要はありません。

公開URLをSafari等で開き、改めてGoogle接続・初回更新を行います。ローカルDB、Cookie、キューは公開版へ自動移行しません。

## 公開アプリを更新する

```powershell
npm.cmd run deploy:check
# 新しいマイグレーションがある場合だけ
npm.cmd run db:migrate:production
npm.cmd run deploy
```

Cloudflareのログイン期限が切れた場合は `npx.cmd wrangler login` を再実行します。

スマホでは再生を終了し、設定の「アプリの更新を確認」を押します。設定を閉じ、一覧上部の「アプリを更新」で適用します。保存キュー・非表示・設定は維持します。動画一覧の右上の更新は新着取得で、アプリ更新とは別です。

旧版でGoogle接続後や再読み込み時に `ERR_FAILED` が出た場合は、自分の公開URLの `/recover` を開き、「修正版を適用して開く」を押します。

## Googleアカウントを変える

同じGoogleアカウントへ再接続するだけなら、設定の「Googleへ再接続」を使います。別のアカウントへの変更には所有者固定の切り替えが必要です。

既存データを消さずに変更する方法は、**新しいD1で別の所有者として初期化する**ことです。以下の作業は自分で切り替えるときだけ行ってください。

1. 必要なら現在のアカウントでログアウトします。旧DBは残します。接続解除ボタンだけでは所有者固定は解除されません。
2. Google CloudのTestingを使う場合、新しいアカウントをテストユーザーへ追加します。OAuthクライアントも変える場合は、新しいクライアントへ同じcallback URIを登録します。
3. 自分のCloudflareに別名のD1を作成します。例: `npx.cmd wrangler d1 create youtube-kit-next`。
4. `wrangler.production.jsonc` のDB名・IDを新しいDBへ変更します。将来作り直す場合に備え `wrangler.jsonc` の本番側も揃えます。
5. `.dev.vars` の許可メールを新しいアカウントにし、subを使わない場合は空欄にします。Client ID・Secretを変更する場合もここへ設定します。暗号鍵は安易に変更しません。
6. 以前の本番Secretに `ALLOWED_GOOGLE_SUB` を登録していた場合は、Cloudflareの当該WorkerのSecretsから古い指定を削除します。**ローカルで空欄にしても既存の本番Secretは削除されません。** 許可対象を本番の `vars` に記載している場合も古い値を残さないでください。
7. `npm.cmd run deploy:secrets` → `npm.cmd run db:migrate:production` → `npm.cmd run deploy` を実行します。
8. 公開URLで新しいGoogleアカウントに接続し、初回更新します。以前の所有者のキューや動画は自動移行しません。

他の人に渡す場合は、この切り替えで自分の公開環境を共有するより、その人自身のGoogle Cloud・Cloudflareへ新しく配備してください。ローカルで別人の環境を試す場合も、別の作業フォルダ・`.dev.vars`・ローカルDBを用意すると元のデータを維持できます。

## エラー・制約

| 状況 | 対処 |
| --- | --- |
| Google設定が未設定 | `.dev.vars` またはWorkers Secretsを確認。ローカルはバックエンド再起動 |
| `redirect_uri_mismatch` | Googleの登録URI・APP_ORIGIN・アクセスURLを完全に一致させる |
| 別アカウントが拒否される | 許可メール／subと所有者固定を確認。上の切り替え手順を使う |
| 接続期限切れ | 設定から再接続。External/Testingでは今回の権限構成の更新トークンは通常7日で期限切れ |
| 一部チャンネルを取得できない | 他の取得は継続。設定の警告を確認し、更新で再試行 |
| 過去動画が足りない | 個別チャンネルを選び「さらに表示」。過去分を取り直す場合は設定から再取得 |
| 自動再生が止まる | 再開ボタンや公式プレーヤーの再生ボタンを押す |
| シアターが解除できない | 画面を動かさず3秒長押し。PCではEscape／Enterも使用可能 |

動画情報・トークンはD1に保存し、トークンは暗号化します。キュー・非表示・設定はブラウザ保存です。オフラインでは保存済みのアプリ本体を開けますが、動画情報の再取得や再生はできません。YouTube公式プレーヤーの広告・標準表示は残ります。

## 開発と詳しい資料

React / TypeScript / Vite、Cloudflare Workers / Hono / D1、Google OAuth、YouTube Data API v3 / IFrame Player APIを使用しています。

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run worker:check
npm.cmd run test:worker
```

- [詳細なセットアップと差分取得](docs/セットアップ.md)
- [スマホでの使い方](docs/スマホでの使い方.md)
- [仕様書](SPEC.md)
- [技術検証レポート](docs/技術検証レポート.md)
- [Shorts除外調査](docs/Shorts除外調査.md)
- [Google OAuth公式](https://developers.google.com/identity/protocols/oauth2/web-server)、[トークンの有効期限](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Cloudflare Wrangler / D1](https://developers.cloudflare.com/workers/wrangler/commands/d1/)

秘密情報、`wrangler.production.jsonc`、`node_modules/`、`dist/`、`.wrangler/` はGit対象外です。再現性のため `package-lock.json` は管理します。Gitのステージ・コミット・pushはユーザーが行います。
