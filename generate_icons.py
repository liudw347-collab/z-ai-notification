"""生成 AI Chat Notification 扩展图标"""
from PIL import Image, ImageDraw

def create_bell_icon(size, output_path):
    """绘制一个简洁的铃铛图标"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 背景：圆角矩形 / 圆形
    margin = max(1, size * 0.05)
    bg_size = size - margin * 2
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=bg_size * 0.22,
        fill=(99, 102, 241, 255)  # Indigo gradient base
    )

    # 画一个简单的铃铛形状
    cx = size / 2
    # 铃铛参数
    bell_top = size * 0.2
    bell_bottom = size * 0.72
    bell_width_top = size * 0.18
    bell_width_bottom = size * 0.32
    clapper_y = size * 0.78
    clapper_r = size * 0.055
    handle_y = size * 0.14
    handle_r = size * 0.08

    # 铃铛把手（顶部小半圆）
    draw.ellipse(
        [cx - handle_r, handle_y - handle_r * 0.5, cx + handle_r, handle_y + handle_r * 1.2],
        fill='white'
    )

    # 铃铛主体（梯形用多边形近似）
    bell_points = [
        (cx - bell_width_top, bell_top),           # 左上
        (cx + bell_width_top, bell_top),           # 右上
        (cx + bell_width_bottom, bell_bottom),     # 右下
        (cx - bell_width_bottom, bell_bottom),     # 左下
    ]
    draw.polygon(bell_points, fill='white')

    # 铃铛底部弧线
    draw.ellipse(
        [cx - bell_width_bottom - size * 0.02, bell_bottom - bell_width_bottom * 0.6,
         cx + bell_width_bottom + size * 0.02, bell_bottom + bell_width_bottom * 0.4],
        fill='white'
    )

    # 铃铛锤（底部小圆）
    draw.ellipse(
        [cx - clapper_r, clapper_y - clapper_r, cx + clapper_r, clapper_y + clapper_r],
        fill='white'
    )

    # 通知红点（右上角）
    dot_r = size * 0.1
    dot_cx = size * 0.75
    dot_cy = size * 0.25
    draw.ellipse(
        [dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
        fill=(239, 68, 68, 255)  # Red
    )

    img.save(output_path, 'PNG')
    print(f'Generated {output_path} ({size}x{size})')

# 生成三种尺寸
for s in [16, 48, 128]:
    create_bell_icon(s, f'/home/z/my-project/z-ai-notification/icons/icon{s}.png')

print('All icons generated!')