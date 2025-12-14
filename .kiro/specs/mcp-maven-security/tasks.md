# Implementation Plan

- [x] 1. 项目初始化和基础架构



  - [x] 1.1 初始化 TypeScript 项目

    - 创建 package.json，配置 TypeScript 严格模式
    - 安装依赖：@modelcontextprotocol/sdk, better-sqlite3, fast-xml-parser, pdfkit, fast-check, vitest
    - 配置 tsconfig.json 和 ESLint
    - _Requirements: 12.5_
  - [x] 1.2 创建项目目录结构


    - 创建目录：src/parsers, src/scanners, src/cache, src/tasks, src/reporters, src/schedulers, src/mcp, src/types, src/utils
    - 创建入口文件 src/index.ts
    - _Requirements: 12.1_
  - [x] 1.3 定义核心类型和接口


    - 创建 src/types/index.ts，定义 Dependency, Vulnerability, SeverityLevel, ScanResult 等类型
    - 创建 src/types/errors.ts，定义 ErrorCode 枚举和 AppError 接口
    - _Requirements: 12.2, 12.4_

- [-] 2. POM 解析器实现

  - [x] 2.1 实现基础 POM 解析功能


    - 创建 src/parsers/pom-parser.ts
    - 实现 parse() 方法解析单个 pom.xml
    - 提取 groupId, artifactId, version
    - _Requirements: 1.1, 1.5_
  - [ ]* 2.2 编写 POM 解析属性测试
    - **Property 1: POM 解析完整性**
    - **Validates: Requirements 1.1, 1.5**
  - [x] 2.3 实现属性占位符解析

    - 实现 resolveProperties() 方法
    - 支持 ${property.name} 格式的版本占位符
    - _Requirements: 1.3_
  - [ ]* 2.4 编写属性占位符解析属性测试
    - **Property 2: 属性占位符解析一致性**
    - **Validates: Requirements 1.3**
  - [x] 2.5 实现 Parent POM 解析


    - 支持 parent 标签的继承解析
    - 合并父 POM 的依赖和属性
    - _Requirements: 1.2_
  - [x] 2.6 实现多模块项目解析

    - 实现 parseMultiModule() 方法
    - 递归扫描所有子模块
    - 聚合并去重依赖
    - _Requirements: 1.6, 1.7_
  - [ ]* 2.7 编写多模块去重属性测试
    - **Property 3: 多模块依赖去重**
    - **Validates: Requirements 1.7**

  - [ ] 2.8 实现解析错误处理
    - 处理文件不存在、格式错误等情况
    - 返回结构化错误信息
    - _Requirements: 1.4_

- [x] 3. Checkpoint - 确保所有测试通过


  - Ensure all tests pass, ask the user if questions arise.

- [-] 4. 漏洞严重程度分级实现


  - [x] 4.1 实现 CVSS 分级函数

    - 创建 src/utils/severity.ts
    - 实现 classifySeverity(cvssScore: number | null): SeverityLevel
    - _Requirements: 3.1, 3.4_
  - [ ]* 4.2 编写 CVSS 分级属性测试
    - **Property 4: CVSS 分级正确性**
    - **Validates: Requirements 3.1, 3.4**

  - [ ] 4.3 实现漏洞排序函数
    - 实现 sortBySeverity(vulnerabilities: Vulnerability[]): Vulnerability[]
    - 按严重程度降序排列
    - _Requirements: 3.2_
  - [ ]* 4.4 编写漏洞排序属性测试
    - **Property 5: 漏洞排序一致性**
    - **Validates: Requirements 3.2**

  - [ ] 4.5 实现严重程度过滤函数
    - 实现 filterBySeverity(vulnerabilities: Vulnerability[], levels: SeverityLevel[]): Vulnerability[]
    - _Requirements: 3.3_
  - [ ]* 4.6 编写严重程度过滤属性测试
    - **Property 6: 严重程度过滤正确性**
    - **Validates: Requirements 3.3**

