"""Render the revised demo; keep the original recording and first edit."""
import math
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
SOURCE = ROOT.parent / 'source' / 'Screen Recording 2026-09-20 at 18.17.55.mov'
OUTPUT = ROOT.parent / 'edits' / 'Jive vs Codex - sembench_movie.mp4'
W, H, FPS = 2554, 144, 30
SWITCH = 85 / 10
FINISH = SWITCH + (533 - 85) / 50
DURATION = FINISH + 6
BG, INK, MUTED, ORANGE = '#deded9', '#080808', '#72726d', '#ff7919'
DARK, WHITE = '#111318', '#f2f2ed'
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
MONO = '/System/Library/Fonts/Supplemental/Courier New.ttf'
MONO_BOLD = '/System/Library/Fonts/Supplemental/Courier New Bold.ttf'
fonts = {}

def font(size, name=FONT):
    key = (size, name)
    if key not in fonts:
        fonts[key] = ImageFont.truetype(name, size)
    return fonts[key]

def text(draw, xy, content, size, color=INK, name=FONT, anchor='lt'):
    draw.text(xy, content, font=font(size, name), fill=color, anchor=anchor)

def source_time(t):
    if t < SWITCH:
        return t * 10
    source = 85 + (t - SWITCH) * 50
    return min(source, 533)

# A compact animated header keeps the terminal pixels untouched.
header = ROOT / 'header-movie.mp4'
encoder = subprocess.Popen([
    'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
    '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '15', '-pix_fmt', 'yuv420p', str(header)
], stdin=subprocess.PIPE)
for frame in range(math.ceil(DURATION * FPS)):
    t = frame / FPS
    im = Image.new('RGB', (W,H), DARK)
    d = ImageDraw.Draw(im)
    text(d,(38,21),'Jive',60,WHITE,BOLD)
    text(d,(1315,21),'Codex',60,WHITE,BOLD)
    text(d,(41,102),'sembench_movie',22,'#a5a9b2',MONO)
    text(d,(1318,102),'sembench_movie',22,'#a5a9b2',MONO)
    d.line((1277,20,1277,123),fill='#393d46',width=1)
    fast = t >= SWITCH
    accent = ORANGE if fast else WHITE
    d.rectangle((1958,16,2254,128),fill='#1a1d23',outline=accent,width=4)
    text(d,(2106,28),'SOURCE TIME',21,accent,BOLD,'mt')
    seconds = int(source_time(t))
    text(d,(2106,58),f'{seconds//60:02d}:{seconds%60:02d}',58,WHITE,MONO_BOLD,'mt')
    d.rectangle((2276,16,2521,128),fill=accent)
    elapsed = t - SWITCH
    accelerating = 0 <= elapsed < 1.8
    if t >= FINISH:
        text(d,(2398,57),'COMPLETE',26,INK,BOLD,'mt')
    else:
        label = 'SPEEDING UP' if accelerating else 'PLAYBACK'
        text(d,(2398,25),label,17,INK,BOLD,'mt')
        pulse = int(10 * math.exp(-1.8*elapsed) * abs(math.sin(elapsed*10))) if accelerating else 0
        text(d,(2386,58),'50×' if fast else '10×',49+pulse,INK,BOLD,'mt')
        if accelerating:
            for j in range(2):
                x = 2472 + j*16 + int((elapsed*24)%9)
                d.line([(x,71),(x+10,81),(x,91)],fill=INK,width=4)
    d.line((0,H-2,W,H-2),fill='#393d46',width=2)
    if accelerating:
        # Orange sweep under the header announces the change in pace.
        d.rectangle((0,H-6,int(W*min(elapsed/.65,1)),H-1),fill=ORANGE)
    encoder.stdin.write(im.tobytes())
encoder.stdin.close()
if encoder.wait():
    raise RuntimeError('Header encode failed')

# Place the completion cards over the input area, below the final response.
for name in ('jive','codex'):
    im = Image.new('RGBA',(520,166),(0,0,0,0))
    d = ImageDraw.Draw(im)
    d.rectangle((7,7,519,165),fill=(0,0,0,120))
    d.rectangle((0,0,511,157),fill=BG,outline=INK,width=2)
    d.rectangle((0,0,8,157),fill=ORANGE)
    text(d,(38,25),'DONE',65,name=BOLD)
    text(d,(41,111),'RUN COMPLETE',21,MUTED,MONO)
    d.line([(416,74),(434,92),(472,49)],fill=INK,width=7)
    im.save(ROOT / f'{name}-done-v2.png')

filters = [
    'trim=end=533',
    f"setpts='if(lt(T,85),T/10,{SWITCH}+(T-85)/50)/TB'",
    'fps=30', 'tpad=stop_mode=clone:stop_duration=6',
    f'pad=iw:ih+{H}:0:{H}:color=0xdeded9',
]
graph = '[0:v]' + ','.join(filters) + '[base];'
graph += '[base][1:v]overlay=0:0[headed];'
graph += f"[headed][2:v]overlay=x=379:y='1590+35*exp(-12*(t-{SWITCH}))':enable='gte(t,{SWITCH})'[left];"
graph += f"[left][3:v]overlay=x=1656:y='1590+35*exp(-12*(t-{FINISH}))':enable='gte(t,{FINISH})'[out]"
subprocess.run([
    'ffmpeg','-hide_banner','-y','-i',str(SOURCE),'-i',str(header),
    '-i',str(ROOT/'jive-done-v2.png'),'-i',str(ROOT/'codex-done-v2.png'),
    '-filter_complex',graph,'-map','[out]','-t',str(DURATION),'-an',
    '-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p',
    '-movflags','+faststart','-metadata','title=Jive vs Codex | sembench_movie',
    '-progress',str(ROOT/'render-movie-progress.txt'),str(OUTPUT)
],check=True)
