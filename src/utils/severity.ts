/**
 * Vulnerability severity classification utilities
 */

import { SeverityLevel, Vulnerability } from '../types/index.js';

/**
 * Classify CVSS score into severity level
 * - Critical: 9.0-10.0
 * - High: 7.0-8.9
 * - Medium: 4.0-6.9
 * - Low: 0.1-3.9
 * - Unrated: null
 */
export function classifySeverity(cvssScore: number | null): SeverityLevel {
  if (cvssScore === null || cvssScore === undefined) {
    return 'UNRATED';
  }

  if (cvssScore >= 9.0) {
    return 'CRITICAL';
  }
  if (cvssScore >= 7.0) {
    return 'HIGH';
  }
  if (cvssScore >= 4.0) {
    return 'MEDIUM';
  }
  if (cvssScore >= 0.1) {
    return 'LOW';
  }

  return 'UNRATED';
}

/**
 * Get numeric priority for severity level (higher = more severe)
 */
export function getSeverityPriority(severity: SeverityLevel): number {
  const priorities: Record<SeverityLevel, number> = {
    'CRITICAL': 5,
    'HIGH': 4,
    'MEDIUM': 3,
    'LOW': 2,
    'UNRATED': 1
  };
  return priorities[severity];
}

/**
 * Sort vulnerabilities by severity level in descending order
 */
export function sortBySeverity(vulnerabilities: Vulnerability[]): Vulnerability[] {
  return [...vulnerabilities].sort((a, b) => {
    const priorityA = getSeverityPriority(a.severity);
    const priorityB = getSeverityPriority(b.severity);
    return priorityB - priorityA;
  });
}

/**
 * Filter vulnerabilities by severity levels
 */
export function filterBySeverity(
  vulnerabilities: Vulnerability[],
  levels: SeverityLevel[]
): Vulnerability[] {
  if (levels.length === 0) {
    return vulnerabilities;
  }
  const levelSet = new Set(levels);
  return vulnerabilities.filter(v => levelSet.has(v.severity));
}

/**
 * Get severity level display color (for reports)
 */
export function getSeverityColor(severity: SeverityLevel): string {
  const colors: Record<SeverityLevel, string> = {
    'CRITICAL': '#FF0000',
    'HIGH': '#FF6600',
    'MEDIUM': '#FFCC00',
    'LOW': '#00CC00',
    'UNRATED': '#999999'
  };
  return colors[severity];
}

/**
 * Get severity level display label
 */
export function getSeverityLabel(severity: SeverityLevel): string {
  const labels: Record<SeverityLevel, string> = {
    'CRITICAL': '严重',
    'HIGH': '高危',
    'MEDIUM': '中危',
    'LOW': '低危',
    'UNRATED': '未评级'
  };
  return labels[severity];
}
