/**
 * In-process authentication attempt limits shared by password and 2FA flows.
 *
 * The panel already keeps these counters in memory for password login. Keeping
 * the 2FA paths on the same counters prevents an attacker from moving between
 * login, challenge verification, and 2FA-management endpoints to reset the
 * failure budget.
 */

import { pruneMapEntries, setBoundedMapValue } from "./boundedCache";

export type AuthRateLimitState = {
  limited: boolean;
  retryAfterSeconds: number;
};

type FailureEntry = { count: number; lastFailAt: number };

export const LOGIN_FAIL_WINDOW_MS = 30 * 60 * 1000;
export const LOGIN_BLOCK_MS = 15 * 60 * 1000;
export const LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT = 8;
export const LOGIN_BLOCK_THRESHOLD_PER_IP = 40;

export const TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS = 60 * 1000;
export const TWO_FACTOR_CHALLENGE_ISSUE_MAX = 5;

const loginFailStore = new Map<string, FailureEntry>();
const loginAccountFailStore = new Map<string, FailureEntry>();
const loginIpFailStore = new Map<string, FailureEntry>();
const challengeIssueStore = new Map<string, number[]>();
const challengeIssueAccountStore = new Map<string, number[]>();
const challengeIssueIpStore = new Map<string, number[]>();
const AUTH_RATE_LIMIT_MAX_KEYS = 50_000;

function normalizeIp(ip: string) {
  return String(ip || "unknown").trim().toLowerCase() || "unknown";
}

function normalizeUsername(username: string) {
  return String(username || "").trim().toLowerCase();
}

export function getAuthAttemptKey(ip: string, username: string) {
  return `${normalizeIp(ip)}:${normalizeUsername(username)}`;
}

function activeFailureEntry(store: Map<string, FailureEntry>, key: string, now = Date.now()) {
  const entry = store.get(key);
  if (!entry) return null;
  if (now - entry.lastFailAt < LOGIN_FAIL_WINDOW_MS) return entry;
  store.delete(key);
  return null;
}

function recordFailure(store: Map<string, FailureEntry>, key: string, now = Date.now()) {
  const entry = activeFailureEntry(store, key, now);
  if (entry) {
    entry.count += 1;
    entry.lastFailAt = now;
    setBoundedMapValue(store, key, entry, AUTH_RATE_LIMIT_MAX_KEYS);
  } else {
    setBoundedMapValue(store, key, { count: 1, lastFailAt: now }, AUTH_RATE_LIMIT_MAX_KEYS);
  }
}

/** Record a 2FA failure for pair, account, and IP scopes. */
export function recordAuthFailure(ip: string, username: string, now = Date.now()) {
  recordFailure(loginFailStore, getAuthAttemptKey(ip, username), now);
  recordFailure(loginAccountFailStore, normalizeUsername(username), now);
  recordFailure(loginIpFailStore, normalizeIp(ip), now);
}

/** Password failures remain scoped to the source IP to avoid account lockout DoS. */
export function recordPasswordFailure(ip: string, username: string, now = Date.now()) {
  recordFailure(loginFailStore, getAuthAttemptKey(ip, username), now);
  recordFailure(loginIpFailStore, normalizeIp(ip), now);
}

/** Explicit name for callers handling a known account's 2FA proof. */
export const recordTwoFactorFailure = recordAuthFailure;

/** Return the same block state used by the password login endpoint. */
export function authRateLimitState(ip: string, username: string, now = Date.now()): AuthRateLimitState {
  const checks = [
    { entry: activeFailureEntry(loginFailStore, getAuthAttemptKey(ip, username), now), threshold: LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT },
    { entry: activeFailureEntry(loginAccountFailStore, normalizeUsername(username), now), threshold: LOGIN_BLOCK_THRESHOLD_PER_ACCOUNT },
    { entry: activeFailureEntry(loginIpFailStore, normalizeIp(ip), now), threshold: LOGIN_BLOCK_THRESHOLD_PER_IP },
  ];
  for (const check of checks) {
    const entry = check.entry;
    if (!entry || entry.count < check.threshold) continue;
    const retryAt = entry.lastFailAt + LOGIN_BLOCK_MS;
    if (retryAt > now) {
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)),
      };
    }
  }
  return { limited: false, retryAfterSeconds: 0 };
}

