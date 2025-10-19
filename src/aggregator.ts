#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { Level } from 'level';

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';
const DEFAULT_REPORT_INTERVAL_MS = 30_000;
const DEFAULT_TOP_COUNT = 10;
const DEFAULT_MAX_TRACKED_POSTS = 100_000;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_HALF_LIFE_HOURS = 3;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_DB_PATH = './data/aggregator-db';
const DEFAULT_SNAPSHOT_DIR = './data/aggregator-snapshots';
const DEFAULT_MAX_ACTIVE_LIKES = 200_000;
const DEFAULT_MAX_ACTIVE_REPOSTS = 120_000;
const DEFAULT_COMPACTION_DELAY_MS = 3 * 60 * 1000;
const REPOST_WEIGHT = 2;

const META_NEXT_POST_ID_KEY = 'meta:nextPostId';
const POST_ID_LOOKUP_PREFIX = 'postid:';
const POST_URI_PREFIX = 'posturi:';

const POST_PREFIX = 'post:';
const LIKE_PREFIX = 'like:';
const REPOST_PREFIX = 'repost:';
const POST_URL_PREFIX = 'posturl:';

interface JetstreamCommit {
  rev: string;
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: any;
  cid?: string;
}

interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: JetstreamCommit;
}

interface PostStats {
  likes: number;
  reposts: number;
  lastUpdated: number;
  id: number;
}

interface PersistedPostStats {
  likes: number;
  reposts: number;
  lastUpdated: number;
  id?: number;
}

interface RankedPost {
  uri: string;
  stats: PostStats;
  score: number;
  hotness: number;
  url: string | null;
}

type ArgMap = Record<string, string | boolean>;

interface AtUriParts {
  did: string;
  collection: string;
  rkey: string;
}

class LruCache<K, V> {
  private readonly maxSize: number;
  private readonly store = new Map<K, V>();

  constructor(limit: number) {
    this.maxSize = Math.max(0, limit);
  }

  get(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.maxSize === 0) return;
    if (this.store.has(key)) {
      this.store.delete(key);
    }
    this.store.set(key, value);
    if (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.store.entries();
  }

  keys(): IterableIterator<K> {
    return this.store.keys();
  }

  values(): IterableIterator<V> {
    return this.store.values();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.store[Symbol.iterator]();
  }
}

interface ProgressLogger {
  tick(delta?: number): void;
  done(extraMessage?: string): void;
}

function createProgressLogger(label: string, interval: number = 5_000): ProgressLogger {
  let count = 0;
  let lastLogged = 0;
  const startTime = Date.now();

  console.log(`${colors.dim}${label}…${colors.reset}`);

  return {
    tick(delta: number = 1) {
      count += delta;
      if (count - lastLogged < interval) {
        return;
      }
      lastLogged = count;
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      console.log(
        `  ${colors.gray}${label}:${colors.reset} ${colors.white}${count.toLocaleString()}${colors.reset} processed (${elapsedSeconds.toFixed(1)}s)`
      );
    },
    done(extraMessage?: string) {
      const elapsedSeconds = (Date.now() - startTime) / 1000;
      let message =
        `${colors.green}${colors.bright}✓${colors.reset} ${label} — ` +
        `${colors.white}${count.toLocaleString()}${colors.reset} processed in ` +
        `${colors.white}${elapsedSeconds.toFixed(1)}s${colors.reset}`;
      if (extraMessage) {
        message += ` (${extraMessage})`;
      }
      console.log(`  ${message}`);
    },
  };
}

type LevelBatchOperation =
  | { type: 'put'; key: string; value: unknown }
  | { type: 'del'; key: string };

interface KeyValueBatch {
  put(key: string, value: unknown): void;
  del(key: string): void;
  flush(): Promise<void>;
}

function createKeyValueBatch(
  targetDb: Level<string, unknown>,
  maxOps: number = 1_000
): KeyValueBatch {
  let pending: Promise<void> | null = null;
  let operations: LevelBatchOperation[] = [];

  const applyBatch = async (ops: LevelBatchOperation[]): Promise<void> => {
    if (ops.length === 0) return;
    try {
      await targetDb.batch(ops);
    } catch (error) {
      console.error(`${colors.red}Failed to apply LevelDB batch:${colors.reset}`, error);
    }
  };

  const scheduleFlush = (): void => {
    if (operations.length < maxOps || pending) {
      return;
    }
    const batch = operations;
    operations = [];
    pending = applyBatch(batch).finally(() => {
      pending = null;
      if (operations.length >= maxOps) {
        scheduleFlush();
      }
    });
  };

  return {
    put(key: string, value: unknown) {
      operations.push({ type: 'put', key, value });
      scheduleFlush();
    },
    del(key: string) {
      operations.push({ type: 'del', key });
      scheduleFlush();
    },
    async flush() {
      if (pending) {
        await pending;
      }
      const batch = operations;
      operations = [];
      await applyBatch(batch);
    },
  };
}

async function withWriteBatch<T>(batch: KeyValueBatch, fn: () => Promise<T>): Promise<T> {
  const previousBatch = activeWriteBatch;
  activeWriteBatch = batch;
  try {
    return await fn();
  } finally {
    await batch.flush();
    activeWriteBatch = previousBatch;
  }
}

const args = process.argv.slice(2);

function parseArgs(rawArgs: string[]): ArgMap {
  const parsed: ArgMap = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (!token.startsWith('--')) continue;

    const next = rawArgs[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[token] = next;
      i++;
    } else {
      parsed[token] = true;
    }
  }
  return parsed;
}

