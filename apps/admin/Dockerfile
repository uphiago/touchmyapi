FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
ARG VITE_ADMIN_API_BASE_URL=https://admin-api.example.invalid
ENV VITE_ADMIN_API_BASE_URL=$VITE_ADMIN_API_BASE_URL
RUN bun run --cwd apps/admin build

FROM oven/bun:1.4.0-slim@sha256:e0ee68d16ccb9927bf02aa7dd8fd4bf3369ee6d46da04faa72b05ce8bfd135f6
WORKDIR /app
COPY --from=build --chown=bun:bun /app/apps/admin/dist /app/public
COPY --from=build --chown=bun:bun /app/infra/docker/static-server.ts /app/static-server.ts
ENV NODE_ENV=production STATIC_ROOT=/app/public PORT=8080
USER bun
EXPOSE 8080
CMD ["bun", "/app/static-server.ts"]
