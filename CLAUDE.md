# Cubica

An original voxel sandbox/survival game that runs in the browser, built for playing with friends for free:
a static site (GitHub Pages) plus peer-to-peer multiplayer (WebRTC via PeerJS), with no paid backend.

**Scope:** an original game in the genre, not a recreation of an existing game. It uses genre conventions
(chunks, mining, grid crafting, hunger/health, standard PC keys), but the blocks, names, textures, recipes,
creatures, power system, extra dimension, enchanting and villages are our own designs. Never use assets,
names or textures from Mojang/Minecraft, and do not map their content 1:1 (e.g. no creeper equivalent,
no obsidian-frame portal).

The user speaks Hebrew. The game UI (menus/overlays) is in Hebrew (RTL); code, comments and the debug overlay are in English.

## Running

Node is installed locally (no Homebrew): `~/.local/node/bin` (Node 22). Add it to PATH:

```bash
export PATH=~/.local/node/bin:$PATH
npm run dev        # http://localhost:5173  (?vd=<2..16> view distance)
npm test           # vitest
npm run build      # tsc --noEmit + vite build -> dist/
```

In the Claude desktop app: preview server named `cubica` (defined in `/Users/idos/אתר/.claude/launch.json`).
In the browser console, `window.cubica` is the `App` (`cubica.session.server` / `cubica.session.client`).
When Pointer Lock is refused (embedded/automated browsers, iframes) `Controls` falls back to a
free-mouse mode after the rejection or 800 ms: the cursor stays visible, mouse movement and the arrow keys
look around, Esc pauses. It can also be driven from JS: `client.controls.down` / `client.controls.buttons` /
`client.interaction.mouseDown(2)`.

## Architecture

**Server and client are separated from day one.** Single player is "a host with one player".

- `GameServer` (src/server) is the authority: world, 20 TPS tick, chunk streaming, action validation,
  saving. It never touches the DOM or three.js.
- `GameClient` (src/client) handles rendering, input, (future) movement prediction, and UI.
- They talk only through `Transport` (src/net) and the messages in `src/shared/protocol/messages.ts`.
  - Single player and the host's own client: `LocalTransport` (in memory, asynchronous).
  - Friends: `PeerTransport` (PeerJS DataConnection, `serialization: 'raw'`, `reliable: true`) with our
    own binary codec + fragmentation (`shared/protocol/codec.ts`).
- The server runs on the main thread (WebRTC is not available in Workers). Heavy work goes to Workers:
  - `worldgen.worker.ts`: generation + base (isolated) chunk lighting.
  - `mesher.worker.ts`: greedy meshing.
  - `WorkerPool` (src/workers) is a generic pool with a `{id, req}` → `{id, res}` contract.

```
src/
  main.ts app.ts          boot; App = menus (main / new world / load / join / pause) + session lifecycle
  game/GameSession.ts     server + local client for one world being played
  shared/                 pure code (no DOM), used by server, client and workers
    constants.ts rng.ts noise/simplex.ts
    blocks/registry.ts    block definitions + lookup tables (OPAQUE, LIGHT_*, TEX_*) + TEXTURE_NAMES
    world/Chunk.ts chunkCodec.ts lighting.ts biomes.ts
    mesh/mesher.ts        greedy mesher (padded 18×18×H volume)
    blocks/placement.ts   placement orientation (facing/torch walls/doors) + isSupported (what pops off)
    items/                registry (items ≥4096, tools, food, fuel), Inventory, Window (container click
                          logic incl. crafting output), crafting (recipes + smelting), mining (breakTime,
                          canHarvest, blockDrops)
    physics/              PlayerBody (movement for players AND creatures: width/height/walkSpeed/
                          climber), collision (AABB sweep), raycast (DDA)
    entities/mobs.ts      creature definitions (size, health, speed, drops) + combat constants
    time.ts               day fraction / sun height / daylight (shared by sky and spawning)
    protocol/messages.ts  ClientMsg / ServerMsg
  server/ GameServer.ts ServerWorld.ts WorkerChunkGenerator.ts PlayerSession.ts ItemEntities.ts
          mobs/MobManager.ts (creature AI, spawning, combat, thorns, spore clouds) mobs/pathfind.ts (A*)
          worldgen/WorldGenerator.ts worldgen/trees.ts (shared by worldgen and sapling growth)
          storage/WorldStorage.ts   IndexedDB worlds + .cubica export/import
  client/ GameClient.ts ClientWorld.ts render/ textures/ input/ ui/ player/LocalPlayer.ts
          interaction/BlockInteraction.ts   targeting, mining progress + cracks, placing, pick block
          ui/Hud.ts (hotbar, hearts/food/air, messages) WindowScreen.ts (all container UIs) icons.ts
          render/EntityRenderer.ts (dropped items as sprites)  textures/itemTextures.ts (item sprites)
          render/PlayerModels.ts (other players: block figure, name tag, interpolation)
          ui/Social.ts (T chat line, Tab player list)
          render/MobRenderer.ts (creature box models, animation, thorns, spore particles, pick ray)
  net/    Transport.ts LocalTransport.ts PeerTransport.ts peerNetwork.ts (HostNetwork, joinHost,
          invite codes, Hebrew error messages; peerjs is loaded lazily, so single player never touches it)
  workers/ WorkerPool.ts worldgen.worker.ts mesher.worker.ts types.ts
tests/    vitest (noise, worldgen, codec, lighting, mesher, inventory, physics, raycast, world file,
          host validation + save/load through a real GameServer with a fake generator and in-memory store)
```

