/**
 * OSV (Open Source Vulnerabilities) API client
 * https://osv.dev/
 */

import { DataSourceName, Vulnerability, VulnerabilityQuery } from '../types/index.js';
import { BaseDataSourceClient } from './data-source.js';
import { classifySeverity } from '../utils/severity.js';
import { retryWithBackoff } from '../utils/retry.js';

const OSV_API_URL = 'https://api.osv.dev/v1';
const MAX_BATCH_SIZE = 1000;

interface OsvVulnerability {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{
    type: string;
    score: string;
  }>;
  affected?: Array<{
    package?: {
      ecosystem: string;
      name: string;
    };
    ranges?: Array<{
      type: string;
      events: Array<{
        introduced?: string;
        fixed?: string;
      }>;
    }>;
    versions?: string[];
  }>;
  references?: Array<{
    type: string;
    url: string;
  }>;
  published?: string;
  modified?: string;
}

interface OsvQueryResponse {
  vulns?: OsvVulnerability[];
}

interface OsvBatchResponse {
  results: OsvQueryResponse[];
}

export class OsvClient extends BaseDataSourceClient {
  readonly name: DataSourceName = 'OSV';
  readonly requiresAuth = false;

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${OSV_API_URL}/vulns/OSV-2020-1`);
      return response.ok;
    } catch {
      return false;
    }
  }

  getMaxBatchSize(): number {
    return MAX_BATCH_SIZE;
  }


  async queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>> {
    const results = new Map<string, Vulnerability[]>();

    if (queries.length === 0) {
      return results;
    }

    // Split into batches
    const batches = this.splitIntoBatches(queries, MAX_BATCH_SIZE);

    for (const batch of batches) {
      const batchResults = await this.queryBatchInternal(batch);
      for (const [key, vulns] of batchResults) {
        results.set(key, vulns);
      }
    }

    return results;
  }

  private async queryBatchInternal(
    queries: VulnerabilityQuery[]
  ): Promise<Map<string, Vulnerability[]>> {
    const results = new Map<string, Vulnerability[]>();

    // Initialize results with empty arrays
    for (const query of queries) {
      results.set(this.generateQueryKey(query), []);
    }

    // Build batch request
    const batchQueries = queries.map(q => ({
      package: {
        ecosystem: 'Maven',
        name: q.name
      },
      version: q.version
    }));

    try {
      const response = await retryWithBackoff(async () => {
        const res = await fetch(`${OSV_API_URL}/querybatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queries: batchQueries })
        });

        if (!res.ok) {
          throw new Error(`OSV API error: ${res.status}`);
        }

        return res.json() as Promise<OsvBatchResponse>;
      });

      // Process results
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const key = this.generateQueryKey(query);
        const queryResult = response.results[i];

        if (queryResult?.vulns) {
          const vulnerabilities = queryResult.vulns.map(v => this.mapVulnerability(v));
          results.set(key, vulnerabilities);
        }
      }
    } catch (error) {
      // Log error but don't throw - return empty results
      console.error('OSV batch query failed:', error);
    }

    return results;
  }

  private mapVulnerability(osv: OsvVulnerability): Vulnerability {
    // Extract CVSS score
    let cvssScore: number | null = null;
    if (osv.severity) {
      for (const sev of osv.severity) {
        if (sev.type === 'CVSS_V3' || sev.type === 'CVSS_V2') {
          cvssScore = parseFloat(sev.score);
          break;
        }
      }
    }

    // Extract fixed version
    let fixedVersion: string | null = null;
    let affectedVersions = '';
    if (osv.affected?.[0]?.ranges) {
      const range = osv.affected[0].ranges[0];
      if (range?.events) {
        const introduced = range.events.find(e => e.introduced)?.introduced;
        const fixed = range.events.find(e => e.fixed)?.fixed;
        fixedVersion = fixed || null;
        affectedVersions = introduced ? `>= ${introduced}` : '';
        if (fixed) {
          affectedVersions += affectedVersions ? `, < ${fixed}` : `< ${fixed}`;
        }
      }
    }

    // Extract references
    const references = osv.references?.map(r => r.url) || [];

    return {
      id: osv.id,
      source: 'OSV',
      severity: classifySeverity(cvssScore),
      cvssScore,
      description: osv.summary || osv.details || 'No description available',
      affectedVersions,
      fixedVersion,
      references,
      publishedDate: osv.published || ''
    };
  }
}

export const osvClient = new OsvClient();
