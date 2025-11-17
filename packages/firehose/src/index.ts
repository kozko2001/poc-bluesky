#!/usr/bin/env node

import WebSocket from 'ws';

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

// Configuration
const JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe';
const RECONNECT_DELAY = 5000; // 5 seconds

// Command-line argument parsing
const args = process.argv.slice(2);
const filters = {
  postsOnly: args.includes('--posts-only'),
  likesOnly: args.includes('--likes-only'),
  followsOnly: args.includes('--follows-only'),
  repostsOnly: args.includes('--reposts-only'),
  deletesOnly: args.includes('--deletes-only'),
};

// Check if any filter is active
const hasFilter = Object.values(filters).some(v => v);

interface JetstreamCommit {
  rev: string;
  operation: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  record?: any;
  cid?: string;
}

interface JetstreamIdentity {
  did: string;
  handle?: string;
  seq?: number;
  time?: string;
}

interface JetstreamAccount {
  did: string;
  seq?: number;
  time?: string;
  active?: boolean;
  status?: string;
}

interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: 'commit' | 'identity' | 'account';
  commit?: JetstreamCommit;
  identity?: JetstreamIdentity;
  account?: JetstreamAccount;
}

function formatTimestamp(): string {
  const now = new Date();
  return `${colors.gray}[${now.toISOString()}]${colors.reset}`;
}

function truncateText(text: string, maxLength: number = 100): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function formatDID(did: string): string {
  // Show first and last parts of DID for readability
  if (did.length > 30) {
    return `${did.substring(0, 15)}...${did.substring(did.length - 10)}`;
  }
  return did;
}

function shouldDisplayEvent(collection: string): boolean {
  if (!hasFilter) return true;

  if (filters.postsOnly && collection === 'app.bsky.feed.post') return true;
  if (filters.likesOnly && collection === 'app.bsky.feed.like') return true;
  if (filters.followsOnly && collection === 'app.bsky.graph.follow') return true;
  if (filters.repostsOnly && collection === 'app.bsky.feed.repost') return true;
  if (filters.deletesOnly) return false; // Deletes are shown separately

  return false;
}

function handleCommitEvent(event: JetstreamEvent) {
  const commit = event.commit!;
  const collection = commit.collection;
  const operation = commit.operation;

  if (operation === 'delete') {
    if (!filters.deletesOnly && hasFilter) return;
    console.log(
      `${formatTimestamp()} ${colors.red}${colors.bright}[DELETE]${colors.reset} ` +
      `${colors.gray}${collection}${colors.reset} ` +
      `by ${colors.cyan}${formatDID(event.did)}${colors.reset}`
    );
    return;
  }

  if (!shouldDisplayEvent(collection)) return;

  const record = commit.record;

  switch (collection) {
    case 'app.bsky.feed.post':
      const postText = record?.text || '[no text]';
      const replyTo = record?.reply ? ' (reply)' : '';
      console.log(
        `${formatTimestamp()} ${colors.blue}${colors.bright}[POST]${colors.reset}${colors.dim}${replyTo}${colors.reset} ` +
        `${colors.cyan}${formatDID(event.did)}${colors.reset}: ` +
        `${colors.white}${truncateText(postText)}${colors.reset}`
      );
      break;

    case 'app.bsky.feed.like':
      const likedUri = record?.subject?.uri || '[unknown]';
      console.log(
        `${formatTimestamp()} ${colors.magenta}${colors.bright}[LIKE]${colors.reset} ` +
        `${colors.cyan}${formatDID(event.did)}${colors.reset} liked ` +
        `${colors.gray}${truncateText(likedUri, 60)}${colors.reset}`
      );
      break;

    case 'app.bsky.graph.follow':
      const followedDID = record?.subject || '[unknown]';
      console.log(
        `${formatTimestamp()} ${colors.green}${colors.bright}[FOLLOW]${colors.reset} ` +
        `${colors.cyan}${formatDID(event.did)}${colors.reset} followed ` +
        `${colors.cyan}${formatDID(followedDID)}${colors.reset}`
      );
      break;

    case 'app.bsky.feed.repost':
      const repostedUri = record?.subject?.uri || '[unknown]';
      console.log(
        `${formatTimestamp()} ${colors.yellow}${colors.bright}[REPOST]${colors.reset} ` +
        `${colors.cyan}${formatDID(event.did)}${colors.reset} reposted ` +
        `${colors.gray}${truncateText(repostedUri, 60)}${colors.reset}`
      );
      break;

    case 'app.bsky.graph.block':
      console.log(
        `${formatTimestamp()} ${colors.red}[BLOCK]${colors.reset} ` +
        `${colors.cyan}${formatDID(event.did)}${colors.reset}`
      );
      break;

    default:
      if (!hasFilter) {
        console.log(
          `${formatTimestamp()} ${colors.gray}[${operation.toUpperCase()}]${colors.reset} ` +
          `${colors.gray}${collection}${colors.reset} ` +
          `by ${colors.cyan}${formatDID(event.did)}${colors.reset}`
        );
      }
  }
}

