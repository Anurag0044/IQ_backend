#!/bin/bash
echo "Building env vars securely..."

ENV_VARS="NODE_ENV=production"

while IFS='=' read -r key value; do
  # Skip empty lines, comments, and the reserved PORT variable
  if [[ -z "$key" ]] || [[ "$key" == \#* ]] || [[ "$key" == "PORT" ]]; then
    continue
  fi

  value="${value%\"}"
  value="${value#\"}"

  ENV_VARS="${ENV_VARS}~${key}=${value}"
done < .env

echo "Deploying to Cloud Run..."
gcloud run deploy cloudiq-backend \
  --source . \
  --region asia-southeast1 \
  --port 8080 \
  --allow-unauthenticated \
  --set-env-vars "^~^${ENV_VARS}"