function parseAtUri(uri: string): AtUriParts | null {
  if (!uri.startsWith('at://')) return null;
  const trimmed = uri.slice('at://'.length);
  const segments = trimmed.split('/');
  if (segments.length < 3) return null;
  const [did, collection, rkey] = segments;
  if (!did || !collection || !rkey) return null;
  return { did, collection, rkey };
}

function toPostUrl(uri: string): string | null {
  const parts = parseAtUri(uri);
  if (!parts) return null;
  if (parts.collection !== 'app.bsky.feed.post') return null;
  return `https://bsky.app/profile/${parts.did}/post/${parts.rkey}`;
}

const parsedArgs = parseArgs(args);

function hasFlag(flag: string): boolean {
  return Object.prototype.hasOwnProperty.call(parsedArgs, flag);
}

function getNumberArg(flag: string, defaultValue: number): number {
  const raw = parsedArgs[flag];
  if (typeof raw === 'string') {
    const value = Number(raw);
    if (!Number.isNaN(value) && value > 0) {
      return value;
    }
  }
  return defaultValue;
}

function getStringArg(flag: string, defaultValue: string): string {
  const raw = parsedArgs[flag];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim();
  }
  return defaultValue;
}

const reportIntervalMs = getNumberArg('--interval-ms', DEFAULT_REPORT_INTERVAL_MS);
const topCount = Math.max(1, Math.floor(getNumberArg('--top', DEFAULT_TOP_COUNT)));
const maxTrackedPosts = Math.max(1000, Math.floor(getNumberArg('--max-posts', DEFAULT_MAX_TRACKED_POSTS)));
const windowHours = Math.max(1, Math.floor(getNumberArg('--window-hours', DEFAULT_WINDOW_HOURS)));
const baseRetentionMs = windowHours * 60 * 60 * 1000;
let staleIntervalMs = baseRetentionMs;
if (hasFlag('--stale-ms')) {
  staleIntervalMs = getNumberArg('--stale-ms', staleIntervalMs);
}
const maxPostAgeMs = staleIntervalMs;
const halfLifeHours = Math.max(0.25, getNumberArg('--half-life-hours', DEFAULT_HALF_LIFE_HOURS));
const snapshotIntervalMs = Math.max(60_000, getNumberArg('--snapshot-interval-ms', DEFAULT_SNAPSHOT_INTERVAL_MS));
const environmentSnapshotPath = process.env.SNAPSHOT_DIR && process.env.SNAPSHOT_DIR.trim().length > 0
  ? process.env.SNAPSHOT_DIR.trim()
  : DEFAULT_SNAPSHOT_DIR;
const snapshotDirArg = getStringArg('--snapshot-dir', environmentSnapshotPath);
const snapshotDir = path.isAbsolute(snapshotDirArg) ? snapshotDirArg : path.resolve(process.cwd(), snapshotDirArg);
const environmentDbPath = process.env.STATE_FILE && process.env.STATE_FILE.trim().length > 0
  ? process.env.STATE_FILE.trim()
  : DEFAULT_DB_PATH;
const dbPathArg = getStringArg('--state', environmentDbPath);
const dbPath = path.isAbsolute(dbPathArg) ? dbPathArg : path.resolve(process.cwd(), dbPathArg);
const maxActiveLikes = Math.max(1_000, Math.floor(getNumberArg('--max-active-likes', DEFAULT_MAX_ACTIVE_LIKES)));
const maxActiveReposts = Math.max(1_000, Math.floor(getNumberArg('--max-active-reposts', DEFAULT_MAX_ACTIVE_REPOSTS)));

if (parsedArgs['--help'] || parsedArgs['-h']) {
  console.log(`
${colors.bright}${colors.blue}Bluesky Like/Repost Aggregator${colors.reset}

Aggregates like and repost counts per post in real-time from the Jetstream firehose.

${colors.bright}Usage:${colors.reset}
  npm run aggregate -- [options]

${colors.bright}Options:${colors.reset}
  --interval-ms <ms>   Reporting interval in milliseconds (default ${DEFAULT_REPORT_INTERVAL_MS})
  --top <n>            Number of top posts to display per report (default ${DEFAULT_TOP_COUNT})
  --max-posts <n>      Maximum posts to track in memory (default ${DEFAULT_MAX_TRACKED_POSTS})
  --window-hours <h>   Hotness/retention window in hours (default ${DEFAULT_WINDOW_HOURS})
  --half-life-hours <h> Hotness half-life in hours (default ${DEFAULT_HALF_LIFE_HOURS})
  --snapshot-interval-ms <ms>
                       Snapshot interval in milliseconds (default ${DEFAULT_SNAPSHOT_INTERVAL_MS})
  --snapshot-dir <path> Directory for 10-minute snapshots (default ${DEFAULT_SNAPSHOT_DIR}, overridable via SNAPSHOT_DIR env)
  --stale-ms <ms>      Override retention window directly (advanced)
  --state <path>       LevelDB database directory (default ${DEFAULT_DB_PATH}, overridable via STATE_FILE env)
  --max-active-likes <n> Max in-memory like entries before falling back to LevelDB (default ${DEFAULT_MAX_ACTIVE_LIKES})
  --max-active-reposts <n> Max in-memory repost entries before falling back to LevelDB (default ${DEFAULT_MAX_ACTIVE_REPOSTS})
  --help, -h           Show this help message
`);
  process.exit(0);
}

