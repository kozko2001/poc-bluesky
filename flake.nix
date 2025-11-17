{
  description = "Bluesky Monorepo - Screenshot CLI and Firehose Viewer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs_20
            nodePackages.npm
            nodePackages.typescript
            chromium  # Required for screenshot package
          ];

          shellHook = ''
            echo "=========================================="
            echo "Bluesky Monorepo - Development Environment"
            echo "=========================================="
            echo ""
            echo "Node.js version: $(node --version)"
            echo "npm version: $(npm --version)"
            echo "Chromium: ${pkgs.chromium}/bin/chromium"
            echo ""
            echo "Packages:"
            echo "  - screenshot: Bluesky post screenshot CLI"
            echo "  - firehose: Real-time Jetstream event viewer"
            echo ""
            echo "Commands:"
            echo "  npm run install:all     - Install dependencies for all packages"
            echo "  npm run build           - Build all packages"
            echo "  npm run build:screenshot - Build screenshot package"
            echo "  npm run build:firehose  - Build firehose package"
            echo "  npm run test:screenshot - Run screenshot tests"
            echo ""
            echo "Package-specific commands:"
            echo "  cd packages/screenshot && npm run dev -- <url>"
            echo "  cd packages/firehose && npm start"
            echo "=========================================="
            echo ""

            # Point Playwright to use Nix-provided Chromium
            export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
            export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${pkgs.chromium}/bin/chromium"
          '';
        };
      }
    );
}
