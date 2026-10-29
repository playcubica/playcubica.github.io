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

## Monsters (existing, Cubica's own)

| Creature | Status |
|---|---|
| Gloomwalker הולך-אפלה | model + skin, melee, burns in sun, night spawning (most common, groups) |
| Thornslinger קוצן | model + skin, ranged thorns |
| Skitterling זחלן | model + skin, climbs walls |
| Sporecap פטריון | model + skin, spore cloud |
| Trader סוחר | model + skin, settlements, trades |

These still use the older box-list models with generic limb animation; they are not saved (by design).

## Next stages (not started)

- **B – monster ecosystem**: new original monsters per role – flying, aquatic, cave dwellers, armoured,
  stealth/teleporting, elite and a boss – each with its own rig, skin, animations, AI, attacks, sounds
  and spawn rules; move the existing monsters onto species rigs.
- **C – water and air life**: fish and other swimmers (needs swimming AI), birds/bats (needs flying AI).

## Known limits

- Baby/adult transitions and taming are host-authoritative and synced; riding is client-driven for the
  rider (the host checks speed and moves the mount with them), like the player's own movement.
- No leads, name tags, armour for horses, or breeding cooldown UI yet.
- Animals in chunks that never load again stay in the save (a few dozen bytes each).