console.log(`${colors.bright}${colors.blue}Bluesky Like/Repost Aggregator${colors.reset}`);
console.log(`${colors.gray}Endpoint: ${JETSTREAM_URL}${colors.reset}`);
console.log(`${colors.gray}Database path: ${dbPath}${colors.reset}`);
console.log(`${colors.gray}Report interval: ${(reportIntervalMs / 1000).toFixed(1)}s, top ${topCount} posts${colors.reset}`);
console.log(`${colors.gray}Tracking up to ${maxTrackedPosts.toLocaleString()} posts; retention ${(maxPostAgeMs / 1000 / 60 / 60).toFixed(1)} hours (half-life ${halfLifeHours.toFixed(1)}h)${colors.reset}`);
console.log(`${colors.gray}Snapshots every ${(snapshotIntervalMs / 1000 / 60).toFixed(1)} minutes → ${snapshotDir}${colors.reset}`);
console.log(`${colors.gray}Active cache limits: likes ≤ ${maxActiveLikes.toLocaleString()}, reposts ≤ ${maxActiveReposts.toLocaleString()}${colors.reset}`);
console.log(`${colors.gray}${'='.repeat(80)}${colors.reset}\n`);

const postStats = new Map<string, PostStats>();
const activeLikes = new LruCache<string, number>(maxActiveLikes);
const activeReposts = new LruCache<string, number>(maxActiveReposts);
const postIdByUri = new Map<string, number>();
const uriByPostId = new Map<number, string>();
const postUrlById = new Map<number, string | null>();

let reportTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let snapshotTimer: NodeJS.Timeout | null = null;
let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastReportTime: number | null = null;
let shuttingDown = false;
let db: Level<string, unknown>;
let snapshotQueue: Promise<void> = Promise.resolve();
let nextPostId = 1;
let activeWriteBatch: KeyValueBatch | null = null;
let startupMaintenanceTimer: NodeJS.Timeout | null = null;
let compactionTimer: NodeJS.Timeout | null = null;
let compactionInProgress = false;

function calculateScore(stats: PostStats): number {
  return stats.likes + REPOST_WEIGHT * stats.reposts;
}

function calculateHotness(stats: PostStats, now: number): number {
  const baseScore = calculateScore(stats);
  if (baseScore <= 0) return 0;
  const ageHours = Math.max(0, (now - stats.lastUpdated) / (60 * 60 * 1000));
  const decayFactor = Math.exp(-ageHours / halfLifeHours);
  return Number.isFinite(decayFactor) ? baseScore * decayFactor : baseScore;
}

function formatTimestamp(): string {
  return `${colors.gray}[${new Date().toISOString()}]${colors.reset}`;
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function postKey(uri: string): string {
  return `${POST_PREFIX}${uri}`;
}

function likeKey(id: string): string {
  return `${LIKE_PREFIX}${id}`;
}

function repostKey(id: string): string {
  return `${REPOST_PREFIX}${id}`;
}

function postIdLookupKey(uri: string): string {
  return `${POST_ID_LOOKUP_PREFIX}${uri}`;
}

function postUriKey(id: number): string {
  return `${POST_URI_PREFIX}${id}`;
}

function postUrlKey(id: number): string {
  return `${POST_URL_PREFIX}${id}`;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'notFound' in error &&
    (error as { notFound?: boolean }).notFound
  );
}

function resolvePostUrl(postId: number, uri: string): string | null {
  const cached = postUrlById.get(postId);
  if (cached !== undefined) {
    return cached;
  }
  const computed = toPostUrl(uri);
  postUrlById.set(postId, computed ?? null);
  if (computed) {
    void putKey(postUrlKey(postId), computed);
  } else {
    void delKey(postUrlKey(postId));
  }
  return computed ?? null;
}

function rememberPostId(postUri: string, postId: number, options?: { persist?: boolean; postUrl?: string | null }): void {
  let postUrl: string | null;
  if (options && Object.prototype.hasOwnProperty.call(options, 'postUrl')) {
    postUrl = options.postUrl ?? null;
  } else {
    postUrl = toPostUrl(postUri);
  }
  postIdByUri.set(postUri, postId);
  uriByPostId.set(postId, postUri);
  postUrlById.set(postId, postUrl ?? null);
  if (options?.persist === false) {
    return;
  }
  void putKey(postIdLookupKey(postUri), postId);
  void putKey(postUriKey(postId), postUri);
  if (postUrl) {
    void putKey(postUrlKey(postId), postUrl);
  } else {
    void delKey(postUrlKey(postId));
  }
}

function allocatePostId(postUri: string): number {
  const existing = postIdByUri.get(postUri);
  if (existing !== undefined) {
    return existing;
  }
  const id = nextPostId++;
  rememberPostId(postUri, id);
  void putKey(META_NEXT_POST_ID_KEY, nextPostId);
  return id;
}

async function removePostId(postUri: string, postId: number): Promise<void> {
  postIdByUri.delete(postUri);
  uriByPostId.delete(postId);
  postUrlById.delete(postId);
  await delKey(postIdLookupKey(postUri));
  await delKey(postUriKey(postId));
  await delKey(postUrlKey(postId));
}

