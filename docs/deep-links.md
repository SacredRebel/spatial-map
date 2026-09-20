# Deep links

How to send someone to a place in this world, and how to get a link to where you are.

A link is how a place travels — into a portal, a dashboard, a message, a scheduled tour. This is
the contract those things build on, so it changes carefully and never silently.

## The parameters

```
?community=<slug>        which community's world. Default: sulphur-mountain
?at=<id>                 a NAMED place from the registry           <- prefer this
?at=<lng>,<lat>[,<deg>]  an exact spot, heading clockwise from north
?t=<hours>               time of day, 0–24, local to the community
?atlas=<origin>          where the registry is read from
?avatar=<url>            the body to walk in
?looks=<off|plain|full|auto>
?pack=<url>              a community pack other than the default
```

## Name, not coordinates

**`at=sulphur-oak-house` and `at=-119.15536,34.4331,14` both work, and they are not equivalent.**

Coordinates are exact, and they rot. The day someone nudges a building three metres, every link
ever sent still points confidently at the field beside it — and nothing anywhere reports an error,
because the coordinates are still perfectly valid coordinates. A name cannot go subtly wrong that
way: it either resolves to the thing or it is refused out loud.

So: **anything that means "this building" uses the id.** Coordinates are for a spot that is not a
thing — a view across the valley, the place a photograph was taken from, somewhere on the path.

Any `id` in the structure registry works, including a reserved SITE with no model on it yet. Those
are worth linking to precisely because nothing is there: *this is where the barn goes* is a thing
to send someone.

### Where a name puts you

Fourteen metres back from the structure, looking at it.

The direction is derived, not fixed: the bearing from the structure toward the community's own
spawn point, so you always arrive the way a person walking from the rest of the settlement would.
A constant like "stand to the south" would put you in the creek at one building and inside the
hillside at another, and a link that drops people at the back of a building teaches them the
building has no front.

A structure with a model uses its position. A reserved site uses its outline's centroid.

### When a name is unknown

`standAt` returns `false`, the world opens at the community's usual way in, and the HUD says:

> this link points at "<id>", and nothing here is called that. Showing the usual way in.

A dead link should be legible. The failure that costs real time is the one where someone arrives
somewhere plausible and spends ten minutes wondering why the view is wrong.

## Making links

```js
world.link()                            // where the walker is standing, and the current hour
world.link({ at: 'sulphur-oak-house' }) // the durable kind
world.link({ at: 'the-barn', hours: 17 })
```

Consuming deep links is only half a contract. Until something can produce one, every link in
existence is hand-written — and hand-written is exactly where the coordinates-instead-of-a-name
mistake gets made. `world.link()` with no name writes the current position to about a centimetre,
which is right for *this exact spot* and wrong for *this building*; pass the name when you mean
the building.

`world.standAt(id)` steps to a named place exactly as `?at=<id>` would, and returns whether the
name was known.

## For anything building on this

- **Send the id.** A portal linking to a community's main house sends `at=sulphur-oak-house`, not
  the coordinates it read out of the registry this morning.
- **Do not parse these links to extract a position.** Ask the registry. The link says which place;
  the registry says where that place is, and it is the thing that stays correct.
- **`t` is honest about time.** A link sent with `t=17` shows that building in evening light on
  purpose. A link with no `t` opens at the community's default hour, not at midnight — `Number(null)`
  is `0`, so an absent parameter is caught before it is parsed rather than silently becoming
  midnight and opening the world in the dark.
