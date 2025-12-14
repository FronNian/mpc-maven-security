# Requirements Document

## Introduction

MCP-MAVEN-SECURITY 是一个 Model Context Protocol (MCP) 工具，旨在帮助 AI 助手查询和分析 Java Maven 项目中的依赖漏洞信息。该工具通过解析 pom.xml 文件，利用免费的漏洞数据库 API（如 OSV、NVD、Sonatype OSS Index）查询依赖的安全漏洞，并支持定时扫描、漏洞报告导出、本地缓存、增量扫描等功能。工具设计为高性能异步架构，支持大型项目的快速扫描。

## Glossary

- **MCP (Model Context Protocol)**: 一种允许 AI 助手与外部工具交互的协议标准
- **Maven**: Java 项目的依赖管理和构建工具
- **pom.xml**: Maven 项目的配置文件，包含项目依赖信息
- **CVE (Common Vulnerabilities and Exposures)**: 通用漏洞披露标识符
- **CVSS (Common Vulnerability Scoring System)**: 通用漏洞评分系统，用于评估漏洞严重程度
- **OSV (Open Source Vulnerabilities)**: Google 维护的开源漏洞数据库，完全免费
- **NVD (National Vulnerability Database)**: 美国国家漏洞数据库，免费但需 API 密钥获得更高速率
- **Sonatype OSS Index**: Sonatype 提供的开源软件漏洞索引服务，免费注册使用
- **Vulnerability_Scanner**: 本系统的漏洞扫描核心组件
- **Report_Generator**: 本系统的报告生成组件
- **Scheduler**: 本系统的定时任务调度组件
- **Cache_Manager**: 本系统的缓存管理组件
- **Dependency_Coordinates**: 依赖坐标，格式为 groupId:artifactId:version

## Requirements

### Requirement 1: POM 文件解析

**User Story:** As a 开发者, I want to 解析 Maven 项目的 pom.xml 文件, so that 系统能够提取所有依赖信息用于漏洞查询。

#### Acceptance Criteria 1

1. WHEN the Vulnerability_Scanner receives a project path THEN the Vulnerability_Scanner SHALL locate and parse the pom.xml file extracting all direct dependencies including groupId, artifactId, and version
2. WHEN the pom.xml contains parent POM references THEN the Vulnerability_Scanner SHALL resolve inherited dependencies from parent POM
3. WHEN the pom.xml uses property placeholders for versions THEN the Vulnerability_Scanner SHALL resolve the actual version values from properties section
4. WHEN the pom.xml file is malformed or missing THEN the Vulnerability_Scanner SHALL return a descriptive error message indicating the parsing failure reason
5. WHEN parsing completes successfully THEN the Vulnerability_Scanner SHALL return a structured list of dependencies with their Dependency_Coordinates
6. WHEN the project is a multi-module Maven project THEN the Vulnerability_Scanner SHALL recursively scan all child module pom.xml files
7. WHEN scanning multi-module project THEN the Vulnerability_Scanner SHALL aggregate dependencies from all modules and deduplicate by Dependency_Coordinates

### Requirement 2: 漏洞数据查询

**User Story:** As a 开发者, I want to 查询依赖的漏洞信息, so that 我能够了解项目中存在的安全风险。

#### Acceptance Criteria 2

1. WHEN the Vulnerability_Scanner queries dependencies THEN the Vulnerability_Scanner SHALL use OSV API as the primary free data source with batch query support
2. WHEN OSV API is unavailable THEN the Vulnerability_Scanner SHALL fallback to Sonatype OSS Index API
3. WHERE NVD API key is configured THEN the Vulnerability_Scanner SHALL include NVD as an additional data source
4. WHEN a vulnerability is found THEN the Vulnerability_Scanner SHALL return CVE ID, CVSS score, severity level, description, affected version range, and fixed version recommendation
5. WHEN querying multiple dependencies THEN the Vulnerability_Scanner SHALL use batch API endpoints to query up to 1000 packages per request
6. WHEN API rate limits are exceeded THEN the Vulnerability_Scanner SHALL implement exponential backoff retry strategy with maximum 3 retries