async function resolveActiveAssociation(
  cache: LruCache<string, number>,
  cacheKey: string,
  storageKey: string
): Promise<number | undefined> {
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const stored = await db.get(storageKey);
    let postId: number | undefined;
    if (typeof stored === 'number') {
      postId = stored;
    } else if (typeof stored === 'string') {
      postId = postIdByUri.get(stored);
      if (postId !== undefined) {
        void putKey(storageKey, postId);
      }
    }
    if (postId !== undefined) {
      cache.set(cacheKey, postId);
      return postId;
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      console.error(`${colors.red}Failed to load association for ${storageKey}:${colors.reset}`, error);
    }
  }
  return undefined;
}

async function purgePersistedAssociationsByPostId(
  prefix: string,
  targetIds: Set<number>,
  skipKeys?: Set<string>
): Promise<void> {
  if (targetIds.size === 0) return;
  const upperBound = `${prefix}\uffff`;
  for await (const [key, value] of db.iterator({ gte: prefix, lt: upperBound })) {
    if (skipKeys?.has(key)) {
      continue;
    }
    if (typeof value === 'number') {
      if (targetIds.has(value)) {
        await delKey(key);
      }
    } else if (typeof value === 'string') {
      const postId = postIdByUri.get(value);
      if (postId !== undefined && targetIds.has(postId)) {
        await delKey(key);
      }
    }
  }
}

async function putKey(key: string, value: unknown): Promise<void> {
  const batch = activeWriteBatch;
  if (batch) {
    batch.put(key, value);
    return;
  }

  try {
    await db.put(key, value);
  } catch (error) {
    console.error(`${colors.red}Failed to persist key ${key}:${colors.reset}`, error);
  }
}

async function delKey(key: string): Promise<void> {
  const batch = activeWriteBatch;
  if (batch) {
    batch.del(key);
    return;
  }

  try {
    await db.del(key);
  } catch (error) {
    console.error(`${colors.red}Failed to delete key ${key}:${colors.reset}`, error);
  }
}

function ensurePostStats(postUri: string): PostStats {
  let stats = postStats.get(postUri);
  const now = Date.now();
  if (!stats) {
    const postId = postIdByUri.get(postUri) ?? allocatePostId(postUri);
    stats = { likes: 0, reposts: 0, lastUpdated: now, id: postId };
    postStats.set(postUri, stats);
  } else {
    stats.lastUpdated = now;
  }
  return stats;
}

async function cleanupActiveMaps(removedPostIds: number[]): Promise<void> {
  if (removedPostIds.length === 0) return;
  const idSet = new Set(removedPostIds);
  const deletedLikeKeys = new Set<string>();
  const deletedRepostKeys = new Set<string>();

  for (const [key, postId] of Array.from(activeLikes.entries())) {
    if (idSet.has(postId)) {
      activeLikes.delete(key);
      const storageKey = likeKey(key);
      deletedLikeKeys.add(storageKey);
      await delKey(storageKey);
    }
  }

  for (const [key, postId] of Array.from(activeReposts.entries())) {
    if (idSet.has(postId)) {
      activeReposts.delete(key);
      const storageKey = repostKey(key);
      deletedRepostKeys.add(storageKey);
      await delKey(storageKey);
    }
  }

  await purgePersistedAssociationsByPostId(LIKE_PREFIX, idSet, deletedLikeKeys);
  await purgePersistedAssociationsByPostId(REPOST_PREFIX, idSet, deletedRepostKeys);
}

async function pruneInactivePosts(): Promise<void> {
  const performPrune = async (): Promise<number> => {
    const removedIds: number[] = [];
    const now = Date.now();

    for (const [uri, stats] of postStats) {
      if (now - stats.lastUpdated > maxPostAgeMs) {
        postStats.delete(uri);
        removedIds.push(stats.id);
        await delKey(postKey(uri));
        await removePostId(uri, stats.id);
      }
    }

    if (postStats.size > maxTrackedPosts) {
      const excess = postStats.size - maxTrackedPosts;
      const entries = Array.from(postStats.entries()).sort(
        (a, b) => a[1].lastUpdated - b[1].lastUpdated
      );
      for (let i = 0; i < excess; i++) {
        const [uri] = entries[i];
        const stats = postStats.get(uri);
        if (stats && postStats.delete(uri)) {
          removedIds.push(stats.id);
          await delKey(postKey(uri));
          await removePostId(uri, stats.id);
        }
      }
    }

    await cleanupActiveMaps(removedIds);
    return removedIds.length;
  };

  const removedCount = activeWriteBatch
    ? await performPrune()
    : await withWriteBatch(createKeyValueBatch(db, 2_000), performPrune);

  if (removedCount > 0) {
    scheduleCompaction();
  }
}

function schedulePruning(): void {
  if (pruneTimer) return;
  const interval = Math.max(15_000, Math.min(5 * reportIntervalMs, maxPostAgeMs));
  pruneTimer = setInterval(() => {
    void pruneInactivePosts();
  }, interval);
}

function adjustLikeCount(postUri: string, delta: number): void {
  const stats = delta > 0 ? ensurePostStats(postUri) : postStats.get(postUri);
  if (!stats) return;

  stats.likes = Math.max(0, stats.likes + delta);
  stats.lastUpdated = Date.now();

  if (stats.likes === 0 && stats.reposts === 0) {
    postStats.delete(postUri);
    void delKey(postKey(postUri));
    void removePostId(postUri, stats.id);
  } else {
    void putKey(postKey(postUri), { ...stats });
  }
}

