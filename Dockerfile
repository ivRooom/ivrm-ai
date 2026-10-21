# ivrm-ai (ai.ivrm.jp). Multi-stage build; runs as a non-root user.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3100
WORKDIR /app
RUN groupadd --system --gid 10001 ivrm && useradd --system --uid 10001 --gid ivrm --no-create-home ivrm
COPY --from=prod-deps --chown=ivrm:ivrm /app/node_modules ./node_modules
COPY --from=build --chown=ivrm:ivrm /app/dist ./dist
COPY --chown=ivrm:ivrm migrations ./migrations
COPY --chown=ivrm:ivrm package.json ./
USER ivrm
EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
