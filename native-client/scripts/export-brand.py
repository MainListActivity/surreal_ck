"""从既有 Logo.svelte 导出静态 SVG；不重绘品牌轮廓。"""
from pathlib import Path
import math
import re
root = Path(__file__).resolve().parents[2]
source = (root / 'web/src/components/Logo.svelte').read_text()
paths = re.findall(r'<path[^>]* d="([^"]+)"', source)
assert len(paths) == 4
cells = []
for index in range(30):
    x, y = 10 + index % 6 * 7.6, 10 + index // 6 * 7.6
    distance = math.hypot(x + 3 - 32, (y + 3 - 24) * 1.15)
    opacity = 1 if index in [2, 9, 16, 22, 27] else max(.22, min(1, 1.15 - distance / 26))
    cells.append(f'<rect x="{x:g}" y="{y:g}" width="6" height="6" rx="1.2" fill="#f5c542" fill-opacity="{opacity:.8f}"/>')
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#161513"/>' + ''.join(cells)
svg += f'<path d="{paths[0]}" fill="none" stroke="#f5c542" stroke-linejoin="round" stroke-width="1.3"/>'
svg += f'<path d="{paths[1]}" fill="#161513"/>'
svg += f'<path d="{paths[2]}" fill="none" stroke="#f5c542" stroke-linejoin="round" stroke-linecap="round" stroke-width="4.6"/>'
svg += f'<path d="{paths[3]}" fill="none" stroke="#161513" stroke-linecap="round" stroke-width="3.4"/></svg>\n'
(root / 'native-client/assets/brand.svg').write_text(svg)
