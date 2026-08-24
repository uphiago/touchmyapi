FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6

WORKDIR /app
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile \
  && bun build apps/api/src/server.ts apps/api/src/admin-server.ts \
    --outdir apps/api/dist --target bun --production

ENV NODE_ENV=production \
    LOCAL_MOCKS=0 \
    LOCAL_ADMIN_MOCKS=0
USER bun
EXPOSE 3000 3001
CMD ["bun", "apps/api/dist/server.js"]
