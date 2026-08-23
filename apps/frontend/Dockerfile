FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Server-side calls stay on the container network.
ARG NEXT_SERVER_API_URL=http://backend:4000
ENV NEXT_SERVER_API_URL=$NEXT_SERVER_API_URL

# Browser-side calls do not, and these are the ones that break on a domain.
#
# Next.js inlines NEXT_PUBLIC_* into the JavaScript bundle at BUILD time.
# Passing them as runtime environment does nothing — the value baked in is
# whatever was present when `next build` ran. They were absent, so the
# client fell back to http://localhost:4000, which is correct on a laptop
# and is a browser talking to itself on any real domain.
#
# So they are build arguments, and changing the domain means rebuilding
# this image rather than restarting it.
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_SOCKET_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
