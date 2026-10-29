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
  the host via `settings` message), FOV, mouse sensitivity, sound and music volume. Plus `showDebug`
  (the F3 panel; hidden by default, F3 flips and saves it). From the main menu and
  the pause menu; applied live.

### Creatures (stage 5, animals reworked after stage 7)
- Status per creature, and what's next: **`docs/creatures.md`** (keep it current).
- `shared/entities/mobs.ts`: monsters are our own designs; animals are real species in our own style:
  - Animals (ids kept from the old ones: 1 sheep, 2 pig, 3 chicken, 4 cow; new 5 horse, 6 wolf, 7 cat,
    8 rabbit, 9 fox, 15 goat). `MobDef.animal` (food, tame, shear, milk, eggs, ride, prey, nocturnal,
    hops, rams), `habitat` (biomes, ground blocks, group, weight), `variant(biome, rnd)`, `retaliates`.
  - `MobFlag` (BABY, SHEARED, TAMED, SITTING, SADDLED, RIDDEN, ANGRY, LOVE) travel in `EntityInfo.flags`
    and `mobState`; `MobAnim` (ATTACK, FUSE, FLEE, EAT, SLEEP, RAM) in mobMove.
  - Host (`MobManager`): breeding (`LOVE_TICKS` 600, partner within 8 → baby between them, parents'
    cooldown 6000; pets/horses only when tamed; wolf/cat babies keep the owner), babies grow in
    `GROW_TICKS` 24000 (feeding −10%), body/hit box × `BABY_SCALE`; tempting (food in hand within 10);
    sheep graze (grass → dirt, regrow fleece); eggs every 6000–12000 ticks; wolves: pack anger, tamed
    ones follow (walk > 6, teleport > 14), sit toggle, defend the owner (`ownerHurt`) and join the
    owner's attacks (`ownerAttacks`); foxes sleep by day and hunt chickens/rabbits at night; goats ram;
    rabbits hop; shy animals flee non-sneaking players. `interact()` returns what happens to the hand
    (consume / replace / give / ride / none); `GameServer.interact` applies it to the real inventory.
  - Riding: right-click a horse (not a baby). Untamed: the rider can't steer; after 2–5 s it's tamed with
    chance temper % (feeding +5, each throw-off +5) or throws them. Tamed + saddled → `ride` message
    with steer, speed 8.5, jump 10.5; the rider's client moves (body gets the horse's size, eye 2.3,
    auto-step), the host checks speed (14 b/s) and `carry`s the horse along; `dismount` (Shift), death,
    disconnect and rifts get you off. Others see the rider seated (`Anim.RIDING`).
  - Saving: animals are kept. On chunk unload they go to `GameServer.dormant` (by chunk key) and come
    back when the chunk loads; `save()` writes `meta.creatures` = dormant + loaded (`SavedMob`, only
    `SAVED_FLAGS`). Cats are placed once per settlement (`meta.catsAt`). Monsters/traders aren't saved.
  - Natural animals: by biome (`trySpawnAnimals`) in the 24–44 ring on their ground with sky light ≥ 9,
    while fewer than 10 animals are within 48 blocks (250 loaded max); 8% babies.
  - Items: raw/cooked fowl, egg → fried egg, feather, bucket (I_I/_I_), milk bucket (drink, bucket back),
    saddle (HHH/HIH hide + iron), shears (_I/I_).
- Looks (`client/render/mobModels.ts`): each animal has a builder (cuboids on named bones with pivots and
  resting rotations; `quad()` frames four-legged ones; features, variants and designed baby proportions)
  and an animator (walk cycles by speed, grazing, glances, sit/sleep poses, wag, wing flaps, hops,
  gallop, ram). Skins: colour + `Pattern` (+ patches, shaggy, stripes) + pixel details on the front
  (`face`) or sides (`side`). Monsters/traders keep role-tagged box lists (`partsRig`).
