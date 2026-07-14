FROM node:22-slim

# The probe drives Maritime's own CLI from inside a Maritime agent.
RUN npm install -g maritime-cli

WORKDIR /app
COPY server.js .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
