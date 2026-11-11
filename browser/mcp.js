import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createConnection } from '@playwright/mcp';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { saved } from './store.js';
import { challenge } from './challenge.js';

const endpoint = process.env.UNII_BROWSER_ENDPOINT ?? 'http://127.0.0.1:9222';
const withheld = new Set(['browser_install', 'browser_close']);
const secrets = new Set();
let secretEntries = {};
const upstreamSecrets = new Proxy({}, {
  ownKeys() {
    for (const account of saved()) secrets.add(account.password);
    secretEntries = Object.fromEntries([...secrets].map((value, index) => [`password_${index}`, value]));
    return Object.keys(secretEntries);
  },
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  get: (_target, key) => secretEntries[key],
});
const outputDir = process.env.UNII_BROWSER_OUTPUT ?? `${homedir()}/.local/state/unii-browser/mcp`;
mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const upstream = await createConnection({ outputDir, browser: { cdpEndpoint: endpoint }, secrets: upstreamSecrets, snapshot: { mode: 'full' } });
const [local, remote] = InMemoryTransport.createLinkedPair();
await upstream.connect(remote);
const client = new Client({ name: 'brave-private', version: '1' });
await client.connect(local);
const server = new Server({ name: 'brave-browser', version: '1' }, { capabilities: { tools: {} } });
const failed = reason => ({ content: [{ type: 'text', text: JSON.stringify({ status: 'needs_roger', reason }) }] });

async function remember() {
  for (const account of saved()) secrets.add(account.password);
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
  let needsRoger = false;
  try {
    for (const page of browser.contexts()[0].pages()) {
      if (!['http:', 'https:', 'about:'].includes(new URL(page.url()).protocol)) throw new Error('Close private browser settings before agent access');
      if (['http:', 'https:'].includes(new URL(page.url()).protocol) && await challenge(page)) needsRoger = true;
      for (const frame of page.frames()) {
        const values = await frame.locator('input[type=password]').evaluateAll(inputs => inputs.map(input => input.value));
        for (const value of values) if (value) secrets.add(value);
      }
    }
  } finally {
    await browser.close();
  }
  return needsRoger;
}

function redact(value) {
  if (typeof value === 'string') {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[password hidden]');
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await client.listTools()).tools.filter(tool => !withheld.has(tool.name)) }));
let pending = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
  const run = pending.then(async () => {
    try {
      if (withheld.has(params.name)) return failed('unsupported_browser_operation');
      if (params.name === 'browser_navigate') {
        const url = new URL(params.arguments?.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return failed('unsupported_browser_url');
      }
      await remember();
      const response = await client.callTool(params);
      const needsRoger = await remember();
      const safe = redact(response);
      if (needsRoger) safe.content.unshift({ type: 'text', text: JSON.stringify({ status: 'needs_roger', reason: 'passkey_2fa_or_captcha', action: 'Ask Roger to complete the challenge in Brave, then resume.' }) });
      return safe;
    } catch {
      return failed('browser_unavailable_or_password_redaction_failed');
    }
  });
  pending = run.then(() => {});
  return run;
});
await server.connect(new StdioServerTransport());
