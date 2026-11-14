import { COOKIE_SESSION_TOKEN, getCookieValue, getStoredToken, getStoredRefreshToken, setStoredToken, getStoredCsrfToken, setStoredCsrfToken } from './auth';

export const getBaseUrl = () => {
  if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
    const { protocol, hostname, port } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      if (process.env.NEXT_PUBLIC_BACKEND_PORT) {
        return `${protocol}//${hostname}:${process.env.NEXT_PUBLIC_BACKEND_PORT}`;
      }
      const parsedPort = parseInt(port, 10);
      if (!isNaN(parsedPort) && parsedPort >= 3000 && parsedPort <= 3010) {
        const backendPort = 5000 + (parsedPort - 3000);
        return `${protocol}//${hostname}:${backendPort}`;
      }
      return `${protocol}//${hostname}:5000`;
    }
  }

  const rawBaseUrl = process.env.NEXT_PUBLIC_API_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:5000' : '');
  return rawBaseUrl;
};

export const BASE_URL = getBaseUrl().replace(/\/$/, '');
// Custom GET cache logic has been removed to allow TanStack Query to manage cache lifecycle exclusively.

const resolveUrl = (endpoint: string) => {
  if (endpoint.startsWith('http')) return endpoint;
  // Normalize any duplicate proxy prefixes e.g. /proxy/proxy/api -> /proxy/api
  const cleanEndpoint = endpoint.replace(/^(\/?proxy)+/i, '/proxy');
  if (cleanEndpoint.startsWith('/proxy')) return cleanEndpoint;

  // On Vercel or Cloud Run with BACKEND_URL rewrite, BASE_URL is '/proxy' or empty
  if (BASE_URL && cleanEndpoint.startsWith(BASE_URL)) return cleanEndpoint;
  return `${BASE_URL}${cleanEndpoint.startsWith('/') ? cleanEndpoint : `/${cleanEndpoint}`}`;
};

export const resolveMediaUrl = (url: string | null | undefined): string | null => {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return trimmed;
  }
  // Strip any repeating /proxy/proxy/ chains completely
  const normalized = trimmed.replace(/(?:\/?proxy\/+)+/gi, '/proxy/').replace(/^\/?proxy$/i, '/proxy');
  if (normalized.startsWith('/proxy/') || normalized === '/proxy') {
    return normalized;
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    const gcsMatch = normalized.match(/^https?:\/\/storage\.googleapis\.com\/[^/]+\/(.+)$/);
    if (gcsMatch && !normalized.includes('X-Goog-Algorithm')) {
      return `/api/files/raw/${gcsMatch[1]}`;
    }
    return normalized;
  }
  const cleanPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  if (cleanPath.startsWith('/categories/')) {
    return `${BASE_URL}/api/files/raw${cleanPath}`;
  }
  if (
    cleanPath.startsWith('/org-logos/') ||
    cleanPath.startsWith('/banners/') ||
    cleanPath.startsWith('/products/') ||
    cleanPath.startsWith('/category-photos/')
  ) {
    return cleanPath;
  }
  if (BASE_URL && cleanPath.startsWith(BASE_URL)) {
    return cleanPath;
  }
  return `${BASE_URL}${cleanPath}`;
};

export const readJsonResponse = async (response: Response) => {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const body = await response.text();
    const preview = body.trim().slice(0, 80);
    throw new Error(
      preview.startsWith('<')
        ? 'Backend API returned HTML instead of JSON. Check NEXT_PUBLIC_API_URL.'
        : 'Backend API returned a non-JSON response.'
    );
  }

  return response.json();
};

export const unwrapApiData = <T = any>(body: any): T => {
  if (body && typeof body === 'object' && 'data' in body) return body.data as T;
  return body as T;
};

