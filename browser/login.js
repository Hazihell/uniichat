import { saved } from './store.js';
import { challenge } from './challenge.js';
import { chromium } from 'playwright';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const endpoint = process.env.UNII_BROWSER_ENDPOINT ?? 'http://127.0.0.1:9222';
const server = new Server({ name: 'brave-login', version: '1' }, { capabilities: { tools: {} } });
const result = (status, reason) => ({ content: [{ type: 'text', text: JSON.stringify({ status, reason }) }] });

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{
  name: 'login',
  description: 'Fill a saved Brave password without revealing it. Does not submit. Returns ok (filled), failed, or needs_roger. Relay needs_roger as an approval request; never solve or bypass passkeys, push 2FA, verification codes or CAPTCHAs. Use only on a login page Roger authorized.',
  inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'Exact HTTPS login page URL' }, username: { type: 'string', description: 'Account to select if more than one is saved' } }, required: ['site'], additionalProperties: false },
}] }));


server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  let browser;
  try {
    if (params.name !== 'login' || typeof params.arguments?.site !== 'string') return result('failed', 'invalid_request');
    const url = new URL(params.arguments.site);
    if (url.protocol !== 'https:' || url.username || url.password) return result('failed', 'https_required');
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    const context = browser.contexts()[0];
    const page = context.pages().find(p => p.url() === url.href) ?? await context.newPage();
    if (page.url() !== url.href) await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (new URL(page.url()).origin !== url.origin) return result('needs_roger', 'login_redirected_to_another_origin');
    if (await challenge(page)) return result('needs_roger', 'passkey_2fa_or_captcha');
    const field = page.locator('input[type=password]:visible');
    if (await field.count() !== 1) return result('needs_roger', 'no_unique_password_field');
    await field.click({ timeout: 5000 });
    if (await field.inputValue()) return result('ok', 'filled_by_brave');
    const accounts = saved(url.origin, params.arguments.username);
    if (accounts.length !== 1) return result('needs_roger', accounts.length ? 'choose_saved_account' : 'no_supported_synced_password');
    const account = accounts[0];
    const user = page.locator('input[autocomplete=username]:visible, input[type=email]:visible');
    if (await user.count() === 1) await user.fill(account.username, { timeout: 5000 });
    await field.fill(account.password, { timeout: 5000 });
    return result('ok', 'filled_from_brave_store');
  } catch {
    return result('failed', 'browser_or_password_store_unavailable');
  } finally {
    await browser?.close().catch(() => {});
  }
});
await server.connect(new StdioServerTransport());
