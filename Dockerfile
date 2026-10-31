FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
EXPOSE 3000
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/data/dealforge.sqlite DEMO_MODE=false
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME /app/data
USER node
CMD ["node","src/server.js"]
