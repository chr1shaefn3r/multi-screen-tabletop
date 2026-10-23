// Minimal Redis client over TCP/TLS for a REDIS_URL connection string
// (redis://user:pass@host:port or rediss:// for TLS). It supports exactly what the
// API needs: single commands, pipelines and MULTI/EXEC. No npm dependency needed.
import net from 'node:net';
import tls from 'node:tls';

class RedisReplyError extends Error {}

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

// Parses one RESP reply starting at offset i. Returns [value, nextOffset] or null if incomplete.
function parse(buf, i) {
  const end = buf.indexOf('\r\n', i);
  if (end < 0) return null;
  const type = buf[i];
  const line = buf.toString('utf8', i + 1, end);
  let p = end + 2;
  switch (type) {
    case 0x2b: // +
      return [line, p];
    case 0x2d: // -
      return [new RedisReplyError(line), p];
    case 0x3a: // :
      return [Number(line), p];
    case 0x24: { // $
      const n = Number(line);
      if (n < 0) return [null, p];
      if (buf.length < p + n + 2) return null;
      return [buf.toString('utf8', p, p + n), p + n + 2];
    }
    case 0x2a: { // *
      const n = Number(line);
      if (n < 0) return [null, p];
      const arr = [];
      for (let k = 0; k < n; k++) {
        const r = parse(buf, p);
        if (!r) return null;
        arr.push(r[0]);
        p = r[1];
      }
      return [arr, p];
    }
    default:
      throw new Error('Unexpected reply from Redis');
  }
}

function check(value) {
  if (value instanceof Error) throw new Error('Redis error: ' + value.message);
  return value;
}

export class RedisTcpStore {
  constructor(url) {
    this.url = new URL(url);
    this.conn = null;
  }

  connect() {
    if (this.conn) return this.conn;
    const u = this.url;
    const host = u.hostname;
    const port = Number(u.port || 6379);
    const socket = u.protocol === 'rediss:' ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(10000); // also drops idle connections
    const conn = { socket, queue: [], buf: Buffer.alloc(0) };

    socket.on('data', (d) => {
      conn.buf = conn.buf.length ? Buffer.concat([conn.buf, d]) : d;
      try {
        let r;
        while (conn.queue.length && (r = parse(conn.buf, 0))) {
          conn.buf = conn.buf.subarray(r[1]);
          conn.queue.shift().resolve(r[0]);
        }
        if (!conn.queue.length) socket.unref(); // an idle connection shouldn't keep the process alive
      } catch (e) {
        fail(e);
      }
    });
    const fail = (err) => {
      if (this.conn === conn) this.conn = null;
      for (const q of conn.queue.splice(0)) q.reject(err);
      socket.destroy();
    };
    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error('Redis connection timed out')));
    socket.on('close', () => fail(new Error('Redis connection closed')));
    this.conn = conn;

    const pre = [];
    const user = decodeURIComponent(u.username), pass = decodeURIComponent(u.password);
    if (pass) pre.push(user ? ['AUTH', user, pass] : ['AUTH', pass]);
    const db = Number(u.pathname.slice(1));
    if (db) pre.push(['SELECT', db]);
    conn.ready = pre.length ? this.send(conn, pre).then((rs) => rs.forEach(check)) : Promise.resolve();
    conn.ready.catch(() => {});
    return conn;
  }

  send(conn, cmds) {
    const replies = cmds.map(() => new Promise((resolve, reject) => conn.queue.push({ resolve, reject })));
    conn.socket.ref();
    conn.socket.write(cmds.map(encode).join(''));
    return Promise.all(replies);
  }

  // Sends commands and returns their raw replies. A dropped connection (e.g. after the
  // serverless function was frozen) is retried once on a fresh one.
  async run(cmds, retry = true) {
    try {
      const conn = this.connect();
      await conn.ready;
      return await this.send(conn, cmds);
    } catch (e) {
      if (!retry || e.message.startsWith('Redis error')) throw e;
      this.conn?.socket.destroy();
      this.conn = null;
      return this.run(cmds, false);
    }
  }

  async cmd(...args) {
    return check((await this.run([args]))[0]);
  }

  async pipeline(cmds) {
    return (await this.run(cmds)).map(check);
  }

  async tx(cmds) {
    const replies = await this.run([['MULTI'], ...cmds, ['EXEC']]);
    replies.slice(0, -1).forEach(check);
    const results = check(replies.at(-1));
    if (!Array.isArray(results)) throw new Error('Redis transaction failed');
    return results.map(check);
  }
}
