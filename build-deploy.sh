#!/bin/bash
set -e

echo "=== Cleaning ==="
rm -rf compiled/ n8n-compiled.tar.gz

echo "=== Building ==="
COPYFILE_DISABLE=1 CI=true pnpm build

echo "=== Deploying ==="
NODE_ENV=production pnpm --filter=n8n --prod --legacy deploy compiled/

echo "=== Fixing semver/lru-cache ==="
mkdir -p compiled/node_modules/semver/node_modules
cp -r compiled/node_modules/.pnpm/lru-cache@6.0.0/node_modules/lru-cache compiled/node_modules/semver/node_modules/

echo "=== Cleaning junk ==="
find compiled/node_modules -name "*.map" -delete 2>/dev/null || true
find compiled/node_modules -name "*.md" -delete 2>/dev/null || true

echo "=== Creating tarball ==="
TOTAL_KB=$(du -sk compiled/ | awk '{print $1}')
TOTAL_BYTES=$((TOTAL_KB * 1024))
tar -cf - compiled/ | pv -s $TOTAL_BYTES | gzip > n8n-compiled.tar.gz

echo "=== Uploading ==="
aws s3 cp n8n-compiled.tar.gz s3://udemy-dev-di-jars/n8n/

echo "=== Done ==="
ls -lh n8n-compiled.tar.gz
