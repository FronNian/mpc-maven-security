/**
 * MCP Server for Maven Security Scanner
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { initDatabase } from '../cache/database.js';
import { PomParser } from '../parsers/pom-parser.js';
import { VulnerabilityScanner } from '../scanners/vulnerability-scanner.js';
import { CacheManager } from '../cache/cache-manager.js';
import { TaskManager } from '../tasks/task-manager.js';
import { ReportGenerator } from '../reporters/report-generator.js';
import { Scheduler } from '../schedulers/scheduler.js';
import { loadConfig, getDataSourceStatus } from '../utils/config.js';
import { ProjectScanResult, SeverityLevel, ReportFormat } from '../types/index.js';
import { ErrorCode, createError, MavenSecurityError } from '../types/errors.js';
// Hash utility imported for potential future use

export class McpServer {
  private server: Server;
  private pomParser: PomParser;
  private scanner: VulnerabilityScanner;
  private cacheManager: CacheManager;
  private taskManager: TaskManager;
  private reportGenerator: ReportGenerator;
  private scheduler: Scheduler;

  constructor() {
    this.server = new Server(
      { name: 'mcp-maven-security', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // Initialize components
    initDatabase();
    this.pomParser = new PomParser();
    this.cacheManager = new CacheManager();
    this.scanner = new VulnerabilityScanner(this.cacheManager);
    this.taskManager = new TaskManager();
    this.reportGenerator = new ReportGenerator();
    this.scheduler = new Scheduler();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
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
              severity_filter: { type: 'array', items: { type: 'string' } }
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
              interval: { type: 'string', description: '扫描间隔，如 30s, 5m, 1h' },
              enabled: { type: 'boolean', default: true }
            },
            required: ['project_path', 'interval']
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
      ]
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'scan_project':
            return await this.handleScanProject(args as { project_path: string; full_scan?: boolean });
          case 'get_scan_progress':
            return await this.handleGetProgress(args as { task_id: string });
          case 'query_vulnerability':
            return await this.handleQueryVulnerability(args as { group_id: string; artifact_id: string; version: string });
          case 'export_report':
            return await this.handleExportReport(args as { task_id: string; format?: string; severity_filter?: string[] });
          case 'get_scan_history':
            return await this.handleGetHistory(args as { project_path: string; limit?: number });
          case 'configure_schedule':
            return await this.handleConfigureSchedule(args as { project_path: string; interval: string; enabled?: boolean });
          case 'clear_cache':
            return await this.handleClearCache(args as { dependency_key?: string });
          case 'get_config_status':
            return await this.handleGetConfigStatus();
          default:
            throw createError(ErrorCode.INVALID_PARAMETER, `Unknown tool: ${name}`);
        }
      } catch (error) {
        return this.formatError(error);
      }
    });
  }


  private async handleScanProject(args: { project_path: string; full_scan?: boolean }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { project_path, full_scan = false } = args;

    // Create task
    const taskId = await this.taskManager.createTask(project_path);

    // Run scan asynchronously
    this.runScanAsync(taskId, project_path, full_scan);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ taskId, status: 'PENDING', message: '扫描任务已创建' })
      }]
    };
  }

  private async runScanAsync(taskId: string, projectPath: string, fullScan: boolean): Promise<void> {
    try {
      // Phase 1: Parsing
      await this.taskManager.updateProgress(taskId, 'PARSING', 10);
      const parseResult = await this.pomParser.parseMultiModule(projectPath);

      // Phase 2: Querying
      await this.taskManager.updateProgress(taskId, 'QUERYING', 30);
      
      // Get previous hash for incremental scan
      const history = await this.taskManager.getScanHistory(projectPath, 1);
      const previousHash = history.length > 0 ? history[0].dependenciesHash : null;

      const scanData = await this.scanner.scanIncremental(
        parseResult.dependencies,
        previousHash,
        fullScan
      );

      await this.taskManager.updateProgress(taskId, 'ANALYZING', 70);

      // Phase 3: Analyzing
      const allVulnerabilities = scanData.results.flatMap(r => r.vulnerabilities);
      const newVulnerabilities = await this.taskManager.detectNewVulnerabilities(
        projectPath,
        allVulnerabilities
      );

      const summary = this.reportGenerator.generateSummary({
        taskId,
        projectPath,
        projectName: parseResult.projectName,
        scannedAt: new Date().toISOString(),
        totalDependencies: parseResult.dependencies.length,
        dependenciesHash: scanData.hash,
        scanResults: scanData.results,
        summary: { totalDependencies: 0, vulnerableDependencies: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, unratedCount: 0 },
        newVulnerabilities: []
      });

      const result: ProjectScanResult = {
        taskId,
        projectPath,
        projectName: parseResult.projectName,
        scannedAt: new Date().toISOString(),
        totalDependencies: parseResult.dependencies.length,
        dependenciesHash: scanData.hash,
        scanResults: scanData.results,
        summary,
        newVulnerabilities
      };

      await this.taskManager.completeTask(taskId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.taskManager.failTask(taskId, message);
    }
  }

  private async handleGetProgress(args: { task_id: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const task = await this.taskManager.getTask(args.task_id);
    
    if (!task) {
      throw createError(ErrorCode.TASK_NOT_FOUND, `Task not found: ${args.task_id}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          taskId: task.taskId,
          status: task.status,
          phase: task.phase,
          progress: task.progress,
          estimatedRemaining: task.estimatedRemaining,
          error: task.error,
          result: task.status === 'COMPLETED' ? task.result : undefined
        })
      }]
    };
  }

  private async handleQueryVulnerability(args: { group_id: string; artifact_id: string; version: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const results = await this.scanner.scan([{
      groupId: args.group_id,
      artifactId: args.artifact_id,
      version: args.version
    }]);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(results[0])
      }]
    };
  }

  private async handleExportReport(args: { task_id: string; format?: string; severity_filter?: string[] }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const task = await this.taskManager.getTask(args.task_id);
    
    if (!task || !task.result) {
      throw createError(ErrorCode.TASK_NOT_FOUND, `Task not found or not completed: ${args.task_id}`);
    }

    const filePath = await this.reportGenerator.generate(task.result, {
      format: (args.format || 'TXT') as ReportFormat,
      severityFilter: args.severity_filter as SeverityLevel[] | undefined
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ filePath, message: '报告已生成' })
      }]
    };
  }

  private async handleGetHistory(args: { project_path: string; limit?: number }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const history = await this.taskManager.getScanHistory(args.project_path, args.limit || 10);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(history)
      }]
    };
  }

  private async handleConfigureSchedule(args: { project_path: string; interval: string; enabled?: boolean }): Promise<{ content: Array<{ type: string; text: string }> }> {
    const intervalSeconds = Scheduler.parseInterval(args.interval);

    await this.scheduler.setSchedule({
      projectPath: args.project_path,
      intervalSeconds,
      enabled: args.enabled !== false
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ message: '定时扫描已配置', intervalSeconds, enabled: args.enabled !== false })
      }]
    };
  }

  private async handleClearCache(args: { dependency_key?: string }): Promise<{ content: Array<{ type: string; text: string }> }> {
    if (args.dependency_key) {
      await this.cacheManager.delete(args.dependency_key);
    } else {
      await this.cacheManager.clear();
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ message: '缓存已清除' })
      }]
    };
  }

  private async handleGetConfigStatus(): Promise<{ content: Array<{ type: string; text: string }> }> {
    const config = loadConfig();
    const dataSources = await getDataSourceStatus(this.scanner);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ dataSources, cacheExpirationHours: config.cacheExpirationHours })
      }]
    };
  }

  private formatError(error: unknown): { content: Array<{ type: string; text: string }>; isError: true } {
    if (error instanceof MavenSecurityError) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(error.toAppError())
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          code: ErrorCode.UNKNOWN_ERROR,
          message: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString()
        })
      }],
      isError: true
    };
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    
    // Start scheduler
    this.scheduler.setScanCallback(async (projectPath) => {
      const taskId = await this.taskManager.createTask(projectPath);
      await this.runScanAsync(taskId, projectPath, false);
    });
    await this.scheduler.start();

    console.error('MCP Maven Security server started');
  }
}
