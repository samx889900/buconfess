#!/bin/sh
set -e
echo "DATABASE_URL starts with: ${DATABASE_URL:0:20}"
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL is not set!"
  exit 1
fi
echo "Running prisma migrate deploy..."
node /app/node_modules/.bin/prisma migrate deploy
echo "Running seed..."
node /app/seed.js
echo "Starting server..."
exec node /app/server.js
