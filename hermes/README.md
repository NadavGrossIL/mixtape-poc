# hermes/ — Mixtape as a Hermes Agent skill

[Hermes Agent](https://hermes-agent.nousresearch.com/) is Nous Research's
open-source, self-hosted agent: persistent memory, self-written skills, one
gateway for WhatsApp / Telegram / Slack / Discord. This folder makes Mixtape
one of its skills, so "make me something for a rainy drive" in a WhatsApp
chat comes back as a pressed Spotify playlist.

Nothing here touches the app. The skill is a client of the public API, exactly
like the browser: `POST /api/generate/stream` → `POST /api/adjust/stream` →
`POST /api/playlist`, as a guest, under the same daily caps.

```
skills/music/mixtape/
  SKILL.md              what the agent reads: when to use, procedure, limits
  scripts/mixtape.mjs   the client — generate | adjust | press (node, no deps)
```

## Wire it into a Hermes install

1. In `~/.hermes/config.yaml`:
   ```yaml
   skills:
     external_dirs:
       - ~/Projects/mixtape-poc/hermes/skills
   ```
   External dirs are read-only to Hermes; a skill it writes itself lands in
   `~/.hermes/skills/`. Check with `hermes skills list` — `mixtape` should
   show under `music`.
2. The script needs nothing but `node`. It keeps its guest cookie and the
   last card under `~/.hermes/mixtape/` (override with `MIXTAPE_STATE`), and
   talks to the live app (override with `MIXTAPE_URL`, e.g.
   `http://127.0.0.1:8888` against a local server).

Try it without Hermes:

```sh
node hermes/skills/music/mixtape/scripts/mixtape.mjs generate "late-night drive back from Eilat"
node hermes/skills/music/mixtape/scripts/mixtape.mjs adjust "less synth"
node hermes/skills/music/mixtape/scripts/mixtape.mjs press
```

## Why a script and not an MCP server

Hermes skills are procedural: a markdown file that tells the agent which
terminal commands to run. A single self-contained script is the smallest
thing that matches that shape, is testable from a shell, and needs no server
process of its own. If Mixtape ever grows an MCP surface, Hermes is also an
MCP client (`mcp_servers:` in its config) and the skill can point at that
instead.
