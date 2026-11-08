// Settings shared by the server and setup.js. Everything can be overridden with environment variables.
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_USER = 'BlackwallAI'
export const userName = () => process.env.FOUNDRY_USER || DEFAULT_USER
export const passwordFile = () => process.env.FOUNDRY_PASSWORD_FILE || join(homedir(), '.config/foundry-mcp/password')
