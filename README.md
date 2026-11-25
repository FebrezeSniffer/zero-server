# ZEROFRAME Arena server

Real-time 1v1 (WebSocket, 30 updates/s, server-owned health and kills) plus leaderboards, score duels and player tags.

## Run it locally
```
npm install
npm start
```
Check http://localhost:8080/health returns `{"ok":true}`.

## Deploy (Render, free tier)
1. Push this folder to a GitHub repo.
2. On render.com: New > Web Service > pick the repo.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Environment variables:
   - `ALLOWED_ORIGIN` = your game's URL (for example `https://yourname.itch.io`). Leave unset while testing.
   - `DATA_FILE` = `/var/data/data.json` if you attach a Render disk (paid). Without a disk, scores reset when the server restarts.
5. Deploy, then open `https://<your-service>.onrender.com/health`.

Free Render services sleep after inactivity; the first connection can take ~30 s to wake.
Railway and Fly.io work the same way (Node app, `npm start`, `PORT` is provided by the host).

## Hook up the game
`client/zfServer.ts` is the drop-in client. In the standalone game build:
- Set `VITE_ZF_SERVER=https://<your-service>.onrender.com`.
- Replace the Quick storage calls in `lib.ts` with the exports from `zfServer.ts`.
- Replace `Net.ts` (shared-storage polling) with `connectLive()`; report hits with `sendHit` and apply damage from `onDamage`.

## Protocol (WebSocket `/live`)
Client > server: `host {name}`, `join {code,name}`, `state {x,y,z,yaw,pitch,lean,crouch,weapon}`, `fire {weapon}`, `hit {dmg,head}`.
Server > client: `hosted`, `start`, `state`, `fire`, `damage`, `confirm`, `kill`, `respawn`, `end`, `left`, `error`.
First to 5 kills or most kills in 3 minutes. Damage per hit is capped at 140 server-side.
