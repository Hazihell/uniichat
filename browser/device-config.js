import { resolve } from 'node:path';

const directory = resolve(import.meta.dir);
console.log(JSON.stringify({ mcp: {
  browser: { command: 'bun', args: [`${directory}/mcp.js`] },
  'browser-login': { command: 'bun', args: [`${directory}/login.js`] },
} }, null, 2));
