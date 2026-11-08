#!/usr/bin/env node
// One-time setup: makes the MCP user's password (kept in a file only you can read) and writes a macro
// that a Gamemaster runs once in Foundry to create that user as Assistant GM.
//   node setup.js [--user Name] [--color "#rrggbb"] [--out macro.js] [--new-password]
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { passwordFile, userName } from './src/config.js'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const user = opt('--user') ?? userName()
const color = opt('--color') ?? '#3fd8ff'
if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`--color must look like #3fd8ff, not ${color}`)
const slug = user.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp'
const out = resolve(opt('--out') ?? `create-${slug}-user.macro.js`)
const pwFile = passwordFile()

let password = !args.includes('--new-password') && existsSync(pwFile) ? readFileSync(pwFile, 'utf8').trim() : ''
if (!password) {
  password = randomBytes(18).toString('base64url')
  mkdirSync(dirname(pwFile), { recursive: true, mode: 0o700 })
  writeFileSync(pwFile, password + '\n', { mode: 0o600 })
}
chmodSync(pwFile, 0o600)

writeFileSync(out, `// Creates the "${user}" user (Assistant GM) that the MCP server logs in as, or resets its
// role and password if it exists. Run once as a Gamemaster, then delete this macro: it holds the password.
const data = { role: CONST.USER_ROLES.ASSISTANT, password: ${JSON.stringify(password)} };
const existing = game.users.getName(${JSON.stringify(user)});
if (existing) await existing.update(data);
else await User.create({ name: ${JSON.stringify(user)}, color: ${JSON.stringify(color)}, ...data });
ui.notifications.info(${JSON.stringify(`${user} is ready as Assistant GM. Delete this macro now.`)});
`, { mode: 0o600 })
console.log(`Password in ${pwFile}\nMacro for the GM: ${out}`)
if (user !== userName()) console.log(`Set FOUNDRY_USER=${user} in your MCP client's config for this server.`)