- Dev gallery: `gallery.html` (dev server only, not built): every creature, variant, flags, animation,
  front/side/back/quarter views, player-size frame and hit box. Host commands: `/summon <kind> [baby]
  [variant] [count]`, `/mobinfo` (nearest creature's state), `/grow` (nearby babies grow, cooldowns end).
- Monsters:
  - Hostile: Gloomwalker הולך-אפלה (melee 3, burns in direct sunlight, drops gloom ash = fuel),
    Thornslinger קוצן (keeps 5–10 blocks away, shoots arcing thorns, drops sticks), Skitterling זחלן
    (fast, climbs walls, drops silk), Sporecap פטריון (puffs for 1.5 s, then a spore cloud: up to 7
    damage within 4 blocks; it does NOT explode or break blocks; drops spore powder: 4 → lumen crystal).
- Host simulation in `MobManager` (20 TPS): bodies reuse `PlayerBody`; A* (`pathfind.ts`, 300 nodes,
  partial paths when unreachable, closed doors block, climbers path up walls); targets the nearest
  survival player within its `followRange` (16, gloomwalkers 32); creative players are ignored.
- Spawning (once a second, `spawnTick`): hostiles in a 24–44 block ring where max(block light,
  sky light × daylight) ≤ 7, on an opaque floor (never leaves/glass). While the player is on the surface
  75% of attempts use the surface (so the cap isn't spent on caves far below), otherwise any floor within
  ±20 of their height. Kinds by `spawnWeight` (`pickSpawnKind`): gloomwalkers 4, the rest 2; gloomwalkers
  come in groups of 2–4 and notice players within 32 blocks (`followRange`, others 16). Cap 20 per player /
  50 total (groups are cut to fit). Animals: see above (by biome, saved). Monsters despawn beyond 80
  blocks (also randomly beyond 32) and are not saved. A night simulation on a real world gives ~10–14 gloomwalkers around a surface player.
- Looks (`MobRenderer`): box models in model pixels; each box gets a pixel-art skin (one texel per model
  pixel) painted from its colour + a `Pattern` (fur, fleece, cloth, rags, ribs, spots, feather, chitin,
  plain) and an optional bottom `band` (hooves, boots, cuffs). A model's skins share one canvas atlas;
  atlas + geometries are built once per kind/variant (`kits`) and shared.
- Combat: left-click a creature (client ray vs. boxes, takes priority over the block behind it).
  Damage: hand 1, sword = tier damage (4–7), axe = damage − 1, other tools 2; 0.4 s cooldown (host checks
  70%), reach 4 (+1.5 slack). Hits knock back and give 0.5 s invulnerability. Creatures hurting a
  player send `knockback`; players get 0.5 s invulnerability against creatures.
- Sync: `entitySpawn` (kind 'mob' / 'projectile'), `mobMove` 10 Hz [id,x,y,z,yaw,anim], `entityEvent`
  (hurt/death/spores), `entityDespawn`. Thorns are extrapolated on the client from their launch velocity.
- Items from creatures: raw/cooked meat and fowl, fleece, hide, feather, egg, silk (fleece/hide/silk also
  work as the bedroll's soft row), gloom ash (fuel 800), spore powder.
- Host commands: `/summon <grazer|tuskling|stiltfowl|hornox|gloomwalker|thornslinger|skitterling|sporecap>`,
  `/time day|night`. Can't sleep with hostiles within 10 blocks.
- Testing note: when the desktop app's browser pane is hidden it stops requestAnimationFrame; drive
  frames with `setInterval(() => client.frame(performance.now()), 16)` during browser checks.

### Multiplayer (stage 4)
- Each world keeps one invite code (`WorldMeta.inviteCode`, made the first time it's opened and saved with
  the world), so the code and link stay the same every time. `HostNetwork.open(code)` waits and retries
  (6 × 3 s) while the id is still held by a page that just closed; if it stays taken (the same world open
  elsewhere) the error says so and the pause menu offers "קוד חדש" (`openToFriends(true)` replaces it).
  Imported worlds get a fresh code. A world that has a code (or is shared) opens to friends by itself
  whenever it is hosted, so the code friends hold always works while someone plays it; concurrent opens
  share one promise (`GameSession.opening`), and the pause menu shows "opening…" meanwhile.
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
- **Every browser has an account**: on startup `Account.restore()` signs in anonymously (Firebase
  "Anonymous" provider) unless a session exists, so every player is a cloud member without signing up and
  every hosted world is a shared world. Google sign-in is optional: from an automatic account it uses
  `linkWithPopup` (same uid, worlds kept); if that Google account already exists it switches to it. Signing
  out of Google gives the browser a new automatic account. ✓ in the player list = Google only
  (`PlayerSession.google`, from the token's email). If the Anonymous provider is off, players stay guests
  and everything falls back to the Google-only behaviour below.
- "Play" re-reads the world's lock from the cloud first: if a friend started it meanwhile, it joins them.
- Optional Google sign-in via Firebase (project `playcubica`, config in `src/cloud/firebaseConfig.ts`;
  the values are public). Firebase is loaded lazily (`import('firebase/...')`): on "sign in", or at startup
  when localStorage `cubica.signedIn` says this browser was signed in. `null` config hides it all.
- `src/cloud/account.ts` (`Account`: popup sign-in, sign-out, `idToken()`), `cloudWorlds.ts`
  (`FirestoreWorlds` + `SyncedStore`), `verifyToken.ts` (RS256 JWT check with WebCrypto against Google's JWKs).
- Cloud saves = **shared worlds** (Firestore, rules in `firestore.rules`, pasted in the Firebase console):
  `worlds/{id}` = `{ meta: JSON string, updatedAt, owner, members: [uid], names: {uid: name},
  host: {uid, name, until} | null }`, chunks in `worlds/{id}/chunks/{cx}_{cz}` = `{ d: Bytes }`. Every friend
  who joins while signed in is added as a member (`ServerOptions.onAccountJoin` → `SyncedStore.addMember`,
  pushed at once), so the world appears in their "load world" list and any member can host it later (same
  fixed invite code). Rules: members read/update, only the owner (`WorldMeta.owner`, never changes) deletes;
  chunk writes are checked with `getAfter` because the world entry rides along in every batch. The host lock
  (`host`, renewed with each push, `HOST_LOCK_MS` = 3 min, cleared by the final flush on exit) makes the list
  show "🟢 X plays now" with a join button instead of a second copy being hosted. Shared worlds open to
  friends automatically. Non-owners "remove" (leave) instead of delete. Old personal saves under
  `users/{uid}/worlds` are still listed and move to `worlds/` on their next save.
- **Handover when the host leaves** (shared worlds only): with every player list the host sends
  `succession` (world id, open code, signed-in non-host players in join order). Leaving a shared world saves
  and flushes to the cloud (releasing the lock) *before* friends are disconnected. A client that loses its
  host (leave, or the 20 s watchdog after a crash) with a non-empty succession runs `App.carryOn`: the first
  in order downloads the world and hosts it (`play(..., { patient })` → `HostNetwork.open(code, patient)`
  waits up to ~75 s for the old page's peer id), everyone else retries joining the same code for about a
  minute. Guests reconnect but can't take over (they aren't members).
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

### Block behaviour closer to the genre (after stage 7)
Reference values come from the genre's well-known mechanics (researched on the public wiki); textures, names
and art stay our own.
- **Bed (bedroll)**: two blocks. State bits 0-1 facing (head points that way), `BED_HEAD` 4, `BED_PAIRED` 8
  (older one-block bedrolls have no PAIRED bit and keep working). `placementRaw` gives the foot; host and
  client place the head at `bedPartner()`; both halves need solid ground. `isSupported` requires the matching
  partner, so breaking either half pops the other; only the foot drops the item. Looks: legs at the outer end of each
  half (3 px), mattress 3–9 px, a raised pillow (9–11 px) on the head half (`bedShape`); collision stays
  one 9/16 box. Sleep: within 3 blocks, no hostiles within 8 horizontal / 5 vertical. Landing on it bounces (0.66 of impact, not when
  sneaking; `PlayerBody.bounced` → `MoveFlag.BOUNCED`) and the host counts half the fall.
- **Cactus**: box 14/16 wide, collision 15/16 high (`BlockDef.collision`). Touching the cell → 1 damage
  every 10 ticks to players and creatures (`tickCactus`, `MobManager.hurtWhere`); dropped items touching it are
  destroyed. Needs sand/cactus below and nothing solid beside it. Grows like the genre: age in state 0-15
  (stored without broadcasting), +1 block at 16, max 3 tall.
- **Change queue**: every `setBlockAndBroadcast` adds the cell to `updates`; `processUpdates` (once per tick,
  ≤4096 cells) looks at each cell and its six neighbours: pops unsupported blocks (with drops), starts
  sand/gravel falling, schedules water, schedules leaf-decay checks.
- **Falling blocks** (`server/FallingBlocks.ts`): entity kind `'block'` (raw), 0.04 b/tick² with 0.98 drag;
  lands on the first solid cell; turns into the block if the landing cell is replaceable (plants drop), else
  drops as an item. Client draws a textured cube (`EntityRenderer.spawnBlock`, `tileCanvas`).
- **Leaf decay**: natural leaves (state 0) near a change get a check 1–11 s later; no log within 6 steps
  through leaves → they decay with their normal drops (+2% stick). Placed leaves carry `LEAVES_PLACED`.
- **Flowing water** (`shared/world/fluid.ts` + `server/water.ts`): state 0 source, 1–7 flowing, bit 3
  falling. Checks run `FLOW_DELAY` = 5 ticks after a neighbour changes (≤2000 a tick). Falls first; only
  sources spread sideways from on top of water; sideways spread goes towards the nearest way down within 4
  (water below counts as a way down), up to 7 from a source or a waterfall's landing spot. Two sources on
  solid ground (or above a source) make a new source. Plants wash away. Worldgen water is all sources and
  stays still until disturbed; random ticks re-check leftover flowing water. The current (`waterFlow`)
  pushes bodies at 1.4 b/s, falling water pushes down. Mesher: liquids per cell with corner heights averaged
  over the four cells sharing the corner (sources weigh 10×), sides only towards open cells.

### Stage 1 notes
- Per-chunk performance (M-series, Node): generation ~1.6 ms, lighting ~1.2 ms, meshing ~4.7 ms. 60 FPS at
  view distance 8 (~300 chunks, ~100–200 draw calls).
- The `pending` count in F3 includes edge chunks that are waiting for neighbours (normal).