- [x] 5. 缓存管理器实现



  - [x] 5.1 初始化 SQLite 数据库

    - 创建 src/cache/database.ts
    - 实现数据库初始化和表创建
    - _Requirements: 8.6_

  - [x] 5.2 实现 CacheManager 类

    - 创建 src/cache/cache-manager.ts
    - 实现 get(), set(), has(), delete(), clear() 方法
    - 缓存键格式：groupId:artifactId:version
    - _Requirements: 8.1, 8.5_
  - [ ]* 5.3 编写缓存命中属性测试
    - **Property 7: 缓存命中行为**
    - **Validates: Requirements 8.2, 8.3**

  - [ ] 5.4 实现缓存过期处理
    - 检查 expiresAt 时间戳
    - 过期条目返回 null
    - _Requirements: 8.4_
  - [ ]* 5.5 编写缓存过期属性测试
    - **Property 8: 缓存过期处理**
    - **Validates: Requirements 8.4**

- [x] 6. Checkpoint - 确保所有测试通过

  - Ensure all tests pass, ask the user if questions arise.

- [-] 7. 数据源客户端实现


  - [x] 7.1 定义数据源接口

    - 创建 src/scanners/data-source.ts
    - 定义 IDataSourceClient 接口
    - _Requirements: 12.3_


  - [ ] 7.2 实现 OSV 客户端
    - 创建 src/scanners/osv-client.ts
    - 实现批量查询 API（最大 1000 个包）
    - _Requirements: 2.1, 2.5_
  - [ ]* 7.3 编写批量查询大小限制属性测试
    - **Property 14: 批量查询大小限制**
    - **Validates: Requirements 2.5**

  - [x] 7.4 实现 OSS Index 客户端

    - 创建 src/scanners/oss-index-client.ts
    - 支持用户名/Token 认证
    - _Requirements: 2.2_

  - [x] 7.5 实现 NVD 客户端

    - 创建 src/scanners/nvd-client.ts
    - 支持可选 API Key
    - _Requirements: 2.3_

  - [ ] 7.6 实现 API 重试机制
    - 创建 src/utils/retry.ts
    - 实现指数退避重试（最多 3 次）
    - _Requirements: 2.6_

  - [ ] 7.7 实现数据源容错切换
    - 主数据源失败时自动切换备用
    - _Requirements: 2.2_

- [-] 8. 漏洞扫描器实现


  - [x] 8.1 实现 VulnerabilityScanner 类

    - 创建 src/scanners/vulnerability-scanner.ts
    - 整合多数据源查询
    - 返回完整漏洞信息（CVE ID, CVSS, 描述等）
    - _Requirements: 2.4_

  - [ ] 8.2 实现依赖哈希计算
    - 创建 src/utils/hash.ts
    - 计算依赖列表的确定性哈希（与顺序无关）
    - _Requirements: 9.1_
  - [ ]* 8.3 编写依赖哈希确定性属性测试
    - **Property 10: 依赖哈希确定性**

    - **Validates: Requirements 9.1**
  - [ ] 8.4 实现增量扫描功能
    - 对比依赖哈希，只查询变更部分
    - 支持强制全量扫描选项
    - _Requirements: 9.2, 9.3, 9.4, 9.5_
  - [ ]* 8.5 编写增量扫描属性测试
    - **Property 9: 增量扫描正确性**

    - **Validates: Requirements 9.2, 9.3, 9.4**
  - [ ] 8.6 实现修复版本推荐
    - 查询并返回最小安全版本
    - 处理多漏洞场景
    - _Requirements: 11.1, 11.2, 11.3, 11.4_
  - [ ]* 8.7 编写修复版本推荐属性测试
    - **Property 13: 修复版本推荐正确性**
    - **Validates: Requirements 11.1, 11.2**

- [x] 9. Checkpoint - 确保所有测试通过

  - Ensure all tests pass, ask the user if questions arise.

- [-] 10. 异步任务管理器实现


  - [x] 10.1 实现 TaskManager 类

    - 创建 src/tasks/task-manager.ts
    - 实现任务创建、状态更新、结果存储
    - _Requirements: 10.1, 10.4, 10.5_
  - [ ]* 10.2 编写任务生命周期属性测试
    - **Property 11: 异步任务生命周期**
    - **Validates: Requirements 10.1, 10.4, 10.5**

  - [ ] 10.3 实现进度追踪
    - 追踪扫描阶段和百分比
    - 计算预估剩余时间
    - _Requirements: 10.2, 10.3_
  - [ ]* 10.4 编写进度追踪属性测试
    - **Property 12: 进度追踪单调性**
    - **Validates: Requirements 10.2, 10.3**

  - [ ] 10.5 实现新漏洞检测
    - 对比历史扫描结果
    - 标记新发现的漏洞
    - _Requirements: 4.4_
  - [ ]* 10.6 编写新漏洞检测属性测试
    - **Property 17: 新漏洞检测正确性**
    - **Validates: Requirements 4.4**

