# chrome-bookmarks-mcp

[English README](README.md)

Claude Code などの MCP クライアントから **Chrome のブックマークを読み書きする** [MCP](https://modelcontextprotocol.io/) サーバーと、それを助ける小さな Chrome 拡張。

```
MCP クライアント ──(stdio / MCP)── chrome-bookmarks-mcp ──(WebSocket 127.0.0.1:17870〜17874)── 拡張 ──(chrome.bookmarks)── Chrome
```

ブックマークの編集は拡張だけができる（`chrome.bookmarks` API）。Chrome 起動中に `Bookmarks` ファイルを直接書き換えても上書きされてしまう。そこでこのプロジェクトは 2 つの部品から成る。

- **`chrome-bookmarks-mcp`**（npm）— MCP サーバー。`127.0.0.1` で WebSocket を待ち受け、ツール呼び出しを拡張へ転送する
- **Chrome Bookmarks MCP Bridge**（`extension/`）— Manifest V3 の拡張。サーバーへ接続し、`chrome.bookmarks` の呼び出しを代行する

## 特徴

- ツール 11 個: status／get_tree／get_children／get／search／get_recent／create／update／move／remove／remove_tree
- 複数の MCP クライアントを同時に扱える（サーバーは 17870〜17874 の空きポートを順に取り、拡張は 5 ポート全部に接続する）
- ローカル限定（サーバーは `127.0.0.1` にだけバインドし、`Origin` が `chrome-extension://` の接続だけ受け付ける）
- 拡張が実行できる `chrome.bookmarks` API はホワイトリストで固定
- 削除系ツール（`remove`／`remove_tree`）には `destructiveHint` を付けてあり、クライアント側で確認を挟める

## セットアップ

Node.js 18 以上と Google Chrome（MV3 拡張が動く Chromium 系ブラウザ）が必要。

### 1. MCP サーバーを登録する

Claude Code:

```sh
claude mcp add --scope user chrome-bookmarks -- npx -y chrome-bookmarks-mcp
claude mcp list   # chrome-bookmarks: ✔ Connected なら OK
```

他の MCP クライアントでは設定にこう書く:

```json
{
  "mcpServers": {
    "chrome-bookmarks": {
      "command": "npx",
      "args": ["-y", "chrome-bookmarks-mcp"]
    }
  }
}
```

### 2. 拡張を Chrome に読み込む（プロファイルごとに 1 回）

1. [Releases](https://github.com/masaodev/chrome-bookmarks-mcp/releases) から `chrome-bookmarks-mcp-extension-<version>.zip` をダウンロードして展開する（リポジトリの `extension/` フォルダでもよい）
2. `chrome://extensions` を開き、右上の「デベロッパー モード」を ON にする
3. 「パッケージ化されていない拡張機能を読み込む」で展開したフォルダを選ぶ
4. ツールバーに緑の栞アイコンが出る。バッジの数字＝接続中の MCP サーバー数（MCP クライアントを開いていなければ空）

ブックマークを操作したいプロファイルで読み込む。複数プロファイルに読み込むと、サーバーは**最後に接続した拡張**へ命令を送る。

> パッケージ化されていない拡張があると Chrome 起動時に「デベロッパー モードの拡張機能を無効にする」と聞かれる。「キャンセル」で閉じれば動き続ける。

### 3. 使ってみる

Claude Code の新しいセッションで「ブックマークのフォルダ一覧を見せて」などと頼むと、`bookmarks_get_tree` が呼ばれる。

## ツール一覧

| ツール                   | 動作                                                     |
| ------------------------ | -------------------------------------------------------- |
| `bookmarks_status`       | 拡張との接続状態（失敗したらまずこれ）                   |
| `bookmarks_get_tree`     | 全体または id 配下のツリー。`[id] 📁 名前 (子の数)` 形式 |
| `bookmarks_get_children` | フォルダ直下を順番どおりに                               |
| `bookmarks_get`          | id 指定で取得                                            |
| `bookmarks_search`       | フリーワード（Chrome 標準）／title・url 完全一致         |
| `bookmarks_get_recent`   | 最近追加した順                                           |
| `bookmarks_create`       | ブックマーク・フォルダ作成（`url` 省略でフォルダ）       |
| `bookmarks_update`       | タイトル・URL 変更                                       |
| `bookmarks_move`         | フォルダ移動・並べ替え                                   |
| `bookmarks_remove`       | 1 件削除（空フォルダ可）                                 |
| `bookmarks_remove_tree`  | フォルダを中身ごと削除                                   |

読み取り系ツールは `format: "json"` を付けると生の `BookmarkTreeNode` を返す。

ルート直下（ブックマークバー・その他のブックマーク・モバイルのブックマーク）の id はプロファイルごとに違う。`bookmarks_get_children` に id `0` を渡して確かめる。

## トラブルシュート

| 症状                                                                                                                | 見るところ                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「Chrome extension is not connected」                                                                               | Chrome が起動しているか／`chrome://extensions` で拡張が有効か。アイコンをクリックすると即再接続。登録前から開いていたセッションはサーバーを起動しないので、新しいセッションを開く（Claude Code なら `/mcp` で再接続）。詳細は拡張の「Service Worker」リンクからコンソールを見る |
| `claude mcp list` で Failed                                                                                         | ターミナルで `npx chrome-bookmarks-mcp` を直接実行して stderr を見る。ポート 17870〜17874 が全部埋まっていると起動しない                                                                                                                                                        |
| 拡張の「エラー」欄に `WebSocket connection to 'ws://127.0.0.1:1787x/' failed: net::ERR_CONNECTION_REFUSED` が溜まる | 実害なし。拡張 0.1.1 で解消済み（以前の版は 30 秒ごとに全ポートへ接続を試み、サーバーが居ないポートの失敗が記録されていた）。拡張を更新してから欄を消去する                                                                                                                     |
| 別プロファイルのブックマークが動く                                                                                  | サーバーは最後に接続した拡張に送る。不要なプロファイルでは拡張を無効にする                                                                                                                                                                                                      |

## 開発

```sh
git clone https://github.com/masaodev/chrome-bookmarks-mcp.git
cd chrome-bookmarks-mcp
npm install
npm test               # 擬似拡張でのスモークテスト（Chrome 不要）
npm run live           # 本物の拡張との疎通確認（読み取りのみ。先に extension/ を読み込む）
npm run pack:extension # dist/chrome-bookmarks-mcp-extension-<version>.zip を作る
```

npm ではなくチェックアウトから動かすとき:

```sh
claude mcp add --scope user chrome-bookmarks -- node /path/to/chrome-bookmarks-mcp/server/index.js
```

### 設計メモ

- MV3 の service worker は約 30 秒で寝るため、サーバーから 20 秒ごとにアプリ層 ping を送り、拡張側でも 30 秒ごとの alarm で再接続する
- WebSocket の接続失敗は必ず拡張のエラーとして記録されるため、拡張はまず各ポートを `fetch` で静かに確かめ（サーバーは素の HTTP に 426 を返す）、サーバーが居るポートにだけ WebSocket を張る
- Native Messaging は使わなかった。Chrome が起動するホストと MCP クライアントが起動するサーバーが別プロセスになり、結局ブリッジが要るため。WebSocket 1 本で済ませた
- 環境変数 `CHROME_BOOKMARKS_MCP_PORTS=17879,17878`（カンマ区切り）で候補ポートを差し替えられる。スモークテストはこれを使い、テスト用サーバーが実セッション・本物の拡張と 17870〜17874 を共有しないようにしている
- サーバーと拡張は小さな JSON プロトコル（`{id, api, args}` → `{id, result | error}`）を共有する。両者のバージョンは揃えて使う

## セキュリティ

サーバーはループバックにだけ待ち受け、`chrome-extension://` 以外の Origin を拒否する。拡張は `background.js` にあるホワイトリストの `chrome.bookmarks` メソッドしか実行しない。ローカルの別プロセスがポートに接続して MCP サーバーを装うことは原理上可能なので、気になる環境では使わないときに拡張を無効にしておく。

## ライセンス

[MIT](LICENSE)
