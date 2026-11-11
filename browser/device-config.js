import { resolve } from 'node:path';

const directory = resolve(import.meta.dir);
console.log(JSON.stringify({ mcp: {
  browser: { command: process.execPath, args: [`${directory}/mcp.js`] },
  'browser-login': { command: process.execPath, args: [`${directory}/login.js`] },
} }, null, 2));
