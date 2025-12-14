/**
 * NVD (National Vulnerability Database) API client
 * https://nvd.nist.gov/developers/vulnerabilities
 */

import { DataSourceName, Vulnerability, VulnerabilityQuery } from '../types/index.js';
import { BaseDataSourceClient } from './data-source.js';
import { classifySeverity } from '../utils/severity.js';
// retryWithBackoff removed - 404 is normal for NVD (no CVE found)

const NVD_API_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const MAX_BATCH_SIZE = 100;

interface NvdCvssV3 {
  baseScore?: number;
  baseSeverity?: string;
}

interface NvdCvssV2 {
  baseScore?: number;
}

interface NvdCve {
  id: string;
  descriptions?: Array<{ lang: string; value: string }>;
  published?: string;
  metrics?: {
    cvssMetricV31?: Array<{ cvssData?: NvdCvssV3 }>;
    cvssMetricV30?: Array<{ cvssData?: NvdCvssV3 }>;
    cvssMetricV2?: Array<{ cvssData?: NvdCvssV2 }>;
  };
  references?: Array<{ url: string }>;
  configurations?: Array<{
    nodes?: Array<{
      cpeMatch?: Array<{
        vulnerable?: boolean;
        criteria?: string;
        versionStartIncluding?: string;
        versionEndExcluding?: string;
      }>;
    }>;
  }>;
}

interface NvdResponse {
  vulnerabilities?: Array<{ cve: NvdCve }>;
  totalResults?: number;
}

export class NvdClient extends BaseDataSourceClient {
  readonly name: DataSourceName = 'NVD';
  readonly requiresAuth = false;

  private apiKey?: string;

  constructor(apiKey?: string) {
    super();
    this.apiKey = apiKey || process.env.NVD_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['apiKey'] = this.apiKey;
      }

      const response = await fetch(`${NVD_API_URL}?resultsPerPage=1`, { headers });
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

    // NVD doesn't support true batch queries, so we query one at a time
    // but with rate limiting consideration
    for (const query of queries) {
      const key = this.generateQueryKey(query);
      const vulns = await this.querySingle(query);
      results.set(key, vulns);

      // Rate limiting: NVD allows 5 requests per 30 seconds without API key
      // With API key: 50 requests per 30 seconds
      const delay = this.apiKey ? 600 : 6000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return results;
  }

  private async querySingle(query: VulnerabilityQuery): Promise<Vulnerability[]> {
    const [groupId, artifactId] = query.name.split(':');
    
    // Skip queries with UNKNOWN version - can't query NVD without a specific version
    if (query.version === 'UNKNOWN' || !query.version) {
      return [];
    }
    
    // Build CPE search string for Maven packages
    const cpeSearch = `cpe:2.3:a:*:${artifactId}:${query.version}:*:*:*:*:*:*:*`;

    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['apiKey'] = this.apiKey;
      }

      const url = `${NVD_API_URL}?cpeName=${encodeURIComponent(cpeSearch)}`;
      const res = await fetch(url, { headers });

      // 404 is normal - means no CVE found for this package (which is good!)
      // Don't treat it as an error
      if (res.status === 404) {
        return [];
      }

      if (!res.ok) {
        // Only log non-404 errors (rate limiting, server errors, etc.)
        console.error(`NVD API error ${res.status} for ${query.name}:${query.version}`);
        return [];
      }

      const response = await res.json() as NvdResponse;

      if (!response.vulnerabilities || response.vulnerabilities.length === 0) {
        return [];
      }

      return response.vulnerabilities.map(v => this.mapVulnerability(v.cve, groupId, artifactId));
    } catch (error) {
      // Only log actual network/parsing errors, not 404s
      console.error(`NVD query error for ${query.name}:${query.version}:`, error);
      return [];
    }
  }

  private mapVulnerability(cve: NvdCve, _groupId: string, _artifactId: string): Vulnerability {
    // Extract CVSS score (prefer v3.1, then v3.0, then v2)
    let cvssScore: number | null = null;
    
    if (cve.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore) {
      cvssScore = cve.metrics.cvssMetricV31[0].cvssData.baseScore;
    } else if (cve.metrics?.cvssMetricV30?.[0]?.cvssData?.baseScore) {
      cvssScore = cve.metrics.cvssMetricV30[0].cvssData.baseScore;
    } else if (cve.metrics?.cvssMetricV2?.[0]?.cvssData?.baseScore) {
      cvssScore = cve.metrics.cvssMetricV2[0].cvssData.baseScore;
    }

    // Extract description (prefer English)
    const description = cve.descriptions?.find(d => d.lang === 'en')?.value 
      || cve.descriptions?.[0]?.value 
      || 'No description available';

    // Extract affected versions
    let affectedVersions = '';
    let fixedVersion: string | null = null;
    
    const cpeMatch = cve.configurations?.[0]?.nodes?.[0]?.cpeMatch?.[0];
    if (cpeMatch) {
      if (cpeMatch.versionStartIncluding) {
        affectedVersions = `>= ${cpeMatch.versionStartIncluding}`;
      }
      if (cpeMatch.versionEndExcluding) {
        affectedVersions += affectedVersions ? `, < ${cpeMatch.versionEndExcluding}` : `< ${cpeMatch.versionEndExcluding}`;
        fixedVersion = cpeMatch.versionEndExcluding;
      }
    }

    // Extract references
    const references = cve.references?.map(r => r.url) || [];

    return {
      id: cve.id,
      source: 'NVD',
      severity: classifySeverity(cvssScore),
      cvssScore,
      description,
      affectedVersions,
      fixedVersion,
      references,
      publishedDate: cve.published || ''
    };
  }
}

export const nvdClient = new NvdClient();
