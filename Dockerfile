# Use ARM64 image to match your M3 Mac
FROM --platform=linux/arm64 node:22

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# See: https://github.com/elizaOS/eliza/issues/1543#issuecomment-2570781857
RUN npm install -g sqlite-vec

# Install system dependencies including SQLite
RUN apt-get update && \
  apt-get install -y python3 make g++ jq sqlite3 libsqlite3-dev

# Copy source code (excluding files in .dockerignore)
COPY . .

# Set environment variables for better-sqlite3
ENV npm_config_better_sqlite3_binary_host_mirror=https://github.com/WiseLibs/better-sqlite3/releases/download
ENV npm_config_better_sqlite3_binary_host_tag=v8.7.0

# Install dependencies with proper native module building
RUN NODE_OPTIONS=--max_old_space_size=4096 \
  npm_config_build_from_source=true \
  pnpm install

# Build the server
RUN cd server && pnpm run build

# Create a proper start script file that ensures unique credentials per container
RUN printf '#!/bin/sh\n\
  # Ensure we have a clean start with no shared credentials\n\
  if [ -f /app/server/data/nevermined-credentials.json ]; then\n\
  echo "Removing existing credentials file to ensure unique DIDs"\n\
  rm -f /app/server/data/nevermined-credentials.json\n\
  fi\n\
  \n\
  # Start the server which will generate new credentials\n\
  cd /app/server && node dist/index.js\n' > /app/start.sh

# Make the script executable
RUN chmod +x /app/start.sh

# Run the server
CMD ["/app/start.sh"] 