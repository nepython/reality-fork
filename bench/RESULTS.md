# Benchmark

Each clip was analysed end to end by the agent (Muse Spark + SAM 3.1 + fitting); values are the fitted ones.

| clip | law found | quantity | truth | measured | error | agrees (2σ or 1%) |
|---|---|---|---|---|---|---|
| Artemis I lifts off (NASA, 16 Nov 2022) | projectile | g | -5.20 | -5.07 ± 0.16 | -2.5% | yes |
| Test scene: bounce | bounce | g | 9.81 | 9.75 ± 0.43 | -0.6% | yes |
| Test scene: bounce | bounce | e | 0.780 | 0.780 ± 0.000054 | -0.0% | yes |
| Test scene: drop-60fps | projectile | g | 9.81 | 9.74 ± 0.43 | -0.7% | yes |
| Test scene: drop | projectile | g | 9.81 | 9.36 ± 0.43 | -4.6% | yes |
| Test scene: float | constant-velocity | speed | 0.966 | 0.963 ± 0.043 | -0.3% | yes |
| Test scene: incline | incline | a | 1.46 | 1.46 ± 0.065 | -0.1% | yes |
| Test scene: moon-drop | projectile | g | 1.62 | 1.63 ± 0.043 | 0.8% | yes |
| Test scene: pendulum | pendulum | g | 9.81 | 9.85 ± 0.84 | 0.4% | yes |
| Test scene: pendulum | pendulum | L | 0.750 | 0.754 ± 0.064 | 0.5% | yes |
| Test scene: throw | projectile-drag | g | 9.81 | 10.0 ± 0.66 | 2.1% | yes |
| Test scene: throw | projectile-drag | b | 0.0300 | 0.0300 ± 0.0020 | 0.1% | yes |

Median |error| in g: 0.75% over 7 clips; 7 of 7 within 2σ.
