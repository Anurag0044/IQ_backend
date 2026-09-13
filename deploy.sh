#!/bin/bash
echo "Building env vars securely..."

ENV_VARS="NODE_ENV=production"

# Read the .env file line by line safely (ignoring comments)
while IFS='=' read -r key value; do
  if [[ -z "$key" ]] || [[ "$key" == \#* ]]; then
    continue
  fi
  
  # Remove surrounding quotes from the value
  value="${value%\"}"
  value="${value#\"}"
  
  # Use a tilde (~) as the separator so it doesn't conflict with email addresses
  ENV_VARS="${ENV_VARS}~${key}=${value}"
done < .env

echo "Deploying to Cloud Run..."
gcloud run deploy cloudiq-backend \
  --source . \
  --region asia-southeast1 \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars "^~^${ENV_VARS}"