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
npm run dev        # http://localhost:5173  (?seed=<text|number>&vd=<2..16>)
npm test           # vitest
npm run build      # tsc --noEmit + vite build -> dist/
```

In the Claude desktop app: preview server named `cubica` (defined in `/Users/idos/אתר/.claude/launch.json`).
In the browser console, `window.cubica = { server, client }` is handy for debugging.

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
  main.ts                 boot (stage 1: straight into single player)
  shared/                 pure code (no DOM), used by server, client and workers
    constants.ts rng.ts noise/simplex.ts
    blocks/registry.ts    block definitions + lookup tables (OPAQUE, LIGHT_*, TEX_*) + TEXTURE_NAMES
    world/Chunk.ts chunkCodec.ts lighting.ts biomes.ts
    mesh/mesher.ts        greedy mesher (padded 18×18×H volume)
    protocol/messages.ts  ClientMsg / ServerMsg
  server/ GameServer.ts ServerWorld.ts WorkerChunkGenerator.ts worldgen/WorldGenerator.ts
  client/ GameClient.ts ClientWorld.ts render/ textures/ input/ ui/
  net/    Transport.ts LocalTransport.ts
  workers/ WorkerPool.ts worldgen.worker.ts mesher.worker.ts types.ts
tests/    vitest (noise, worldgen, codec, lighting, mesher)
```

### Chunk data model
- 16×16×256. Index `x | z<<4 | y<<8` (horizontal layers are contiguous).
- `blocks: Uint16Array`: 12-bit id + 4-bit state. `light: Uint8Array`: high nibble sky, low nibble block.
- `heightmap` (highest non-air block per column), `biomes` (per column), `maxY`.
- `chunkCodec`: version + cx/cz + topY + RLE(varint) of blocks and light up to `maxY+16`. Used for both
  network and saves. A typical chunk is a few KB.

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
See `src/shared/protocol/messages.ts`. Implemented so far: `hello`, `welcome`, `move`, `chunk`,
`unloadChunk`, `time`, `kick`. The rest are reserved with the stage they arrive in noted.
Validation on the host (stage 4): reach ≤ 6, minimum dig time, speed limit, no placing a block inside a
player, the item must be held, chat rate-limit.

## Stages and status

Each stage ends in a runnable state, a commit, and an update to this file. **Do not start the next stage
before the user has approved the current one.**

1. ✅ **Engine and world**: infinite world from a seed, 16×16×256 chunks, 8 biomes, caves, ores, trees,
   water, corerock, greedy meshing, frustum culling, sky + block lighting, day/night, fog, workers, F3
   overlay. Temporary control: free flight (WASD, Space/Shift, Ctrl for speed).
2. ⏳ **Player and interaction**: AABB physics (gravity, jump, sprint, sneak, swim), DDA raycast, mining
   by hardness/tool, block placement, 9-slot hotbar, inventory (E), Creative, IndexedDB save + `.cubica`
   export/import, main menu (new / load / join).
3. ⏳ **Survival**: health, hunger, fall damage, drowning, death/respawn, 2×2/3×3 crafting with our own
   recipes, 5 tool tiers with durability, furnace, chests, bed, torches, doors, food, drop tables.
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
