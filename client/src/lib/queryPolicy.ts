import { ACCOUNT_DISABLED_ERR_MSG, SESSION_REPLACED_ERR_MSG, UNAUTHED_ERR_MSG } from "../../../shared/const";
import { DATABASE_UNAVAILABLE_MESSAGE } from "../../../shared/databaseHealth";

export function isAuthenticationFailure(error: unknown) {
  const message = (error as { message?: string } | null)?.message;
  return message === UNAUTHED_ERR_MSG || message === ACCOUNT_DISABLED_ERR_MSG || message === SESSION_REPLACED_ERR_MSG;
}

export function shouldRetryQuery(failureCount: number, error: unknown) {
  if (isAuthenticationFailure(error)) return false;
  const value = error as { message?: string; data?: { code?: string; httpStatus?: number } } | null;
  if (value?.message === DATABASE_UNAVAILABLE_MESSAGE || value?.data?.code === "SERVICE_UNAVAILABLE" ||
    value?.data?.code === "TOO_MANY_REQUESTS" || value?.data?.httpStatus === 503 || value?.data?.httpStatus === 429) return false;
  return failureCount < 1;
}

type PollingQuery = { state: { status: string; error: unknown; errorUpdateCount: number } };
const failures = new WeakMap<object, { errorUpdateCount: number; count: number }>();

// Failed periodic reads back off 5/10/20/30s without clearing existing data.
// Keep state on the Query (not the render/interval closure), reset on success.
export function adaptivePollingInterval(interval: number | false) {
  return (query: PollingQuery): number | false => {
    if (interval === false) return false;
    if (query.state.status !== "error") { failures.delete(query); return interval; }
    if (isAuthenticationFailure(query.state.error)) return false;
    const previous = failures.get(query);
    const count = previous ? previous.count + (previous.errorUpdateCount !== query.state.errorUpdateCount ? 1 : 0) : 1;
    failures.set(query, { errorUpdateCount: query.state.errorUpdateCount, count });
    return Math.max(interval, Math.min(30_000, 5_000 * 2 ** Math.min(count - 1, 3)));
  };
}

const authRetryInterval = adaptivePollingInterval(3000);
export function retryAuthCheck(query: PollingQuery) {
  if (query.state.status === "error") return authRetryInterval(query);
  failures.delete(query);
  return false;
}

export function isAuthCheckPending(user: unknown, loading: boolean, error: unknown) {
  // undefined means not verified yet, whereas null is a confirmed anonymous user.
  return loading || (user === undefined && !!error && !isAuthenticationFailure(error));
}
