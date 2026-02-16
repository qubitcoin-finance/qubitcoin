# Stage 1: Install dependencies
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Stage 2: Runtime
FROM node:22-slim

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src/ ./src/

ENV NODE_OPTIONS="--max-old-space-size=12288"

EXPOSE 3001 6001

VOLUME /data

ENTRYPOINT ["node", "--loader", "ts-node/esm", "src/qbtcd.ts", "--rpc-bind", "0.0.0.0"]
CMD ["--mine", "--full", "--datadir", "/data"]
