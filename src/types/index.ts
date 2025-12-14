/**
 * Core type definitions for MCP-MAVEN-SECURITY
 */

// ============ Dependency Types ============

export interface Dependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: string;
  optional?: boolean;
}

export interface ParseResult {
  projectName: string;
  projectVersion: string;
  dependencies: Dependency[];
  modules: string[];
}

// ============ Vulnerability Types ============

export type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNRATED';

export interface Vulnerability {
  id: string;
  source: DataSourceName;
  severity: SeverityLevel;
  cvssScore: number | null;
  description: string;
  affectedVersions: string;
  fixedVersion: string | null;
  references: string[];
  publishedDate: string;
}

export interface FixRecommendation {
  currentVersion: string;
  recommendedVersion: string;
  versionJump: 'patch' | 'minor' | 'major';
  fixesCount: number;
}

export interface ScanResult {
  dependency: Dependency;
  vulnerabilities: Vulnerability[];
  fixRecommendation: FixRecommendation | null;
}

// ============ Data Source Types ============

export type DataSourceName = 'OSV' | 'OSS_INDEX' | 'NVD';

export interface VulnerabilityQuery {
  ecosystem: 'Maven';
  name: string;
  version: string;
}

export interface IDataSourceClient {
  readonly name: DataSourceName;
  readonly requiresAuth: boolean;
  isAvailable(): Promise<boolean>;
  queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>>;
  getMaxBatchSize(): number;
}


// ============ Task Types ============

export type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type TaskPhase = 'PARSING' | 'QUERYING' | 'ANALYZING' | 'GENERATING_REPORT';

export interface ScanTask {
  taskId: string;
  projectPath: string;
  status: TaskStatus;
  phase: TaskPhase;
  progress: number;
  estimatedRemaining: number;
  createdAt: number;
  completedAt: number | null;
  result: ProjectScanResult | null;
  error: string | null;
}

export interface ProjectScanResult {
  taskId: string;
  projectPath: string;
  projectName: string;
  scannedAt: string;
  totalDependencies: number;
  dependenciesHash: string;
  scanResults: ScanResult[];
  summary: ReportSummary;
  newVulnerabilities: Vulnerability[];
}

export interface ReportSummary {
  totalDependencies: number;
  vulnerableDependencies: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  unratedCount: number;
}

// ============ Report Types ============

export type ReportFormat = 'PDF' | 'TXT';

export interface ReportOptions {
  format: ReportFormat;
  severityFilter?: SeverityLevel[];
  outputPath?: string;
}

// ============ Schedule Types ============

export interface ScheduleConfig {
  projectPath: string;
  intervalSeconds: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
}

// ============ Cache Types ============

export interface CacheEntry {
  key: string;
  data: Vulnerability[];
  createdAt: number;
  expiresAt: number;
}

// ============ Config Types ============

export interface AppConfig {
  nvdApiKey?: string;
  ossIndexUser?: string;
  ossIndexToken?: string;
  cacheExpirationHours: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface DataSourceStatus {
  name: DataSourceName;
  available: boolean;
  authenticated: boolean;
}
