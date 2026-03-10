# Token Diet — Tier 1

Reduces ZeroClaw's per-turn input token footprint by ~6,200+ tokens
through config-only changes. No Rust code modifications required.

## How it works

The token diet is applied automatically by `start-zeroclaw.sh` on every
container start. No manual deployment needed — just rebuild the container.

### Changes in `start-zeroclaw.sh`

| Change | Tokens saved |
|--------|-------------|
| `skills prompt_injection_mode = "compact"` | ~4,860/turn |
| Delete BOOTSTRAP.md on startup | ~170/turn |
| Stop inlining SKILL.md into USER.md | ~800+/turn |
| Yahoo Finance `interval=1d` guidance | ~10,000/turn (response) |
| **Total** | **~6,000+ system + ~10,000 response** |

### Reference files (contrib/token-diet/)

| File | Purpose |
|------|---------|
| `config-patch.toml` | Reference for `non_cli_excluded_tools` expansion |
| `deploy.sh` | Standalone deploy script (for non-container setups) |
| `workspace/*.md` | Trimmed workspace templates (deploy manually to R2 if desired) |

## Optional: trim workspace files

The `workspace/*.md` files here are trimmed versions of the defaults.
Upload them to R2 to replace the originals for ~1,210 more tokens/turn:

```bash
# Example: upload trimmed workspace files to R2
rclone copy contrib/token-diet/workspace/ r2:moltbot-data/workspace/
```

## Optional: exclude more tools

Uncomment tools in `config-patch.toml`'s `non_cli_excluded_tools` for
~300-700 more tokens/turn on non-CLI channels (Discord, Telegram).
