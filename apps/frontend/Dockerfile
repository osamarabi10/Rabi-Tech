FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
ARG NEXT_SERVER_API_URL=http://backend:4000
ENV NEXT_SERVER_API_URL=$NEXT_SERVER_API_URL
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
