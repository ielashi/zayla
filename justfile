start:
  bun run src/cli.ts serve

# Run Biome lint and TypeScript typecheck
lint:
  bun run lint
  bun run typecheck

# Build the image on the homelab from the committed files and restart the container.
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    host=homelab@homelab
    ssh "$host" "rm -rf ~/build/zayla && mkdir -p ~/build/zayla"
    git ls-files -z | rsync -az --from0 --files-from=- ./ "$host:build/zayla/"
    ssh "$host" 'set -e
      docker build -t zayla:latest ~/build/zayla
      cd ~/services && docker compose up -d zayla'
