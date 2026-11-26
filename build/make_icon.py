# encoding: utf-8
"""生成 Windows 图标（ICO），供 exe 与安装包使用。"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SIZES = [16, 24, 32, 48, 64, 128, 256]


def render(size: int) -> Image.Image:
    scale = size / 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    def box(x1, y1, x2, y2, radius, fill):
        draw.rounded_rectangle(
            [x1 * scale, y1 * scale, x2 * scale, y2 * scale],
            radius=max(1, int(radius * scale)),
            fill=fill,
        )

    box(3, 3, 61, 61, 15, (255, 36, 66, 255))
    box(17, 15, 26, 49, 4, (255, 255, 255, 255))
    box(31, 15, 40, 49, 4, (255, 255, 255, 150))
    return image


def main() -> int:
    images = [render(size) for size in SIZES]
    target = HERE / "icon.ico"
    images[-1].save(target, format="ICO", sizes=[(size, size) for size in SIZES])
    images[-1].save(HERE / "icon.png", format="PNG")
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
