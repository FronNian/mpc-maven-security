/**
 * Scheduled scan manager
 */

import { getDatabase } from '../cache/database.js';
import { ScheduleConfig } from '../types/index.js';

export class Scheduler {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private scanCallback?: (projectPath: string) => Promise<void>;

  /**
   * Set the callback function for scheduled scans
   */
  setScanCallback(callback: (projectPath: string) => Promise<void>): void {
    this.scanCallback = callback;
  }

  /**
   * Set or update a schedule
   */
  async setSchedule(config: ScheduleConfig): Promise<void> {
    const db = getDatabase();
    const now = Date.now();
    const nextRunAt = now + (config.intervalSeconds * 1000);

    db.prepare(`
      INSERT OR REPLACE INTO schedules (project_path, interval_seconds, enabled, next_run_at)
      VALUES (?, ?, ?, ?)
    `).run(config.projectPath, config.intervalSeconds, config.enabled ? 1 : 0, nextRunAt);

    // Update timer
    if (config.enabled) {
      this.startTimer(config.projectPath, config.intervalSeconds);
    } else {
      this.stopTimer(config.projectPath);
    }
  }

  /**
   * Get schedule for a project
   */
  async getSchedule(projectPath: string): Promise<ScheduleConfig | null> {
    const db = getDatabase();
    const row = db.prepare(`
      SELECT * FROM schedules WHERE project_path = ?
    `).get(projectPath) as DbSchedule | undefined;

    if (!row) {
      return null;
    }

    return {
      projectPath: row.project_path,
      intervalSeconds: row.interval_seconds,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined
    };
  }

  /**
   * Remove a schedule
   */
  async removeSchedule(projectPath: string): Promise<void> {
    const db = getDatabase();
    db.prepare('DELETE FROM schedules WHERE project_path = ?').run(projectPath);
    this.stopTimer(projectPath);
  }

  /**
   * List all schedules
   */
  async listSchedules(): Promise<ScheduleConfig[]> {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM schedules').all() as DbSchedule[];

    return rows.map(row => ({
      projectPath: row.project_path,
      intervalSeconds: row.interval_seconds,
      enabled: row.enabled === 1,
      lastRunAt: row.last_run_at ?? undefined,
      nextRunAt: row.next_run_at ?? undefined
    }));
  }


  /**
   * Start all enabled schedules
   */
  async start(): Promise<void> {
    const schedules = await this.listSchedules();
    for (const schedule of schedules) {
      if (schedule.enabled) {
        this.startTimer(schedule.projectPath, schedule.intervalSeconds);
      }
    }
  }

  /**
   * Stop all schedules
   */
  stop(): void {
    for (const [projectPath] of this.timers) {
      this.stopTimer(projectPath);
    }
  }

  /**
   * Start a timer for a project
   */
  private startTimer(projectPath: string, intervalSeconds: number): void {
    // Stop existing timer if any
    this.stopTimer(projectPath);

    const timer = setInterval(async () => {
      await this.runScheduledScan(projectPath);
    }, intervalSeconds * 1000);

    this.timers.set(projectPath, timer);
  }

  /**
   * Stop a timer for a project
   */
  private stopTimer(projectPath: string): void {
    const timer = this.timers.get(projectPath);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(projectPath);
    }
  }

  /**
   * Run a scheduled scan
   */
  private async runScheduledScan(projectPath: string): Promise<void> {
    if (!this.scanCallback) {
      console.warn('No scan callback set for scheduler');
      return;
    }

    const db = getDatabase();
    const now = Date.now();

    try {
      await this.scanCallback(projectPath);

      // Update last run time
      const schedule = await this.getSchedule(projectPath);
      if (schedule) {
        const nextRunAt = now + (schedule.intervalSeconds * 1000);
        db.prepare(`
          UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE project_path = ?
        `).run(now, nextRunAt, projectPath);
      }
    } catch (error) {
      console.error(`Scheduled scan failed for ${projectPath}:`, error);
    }
  }

  /**
   * Parse interval string to seconds
   * Supports formats: "30s", "5m", "1h", "30" (seconds)
   */
  static parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)(s|m|h)?$/i);
    if (!match) {
      throw new Error(`Invalid interval format: ${interval}`);
    }

    const value = parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();

    switch (unit) {
      case 'h': return value * 3600;
      case 'm': return value * 60;
      case 's': return value;
      default: return value;
    }
  }
}

interface DbSchedule {
  project_path: string;
  interval_seconds: number;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

export const scheduler = new Scheduler();