/** Clear the target account's failures after a successful authentication. */
export function clearAuthAccountFailures(ip: string, username: string) {
  loginFailStore.delete(getAuthAttemptKey(ip, username));
  loginAccountFailStore.delete(normalizeUsername(username));
}

function challengeIssueKey(ip: string, username: string) {
  return getAuthAttemptKey(ip, username);
}

/**
 * Limit successful-password 2FA challenge issuance as well as failed guesses.
 * Without this separate window, an attacker with the password could mint an
 * unlimited number of fresh five-attempt challenges.
 */
export function twoFactorChallengeIssueState(ip: string, username: string, now = Date.now()): AuthRateLimitState {
  const cutoff = now - TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS;
  const scopes = [
    { store: challengeIssueStore, key: challengeIssueKey(ip, username) },
    { store: challengeIssueAccountStore, key: normalizeUsername(username) },
    { store: challengeIssueIpStore, key: normalizeIp(ip) },
  ];
  let retryAfterSeconds = 0;
  for (const scope of scopes) {
    const timestamps = scope.store.get(scope.key);
    if (!timestamps) continue;
    const active = timestamps.filter((timestamp) => timestamp > cutoff);
    if (active.length > 0) setBoundedMapValue(scope.store, scope.key, active, AUTH_RATE_LIMIT_MAX_KEYS);
    else scope.store.delete(scope.key);
    if (active.length >= TWO_FACTOR_CHALLENGE_ISSUE_MAX) {
      retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((active[0] + TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS - now) / 1000));
    }
  }
  return retryAfterSeconds > 0
    ? { limited: true, retryAfterSeconds }
    : { limited: false, retryAfterSeconds: 0 };
}

export function recordTwoFactorChallengeIssue(ip: string, username: string, now = Date.now()) {
  const cutoff = now - TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS;
  const scopes = [
    { store: challengeIssueStore, key: challengeIssueKey(ip, username) },
    { store: challengeIssueAccountStore, key: normalizeUsername(username) },
    { store: challengeIssueIpStore, key: normalizeIp(ip) },
  ];
  for (const scope of scopes) {
    const active = (scope.store.get(scope.key) || []).filter((timestamp) => timestamp > cutoff);
    active.push(now);
    setBoundedMapValue(scope.store, scope.key, active, AUTH_RATE_LIMIT_MAX_KEYS);
  }
}

export function pruneAuthRateLimitState(now = Date.now()) {
  const failureExpired = (entry: FailureEntry) => now - entry.lastFailAt >= LOGIN_FAIL_WINDOW_MS;
  pruneMapEntries(loginFailStore, failureExpired);
  pruneMapEntries(loginAccountFailStore, failureExpired);
  pruneMapEntries(loginIpFailStore, failureExpired);
  const cutoff = now - TWO_FACTOR_CHALLENGE_ISSUE_WINDOW_MS;
  for (const store of [challengeIssueStore, challengeIssueAccountStore, challengeIssueIpStore]) {
    for (const [key, timestamps] of store) {
      const active = timestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length > 0) setBoundedMapValue(store, key, active, AUTH_RATE_LIMIT_MAX_KEYS);
      else store.delete(key);
    }
  }
}

export function clearTwoFactorChallengeIssueHistory(ip: string, username: string) {
  challengeIssueStore.delete(challengeIssueKey(ip, username));
  challengeIssueAccountStore.delete(normalizeUsername(username));
}

/** Test-only reset hook; no production code calls this. */
export function clearAuthRateLimitStateForTests() {
  loginFailStore.clear();
  loginAccountFailStore.clear();
  loginIpFailStore.clear();
  challengeIssueStore.clear();
  challengeIssueAccountStore.clear();
  challengeIssueIpStore.clear();
}

export function authRateLimitStoreSizesForTests() {
  return {
    failures: loginFailStore.size + loginAccountFailStore.size + loginIpFailStore.size,
    challengeIssues: challengeIssueStore.size + challengeIssueAccountStore.size + challengeIssueIpStore.size,
  };
}

const authRateLimitCleanupTimer = setInterval(() => pruneAuthRateLimitState(), 5 * 60 * 1000);
authRateLimitCleanupTimer.unref?.();