### Requirement 3: 漏洞严重程度分级

**User Story:** As a 安全管理员, I want to 按严重程度对漏洞进行分级, so that 我能够优先处理高危漏洞。

#### Acceptance Criteria 3

1. WHEN a vulnerability has a CVSS score THEN the Vulnerability_Scanner SHALL classify it as: Critical (9.0-10.0), High (7.0-8.9), Medium (4.0-6.9), Low (0.1-3.9)
2. WHEN displaying vulnerability results THEN the Vulnerability_Scanner SHALL sort vulnerabilities by severity level in descending order
3. WHEN filtering by severity THEN the Vulnerability_Scanner SHALL return only vulnerabilities matching the specified severity levels
4. WHEN a vulnerability lacks a CVSS score THEN the Vulnerability_Scanner SHALL mark it as "Unrated" and include it in results

### Requirement 4: 定时扫描功能

**User Story:** As a 开发者, I want to 设置定时自动扫描, so that 我能够持续监控项目的安全状态。

#### Acceptance Criteria 4

1. WHEN the user configures a scan schedule THEN the Scheduler SHALL accept interval in hours, minutes, or seconds format
2. WHEN a scheduled scan time arrives THEN the Scheduler SHALL automatically trigger a full project scan
3. WHEN a scheduled scan completes THEN the Scheduler SHALL store the scan results with timestamp in local database
4. WHEN a new vulnerability is detected compared to previous scan THEN the Scheduler SHALL flag it as newly discovered
5. WHEN the user requests scan history THEN the Scheduler SHALL return the last 10 scan results with timestamps and summary

### Requirement 5: 报告导出功能

**User Story:** As a 安全管理员, I want to 导出漏洞报告, so that 我能够与团队分享安全状态并存档。

#### Acceptance Criteria 5

1. WHEN the user requests a PDF report THEN the Report_Generator SHALL generate a formatted PDF file in the project root directory
2. WHEN the user requests a TXT report THEN the Report_Generator SHALL generate a plain text file in the project root directory
3. WHEN generating a report THEN the Report_Generator SHALL include: scan timestamp, project name, total dependencies count, vulnerabilities summary by severity, and detailed vulnerability list with fix recommendations
4. WHEN the user specifies severity filter for export THEN the Report_Generator SHALL include only vulnerabilities matching the specified severity levels
5. WHEN the report file is generated THEN the Report_Generator SHALL return the absolute file path of the generated report
6. WHEN generating report THEN the Report_Generator SHALL format the report with clear sections and readable layout

### Requirement 6: MCP 工具接口

**User Story:** As a AI 助手, I want to 通过 MCP 协议调用漏洞扫描功能, so that 我能够帮助开发者分析项目安全状态。

#### Acceptance Criteria 6

1. WHEN the MCP server starts THEN the MCP server SHALL expose tools for: scan_project, query_vulnerability, get_scan_history, export_report, configure_schedule, get_scan_progress, clear_cache
2. WHEN a tool is called with invalid parameters THEN the MCP server SHALL return a structured error response with parameter validation details
3. WHEN a scan completes THEN the MCP server SHALL return results in JSON format with consistent schema
4. WHEN the MCP server initializes THEN the MCP server SHALL validate API key configurations and report available data sources
5. WHEN scan_project is called THEN the MCP server SHALL accept project_path parameter and return task_id for async tracking

### Requirement 7: API 密钥配置

**User Story:** As a 开发者, I want to 配置 API 密钥, so that 我能够使用需要认证的漏洞数据源。

#### Acceptance Criteria 7

1. WHEN the system starts THEN the system SHALL read API keys from environment variables (NVD_API_KEY, OSS_INDEX_USER, OSS_INDEX_TOKEN)
2. WHERE no API keys are configured THEN the system SHALL operate using only free unauthenticated APIs (OSV)
3. WHEN an API key is invalid THEN the system SHALL log a warning and continue with remaining valid data sources
4. WHEN the user queries configuration status THEN the system SHALL return which data sources are available based on configured keys

