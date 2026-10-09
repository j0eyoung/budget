# Debian rather than Alpine: the Claude Code CLI needs glibc.
FROM node:24-bookworm-slim
WORKDIR /app
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV PORT=8099
CMD ["node", "server/index.ts"]
