/**
 * Retry utilities with exponential backoff
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, maxDelay);
}

/**
 * Default retry condition - retry on network errors and 5xx status codes
 */
function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    
    // Retry on network errors
    if (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('socket') ||
      message.includes('fetch failed') ||
      message.includes('tls') ||
      message.includes('ssl') ||
      message.includes('certificate')
    ) {
      return true;
    }
    
    // Retry on rate limiting
    if (message.includes('429') || message.includes('rate limit')) {
      return true;
    }
    
    // Retry on server errors
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
      return true;
    }

    // Check cause for nested errors (Node.js fetch wraps errors)
    const cause = (error as Error & { cause?: Error }).cause;
    if (cause instanceof Error) {
      const causeMessage = cause.message.toLowerCase();
      const causeCode = (cause as Error & { code?: string }).code?.toLowerCase() || '';
      
      if (
        causeMessage.includes('econnreset') ||
        causeMessage.includes('econnrefused') ||
        causeMessage.includes('etimedout') ||
        causeMessage.includes('socket') ||
        causeMessage.includes('tls') ||
        causeCode === 'econnreset' ||
        causeCode === 'econnrefused' ||
        causeCode === 'etimedout'
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Execute a function with exponential backoff retry
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    shouldRetry = defaultShouldRetry
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}
