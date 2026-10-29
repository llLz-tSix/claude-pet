"""Собирает GIF из кадров tools/make-gifs.js (нужен Pillow): python tools/make-gifs.py <папка с кадрами> docs"""
import sys
from pathlib import Path
from PIL import Image

STEP_MS = 60  # как STEP в tools/gif.html

frames_root, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
for scene in sorted(p for p in frames_root.iterdir() if p.is_dir()):
    frames = []
    for file in sorted(scene.glob('*.png')):
        rgba = Image.open(file).convert('RGBA')
        # Пиксель-арт без полупрозрачности: один цвет палитры отдаём под прозрачный фон,
        # чтобы питомец смотрелся и на светлой, и на тёмной теме GitHub.
        frame = rgba.convert('RGB').quantize(colors=255, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
        mask = rgba.getchannel('A').point(lambda a: 255 if a < 128 else 0)
        frame.paste(255, mask=mask)
        frames.append(frame)
    target = out / f'{scene.name}.gif'
    frames[0].save(target, save_all=True, append_images=frames[1:], duration=STEP_MS, loop=0,
                   transparency=255, disposal=2, optimize=False)
    print(f'{target}: {len(frames)} кадров, {target.stat().st_size // 1024} КБ')
