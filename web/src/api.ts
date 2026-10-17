/** Thin client for the REST API. Every screen talks to the server through this module. */

const BASE = '/api/v1';
let csrfToken = '';

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

/** Raised when the server could not be reached, so the outcome of the request is unknown. */
export class NetworkError extends Error {
  constructor() {
    super('The server could not be reached. Check your connection and try again.');
  }
}

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method, credentials: 'same-origin',
      headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const err = payload?.error;
  if (res.status === 401 && !path.startsWith('/auth/')) onUnauthenticated?.();
  throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `The request failed (${res.status}).`, err?.details);
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(params?: Query): string {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  get: <T = any>(path: string, params?: Query) => send<T>('GET', path + qs(params)),
  post: <T = any>(path: string, body?: unknown) => send<T>('POST', path, body ?? {}),
  patch: <T = any>(path: string, body?: unknown) => send<T>('PATCH', path, body ?? {}),
  put: <T = any>(path: string, body?: unknown) => send<T>('PUT', path, body ?? {}),
  del: <T = any>(path: string) => send<T>('DELETE', path),
  /** URL for a file the browser downloads or opens itself (session cookie authenticates it). */
  url: (path: string, params?: Query) => BASE + path + qs(params),
  download,
};

/** Fetches a file and saves it, so a slow file (e.g. a contract printed to PDF) can show progress and a readable error. */
async function download(path: string, params?: Query): Promise<void> {
  let res: Response;
  try {
    res = await fetch(BASE + path + qs(params), { credentials: 'same-origin' });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    const err = await res.json().then((p) => p?.error, () => null);
    if (res.status === 401) onUnauthenticated?.();
    throw new ApiError(res.status, err?.code ?? 'ERROR', err?.message ?? `The download failed (${res.status}).`, err?.details);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'download';
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof NetworkError) return err.message;
  return 'Something unexpected happened. Please try again.';
}

/** Key identifying one submission of a financial form; reused on retry so the server never records it twice. */
export function newSubmissionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}
