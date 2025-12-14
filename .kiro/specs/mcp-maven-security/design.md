# Design Document: MCP-MAVEN-SECURITY

## Overview

MCP-MAVEN-SECURITY 是一个基于 Model Context Protocol 的 Maven 依赖漏洞扫描工具。该工具采用 TypeScript 开发，提供异步扫描、本地缓存、增量扫描等高性能特性，支持多种免费漏洞数据源（OSV、OSS Index、NVD）。

### 核心设计目标

1. **高性能** - 批量 API 查询、本地缓存、增量扫描
2. **可扩展** - 插件式数据源架构，易于添加新的漏洞数据库
3. **可靠性** - 多数据源容错、指数退避重试
4. **易用性** - 简洁的 MCP 工具接口，异步非阻塞

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Server Layer                          │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  Tools: scan_project | query_vulnerability | export_report  ││
│  │         get_scan_history | configure_schedule | get_progress││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Core Service Layer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ ScanService  │  │ ReportService│  │   SchedulerService   │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Component Layer                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐ │
│  │ PomParser  │  │VulnScanner │  │CacheManager│  │TaskManager│ │
│  └────────────┘  └────────────┘  └────────────┘  └───────────┘ │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Data Source Layer (Plugin)                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │ OSV Client │  │ OSS Index  │  │ NVD Client │  ... (可扩展)   │
│  └────────────┘  └────────────┘  └────────────┘                 │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Storage Layer                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    SQLite Database                           ││
│  │  Tables: cache | scan_history | scan_tasks | schedules      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Components and Interfaces

### 1. PomParser - POM 文件解析器

```typescript
interface Dependency {
  groupId: string;
  artifactId: string;
  version: string;
  scope?: string;
  optional?: boolean;
}

interface ParseResult {
  projectName: string;
  projectVersion: string;
  dependencies: Dependency[];
  modules: string[];  // 子模块路径
}

interface IPomParser {
  parse(pomPath: string): Promise<ParseResult>;
  parseMultiModule(projectPath: string): Promise<ParseResult>;
  resolveProperties(pom: string, properties: Record<string, string>): string;
}
```

### 2. VulnerabilityScanner - 漏洞扫描器

```typescript
interface Vulnerability {
  id: string;           // CVE ID
  source: string;       // OSV | OSS_INDEX | NVD
  severity: SeverityLevel;
  cvssScore: number | null;
  description: string;
  affectedVersions: string;
  fixedVersion: string | null;
  references: string[];
  publishedDate: string;
}

type SeverityLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNRATED';

interface ScanResult {
  dependency: Dependency;
  vulnerabilities: Vulnerability[];
  fixRecommendation: FixRecommendation | null;
}

interface FixRecommendation {
  currentVersion: string;
  recommendedVersion: string;
  versionJump: string;  // e.g., "minor" | "major" | "patch"
  fixesCount: number;
}

interface IVulnerabilityScanner {
  scan(dependencies: Dependency[]): Promise<ScanResult[]>;
  scanIncremental(dependencies: Dependency[], previousHash: string): Promise<ScanResult[]>;
  getFixRecommendation(dependency: Dependency, vulnerabilities: Vulnerability[]): Promise<FixRecommendation | null>;
}
```

### 3. DataSourceClient - 数据源客户端接口（插件式）

```typescript
interface VulnerabilityQuery {
  ecosystem: 'Maven';
  name: string;      // groupId:artifactId
  version: string;
}

interface IDataSourceClient {
  readonly name: string;
  readonly requiresAuth: boolean;
  
  isAvailable(): Promise<boolean>;
  queryBatch(queries: VulnerabilityQuery[]): Promise<Map<string, Vulnerability[]>>;
  getMaxBatchSize(): number;
}

// OSV 实现 - 免费，无需认证
class OsvClient implements IDataSourceClient {
  readonly name = 'OSV';
  readonly requiresAuth = false;
  getMaxBatchSize() { return 1000; }
}

// OSS Index 实现 - 免费注册
class OssIndexClient implements IDataSourceClient {
  readonly name = 'OSS_INDEX';
  readonly requiresAuth = true;
  getMaxBatchSize() { return 128; }
}

// NVD 实现 - 免费，API Key 可选
class NvdClient implements IDataSourceClient {
  readonly name = 'NVD';
  readonly requiresAuth = false;  // 可选
  getMaxBatchSize() { return 100; }
}
```

### 4. CacheManager - 缓存管理器

