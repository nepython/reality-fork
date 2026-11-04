# Street speed-survey clips

Eight single-vehicle passes for the speed-survey step (not shown on the rail). All are cut from one fixed-camera video.

- Source: "Views of the Caton Farm Road and Essington Road Intersection in Joliet, Illinois" (22 Aug 2026), https://commons.wikimedia.org/wiki/File:Views_of_the_Caton_Farm_Road_and_Essington_Road_Intersection_in_Joliet,_Illinois.webm
- Author: Illinois_Roadbuff (Rogue Jr). Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); keep this credit.
- Processing: first fixed-camera segment (0-59 s, 4096x2160, 59.94 fps, non-square pixels) cut with a near-lossless re-encode, audio removed, then `normalise()` to 1280x720 at 59.94 fps. Black letterbox bars of about 22 px at top and bottom.
- Scene: a signalised four-lane junction in the US. Cars cross left to right in the near lanes, mostly turning or pulling away from a green, so speeds are probably low (nothing here is a measured speed). Perspective is oblique: the road recedes to the right, so pixel scale shrinks along the path. The grey signal pole (x about 1000-1060 px) hides each car for a moment at the right. Plates are not legible at 720p; no drivers identifiable.
- Segments 2-5 of the source (from 59 s) are NOT used: the camera pans or changes view.
- Times below are seconds in the clip (rough, read from contact sheets). "Length" is the car's rough on-screen length at its largest, bumper to bumper.

| Clip | Source time | Duration | Car | In shot (s) | Length (px) | Notes |
|---|---|---|---|---|---|---|
| car01 | 3.8-8.2 s | 4.40 s | dark SUV | 0.3-2.3 | about 575 | A white SUV is leaving at the very start (it is the hero clip's car). |
| car02 | 27.2-31.2 s | 4.00 s | grey sedan | 0.9-2.8 | about 610 | Clean; far traffic is small. |
| car03 | 32.2-36.2 s | 4.00 s | silver SUV | 0.7-2.8 | about 575 | Clean; enters at left edge after 0.7 s. |
| car04 | 38.6-42.8 s | 4.20 s | light grey sports sedan | 0.6-2.4 | about 575 | A dark SUV is still leaving at the start (0-1 s), partly overlapping. |
| car05 | 42.6-46.6 s | 4.00 s | black SUV, then silver SUV | 0.3-1.7 and 1.3-3.0 | about 540 and 340 | Two cars close together; the second is further away (smaller). |
| car06 | 45.9-49.9 s | 4.00 s | dark pickup | 0-2.3 | about 345 | Far lane, small and dark: weakest clip. |
| car07 | 50.2-54.2 s | 4.00 s | tan SUV | 0.3-2.0 | about 730 | Nearest lane, largest; a dark car follows it. |
| car08 | 0.0-4.4 s | 4.40 s | white SUV | 0.55-3.7 | about 610 | Same clip as `clips/street_car.mp4` (the rail's hero). |

No scale or ground-truth speed is known for these; see the notes in `clips/manifest.json` (entry `street_car`) for scale references (the car's own length, an estimate).
