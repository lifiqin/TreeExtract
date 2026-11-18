# Synthetic annotation QA fixtures

- `qa-blank-100x50.jpg` and `qa-blue-100x50.jpg`: locally generated solid-color JPEGs, 100 × 50 pixels, used for dimensions, SHA-256 and independent-evidence validation tests.
- `qa-blank-120x90.jpg` and `qa-blue-120x90.jpg`: locally generated solid-color JPEGs, 120 × 90 pixels, used for 4:3 collection and same-dimensions/different-hash browser tests.
- `qa-rgba-2x2.png` and `qa-rgba-marked-2x2.png`: locally generated 2 × 2 opaque RGBA pixels with known colors and one changed pixel, used for BGRA hashing and pair-review tests.
- `qa-rgba-100x50.png` and `qa-rgba-far-100x50.png`: synthetic PNGs differing by one distant pixel, used to reject a supposed candidate marker that is nowhere near the selected observation.

These files do not contain real people or project data and do not establish detector accuracy. `astronaut.png` has separate provenance in [README.md](README.md).
