import type { RequestFunction, RequestOptions, ClientOptions } from '../types';

export class BaseResource {
  readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
  }

  /**
   * Makes an HTTP request to the API with retries and exponential backoff
   * @param path - The API endpoint path
   * @param options - Optional request configuration
   * @returns Promise containing the response data
   */
  public async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let lastError: Error | null = null;
    const { baseUrl, retries = 3, backoffMs = 100, maxBackoffMs = 1000, headers = {} } = this.options;

    let delay = backoffMs;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${baseUrl}${path}`, {
          ...options,
          headers: {
            ...headers,
            ...options.headers,
            // TODO: Bring this back once we figure out what we/users need to do to make this work with cross-origin requests
            // 'x-mastra-client-type': 'js',
          },
          body:
            options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          let errorMessage = `HTTP error! status: ${response.status}`;
          try {
            const errorJson = JSON.parse(errorBody);
            errorMessage += ` - ${JSON.stringify(errorJson)}`;
          } catch {
            if (errorBody) {
              errorMessage += ` - ${errorBody}`;
            }
          }
          throw new Error(errorMessage);
        }

        if (options.stream) {
          return response as unknown as T;
        }

        const data = await response.json();
        return data as T;
      } catch (error) {
        lastError = error as Error;

        if (attempt === retries) {
          break;
        }

        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, maxBackoffMs);
      }
    }

    throw lastError || new Error('Request failed');
  }
}
