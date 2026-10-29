# Creatures – implementation status

Animals are real-world species drawn in Cubica's own style (own models, textures, colours, sounds);
monsters are Cubica's own designs. "Done" means: dedicated model (rig + skin), variants and baby
form where they apply, animations driven by real state, AI, spawning, interactions through the real
inventory/host code, multiplayer sync, saving, and automated tests. Inspect them in the dev gallery
(`npm run dev` → http://localhost:5173/gallery.html) or in game with `/summon <kind> [baby] [variant] [count]`,
`/mobinfo`, `/grow`.

## Stage A – farm animals and pets (done)

| Creature | Model / variants / baby | Behaviour | Interactions | Spawns |
|---|---|---|---|---|
| Cow פרה | rig; 3 (black-and-white, shaggy red highland, humped zebu); calf | graze anim, follows sunwheat | breed, milk (bucket), drops hide + meat | plains, forest, mountains |
| Sheep כבשה | rig; 6 fleece colours; sheared look; lamb | eats grass (grass → dirt) and regrows fleece | shear (shears), breed | plains, forest, mountains, snow |
| Pig חזיר | rig; 3 (pink, woolly brown, black belted); piglet | follows ashfruit/berries/sunwheat | breed | plains, forest, snow |
| Chicken תרנגולת | rig; 3 (white, barred grey, red); chick | flutters down slowly, pecks, wings flap | eggs every 5–10 min, breed with seeds; drops raw fowl + feathers | plains, forest |
| Horse סוס | rig with neck; 6 coats × 4 markings; foal | grazes, gallops when ridden | tame by riding (temper), saddle, ride + steer + jump, breed (mixed coat) | plains |
| Wolf זאב | rig; 3 (grey, snow, dark); angry eyes; collar; pup | pack retaliation; tamed: follow, sit, teleport to owner, defend owner, attack owner's target | tame with raw meat (⅓), sit toggle, breed when tamed | forest, snow |
| Cat חתול | rig; 6 coats (tabbies, black, white, calico, pointed); collar; kitten | shy when wild; tamed: follow, sit | tame with raw fowl (⅓), sit toggle | settlements (1–2 per settlement, once) |
| Rabbit ארנב | rig; 4 (brown, white, gold, spotted); kit | hops, flees people | breed | plains, desert (sand), snow, forest |
| Fox שועל | rig; 2 (red, arctic); kit | sleeps by day (curled), wakes if approached; hunts chickens/rabbits at night | breed with berries | forest, snow |
| Goat עז | rig; 2 (white, alpine); kid | rams players now and then (charge + knockback), high jump | milk, breed | mountains, snow |

Shared systems: per-species rigs and animators (`client/render/mobModels.ts`), skins/atlas renderer
(`client/render/MobRenderer.ts`), host AI (`server/mobs/MobManager.ts`), saving by chunk
(`WorldMeta.creatures`), `mobState` / `ride` / `dismount` messages, synthesized voices.

## Stage B – monster ecosystem (done)

All monsters are Cubica's own designs, each with its own rig (`client/render/monsterModels.ts`), skin,
animations, sounds, AI (`server/mobs/MobManager.ts`) and spawn zone (`MobDef.zones`).

| Monster | Role | Look | Behaviour | Weakness | Appears |
|---|---|---|---|---|---|
| Gloomwalker הולך-אפלה | ground melee | ragged hooded figure, reaching arms, burning eyes | groups of 2–4, chases from 32 blocks | burns in sunlight | surface/caves at night (most common) |
| Thornslinger קוצן | ranged | walking cactus bulb with a maw and a flower | keeps 5–10 blocks away, arcing thorns | slow | surface/caves |
| Skitterling זחלן | fast climber | low eight-legged crawler, 4 red eyes | climbs walls | low health | surface/caves |
| Sporecap פטריון | area damage | walking toadstool, glowing spots | cap swells, spore cloud (no block damage) | must get close | surface/caves |
| Duskwing כנף-דמדומים | **flier** | membrane-winged night flier, 2.2-block span | circles above prey, dives, climbs away | torchlight (block light ≥ 9) drives it off; sunlight burns | in the air above the night surface |
| Mirefin סנפיר-ביצה | **aquatic** | eel with a glowing lure, waving body | bites people in the water | dries out and flops on land | in deep water, day or night |
| Cragback גב-סלע | **armoured** | mossy stone shell, six stubby legs | slow, hits hard (5); curls up when struck in the face | shell takes 20% from the front; a pickaxe cracks it (×2 from any side) | caves |
| Shade צל-חלול | **stealth / teleport** | floating hooded wraith, long pale hands, see-through (fades with distance) | blinks to just behind its prey, often blinks away when hit | bright light (≥ 10) keeps it off | surface/caves at night (rare) |
| Bramblehulk ענק-קוצים | **elite** | 2.7-block giant of rock and roots, glowing core in its back | winds up, then slams the ground (up to 8 damage in 4.5 blocks, big knockback) | ×2 damage from behind (the core); slow | surface at night (rare) |
| Ember mite קרדית-גחלים | swarm | small glowing beetle | packs of 3–5, leaps at you | 4 health | the Ember Deep |
| **Matriarch אם-הגחלים** | **boss** (300 health, boss bar) | giant ember beetle queen, glowing seams, mandibles | spits fans of embers; winds up and charges (crashing into a wall stuns her for 4 s); from half health spits more, charges more often, calls mites | ×2.5 damage while stunned — bait her into walls | woken at an **ember altar** (8 ember shards + lumen crystal + 3 ashstone) with lumen dust, in the Ember Deep only; one at a time |

Rewards: dusk membrane (bedroll material), raw fish (cook it; cats eat it), raw iron and rubblestone,
lumen dust, lumen crystals and iron ingots, ember shards, and the matriarch's heart (furnace fuel that
burns for 32,000 ticks) with diamonds.

## Next stages (not started)

- **C – more life**: passive fish and squid-like swimmers, birds and bats, more pets/mounts; leads and name tags.

## Known limits

- Baby/adult transitions and taming are host-authoritative and synced; riding is client-driven for the
  rider (the host checks speed and moves the mount with them), like the player's own movement.
- No leads, name tags, armour for horses, or breeding cooldown UI yet.
- Animals in chunks that never load again stay in the save (a few dozen bytes each).
