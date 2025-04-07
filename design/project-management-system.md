# プロジェクト管理AIシステム設計書

## 1. 概要と目的

本システムは、会議情報の処理・保存と、プロジェクト情報への質問対応を行う2つの主要コンポーネントから構成されるAIベースのプロジェクト管理システムです。

### 目的

- 会議トランスクリプトから自動的に重要情報を抽出・整理
- プロジェクト情報の一元管理と検索容易性の向上
- タスク管理の効率化と追跡
- プロジェクト関連の質問に対する即時応答
- 組織の知識・情報の効率的な管理と活用

## 2. システムアーキテクチャ

```
┌───────────────────────┐     ┌────────────────────────────┐
│                       │     │                            │
│  会議情報処理         │     │  プロジェクト質問対応      │
│  ワークフロー         │     │  AIエージェント           │
│                       │     │                            │
└─────────┬─────────────┘     └───────────────┬────────────┘
          │                                   │
          │                                   │
          ▼                                   ▼
┌─────────────────────────────────────────────────────────┐
│                                                         │
│                   永続化メモリレイヤー                  │
│           (PostgreSQL + pgvector / ベクトルDB)         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 3. コンポーネント詳細

### 3.1 会議情報処理ワークフロー

**責務:**

- 会議トランスクリプトの取り込みと前処理
- メタデータ（日時、参加者、プロジェクトID等）の収集と検証
- 重要情報の抽出と構造化
- タスク・アクションアイテムの識別
- 情報の永続化と索引付け

**実装方式:**

- Mastraワークフロー機能を活用
- 定義された処理ステップに沿って順次処理
- エラーハンドリングと再処理機能

**処理フロー:**

1. メタデータ収集・検証ステップ
2. トランスクリプト解析ステップ
3. タスク抽出ステップ
4. 永続化ステップ

### 3.2 プロジェクト質問対応AIエージェント

**責務:**

- ユーザーからの質問理解と意図分析
- 関連するプロジェクト情報の検索・取得
- タスク進捗確認や更新
- 適切な回答の生成と返却

**実装方式:**

- Mastraエージェント機能を活用
- RAG（Retrieval-Augmented Generation）アプローチ
- 必要に応じた複数の専門化サブエージェント連携

**主要機能:**

- プロジェクト情報検索
- タスク管理（確認・更新・作成）
- 会議要約の取得
- プロジェクト進捗レポート生成

## 4. データフロー

```
┌─────────────┐     ┌────────────────┐     ┌───────────────┐
│ 会議データ  │────→│ワークフロー処理 │────→│ 永続化メモリ  │
└─────────────┘     └────────────────┘     └───────┬───────┘
                                                    │
                                                    ▼
┌─────────────┐     ┌────────────────┐     ┌───────────────┐
│ ユーザー   │←────│  AIエージェント │←────│  情報検索     │
│ 質問/応答  │     │                │     │  (RAG処理)    │
└─────────────┘     └────────────────┘     └───────────────┘
```

## 5. データモデル

### プロジェクト情報

```typescript
interface Project {
  id: string;
  name: string;
  description: string;
  startDate: Date;
  endDate?: Date;
  status: 'active' | 'completed' | 'on-hold';
  clientInfo?: {
    name: string;
    contactPerson: string;
    email?: string;
  };
  tags: string[];
}
```

### 会議情報

```typescript
interface MeetingRecord {
  id: string;
  projectId: string;
  date: Date;
  participants: string[];
  rawTranscript: string;
  summary: string;
  keyPoints: string[];
  nextSteps?: string[];
  vectorEmbedding?: number[]; // For semantic search
}
```

### タスク情報

```typescript
interface Task {
  id: string;
  projectId: string;
  description: string;
  assignee?: string;
  dueDate?: Date;
  status: 'pending' | 'in-progress' | 'completed';
  priority: 'low' | 'medium' | 'high';
  sourceType: 'meeting' | 'manual';
  sourceId?: string; // ID of meeting if from meeting
  createdAt: Date;
  updatedAt?: Date;
}
```

## 6. 技術スタック

- **フレームワーク**: Mastra AI Framework
- **データベース**: PostgreSQL + pgvector拡張
- **言語モデル**: OpenAI GPT-4o または同等モデル
- **開発言語**: TypeScript
- **API**: REST + WebSockets

## 7. 将来的な拡張計画

- マルチプロジェクト間の関連性分析
- プロジェクトリスク予測機能
- リソース最適化提案機能
- ドキュメント自動生成機能
- チームコラボレーション分析
