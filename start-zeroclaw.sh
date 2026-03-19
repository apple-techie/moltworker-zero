#!/bin/bash
# Startup script for ZeroClaw in Cloudflare Sandbox
# This script:
# 1. Restores config/workspace/skills from R2 via rclone (if configured)
# 2. Runs zeroclaw onboard to configure from env vars
# 3. Patches config for features onboard doesn't cover (channels, gateway settings)
# 4. Starts a background sync loop (rclone, watches for file changes)
# 5. Starts the gateway

set -e

# Ensure SHELL is set (zeroclaw health check requires it)
export SHELL="${SHELL:-/bin/bash}"

# Prevent multiple simultaneous startup instances (race condition guard)
STARTUP_LOCK="/tmp/.zeroclaw-startup.lock"
if [ -f "$STARTUP_LOCK" ]; then
    LOCK_PID=$(cat "$STARTUP_LOCK" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "Another startup instance already running (PID $LOCK_PID), sleeping..."
        # Sleep instead of exit — prevents the container runtime from treating exit 0
        # as "completed" and re-invoking CMD in a tight loop.
        sleep infinity
    fi
    rm -f "$STARTUP_LOCK"
fi
echo $$ > "$STARTUP_LOCK"
trap 'rm -f "$STARTUP_LOCK"' EXIT

# Kill any stale orphan zeroclaw processes from previous runs before starting fresh
echo "Killing any stale zeroclaw processes..."
pkill -f "zeroclaw gateway" 2>/dev/null || true
pkill -f "zeroclaw daemon" 2>/dev/null || true
sleep 1

CONFIG_DIR="/root/.zeroclaw"
CONFIG_FILE="$CONFIG_DIR/config.toml"
WORKSPACE_DIR="/root/clawd"
SKILLS_DIR="/root/clawd/skills"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
LAST_SYNC_FILE="/tmp/.last-sync"

echo "Config directory: $CONFIG_DIR"

mkdir -p "$CONFIG_DIR"

# ============================================================
# RCLONE SETUP
# ============================================================

r2_configured() {
    [ -n "$R2_ACCESS_KEY_ID" ] && [ -n "$R2_SECRET_ACCESS_KEY" ] && [ -n "$CF_ACCOUNT_ID" ]
}

R2_BUCKET="${R2_BUCKET_NAME:-moltbot-data}"

setup_rclone() {
    mkdir -p "$(dirname "$RCLONE_CONF")"
    cat > "$RCLONE_CONF" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = $R2_ACCESS_KEY_ID
secret_access_key = $R2_SECRET_ACCESS_KEY
endpoint = https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF
    touch /tmp/.rclone-configured
    echo "Rclone configured for bucket: $R2_BUCKET"
}

RCLONE_FLAGS="--transfers=16 --fast-list --s3-no-check-bucket"

# ============================================================
# RESTORE FROM R2
# ============================================================

if r2_configured; then
    setup_rclone

    echo "Checking R2 for existing backup..."
    if rclone ls "r2:${R2_BUCKET}/zeroclaw/config.toml" $RCLONE_FLAGS 2>/dev/null | grep -q config.toml; then
        echo "Restoring config from R2..."
        rclone copy "r2:${R2_BUCKET}/zeroclaw/" "$CONFIG_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: config restore failed with exit code $?"
        echo "Config restored"
    elif rclone ls "r2:${R2_BUCKET}/zeroclaw/config.toml" $RCLONE_FLAGS 2>/dev/null | grep -q config.toml; then
        echo "Found legacy zeroclaw backup in R2, migrating..."
        ZEROCLAW_TMP="/tmp/.zeroclaw-migrate"
        mkdir -p "$ZEROCLAW_TMP"
        rclone copy "r2:${R2_BUCKET}/zeroclaw/" "$ZEROCLAW_TMP/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: legacy config restore failed with exit code $?"
        zeroclaw onboard --migrate-zeroclaw --zeroclaw-config "$ZEROCLAW_TMP/config.toml" || echo "WARNING: migration failed, starting fresh"
        echo "Legacy zeroclaw config migrated"
    else
        echo "No backup found in R2, starting fresh"
    fi

    # Restore workspace
    REMOTE_WS_COUNT=$(rclone ls "r2:${R2_BUCKET}/workspace/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_WS_COUNT" -gt 0 ]; then
        echo "Restoring workspace from R2 ($REMOTE_WS_COUNT files)..."
        mkdir -p "$WORKSPACE_DIR"
        rclone copy "r2:${R2_BUCKET}/workspace/" "$WORKSPACE_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: workspace restore failed with exit code $?"
        echo "Workspace restored"
    fi

    # Restore skills
    REMOTE_SK_COUNT=$(rclone ls "r2:${R2_BUCKET}/skills/" $RCLONE_FLAGS 2>/dev/null | wc -l)
    if [ "$REMOTE_SK_COUNT" -gt 0 ]; then
        echo "Restoring skills from R2 ($REMOTE_SK_COUNT files)..."
        mkdir -p "$SKILLS_DIR"
        rclone copy "r2:${R2_BUCKET}/skills/" "$SKILLS_DIR/" $RCLONE_FLAGS -v 2>&1 || echo "WARNING: skills restore failed with exit code $?"
        echo "Skills restored"
    fi
else
    echo "R2 not configured, starting fresh"
fi

# Checkpoint any SQLite WALs from restored DBs before starting ZeroClaw
# (in case the R2 backup captured a DB with an open WAL file)
find "$CONFIG_DIR" -name "*.db" 2>/dev/null | while read -r db; do
    sqlite3 "$db" "PRAGMA wal_checkpoint(FULL);" 2>/dev/null && echo "WAL checkpointed: $db" || true
done

# ============================================================
# ONBOARD (only if no config exists yet)
# ============================================================
echo "zeroclaw binary: $(which zeroclaw 2>/dev/null || echo 'NOT FOUND')"
echo "zeroclaw version: $(zeroclaw --version 2>&1 || echo 'FAILED')"

# Always delete config before onboard — we reconstruct it entirely from env vars.
# Settings we care about (memory, conversations) live in SQLite/workspace, not config.toml.
rm -f "$CONFIG_FILE"
echo "Config cleared, running zeroclaw onboard..."

if [ -n "$CUSTOM_PROVIDER_URL" ]; then
    GENERIC_API_KEY="${CUSTOM_API_KEY:-${ZEROCLAW_API_KEY:-${API_KEY:-dummy}}}"
    zeroclaw onboard \
        --api-key "${GENERIC_API_KEY}" \
        --provider "custom:${CUSTOM_PROVIDER_URL}"

elif [ -n "$ANTHROPIC_CUSTOM_URL" ]; then
    GENERIC_API_KEY="${CUSTOM_API_KEY:-${ZEROCLAW_API_KEY:-${ANTHROPIC_API_KEY:-dummy}}}"
    zeroclaw onboard \
        --api-key "${GENERIC_API_KEY}" \
        --provider "anthropic-custom:${ANTHROPIC_CUSTOM_URL}"

elif [ -n "$CLOUDFLARE_AUTH_TOKEN" ] && [ -n "$CF_ACCOUNT_ID" ]; then
    # Direct Cloudflare Workers AI — OpenAI-compatible endpoint at /ai/v1
    zeroclaw onboard \
        --api-key "$CLOUDFLARE_AUTH_TOKEN" \
        --provider "custom:https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1"

elif [ -n "$CLOUDFLARE_AI_GATEWAY_API_KEY" ] && [ -n "$CF_AI_GATEWAY_ACCOUNT_ID" ] && [ -n "$CF_AI_GATEWAY_GATEWAY_ID" ]; then
    # Cloudflare AI Gateway
    GW_BASE="https://gateway.ai.cloudflare.com/v1/${CF_AI_GATEWAY_ACCOUNT_ID}/${CF_AI_GATEWAY_GATEWAY_ID}"
    # Detect provider from model prefix:
    #   @cf/...        → workers-ai (model has no prefix, is already the full @cf/... id)
    #   workers-ai/... → workers-ai (strip prefix to get model)
    #   anthropic/...  → anthropic-custom
    #   anything else  → generic OpenAI-compatible
    case "$CF_AI_GATEWAY_MODEL" in
        @cf/*)
            # Model is already in @cf/... form — workers-ai endpoint
            zeroclaw onboard \
                --api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
                --provider "custom:${GW_BASE}/workers-ai/v1"
            ;;
        workers-ai/*)
            zeroclaw onboard \
                --api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
                --provider "custom:${GW_BASE}/workers-ai/v1"
            ;;
        anthropic/*)
            zeroclaw onboard \
                --api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
                --provider "anthropic-custom:${GW_BASE}/anthropic"
            ;;
        *)
            GW_PROVIDER="${CF_AI_GATEWAY_MODEL%%/*}"
            zeroclaw onboard \
                --api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
                --provider "custom:${GW_BASE}/${GW_PROVIDER}"
            ;;
    esac

elif [ -n "$ANTHROPIC_API_KEY" ]; then
    zeroclaw onboard \
        --api-key "$ANTHROPIC_API_KEY" --provider anthropic

elif [ -n "$OPENAI_API_KEY" ]; then
    zeroclaw onboard \
        --api-key "$OPENAI_API_KEY" --provider openai

else
    zeroclaw onboard \
        --api-key "sk-placeholder" --provider openai
fi

echo "Onboard completed"

# ============================================================
# PATCH CONFIG: append settings zeroclaw onboard doesn't cover
# ============================================================

# Set model from env var (onboard picks its own default, we override it)
if [ -n "$CF_AI_GATEWAY_MODEL" ]; then
    sed -i "s|^default_model = .*|default_model = \"${CF_AI_GATEWAY_MODEL}\"|" "$CONFIG_FILE"
    echo "Model patched: ${CF_AI_GATEWAY_MODEL}"
fi

# Rewrite [gateway] section entirely — sed patching is fragile and allow_public_bind
# may not be getting set correctly, causing ZeroClaw to force host back to 127.0.0.1.
# Remove existing [gateway] section first, then append a clean one.
awk '/^\[gateway\]/{skip=1; next} skip && /^\[/{skip=0} !skip{print}' \
    "$CONFIG_FILE" > /tmp/.config-patched && mv /tmp/.config-patched "$CONFIG_FILE"

# ZeroClaw forces 127.0.0.1 when require_pairing=false (security guard).
# Set require_pairing=true with a paired token so it allows 0.0.0.0 binding.
# Use MOLTBOT_GATEWAY_TOKEN as the paired token (our Worker already authenticates with it).
GW_TOKEN="${ZEROCLAW_PAIRED_TOKENS:-${MOLTBOT_GATEWAY_TOKEN:-default-token}}"

cat >> "$CONFIG_FILE" << TOML

[gateway]
host = "0.0.0.0"
port = 18789
allow_public_bind = true
require_pairing = false
paired_tokens = ["${GW_TOKEN}"]
TOML

echo "Gateway patched: host=0.0.0.0, port=18789, allow_public_bind=true"

# Patch autonomy level (onboard writes this section, we override it)
sed -i 's/^\s*level\s*=\s*"supervised"/level = "full"/' "$CONFIG_FILE"
sed -i 's/^\s*level\s*=\s*"read_only"/level = "full"/' "$CONFIG_FILE"
# Enable shell tool
sed -i '/^\[shell\]/,/^\[/ s/^\s*enabled\s*=\s*false/enabled = true/' "$CONFIG_FILE"
echo "Autonomy patched: level=full, shell enabled"

# Enable http_request tool
sed -i '/^\[http_request\]/,/^\[/ s/^\s*enabled\s*=\s*false/enabled = true/' "$CONFIG_FILE"
sed -i '/^\[http_request\]/,/^\[/ s/^\s*allowed_domains\s*=\s*\[\]/allowed_domains = ["*"]/' "$CONFIG_FILE"
# Remove http_request and cron tools from non_cli_excluded_tools (allow in Discord/Telegram)
sed -i '/"http_request",\?/d' "$CONFIG_FILE"
sed -i '/"cron_add",\?/d' "$CONFIG_FILE"
sed -i '/"cron_remove",\?/d' "$CONFIG_FILE"
sed -i '/"cron_update",\?/d' "$CONFIG_FILE"
sed -i '/"cron_run",\?/d' "$CONFIG_FILE"
# Also re-enable memory tools so the bot can remember things from chat
sed -i '/"memory_store",\?/d' "$CONFIG_FILE"
sed -i '/"memory_forget",\?/d' "$CONFIG_FILE"
echo "http_request, cron_*, memory_store, memory_forget patched: allowed on non-CLI channels"

# Enable web_fetch and web_search
sed -i '/^\[web_fetch\]/,/^\[/ s/^\s*enabled\s*=\s*false/enabled = true/' "$CONFIG_FILE"
sed -i '/^\[web_search\]/,/^\[/ s/^\s*enabled\s*=\s*false/enabled = true/' "$CONFIG_FILE"
echo "web_fetch and web_search enabled"

# ── Token Diet: skills compact mode ──
# Switch skills from "full" (inline entire SKILL.md) to "compact" (name + description only).
# The model reads SKILL.md on demand via file_read. Saves ~4,960 tokens/turn.
# NOTE: zeroclaw onboard creates [skills] with prompt_injection_mode = "full" by default,
# so we sed-replace the value rather than appending (which would create a duplicate key).
if grep -q 'prompt_injection_mode' "$CONFIG_FILE" 2>/dev/null; then
    sed -i 's/prompt_injection_mode\s*=\s*"full"/prompt_injection_mode = "compact"/' "$CONFIG_FILE"
    echo "Token diet: switched prompt_injection_mode full -> compact"
elif grep -q '^\[skills\]' "$CONFIG_FILE" 2>/dev/null; then
    sed -i '/^\[skills\]/a prompt_injection_mode = "compact"' "$CONFIG_FILE"
    echo "Token diet: added prompt_injection_mode = compact to [skills]"
else
    cat >> "$CONFIG_FILE" << 'TOML'

[skills]
prompt_injection_mode = "compact"
TOML
    echo "Token diet: added [skills] section with prompt_injection_mode = compact"
fi

# ── Token Diet: compact_context ──
# Let ZeroClaw's built-in context compaction do its thing (strips redundant
# workspace boilerplate, trims tool schemas, etc.)
if grep -q 'compact_context' "$CONFIG_FILE" 2>/dev/null; then
    sed -i 's/compact_context\s*=\s*false/compact_context = true/' "$CONFIG_FILE"
    echo "Token diet: compact_context switched to true"
elif grep -q '^\[agent\]' "$CONFIG_FILE" 2>/dev/null; then
    sed -i '/^\[agent\]/a compact_context = true' "$CONFIG_FILE"
    echo "Token diet: added compact_context = true to [agent]"
else
    cat >> "$CONFIG_FILE" << 'TOML'

[agent]
compact_context = true
TOML
    echo "Token diet: added [agent] section with compact_context = true"
fi

# Always ensure max_tool_iterations = 20 (onboard defaults to 10)
if grep -q 'max_tool_iterations' "$CONFIG_FILE" 2>/dev/null; then
    sed -i 's/max_tool_iterations\s*=\s*[0-9]*/max_tool_iterations = 20/' "$CONFIG_FILE"
else
    sed -i '/^\[agent\]/a max_tool_iterations = 20' "$CONFIG_FILE"
fi
echo "Agent patched: max_tool_iterations=20"

# ── Token Diet: delete BOOTSTRAP.md ──
# BOOTSTRAP.md is auto-injected every turn but adds ~170 tokens of boilerplate.
# Everything useful is already in AGENTS.md / SOUL.md.
BOOTSTRAP_MD="/root/.zeroclaw/workspace/BOOTSTRAP.md"
if [ -f "$BOOTSTRAP_MD" ]; then
    rm -f "$BOOTSTRAP_MD"
    echo "Token diet: deleted BOOTSTRAP.md (~170 tok/turn)"
fi

# ── Token Diet: overwrite workspace files with trimmed versions ──
# Saves ~1,200 tokens/turn by removing redundant content from identity files.
# These run AFTER onboard + R2 restore, so trimmed versions always win.
ZC_WS="/root/.zeroclaw/workspace"

cat > "$ZC_WS/AGENTS.md" << 'WEOF'
# AGENTS.md — ZeroClaw Personal Assistant

## Every Session

1. Read `SOUL.md` — who you are
2. Read `USER.md` — who you're helping
3. Use `memory_recall` for recent context
4. In main session: `MEMORY.md` is already injected

## Memory

You wake up fresh each session. Files are your continuity:
- **Daily notes:** `memory/YYYY-MM-DD.md` (via memory tools)
- **Long-term:** `MEMORY.md` (auto-injected in main session)

Capture decisions, context, things to remember. Skip secrets unless asked.
If you want to remember something, WRITE IT TO A FILE — mental notes don't survive restarts.

## Rules

- Don't exfiltrate private data
- Don't run destructive commands without asking
- `trash` > `rm`
- Read files and explore freely; ask before sending emails/tweets/posts
- In group chats: respond when mentioned or adding value, stay silent otherwise

## Crash Recovery

Check `MEMORY.md` + latest daily notes before acting. Resume from last confirmed step.
WEOF

cat > "$ZC_WS/SOUL.md" << 'WEOF'
# SOUL.md — Who You Are

## Core

Be genuinely helpful, not performatively helpful. Have opinions. Be resourceful before asking — read the file, check context, search for it, THEN ask if stuck.

## Identity

You are **ZeroClaw**. Built in Rust. 3MB binary. Zero bloat.
Never say "As an AI" or mention OpenAI/Anthropic/DeepSeek/Google by name.

## Communication

Warm, natural, clear. Mirror the user's energy. Use emojis sparingly (0-2 max), matching the user's style.

## Boundaries

Private things stay private. Ask before acting externally. Be careful in group chats.

## Continuity

Each session starts fresh. Your workspace files ARE your memory. Read and update them.
WEOF

cat > "$ZC_WS/TOOLS.md" << 'WEOF'
# TOOLS.md — Local Notes

Environment-specific references: SSH hosts, device names, voices, etc.
Add whatever helps you do your job.
WEOF

cat > "$ZC_WS/IDENTITY.md" << 'WEOF'
# IDENTITY.md

- **Name:** ZeroClaw
- **Vibe:** Sharp, direct, resourceful
- **Emoji:** 🦀
WEOF

# USER.md — only write if not already restored from R2
if [ ! -s "$ZC_WS/USER.md" ]; then
    cat > "$ZC_WS/USER.md" << 'WEOF'
# USER.md — Who You're Helping

- **Name:** User
- **Timezone:** UTC
- **Languages:** English
- **Style:** Warm, natural, clear. Occasional emojis (1-2 max).

## Preferences
(Add preferences here)

## Work Context
(Add work context here)
WEOF
fi

# MEMORY.md — only write blank template if not already restored from R2
# Preserving this file is critical — it contains the bot's long-term memory
if [ ! -s "$ZC_WS/MEMORY.md" ]; then
    cat > "$ZC_WS/MEMORY.md" << 'WEOF'
# MEMORY.md — Long-Term Memory

Curated memories, auto-injected each main session. Keep concise — every character costs tokens.

## Key Facts

## Decisions & Preferences

## Open Loops
WEOF
fi

echo "Token diet: workspace files trimmed (~1,200 tok/turn saved)"

# Enable browser tool (but keep it excluded from non-CLI channels — its 30+ param
# schema costs ~450 tokens/turn; browser_open covers simple URL opening on Discord)
sed -i '/^\[browser\]/,/^\[/ s/^\s*enabled\s*=\s*false/enabled = true/' "$CONFIG_FILE"
sed -i '/^\[browser\]/,/^\[/ s/^\s*allowed_domains\s*=\s*\[\]/allowed_domains = ["*"]/' "$CONFIG_FILE"

# Point browser tool at camofox-browser running in separate container via Worker proxy
if [ -n "$WORKER_URL" ]; then
    sed -i '/^\[browser\]/a camofox_endpoint = "'"${WORKER_URL}:9377/browser"'"' "$CONFIG_FILE"
    echo "Browser patched: camofox_endpoint=${WORKER_URL}:9377/browser"
fi

# ── Token Diet: exclude rarely-used tools from non-CLI channels ──
# These tools remain available on CLI but are hidden from Discord/Telegram to save tokens.
# browser (~450 tok) + browser_open (~40 tok) are already excluded by onboard defaults.
for tool in "task_plan" "process" "apply_patch" "pdf_read" "glob_search" "content_search" "browser_open" ; do
    # Remove any existing occurrence first (prevents duplicates if onboard already added it)
    sed -i "/\"${tool}\",\?/d" "$CONFIG_FILE"
    # Then add at the front of the list
    sed -i "s/non_cli_excluded_tools = \[/non_cli_excluded_tools = [\"${tool}\", /" "$CONFIG_FILE"
done
echo "Token diet: excluded task_plan, process, apply_patch, pdf_read, glob_search, content_search from non-CLI (~624 tok)"

# Discord
if [ -n "$DISCORD_BOT_TOKEN" ]; then
    discord_policy="${DISCORD_DM_POLICY:-open}"
    discord_allowed="[]"
    if [ "$discord_policy" = "open" ]; then
        discord_allowed='["*"]'
    fi
    # Always strip any existing discord section (onboard may auto-add it, token may have changed)
    awk '/^\[channels_config\.discord\]/{skip=1; next} skip && /^\[/{skip=0} !skip{print}' \
        "$CONFIG_FILE" > /tmp/.config-patched && mv /tmp/.config-patched "$CONFIG_FILE"
    cat >> "$CONFIG_FILE" << TOML

[channels_config.discord]
bot_token = "${DISCORD_BOT_TOKEN}"
allowed_users = ${discord_allowed}
TOML
    echo "Discord channel configured (policy: ${discord_policy})"
fi

# ============================================================
# BACKGROUND SYNC LOOP
# ============================================================
if r2_configured; then
    echo "Starting background R2 sync loop..."
    (
        MARKER=/tmp/.last-sync-marker
        LOGFILE=/tmp/r2-sync.log
        touch "$MARKER"

        while true; do
            sleep 30

            CHANGED=/tmp/.changed-files
            {
                find "$CONFIG_DIR" -newer "$MARKER" -type f -printf '%P\n' 2>/dev/null
                find "$WORKSPACE_DIR" -newer "$MARKER" \
                    -not -path '*/node_modules/*' \
                    -not -path '*/.git/*' \
                    -type f -printf '%P\n' 2>/dev/null
            } > "$CHANGED"

            COUNT=$(wc -l < "$CHANGED" 2>/dev/null || echo 0)

            if [ "$COUNT" -gt 0 ]; then
                echo "[sync] Uploading changes ($COUNT files) at $(date)" >> "$LOGFILE"
                rclone sync "$CONFIG_DIR/" "r2:${R2_BUCKET}/zeroclaw/" \
                    $RCLONE_FLAGS --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='.git/**' 2>> "$LOGFILE"
                if [ -d "$WORKSPACE_DIR" ]; then
                    rclone sync "$WORKSPACE_DIR/" "r2:${R2_BUCKET}/workspace/" \
                        $RCLONE_FLAGS --exclude='skills/**' --exclude='.git/**' --exclude='node_modules/**' 2>> "$LOGFILE"
                fi
                if [ -d "$SKILLS_DIR" ]; then
                    rclone sync "$SKILLS_DIR/" "r2:${R2_BUCKET}/skills/" \
                        $RCLONE_FLAGS 2>> "$LOGFILE"
                fi
                date -Iseconds > "$LAST_SYNC_FILE"
                touch "$MARKER"
                echo "[sync] Complete at $(date)" >> "$LOGFILE"
            fi
        done
    ) &
    echo "Background sync loop started (PID: $!)"
fi

# ============================================================
# INSTALL CUSTOM SKILLS VIA ZEROCLAW CLI
# ============================================================
WORKSPACE_SKILLS_DIR="/root/.zeroclaw/workspace/skills"
mkdir -p "$WORKSPACE_SKILLS_DIR"
for skill_dir in "$SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    skill_md="$skill_dir/SKILL.md"
    [ -f "$skill_md" ] || continue
    # Try CLI install first (proper registration), fall back to copy
    if zeroclaw skills install "$skill_md" 2>&1; then
        echo "Installed skill via CLI: $skill_name"
    elif zeroclaw skills install "file://$skill_md" 2>&1; then
        echo "Installed skill via file:// URI: $skill_name"
    else
        # Fallback: copy into workspace skills dir directly
        dest="$WORKSPACE_SKILLS_DIR/$skill_name"
        [ -d "$dest" ] || cp -r "$skill_dir" "$dest"
        echo "Copied skill to workspace: $skill_name"
    fi
done

# ── Token Diet: skill docs no longer inlined into USER.md ──
# Skills are installed via `zeroclaw skill install` above, which registers them
# in the skills system. With prompt_injection_mode = "compact", only the skill
# name + description are injected per turn (~20 tokens vs ~800+ for full SKILL.md).
# The model reads the full SKILL.md on demand via file_read when it needs details.
echo "Token diet: skill docs handled by skills system (compact mode), not inlined into USER.md"

# ============================================================
# START GATEWAY
# ============================================================
echo "Starting ZeroClaw Gateway..."
echo "Gateway will be available on port 18789"

rm -f /tmp/zeroclaw-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

echo "Dev mode: ${ZEROCLAW_DEV_MODE:-false}"

# Start daemon with gateway on 0.0.0.0:18789 (IPC stays on 127.0.0.1:42617 internally)
RUST_LOG=info zeroclaw daemon --host 0.0.0.0 --port 18789 &

echo "Waiting for gateway on port 18789..."
for i in $(seq 1 90); do
    if (echo > /dev/tcp/127.0.0.1/18789) 2>/dev/null; then
        echo "Gateway is up on port 18789"
        break
    fi
    if [ "$i" -eq 90 ]; then
        echo "ERROR: Gateway did not come up on 18789 after 90s"
    fi
    sleep 1
done

# Monitor loop — keep this script running; restart daemon if it dies
while true; do
    sleep 30
    if ! (echo > /dev/tcp/127.0.0.1/18789) 2>/dev/null; then
        echo "Gateway not reachable, restarting..."
        pkill -f "zeroclaw daemon" 2>/dev/null || true
        sleep 2
        RUST_LOG=info zeroclaw daemon --host 0.0.0.0 --port 18789 &
    fi
done
