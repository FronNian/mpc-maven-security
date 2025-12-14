/**
 * Data source interface for vulnerability queries
 */

import { DataSourceName, Vulnerability, VulnerabilityQuery } from '../types/index.js';

/**
 * Interface for vulnerability data source clients
 */
export interface IDataSourceClient {
  readonly name: DataSourceName;
  readonly requiresAuth: boolean;

  /**
   * Check if the data source is available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Query vulnerabilities for multiple packages in batch
   */
  queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>>;

  /**
   * Get the maximum batch size for this data source
   */
  getMaxBatchSize(): number;
}

/**
 * Base class for data source clients with common functionality
 */
export abstract class BaseDataSourceClient implements IDataSourceClient {
  abstract readonly name: DataSourceName;
  abstract readonly requiresAuth: boolean;

  abstract isAvailable(): Promise<boolean>;
  abstract queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>>;
  abstract getMaxBatchSize(): number;

  /**
   * Generate a unique key for a query
   */
  protected generateQueryKey(query: VulnerabilityQuery): string {
    return `${query.name}:${query.version}`;
  }

  /**
   * Split queries into batches
   */
  protected splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }
}
