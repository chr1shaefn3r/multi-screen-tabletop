// Tiny key-value store used by the API.
// In production this is Redis: either a REDIS_URL connection string (what Vercel's
// Storage integrations set) or Upstash's REST API. Locally it falls back to memory.
import { HttpError } from './http.js';
import { RedisTcpStore } from './redis-tcp.js';

class UpstashStore {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  async req(path, body) {
    const r = await fetch(this.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Redis error: ' + (j.error || r.status));
    return j;
  }

  async cmd(...args) {
    return (await this.req('', args.map(String))).result;
  }

  async pipeline(cmds) {
    return unwrap(await this.req('/pipeline', cmds.map((c) => c.map(String))));
  }

  // Runs the commands atomically (MULTI/EXEC).
  async tx(cmds) {
    return unwrap(await this.req('/multi-exec', cmds.map((c) => c.map(String))));
  }
}

function unwrap(results) {
  return results.map((x) => {
    if (x.error) throw new Error('Redis error: ' + x.error);
    return x.result;
  });
}

// Implements just the Redis commands the API uses.
export class MemoryStore {
  constructor() {
    this.data = new Map();
    this.expires = new Map();
  }

  alive(k) {
    const e = this.expires.get(k);
    if (e !== undefined && e <= Date.now()) {
      this.data.delete(k);
      this.expires.delete(k);
    }
    return this.data.has(k);
  }

  exec([name, ...a]) {
    const k = String(a[0]);
    switch (String(name).toUpperCase()) {
      case 'GET':
        return this.alive(k) ? this.data.get(k) : null;
      case 'SET': {
        let ex = null, nx = false, xx = false;
        for (let i = 2; i < a.length; i++) {
          const o = String(a[i]).toUpperCase();
          if (o === 'EX') ex = Number(a[++i]);
          else if (o === 'NX') nx = true;
          else if (o === 'XX') xx = true;
        }
        const has = this.alive(k);
        if ((nx && has) || (xx && !has)) return null;
        this.data.set(k, String(a[1]));
        if (ex) this.expires.set(k, Date.now() + ex * 1000);
        else this.expires.delete(k);
        return 'OK';
      }
      case 'DEL': {
        let n = 0;
        for (const key of a.map(String)) {
          if (this.alive(key)) n++;
          this.data.delete(key);
          this.expires.delete(key);
        }
        return n;
      }
      case 'INCR': {
        const v = (this.alive(k) ? Number(this.data.get(k)) : 0) + 1;
        this.data.set(k, String(v));
        return v;
      }
      case 'EXPIRE':
        if (!this.alive(k)) return 0;
        this.expires.set(k, Date.now() + Number(a[1]) * 1000);
        return 1;
      case 'RPUSH': {
        let list = this.alive(k) ? this.data.get(k) : null;
        if (!list) {
          list = [];
          this.data.set(k, list);
        }
        list.push(...a.slice(1).map(String));
        return list.length;
      }
      case 'LRANGE': {
        if (!this.alive(k)) return [];
        const list = this.data.get(k);
        const start = Number(a[1]);
        const stop = Number(a[2]) < 0 ? list.length + Number(a[2]) : Number(a[2]);
        return list.slice(start, stop + 1);
      }
      case 'LLEN':
        return this.alive(k) ? this.data.get(k).length : 0;
      default:
        throw new Error('MemoryStore: unsupported command ' + name);
    }
  }

  async cmd(...args) {
    return this.exec(args);
  }

  async pipeline(cmds) {
    return cmds.map((c) => this.exec(c));
  }

  async tx(cmds) {
    return cmds.map((c) => this.exec(c));
  }
}

export function getStore() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) return new UpstashStore(url, token);
  if (process.env.REDIS_URL) {
    globalThis.__tiletopRedis ??= new RedisTcpStore(process.env.REDIS_URL); // reuse the connection while warm
    return globalThis.__tiletopRedis;
  }
  if (process.env.VERCEL) {
    throw new HttpError(
      500,
      'No Redis database connected. In Vercel, open the project → Storage → create a Redis database, connect it to this project and redeploy.',
    );
  }
  globalThis.__tiletopStore ??= new MemoryStore();
  return globalThis.__tiletopStore;
}
