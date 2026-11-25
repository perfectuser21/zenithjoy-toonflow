# syntax=docker/dockerfile:1
FROM oven/bun:1.4.3 AS base

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:server

FROM base
COPY . .
# 插件运行时从工作区解析依赖，保留服务端生产依赖并把构建依赖留在构建阶段。
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --production --filter '@toonflow/server'
COPY --from=build --chown=bun:bun /app/build /app/build
RUN mkdir -p data/workspaces/myProject data/tmp && chown -R bun:bun data

ENV NODE_ENV=production
ENV TOONFLOW_DATA_DIR=/app/data

USER bun
EXPOSE 3000

CMD ["bun", "build/server/index.js"]
