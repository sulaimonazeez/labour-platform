#!/usr/bin/env bash
# Wires the intake files into YOUR existing project without overwriting anything else.
# Run from the project root (the folder with package.json). Safe to run twice.
set -e
[ -f package.json ] && [ -f src/api/app.ts ] || { echo "Run this from the labour-platform folder."; exit 1; }

grep -q './intake"' src/db/schema/index.ts || echo 'export * from "./intake";' >> src/db/schema/index.ts

if ! grep -q 'intakeRoutes' src/api/app.ts; then
  sed -i '0,/^import /s//import { intakeRoutes } from ".\/intake-routes";\nimport /' src/api/app.ts
  sed -i 's|^\(app\.route("/requests", requestRoutes);\)|\1\napp.route("/requests", intakeRoutes);|' src/api/app.ts
fi
if ! grep -q 'route("/requests", intakeRoutes)' src/api/app.ts; then
  echo "Could not find the line app.route(\"/requests\", requestRoutes); in src/api/app.ts."
  echo "Add this line right after it by hand:   app.route(\"/requests\", intakeRoutes);"
  exit 1
fi

node -e '
const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));
p.scripts["test:intake"]="STORAGE_DRIVER=memory INTAKE_MAX_ATTACHMENTS=3 RATE_LIMIT_DISABLED=1 tsx src/api/test-intake.ts";
p.scripts["storage:smoke"]="tsx src/storage-smoke.ts";
fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");'

if [ -f .env.example ] && ! grep -q SUPABASE_SERVICE_ROLE_KEY .env.example; then
cat >> .env.example <<'EOT'

# Request photos/videos (private object storage). SERVER-SIDE SECRETS: never expose the service-role key to the browser.
# Create a PRIVATE bucket named request-media in Supabase Storage (or set STORAGE_BUCKET).
# SUPABASE_URL=https://<ref>.supabase.co
# SUPABASE_SERVICE_ROLE_KEY=
# STORAGE_BUCKET=request-media
EOT
fi
if [ -f README.md ] && ! grep -q 'docs/INTAKE.md' README.md; then
  printf '\n## Request intake (guided questions + photo/video)\nSee `docs/INTAKE.md`: endpoints, decisions, run order, storage setup. Test: `npm run test:intake`.\n' >> README.md
fi
echo "Wired. Next: npm run db:generate && npm run db:migrate && npm run db:lockdown && npm run typecheck && npm run test:intake"