function adjustRepostCount(postUri: string, delta: number): void {
  const stats = delta > 0 ? ensurePostStats(postUri) : postStats.get(postUri);
  if (!stats) return;

  stats.reposts = Math.max(0, stats.reposts + delta);
  stats.lastUpdated = Date.now();

  if (stats.likes === 0 && stats.reposts === 0) {
    postStats.delete(postUri);
    void delKey(postKey(postUri));
    void removePostId(postUri, stats.id);
  } else {
    void putKey(postKey(postUri), { ...stats });
  }
}

function reportTopPosts(reason: string): void {
  const now = Date.now();
  const currentCpu = process.cpuUsage();
  const memory = process.memoryUsage();

  const rssMb = formatMB(memory.rss);
  const heapMb = formatMB(memory.heapUsed);
  const likeCacheSize = activeLikes.size().toLocaleString();
  const repostCacheSize = activeReposts.size().toLocaleString();
  const likeCacheLimit = maxActiveLikes.toLocaleString();
  const repostCacheLimit = maxActiveReposts.toLocaleString();

  let cpuDisplay = 'n/a';
  if (lastCpuUsage && lastReportTime) {
    const elapsedMs = now - lastReportTime;
    if (elapsedMs > 0) {
      const deltaUser = currentCpu.user - lastCpuUsage.user;
      const deltaSystem = currentCpu.system - lastCpuUsage.system;
      const totalCpuMs = Math.max(0, (deltaUser + deltaSystem) / 1000);
      const cpuPercent = (totalCpuMs / elapsedMs) * 100;
      cpuDisplay = `${cpuPercent.toFixed(1)}%`;
    }
  }

  lastCpuUsage = currentCpu;
  lastReportTime = now;

  console.log(`${formatTimestamp()} ${colors.bright}${reason}:${colors.reset}`);
  console.log(
    `  ${colors.dim}Resources${colors.reset}: RSS ${colors.white}${rssMb} MB${colors.reset}, ` +
    `Heap ${colors.white}${heapMb} MB${colors.reset}, CPU ${colors.white}${cpuDisplay}${colors.reset}, ` +
    `Likes cache ${colors.white}${likeCacheSize}${colors.reset}/${likeCacheLimit}, ` +
    `Reposts cache ${colors.white}${repostCacheSize}${colors.reset}/${repostCacheLimit}`
  );

  if (postStats.size === 0) {
    console.log(`  ${colors.dim}No like/repost data yet.${colors.reset}\n`);
    return;
  }

  const topEntries = getRankedPosts(topCount, now);
  for (const entry of topEntries) {
    const { uri, stats, score, hotness, url } = entry;
    const likePart = `${colors.magenta}${stats.likes} like${stats.likes === 1 ? '' : 's'}${colors.reset}`;
    const repostPart = `${colors.yellow}${stats.reposts} repost${stats.reposts === 1 ? '' : 's'}${colors.reset}`;
    const location = url
      ? `${colors.cyan}${url}${colors.reset} ${colors.dim}(${uri})${colors.reset}`
      : `${colors.cyan}${uri}${colors.reset}`;
    console.log(
      `  ${location} — ${likePart}, ${repostPart}, score ${colors.white}${score}${colors.reset}, hotness ${colors.white}${hotness.toFixed(2)}${colors.reset} (updated ${new Date(stats.lastUpdated).toISOString()})`
    );
  }
  console.log('');
}

function getRankedPosts(limit: number, now: number): RankedPost[] {
  const ranked: RankedPost[] = [];
  for (const [uri, stats] of postStats) {
    const score = calculateScore(stats);
    const hotness = calculateHotness(stats, now);
    const url = resolvePostUrl(stats.id, uri);
    ranked.push({
      uri,
      stats,
      score,
      hotness,
      url,
    });
  }

  ranked.sort((a, b) => {
    if (b.hotness !== a.hotness) return b.hotness - a.hotness;
    if (b.score !== a.score) return b.score - a.score;
    return b.stats.lastUpdated - a.stats.lastUpdated;
  });

  return ranked.slice(0, limit);
}

function snapshotPath(timestamp: number): { directory: string; filePath: string } {
  const iso = new Date(timestamp).toISOString();
  const day = iso.slice(0, 10);
  const timePart = iso.slice(11, 16).replace(':', '-');
  const directory = path.join(snapshotDir, day);
  const filePath = path.join(directory, `${day}T${timePart}Z.json`);
  return { directory, filePath };
}

async function writeSnapshot(reason: string): Promise<void> {
  const now = Date.now();
  const ranked = getRankedPosts(topCount, now);
  const payload = {
    generatedAt: new Date(now).toISOString(),
    reason,
    windowHours,
    halfLifeHours,
    topCount: ranked.length,
    posts: ranked.map((entry, index) => ({
      rank: index + 1,
      uri: entry.uri,
      url: entry.url,
      postId: entry.stats.id,
      likes: entry.stats.likes,
      reposts: entry.stats.reposts,
      score: entry.score,
      hotness: Number(entry.hotness.toFixed(6)),
      lastUpdated: new Date(entry.stats.lastUpdated).toISOString(),
    })),
  };

  try {
    const { directory, filePath } = snapshotPath(now);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`${formatTimestamp()} ${colors.dim}Snapshot saved (${reason}): ${filePath}${colors.reset}`);
  } catch (error) {
    console.error(`${colors.red}Failed to write snapshot:${colors.reset}`, error);
  }
}

function queueSnapshot(reason: string): void {
  snapshotQueue = snapshotQueue.then(() => writeSnapshot(reason));
}

function scheduleSnapshots(): void {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(() => {
    queueSnapshot('Periodic snapshot');
  }, snapshotIntervalMs);
}

