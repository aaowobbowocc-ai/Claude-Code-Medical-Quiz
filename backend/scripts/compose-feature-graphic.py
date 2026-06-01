"""
合成 Google Play feature graphic (1024×500)。

流程：
  1. 讀 feature-bg.png (Nano Banana 生的 1024×1024 純插圖)
  2. 裁切到 1024×500 (取中央水平條)
  3. 用 PIL + Microsoft JhengHei 字型疊上中文標題/副標/tagline
  4. 輸出 feature-graphic.png

中文字型: C:/Windows/Fonts/msjh.ttc (微軟正黑體)
"""
import os
from PIL import Image, ImageDraw, ImageFont

BG_PATH = 'C:/Projects/examking/frontend/public/play-assets/feature-bg.png'
OUT_PATH = 'C:/Projects/examking/frontend/public/play-assets/feature-graphic.png'
FONT_PATH = 'C:/Windows/Fonts/msjh.ttc'  # Microsoft JhengHei (繁體)

TITLE = '國考知識王'
SUBTITLE = '醫師・律師・公職・駕照'
TAGLINE = '免費刷題・AI 解說・對戰挑戰'


def main():
    bg = Image.open(BG_PATH).convert('RGB')
    w, h = bg.size
    print(f'Source: {w}×{h}')

    # 裁切到 1024×500 — 從原圖中央取水平條
    target_w, target_h = 1024, 500
    # 先 resize 寬度到 1024 (若不是),再從中央取 500 高度
    if w != target_w:
        new_h = int(h * target_w / w)
        bg = bg.resize((target_w, new_h), Image.LANCZOS)
        w, h = target_w, new_h
        print(f'Resized to: {w}×{h}')

    # 從垂直中央取 500
    top = (h - target_h) // 2
    bg = bg.crop((0, top, target_w, top + target_h))
    print(f'Cropped to: {bg.size}')

    # 加左側深色漸層 overlay,讓文字更顯眼
    overlay = Image.new('RGBA', (target_w, target_h), (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    # 從左 0 (alpha 180) 漸層到 580 (alpha 0)
    for x in range(580):
        alpha = int(180 * (1 - x / 580))
        overlay_draw.line([(x, 0), (x, target_h)], fill=(15, 41, 64, alpha))
    bg = Image.alpha_composite(bg.convert('RGBA'), overlay).convert('RGB')

    draw = ImageDraw.Draw(bg)

    # ─── 標題 (左側 ~40% 區域) ────────────────────────────────
    # 國考知識王 — 大字白色,垂直略偏上
    title_font = ImageFont.truetype(FONT_PATH, 78)
    title_x, title_y = 56, 130
    # 加陰影增加可讀性
    draw.text((title_x + 3, title_y + 3), TITLE, font=title_font, fill=(0, 0, 0, 128))
    draw.text((title_x, title_y), TITLE, font=title_font, fill=(255, 255, 255))

    # ─── 副標 ─────────────────────────────────────────────
    subtitle_font = ImageFont.truetype(FONT_PATH, 30)
    subtitle_y = title_y + 90
    # 副標用暖金色突出
    draw.text((title_x + 2, subtitle_y + 2), SUBTITLE, font=subtitle_font, fill=(0, 0, 0, 128))
    draw.text((title_x, subtitle_y), SUBTITLE, font=subtitle_font, fill=(255, 215, 0))

    # ─── Tagline ─────────────────────────────────────────
    tagline_font = ImageFont.truetype(FONT_PATH, 22)
    tagline_y = subtitle_y + 60
    draw.text((title_x + 2, tagline_y + 2), TAGLINE, font=tagline_font, fill=(0, 0, 0, 128))
    draw.text((title_x, tagline_y), TAGLINE, font=tagline_font, fill=(230, 230, 230))

    bg.save(OUT_PATH, 'PNG', optimize=True)
    size = os.path.getsize(OUT_PATH)
    print(f'OK {OUT_PATH} ({size} bytes, {bg.size})')


if __name__ == '__main__':
    main()
