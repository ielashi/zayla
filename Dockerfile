# Published to ghcr.io/ielashi/zayla for amd64 and arm64; see
# .github/workflows/image.yml and "Install with Docker" in the README.
FROM oven/bun:1.3.11 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11
LABEL org.opencontainers.image.source=https://github.com/ielashi/zayla \
      org.opencontainers.image.description="A personal archive for your documents" \
      org.opencontainers.image.licenses=AGPL-3.0-only
# pdftoppm / pdftotext, used by src/core/render.ts
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY index.html frontend.ts ./
COPY public ./public
COPY src ./src
ENV LIBRARY_DIR=/data PORT=3000
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD bun -e 'process.exit((await fetch(`http://127.0.0.1:${process.env.PORT}/`)).ok ? 0 : 1)'
CMD ["bun", "src/cli.ts", "serve"]
