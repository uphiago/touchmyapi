FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile \
  && bun build apps/worker-control/src/server.ts --outdir apps/worker-control/dist \
    --target bun --production --external @react-pdf/renderer \
  && bun --cwd apps/worker-control -e "await import('@react-pdf/renderer')"

ENV NODE_ENV=production \
    RUNNER_MODE=isolated \
    WORKER_PORT=3002
USER bun
EXPOSE 3002
CMD ["bun", "apps/worker-control/dist/server.js"]
