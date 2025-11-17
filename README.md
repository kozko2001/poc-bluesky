# Bluesky Monorepo

A monorepo containing Bluesky-related tools and services:

- **screenshot**: CLI tool to capture screenshots of Bluesky posts
- **firehose**: Real-time Jetstream firehose event viewer with aggregation

## Repository Structure

```
bluesky-monorepo/
├── packages/
│   ├── screenshot/        # Bluesky screenshot CLI
│   │   ├── src/
│   │   ├── tests/
│   │   ├── Dockerfile
│   │   └── package.json
│   └── firehose/          # Bluesky firehose viewer
│       ├── src/
│       ├── Dockerfile
│       └── package.json
├── k8s/                   # Kubernetes configurations
│   ├── namespace.yaml     # Unified "bluesky" namespace
│   ├── screenshot/        # Screenshot deployment configs
│   └── firehose/          # Firehose deployment configs (with PVC)
├── .github/
│   └── workflows/         # CI/CD pipelines
│       ├── screenshot-ci.yml
│       └── firehose-ci.yml
├── package.json           # Root package with build scripts
├── tsconfig.base.json     # Shared TypeScript configuration
└── flake.nix              # Unified Nix development environment
```

## Quick Start

### Using Nix (Recommended)

```bash
# Enter development environment
nix develop

# Install dependencies for all packages
npm run install:all

# Build all packages
npm run build
```

### Without Nix

```bash
# Install dependencies for all packages
cd packages/screenshot && npm install
cd ../firehose && npm install

# Or use the convenience script
npm run install:all
```

## Packages

### 📸 Screenshot (`packages/screenshot/`)

A CLI tool to capture screenshots of Bluesky posts using Playwright.

**Features:**
- Single and batch screenshot processing
- Transparent background support
- Docker-ready with multi-stage builds
- Comprehensive test suite

**Quick Usage:**
```bash
cd packages/screenshot
npm run dev -- https://bsky.app/profile/user/post/123
```

**Docker:**
```bash
docker build -f packages/screenshot/Dockerfile -t bsky-screenshot .
docker run -v $(pwd)/screenshots:/app/screenshots bsky-screenshot <url>
```

See [packages/screenshot/README.md](packages/screenshot/README.md) for detailed documentation.

### 🌊 Firehose (`packages/firehose/`)

Real-time event viewer for Bluesky's Jetstream firehose with like/repost aggregation.

**Features:**
- Real-time WebSocket streaming
- Event filtering and color-coded output
- LevelDB-based state persistence
- Periodic leaderboard reporting

**Quick Usage:**
```bash
cd packages/firehose
npm start              # Run the event viewer
npm run aggregate      # Run the aggregator
```

**Docker:**
```bash
docker build -f packages/firehose/Dockerfile -t bluesky-firehose .
docker run -v $(pwd)/data:/data bluesky-firehose
```

## Development

### Available Scripts

From the root directory:

```bash
# Install dependencies for all packages
npm run install:all

# Build all packages
npm run build

# Build individual packages
npm run build:screenshot
npm run build:firehose

# Run screenshot tests
npm run test:screenshot

# Clean build artifacts
npm run clean
```

### Package-specific Commands

Each package has its own scripts. Navigate to the package directory and use:

**Screenshot:**
```bash
cd packages/screenshot
npm run dev -- <url>    # Development mode
npm test                # Run tests
npm run build           # Build TypeScript
```

**Firehose:**
```bash
cd packages/firehose
npm start               # Build and run viewer
npm run aggregate       # Build and run aggregator
npm run dev             # Quick development build
```

## Docker Builds

Each package has its own Dockerfile and builds independently. Build from the repository root:

```bash
# Build screenshot Docker image
docker build -f packages/screenshot/Dockerfile -t bsky-screenshot .

# Build firehose Docker image
docker build -f packages/firehose/Dockerfile -t bluesky-firehose .
```

Both images are multi-stage builds optimized for production deployment.

## Kubernetes Deployment

### Prerequisites

```bash
# Create the unified namespace
kubectl apply -f k8s/namespace.yaml
```

### Deploy Screenshot Service

```bash
kubectl apply -f k8s/screenshot/deployment.yaml
```

### Deploy Firehose Service

```bash
# Create persistent volume claim (for LevelDB storage)
kubectl apply -f k8s/firehose/pvc.yaml

# Deploy the service
kubectl apply -f k8s/firehose/deployment.yaml
```

### Namespace

Both services deploy to the unified `bluesky` namespace:
```bash
kubectl get pods -n bluesky
```

## CI/CD

The monorepo uses GitHub Actions with path-based triggers:

### Screenshot Pipeline (`screenshot-ci.yml`)
**Triggers on:**
- Changes to `packages/screenshot/**`
- Changes to `.github/workflows/screenshot-ci.yml`

**Steps:**
1. Run unit and integration tests
2. Build TypeScript
3. Build and push Docker image to Harbor
4. Update `k8s/screenshot/deployment.yaml` with new SHA

### Firehose Pipeline (`firehose-ci.yml`)
**Triggers on:**
- Changes to `packages/firehose/**`
- Changes to `.github/workflows/firehose-ci.yml`

**Steps:**
1. Build TypeScript
2. Build and push Docker image to Harbor
3. Update `k8s/firehose/deployment.yaml` with new SHA

### Required Secrets

Configure in GitHub repository settings:
- `HARBOR_USERNAME` - Harbor registry username
- `HARBOR_PASSWORD` - Harbor registry password

## Technology Stack

### Common
- **Language**: TypeScript 5.7.2
- **Runtime**: Node.js 20+
- **Module System**: ES Modules (ESM)
- **Container**: Docker multi-stage builds
- **Orchestration**: Kubernetes
- **Registry**: Harbor (harbor.allocsoc.net)

### Screenshot-specific
- **Browser Automation**: Playwright (Chromium)
- **CLI Framework**: Commander
- **Testing**: Vitest

### Firehose-specific
- **WebSocket Client**: ws
- **Database**: LevelDB (via level package)
- **Persistence**: Kubernetes PVC with rook-ceph-block

## Architecture Decisions

### Module System
Both packages use **ES Modules** (ESM) for modern JavaScript standards and better tree-shaking. Import statements require `.js` extensions for local modules.

### Monorepo Structure
- **Simple approach**: No complex workspace tooling (npm workspaces, pnpm, Turborepo)
- **Independent packages**: Each package manages its own dependencies
- **Shared configuration**: Base TypeScript config and unified dev environment

### Kubernetes Namespace
- **Unified namespace**: Both services deploy to `bluesky` namespace
- **Isolation via labels**: Services distinguished by labels and names
- **Separate deployments**: Each service has its own deployment config

### Docker Strategy
- **Per-package Dockerfiles**: Each package maintains its own optimized Dockerfile
- **Independent builds**: CI/CD builds each package separately
- **Context-aware**: Workflows set correct build context (`packages/*/`)

## Contributing

1. Make changes to the relevant package (`packages/screenshot` or `packages/firehose`)
2. Test locally:
   ```bash
   cd packages/<package-name>
   npm test          # (screenshot only)
   npm run build
   ```
3. Submit a pull request
4. CI/CD will automatically test and build affected packages

## License

MIT

## Links

- **Screenshot Package**: [packages/screenshot/README.md](packages/screenshot/README.md)
- **Harbor Registry**: https://harbor.allocsoc.net
- **Bluesky**: https://bsky.app
