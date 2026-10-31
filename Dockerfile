FROM node:22-alpine
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# ponytail: single stage incl. dev dependencies; split into build/runtime stages when image size matters.
RUN pnpm install --frozen-lockfile && pnpm build && chown -R node:node /app
EXPOSE 3000
ENV HOST=0.0.0.0 PORT=3000
USER node
CMD ["node", "apps/api/dist/main.js"]