```typescript
interface CacheEntry {
  key: string;              // groupId:artifactId:version
  data: Vulnerability[];
  createdAt: number;
  expiresAt: number;
}

interface ICacheManager {
  get(key: string): Promise<Vulnerability[] | null>;
  set(key: string, data: Vulnerability[], ttlHours?: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  getStats(): Promise<{ totalEntries: number; hitRate: number }>;
}
```

### 5. TaskManager - 异步任务管理器

```typescript
type TaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
type TaskPhase = 'PARSING' | 'QUERYING' | 'ANALYZING' | 'GENERATING_REPORT';

interface ScanTask {
  taskId: string;
  projectPath: string;
  status: TaskStatus;
  phase: TaskPhase;
  progress: number;         // 0-100
  estimatedRemaining: number; // seconds
  createdAt: number;
  completedAt: number | null;
  result: ProjectScanResult | null;
  error: string | null;
}

interface ITaskManager {
  createTask(projectPath: string): Promise<string>;
  getTask(taskId: string): Promise<ScanTask | null>;
  updateProgress(taskId: string, phase: TaskPhase, progress: number): Promise<void>;
  completeTask(taskId: string, result: ProjectScanResult): Promise<void>;
  failTask(taskId: string, error: string): Promise<void>;
  listTasks(limit?: number): Promise<ScanTask[]>;
}
```

### 6. ReportGenerator - 报告生成器

```typescript
interface ReportOptions {
  format: 'PDF' | 'TXT';
  severityFilter?: SeverityLevel[];
  outputPath?: string;
}

interface IReportGenerator {
  generate(scanResult: ProjectScanResult, options: ReportOptions): Promise<string>;
  formatVulnerabilityList(vulnerabilities: Vulnerability[]): string;
  generateSummary(scanResult: ProjectScanResult): ReportSummary;
}

interface ReportSummary {
  totalDependencies: number;
  vulnerableDependencies: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  unratedCount: number;
}
```

### 7. Scheduler - 定时调度器

```typescript
interface ScheduleConfig {
  projectPath: string;
  intervalSeconds: number;
  enabled: boolean;
}

interface IScheduler {
  setSchedule(config: ScheduleConfig): Promise<void>;
  getSchedule(projectPath: string): Promise<ScheduleConfig | null>;
  removeSchedule(projectPath: string): Promise<void>;
  listSchedules(): Promise<ScheduleConfig[]>;
  start(): void;
  stop(): void;
}
```

### 8. MCP Server - MCP 工具服务

```typescript
interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

// MCP 工具列表
const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'scan_project',
    description: '扫描 Maven 项目的依赖漏洞',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string', description: '项目根目录路径' },
        full_scan: { type: 'boolean', description: '是否强制全量扫描', default: false }
      },
      required: ['project_path']
    }
  },
  {
    name: 'get_scan_progress',
    description: '获取扫描任务进度',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID' }
      },
      required: ['task_id']
    }
  },
  {
    name: 'query_vulnerability',
    description: '查询指定依赖的漏洞信息',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string' },
        artifact_id: { type: 'string' },
        version: { type: 'string' }
      },
      required: ['group_id', 'artifact_id', 'version']
    }
  },
  {
    name: 'export_report',
    description: '导出漏洞报告',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '扫描任务 ID' },
        format: { type: 'string', enum: ['PDF', 'TXT'], default: 'TXT' },
        severity_filter: { 
          type: 'array', 
          items: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] }
        }
      },
      required: ['task_id']
    }
  },
  {
    name: 'get_scan_history',
    description: '获取扫描历史记录',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string' },
        limit: { type: 'number', default: 10 }
      },
      required: ['project_path']
    }
  },
  {
    name: 'configure_schedule',
    description: '配置定时扫描',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: { type: 'string' },
        interval_seconds: { type: 'number', description: '扫描间隔（秒）' },
        enabled: { type: 'boolean', default: true }
      },
      required: ['project_path', 'interval_seconds']
    }
  },
  {
    name: 'clear_cache',
    description: '清除漏洞缓存',
    inputSchema: {
      type: 'object',
      properties: {
        dependency_key: { type: 'string', description: '指定依赖 key，不填则清除全部' }
      }
    }
  },
  {
    name: 'get_config_status',
    description: '获取配置状态和可用数据源',
    inputSchema: { type: 'object', properties: {} }
  }
];
```

## Data Models

### SQLite 数据库表结构

