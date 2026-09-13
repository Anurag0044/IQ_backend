ENV_VARS="NODE_ENV=production"
while IFS='=' read -r key value; do
  if [[ -z "$key" ]] || [[ "$key" == \#* ]]; then
    continue
  fi
  value="${value%\"}"
  value="${value#\"}"
  ENV_VARS="${ENV_VARS}@${key}=${value}"
done < .env.test
echo "^@^${ENV_VARS}"
