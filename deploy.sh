#!/usr/bin/env bash
# assist.drev.space deploy + cache purge
set -e
[ -f ~/.drev-secrets ] && source ~/.drev-secrets
CF_TOKEN="${CF_TOKEN:?CF_TOKEN not set}"
CF_ACCOUNT="${CF_ACCOUNT:?CF_ACCOUNT not set}"
CF_ZONE="${CF_ZONE:-c00f30a095dbd588b3d1ffc83087b84a}"

CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT" CLOUDFLARE_API_TOKEN="$CF_TOKEN" \
  wrangler pages deploy . \
  --project-name drev-assist --commit-dirty true --branch master

curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/purge_cache" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"purge_everything":true}'
echo "assist.drev.space deployed + cache purged"
