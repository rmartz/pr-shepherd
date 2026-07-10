#!/usr/bin/env bash
# Updates a public environment config file.
#
# Usage:
#   scripts/update-config.sh --env=preview KEY=value [KEY=value ...]
#   scripts/update-config.sh --env=production --firebase-config=/path/to/config.json
#   scripts/update-config.sh --env=preview --firebase-config=... --sync
#
# The --firebase-config flag accepts the path to a JSON file containing the
# firebaseConfig object exported from the Firebase console. It extracts and maps
# the relevant NEXT_PUBLIC_FIREBASE_* keys automatically. Both strict JSON and
# the JavaScript object literal format produced by the Firebase console are accepted.
#
# Pass --sync to also push the updated values to Vercel after writing the YAML.
# Without --sync, only the local YAML is updated.
#
# NOTE: pushing config to Vercel (the old `sync-env`) is being consolidated into
# a standalone `envctl` tool (usage TBD). Until envctl ships, --sync cannot push
# and exits non-zero; the local YAML edit still works.
#
# Sensitive values must NEVER be passed as KEY=value arguments — they will appear
# in shell history and ps output. Use `pnpm exec vercel env add` directly for secrets.
#
# Requires: node

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENT_DIR="$PROJECT_ROOT/deployment"

# ── Argument parsing ──────────────────────────────────────────────────────────

ENV_NAME=""
FIREBASE_CONFIG_FILE=""
SYNC=false
declare -a KEY_VALUE_PAIRS=()

for arg in "$@"; do
  case "$arg" in
    --env=*) ENV_NAME="${arg#--env=}" ;;
    --firebase-config=*) FIREBASE_CONFIG_FILE="${arg#--firebase-config=}" ;;
    --sync) SYNC=true ;;
    *=*) KEY_VALUE_PAIRS+=("$arg") ;;
    *) echo "ERROR: Unknown argument: $arg"; exit 1 ;;
  esac
done

if [[ -z "$ENV_NAME" ]]; then
  echo "ERROR: --env=<preview|production> is required."
  exit 1
fi

CONFIG_FILE="$DEPLOYMENT_DIR/$ENV_NAME.yml"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: $CONFIG_FILE not found. Create it first."
  exit 1
fi

# ── Firebase config extraction ────────────────────────────────────────────────

if [[ -n "$FIREBASE_CONFIG_FILE" ]]; then
  if [[ ! -f "$FIREBASE_CONFIG_FILE" ]]; then
    echo "ERROR: Firebase config file not found: $FIREBASE_CONFIG_FILE"
    exit 1
  fi
  echo "Extracting Firebase client config from $FIREBASE_CONFIG_FILE..."
  while IFS="=" read -r key value; do
    KEY_VALUE_PAIRS+=("$key=$value")
  done < <(FIREBASE_CONFIG_PATH="$FIREBASE_CONFIG_FILE" node -e "
    const raw = require('fs').readFileSync(process.env.FIREBASE_CONFIG_PATH, 'utf8').trim();

    // Strip common Firebase console JS prefixes so both strict JSON and the
    // JS object literal snippet format are handled safely without eval/new Function.
    function stripPrefixes(s) {
      return s
        .replace(/;\s*$/, '')
        .replace(/^\s*export\s+default\s+/, '')
        .replace(/^\s*(?:const|let|var)\s+\w+\s*=\s*/, '')
        .trim();
    }

    // Normalise a JS object literal to strict JSON: strip comments, fix trailing
    // commas, and quote bare identifier keys.
    function toJson(s) {
      const start = s.indexOf('{');
      if (start === -1) throw new Error('No object literal found in Firebase config');
      let depth = 0;
      let inStr = false; let strChar = ''; let escaped = false;
      let end = -1;
      for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
          if (escaped) { escaped = false; continue; }
          if (c === '\\\\') { escaped = true; continue; }
          if (c === strChar) inStr = false;
          continue;
        }
        if (c === '\"' || c === \"'\") { inStr = true; strChar = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { if (--depth === 0) { end = i; break; } }
      }
      if (end === -1) throw new Error('Could not find closing brace in Firebase config object');
      let obj = s.slice(start, end + 1);
      obj = obj.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      obj = obj.replace(/,(\s*[}\]])/g, '\$1');
      obj = obj.replace(/([{,]\s*)([A-Za-z_\$][A-Za-z0-9_\$]*)(\s*:)/g, '\$1\"\$2\"\$3');
      return obj;
    }

    let cfg;
    try { cfg = JSON.parse(raw); }
    catch { cfg = JSON.parse(toJson(stripPrefixes(raw))); }

    const map = {
      apiKey: 'NEXT_PUBLIC_FIREBASE_API_KEY',
      authDomain: 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
      projectId: 'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
      storageBucket: 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
      messagingSenderId: 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
      appId: 'NEXT_PUBLIC_FIREBASE_APP_ID',
      databaseURL: 'NEXT_PUBLIC_FIREBASE_DATABASE_URL',
    };
    const src = cfg.firebaseConfig ?? cfg;
    for (const [k, v] of Object.entries(src)) {
      if (map[k]) process.stdout.write(map[k] + '=' + v + '\n');
    }
  ")
