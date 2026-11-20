"""从既有 Logo.svelte 导出静态 SVG 与 App 图标；不重绘品牌轮廓。实现见 brand_icon.py。"""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('brand_icon', Path(__file__).with_name('brand_icon.py'))
brand_icon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(brand_icon)

if __name__ == '__main__':
    brand_icon.main(sys.argv[1:] or ['generate'])
