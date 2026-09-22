# Measuring: true lengths, square footage, plans

v0.16 makes every length in the world the real length on the ground, and says so while you draw.

## The metres are true

The world turns longitude and latitude into metres with the WGS84 ellipsoid's two radii at its origin
(`src/world/geo.ts`, `metresPerDegree`):

| per degree at 34.4326° N | before v0.16 (sphere) | now (WGS84) |
|---|---|---|
| east–west | 91,826 m | 91,913.9 m |
| north–south | 111,319 m | 110,930.2 m |

The sphere stretched everything 0.35% north–south. That is 1.3 ft on the survey's 377.58 ft west line.
Checked against the eleven boundary calls of the licensed survey (Henry Land Surveying, 2024-11-14), every
line now measures within 0.07 ft of the surveyor's figure (`tests/measure.test.mjs`). The editor shows the
same check live: **✓ true to the ground: 11 survey lines within 0.07 ft**.

Anything else that turns metres into degrees must use `metresPerDegree` too. A pack's own `frame` is
the pack's declared transform for its own files (trees.csv). The sulphur-mountain pack still uses
spherical constants there; that is its phase C15.3.

## Drawing to size

- Each side of a wall, floor, roof, fence or territory is labelled as it is drawn. The side being
  pulled also shows its bearing and the corner it makes.
- **Type a length** while drawing, then **Enter**: the next point goes exactly that far toward the
  cursor. Accepted: `32'6"`, `32' 6`, `32.5'`, `32ft 6in`, `6"`, `9.9m`, `990cm`, or a bare number
  in the chosen units.
- **Shift** snaps the direction to 45° from the last side (15° steps for the first) and the length to
  6 in (10 cm in metres).
- A closed shape shows its area and perimeter. A closing wall also shows the area to the outside of
  the wall.
- **ft·in / m** in the panel's head switches which unit comes first. It is remembered in this browser.

## The tape (T)

Click where the tape starts, then where it ends: on the ground, a wall or a roof. It reads the level
distance, the rise and the slope. Ends pull onto the corners of walls and floors within 30 cm.

## Square footage (ANSI Z765)

A building is every part with the same **part of** name.

- **Gross** is measured to the outside face of the outside walls. The biggest closed run of walls that
  stands from a floor to head height is the outside wall. Walls drawn one by one count when their ends
  meet within 35 cm.
- **Net** is measured to the inside face.
- **Levels** are the floors' `level_m`. A level's ceiling is the next full floor above it (less its
  thickness) or the top of its walls. A level with a ceiling under 7 ft is drawn but not counted.
- **Footprint** is the lowest level's gross outline. The **setback** is the nearest distance from it to
  the surveyed line; a building not wholly inside the line is flagged.
- **Make it … sq ft** scales every part about the footprint's middle until the gross comes to the
  target. Thicknesses and heights stay; openings keep their place along their walls. An organic building
  is regrown from a scaled perimeter. The organic tool's **size** field does the same as it is drawn.

A registry model is measured from the floors it carries for walking. Its rooms count; terraces, steps,
paths, yards and landings do not.

## The plan (P)

**📐 floor plan** (or P) draws what is selected, north up, in true metres:

- walls cut at 1.2 m and filled; doors with their swing; windows as three lines; roof edges dashed;
- each straight outside side dimensioned, then the overall width and depth along the building's own
  axis; the gross and net area in the middle;
- a level for each floor, a north arrow, a scale bar, and a title block with the coordinates and the
  survey check.

The **site plan** puts the footprint on the parcel with the surveyed line, the easements, the other
buildings and the trees, and dimensions the setback. Both download as SVG or PNG, or print to PDF.
