#!/usr/bin/env node

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
const DEFAULT_STALE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_DB_PATH = './data/aggregator-db';

const POST_PREFIX = 'post:';
const LIKE_PREFIX = 'like:';
const REPOST_PREFIX = 'repost:';

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
}

interface PersistedPostStats {
  likes: number;
  reposts: number;
  lastUpdated: number;
}

type ArgMap = Record<string, string | boolean>;

interface AtUriParts {
  did: string;
  collection: string;
  rkey: string;
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
const staleIntervalMs = getNumberArg('--stale-ms', DEFAULT_STALE_INTERVAL_MS);
const environmentDbPath = process.env.STATE_FILE && process.env.STATE_FILE.trim().length > 0
  ? process.env.STATE_FILE.trim()
  : DEFAULT_DB_PATH;
const dbPathArg = getStringArg('--state', environmentDbPath);
const dbPath = path.isAbsolute(dbPathArg) ? dbPathArg : path.resolve(process.cwd(), dbPathArg);

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
  --stale-ms <ms>      Drop posts inactive for this long (default ${DEFAULT_STALE_INTERVAL_MS})
  --state <path>       LevelDB database directory (default ${DEFAULT_DB_PATH}, overridable via STATE_FILE env)
  --help, -h           Show this help message
`);
  process.exit(0);
}

console.log(`${colors.bright}${colors.blue}Bluesky Like/Repost Aggregator${colors.reset}`);
console.log(`${colors.gray}Endpoint: ${JETSTREAM_URL}${colors.reset}`);
console.log(`${colors.gray}Database path: ${dbPath}${colors.reset}`);
console.log(`${colors.gray}Report interval: ${(reportIntervalMs / 1000).toFixed(1)}s, top ${topCount} posts${colors.reset}`);
console.log(`${colors.gray}Tracking up to ${maxTrackedPosts.toLocaleString()} posts; stale after ${(staleIntervalMs / 1000 / 60).toFixed(1)} minutes${colors.reset}`);
console.log(`${colors.gray}${'='.repeat(80)}${colors.reset}\n`);

const postStats = new Map<string, PostStats>();
const activeLikes = new Map<string, string>();
const activeReposts = new Map<string, string>();

let reportTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastReportTime: number | null = null;
let shuttingDown = false;
let db: Level<string, unknown>;

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

async function putKey(key: string, value: unknown): Promise<void> {
  try {
    await db.put(key, value);
  } catch (error) {
    console.error(`${colors.red}Failed to persist key ${key}:${colors.reset}`, error);
  }
}

async function delKey(key: string): Promise<void> {
  try {
    await db.del(key);
  } catch (error) {
    console.error(`${colors.red}Failed to delete key ${key}:${colors.reset}`, error);
  }
}

function ensurePostStats(postUri: string): PostStats {
  let stats = postStats.get(postUri);
  if (!stats) {
    stats = { likes: 0, reposts: 0, lastUpdated: Date.now() };
    postStats.set(postUri, stats);
  } else {
    stats.lastUpdated = Date.now();
  }
  return stats;
}

async function cleanupActiveMaps(removedUris: string[]): Promise<void> {
  if (removedUris.length === 0) return;
  const uriSet = new Set(removedUris);

  for (const [key, uri] of activeLikes) {
    if (uriSet.has(uri)) {
      activeLikes.delete(key);
      await delKey(likeKey(key));
    }
  }

  for (const [key, uri] of activeReposts) {
    if (uriSet.has(uri)) {
      activeReposts.delete(key);
      await delKey(repostKey(key));
    }
  }
}

async function pruneInactivePosts(): Promise<void> {
  const removed: string[] = [];
  const now = Date.now();

  for (const [uri, stats] of postStats) {
    if (now - stats.lastUpdated > staleIntervalMs) {
      postStats.delete(uri);
      removed.push(uri);
      await delKey(postKey(uri));
    }
  }

  if (postStats.size > maxTrackedPosts) {
    const excess = postStats.size - maxTrackedPosts;
    const entries = Array.from(postStats.entries()).sort(
      (a, b) => a[1].lastUpdated - b[1].lastUpdated
    );
    for (let i = 0; i < excess; i++) {
      const [uri] = entries[i];
      if (postStats.delete(uri)) {
        removed.push(uri);
        await delKey(postKey(uri));
      }
    }
  }

  await cleanupActiveMaps(removed);
}

function schedulePruning(): void {
  if (pruneTimer) return;
  const interval = Math.max(15_000, Math.min(5 * reportIntervalMs, staleIntervalMs));
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
    `Heap ${colors.white}${heapMb} MB${colors.reset}, CPU ${colors.white}${cpuDisplay}${colors.reset}`
  );

  if (postStats.size === 0) {
    console.log(`  ${colors.dim}No like/repost data yet.${colors.reset}\n`);
    return;
  }

  const entries = Array.from(postStats.entries());
  entries.sort((a, b) => {
    const scoreA = a[1].likes + a[1].reposts;
    const scoreB = b[1].likes + b[1].reposts;
    if (scoreA === scoreB) {
      return b[1].lastUpdated - a[1].lastUpdated;
    }
    return scoreB - scoreA;
  });

  const topEntries = entries.slice(0, topCount);
  for (const [uri, stats] of topEntries) {
    const likePart = `${colors.magenta}${stats.likes} like${stats.likes === 1 ? '' : 's'}${colors.reset}`;
    const repostPart = `${colors.yellow}${stats.reposts} repost${stats.reposts === 1 ? '' : 's'}${colors.reset}`;
    const url = toPostUrl(uri);
    const location = url
      ? `${colors.cyan}${url}${colors.reset} ${colors.dim}(${uri})${colors.reset}`
      : `${colors.cyan}${uri}${colors.reset}`;
    console.log(
      `  ${location} — ${likePart}, ${repostPart} (updated ${new Date(stats.lastUpdated).toISOString()})`
    );
  }
  console.log('');
}

function handleLike(event: JetstreamEvent, commit: JetstreamCommit): void {
  const key = `${event.did}/${commit.rkey}`;

  if (commit.operation === 'delete') {
    const subjectUri = activeLikes.get(key);
    if (subjectUri) {
      adjustLikeCount(subjectUri, -1);
      activeLikes.delete(key);
      void delKey(likeKey(key));
    }
    return;
  }

  if (commit.operation !== 'create') return;
  const subjectUri = commit.record?.subject?.uri;
  if (!subjectUri) return;

  adjustLikeCount(subjectUri, 1);
  activeLikes.set(key, subjectUri);
  void putKey(likeKey(key), subjectUri);
}

function handleRepost(event: JetstreamEvent, commit: JetstreamCommit): void {
  const key = `${event.did}/${commit.rkey}`;

  if (commit.operation === 'delete') {
    const subjectUri = activeReposts.get(key);
    if (subjectUri) {
      adjustRepostCount(subjectUri, -1);
      activeReposts.delete(key);
      void delKey(repostKey(key));
    }
    return;
  }

  if (commit.operation !== 'create') return;
  const subjectUri = commit.record?.subject?.uri;
  if (!subjectUri) return;

  adjustRepostCount(subjectUri, 1);
  activeReposts.set(key, subjectUri);
  void putKey(repostKey(key), subjectUri);
}

function handleCommitEvent(event: JetstreamEvent): void {
  const commit = event.commit;
  if (!commit) return;

  switch (commit.collection) {
    case 'app.bsky.feed.like':
      handleLike(event, commit);
      break;
    case 'app.bsky.feed.repost':
      handleRepost(event, commit);
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
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const event: JetstreamEvent = JSON.parse(data.toString());
      if (event.kind !== 'commit' || !event.commit) return;
      handleCommitEvent(event);
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
  const now = Date.now();
  let loadedPosts = 0;
  let removedStale = 0;
  const pendingLikes: Array<[string, string]> = [];
  const pendingReposts: Array<[string, string]> = [];

  for await (const [key, value] of db.iterator()) {
    if (typeof key !== 'string') continue;

    if (key.startsWith(POST_PREFIX)) {
      const uri = key.slice(POST_PREFIX.length);
      const persisted = value as PersistedPostStats | undefined;
      if (!persisted) {
        await delKey(key);
        continue;
      }
      const likes = Number(persisted.likes) || 0;
      const reposts = Number(persisted.reposts) || 0;
      const lastUpdated = Number(persisted.lastUpdated) || now;

      if (likes === 0 && reposts === 0) {
        await delKey(key);
        continue;
      }

      if (now - lastUpdated > staleIntervalMs) {
        removedStale++;
        await delKey(key);
        continue;
      }

      postStats.set(uri, { likes, reposts, lastUpdated });
      loadedPosts++;
    } else if (key.startsWith(LIKE_PREFIX)) {
      pendingLikes.push([key.slice(LIKE_PREFIX.length), value as string]);
    } else if (key.startsWith(REPOST_PREFIX)) {
      pendingReposts.push([key.slice(REPOST_PREFIX.length), value as string]);
    }
  }

  for (const [likeId, uri] of pendingLikes) {
    if (uri && postStats.has(uri)) {
      activeLikes.set(likeId, uri);
    } else {
      await delKey(likeKey(likeId));
    }
  }

  for (const [repostId, uri] of pendingReposts) {
    if (uri && postStats.has(uri)) {
      activeReposts.set(repostId, uri);
    } else {
      await delKey(repostKey(repostId));
    }
  }

  await pruneInactivePosts();

  console.log(
    `${colors.gray}Recovered ${postStats.size} posts (${activeLikes.size} likes, ${activeReposts.size} reposts) from LevelDB` +
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

  reportTopPosts('Final report');
  await pruneInactivePosts();

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
  reportTopPosts('Initial status');
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
