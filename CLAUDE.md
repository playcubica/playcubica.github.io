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
Automated browsers can't get Pointer Lock: to test, set `client.state = 'playing'` and drive
`client.controls.down` / `client.controls.buttons` / `client.interaction.mouseDown(2)` from JS.

## Architecture

**Server and client are separated from day one.** Single player is "a host with one player".

- `GameServer` (src/server) is the authority: world, 20 TPS tick, chunk streaming, action validation,
  saving. It never touches the DOM or three.js.
- `GameClient` (src/client) handles rendering, input, (future) movement prediction, and UI.
- They talk only through `Transport` (src/net) and the messages in `src/shared/protocol/messages.ts`.
  - Single player and the host's own client: `LocalTransport` (in memory, asynchronous).
  - Stage 4: `PeerTransport` (PeerJS DataConnection, `serialization: 'binary'`) for each friend.
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
    physics/              PlayerBody (fixed-step movement), collision (AABB sweep), raycast (DDA)
    protocol/messages.ts  ClientMsg / ServerMsg
  server/ GameServer.ts ServerWorld.ts WorkerChunkGenerator.ts PlayerSession.ts ItemEntities.ts
          worldgen/WorldGenerator.ts worldgen/trees.ts (shared by worldgen and sapling growth)
          storage/WorldStorage.ts   IndexedDB worlds + .cubica export/import
  client/ GameClient.ts ClientWorld.ts render/ textures/ input/ ui/ player/LocalPlayer.ts
          interaction/BlockInteraction.ts   targeting, mining progress + cracks, placing, pick block
          ui/Hud.ts (hotbar, hearts/food/air, messages) WindowScreen.ts (all container UIs) icons.ts
          render/EntityRenderer.ts (dropped items as sprites)  textures/itemTextures.ts (item sprites)
  net/    Transport.ts LocalTransport.ts
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
Still to come in stage 4: movement speed limit (fall damage currently trusts the client's positions),
chat rate-limit.

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
4. ⏳ **P2P multiplayer**: "Open to friends" → code/link `?join=CODE`, PeerJS + public STUN, chunk sync,
   players, blocks, entities, chat (T), player list (Tab), host validation, disconnect handling, up to 8
   players, clear error messages when a connection fails (including symmetric NAT without TURN).
5. ⏳ **Creatures**: original passive and hostile creatures (no creeper equivalent), light-based spawning,
   A*, combat with knockback.
6. ⏳ **Extensions**: our own signal/power system, an original dimension with its own portal ritual, rune
   upgrades, farming, settlements with traders, Web Audio sounds and music, settings screen (view distance,
   FOV, sensitivity).
7. ⏳ **Publishing**: GitHub Actions → GitHub Pages on every push, with a permanent link.

### Stage 1 notes
- Per-chunk performance (M-series, Node): generation ~1.6 ms, lighting ~1.2 ms, meshing ~4.7 ms. 60 FPS at
  view distance 8 (~300 chunks, ~100–200 draw calls).
- The `pending` count in F3 includes edge chunks that are waiting for neighbours (normal).
