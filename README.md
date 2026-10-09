# Lightchain Agent Registry

Directory of apps on Lightchain (chain 9200) for AI agents. Hosted on Cloudflare Workers.

- Manifest: `/.well-known/lightchain-apps.json`
- MCP: `POST /mcp` — `list_apps`, `get_app`, `how_to_pay`, `get_onramp`
- Submit: `POST /submit` — ownership proof + 1 LCAI fee

On-ramp: [bridge.lightchain.ai](https://bridge.lightchain.ai/) (Buy & Bridge, one signature).

Public identity: **KeikoDev**. Git: `KeikoDev <keikodev@users.noreply.github.com>`.

Submit fee (1 LCAI native) is paid to the configured `SUBMISSION_WALLET` on chain 9200.
