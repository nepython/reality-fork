---
name: reality-fork
description: Measure the physics of motion in a short video (gravity, speed, drag, bounciness, pendulum length, acceleration on a slope) with error bars, then re-simulate it under other physics (Moon gravity, no air, a bouncier ball). Use when the user has a video of something moving and wants numbers for code, a simulation or a check of a claim.
---

# Reality Fork: physics from video

Reality Fork tracks a moving object frame by frame (Meta SAM 3.1), fits a law of motion with error bars, and can "fork" the motion under changed physics.

## When to use it
The user has a video (or a sample clip id) and wants: gravity, launch speed or angle, air drag, how bouncy a ball is, a pendulum's length or period, acceleration on a slope, or "what would this look like on the Moon". Also when code needs real constants measured from footage.

## How to call it
Replace `<DIR>` with the reality-fork checkout (the folder holding `mcp/`).

MCP tools (if the `reality-fork` server is connected):
- `list_clips` - clip ids and whether each is analysed.
- `analyze_video({path | clip_id, question?, live?})` - headline, answer, law, measurements with sigma, assumptions, confidence.
- `fork_motion({clip_id, g?, drag?, e?})` - re-simulation: summary, landing/bounce events, path every 0.1 s in metres.
- `export_measurements({clip_id})` - JSON of the fitted law, parameters, sigmas, scale, frame range, fps.
- `braking_fork({clip_id, hazard_distance_m = 20, speed_kmh?, react_s = 1.5, decel = 7})` - for a clip of a car crossing the frame: does it stop if someone steps out that far ahead, by how many metres, or at what speed does it hit? Both the measured speed (with its error bar) and `speed_kmh` if given.
- `speed_survey({clip_ids, limit_kmh = 30})` - many analysed car clips: each speed in km/h with sigma, the mean, the 85th-percentile speed with an uncertainty, the share over the limit, and a plain summary. Non-vehicle or unanalysed clips are listed as skipped, with the reason.

Shell (same tools, JSON on stdout; use this if MCP is not available):
```
node <DIR>/mcp/cli.mjs list
node <DIR>/mcp/cli.mjs analyze <video-path|clip_id> --question "what is g?"
node <DIR>/mcp/cli.mjs fork <clip_id> --g 1.62        # or --g moon, --drag none, --e 0.8
node <DIR>/mcp/cli.mjs export <clip_id>
node <DIR>/mcp/cli.mjs brake <clip_id> --distance 20 --speed 30   # also --react 1.5 --decel 7
node <DIR>/mcp/cli.mjs survey <clip_id> <clip_id> ... --limit 30
```
Typical flow: `analyze`, then `export` to get numbers, optionally `fork`. Put the exported values into the user's code, with their sigmas as tolerances.

## Cars: braking and speed surveys
Use `braking_fork` when the question is about safety on a street ("would the car stop if a child stepped out 20 m ahead?", "what difference does 30 km/h make?") and `speed_survey` when someone needs the speed of traffic for a council or a school: councils act on the **85th-percentile speed**, the speed 85% of drivers stay under, not the average. Both need clips already analysed with a constant-velocity fit of something moving sideways across the frame at over 2 m/s. Always quote the stated assumptions with the answer: 1.5 s perception-reaction time and hard braking at 7 m/s² on dry asphalt are typical figures, not measurements; change `react_s` and `decel` for a tired driver or a wet road. Each clip's speed depends on the scale (the size of a known object such as a car's length), so say so, and with fewer than about 20 clips call the 85th percentile a rough guide.

## Reading the numbers
- Every value has a 1-sigma error. `sigma` in `analyze_video` measurements already includes the scale uncertainty; in `export_measurements` use `sigma_total` for real-world claims and `sigma_fit` for fit-only noise.
- About 68% of repeats should land within 1 sigma, 95% within 2. If a result is within 2 sigma of a known value (Earth g = 9.81), it agrees; do not over-read a 3% difference when sigma is 6%.
- Check `confidence` and `assumptions`. Say "measured 10.0 +/- 0.7 m/s^2", never a bare number.
- Fork results are simulations from the fitted law, not new measurements. Times are seconds from the track start, positions metres from the fit's start point, x right, y up.

## Honest limits
- Still camera; no panning or zoom.
- Motion roughly in a plane facing the camera (no strong depth change).
- Scale comes from an object of known size in the same plane (a tennis ball, a person); a wrong size assumption scales every length and speed.
- Short clips: at most 20 s are used. Video is H.264-normalised; frame timing is the clock.
- A new analysis (`live=true`) calls Meta's models, costs a few cents of API credit, and only runs if the process was started with `RF_ALLOW_LIVE=1`. Otherwise only already-analysed clips are available. Never enable it without the user's say-so.
