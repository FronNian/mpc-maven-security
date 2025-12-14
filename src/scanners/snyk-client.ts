/**
 * Snyk API client
 * https://snyk.io/
 * 
 * Free tier: 200 tests/month
 * Get API token: https://app.snyk.io/account
 */

import { DataSourceName, Vulnerability, VulnerabilityQuery } from '../types/index.js';
import { BaseDataSourceClient } from './data-source.js';
import { classifySeverity } from '../utils/severity.js';

const SNYK_API_URL = 'https://api.snyk.io/v1';
const MAX_BATCH_SIZE = 100;

interface SnykVulnerability {
  id: string;
  title: string;
  description?: string;
  severity: string;
  cvssScore?: number;
  CVSSv3?: string;
  semver?: {
    vulnerable: string[];
  };
  fixedIn?: string[];
  references?: Array<{ url: string }>;
  publicationTime?: string;
}

interface SnykTestResult {
  ok: boolean;
  vulnerabilities?: SnykVulnerability[];
  dependencyCount?: number;
}

export class SnykClient extends BaseDataSourceClient {
  readonly name: DataSourceName = 'SNYK';
  readonly requiresAuth = true;

  private apiToken?: string;

  constructor(apiToken?: string) {
    super();
    this.apiToken = apiToken || process.env.SNYK_TOKEN;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiToken) {
      return false;
    }

    try {
      const response = await fetch(`${SNYK_API_URL}/`, {
        headers: this.getHeaders()
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
    return {
      'Content-Type': 'application/json',
      'Authorization': `token ${this.apiToken}`
    };
  }

  async queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>> {
    const results = new Map<string, Vulnerability[]>();

    if (queries.length === 0 || !this.apiToken) {
      return results;
    }

    // Filter out UNKNOWN versions
    const validQueries = queries.filter(q => q.version && q.version !== 'UNKNOWN');

    // Initialize all with empty arrays
    for (const query of queries) {
      results.set(this.generateQueryKey(query), []);
    }

    if (validQueries.length === 0) {
      return results;
    }

    // Snyk test API - test Maven packages
    // We need to query one by one as Snyk doesn't have a true batch API for arbitrary packages
    // But we can parallelize with concurrency limit
    const concurrency = 5;
    const chunks = this.chunkArray(validQueries, concurrency);

    for (const chunk of chunks) {
      const promises = chunk.map(query => this.querySingle(query));
      const chunkResults = await Promise.all(promises);
      
      for (let i = 0; i < chunk.length; i++) {
        const query = chunk[i];
        const vulns = chunkResults[i];
        results.set(this.generateQueryKey(query), vulns);
      }
    }

    return results;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private async querySingle(query: VulnerabilityQuery): Promise<Vulnerability[]> {
    const [groupId, artifactId] = query.name.split(':');
    
    try {
      // Use Snyk's test endpoint for Maven packages
      const response = await fetch(
        `${SNYK_API_URL}/test/maven/${encodeURIComponent(groupId)}/${encodeURIComponent(artifactId)}/${encodeURIComponent(query.version)}`,
        {
          method: 'GET',
          headers: this.getHeaders()
        }
      );

      if (!response.ok) {
        // 404 means no vulnerabilities found (good!)
        if (response.status === 404) {
          return [];
        }
        // Rate limit or other error
        if (response.status === 429) {
          console.error('Snyk rate limit reached');
        }
        return [];
      }

      const result = await response.json() as SnykTestResult;

      if (!result.vulnerabilities || result.vulnerabilities.length === 0) {
        return [];
      }

      return result.vulnerabilities.map(v => this.mapVulnerability(v));
    } catch (error) {
      // Silent fail - don't spam logs
      return [];
    }
  }

  private mapVulnerability(snykVuln: SnykVulnerability): Vulnerability {
    // Extract CVSS score
    let cvssScore: number | null = snykVuln.cvssScore || null;
    
    // Try to parse from CVSSv3 string if not directly available
    if (!cvssScore && snykVuln.CVSSv3) {
      const match = snykVuln.CVSSv3.match(/CVSS:3\.\d\/AV:\w\/.*?\/S:\w\/C:\w\/I:\w\/A:\w/);
      if (match) {
        // Snyk usually provides the score separately, but fallback to severity mapping
        cvssScore = this.severityToScore(snykVuln.severity);
      }
    }

    if (!cvssScore) {
      cvssScore = this.severityToScore(snykVuln.severity);
    }

    // Get fixed version
    const fixedVersion = snykVuln.fixedIn && snykVuln.fixedIn.length > 0 
      ? snykVuln.fixedIn[snykVuln.fixedIn.length - 1] 
      : null;

    // Get affected versions
    const affectedVersions = snykVuln.semver?.vulnerable?.join(', ') || '';

    // Get references
    const references = snykVuln.references?.map(r => r.url) || [];
    // Add Snyk advisory link
    references.unshift(`https://snyk.io/vuln/${snykVuln.id}`);

    return {
      id: snykVuln.id,
      source: 'SNYK',
      severity: classifySeverity(cvssScore),
      cvssScore,
      description: snykVuln.title || snykVuln.description || 'No description available',
      affectedVersions,
      fixedVersion,
      references,
      publishedDate: snykVuln.publicationTime || ''
    };
  }

  private severityToScore(severity: string): number {
    switch (severity?.toLowerCase()) {
      case 'critical': return 9.5;
      case 'high': return 8.0;
      case 'medium': return 5.5;
      case 'low': return 3.0;
      default: return 0;
    }
  }
}

export const snykClient = new SnykClient();