- [x] 11. 报告生成器实现



  - [x] 11.1 实现 ReportGenerator 类

    - 创建 src/reporters/report-generator.ts
    - 实现报告摘要生成
    - _Requirements: 5.3_
  - [ ]* 11.2 编写报告内容完整性属性测试
    - **Property 15: 报告内容完整性**
    - **Validates: Requirements 5.3**

  - [ ] 11.3 实现 TXT 报告导出
    - 生成格式化的纯文本报告
    - 支持严重程度过滤
    - _Requirements: 5.2, 5.4_
  - [ ]* 11.4 编写报告过滤属性测试
    - **Property 16: 报告过滤一致性**
    - **Validates: Requirements 5.4**

  - [ ] 11.5 实现 PDF 报告导出
    - 使用 pdfkit 生成 PDF
    - 包含清晰的章节和布局

    - _Requirements: 5.1, 5.6_
  - [ ] 11.6 实现报告文件路径返回
    - 返回生成文件的绝对路径
    - _Requirements: 5.5_

- [x] 12. Checkpoint - 确保所有测试通过

  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. 定时调度器实现



  - [-] 13.1 实现 Scheduler 类

    - 创建 src/schedulers/scheduler.ts
    - 支持秒/分/时格式的间隔配置

    - _Requirements: 4.1_
  - [ ] 13.2 实现定时触发扫描
    - 到达调度时间自动触发扫描

    - 存储扫描结果和时间戳
    - _Requirements: 4.2, 4.3_
  - [ ] 13.3 实现扫描历史查询
    - 返回最近 10 次扫描记录
    - 包含时间戳和摘要信息
    - _Requirements: 4.5_



- [ ] 14. MCP Server 实现
  - [x] 14.1 创建 MCP Server 框架

    - 创建 src/mcp/server.ts
    - 初始化 MCP SDK
    - 注册所有工具
    - _Requirements: 6.1_

  - [ ] 14.2 实现 scan_project 工具
    - 接收 project_path 参数
    - 返回 task_id

    - _Requirements: 6.5_
  - [x] 14.3 实现 get_scan_progress 工具

    - 返回进度百分比、阶段、预估时间
    - _Requirements: 10.3_

  - [ ] 14.4 实现 query_vulnerability 工具
    - 查询单个依赖的漏洞信息
    - _Requirements: 2.4_

  - [ ] 14.5 实现 export_report 工具
    - 支持 PDF/TXT 格式
    - 支持严重程度过滤
    - _Requirements: 5.1, 5.2, 5.4_

  - [ ] 14.6 实现 get_scan_history 工具
    - 返回项目扫描历史

    - _Requirements: 4.5_
  - [ ] 14.7 实现 configure_schedule 工具
    - 配置定时扫描

    - _Requirements: 4.1_
  - [ ] 14.8 实现 clear_cache 和 get_config_status 工具
    - 清除缓存
    - 返回配置状态和可用数据源
    - _Requirements: 8.5, 7.4_
  - [ ] 14.9 实现参数验证和错误响应
    - 验证所有工具参数
    - 返回结构化错误响应
    - _Requirements: 6.2, 6.3_
  - [ ]* 14.10 编写错误响应属性测试
    - **Property 18: 错误响应结构一致性**
    - **Validates: Requirements 6.2, 12.4**


- [x] 15. API 密钥配置实现

  - [ ] 15.1 实现配置加载
    - 创建 src/utils/config.ts
    - 从环境变量读取 API 密钥

    - _Requirements: 7.1_
  - [ ] 15.2 实现配置验证
    - 验证 API 密钥有效性

    - 无密钥时使用免费 API
    - _Requirements: 7.2, 7.3_
  - [ ] 15.3 实现初始化日志
    - 启动时报告可用数据源
    - _Requirements: 6.4_


- [x] 16. Final Checkpoint - 确保所有测试通过

  - Ensure all tests pass, ask the user if questions arise.
