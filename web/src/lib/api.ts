import { emitToast } from './toast.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Fired on window when any API call comes back 401 (e.g. the device was revoked). */
export const UNAUTHORIZED_EVENT = 'sb:unauthorized';

/** Raw request. Throws ApiError on non-2xx. */
export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the Switchboard daemon');
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const msg =
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `${res.status} ${res.statusText || 'request failed'}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

/** Request that reports failures as an error toast and resolves to null instead of throwing. */
export async function call<T>(method: Method, path: string, body?: unknown): Promise<T | null> {
  try {
    return await request<T>(method, path, body);
  } catch (e) {
    emitToast('error', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export const api = {
  get: <T>(path: string) => call<T>('GET', path),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
  del: <T>(path: string) => call<T>('DELETE', path),
};

export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