function handleIdentityEvent(event: JetstreamEvent) {
  if (hasFilter) return; // Don't show identity events when filtering

  const identity = event.identity!;
  const handle = identity.handle || '[no handle]';
  console.log(
    `${formatTimestamp()} ${colors.cyan}${colors.bright}[IDENTITY]${colors.reset} ` +
    `${colors.cyan}${formatDID(event.did)}${colors.reset} → ` +
    `${colors.white}${handle}${colors.reset}`
  );
}

function handleAccountEvent(event: JetstreamEvent) {
  if (hasFilter) return; // Don't show account events when filtering

  const account = event.account!;
  const status = account.active ? 'active' : 'inactive';
  const statusColor = account.active ? colors.green : colors.red;
  console.log(
    `${formatTimestamp()} ${colors.yellow}${colors.bright}[ACCOUNT]${colors.reset} ` +
    `${colors.cyan}${formatDID(event.did)}${colors.reset} ` +
    `${statusColor}[${status}]${colors.reset}`
  );
}

function connectToFirehose() {
  console.log(`${colors.bright}${colors.blue}Connecting to Bluesky Jetstream...${colors.reset}`);
  console.log(`${colors.gray}Endpoint: ${JETSTREAM_URL}${colors.reset}`);

  if (hasFilter) {
    console.log(`${colors.yellow}Active filters:${colors.reset}`);
    if (filters.postsOnly) console.log(`  - Posts only`);
    if (filters.likesOnly) console.log(`  - Likes only`);
    if (filters.followsOnly) console.log(`  - Follows only`);
    if (filters.repostsOnly) console.log(`  - Reposts only`);
    if (filters.deletesOnly) console.log(`  - Deletes only`);
  }

  console.log(`${colors.gray}${'='.repeat(80)}${colors.reset}\n`);

  const ws = new WebSocket(JETSTREAM_URL);

  ws.on('open', () => {
    console.log(`${colors.green}${colors.bright}✓ Connected to Bluesky firehose!${colors.reset}\n`);
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const event: JetstreamEvent = JSON.parse(data.toString());

      switch (event.kind) {
        case 'commit':
          handleCommitEvent(event);
          break;
        case 'identity':
          handleIdentityEvent(event);
          break;
        case 'account':
          handleAccountEvent(event);
          break;
        default:
          if (!hasFilter) {
            console.log(
              `${formatTimestamp()} ${colors.gray}[UNKNOWN]${colors.reset} ` +
              `${colors.gray}${JSON.stringify(event)}${colors.reset}`
            );
          }
      }
    } catch (error) {
      console.error(`${colors.red}Error parsing event:${colors.reset}`, error);
    }
  });

  ws.on('error', (error) => {
    console.error(`${colors.red}${colors.bright}WebSocket error:${colors.reset}`, error.message);
  });

  ws.on('close', () => {
    console.log(`\n${colors.yellow}Connection closed. Reconnecting in ${RECONNECT_DELAY / 1000} seconds...${colors.reset}`);
    setTimeout(connectToFirehose, RECONNECT_DELAY);
  });
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n\n${colors.yellow}Shutting down...${colors.reset}`);
  process.exit(0);
});

// Print help if requested
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
${colors.bright}Bluesky Firehose Event Viewer${colors.reset}

Connects to the Bluesky Jetstream and displays real-time events.

${colors.bright}Usage:${colors.reset}
  npm start [options]

${colors.bright}Options:${colors.reset}
  --posts-only     Show only posts
  --likes-only     Show only likes
  --follows-only   Show only follows
  --reposts-only   Show only reposts
  --deletes-only   Show only deletes
  --help, -h       Show this help message

${colors.bright}Examples:${colors.reset}
  npm start                 # Show all events
  npm start -- --posts-only # Show only posts
  npm start -- --likes-only # Show only likes

${colors.gray}Press Ctrl+C to stop${colors.reset}
`);
  process.exit(0);
}

// Start the application
console.log(`${colors.bright}${colors.blue}Bluesky Firehose Event Viewer${colors.reset}\n`);
connectToFirehose();