const normalizeHeaders = (headers: HeadersInit | undefined, body?: BodyInit | null) => {
  const next: Record<string, string> = { ...(headers as any) };
  const auth = next.Authorization || next.authorization || '';
  if (/^Bearer\s*(null|undefined|cookie-session)?$/i.test(auth.trim())) {
    delete next.Authorization;
    delete next.authorization;
  }
  if (!next.Authorization && !next.authorization && typeof window !== 'undefined') {
    const token = getStoredToken() || localStorage.getItem('token') || localStorage.getItem('msme_auth_token');
    if (token && token !== 'null' && token !== 'undefined' && token !== COOKIE_SESSION_TOKEN) {
      next['Authorization'] = `Bearer ${token}`;
    }
  }
  if (body instanceof FormData) {
    delete next['Content-Type'];
    delete next['content-type'];
    delete next['CONTENT-TYPE'];
  } else if (!next['Content-Type'] && !next['content-type']) {
    next['Content-Type'] = 'application/json';
  }
  const csrfToken = getStoredCsrfToken() || getCookieValue('csrfToken');
  if (csrfToken && !next['X-CSRF-Token'] && !next['x-csrf-token']) {
    next['X-CSRF-Token'] = csrfToken;
  }
  return next;
};

const shouldDispatchUnauthorized = (endpoint: string) =>
  ![
    '/api/auth/me',
    '/api/auth/refresh',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/notifications',
    '/api/navigation/summary',
  ].some((path) => endpoint.startsWith(path));

const isUnsafeMethod = (method: string) => !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());

const isCsrfFailure = async (response: Response) => {
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().json();
    const code = String(body?.code || body?.errorCode || body?.data?.code || body?.data?.errorCode || '');
    const message = String(body?.message || body?.error || '');
    return code === 'CSRF_TOKEN_INVALID' || /csrf/i.test(message);
  } catch {
    return false;
  }
};

const getResponseErrorCode = async (response: Response): Promise<string> => {
  try {
    const body = await response.clone().json();
    return String(body?.code || body?.errorCode || body?.data?.code || body?.data?.errorCode || '');
  } catch {
    return '';
  }
};

let activeRefreshPromise: Promise<boolean> | null = null;
const refreshSessionCookies = async (): Promise<boolean> => {
  if (activeRefreshPromise) return activeRefreshPromise;
  activeRefreshPromise = (async () => {
    try {
      const storedRefreshToken = getStoredRefreshToken();
      const response = await fetch(resolveUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: normalizeHeaders(undefined, null),
        body: JSON.stringify({ refreshToken: storedRefreshToken || undefined }),
      });
      if (!response.ok) {
        const code = await getResponseErrorCode(response);
        if (code === 'SESSION_CONCURRENT_LOGIN' && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { code: 'SESSION_CONCURRENT_LOGIN' } }));
        }
        return false;
      }

      try {
        const data = await response.clone().json();
        const nextAccessToken = data.accessToken || data.token;
        if (nextAccessToken) {
          setStoredToken(nextAccessToken, data.refreshToken || storedRefreshToken);
        }
        if (data.csrfToken) {
          setStoredCsrfToken(data.csrfToken);
        }
      } catch {
        // ignore parse error if empty
      }
      return true;
    } catch {
      return false;
    } finally {
      activeRefreshPromise = null;
    }
  })();
  return activeRefreshPromise;
};

let activeCsrfFetchPromise: Promise<string> | null = null;
export const fetchCsrfToken = async (): Promise<string> => {
  if (activeCsrfFetchPromise) return activeCsrfFetchPromise;
  activeCsrfFetchPromise = (async () => {
    try {
      const response = await fetch(resolveUrl('/api/auth/csrf-token'), {
        method: 'GET',
        credentials: 'include',
        headers: normalizeHeaders(undefined, null)
      });
      if (response.ok) {
        const body = await response.json();
        const token = body?.csrfToken || body?.data?.csrfToken;
        if (token) {
          setStoredCsrfToken(token);
          return token;
        }
      }
    } catch {
      // ignore network errors
    } finally {
      activeCsrfFetchPromise = null;
    }
    return getStoredCsrfToken() || getCookieValue('csrfToken');
  })();
  return activeCsrfFetchPromise;
};

const networkErrorResponse = (error: unknown) => {
  const detailMsg = error instanceof Error ? error.message : String(error || '');
  const message = detailMsg && !detailMsg.toLowerCase().includes('failed to fetch')
    ? `Request failed: ${detailMsg}`
    : 'Unable to reach the backend API. Please check that the backend server is running.';
  return new Response(
    JSON.stringify({
      success: false,
      message,
      code: 'NETWORK_ERROR',
      detail: detailMsg,
    }),
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' },
    },
  );
};

const clearApiCache = (matcher?: string) => {
  // Legacy cache clear stub
};

