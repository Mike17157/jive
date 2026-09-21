# Jive vs Codex demos

The recordings and rendered edits are not tracked in git (they are gigabytes of
video); only the render scripts and this description are. Drop the source
recordings into `source/` to re-render.

- `source/`: original, unmodified screen recording.
- `edits/Jive vs Codex - conversation_eval v3.mp4`: current edit.
- `edits/Jive vs Codex - sembench_movie.mp4`: movie-review task, matching current styling.
- `project/`: reproducible render scripts; generated graphics and intermediate files are written here.

## Current edit

10× until Jive finishes at source time 03:17, then 50× until 20:38, followed by a six-second final hold. Approximately 46 seconds total. The source-time counter includes the skipped time at the cut.

The accidental WhatsApp switch at 05:21–05:25.5 is removed. Footage after 20:38 is removed, including the recording controls and `/status` interaction.

Dark header, white titles, bold bordered source timer, orange playback accent, animated speed-change cue, and large DONE cards over the lower input areas. The timer border matches the speed panel: white at 10×, orange at 50×. No footer. Full source pixels retained; 2554×1778 output at 30 fps. The source has no audio.

## Re-render on macOS

Requires FFmpeg, Python, and Pillow. Fonts are loaded from macOS system fonts.

```sh
python3 -m venv demos/project/.venv
demos/project/.venv/bin/pip install Pillow
demos/project/.venv/bin/python demos/project/render_v3.py
# Movie-review task:
demos/project/.venv/bin/python demos/project/render_movie.py
```

Each script replaces only its respective output edit and generated intermediates. The original recording stays unchanged.

## Movie-review edit

Source: `Screen Recording 2026-09-20 at 18.17.55.mov`. 10× through 01:25, then 50× through 08:53. Six-second final hold, approximately 23.5 seconds total. Recording controls at the end are excluded. No middle cut. Same dark header, animated speed transition, bordered source-time counter, and DONE cards as the latest conversation-evaluation edit.
