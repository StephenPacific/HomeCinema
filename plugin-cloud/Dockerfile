FROM node:22-alpine

WORKDIR /app

COPY package.json ./package.json
COPY plugin-cloud ./plugin-cloud
COPY extension/plugin-room.js ./extension/plugin-room.js

ENV PLUGIN_SIGNAL_HOST=0.0.0.0
ENV PLUGIN_SIGNAL_PORT=4180

EXPOSE 4180

CMD ["node", "plugin-cloud/server.js"]
