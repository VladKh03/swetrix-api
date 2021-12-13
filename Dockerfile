#Stage 1
FROM node:lts-alpine as build
WORKDIR /build
COPY . .
RUN npm i -g pnpm && pnpm i && npm run deploy

#Stage 2
FROM node:lts-alpine as run
ENV TZ=UTC \
    JWT_SECRET=SOME_SECRET_TOKEN \
    MYSQL_HOST=localhost \
    MYSQL_USER=root \
    MYSQL_ROOT_PASSWORD=password \
    MYSQL_DATABASE=analytics \
    REDIS_HOST=localhost \
    REDIS_PORT=6379 \
    CLICKHOUSE_HOST=http://localhost \
    CLICKHOUSE_USER=default \
    CLICKHOUSE_PORT=8123 \
    CLICKHOUSE_PASSWORD=password \
    CLICKHOUSE_DATABASE=analytics \
    EMAIL=test@test.com \
    PASSWORD=12345678 \
    SMTP_MOCK=true \ 
    SELFHOSTED=true
RUN apk add --no-cache tzdata && cp /usr/share/zoneinfo/$TZ /etc/localtime
WORKDIR /app
COPY --from=build /build/package*.json ./
COPY --from=build /build/dist/ ./dist/
COPY --from=build /build/node_modules/ ./node_modules/
CMD [ "npm", "run", "start:prod" ]
EXPOSE 80
HEALTHCHECK CMD wget -nv -t1 --spider 'http://localhost/ping' || exit 1