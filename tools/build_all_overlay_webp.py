"""Build pixel-exact lossless WebP companions for flood display overlays.

Packed query rasters and other PNG data stay in their original format. Existing
PNG overlays remain as a browser fallback. Identical PNGs share one encoding.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha256
from pathlib import Path
import shutil

from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    h = sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def encode(source, destinations):
    output = destinations[0]
    with Image.open(source) as original:
        rgba = original.convert('RGBA')
        pixels = sha256(rgba.tobytes()).digest()
        size = rgba.size
        rgba.save(output, 'WEBP', lossless=True, exact=True, quality=100, method=4)
    with Image.open(output) as webp:
        decoded = webp.convert('RGBA')
        if decoded.size != size or sha256(decoded.tobytes()).digest() != pixels:
            output.unlink(missing_ok=True)
            raise RuntimeError(f'WebP pixel verification failed: {source}')
    for destination in destinations[1:]:
        shutil.copyfile(output, destination)
    return len(destinations)


def main():
    if not features.check('webp'):
        raise RuntimeError('Pillow was built without WebP support')
    paths = sorted(path for path in (ROOT / 'assets').rglob('*.png')
                   if 'DepthPNGs' in path.parts or 'StagePNGs' in path.parts)
    groups = {}
    for path in paths:
        target = path.with_suffix('.webp')
        if not target.exists():
            groups.setdefault(digest(path), []).append(path)
    print(f'{len(paths)} display PNGs; {sum(map(len, groups.values()))} WebP companions missing; {len(groups)} unique encodings', flush=True)
    count = 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(encode, group[0], [path.with_suffix('.webp') for path in group])
                   for group in groups.values()]
        for future in as_completed(futures):
            count += future.result()
            if count % 100 < 2:
                print(f'Created {count} WebP companions', flush=True)
    print(f'Created {count} pixel-verified WebP companions', flush=True)


if __name__ == '__main__':
    main()
