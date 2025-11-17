# Bluesky Screenshot

A CLI tool to capture screenshots of Bluesky posts. Built with TypeScript, Playwright, and designed to run seamlessly in Docker.

## Features

- Screenshot single or multiple Bluesky posts
- Support for transparent backgrounds
- Batch processing with URL-to-image manifest
- Docker support for consistent cross-platform execution
- CLI and programmatic API
- Comprehensive test coverage
- CI/CD pipeline with automated Docker builds

## Installation

### Using npm (Local)

```bash
npm install
npm run build
npm link  # Makes bsky-screenshot available globally
```

### Using Docker

```bash
# Pull from Harbor registry
docker pull harbor.allocsoc.net/bluesky/bsky-screenshot:latest

# Or build locally
docker build -t bsky-screenshot .
```

## Usage

### CLI

#### Screenshot a single post

```bash
bsky-screenshot https://bsky.app/profile/did:plc:rrfwruhud4ovela3oe6isre5/post/3m3iwjohoxc2e
```

#### Screenshot with custom output path

```bash
bsky-screenshot https://bsky.app/profile/user/post/123 -o ./my-screenshots/custom.png
```

#### Screenshot multiple posts (command line)

```bash
bsky-screenshot <url1> <url2> <url3> -o ./screenshots
```

#### Screenshot multiple posts (from file)

Create a file `urls.txt`:
```
https://bsky.app/profile/user1/post/123
https://bsky.app/profile/user2/post/456
# Comments are supported
https://bsky.app/profile/user3/post/789
```

Then run:
```bash
bsky-screenshot -f urls.txt -o ./screenshots
```

#### Combine both approaches

```bash
bsky-screenshot <url1> <url2> -f urls.txt -o ./screenshots
```

### Docker Usage

#### Single post

```bash
docker run -v $(pwd)/screenshots:/app/screenshots bsky-screenshot \
  https://bsky.app/profile/user/post/123
```

#### Batch processing with manifest

```bash
# Create urls.txt in current directory
docker run -v $(pwd)/screenshots:/app/screenshots \
  -v $(pwd)/urls.txt:/app/urls.txt \
  bsky-screenshot -f /app/urls.txt -o /app/screenshots
```

### Options

- `-f, --file <path>` - Read URLs from a file (one per line)
- `-o, --output <path>` - Output directory or file path (default: `./screenshots`)
- `--timeout <ms>` - Page load timeout in milliseconds (default: `30000`)
- `--no-transparent` - Disable transparent background

## Output Format

### Single URL
When processing a single URL, the screenshot is saved to the specified output path.

### Multiple URLs (Batch Processing)
When processing multiple URLs, the tool:
1. Creates sequentially named screenshots: `post-001.png`, `post-002.png`, etc.
2. Generates a `manifest.json` file mapping URLs to filenames

Example `manifest.json`:
```json
{
  "generated": "2025-01-15T10:30:00.000Z",
  "total": 3,
  "successful": 3,
  "failed": 0,
  "entries": [
    {
      "url": "https://bsky.app/profile/user1/post/123",
      "filename": "post-001.png",
      "timestamp": "2025-01-15T10:30:05.000Z",
      "success": true
    },
    {
      "url": "https://bsky.app/profile/user2/post/456",
      "filename": "post-002.png",
      "timestamp": "2025-01-15T10:30:08.000Z",
      "success": true
    }
  ]
}
```

## Development

### Prerequisites

- Node.js 20 or higher
- npm

### Setup

```bash
# Install dependencies
npm install

# Install Playwright browsers
npm run postinstall

# Run in development mode
npm run dev -- <url>

# Build
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

### Using Nix

If you're using Nix:

```bash
nix develop
npm install
npm run dev -- <url>
```

## Testing

The project includes both unit and integration tests:

- **Unit tests** (`tests/utils.test.ts`): Test utility functions, URL validation, file operations
- **Integration tests** (`tests/screenshot.test.ts`): Test actual screenshot capture using Playwright

Run tests:
```bash
npm test
```

## CI/CD

The project uses GitHub Actions for continuous integration and deployment:

1. **On Push/PR**: Runs unit tests, integration tests, and builds TypeScript
2. **On Push to Main**:
   - Builds and pushes Docker image to Harbor registry
   - Updates Kubernetes deployment manifest with new image SHA
   - Commits the updated manifest back to the repository

### Required Secrets

Configure these secrets in your GitHub repository:

- `HARBOR_USERNAME` - Your Harbor registry username
- `HARBOR_PASSWORD` - Your Harbor registry password

### Deployment

The Docker image is pushed to: `harbor.allocsoc.net/bluesky/bsky-screenshot:<commit-sha>`

The workflow automatically updates `k8s/deployment.yaml` with the new image tag after a successful build.

## Project Structure

```
.
├── src/
│   ├── cli.ts          # CLI entry point
│   ├── screenshot.ts   # Playwright screenshot logic
│   ├── batch.ts        # Batch processing and manifest generation
│   └── utils.ts        # Utility functions
├── tests/
│   ├── utils.test.ts       # Unit tests
│   └── screenshot.test.ts  # Integration tests
├── k8s/
│   └── deployment.yaml # Kubernetes deployment manifest
├── .github/
│   └── workflows/
│       └── ci.yml      # CI/CD pipeline
├── Dockerfile          # Multi-stage Docker build
├── package.json        # Project metadata and dependencies
├── tsconfig.json       # TypeScript configuration
└── vitest.config.ts    # Test configuration
```

## How It Works

1. **URL Parsing**: Validates Bluesky post URLs
2. **Browser Automation**: Uses Playwright to launch a headless Chromium browser
3. **Screenshot Capture**: Navigates to the post, waits for content to load, and captures the post element
4. **Batch Processing**: Reuses browser instance for efficiency when processing multiple URLs
5. **Manifest Generation**: Creates a JSON manifest to track URL-to-file mappings

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Troubleshooting

### Playwright browser not found

Run:
```bash
npx playwright install chromium
```

### Permission errors in Docker

Make sure the mounted volume has appropriate permissions:
```bash
mkdir -p screenshots
chmod 777 screenshots
```

### Screenshots are blank or incomplete

Try increasing the timeout:
```bash
bsky-screenshot <url> --timeout 60000
```
