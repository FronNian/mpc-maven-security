/**
 * Cache manager for vulnerability query results
 */

import { getDatabase } from './database.js';
import { Vulnerability } from '../types/index.js';

const DEFAULT_TTL_HOURS = 24;

export class CacheManager {
  private ttlHours: number;

  constructor(ttlHours: number = DEFAULT_TTL_HOURS) {
    this.ttlHours = ttlHours;
  }

  /**
   * Generate cache key from dependency coordinates
   */
  private generateKey(groupId: string, artifactId: string, version: string): string {
    return `${groupId}:${artifactId}:${version}`;
  }

  /**
   * Get cached vulnerabilities for a dependency
   */
  async get(key: string): Promise<Vulnerability[] | null> {
    const db = getDatabase();
    const now = Date.now();

    const row = db.prepare(`
      SELECT data, expires_at FROM cache WHERE key = ?
    `).get(key) as { data: string; expires_at: number } | undefined;

    if (!row) {
      return null;
    }

    // Check if expired
    if (row.expires_at < now) {
      // Delete expired entry
      db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return null;
    }

    try {
      return JSON.parse(row.data) as Vulnerability[];
    } catch {
      return null;
    }
  }

  /**
   * Get cached vulnerabilities by dependency coordinates
   */
  async getByCoordinates(
    groupId: string,
    artifactId: string,
    version: string
  ): Promise<Vulnerability[] | null> {
    const key = this.generateKey(groupId, artifactId, version);
    return this.get(key);
  }


  /**
   * Store vulnerabilities in cache
   */
  async set(key: string, data: Vulnerability[], ttlHours?: number): Promise<void> {
    const db = getDatabase();
    const now = Date.now();
    const ttl = ttlHours ?? this.ttlHours;
    const expiresAt = now + (ttl * 60 * 60 * 1000);

    db.prepare(`
      INSERT OR REPLACE INTO cache (key, data, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(key, JSON.stringify(data), now, expiresAt);
  }

  /**
   * Store vulnerabilities by dependency coordinates
   */
  async setByCoordinates(
    groupId: string,
    artifactId: string,
    version: string,
    data: Vulnerability[],
    ttlHours?: number
  ): Promise<void> {
    const key = this.generateKey(groupId, artifactId, version);
    return this.set(key, data, ttlHours);
  }

  /**
   * Check if cache entry exists and is valid
   */
  async has(key: string): Promise<boolean> {
    const db = getDatabase();
    const now = Date.now();

    const row = db.prepare(`
      SELECT expires_at FROM cache WHERE key = ?
    `).get(key) as { expires_at: number } | undefined;

    if (!row) {
      return false;
    }

    return row.expires_at >= now;
  }

  /**
   * Delete a cache entry
   */
  async delete(key: string): Promise<void> {
    const db = getDatabase();
    db.prepare('DELETE FROM cache WHERE key = ?').run(key);
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    const db = getDatabase();
    db.prepare('DELETE FROM cache').run();
  }

  /**
   * Clean up expired entries
   */
  async cleanup(): Promise<number> {
    const db = getDatabase();
    const now = Date.now();
    const result = db.prepare('DELETE FROM cache WHERE expires_at < ?').run(now);
    return result.changes;
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{ totalEntries: number; expiredEntries: number }> {
    const db = getDatabase();
    const now = Date.now();

    const total = db.prepare('SELECT COUNT(*) as count FROM cache').get() as { count: number };
    const expired = db.prepare(
      'SELECT COUNT(*) as count FROM cache WHERE expires_at < ?'
    ).get(now) as { count: number };

    return {
      totalEntries: total.count,
      expiredEntries: expired.count
    };
  }
}

export const cacheManager = new CacheManager();