### Chunk data model
- 16×16×256. Index `x | z<<4 | y<<8` (horizontal layers are contiguous).
- `blocks: Uint16Array`: 12-bit id + 4-bit state. `light: Uint8Array`: high nibble sky, low nibble block.
- `heightmap` (highest non-air block per column), `biomes` (per column), `maxY`.
- `blockEntities: Map<index, BlockEntity>`: chests and furnaces (contents, burn/cook state).
- Block state (upper 4 bits) is used by: furnace/chest facing, doors (facing | open | upper half), torches
  (standing or which wall). Messages carry raw values (id + state).
- `chunkCodec` v2: version + cx/cz + topY + RLE(varint) of blocks and light up to `maxY+16` + block
  entities as JSON. Reads v1 too. Used for both network and saves. A typical chunk is a few KB.

### Lighting
- Sky light (15 travels straight down without loss through clear blocks) + block light (emitters), via BFS.
- Every chunk is lit **in isolation** in the gen worker. The client runs `mergeChunkBorders` when a chunk
  arrives to let light cross boundaries. The client holds the "correct" light; the server holds base light
  (enough for now; stage 5 spawning will need merging on the server too).
- `updateLightAt` handles incremental updates (removal + re-flood) on block changes. Tested; it gets wired
  into gameplay in stage 2.
- Light is stored per vertex (smooth lighting + AO). The shader multiplies sky light by `uSkyLight`
  (daylight colour), so the day/night cycle never requires a remesh.

### Rendering
- One opaque mesh (including cutout leaves and plants) + one translucent mesh (water and ice) per chunk.
  Positions are Int16 in 1/16 units (mesh.scale = 1/16), 16 bytes per vertex.
- Textures: 16×16 procedural pixel art (`client/textures/procedural.ts`), assembled into a Canvas atlas and
  from it into a `DataArrayTexture` (WebGL2), so greedy quads repeat a tile.