function scheduleCompaction(delayMs: number = DEFAULT_COMPACTION_DELAY_MS): void {
  if (!db) return;
  const compactable = db as Level<string, unknown> & {
    compactRange?: (start?: string, end?: string) => Promise<void>;
  };
  if (typeof compactable.compactRange !== 'function') {
    return;
  }
  if (compactionTimer || compactionInProgress) {
    return;
  }

  compactionTimer = setTimeout(() => {
    compactionTimer = null;
    if (!db) return;
    const target = db as Level<string, unknown> & {
      compactRange?: (start?: string, end?: string) => Promise<void>;
    };
    if (typeof target.compactRange !== 'function') {
      return;
    }

    compactionInProgress = true;
    const startedAt = Date.now();
    void target
      .compactRange(undefined, undefined)
      .then(() => {
        const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(
          `${formatTimestamp()} ${colors.dim}LevelDB compaction completed in ${elapsedSeconds}s${colors.reset}`
        );
      })
      .catch((error) => {
        console.error(`${colors.red}LevelDB compaction failed:${colors.reset}`, error);
      })
      .finally(() => {
        compactionInProgress = false;
      });
  }, Math.max(1, delayMs));
}

function scheduleStartupMaintenance(delayMs: number = 10_000): void {
  if (startupMaintenanceTimer) return;
  startupMaintenanceTimer = setTimeout(() => {
    startupMaintenanceTimer = null;
    void pruneInactivePosts().catch((error) => {
      console.error(`${colors.red}Startup prune failed:${colors.reset}`, error);
    });
  }, Math.max(0, delayMs));
}

async function handleLike(event: JetstreamEvent, commit: JetstreamCommit): Promise<void> {
  const key = `${event.did}/${commit.rkey}`;
  const storageKey = likeKey(key);

  if (commit.operation === 'delete') {
    const postId = await resolveActiveAssociation(activeLikes, key, storageKey);
    if (postId !== undefined) {
      const subjectUri = uriByPostId.get(postId);
      if (subjectUri) {
        adjustLikeCount(subjectUri, -1);
      }
      activeLikes.delete(key);
      await delKey(storageKey);
    }
    return;
  }

  if (commit.operation !== 'create') return;
  const subjectUri = commit.record?.subject?.uri;
  if (!subjectUri) return;

  const stats = ensurePostStats(subjectUri);
  adjustLikeCount(subjectUri, 1);
  activeLikes.set(key, stats.id);
  void putKey(storageKey, stats.id);
}

async function handleRepost(event: JetstreamEvent, commit: JetstreamCommit): Promise<void> {
  const key = `${event.did}/${commit.rkey}`;
  const storageKey = repostKey(key);

  if (commit.operation === 'delete') {
    const postId = await resolveActiveAssociation(activeReposts, key, storageKey);
    if (postId !== undefined) {
      const subjectUri = uriByPostId.get(postId);
      if (subjectUri) {
        adjustRepostCount(subjectUri, -1);
      }
      activeReposts.delete(key);
      await delKey(storageKey);
    }
    return;
  }

  if (commit.operation !== 'create') return;
  const subjectUri = commit.record?.subject?.uri;
  if (!subjectUri) return;

  const stats = ensurePostStats(subjectUri);
  adjustRepostCount(subjectUri, 1);
  activeReposts.set(key, stats.id);
  void putKey(storageKey, stats.id);
}

async function handleCommitEvent(event: JetstreamEvent): Promise<void> {
  const commit = event.commit;
  if (!commit) return;

  switch (commit.collection) {
    case 'app.bsky.feed.like':
      await handleLike(event, commit);
      break;
    case 'app.bsky.feed.repost':
      await handleRepost(event, commit);
      break;
    default:
      break;
  }
}

function connect(): void {
  console.log(`${colors.dim}Connecting to Jetstream…${colors.reset}`);
  const ws = new WebSocket(JETSTREAM_URL);

  ws.on('open', () => {
    console.log(`${colors.green}${colors.bright}✓ Connected${colors.reset}`);
    if (!reportTimer) {
      reportTimer = setInterval(() => {
        reportTopPosts('Periodic report');
      }, reportIntervalMs);
    }
    schedulePruning();
    scheduleSnapshots();
    queueSnapshot('Connected snapshot');
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const event: JetstreamEvent = JSON.parse(data.toString());
      if (event.kind !== 'commit' || !event.commit) return;
      void handleCommitEvent(event).catch((error) => {
        console.error(`${colors.red}Failed to handle commit event:${colors.reset}`, error);
      });
    } catch (error) {
      console.error(`${colors.red}Failed to parse event:${colors.reset}`, error);
    }
  });

  ws.on('error', (error) => {
    console.error(`${colors.red}${colors.bright}WebSocket error:${colors.reset} ${error.message}`);
  });

  ws.on('close', () => {
    if (shuttingDown) return;
    console.log(`${colors.yellow}Connection closed. Reconnecting in 5s…${colors.reset}`);
    setTimeout(connect, 5000);
  });
}

