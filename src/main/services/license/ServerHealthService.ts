import { DEFAULT_API_URL } from '../../config';
import { logger } from '../../logger';
import { pinnedFetch } from '../security';

export interface ServerHealthResult {
  online: boolean;
  responseTime: number;
  error?: string;
}

interface CachedHealthResult extends ServerHealthResult {
  timestamp: number;
}

const CACHE_DURATION_MS = 60000; // 1 minute
const HEALTH_CHECK_TIMEOUT_MS = 5000; // 5 seconds

export class ServerHealthService {
  private cache: Map<string, CachedHealthResult> = new Map();

  /**
   * Check if a license server is reachable by pinging its public key endpoint
   *
   * @param apiUrl - The API base URL to check (defaults to DEFAULT_API_URL)
   * @returns Health check result with online status and response time
   */
  async checkHealth(apiUrl?: string): Promise<ServerHealthResult> {
    const targetUrl = apiUrl || DEFAULT_API_URL;

    // Check cache first
    const cached = this.cache.get(targetUrl);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION_MS) {
      logger.debug('ServerHealthService: Returning cached health result', {
        url: targetUrl,
        online: cached.online,
        age: Date.now() - cached.timestamp,
      });
      return {
        online: cached.online,
        responseTime: cached.responseTime,
        error: cached.error,
      };
    }

    // Perform health check
    logger.info('ServerHealthService: Checking server health', { url: targetUrl });
    const startTime = Date.now();

    try {
      const publicKeyUrl = `${targetUrl}/api/license/public-key`;

      const response = await pinnedFetch(publicKeyUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const result: ServerHealthResult = {
          online: false,
          responseTime,
          error: `Server returned status ${response.status}`,
        };

        logger.warn('ServerHealthService: Server health check failed', {
          url: targetUrl,
          status: response.status,
          responseTime,
        });

        this.cacheResult(targetUrl, result);
        return result;
      }

      // Success
      const result: ServerHealthResult = {
        online: true,
        responseTime,
      };

      logger.info('ServerHealthService: Server is online', {
        url: targetUrl,
        responseTime,
      });

      this.cacheResult(targetUrl, result);
      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'Connection timed out'
          : error instanceof TypeError
            ? 'Network error - unable to reach server'
            : error instanceof Error
              ? error.message
              : 'Unknown error';

      const result: ServerHealthResult = {
        online: false,
        responseTime,
        error: errorMessage,
      };

      logger.error('ServerHealthService: Health check failed', {
        url: targetUrl,
        error: errorMessage,
        responseTime,
      });

      this.cacheResult(targetUrl, result);
      return result;
    }
  }

  /**
   * Clear all cached health results
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('ServerHealthService: Cache cleared');
  }

  /**
   * Clear cached result for a specific URL
   */
  clearCacheForUrl(apiUrl: string): void {
    this.cache.delete(apiUrl);
    logger.debug('ServerHealthService: Cache cleared for URL', { url: apiUrl });
  }

  private cacheResult(url: string, result: ServerHealthResult): void {
    this.cache.set(url, {
      ...result,
      timestamp: Date.now(),
    });
  }
}
