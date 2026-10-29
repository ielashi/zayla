# Runs on the homelab (amd64); see `just deploy`.
FROM oven/bun:1.3.11 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.11
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
