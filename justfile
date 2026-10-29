start:
  bun run src/cli.ts serve

# Run Biome lint and TypeScript typecheck
lint:
  bun run lint
  bun run typecheck