- A chunk is meshed only when all 8 of its neighbours are present. The server streams `viewDistance+1`.
- Faces between two translucent blocks are skipped (translucent faces don't write depth).
- three.js colour management is off: colours and textures are raw sRGB.

### Worldgen
- `WorldGenerator.column(x,z)` is a pure function: continentalness spline + mountain mask + ridge + detail
  → height; temperature/humidity → biome (ocean, frozen ocean, beach, plains, forest, desert, snowfield,
  mountains).
- Caves: tunnels (two 3D noises near zero) + caverns. Ores by depth: coal ≤128, iron ≤64, gold ≤32,
  diamond ≤16. Lumen crystals (glowing) on cave ceilings.
- Trees that cross chunk boundaries are re-derived from neighbouring columns (MARGIN=3), with no
  pending-block queue, so every chunk is independent and deterministic.

### Protocol (Host ↔ Client)
See `src/shared/protocol/messages.ts`. Implemented: `hello`, `welcome`, `move`, `dig`, `place`, `held`,
`inv`, `setGameMode` (host only), `chunk`, `unloadChunk`, `blockChange`, `inventory`, `gameMode`, `time`,
`kick`. The rest are reserved with the stage they arrive in noted.

**Prediction + authority:** the client applies dig/place/inventory actions immediately (same shared code)
and sends them; the host validates and broadcasts `blockChange` to everyone holding that chunk. If it
rejects, it sends the true block (`blockChange`) and/or an `inventory` snapshot back, which overwrites the
prediction.

Host validation already in place: reach (5 + 1.5 slack, from the eye), minimum dig time in survival (70% of
`breakTime`), the held stack must contain a placeable block, the target must be replaceable, a placed block
must touch something, it can't overlap a player, plants need solid ground, creative-only inventory actions.
Stage 4 added: movement speed limit, chat rate-limit, name checks, timeouts. Fall damage still derives
from client-reported positions (bounded by the speed check).

### Extensions (stage 6)
- **Block texture variants**: `BlockDef.texFn(state, dir)` + `extraTex` (crop stages, wire on/off,
  pusher front by direction, farmland wet/dry, gates on/off). Cross-shaped plants use `faceLayer` too.
- **Farming**: shovel + right-click on grass/dirt → farmland (wet with water within 4 blocks, dries back
  to dirt without a crop). Seeds (12% from tall grass, also from harvests) → Sunwheat, 8 stages via random
  ticks (faster when wet). Spore powder = fertiliser (+2–4 stages). 3 sunwheat → bread; 1 → 2 seeds.
- **Glow power** (`server/power.ts`, host only): glowwire = item "lumen dust" (lumen crystals now drop 2–4;
  4 dust → crystal). Strength 15, −1 per wire block (same level, 4 directions). Sources: lever, pressure
  plate (players/creatures standing on it), power crystal. Relay (back → front, 2-tick delay, restores 15),
  inverter (front on while back off; 2 ticks). Consumers: glow lamp (LAMP ↔ LAMP_ON), pusher (pushes up to
  12 blocks the way it faces, `state & 7` = mesher dir, bit 3 extended, head block in front; can't move
  corerock, rifts, doors, containers), doors (follow the signal only when the signal changes, so a door
  opened by hand stays open). Any `setBlockAndBroadcast` next to a power block triggers
  `PowerGrid.update`; gate ticks are scheduled in `GameServer.scheduled`.
- **Runes** (`shared/items/runes.ts`): rune table window (tool + rune + lumen dust → upgraded tool, cost
  4 × level, max level 3). Swiftness (+30% mining speed/level), keenness (+1 damage/level, swords/axes),
  endurance (wear chance 1/(level+1)), bounty (ores & crops +0..level extra). Stored as
  `ItemStack.runes = [swift, keen, endure, bounty]`. Rune stones: shapeless cut stone + ember shard + lumen
  dust + gold ingot / iron ingot / diamond / spore powder.
- **Ember Deep** (`shared/world/dimensions.ts`): same coordinate space, x ≥ 500,000 (origin 1,000,000).
  Corerock floor (y 0) and ceiling (y 127), ashstone caverns (3D noise), magma lakes at y ≤ 24 (burns
  3 every 0.5 s, you swim slowly), emberstone (light 10), ember ore (stone pickaxe+ → ember shards),
  lumen crystals on ceilings. Client: red fog, no sky, min light 0.16, "deep" music mood. No sleeping.
- **Rifts**: rift stone (crafted with a diamond and 4 lumen crystals) + a lumen crystal on each diagonal
  corner + right-click with lumen dust → 2-high rift. Standing in it for 2 s moves you to x ± 1,000,000
  (1:1); the host loads the destination (`ServerWorld.ensureChunk`), reuses a rift within 6 blocks or
  builds a lit return altar, then teleports.
- **Settlements** (`server/worldgen/settlements.ts`): one possible per 192×192 cell (50%) in plains/forest/
  desert/snow; 3–5 houses (style by biome) with door, windows, bedroll, workbench, torch and a loot chest,
  a well, a 5×5 field and gravel paths. Pure functions of the seed; each chunk builds its own part in the
  worker (loot chests travel back as `GenResult.blockEntities`). Traders (farmer / smith / mystic,
  `shared/entities/trades.ts`) spawn when the centre chunk loads, stay within 10 blocks of home, never
  distance-despawn; right-click → `trades`, click an offer → `trade` (host checks items). Currency:
  lumen dust.
- **Sound & music** (`client/audio/AudioEngine.ts`): everything synthesized (noise bursts by material,
  oscillator sweeps), positional (distance gain + stereo pan). Own actions sound immediately; the host's
  echo of them is skipped (`predicted` map). Generative pentatonic pieces every few minutes; mood = day /
  night / deep. Audio unlocks on the "resume" click.
- **Settings** (`client/settings.ts`, localStorage `cubica.settings`): view distance 2–12 (per player on
  the host via `settings` message), FOV, mouse sensitivity, sound and music volume. From the main menu and
  the pause menu; applied live.

### Creatures (stage 5)
- Original creatures (`shared/entities/mobs.ts`), not 1:1 equivalents of another game's mobs:
  - Passive: Grazer צמרן (fleece + meat), Tuskling חטון (meat), Stiltfowl רגלון (meat), Hornox קרנוף
    (hide + meat). Wander; flee when hit.
  - Hostile: Gloomwalker הולך-אפלה (melee 3, burns in direct sunlight, drops gloom ash = fuel),
    Thornslinger קוצן (keeps 5–10 blocks away, shoots arcing thorns, drops sticks), Skitterling זחלן
    (fast, climbs walls, drops silk), Sporecap פטריון (puffs for 1.5 s, then a spore cloud: up to 7
    damage within 4 blocks; it does NOT explode or break blocks; drops spore powder: 4 → lumen crystal).
- Host simulation in `MobManager` (20 TPS): bodies reuse `PlayerBody`; A* (`pathfind.ts`, 300 nodes,
  partial paths when unreachable, closed doors block, climbers path up walls); targets the nearest
  survival player within 16 blocks; creative players are ignored.
- Spawning (once a second, `spawnTick`): hostiles in a 24–44 block ring where max(block light,
  sky light × daylight) ≤ 7 (night surface or caves), cap 10 per player / 30 total; passive herds of 2–3
  on grass with sky light ≥ 9, cap 8 per player / 24. Despawn beyond 80 blocks (hostiles also randomly
  beyond 40). Creatures are not saved (they respawn naturally).
- Combat: left-click a creature (client ray vs. boxes, takes priority over the block behind it).
  Damage: hand 1, sword = tier damage (4–7), axe = damage − 1, other tools 2; 0.4 s cooldown (host checks
  70%), reach 4 (+1.5 slack). Hits knock back and give 0.5 s invulnerability. Creatures hurting a
  player send `knockback`; players get 0.5 s invulnerability against creatures.
- Sync: `entitySpawn` (kind 'mob' / 'projectile'), `mobMove` 10 Hz [id,x,y,z,yaw,anim], `entityEvent`
  (hurt/death/spores), `entityDespawn`. Thorns are extrapolated on the client from their launch velocity.
- New items: raw/cooked meat, fleece, hide, silk (all three also work as the bedroll's soft row),
  gloom ash (fuel 800), spore powder.
- Host commands: `/summon <grazer|tuskling|stiltfowl|hornox|gloomwalker|thornslinger|skitterling|sporecap>`,
  `/time day|night`. Can't sleep with hostiles within 10 blocks.
- Testing note: when the desktop app's browser pane is hidden it stops requestAnimationFrame; drive
  frames with `setInterval(() => client.frame(performance.now()), 16)` during browser checks.

### Multiplayer (stage 4)
- Host: pause menu → "פתח לחברים" → `HostNetwork.open()` registers peer id `cubica-v1-<CODE>` on the free
  public PeerJS signalling server (0.peerjs.com) with free STUN (Google, Cloudflare). Invite code
  `XXXX-XXXX` (alphabet without 0/O/1/I/L) and link `?join=CODE`. Each incoming connection becomes a
  `PeerTransport` handed to `GameServer.addConnection`. No TURN server: symmetric NATs (some mobile or
  corporate networks) can't connect, and the timeout message says so.
- Joining: main menu "הצטרף לחבר" (or opening the invite link) → `joinHost(code)` → `GameSession.remote`
  (client only, no IndexedDB writes; the world lives at the host). 20 s timeout with a readable reason.
- Wire format: `encodeMessage`: byte 0 = 0 JSON, 1 = chunk (varint cx/cz + chunkCodec bytes).
  `fragment`: 16 KB frames, reassembled in order, 2 MB cap. Host skips chunk streaming while the
  data channel backlog > 512 KB.
- Sync: `playerJoin`/`playerLeave`, `snapshot` of other players at 10 Hz (pos, yaw, pitch, anim flags
  sneak/swing/flying), rendered 120 ms behind with interpolation. Blocks/items/containers were already
  host-authoritative and broadcast to everyone holding the chunk.
- Chat (T, or / for commands): host strips control chars, 200 chars max, 5 messages per 5 s.
  Commands: `/help`, `/list`, `/kick name` (host only).
- Tab: player list with ping (host pings every 2 s; list every 5 s and on join/leave).
- Validation added: names (`sanitizeName`: 1–16 letters/digits/space/_/-, unique per world), movement
  speed (8 b/s on foot, 24 flying, +1.5 slack per message; otherwise teleport back), moves ignored after
  a teleport until the client reports the new position, client silence > 30 s → dropped; client side,
  host silence > 20 s → disconnected screen. Host leaving sends `kick` "המארח סגר את העולם".
- The host's player name comes from the main menu (stored in localStorage `cubica.name`); old saves
  keyed "Player" are taken over by the host's name.
- Testing note: the Claude desktop app's built-in browser blocks WebRTC entirely (even an in-page
  RTCPeerConnection loopback stays at ICE "new"), so real P2P must be tested in Chrome/Edge/Firefox/
  Safari. Signalling via 0.peerjs.com was verified from the built-in browser (offer/answer exchanged).

### Survival (stage 3)
- Stats live on the host (`PlayerSession`): health 20, food 20 + saturation + exhaustion (walking/sprinting/
  jumping/mining/regeneration), air 300 ticks. Fall damage = fall height − 3 (computed by the host from
  move messages with the ON_GROUND flag). Drowning: 2 damage per second without air. Starving stops at 1 hp.
  Regeneration when food ≥ 18. Creative ignores all of it.
- Death: the whole inventory spills as item entities, `death` message → death screen → `respawn` →
  bedroll (if it still exists) or world spawn.
- Item entities (`ItemEntities`): host physics, pickup within 1.5 blocks, merging, despawn after 5 min.
  All drops (mining, death, Q, closing a window with leftovers) go through them. Not saved yet: items
  lying on the ground vanish when their chunk unloads or the world closes.
- Windows: window 0 = own inventory with a 2×2 grid; containers get an incrementing id. The client
  predicts with the same `ContainerWindow` code; the host answers with `inventory` + `window` snapshots.
  Chests/furnaces share one slot array between all viewers. Closing returns grid/cursor items.
- Furnace: 200 ticks per item, fuel in ticks (coal 1600, wood 300, stick 100). Lit furnaces switch to
  FURNACE_LIT (light 13). Active furnaces are tracked in `GameServer.furnaces`.
- Tools: 5 tiers (wood/stone/iron/gold/diamond) × pickaxe/axe/shovel/sword. Original two-step crafting:
  material in a head shape → head; head + 2 sticks (shapeless) → tool. Head shapes: pickaxe `MMM`,
  axe L of 3, shovel `MM`, sword blade vertical `M/M`. Pickaxe tier gates drops (stone/coal ≥ wood,
  iron ≥ stone, gold/diamond ≥ iron). Durability −1 per block (sword −2).
- Other recipes: log → 4 planks, plank → 2 sticks, 2×2 planks → workbench, ring of rubblestone →
  furnace, ring of planks → chest, coal over stick → 4 torches, 3 leaves over 3 planks → bedroll,
  2×3 planks → 3 doors, 2×2 stone → 4 cut stone. Smelting: raw iron/gold → ingots, sand → glass,
  rubblestone → stone, ashfruit → baked, logs → coal.
- Food: ashfruit (6% from ashwood leaves), frostberries (5% from frostpine needles), baked ashfruit.
  Eating = hold right-click 1.6 s (host checks ≥70% of that).
- Bedroll: right-click sets the respawn point; at night, when every living player has used one within
  3 s, the night is skipped.
- Random ticks (3 per 16-high section per tick): saplings grow into trees (shared `trees.ts`), grass
  spreads to lit dirt, grass under an opaque block turns to dirt.
- Support rules (`isSupported`): plants/saplings/cactus/torches/doors pop off with a drop when what holds
  them is removed (host cascades; client predicts the same).
- Client applies `chunk`, `blockChange` and `unloadChunk` through one ordered queue (a change for a chunk
  still waiting to be decoded used to get lost).

### Gameplay (stage 2)
- Physics `PlayerBody` (blocks/seconds, fixed 60 Hz step): walk 4.3, sprint 5.6, sneak 1.3 (no walking off
  edges), jump ≈1.26 blocks, swimming with drag, creative flight (double-tap Space). Unloaded chunks count
  as solid so nobody falls through the world while it streams in.
- Mining: `breakTime = hardness × 1.5`, ×10/3 without a pickaxe on blocks that want one, ÷ tool speed with
  the right tool (tools arrive in stage 3). Creative breaks instantly (0.2 s repeat).
- Game mode is per player (saved with the player). The world's mode is the default for new players.
- Saving: only changed chunks are stored; untouched ones regenerate from the seed. Autosave every 30 s,
  on tab hide and on "save and quit". Chunks unloaded before their save finishes stay in memory (`evicted`).
  Players are saved by name (single player: "Player").
- `.cubica` file: magic `CUBICAW1` + JSON header (WorldMeta) + length-prefixed chunks.

## Stages and status

Each stage ends in a runnable state, a commit, and an update to this file. **Do not start the next stage
before the user has approved the current one.**

1. ✅ **Engine and world**: infinite world from a seed, 16×16×256 chunks, 8 biomes, caves, ores, trees,
   water, corerock, greedy meshing, frustum culling, sky + block lighting, day/night, fog, workers, F3
   overlay. Temporary control: free flight (WASD, Space/Shift, Ctrl for speed).
2. ✅ **Player and interaction**: AABB physics (gravity, jump, sprint, sneak, swim), DDA raycast, mining
   by hardness/tool, block placement, 9-slot hotbar, inventory (E), Creative, IndexedDB save + `.cubica`
   export/import, main menu (new / load / join), pause menu. "Join" is a placeholder until stage 4.
   Building blocks added: planks ×2, rubblestone, glass, cut stone.
3. ✅ **Survival**: health, hunger, fall damage, drowning, death/respawn, 2×2/3×3 crafting with our own
   recipes, 5 tool tiers with durability, furnace, chests, bedroll, torches, doors, food, drop tables,
   dropped items, saplings that grow.
4. ✅ **P2P multiplayer**: "Open to friends" → code/link `?join=CODE`, PeerJS + public STUN, chunk sync,
   players, blocks, entities, chat (T), player list (Tab), host validation, disconnect handling, up to 8
   players, clear error messages when a connection fails (including symmetric NAT without TURN).
5. ✅ **Creatures**: original passive and hostile creatures (no creeper equivalent), light-based spawning,
   A*, combat with knockback.
6. ✅ **Extensions**: our own signal/power system, an original dimension with its own portal ritual, rune
   upgrades, farming, settlements with traders, Web Audio sounds and music, settings screen (view distance,
   FOV, sensitivity).
7. ✅ **Publishing**: GitHub Actions → GitHub Pages on every push, with a permanent link.

### Publishing (stage 7)
- Live: **https://playcubica.github.io/**. Repo: https://github.com/playcubica/playcubica.github.io
  (public, in the free GitHub organization `playcubica`, owned by idoszmail-crypto; Pages source =
  "GitHub Actions"). It moved there from idoszmail-crypto/cubica; the old Pages URL no longer serves.
- `.github/workflows/deploy.yml`: on every push to `main` → `npm ci`, `npm test`, `npm run build`, upload
  `dist/`, `deploy-pages`. A failing test blocks the deploy. `gh run list -R playcubica/playcubica.github.io` shows runs.
- `gh` is installed locally at `~/.local/gh/bin/gh` (logged in as idoszmail-crypto with the `workflow` scope;
  pushing files under `.github/workflows` needs that scope).
- `base: './'` keeps the build path-agnostic. Check a production build under a sub-path with the
  `cubica-dist` preview config (`vite preview --base /cubica/`, port 4173).
- Invite links use the page's own URL, so `?join=CODE` links point at the live site when the host plays there.

### Accounts and cloud saves (after stage 7)
- Optional Google sign-in via Firebase (project `playcubica`, config in `src/cloud/firebaseConfig.ts`;
  the values are public). Firebase is loaded lazily (`import('firebase/...')`): on "sign in", or at startup
  when localStorage `cubica.signedIn` says this browser was signed in. `null` config hides it all.
- `src/cloud/account.ts` (`Account`: popup sign-in, sign-out, `idToken()`), `cloudWorlds.ts`
  (`FirestoreWorlds` + `SyncedStore`), `verifyToken.ts` (RS256 JWT check with WebCrypto against Google's JWKs).
- Cloud saves (Firestore, rules in `firestore.rules`, pasted in the Firebase console):
  `users/{uid}/worlds/{id}` = `{ meta: JSON string, updatedAt }`, chunks in `.../chunks/{cx}_{cz}` = `{ d: Bytes }`.
  IndexedDB stays the working copy. `SyncedStore` wraps the local ChunkStore: first push of a session uploads
  every saved chunk, then only changed ones, at most once a minute (on `saveMeta`), on tab hide and on exit.
  The load menu merges local and cloud lists; a newer (or cloud-only) copy is downloaded into IndexedDB
  (`replaceWorld`) before playing. Same world on two devices at once: last writer wins per chunk.
- Identity in multiplayer: `hello.token` = Firebase ID token; the host checks it (`ServerOptions.verifyAccount`)
  and keys the player's save as `g:<uid>` (a guest save under the same name is taken over). A failed check
  means "guest" with a chat note; the same account twice is kicked. Verified players get ✓ in the Tab list.
  The host's own account is passed in-page (`addConnection({ host, account })`). Emails are never sent to
  other players.
- Free tier limits (Spark): Firestore 50k reads / 20k writes per day; a push is (changed chunks + 1) writes.
- The built-in browser blocks the sign-in popup for automated clicks; real logins need the user.

### Game controllers
- `client/input/Gamepad.ts`: one `gamepad` (Gamepad API, standard mapping) polled in its own rAF loop;
  listeners get a `PadFrame` (held/pressed/released, sticks with radial deadzone, `nav` with key repeat).
  Bluetooth/USB controllers paired with the OS appear after a button press on the page. `gamepad.active`
  = used in the last 2 s; `Controls.lock()` then skips Pointer Lock (a pad press is no user gesture) and
  goes straight to free-mouse mode without the mouse hint.
- In play (`GameClient.padFrame`) the pad drives the same paths as keyboard/mouse via
  `Controls.padKey/padButton/padLook/padMove` (kept in separate sets so a real mouse-up can't release them):
  LS move (analog, L3 toggles sprint), RS look (quadratic), A jump, B sneak, RT mine/attack, LT place/use,
  LB/RB and D-pad ←/→ hotbar, Y inventory, X drop, D-pad ↑ pick block, View list, Menu pause.
  The first frame after leaving a menu is ignored so the press that resumed doesn't pause again.
- In windows (`padWindow`) the left stick (or D-pad, one slot per step) moves `.pad-pointer`, which
  dispatches mousemove/mousedown/click at that point: A click, X right-click, RB/LB shift-click, B/Y close.
- Menus (`App.padMenu`): up/down moves `.pad-focus` over visible buttons/sliders/file labels, A clicks,
  left/right steps sliders, B = back/resume, Menu = resume/respawn. The pause menu shows the controller
  layout instead of the keyboard one while a controller is connected.
- Testing without hardware: override `navigator.getGamepads` with a fake standard pad and call
  `gamepad.poll(performance.now())` (import `/src/client/input/Gamepad.ts` in the dev page).

### Stage 1 notes
- Per-chunk performance (M-series, Node): generation ~1.6 ms, lighting ~1.2 ms, meshing ~4.7 ms. 60 FPS at
  view distance 8 (~300 chunks, ~100–200 draw calls).
- The `pending` count in F3 includes edge chunks that are waiting for neighbours (normal).
