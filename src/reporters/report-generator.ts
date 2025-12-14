/**
 * Report generator for vulnerability scan results
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { createWriteStream } from 'fs';
import { ProjectScanResult, ReportOptions, ReportSummary, SeverityLevel } from '../types/index.js';
import { filterBySeverity, getSeverityLabel } from '../utils/severity.js';

export class ReportGenerator {
  /**
   * Generate a report in the specified format
   */
  async generate(scanResult: ProjectScanResult, options: ReportOptions): Promise<string> {
    const outputPath = options.outputPath || scanResult.projectPath;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    if (options.format === 'PDF') {
      return this.generatePdf(scanResult, outputPath, timestamp, options.severityFilter);
    } else {
      return this.generateTxt(scanResult, outputPath, timestamp, options.severityFilter);
    }
  }

  /**
   * Generate summary from scan results
   */
  generateSummary(scanResult: ProjectScanResult): ReportSummary {
    let criticalCount = 0;
    let highCount = 0;
    let mediumCount = 0;
    let lowCount = 0;
    let unratedCount = 0;
    let vulnerableDependencies = 0;

    for (const result of scanResult.scanResults) {
      if (result.vulnerabilities.length > 0) {
        vulnerableDependencies++;
        for (const vuln of result.vulnerabilities) {
          switch (vuln.severity) {
            case 'CRITICAL': criticalCount++; break;
            case 'HIGH': highCount++; break;
            case 'MEDIUM': mediumCount++; break;
            case 'LOW': lowCount++; break;
            case 'UNRATED': unratedCount++; break;
          }
        }
      }
    }

    return {
      totalDependencies: scanResult.totalDependencies,
      vulnerableDependencies,
      criticalCount,
      highCount,
      mediumCount,
      lowCount,
      unratedCount
    };
  }


  /**
   * Generate TXT report
   */
  private async generateTxt(
    scanResult: ProjectScanResult,
    outputPath: string,
    timestamp: string,
    severityFilter?: SeverityLevel[]
  ): Promise<string> {
    const filePath = path.join(outputPath, `vulnerability-report-${timestamp}.txt`);
    const summary = this.generateSummary(scanResult);
    
    let content = '';
    content += '═'.repeat(60) + '\n';
    content += '           MAVEN 依赖漏洞扫描报告\n';
    content += '═'.repeat(60) + '\n\n';
    
    content += `项目名称: ${scanResult.projectName}\n`;
    content += `项目路径: ${scanResult.projectPath}\n`;
    content += `扫描时间: ${scanResult.scannedAt}\n`;
    content += `报告生成: ${new Date().toISOString()}\n\n`;
    
    content += '─'.repeat(60) + '\n';
    content += '                    摘要\n';
    content += '─'.repeat(60) + '\n';
    content += `依赖总数: ${summary.totalDependencies}\n`;
    content += `存在漏洞的依赖: ${summary.vulnerableDependencies}\n`;
    content += `严重漏洞: ${summary.criticalCount}\n`;
    content += `高危漏洞: ${summary.highCount}\n`;
    content += `中危漏洞: ${summary.mediumCount}\n`;
    content += `低危漏洞: ${summary.lowCount}\n`;
    content += `未评级漏洞: ${summary.unratedCount}\n\n`;

    content += '─'.repeat(60) + '\n';
    content += '                  漏洞详情\n';
    content += '─'.repeat(60) + '\n\n';

    for (const result of scanResult.scanResults) {
      let vulns = result.vulnerabilities;
      if (severityFilter && severityFilter.length > 0) {
        vulns = filterBySeverity(vulns, severityFilter);
      }
      
      if (vulns.length === 0) continue;

      const dep = result.dependency;
      content += `【${dep.groupId}:${dep.artifactId}:${dep.version}】\n`;
      content += `  发现 ${vulns.length} 个漏洞:\n\n`;

      for (const vuln of vulns) {
        content += `  ● ${vuln.id} [${getSeverityLabel(vuln.severity)}]\n`;
        content += `    CVSS: ${vuln.cvssScore ?? 'N/A'}\n`;
        content += `    描述: ${vuln.description.substring(0, 200)}${vuln.description.length > 200 ? '...' : ''}\n`;
        if (vuln.fixedVersion) {
          content += `    修复版本: ${vuln.fixedVersion}\n`;
        }
        content += '\n';
      }

      if (result.fixRecommendation) {
        content += `  ★ 建议升级: ${result.fixRecommendation.currentVersion} → ${result.fixRecommendation.recommendedVersion}\n`;
        content += `    (${result.fixRecommendation.versionJump} 版本升级，修复 ${result.fixRecommendation.fixesCount} 个漏洞)\n`;
      }
      content += '\n';
    }

    content += '═'.repeat(60) + '\n';
    content += '                  报告结束\n';
    content += '═'.repeat(60) + '\n';

    await fs.writeFile(filePath, content, 'utf-8');
    return path.resolve(filePath);
  }

  /**
   * Generate PDF report
   */
  private async generatePdf(
    scanResult: ProjectScanResult,
    outputPath: string,
    timestamp: string,
    severityFilter?: SeverityLevel[]
  ): Promise<string> {
    const filePath = path.join(outputPath, `vulnerability-report-${timestamp}.pdf`);
    const summary = this.generateSummary(scanResult);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = createWriteStream(filePath);
      
      doc.pipe(stream);

      // Title
      doc.fontSize(20).text('Maven 依赖漏洞扫描报告', { align: 'center' });
      doc.moveDown();

      // Project info
      doc.fontSize(12);
      doc.text(`项目名称: ${scanResult.projectName}`);
      doc.text(`项目路径: ${scanResult.projectPath}`);
      doc.text(`扫描时间: ${scanResult.scannedAt}`);
      doc.moveDown();

      // Summary
      doc.fontSize(14).text('摘要', { underline: true });
      doc.fontSize(10);
      doc.text(`依赖总数: ${summary.totalDependencies}`);
      doc.text(`存在漏洞的依赖: ${summary.vulnerableDependencies}`);
      doc.text(`严重: ${summary.criticalCount} | 高危: ${summary.highCount} | 中危: ${summary.mediumCount} | 低危: ${summary.lowCount}`);
      doc.moveDown();

      // Vulnerabilities
      doc.fontSize(14).text('漏洞详情', { underline: true });
      doc.fontSize(10);

      for (const result of scanResult.scanResults) {
        let vulns = result.vulnerabilities;
        if (severityFilter && severityFilter.length > 0) {
          vulns = filterBySeverity(vulns, severityFilter);
        }
        
        if (vulns.length === 0) continue;

        const dep = result.dependency;
        doc.moveDown();
        doc.fontSize(11).text(`${dep.groupId}:${dep.artifactId}:${dep.version}`, { continued: false });
        
        for (const vuln of vulns) {
          doc.fontSize(9);
          doc.text(`  • ${vuln.id} [${getSeverityLabel(vuln.severity)}] CVSS: ${vuln.cvssScore ?? 'N/A'}`);
          doc.text(`    ${vuln.description.substring(0, 150)}${vuln.description.length > 150 ? '...' : ''}`);
        }

        if (result.fixRecommendation) {
          doc.text(`  → 建议升级到: ${result.fixRecommendation.recommendedVersion}`);
        }
      }

      doc.end();

      stream.on('finish', () => resolve(path.resolve(filePath)));
      stream.on('error', reject);
    });
  }
}

export const reportGenerator = new ReportGenerator();