### Requirement 8: 本地缓存机制

**User Story:** As a 开发者, I want to 缓存漏洞查询结果, so that 重复查询时能够快速响应并减少 API 调用。

#### Acceptance Criteria 8

1. WHEN a vulnerability query completes THEN the Cache_Manager SHALL store the result with dependency coordinates as key and 24-hour expiration time
2. WHEN querying a dependency THEN the Cache_Manager SHALL first check local cache before calling external APIs
3. WHEN cache entry exists and is valid THEN the Cache_Manager SHALL return cached result without external API call
4. WHEN cache entry is expired THEN the Cache_Manager SHALL refresh the data from external APIs
5. WHEN the user requests cache clear THEN the Cache_Manager SHALL remove all cached entries and return confirmation
6. WHEN storing cache THEN the Cache_Manager SHALL use SQLite database for persistent storage across sessions

### Requirement 9: 增量扫描功能

**User Story:** As a 开发者, I want to 只扫描变更的依赖, so that 后续扫描能够快速完成。

#### Acceptance Criteria 9

1. WHEN a scan completes THEN the Vulnerability_Scanner SHALL store a hash of all dependency coordinates for the project
2. WHEN starting a new scan THEN the Vulnerability_Scanner SHALL compare current dependencies with stored hash to identify changes
3. WHEN dependencies have changed THEN the Vulnerability_Scanner SHALL only query vulnerabilities for new or updated dependencies
4. WHEN dependencies have not changed THEN the Vulnerability_Scanner SHALL return previous scan results with updated timestamp
5. WHEN the user requests full scan THEN the Vulnerability_Scanner SHALL ignore incremental optimization and scan all dependencies

### Requirement 10: 异步扫描与进度跟踪

**User Story:** As a 开发者, I want to 在后台执行扫描并查看进度, so that 扫描大型项目时不会阻塞我的工作。

#### Acceptance Criteria 10

1. WHEN a scan is initiated THEN the Vulnerability_Scanner SHALL return immediately with a unique task_id
2. WHEN scan is in progress THEN the Vulnerability_Scanner SHALL track progress as percentage and current phase (parsing, querying, analyzing)
3. WHEN the user queries progress with task_id THEN the Vulnerability_Scanner SHALL return current percentage, phase, and estimated remaining time
4. WHEN scan completes THEN the Vulnerability_Scanner SHALL store results and mark task as completed
5. WHEN scan fails THEN the Vulnerability_Scanner SHALL store error details and mark task as failed with reason

### Requirement 11: 漏洞修复建议

**User Story:** As a 开发者, I want to 获取漏洞修复建议, so that 我能够快速升级到安全版本。

#### Acceptance Criteria 11

1. WHEN a vulnerability is found THEN the Vulnerability_Scanner SHALL query and return the minimum safe version that fixes the vulnerability
2. WHEN multiple vulnerabilities affect same dependency THEN the Vulnerability_Scanner SHALL recommend the version that fixes all vulnerabilities
3. WHEN no fix version is available THEN the Vulnerability_Scanner SHALL indicate "No fix available" and suggest alternative libraries if known
4. WHEN displaying fix recommendations THEN the Vulnerability_Scanner SHALL show current version, recommended version, and version jump distance

### Requirement 12: 项目结构规范

**User Story:** As a 开发者, I want to 遵循清晰的项目结构, so that 代码易于维护和扩展。

#### Acceptance Criteria 12

1. WHEN organizing source code THEN the project SHALL follow modular architecture with separate directories for: parsers, scanners, reporters, schedulers, cache, and mcp-server
2. WHEN implementing components THEN each component SHALL have a single responsibility and clear TypeScript interface
3. WHEN adding new data sources THEN the scanner module SHALL support plugin-style extension without modifying existing code
4. WHEN handling errors THEN all components SHALL use consistent error types with error codes and structured logging
5. WHEN implementing the project THEN the project SHALL use TypeScript with strict mode enabled for type safety
