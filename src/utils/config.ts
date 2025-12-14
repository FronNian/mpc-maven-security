/**
 * Configuration management
 */

import { AppConfig, DataSourceStatus } from '../types/index.js';
import { VulnerabilityScanner } from '../scanners/vulnerability-scanner.js';

/**
 * Load configuration from environment variables
 */
export function loadConfig(): AppConfig {
  return {
    nvdApiKey: process.env.NVD_API_KEY,
    ossIndexUser: process.env.OSS_INDEX_USER,
    ossIndexToken: process.env.OSS_INDEX_TOKEN,
    cacheExpirationHours: parseInt(process.env.CACHE_EXPIRATION_HOURS || '24', 10),
    maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '1000', 10)
  };
}

/**
 * Get data source availability status
 */
export async function getDataSourceStatus(scanner: VulnerabilityScanner): Promise<DataSourceStatus[]> {
  const config = loadConfig();
  const availableSources = await scanner.getAvailableDataSources();

  return [
    {
      name: 'OSV',
      available: availableSources.includes('OSV'),
      authenticated: false // OSV doesn't require auth
    },
    {
      name: 'OSS_INDEX',
      available: availableSources.includes('OSS_INDEX'),
      authenticated: !!(config.ossIndexUser && config.ossIndexToken)
    },
    {
      name: 'NVD',
      available: availableSources.includes('NVD'),
      authenticated: !!config.nvdApiKey
    }
  ];
}

/**
 * Validate configuration and log warnings
 */
export function validateConfig(): void {
  const config = loadConfig();

  if (!config.ossIndexUser || !config.ossIndexToken) {
    console.warn('OSS Index credentials not configured. Set OSS_INDEX_USER and OSS_INDEX_TOKEN for additional vulnerability data.');
  }

  if (!config.nvdApiKey) {
    console.warn('NVD API key not configured. Set NVD_API_KEY for faster NVD queries.');
  }
}