fi

if [[ ${#KEY_VALUE_PAIRS[@]} -eq 0 ]]; then
  echo "ERROR: No key=value pairs provided and no --firebase-config specified."
  exit 1
fi

# ── Pre-validate proposed keys against schema ─────────────────────────────────
# Validate before writing anything — prevents a dirty working tree when a
# denied or unknown key is passed.

SCHEMA_FILE="$DEPLOYMENT_DIR/schema.yml"
KEYS_TO_CHECK=()
for pair in "${KEY_VALUE_PAIRS[@]}"; do
  KEYS_TO_CHECK+=("${pair%%=*}")
done

node - "$SCHEMA_FILE" "${KEYS_TO_CHECK[@]}" <<'NODE'
const fs = require('fs');
const [, , schemaFile, ...keys] = process.argv;

function parseYamlList(content, listKey) {
  const lines = content.split('\n');
  const items = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(listKey + ':')) { inList = true; continue; }
    if (inList) {
      if (trimmed.startsWith('- ')) {
        items.push(trimmed.slice(2).replace(/#.*$/, '').replace(/^["']|["']$/g, '').trim());
      } else if (trimmed && !trimmed.startsWith('#')) {
        inList = false;
      }
    }
  }
  return items;
}

function globMatch(pattern, key) {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(key);
}

const content = fs.readFileSync(schemaFile, 'utf8');
const allowedPatterns = parseYamlList(content, 'allowed_patterns');
const allowedKeys = parseYamlList(content, 'allowed_keys');
const deniedPatterns = parseYamlList(content, 'denied_patterns');

let failed = false;
for (const key of keys) {
  if (deniedPatterns.some(p => globMatch(p, key))) {
    process.stderr.write(`ERROR: Key ${key} matches a denied_pattern in schema.yml\n`);
    failed = true;
  } else if (!allowedPatterns.some(p => globMatch(p, key)) && !allowedKeys.includes(key)) {
    process.stderr.write(`ERROR: Key ${key} is not in allowed_patterns or allowed_keys in schema.yml\n`);
    failed = true;
  }
}
if (failed) process.exit(1);
NODE

# ── Update YAML in place ──────────────────────────────────────────────────────

echo "Updating $CONFIG_FILE..."

for pair in "${KEY_VALUE_PAIRS[@]}"; do
  KEY="${pair%%=*}"
  VALUE="${pair#*=}"

  # Update existing key or insert within the variables: block.
  # KEY and VALUE are passed via process.argv to avoid shell injection.
  action=$(node - "$CONFIG_FILE" "$KEY" "$VALUE" <<'NODE'
const fs = require('fs');
const [, , configFile, key, value] = process.argv;
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const content = fs.readFileSync(configFile, 'utf8');
const lines = content.split('\n');

const variablesStart = lines.findIndex(l => /^variables:\s*$/.test(l));
if (variablesStart === -1) {
  process.stderr.write(`ERROR: No variables: block found in ${configFile}\n`);
  process.exit(1);
}

let variablesEnd = lines.length;
for (let i = variablesStart + 1; i < lines.length; i++) {
  if (/^\S/.test(lines[i]) && lines[i].trim() !== '') { variablesEnd = i; break; }
}

const renderedLine = `  ${key}: ${JSON.stringify(value)}`;
const keyPat = new RegExp(`^  ${escapeRegex(key)}:.*$`);
let updated = false;
for (let i = variablesStart + 1; i < variablesEnd; i++) {
  if (keyPat.test(lines[i])) { lines[i] = renderedLine; updated = true; break; }
}
if (!updated) lines.splice(variablesEnd, 0, renderedLine);

let out = lines.join('\n');
if (content.endsWith('\n') && !out.endsWith('\n')) out += '\n';
fs.writeFileSync(configFile, out);
process.stdout.write(updated ? 'Updated' : 'Added');
NODE
  )
  echo "  $action $KEY"
done

# ── Validate ──────────────────────────────────────────────────────────────────

echo ""
echo "Validating against schema..."
node "$SCRIPT_DIR/validate-config.mjs" --env="$ENV_NAME"

# ── Sync to Vercel (optional) ─────────────────────────────────────────────────

if [[ "$SYNC" == "true" ]]; then
  echo ""
  echo "error: --sync is not available. Pushing config to Vercel is being" >&2
  echo "       consolidated into the 'envctl' tool (usage TBD), which is not" >&2
  echo "       yet wired up. The local YAML was updated; sync manually once" >&2
  echo "       envctl ships." >&2
  exit 1
fi

echo ""
echo "YAML updated. Pushing to Vercel will be handled by the 'envctl' tool (usage TBD)."