const invalidatePrefixFor = (endpoint: string) => {
  // Legacy cache invalidate stub
};

export const api = {
  fetch: (endpoint: string, options: RequestInit & { skipCache?: boolean } = {}) => {
    const url = resolveUrl(endpoint);
    const method = (options.method || 'GET').toUpperCase();
    const headers = normalizeHeaders(options.headers, options.body as BodyInit | null);

    const sendRequest = (requestHeaders: Record<string, string>) => {
      const fetchOptions: RequestInit = {
        credentials: 'include',
        ...options,
        headers: requestHeaders,
      };
      if (options.skipCache) {
        fetchOptions.cache = 'no-store';
        requestHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        requestHeaders['Pragma'] = 'no-cache';
      }
      return fetch(url, fetchOptions);
    };

    const request = sendRequest(headers).then(async (response) => {
      if (isUnsafeMethod(method) && await isCsrfFailure(response)) {
        const freshCsrf = await fetchCsrfToken().catch(() => '');
        const refreshed = freshCsrf ? true : await refreshSessionCookies().catch(() => false);
        if (refreshed) {
          const retryHeaders = normalizeHeaders(options.headers, options.body as BodyInit | null);
          const activeCsrf = freshCsrf || getStoredCsrfToken() || getCookieValue('csrfToken');
          if (activeCsrf) retryHeaders['X-CSRF-Token'] = activeCsrf;
          response = await sendRequest(retryHeaders);
        }
      }

      // If unauthorized and not an auth endpoint, check error code
      if (response.status === 401 && !endpoint.startsWith('/api/auth/')) {
        const errCode = await getResponseErrorCode(response);
        const hasSessionEvidence = typeof window !== 'undefined' && Boolean(
          getCookieValue('csrfToken') || getStoredRefreshToken() || localStorage.getItem('token') || localStorage.getItem('msme_auth_token')
        );

        if (errCode === 'SESSION_CONCURRENT_LOGIN') {
          if (typeof window !== 'undefined' && hasSessionEvidence) {
            window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { code: 'SESSION_CONCURRENT_LOGIN' } }));
          }
        } else if (hasSessionEvidence) {
          const refreshed = await refreshSessionCookies().catch(() => false);
          if (refreshed) {
            const retryHeaders = normalizeHeaders(options.headers, options.body as BodyInit | null);
            const freshToken = getStoredToken() || (typeof window !== 'undefined' ? (localStorage.getItem('token') || localStorage.getItem('msme_auth_token')) : null);
            if (freshToken && freshToken !== 'null' && freshToken !== 'undefined' && freshToken !== COOKIE_SESSION_TOKEN) {
              retryHeaders['Authorization'] = `Bearer ${freshToken}`;
            }
            response = await sendRequest(retryHeaders);
          } else if (shouldDispatchUnauthorized(endpoint) && typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { code: errCode || 'SESSION_INVALID' } }));
          }
        }
      }
      if (response.status === 503 && !endpoint.includes('/health')) {
        if (typeof window !== 'undefined' && !window.location.pathname.includes('503')) {
          window.location.href = '/503.html';
        }
      }
      
      return response;
    }).catch(networkErrorResponse);

    return request;
  },

  get: (endpoint: string, options: RequestInit & { skipCache?: boolean } = {}) =>
    api.fetch(endpoint, { ...options, method: 'GET' }),

  post: (endpoint: string, body: any, options: RequestInit = {}) =>
    api.fetch(endpoint, {
      ...options,
      method: 'POST',
      body: body instanceof FormData ? body : JSON.stringify(body)
    }),

  put: (endpoint: string, body: any, options: RequestInit = {}) =>
    api.fetch(endpoint, {
      ...options,
      method: 'PUT',
      body: body instanceof FormData ? body : JSON.stringify(body)
    }),

  patch: (endpoint: string, body: any, options: RequestInit = {}) =>
    api.fetch(endpoint, {
      ...options,
      method: 'PATCH',
      body: body instanceof FormData ? body : JSON.stringify(body)
    }),

  delete: (endpoint: string, options: RequestInit = {}) =>
    api.fetch(endpoint, { ...options, method: 'DELETE' }),

  peek: (endpoint: string, options: RequestInit = {}): any => {
    // Legacy API cache peek stub
    return null;
  },

  invalidate: clearApiCache,
};
