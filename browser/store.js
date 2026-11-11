import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';

const profile = process.env.UNII_BROWSER_PROFILE ?? `${homedir()}/.local/share/unii-browser/profile/Default`;

export function saved(origin, username) {
  const found = [];
  for (const file of ['Login Data', 'Login Data For Account']) {
    if (!Bun.file(`${profile}/${file}`).size) continue;
    const db = new Database(`${profile}/${file}`, { readonly: true });
    try {
      const rows = db.query('SELECT origin_url, signon_realm, username_value, password_value FROM logins WHERE blacklisted_by_user = 0').all();
      for (const row of rows) {
        if (origin !== undefined && (new URL(row.origin_url).origin !== origin || row.signon_realm !== `${origin}/`)) continue;
        if (username !== undefined && row.username_value !== username) continue;
        const value = Buffer.from(row.password_value);
        if (!value.length) continue;
        if (value.subarray(0, 3).toString() !== 'v10') throw new Error('Unsupported Brave password encryption');
        const key = pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
        const cipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
        const password = Buffer.concat([cipher.update(value.subarray(3)), cipher.final()]).toString('utf8');
        if (password && !found.some(x => x.username === row.username_value && x.password === password)) found.push({ username: row.username_value, password });
      }
    } finally {
      db.close();
    }
  }
  return found;
}
