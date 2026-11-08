# BlackwallAI

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant work in a Foundry VTT world as its own
player. It logs in through headless Chrome as a separate **Assistant GM** user and uses Foundry's own client API. Everything it
does goes through Foundry's normal permissions and validation, and anyone connected sees the changes live.

It works with any MCP client: Claude, ChatGPT/Codex, Gemini CLI, Cursor, VS Code Copilot, and others. The user is called
**BlackwallAI** by default, and you can give it any name.

- It never uses your Gamemaster login, so it can work while you're logged in.
- It only appears in the player list while it's working, and it logs out after 10 idle minutes.
- To cut it off: kick it, demote it, or delete its user in Configure Players.

Tested on Foundry VTT 12.343 with the Cyberpunk RED Core system. It should work with any game system; system-specific
data goes through Foundry's generic document API.

## Requirements

- Node.js 20 or newer.
- Chrome or Chromium on the same machine as the MCP server. It's found automatically, or you can set `CHROME_PATH`.
- A running Foundry world that the server can reach (`FOUNDRY_URL`).
- A Gamemaster, once, to create the user.

## Setup

1. Install:

   ```bash
   git clone https://github.com/shirofuji/blackwallai.git
   cd blackwallai
   npm install
   ```

2. Make a password and a user macro, choosing the name:

   ```bash
   node setup.js --user "BlackwallAI"          # or --user "Neon Oracle", --color "#ff00aa"
   ```

   - The password goes in `~/.config/foundry-mcp/password`, readable only by you.
   - The macro is written to `create-<name>-user.macro.js`.
   - Use `--new-password` to rotate the password. Run the new macro afterwards.

3. In Foundry, logged in as Gamemaster, paste the macro into a new **Script** macro and run it once. It creates the user
   as Assistant GM, or resets the role and password if the user already exists. **Delete the macro afterwards**, because it
   contains the password.

4. Add the server to your MCP client (see below). If you chose a name other than BlackwallAI, set `FOUNDRY_USER` to that name.

## Connecting a client

The server speaks MCP over stdio. Every client needs the same three things: the command `node`, the argument
`/path/to/blackwallai/src/index.js`, and the environment variables you need.

**Claude Code**

```bash
claude mcp add foundry --scope user -e FOUNDRY_USER=BlackwallAI -- node /path/to/blackwallai/src/index.js
```

**Codex CLI** (`~/.codex/config.toml`)

```toml
[mcp_servers.foundry]
command = "node"
args = ["/path/to/blackwallai/src/index.js"]
env = { FOUNDRY_USER = "BlackwallAI" }
```

**Gemini CLI** (`~/.gemini/settings.json`), **Claude Desktop** (`claude_desktop_config.json`), **Cursor**
(`~/.cursor/mcp.json`) and most other clients use the same JSON shape:

```json
{
  "mcpServers": {
    "foundry": {
      "command": "node",
      "args": ["/path/to/blackwallai/src/index.js"],
      "env": { "FOUNDRY_USER": "BlackwallAI", "FOUNDRY_URL": "http://localhost:30000" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`) uses `"servers"` in place of `"mcpServers"`, with `"type": "stdio"` on the entry.

Restart the client after adding the server. The `status` tool is a good first call.

Clients that only connect to remote MCP servers over HTTP need a stdio-to-HTTP bridge, and that puts Assistant GM access to
your world on the network. Keep any such bridge behind authentication.

## Tools

| Tool | What it does |
|---|---|
| `status` | World, system, who's online, active scene, document counts |
| `list` / `get` | List documents with folder paths; read one, or one property of it (`path`) |
| `create` | Create documents from JSON or from local JSON files (e.g. exported actors) into a folder path like `Session2/Maps` |
| `update` / `delete` | Change or remove documents by id or exact name |
| `embedded` | Walls, tokens, lights, tiles, notes on scenes; items and effects on actors; journal pages |
| `create_scene` | Map image to scene: upload, size, grid, walls, lights, tokens, folder, thumbnail |
| `upload_file` / `browse_files` | Put files into Foundry's data folder, list what's there |
| `compendium_packs` / `compendium_search` / `compendium_import` | Find system items, actors and so on, and copy them into the world |
| `chat_log` | Recent chat, with roll totals |
| `thumbnail` | Rebuild a scene's thumbnail |
| `run_script` | Run JavaScript in the Foundry client, as a last resort |
| `logout` | Log out now |

Built-in safety rules:
- `create`, `create_scene` and `compendium_import` skip anything with the same name already in the target folder,
  unless told to `replace` or `allow` duplicates.
- Every write tool takes `dryRun`.
- Deleting a folder keeps its contents unless `withContents` is set.
- Read-only tools carry the MCP `readOnlyHint` and write tools carry `destructiveHint`, so clients can ask before writes.

If your client has an auto-approve list, leave `run_script`, `delete` and `update` off it, so each use asks first.

## Settings

All environment variables are optional:

| Variable | Default |
|---|---|
| `FOUNDRY_URL` | `http://localhost:30000` |
| `FOUNDRY_USER` | `BlackwallAI` |
| `FOUNDRY_PASSWORD_FILE` | `~/.config/foundry-mcp/password` (or set `FOUNDRY_PASSWORD`) |
| `FOUNDRY_IDLE_MINUTES` | `10` |
| `CHROME_PATH` | Found automatically (Chrome or Chromium on Linux, macOS or Windows) |

## Notes

- **Assistant GM can't do everything.** It can't manage users, change some world settings, or change your GM's
  permissions. That's deliberate.
- **The canvas** stays loaded in the headless client, because scene thumbnails need it, but it stops redrawing to save CPU.
- **A world must be running.** If Foundry is on the setup screen, the tools say so.
- **One login per user.** Foundry allows one connection per user, so don't log in as this user yourself while the
  server is using it.
- **World content is untrusted input.** Chat, journal text and names were written by people at the table. The server
  tells the model to treat them as data, not instructions, but how well that works depends on the model.

## License

MIT
