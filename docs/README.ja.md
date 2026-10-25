# Parallax — ドキュメント

[한국어](README.ko.md) · **日本語** · [English](README.md) · [中文](README.zh.md)

Parallax は、ローカル優先のコード変更影響分析レイヤーです。単一の SQLite ストアが、CLI、コーディングエージェント向け MCP サーバー、UI Explorer を支えます。この索引には、`docs/` に含まれる主要ガイドへのリンクをまとめています。

詳細ガイドは現在、英語・韓国語・中国語で提供しています。以下は英語版へのリンクです。

**キャッシュの検証:** Git の clean 状態だけでなく、実際のスキャン入力と選択した Git 履歴も比較して結果を再利用します。本文の読み取りは省略しません。1 MB 上限を明示する場合は `parallax index --max-file-bytes 1000000` を使用してください。[検証範囲（英語）](verification.md)。

## はじめに

| ドキュメント | 内容 |
| :--- | :--- |
| [`getting-started.md`](getting-started.md) | 初回実行チュートリアル: init、index、analyze、UI、MCP、CI ガードレール |

## 概念と方向性

| ドキュメント | 内容 |
| :--- | :--- |
| [`vision.md`](vision.md) | プロジェクトのビジョン |
| [`value-proposition.md`](value-proposition.md) | 提供価値と差別化 |
| [`roadmap.md`](roadmap.md) | 現在のバックログと次の実装単位 |
| [`invariants.md`](invariants.md) | ローカル優先、秘匿情報のマスキング、権限モデルなどの不変条件 |
| [`glossary.md`](glossary.md) | 用語集 |
| [`architecture.md`](architecture.md) | 実行時アーキテクチャと拡張マップ |

## リファレンス

| ドキュメント | 内容 |
| :--- | :--- |
| [`mcp.md`](mcp.md) | MCP サーバー、ツール、リソース |
| [`cli-reference.md`](cli-reference.md) | すべての CLI コマンド、フラグ、終了コード |
| [`report-schema.md`](report-schema.md) | `analyze --json` 出力の公開 JSON Schema |
| [`extending-adapters.md`](extending-adapters.md) | 意味解析アダプターの作成 |
| [`verification.md`](verification.md) | 検証レイヤー、テストスクリプト、dogfood ガード |
| [`operations.md`](operations.md) | トラブルシューティングと運用手順 |
| [`release-checklist.md`](release-checklist.md) | リリース、CI、監査、パッケージスモークテストのチェックリスト |

## ソースチェックアウトについて

リポジトリのチェックアウトには、TypeScript ソースファイル、テスト、ベンチマークのフィクスチャに加え、Claude Code / Codex ユーザー向けの Parallax スキルが `skills/` に含まれます。npm パッケージにはビルド済み CLI、公開ドキュメント、`schemas/` 内の公開レポートスキーマが含まれますが、スキルディレクトリは含まれません。アーキテクチャやリリースチェックリストなどのメンテナー向け文書には、ソースチェックアウトが必要な箇所を明記しています。

プロジェクトの概要は、[ルート README](../README.ja.md) を参照してください。