async function loadState(): Promise<void> {
  postStats.clear();
  activeLikes.clear();
  activeReposts.clear();
  postIdByUri.clear();
  uriByPostId.clear();
  postUrlById.clear();

  console.log(`${colors.dim}Loading LevelDB state into memory…${colors.reset}`);

  let removedStale = 0;
  let highestSeenPostId = 0;
  const recoveryBatch = createKeyValueBatch(db, 5_000);

  await withWriteBatch(recoveryBatch, async () => {
    const now = Date.now();

    async function loadStoredNextPostId(): Promise<number | null> {
      try {
        const stored = await db.get(META_NEXT_POST_ID_KEY);
        const numeric = Number(stored);
        if (!Number.isNaN(numeric) && numeric > 0) {
          return Math.floor(numeric);
        }
        await delKey(META_NEXT_POST_ID_KEY);
      } catch (error) {
        if (!isNotFoundError(error)) {
          console.error(`${colors.red}Failed to load ${META_NEXT_POST_ID_KEY}:${colors.reset}`, error);
        }
      }
      return null;
    }

    async function restorePostIdLookups(): Promise<number> {
      let maxId = 0;
      const progress = createProgressLogger('Restoring post ID lookups');
      const upperBound = `${POST_ID_LOOKUP_PREFIX}\uffff`;
      for await (const [key, value] of db.iterator({ gte: POST_ID_LOOKUP_PREFIX, lt: upperBound })) {
        progress.tick();
        const uri = key.slice(POST_ID_LOOKUP_PREFIX.length);
        const idValue = Number(value);
        if (uri && Number.isInteger(idValue) && idValue > 0) {
          postIdByUri.set(uri, idValue);
          maxId = Math.max(maxId, idValue);
        } else {
          await delKey(key);
        }
      }
      const extra = maxId > 0 ? `highest id ${maxId.toLocaleString()}` : undefined;
      progress.done(extra);
      return maxId;
    }

    async function restorePostUriMappings(): Promise<number> {
      let maxId = 0;
      const progress = createProgressLogger('Restoring post URI mappings');
      const upperBound = `${POST_URI_PREFIX}\uffff`;
      for await (const [key, value] of db.iterator({ gte: POST_URI_PREFIX, lt: upperBound })) {
        progress.tick();
        const idValue = Number(key.slice(POST_URI_PREFIX.length));
        if (!Number.isInteger(idValue) || idValue <= 0) {
          await delKey(key);
          continue;
        }

        const metaValue = value as unknown;
        let uri: string | undefined;
        let url: string | null | undefined;
        if (typeof metaValue === 'string') {
          uri = metaValue;
        } else if (metaValue && typeof metaValue === 'object') {
          const meta = metaValue as { uri?: unknown; url?: unknown };
          if (typeof meta.uri === 'string') uri = meta.uri;
          if (typeof meta.url === 'string') url = meta.url;
          if (meta.url === null) url = null;
        }

        if (!uri) {
          await delKey(key);
          continue;
        }

        uriByPostId.set(idValue, uri);
        if (!postIdByUri.has(uri)) {
          postIdByUri.set(uri, idValue);
        }
        if (url !== undefined) {
          postUrlById.set(idValue, url);
        }
        maxId = Math.max(maxId, idValue);
      }
      const extra = maxId > 0 ? `highest id ${maxId.toLocaleString()}` : undefined;
      progress.done(extra);
      return maxId;
    }

    async function restorePostUrls(): Promise<number> {
      let maxId = 0;
      const progress = createProgressLogger('Restoring post URLs');
      const upperBound = `${POST_URL_PREFIX}\uffff`;
      for await (const [key, value] of db.iterator({ gte: POST_URL_PREFIX, lt: upperBound })) {
        progress.tick();
        const idValue = Number(key.slice(POST_URL_PREFIX.length));
        if (!Number.isInteger(idValue) || idValue <= 0) {
          await delKey(key);
          continue;
        }
        const storedUrl = typeof value === 'string'
          ? value
          : value === null
            ? null
            : undefined;
        if (storedUrl === undefined) {
          await delKey(key);
          continue;
        }
        postUrlById.set(idValue, storedUrl === '' ? null : storedUrl);
        maxId = Math.max(maxId, idValue);
      }
      const extra = maxId > 0 ? `highest id ${maxId.toLocaleString()}` : undefined;
      progress.done(extra);
      return maxId;
    }

    async function restorePosts(): Promise<{ loaded: number; removed: number; highestId: number }> {
      let restored = 0;
      let removed = 0;
      let highestId = 0;
      const progress = createProgressLogger('Restoring post aggregates');
      const upperBound = `${POST_PREFIX}\uffff`;
      for await (const [key, value] of db.iterator({ gte: POST_PREFIX, lt: upperBound })) {
        progress.tick();
        const uri = key.slice(POST_PREFIX.length);
        if (!uri) {
          await delKey(key);
          continue;
        }
        const persisted = value as PersistedPostStats | undefined;
        if (!persisted) {
          await delKey(key);
          continue;
        }

        const likes = Number(persisted.likes) || 0;
        const reposts = Number(persisted.reposts) || 0;
        const lastUpdated = Number(persisted.lastUpdated) || now;
        const persistedId = typeof persisted.id === 'number' && Number.isInteger(persisted.id) && persisted.id > 0
          ? persisted.id
          : undefined;

        if (likes === 0 && reposts === 0) {
          await delKey(key);
          const knownId = persistedId ?? postIdByUri.get(uri);
          if (knownId !== undefined) {
            await removePostId(uri, knownId);
          }
          continue;
        }

        if (now - lastUpdated > maxPostAgeMs) {
          removed++;
          await delKey(key);
          const knownId = persistedId ?? postIdByUri.get(uri);
          if (knownId !== undefined) {
            await removePostId(uri, knownId);
          }
          continue;
        }

        let postId = postIdByUri.get(uri);
        if (postId === undefined && persistedId !== undefined) {
          postId = persistedId;
          postIdByUri.set(uri, postId);
          uriByPostId.set(postId, uri);
        }
        if (postId === undefined) {
          postId = allocatePostId(uri);
        } else {
          uriByPostId.set(postId, uri);
          if (!postUrlById.has(postId)) {
            const resolvedUrl = toPostUrl(uri);
            postUrlById.set(postId, resolvedUrl ?? null);
          }
        }

        const stats: PostStats = {
          likes,
          reposts,
          lastUpdated,
          id: postId,
        };
        postStats.set(uri, stats);
        highestId = Math.max(highestId, postId);

        const persistedSnapshot = persisted as PersistedPostStats;
        const persistedPayload: PersistedPostStats = {
          likes: stats.likes,
          reposts: stats.reposts,
          lastUpdated: stats.lastUpdated,
          id: stats.id,
        };

        const needsRewrite =
          persistedSnapshot.likes !== persistedPayload.likes ||
          persistedSnapshot.reposts !== persistedPayload.reposts ||
          persistedSnapshot.lastUpdated !== persistedPayload.lastUpdated ||
          persistedSnapshot.id !== persistedPayload.id;

        if (needsRewrite) {
          void putKey(postKey(uri), persistedPayload);
        }
        restored++;
      }
      progress.done(`${restored.toLocaleString()} active, ${removed.toLocaleString()} stale removed`);
      return { loaded: restored, removed, highestId };
    }

    async function restoreLikes(): Promise<void> {
      const progress = createProgressLogger('Restoring like associations');
      let recovered = 0;
      let purged = 0;
      const upperBound = `${LIKE_PREFIX}\uffff`;
      for await (const [key, value] of db.iterator({ gte: LIKE_PREFIX, lt: upperBound })) {
        progress.tick();
        const likeId = key.slice(LIKE_PREFIX.length);
        let postId: number | undefined;
        if (typeof value === 'number') {
          postId = value;
        } else if (typeof value === 'string') {
          postId = postIdByUri.get(value);
          if (postId !== undefined) {
            void putKey(likeKey(likeId), postId);
          }
        }

        if (postId !== undefined) {
          const uri = uriByPostId.get(postId);
          if (uri && postStats.has(uri)) {
            activeLikes.set(likeId, postId);
            recovered++;
            continue;
          }
        }
        await delKey(key);
        purged++;
      }
      progress.done(`${recovered.toLocaleString()} active, ${purged.toLocaleString()} purged`);
    }

    async function restoreReposts(): Promise<void> {
      const progress = createProgressLogger('Restoring repost associations');
      let recovered = 0;
      let purged = 0;
      const upperBound = `${REPOST_PREFIX}\uffff`;
      for await (const [key, value] of db.iterator({ gte: REPOST_PREFIX, lt: upperBound })) {
        progress.tick();
        const repostId = key.slice(REPOST_PREFIX.length);
        let postId: number | undefined;
        if (typeof value === 'number') {
          postId = value;
        } else if (typeof value === 'string') {
          postId = postIdByUri.get(value);
          if (postId !== undefined) {
            void putKey(repostKey(repostId), postId);
          }
        }

        if (postId !== undefined) {
          const uri = uriByPostId.get(postId);
          if (uri && postStats.has(uri)) {
            activeReposts.set(repostId, postId);
            recovered++;
            continue;
          }
        }
        await delKey(key);
        purged++;
      }
      progress.done(`${recovered.toLocaleString()} active, ${purged.toLocaleString()} purged`);
    }

    const storedNextPostId = await loadStoredNextPostId();
    highestSeenPostId = Math.max(highestSeenPostId, await restorePostIdLookups());
    highestSeenPostId = Math.max(highestSeenPostId, await restorePostUriMappings());
    highestSeenPostId = Math.max(highestSeenPostId, await restorePostUrls());

    nextPostId = Math.max(storedNextPostId ?? 0, highestSeenPostId + 1, 1);

    const postResult = await restorePosts();
    removedStale += postResult.removed;
    highestSeenPostId = Math.max(highestSeenPostId, postResult.highestId);
    nextPostId = Math.max(nextPostId, highestSeenPostId + 1);

    void putKey(META_NEXT_POST_ID_KEY, nextPostId);

    await restoreLikes();
    await restoreReposts();
  });

  if (removedStale > 0) {
    scheduleCompaction(30_000);
  }

  console.log(
    `${colors.gray}Recovered ${postStats.size} posts (${activeLikes.size()} likes, ${activeReposts.size()} reposts) from LevelDB` +
    (removedStale ? `, removed ${removedStale} stale entries` : '') +
    `${colors.reset}`
  );
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${colors.yellow}Received ${signal}. Shutting down…${colors.reset}`);

  if (reportTimer) clearInterval(reportTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);

  await snapshotQueue;

  reportTopPosts('Final report');
  await pruneInactivePosts();
  await writeSnapshot('Final snapshot');

  try {
    await db.close();
  } catch (error) {
    console.error(`${colors.red}Failed to close database:${colors.reset}`, error);
  }

  process.exit(0);
}

async function main(): Promise<void> {
  db = new Level<string, unknown>(dbPath, { valueEncoding: 'json' });
  await db.open();
  await loadState();
  scheduleStartupMaintenance();
  reportTopPosts('Initial status');
  queueSnapshot('Initial snapshot');
  connect();
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

main().catch((error) => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, error);
  process.exit(1);
});
