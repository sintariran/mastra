import { MastraVector } from '@mastra/core/vector';
import type {
  QueryResult,
  CreateIndexParams,
  UpsertVectorParams,
  QueryVectorParams,
  ParamsToArgs,
} from '@mastra/core/vector';
import type { VectorFilter } from '@mastra/core/vector/filter';
import Cloudflare from 'cloudflare';

import { VectorizeFilterTranslator } from './filter';

export class CloudflareVector extends MastraVector {
  client: Cloudflare;
  accountId: string;

  constructor({ accountId, apiToken }: { accountId: string; apiToken: string }) {
    super();
    this.accountId = accountId;

    this.client = new Cloudflare({
      apiToken: apiToken,
    });
  }

  async upsert(...args: ParamsToArgs<UpsertVectorParams>): Promise<string[]> {
    const params = this.normalizeArgs<UpsertVectorParams>('upsert', args);

    const { indexName, vectors, metadata, ids } = params;

    const generatedIds = ids || vectors.map(() => crypto.randomUUID());

    // Create NDJSON string - each line is a JSON object
    const ndjson = vectors
      .map((vector, index) =>
        JSON.stringify({
          id: generatedIds[index]!,
          values: vector,
          metadata: metadata?.[index],
        }),
      )
      .join('\n');

    // Note: __binaryRequest is required for proper NDJSON handling
    await this.client.vectorize.indexes.upsert(
      indexName,
      {
        account_id: this.accountId,
        body: ndjson,
      },
      {
        __binaryRequest: true,
      },
    );

    return generatedIds;
  }

  transformFilter(filter?: VectorFilter) {
    const translator = new VectorizeFilterTranslator();
    return translator.translate(filter);
  }

  private async verifyIndexExists(indexName: string, dimension: number): Promise<boolean> {
    try {
      const info = await this.client.vectorize.indexes.info(indexName, {
        account_id: this.accountId,
      });

      if (!info) {
        return false; // Index doesn't exist
      }
      if (info.dimensions !== dimension) {
        throw new Error(
          `Index "${indexName}" already exists with ${info.dimensions} dimensions, but ${dimension} dimensions were requested`,
        );
      }

      // Index exists with matching dimensions
      return true;
    } catch (error: any) {
      // Check if this is an expected "index doesn't exist" error
      // This covers all variants of not found/deleted errors by checking:
      // 1. HTTP status (404/410 both mean the index isn't there)
      // 2. Error message content (contains common patterns)
      const message = error?.errors?.[0]?.message || error?.message;
      if (
        error.status === 404 ||
        error.status === 410 ||
        message?.toLowerCase().includes('not found') ||
        message?.toLowerCase().includes('deleted')
      ) {
        return false;
      }

      // For any other errors, propagate them up
      throw error;
    }
  }

  async createIndex(...args: ParamsToArgs<CreateIndexParams>): Promise<void> {
    const params = this.normalizeArgs<CreateIndexParams>('createIndex', args);

    const { indexName, dimension, metric = 'cosine' } = params;

    // Check if index exists with correct dimensions
    const exists = await this.verifyIndexExists(indexName, dimension);
    if (exists) {
      this.logger.info(
        `Index "${indexName}" already exists with ${dimension} dimensions and metric ${metric}, skipping creation.`,
      );
      return;
    }

    // Index doesn't exist, create it
    await this.client.vectorize.indexes.create({
      account_id: this.accountId,
      config: {
        dimensions: dimension,
        metric: metric === 'dotproduct' ? 'dot-product' : metric,
      },
      name: indexName,
    });
  }

  async query(...args: ParamsToArgs<QueryVectorParams>): Promise<QueryResult[]> {
    const params = this.normalizeArgs<QueryVectorParams>('query', args);

    const { indexName, queryVector, topK = 10, filter, includeVector = false } = params;

    const translatedFilter = this.transformFilter(filter) ?? {};
    const response = await this.client.vectorize.indexes.query(indexName, {
      account_id: this.accountId,
      vector: queryVector,
      returnValues: includeVector,
      returnMetadata: 'all',
      topK,
      filter: translatedFilter,
    });

    return (
      response?.matches?.map((match: any) => {
        return {
          id: match.id,
          metadata: match.metadata,
          score: match.score,
          vector: match.values,
        };
      }) || []
    );
  }

  async listIndexes(): Promise<string[]> {
    const res = await this.client.vectorize.indexes.list({
      account_id: this.accountId,
    });

    return res?.result?.map(index => index.name!) || [];
  }

  async describeIndex(indexName: string) {
    const index = await this.client.vectorize.indexes.get(indexName, {
      account_id: this.accountId,
    });

    const described = await this.client.vectorize.indexes.info(indexName, {
      account_id: this.accountId,
    });

    return {
      dimension: described?.dimensions!,
      // Since vector_count is not available in the response,
      // we might need a separate API call to get the count if needed
      count: described?.vectorCount || 0,
      metric: index?.config?.metric as 'cosine' | 'euclidean' | 'dotproduct',
    };
  }

  async deleteIndex(indexName: string): Promise<void> {
    await this.client.vectorize.indexes.delete(indexName, {
      account_id: this.accountId,
    });
  }

  async createMetadataIndex(indexName: string, propertyName: string, indexType: 'string' | 'number' | 'boolean') {
    await this.client.vectorize.indexes.metadataIndex.create(indexName, {
      account_id: this.accountId,
      propertyName,
      indexType,
    });
  }

  async deleteMetadataIndex(indexName: string, propertyName: string) {
    await this.client.vectorize.indexes.metadataIndex.delete(indexName, {
      account_id: this.accountId,
      propertyName,
    });
  }

  async listMetadataIndexes(indexName: string) {
    const res = await this.client.vectorize.indexes.metadataIndex.list(indexName, {
      account_id: this.accountId,
    });

    return res?.metadataIndexes ?? [];
  }

  async updateIndexById(
    indexName: string,
    id: string,
    update: {
      vector?: number[];
      metadata?: Record<string, any>;
    },
  ): Promise<void> {
    if (!update.vector && !update.metadata) {
      throw new Error('No update data provided');
    }

    const updatePayload: any = {
      ids: [id],
      account_id: this.accountId,
    };

    if (update.vector) {
      updatePayload.vectors = [update.vector];
    }
    if (update.metadata) {
      updatePayload.metadata = [update.metadata];
    }

    await this.upsert({ indexName: indexName, vectors: updatePayload.vectors, metadata: updatePayload.metadata });
  }

  async deleteIndexById(indexName: string, id: string): Promise<void> {
    await this.client.vectorize.indexes.deleteByIds(indexName, {
      ids: [id],
      account_id: this.accountId,
    });
  }
}
