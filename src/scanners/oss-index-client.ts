/**
 * Sonatype OSS Index API client
 * https://ossindex.sonatype.org/
 */

import { DataSourceName, Vulnerability, VulnerabilityQuery } from '../types/index.js';
import { BaseDataSourceClient } from './data-source.js';
import { classifySeverity } from '../utils/severity.js';
import { retryWithBackoff } from '../utils/retry.js';

const OSS_INDEX_API_URL = 'https://ossindex.sonatype.org/api/v3';
const MAX_BATCH_SIZE = 128;

interface OssIndexVulnerability {
  id: string;
  displayName?: string;
  title?: string;
  description?: string;
  cvssScore?: number;
  cvssVector?: string;
  cwe?: string;
  reference?: string;
  externalReferences?: string[];
}

interface OssIndexComponent {
  coordinates: string;
  description?: string;
  reference?: string;
  vulnerabilities?: OssIndexVulnerability[];
}

export class OssIndexClient extends BaseDataSourceClient {
  readonly name: DataSourceName = 'OSS_INDEX';
  readonly requiresAuth = true;

  private user?: string;
  private token?: string;

  constructor(user?: string, token?: string) {
    super();
    this.user = user || process.env.OSS_INDEX_USER;
    this.token = token || process.env.OSS_INDEX_TOKEN;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.user || !this.token) {
      return false;
    }

    try {
      const response = await fetch(`${OSS_INDEX_API_URL}/authorized/component-report`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ coordinates: ['pkg:maven/org.apache.commons/commons-lang3@3.12.0'] })
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getMaxBatchSize(): number {
    return MAX_BATCH_SIZE;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (this.user && this.token) {
      const auth = Buffer.from(`${this.user}:${this.token}`).toString('base64');
      headers['Authorization'] = `Basic ${auth}`;
    }

    return headers;
  }


  async queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>> {
    const results = new Map<string, Vulnerability[]>();

    if (queries.length === 0 || !this.user || !this.token) {
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

    // Build coordinates in purl format
    const coordinates = queries.map(q => {
      const [groupId, artifactId] = q.name.split(':');
      return `pkg:maven/${groupId}/${artifactId}@${q.version}`;
    });

    try {
      const response = await retryWithBackoff(async () => {
        const res = await fetch(`${OSS_INDEX_API_URL}/authorized/component-report`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify({ coordinates })
        });

        if (!res.ok) {
          throw new Error(`OSS Index API error: ${res.status}`);
        }

        return res.json() as Promise<OssIndexComponent[]>;
      });

      // Process results
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const key = this.generateQueryKey(query);
        const component = response[i];

        if (component?.vulnerabilities && component.vulnerabilities.length > 0) {
          const vulnerabilities = component.vulnerabilities.map(v => this.mapVulnerability(v));
          results.set(key, vulnerabilities);
        }
      }
    } catch (error) {
      console.error('OSS Index batch query failed:', error);
    }

    return results;
  }

  private mapVulnerability(ossVuln: OssIndexVulnerability): Vulnerability {
    const cvssScore = ossVuln.cvssScore ?? null;

    return {
      id: ossVuln.id,
      source: 'OSS_INDEX',
      severity: classifySeverity(cvssScore),
      cvssScore,
      description: ossVuln.description || ossVuln.title || 'No description available',
      affectedVersions: '',
      fixedVersion: null,
      references: ossVuln.externalReferences || (ossVuln.reference ? [ossVuln.reference] : []),
      publishedDate: ''
    };
  }
}

export const ossIndexClient = new OssIndexClient();
