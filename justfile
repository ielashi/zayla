start:
  bun run src/cli.ts serve

# Run Biome lint and TypeScript typecheck
lint:
  bun run lint
  bun run typecheck

# Pull the latest published image on the homelab and restart the container.
deploy:
    ssh homelab@homelab 'cd ~/services && docker compose pull zayla && docker compose up -d zayla'
