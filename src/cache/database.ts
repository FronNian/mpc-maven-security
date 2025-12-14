/**
 * SQLite database initialization and management
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

let db: Database.Database | null = null;

const DB_PATH = path.join(process.cwd(), '.mcp-maven-security.db');

/**
 * Initialize the SQLite database and create tables
 */
export function initDatabase(): Database.Database {
  if (db) {
    return db;
  }

  db = new Database(DB_PATH);
  
  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');
  
  // Create tables
  db.exec(`
    -- Vulnerability cache table
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);

    -- Scan tasks table
    CREATE TABLE IF NOT EXISTS scan_tasks (
      task_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT,
      progress INTEGER DEFAULT 0,
      estimated_remaining INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      result TEXT,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON scan_tasks(project_path);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON scan_tasks(status);

    -- Scan history table
    CREATE TABLE IF NOT EXISTS scan_history (
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

    CREATE INDEX IF NOT EXISTS idx_history_project ON scan_history(project_path);

    -- Schedules table
    CREATE TABLE IF NOT EXISTS schedules (
      project_path TEXT PRIMARY KEY,
      interval_seconds INTEGER NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER
    );
  `);

  return db;
}

/**
 * Get the database instance
 */
export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Delete the database file (for testing)
 */
export function deleteDatabase(): void {
  closeDatabase();
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
  }
  // Also remove WAL files
  const walPath = DB_PATH + '-wal';
  const shmPath = DB_PATH + '-shm';
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
}
