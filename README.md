# Tiletop

Put phones and tablets next to each other on a table and turn them into **one big game board**.
A piece dragged to the edge of one phone continues on the next one, lined up to the millimetre.

## How a game works

1. **Game master** opens the site, enters the host password and gets a 6-character code (plus a QR code).
2. **Players** open the site on their devices and join with the code. Every device shows a big number and colour.
3. **Layout** – the game master's screen shows a rectangle for every device. Drag them so they match how the
   devices lie on the table (edges snap together) and rotate the ones that lie sideways or upside down.
4. **Align** – every screen shows the same pattern of lines and circles. On each device, drag until the lines
   continue straight into the neighbouring screens. The gaps between
   screens (bezels) are handled naturally: the picture simply continues "behind" them.
   Each screen shows the size it is assumed to have (e.g. "65 × 145 mm"); it should match the real screen.
   *Card size* lets you match a bank card outline to set the exact physical size of a screen.
   *Resize* allows changing the size with two fingers, *Rotate* allows small twists if a device lies slightly
   crooked. Both are off by default so a stray second finger can't change them.
5. **Play** – pick Chess, Checkers, a battle map with a 1-inch grid, a free table with dice and tokens, or upload
   an image as a map. Drag pieces, tap a die to roll it, double-tap a checkers piece to crown it.

## How the devices connect

The devices talk **directly to the game master's device** over WebRTC data channels: fast, free, and
nothing goes through Vercel during a game. Vercel only does the short handshake when a device joins:

```
player ──offer──▶ /api/join ──▶ Redis ◀── /api/host (poll) ◀── game master
player ◀─answer── /api/join ◀── Redis ◀── /api/host (answer) ◀── game master
player ◀════════════ direct WebRTC connection ═════════════▶ game master
```

The game master's device is the "server" of the game: it holds the game state and relays moves.

## Deploy on Vercel (free)

1. Import this GitHub repository in Vercel (**Add New → Project**). No framework, no build command needed.
2. In the project, open **Storage → Create Database**, pick a Redis provider with a free plan (e.g. Redis or
   Upstash for Redis) and connect it to the project. This sets the `REDIS_URL` variable.
3. In **Settings → Environment Variables** add `HOST_SECRET` with a long password of your choice.
4. Redeploy, because new environment variables only take effect in a new deployment. Open the site, choose "I'm the game master", enter the password.

Optional: `ICE_SERVERS` (JSON) to add a TURN server if devices can't connect directly – see `.env.example`.

## Abuse protection

- Only someone with `HOST_SECRET` can open a table. After 10 wrong passwords an IP is locked out for an hour.
- Joining needs a valid code (32⁶ ≈ 1 billion combinations) and is rate limited per IP.
- Codes expire after 6 hours without activity; at most 16 devices can wait to join at once; payloads are size-checked.
- The game master's lobby closes by itself after 10 minutes without new devices (re-open it in the panel),
  so an idle game doesn't keep using serverless calls.
- Game traffic never touches Vercel, so there is no bandwidth to abuse.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000, host password "devsecret"
npm test
```

Requires Node.js 24. Without `REDIS_URL`, an in-memory store replaces Redis. To try it with real phones,
open `http://<your-computer-ip>:3000` on devices in the same Wi-Fi.

## When devices don't connect

Tap **Connection details** (the **i** button, or the button on the "Connecting…" screen; the game master
finds it in the panel too). It shows every step live: the network addresses each device offered, each
connection check between the two devices, and a diagnosis if it fails. **Copy** puts the log on the clipboard.
Compare the player's log with the game master's: both sides of a join are logged.

The server logs (Vercel → project → **Logs**) show the server's part of every join, one line per request:

```
[tiletop] join/offer code=K7RX2M from=#3fa2 → 200 in 41ms | stored offer peer=UhSh3x… (1 waiting for the game master), offer has 2 address(es): host udp ×1 (mDNS), srflx udp ×1
[tiletop] host/poll code=K7RX2M from=#3fa2 → 200 in 12ms | handed offer peer=UhSh3x… to the game master (it waited 1.3s)
[tiletop] host/answer code=K7RX2M from=#3fa2 → 200 in 9ms | stored answer for peer=UhSh3x…, answer has 2 address(es): …
[tiletop] join/answer code=K7RX2M from=#3fa2 → 200 in 8ms | device picked up the answer for peer=UhSh3x… Server part done, the devices now connect directly.
```

`from=` is an anonymous tag of the IP address (devices on the same Wi-Fi share one). Errors are logged as warnings
with their reason. Routine "nothing new" polls are hidden; set the environment variable `LOG_LEVEL=debug` to see them.
If all four lines appear but the devices still don't connect, the problem is the direct connection between
the devices, not the server.

The usual cause is a Wi-Fi network that doesn't let devices talk to each other (guest networks, "AP/client
isolation"). Try a phone hotspot, or add a TURN relay server through `ICE_SERVERS`.

## Tips and limits

- Put all devices on the **same Wi-Fi**. Across different networks (e.g. mobile data) a TURN server is needed.
- Turn off auto-rotate before the layout step; a device that rotates changes its screen shape.
- Use fullscreen (⛶). iPhones don't support fullscreen in the browser: use Share → **Add to Home Screen**.
  That also stops Safari's swipe-back gesture when you drag pieces over the left edge.
- Screen sizes are first guessed from the device type; the align step (or *Card size*) fixes the exact scale.
- A piece can't be dragged over a gap in one go: drag it to the edge, then pick it up on the next screen.

## Code overview

| Path | What it does |
| --- | --- |
| `api/host.js`, `api/join.js` | Vercel functions for the join handshake (password check, rate limits) |
| `lib/` | Redis access ([node-redis](https://github.com/redis/node-redis)) with an in-memory fallback, HTTP helpers |
| `public/js/core.js` | Game master's authoritative state: devices, their position on the table, pieces |
| `public/js/screen.js` | Draws one device's part of the table and handles touch (align gestures, dragging) |
| `public/js/layout.js` | Layout editor on the game master's device |
| `public/js/games.js`, `draw.js` | Game setups and drawing of boards and pieces |
| `public/js/net.js` | WebRTC connection setup and API calls |
| `public/js/diag.js` | Connection log and the "Connection details" screen |
