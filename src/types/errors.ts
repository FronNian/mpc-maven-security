/**
 * Error types and codes for MCP-MAVEN-SECURITY
 */

export enum ErrorCode {
  // Parse errors (1xxx)
  POM_NOT_FOUND = 1001,
  POM_PARSE_ERROR = 1002,
  PROPERTY_NOT_RESOLVED = 1003,
  INVALID_POM_STRUCTURE = 1004,

  // API errors (2xxx)
  API_UNAVAILABLE = 2001,
  API_RATE_LIMITED = 2002,
  API_AUTH_FAILED = 2003,
  API_TIMEOUT = 2004,
  API_RESPONSE_ERROR = 2005,

  // Cache errors (3xxx)
  CACHE_READ_ERROR = 3001,
  CACHE_WRITE_ERROR = 3002,
  DATABASE_ERROR = 3003,

  // Task errors (4xxx)
  TASK_NOT_FOUND = 4001,
  TASK_ALREADY_RUNNING = 4002,
  TASK_FAILED = 4003,

  // Report errors (5xxx)
  REPORT_GENERATION_FAILED = 5001,
  INVALID_OUTPUT_PATH = 5002,
  FILE_WRITE_ERROR = 5003,

  // Parameter errors (6xxx)
  INVALID_PARAMETER = 6001,
  MISSING_REQUIRED_PARAMETER = 6002,
  INVALID_PROJECT_PATH = 6003,

  // General errors (9xxx)
  UNKNOWN_ERROR = 9999
}

export interface AppError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export class MavenSecurityError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly timestamp: string;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MavenSecurityError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toAppError(): AppError {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp
    };
  }
}

export function createError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): MavenSecurityError {
  return new MavenSecurityError(code, message, details);
}

export function isAppError(error: unknown): error is MavenSecurityError {
  return error instanceof MavenSecurityError;
}
