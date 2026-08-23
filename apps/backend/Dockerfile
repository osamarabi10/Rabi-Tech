FROM node:20-alpine
WORKDIR /app
# openssl for Prisma; postgresql-client for the backup job.
#
# The client must be the same major version as the server or NEWER. pg_dump
# can dump an older server and refuses a newer one, so 16 against our 15 is
# supported and 15 against a future 16 would not be. Alpine no longer ships a
# 15 client, which is why this is not pinned to the server version.
RUN apk add --no-cache openssl postgresql16-client
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build
EXPOSE 4000
CMD ["npm", "start"]