```sql
-- 漏洞缓存表
CREATE TABLE cache (
  key TEXT PRIMARY KEY,           -- groupId:artifactId:version
  data TEXT NOT NULL,             -- JSON: Vulnerability[]
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_cache_expires ON cache(expires_at);

-- 扫描任务表
CREATE TABLE scan_tasks (
  task_id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  status TEXT NOT NULL,           -- PENDING | RUNNING | COMPLETED | FAILED
  phase TEXT,                     -- PARSING | QUERYING | ANALYZING | GENERATING_REPORT
  progress INTEGER DEFAULT 0,
  estimated_remaining INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  result TEXT,                    -- JSON: ProjectScanResult
  error TEXT
);

CREATE INDEX idx_tasks_project ON scan_tasks(project_path);
CREATE INDEX idx_tasks_status ON scan_tasks(status);

-- 扫描历史表
CREATE TABLE scan_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependencies_hash TEXT NOT NULL,
  total_dependencies INTEGER,
  vulnerable_count INTEGER,
  critical_count INTEGER,
  high_count INTEGER,
  medium_count INTEGER,
  low_count INTEGER,
  scanned_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES scan_tasks(task_id)
);

CREATE INDEX idx_history_project ON scan_history(project_path);

-- 定时任务表
CREATE TABLE schedules (
  project_path TEXT PRIMARY KEY,
  interval_seconds INTEGER NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER
);
```

### 项目扫描结果

```typescript
interface ProjectScanResult {
  taskId: string;
  projectPath: string;
  projectName: string;
  scannedAt: string;
  totalDependencies: number;
  dependenciesHash: string;
  scanResults: ScanResult[];
  summary: ReportSummary;
  newVulnerabilities: Vulnerability[];  // 相比上次扫描新发现的
}
```



## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: POM 解析完整性

*For any* valid pom.xml 文件，解析后返回的依赖列表应包含文件中声明的所有直接依赖，且每个依赖都包含完整的 groupId、artifactId 和 version。

**Validates: Requirements 1.1, 1.5**

### Property 2: 属性占位符解析一致性

*For any* pom.xml 中使用 `${property.name}` 格式的版本占位符，解析器应将其替换为 properties 节中定义的实际值。如果属性未定义，应返回错误而非空值。

**Validates: Requirements 1.3**

### Property 3: 多模块依赖去重

*For any* 多模块 Maven 项目，聚合后的依赖列表中不应存在重复的 groupId:artifactId:version 组合。

**Validates: Requirements 1.7**

### Property 4: CVSS 分级正确性

*For any* CVSS 分数 score，分级函数应满足：
- 9.0 ≤ score ≤ 10.0 → CRITICAL
- 7.0 ≤ score < 9.0 → HIGH
- 4.0 ≤ score < 7.0 → MEDIUM
- 0.1 ≤ score < 4.0 → LOW
- score 为 null → UNRATED

**Validates: Requirements 3.1, 3.4**

### Property 5: 漏洞排序一致性

*For any* 漏洞列表，排序后的结果应满足：对于任意相邻的两个漏洞 v[i] 和 v[i+1]，v[i] 的严重程度应大于或等于 v[i+1]。

**Validates: Requirements 3.2**

### Property 6: 严重程度过滤正确性

*For any* 漏洞列表和严重程度过滤条件，过滤后的结果应只包含匹配指定严重程度的漏洞，且不遗漏任何匹配项。

**Validates: Requirements 3.3**

### Property 7: 缓存命中行为

*For any* 已缓存且未过期的依赖查询，Cache_Manager 应返回缓存数据而不调用外部 API。缓存键为 groupId:artifactId:version 格式。

**Validates: Requirements 8.2, 8.3**

### Property 8: 缓存过期处理

*For any* 缓存条目，当当前时间超过 expiresAt 时，该条目应被视为无效，后续查询应触发外部 API 调用并更新缓存。

**Validates: Requirements 8.4**

### Property 9: 增量扫描正确性

*For any* 两次连续扫描，如果依赖哈希相同，则第二次扫描应返回上次结果；如果哈希不同，则只查询变更的依赖。

**Validates: Requirements 9.2, 9.3, 9.4**

### Property 10: 依赖哈希确定性

*For any* 相同的依赖列表（相同的 groupId:artifactId:version 集合），计算的哈希值应相同，与依赖的顺序无关。

**Validates: Requirements 9.1**

### Property 11: 异步任务生命周期

*For any* 扫描任务，其状态转换应遵循：PENDING → RUNNING → (COMPLETED | FAILED)。任务完成后应存储结果或错误信息。

**Validates: Requirements 10.1, 10.4, 10.5**

### Property 12: 进度追踪单调性

*For any* 正在运行的扫描任务，进度值应单调递增（0 到 100），不应出现进度回退。

