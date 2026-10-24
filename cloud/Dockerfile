FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY static ./static
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8787 EUNNEI_DATA_DIR=/data EUNNEI_STATIC_DIR=/app/static
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "src/server.mjs"]
