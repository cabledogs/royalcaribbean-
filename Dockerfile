FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WWW_DIR=/app/www
WORKDIR /app
COPY server/server.js server/sms.js /app/
COPY app/src/main/assets/www/ /app/www/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "/app/server.js"]
