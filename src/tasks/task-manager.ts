/**
 * Async task manager for scan operations
 */

import { getDatabase } from '../cache/database.js';
import { ScanTask, TaskStatus, TaskPhase, ProjectScanResult, Vulnerability } from '../types/index.js';
import { generateTaskId } from '../utils/hash.js';

export class TaskManager {
  /**
   * Create a new scan task
   */
  async createTask(projectPath: string): Promise<string> {
    const db = getDatabase();
    const taskId = generateTaskId();
    const now = Date.now();

    db.prepare(`
      INSERT INTO scan_tasks (task_id, project_path, status, phase, progress, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskId, projectPath, 'PENDING', 'PARSING', 0, now);

    return taskId;
  }

  /**
   * Get a task by ID
   */
  async getTask(taskId: string): Promise<ScanTask | null> {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT * FROM scan_tasks WHERE task_id = ?
    `).get(taskId) as DbScanTask | undefined;

    if (!row) {
      return null;
    }

    return this.mapDbTask(row);
  }

  /**
   * Update task status
   */
  async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
    const db = getDatabase();
    db.prepare(`
      UPDATE scan_tasks SET status = ? WHERE task_id = ?
    `).run(status, taskId);
  }

  /**
   * Update task progress
   */
  async updateProgress(
    taskId: string,
    phase: TaskPhase,
    progress: number,
    estimatedRemaining?: number
  ): Promise<void> {
    const db = getDatabase();
    db.prepare(`
      UPDATE scan_tasks 
      SET phase = ?, progress = ?, estimated_remaining = ?, status = 'RUNNING'
      WHERE task_id = ?
    `).run(phase, Math.min(100, Math.max(0, progress)), estimatedRemaining ?? null, taskId);
  }


  /**
   * Complete a task with results
   */
  async completeTask(taskId: string, result: ProjectScanResult): Promise<void> {
    const db = getDatabase();
    const now = Date.now();

    db.prepare(`
      UPDATE scan_tasks 
      SET status = 'COMPLETED', progress = 100, completed_at = ?, result = ?
      WHERE task_id = ?
    `).run(now, JSON.stringify(result), taskId);

    // Also save to history
    await this.saveToHistory(result);
  }

  /**
   * Fail a task with error
   */
  async failTask(taskId: string, error: string): Promise<void> {
    const db = getDatabase();
    const now = Date.now();

    db.prepare(`
      UPDATE scan_tasks 
      SET status = 'FAILED', completed_at = ?, error = ?
      WHERE task_id = ?
    `).run(now, error, taskId);
  }

  /**
   * List recent tasks
   */
  async listTasks(limit: number = 10): Promise<ScanTask[]> {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT * FROM scan_tasks ORDER BY created_at DESC LIMIT ?
    `).all(limit) as DbScanTask[];

    return rows.map(row => this.mapDbTask(row));
  }

  /**
   * Get tasks for a specific project
   */
  async getProjectTasks(projectPath: string, limit: number = 10): Promise<ScanTask[]> {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT * FROM scan_tasks WHERE project_path = ? ORDER BY created_at DESC LIMIT ?
    `).all(projectPath, limit) as DbScanTask[];

    return rows.map(row => this.mapDbTask(row));
  }

  /**
   * Save scan result to history
   */
  private async saveToHistory(result: ProjectScanResult): Promise<void> {
    const db = getDatabase();

    db.prepare(`
      INSERT INTO scan_history (
        project_path, task_id, dependencies_hash, total_dependencies,
        vulnerable_count, critical_count, high_count, medium_count, low_count, scanned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.projectPath,
      result.taskId,
      result.dependenciesHash,
      result.totalDependencies,
      result.summary.vulnerableDependencies,
      result.summary.criticalCount,
      result.summary.highCount,
      result.summary.mediumCount,
      result.summary.lowCount,
      Date.now()
    );
  }

  /**
   * Get scan history for a project
   */
  async getScanHistory(projectPath: string, limit: number = 10): Promise<ScanHistoryEntry[]> {
    const db = getDatabase();
    const rows = db.prepare(`
      SELECT * FROM scan_history WHERE project_path = ? ORDER BY scanned_at DESC LIMIT ?
    `).all(projectPath, limit) as DbScanHistory[];

    return rows.map(row => ({
      id: row.id,
      projectPath: row.project_path,
      taskId: row.task_id,
      dependenciesHash: row.dependencies_hash,
      totalDependencies: row.total_dependencies,
      vulnerableCount: row.vulnerable_count,
      criticalCount: row.critical_count,
      highCount: row.high_count,
      mediumCount: row.medium_count,
      lowCount: row.low_count,
      scannedAt: new Date(row.scanned_at).toISOString()
    }));
  }

  /**
   * Detect new vulnerabilities compared to previous scan
   */
  async detectNewVulnerabilities(
    projectPath: string,
    currentVulnerabilities: Vulnerability[]
  ): Promise<Vulnerability[]> {
    const history = await this.getScanHistory(projectPath, 1);
    
    if (history.length === 0) {
      // First scan, all vulnerabilities are new
      return currentVulnerabilities;
    }

    // Get previous scan result
    const previousTask = await this.getTask(history[0].taskId);
    if (!previousTask?.result) {
      return currentVulnerabilities;
    }

    const previousIds = new Set(
      previousTask.result.scanResults.flatMap(r => r.vulnerabilities.map(v => v.id))
    );

    return currentVulnerabilities.filter(v => !previousIds.has(v.id));
  }

  private mapDbTask(row: DbScanTask): ScanTask {
    return {
      taskId: row.task_id,
      projectPath: row.project_path,
      status: row.status as TaskStatus,
      phase: row.phase as TaskPhase,
      progress: row.progress,
      estimatedRemaining: row.estimated_remaining ?? 0,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      result: row.result ? JSON.parse(row.result) as ProjectScanResult : null,
      error: row.error
    };
  }
}

interface DbScanTask {
  task_id: string;
  project_path: string;
  status: string;
  phase: string;
  progress: number;
  estimated_remaining: number | null;
  created_at: number;
  completed_at: number | null;
  result: string | null;
  error: string | null;
}

interface DbScanHistory {
  id: number;
  project_path: string;
  task_id: string;
  dependencies_hash: string;
  total_dependencies: number;
  vulnerable_count: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  low_count: number;
  scanned_at: number;
}

export interface ScanHistoryEntry {
  id: number;
  projectPath: string;
  taskId: string;
  dependenciesHash: string;
  totalDependencies: number;
  vulnerableCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  scannedAt: string;
}

export const taskManager = new TaskManager();
