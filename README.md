# Bluesky Firehose Event Viewer

A real-time event viewer for the Bluesky social network using the Jetstream firehose API. This utility connects to Bluesky's public WebSocket stream and displays all events happening across the network in real-time.

## Features

- Real-time streaming of Bluesky events
- Color-coded output for different event types
- Support for filtering specific event types
- Optional like/repost aggregation with top-post reporting
- No authentication required (public firehose)
- Auto-reconnection on connection loss
- Graceful error handling

## Event Types

The viewer displays the following event types:

- **Posts**: New posts and replies
- **Likes**: When users like posts
- **Follows**: When users follow each other
- **Reposts**: When users repost content
- **Deletes**: When content is deleted
- **Identity**: Handle and DID updates
- **Account**: Account status changes
- **Blocks**: When users block others

## Prerequisites

This project uses Nix flakes for a reproducible development environment. Make sure you have:

- Nix with flakes enabled
- NixOS or any Linux distribution with Nix installed

## Getting Started

### 1. Enter the Nix development shell

```bash
nix develop
```

This will set up Node.js 20, npm, and TypeScript automatically.

### 2. Install dependencies

```bash
npm install
```

### 3. Run the firehose viewer

```bash
npm start
```

That's it! You should now see real-time events streaming from Bluesky.

## Usage

### View all events (default)

```bash
npm start
```

### Filter specific event types

Show only posts:
```bash
npm start -- --posts-only
```

Show only likes:
```bash
npm start -- --likes-only
```

Show only follows:
```bash
npm start -- --follows-only
```

Show only reposts:
```bash
npm start -- --reposts-only
```

Show only deletes:
```bash
npm start -- --deletes-only
```

### Get help

```bash
npm start -- --help
```

## Like/Repost Aggregator

For an in-memory tally of likes and reposts per post, run the aggregation script:

```bash
npm run aggregate
```

This connects to the same Jetstream firehose, tracks like/repost events, and prints the top posts at a regular interval.

### Aggregator Options

```bash
npm run aggregate -- --interval-ms 60000 --top 20 --max-posts 200000
```

- `--interval-ms <ms>`: How often to print the leaderboard (default 30000).
- `--top <n>`: Number of posts to show per report (default 10).
- `--max-posts <n>`: Maximum posts kept in memory (default 100000).
- `--stale-ms <ms>`: Drop posts that have not been updated in this period (default 6 hours).
- `--state <path>`: LevelDB directory used to persist aggregation state (default `/data/aggregator-db`, overridable via the `STATE_FILE` env var).

Each report includes current process RSS/heap usage and CPU percentage, plus a direct `https://bsky.app/profile/.../post/...` link alongside the source `at://` URI. All counters and active like/repost references are persisted incrementally in a LevelDB database (default `/data/aggregator-db`) so restarts resume immediately without rewriting a monolithic JSON file.

> Running outside Docker? Override the default with `npm run aggregate -- --state ./aggregator-db` (or set `STATE_FILE`) so the tracker stores data in a directory you control.

## Docker

Build the container image (multi-stage build compiles TypeScript ahead of time):

```bash
docker build -t bluesky-firehose .
```

Run the aggregator with a host directory mounted at `/data` so the persistent LevelDB survives restarts:

```bash
docker run --rm -it -v "$(pwd)/data:/data" bluesky-firehose
```

The container entrypoint runs `node dist/aggregator.js --state /data/aggregator-db` by default. To tweak options, append extra flags after the image name, for example:

```bash
docker run --rm -it -v "$(pwd)/data:/data" bluesky-firehose --interval-ms 60000 --top 25
```

Environment variable `STATE_FILE` can override the persisted LevelDB location if needed.

## How It Works

This utility connects to Bluesky's **Jetstream** service, which is a simplified JSON-based firehose API. Unlike the raw AT Protocol firehose (which uses CBOR encoding), Jetstream provides:

- Simple JSON messages over WebSocket
- No authentication required
- Significantly smaller message sizes (>99% reduction)
- Easy-to-parse event structure

The connection is made to: `wss://jetstream2.us-east.bsky.network/subscribe`

### About AT Protocol and Bluesky

The AT Protocol (Authenticated Transfer Protocol) is the underlying protocol powering Bluesky. Key concepts:

- **Firehose**: A real-time stream of all public events across the network
- **DIDs**: Decentralized Identifiers for users (e.g., `did:plc:...`)
- **Collections**: Different types of records (posts, likes, follows, etc.)
- **Jetstream**: A developer-friendly wrapper around the AT Protocol firehose

All data in the firehose is public, which is why no authentication is needed to consume it.

## Understanding the Output

Example output:

```
[2025-10-16T12:34:56.789Z] [POST] did:plc:abc123...: Just tried Claude Code and it's amazing!
[2025-10-16T12:34:57.123Z] [LIKE] did:plc:def456... liked at://did:plc:abc123.../app.bsky.feed.post/...
[2025-10-16T12:34:57.456Z] [FOLLOW] did:plc:ghi789... followed did:plc:jkl012...
[2025-10-16T12:34:58.789Z] [REPOST] did:plc:mno345... reposted at://...
[2025-10-16T12:34:59.012Z] [DELETE] app.bsky.feed.post by did:plc:pqr678...
[2025-10-16T12:34:59.345Z] [IDENTITY] did:plc:stu901... → alice.bsky.social
```

Color coding:
- **Blue**: Posts
- **Magenta**: Likes
- **Green**: Follows
- **Yellow**: Reposts and account events
- **Red**: Deletes and blocks
- **Cyan**: Identity updates
- **Gray**: Timestamps and metadata

## Development

### Build only

```bash
npm run build
```

### Clean build artifacts

```bash
npm run clean
```

### Development mode (rebuild and run)

```bash
npm run dev
```

## Project Structure

```
.
├── flake.nix           # Nix flake configuration for dev environment
├── package.json        # Node.js dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── src/
│   ├── index.ts        # Streaming event viewer
│   └── aggregator.ts   # Like/repost aggregation script
├── dist/               # Compiled JavaScript (generated)
└── README.md           # This file
```

## Technical Details

- **Language**: TypeScript
- **Runtime**: Node.js 20
- **WebSocket Library**: ws
- **Package Manager**: npm
- **Build Tool**: TypeScript Compiler (tsc)
- **Dev Environment**: Nix flakes

## Troubleshooting

### Connection Issues

If you experience connection issues, the viewer will automatically attempt to reconnect after 5 seconds. If problems persist:

1. Check your internet connection
2. Verify that `wss://jetstream2.us-east.bsky.network` is accessible
3. Try one of the other Jetstream endpoints:
   - `wss://jetstream1.us-east.bsky.network/subscribe`
   - `wss://jetstream1.us-west.bsky.network/subscribe`
   - `wss://jetstream2.us-west.bsky.network/subscribe`

### High Event Volume

The Bluesky network processes over 2,000 events per second. If the output is too fast:

1. Use filters to show only specific event types
2. Pipe output to less: `npm start | less`
3. Redirect to a file: `npm start > events.log`

## Resources

- [Bluesky Firehose Documentation](https://docs.bsky.app/docs/advanced-guides/firehose)
- [Jetstream GitHub Repository](https://github.com/bluesky-social/jetstream)
- [AT Protocol Specification](https://atproto.com/)
- [Bluesky Documentation](https://docs.bsky.app/)

## License

MIT

## Contributing

Feel free to open issues or submit pull requests!

## Stopping the Viewer

Press `Ctrl+C` to gracefully shut down the viewer.
