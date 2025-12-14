/**
 * Hash utilities for dependency tracking
 */

import * as crypto from 'crypto';
import { Dependency } from '../types/index.js';

/**
 * Compute a deterministic hash of dependencies
 * The hash is independent of the order of dependencies
 */
export function computeDependenciesHash(dependencies: Dependency[]): string {
  // Sort dependencies by coordinates to ensure deterministic hash
  const sortedCoordinates = dependencies
    .map(dep => `${dep.groupId}:${dep.artifactId}:${dep.version}`)
    .sort();

  const content = sortedCoordinates.join('\n');
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `task_${timestamp}_${random}`;
}
