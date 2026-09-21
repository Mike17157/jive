"""Render exported xterm screen cells, not reconstructed agent activity."""
import json
import math
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = Path(__file__).parent
TASK = sys.argv[1]
PREVIEW = '--preview' in sys.argv
META = json.loads((ROOT / 'tui-generated' / f'{TASK}.json').read_text())
CELL_W, CELL_H, PAD = 12, 26, 24
PANE_W, TOP, ROWS = 1488, 190, 36
FOOTER = TOP + ROWS * CELL_H + 18
W, H = PANE_W * 3, FOOTER + 184
BG, FG, ORANGE = '#111318', '#eeeeec', '#ff7919'
FONT_DIR = Path('/System/Library/Fonts/Supplemental')
MONO = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 20, index=0)
MONO_BOLD = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 20, index=1)
SYMBOLS = ImageFont.truetype('/System/Library/Fonts/Apple Symbols.ttf', 24)
SYSTEM = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', 20)
UNICODE = ImageFont.truetype(str(FONT_DIR / 'Arial Unicode.ttf'), 20)
CMAPS = {id(f): TTFont(f.path,fontNumber=f.index).getBestCmap() for f in (MONO,MONO_BOLD,SYMBOLS,SYSTEM,UNICODE)}
TITLE = ImageFont.truetype(str(FONT_DIR / 'Arial Bold.ttf'), 48)
SMALL = ImageFont.truetype(str(FONT_DIR / 'Arial.ttf'), 24)
LABEL = ImageFont.truetype(str(FONT_DIR / 'Arial Bold.ttf'), 24)
CLOCK = ImageFont.truetype(str(FONT_DIR / 'Courier New Bold.ttf'), 68)
SPEED = ImageFont.truetype(str(FONT_DIR / 'Arial Bold.ttf'), 68)
COMPLETE = ImageFont.truetype(str(FONT_DIR / 'Arial Bold.ttf'), 76)
PALETTE = ['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5',
           '#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff']
for r in (0,95,135,175,215,255):
    for g in (0,95,135,175,215,255):
        for b in (0,95,135,175,215,255):
            PALETTE.append(f'#{r:02x}{g:02x}{b:02x}')
PALETTE += [f'#{v:02x}{v:02x}{v:02x}' for v in range(8,239,10)]

def color(value, default):
    return default if value is None else PALETTE[value] if isinstance(value,int) else value

@lru_cache(maxsize=4096)
def terminal_font(chars, bold):
    primary = MONO_BOLD if bold else MONO
    if chars.isascii(): return primary
    for candidate in (primary, SYMBOLS, SYSTEM, UNICODE):
        if all(ord(c) in CMAPS[id(candidate)] for c in chars):
            return candidate
    return primary

def clock(value):
    value = round(value)
    return f'{value//60:02d}:{value%60:02d}'

output = ROOT.parent / 'edits' / f'Jive vs Codex vs Claude - {TASK}.mp4'
output.parent.mkdir(exist_ok=True)
temporary = output.with_suffix('.rendering.mp4')
encoder = None if PREVIEW else subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo',
    '-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(META['fps']),'-i','-','-an',
    '-c:v','libx264','-threads','4','-preset','fast','-crf','17','-pix_fmt','yuv420p','-movflags','+faststart',str(temporary)],stdin=subprocess.PIPE)
last_frame = math.ceil(META['fps']*META['duration'])-1
with (ROOT / 'tui-generated' / f'{TASK}.frames.jsonl').open() as frames:
    for index,line in enumerate(frames):
        if PREVIEW and index not in (0,120,last_frame): continue
        frame = json.loads(line)
        im = Image.new('RGB',(W,H),BG)
        d = ImageDraw.Draw(im)
        source = frame['source']
        for pane,(run,rows) in enumerate(zip(META['runs'],frame['screens'])):
            left = pane * PANE_W
            done = source >= run['seconds']
            d.text((left+PAD,20),['Jive','Codex','Claude Code'][pane],font=TITLE,fill=FG)
            d.text((left+PAD,80),TASK,font=SMALL,fill='#a5a9b2')
            model = 'Opus 5' if pane == 2 else 'GPT-5.6 Sol'
            d.text((left+PAD,119),f'{model} · medium',font=SMALL,fill='#a5a9b2')
            # Reference treatment: outlined dark clock beside a light speed box.
            d.rectangle((left+768,20,left+1118,160),fill='#191f23',outline='#edf1eb',width=4)
            d.text((left+943,31),'SOURCE TIME',font=LABEL,fill='#edf1eb',anchor='mt')
            # Each pane's source clock stops at that agent's own completion time.
            d.text((left+943,76),clock(min(source,run['seconds'])),font=CLOCK,fill='#edf1eb',anchor='mt')
            d.rectangle((left+1142,20,left+1464,160),fill='#edf1eb')
            d.text((left+1303,31),'PLAYBACK',font=LABEL,fill='#080b0c',anchor='mt')
            d.text((left+1303,72),'10×' if source < META['switchAt'] else '50×',font=SPEED,fill='#080b0c',anchor='mt')
            d.line((left,TOP-12,left+PANE_W,TOP-12),fill='#94b9fd',width=2)
            if pane: d.line((left,0,left,H),fill='#393d46',width=2)
            for y,spans in enumerate(rows):
                for x,chars,style,width in spans:
                    fg,bg,bold,inverse,underline = style
                    fg,bg = color(fg,FG),color(bg,BG)
                    if inverse: fg,bg = bg,fg
                    px,py = left+PAD+x*CELL_W,TOP+y*CELL_H
                    d.rectangle((px,py,px+width*CELL_W-1,py+CELL_H-1),fill=bg)
                    if chars == '\u23fa':
                        d.ellipse((px+2,py+9,px+10,py+17),fill=fg)
                    elif chars == '\u23f5':
                        d.polygon([(px+3,py+7),(px+10,py+13),(px+3,py+19)],fill=fg)
                    else:
                        d.text((px,py),chars,font=terminal_font(chars,bold),fill=fg)
                    if underline: d.line((px,py+CELL_H-3,px+width*CELL_W,py+CELL_H-3),fill=fg)
            # Reserve a footer so the large completion banner never hides TUI rows.
            if done:
                d.rectangle((left+PAD,FOOTER,left+PANE_W-PAD,H-20),fill='#edf1eb')
                d.rectangle((left+PAD,FOOTER,left+PAD+12,H-20),fill=ORANGE)
                d.text((left+PAD+42,FOOTER+20),'COMPLETE',font=COMPLETE,fill='#080b0c')
                d.text((left+PAD+47,FOOTER+113),f'FINISHED IN {clock(run["seconds"])}',font=LABEL,fill='#535954')
                d.line([(left+PANE_W-190,FOOTER+77),(left+PANE_W-160,FOOTER+106),(left+PANE_W-104,FOOTER+48)],fill='#080b0c',width=10)
        if index == min(120,round(META['fps']*META['duration'])-1):
            im.save(ROOT / 'tui-generated' / f'{TASK}-preview.png')
        if index in (0,last_frame):
            im.save(ROOT / 'tui-generated' / f'{TASK}-{"start" if index==0 else "final"}.png')
        if encoder: encoder.stdin.write(im.tobytes())
if encoder:
    encoder.stdin.close()
    if encoder.wait(): raise RuntimeError('Video encoding failed')
    temporary.replace(output)
    print(output)