**Validates: Requirements 10.2, 10.3**

### Property 13: 修复版本推荐正确性

*For any* 存在漏洞的依赖，如果存在修复版本，推荐的版本应修复所有已知漏洞，且版本号应大于当前版本。

**Validates: Requirements 11.1, 11.2**

### Property 14: 批量查询大小限制

*For any* 批量漏洞查询，单次 API 请求的依赖数量不应超过数据源的最大批量大小（OSV: 1000, OSS Index: 128, NVD: 100）。

**Validates: Requirements 2.5**

### Property 15: 报告内容完整性

*For any* 生成的报告，应包含：扫描时间戳、项目名称、依赖总数、各严重程度漏洞数量统计、详细漏洞列表。

**Validates: Requirements 5.3**

### Property 16: 报告过滤一致性

*For any* 带严重程度过滤的报告导出，报告中的漏洞应与过滤条件匹配，不应包含被过滤掉的漏洞。

**Validates: Requirements 5.4**

### Property 17: 新漏洞检测正确性

*For any* 两次扫描结果的对比，标记为"新发现"的漏洞应满足：该漏洞在当前扫描中存在，但在上次扫描中不存在。

**Validates: Requirements 4.4**

### Property 18: 错误响应结构一致性

*For any* 无效的 MCP 工具调用参数，返回的错误响应应包含错误码和参数验证详情，格式应与正常响应保持一致的 JSON 结构。

**Validates: Requirements 6.2, 12.4**

## Error Handling

### 错误类型定义

```typescript
enum ErrorCode {
  // 解析错误 (1xxx)
  POM_NOT_FOUND = 1001,
  POM_PARSE_ERROR = 1002,
  PROPERTY_NOT_RESOLVED = 1003,
  
  // API 错误 (2xxx)
  API_UNAVAILABLE = 2001,
  API_RATE_LIMITED = 2002,
  API_AUTH_FAILED = 2003,
  API_TIMEOUT = 2004,
  
  // 缓存错误 (3xxx)
  CACHE_READ_ERROR = 3001,
  CACHE_WRITE_ERROR = 3002,
  
  // 任务错误 (4xxx)
  TASK_NOT_FOUND = 4001,
  TASK_ALREADY_RUNNING = 4002,
  
  // 报告错误 (5xxx)
  REPORT_GENERATION_FAILED = 5001,
  INVALID_OUTPUT_PATH = 5002,
  
  // 参数错误 (6xxx)
  INVALID_PARAMETER = 6001,
  MISSING_REQUIRED_PARAMETER = 6002
}

interface AppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}
```

### 错误处理策略

1. **API 失败容错**：主数据源失败时自动切换到备用数据源
2. **重试机制**：网络错误使用指数退避重试（最多 3 次）
3. **优雅降级**：部分功能失败不影响整体扫描
4. **详细日志**：所有错误记录到日志文件，包含上下文信息

## Testing Strategy

### 单元测试

使用 Vitest 作为测试框架，覆盖以下场景：

1. **PomParser 测试**
   - 解析标准 pom.xml
   - 解析带 parent 的 pom.xml
   - 属性占位符解析
   - 多模块项目解析
   - 错误处理（文件不存在、格式错误）

2. **CVSS 分级测试**
   - 边界值测试（9.0, 7.0, 4.0, 0.1）
   - null 值处理

3. **CacheManager 测试**
   - 缓存存取
   - 过期处理
   - 清除功能

4. **TaskManager 测试**
   - 任务创建和状态转换
   - 进度更新

### 属性测试

使用 fast-check 库进行属性测试，每个属性测试运行至少 100 次迭代。

测试标注格式：`**Feature: mcp-maven-security, Property {number}: {property_text}**`

1. **Property 4 测试**：生成随机 CVSS 分数，验证分级正确性
2. **Property 5 测试**：生成随机漏洞列表，验证排序后的顺序
3. **Property 6 测试**：生成随机漏洞和过滤条件，验证过滤结果
4. **Property 7 测试**：生成随机依赖，验证缓存命中行为
5. **Property 10 测试**：生成随机依赖列表（不同顺序），验证哈希一致性
6. **Property 12 测试**：模拟进度更新序列，验证单调性

### 集成测试

1. **端到端扫描测试**：使用真实的小型 Maven 项目
2. **MCP 工具调用测试**：验证所有工具的参数验证和响应格式
3. **定时任务测试**：验证调度器的触发和执行

### 测试覆盖率目标

- 核心业务逻辑：≥ 80%
- 工具函数：≥ 90%
- 错误处理路径：≥ 70%
