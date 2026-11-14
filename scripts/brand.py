"""Generate outlined Solara mark/lockup SVGs. Mark geometry = the in-app #m symbol (index.html)."""
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
FONT,OUT=sys.argv[1],sys.argv[2]
SIZE=40.0
f=TTFont(FONT);gs=f.getGlyphSet();cmap=f.getBestCmap();upm=f['head'].unitsPerEm;hm=f['hmtx'];s=SIZE/upm
def text(txt,x0,base):
  pen=SVGPathPen(gs);bp=BoundsPen(gs);x=x0
  for ch in txt:
    g=cmap[ord(ch)];t=(s,0,0,-s,x,base);gs[g].draw(TransformPen(pen,t));gs[g].draw(TransformPen(bp,t));x+=hm[g][0]*s
  return pen.getCommands(),bp.bounds
MARK='''<g transform="translate({dx:.2f} {dy:.2f}) scale({k:.4f})" fill="{c}" stroke="{c}" stroke-linecap="round" stroke-linejoin="round">
<path d="M18 42a14 14 0 0 1 28 0z" stroke="none"/><path d="M32 14v8M12.2 22.2l5.7 5.7M51.8 22.2l-5.7 5.7M8 47h48M18 54h28" fill="none" stroke-width="3.2"/></g>'''
# mark visible bounds in its 64 grid: x 6.4..57.6, y 12.4..55.6
for name,c in [('mark-coral','#F25C54'),('mark-cream','#FFF6E5')]:
  open(f'{OUT}/solara-{name}.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 11 54 46" role="img" aria-label="Solara">{MARK.format(dx=0,dy=0,k=1,c=c)}</svg>\n')
xh=f['OS/2'].sxHeight*s
k=xh/ (42-14)*1.15          # sun+rays height ~ x-height
base=0.0
dy=base-47*k                 # horizon line on the baseline
dx=-6.4*k
tx=dx+57.6*k+0.3*SIZE
d,(x1,y1,x2,y2)=text('solara',tx,base)
top=min(y1,dy+12.4*k);bot=max(y2,dy+55.6*k);P=4
vb=f'{-P:.2f} {top-P:.2f} {x2+2*P:.2f} {bot-top+2*P:.2f}'
for name,mc,tc in [('logo-light-bg','#F25C54','#183F3D'),('logo-dark-bg','#F25C54','#FFF6E5')]:
  open(f'{OUT}/solara-{name}.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="Solara">\n{MARK.format(dx=dx,dy=dy,k=k,c=mc)}\n<path fill="{tc}" d="{d}"/>\n</svg>\n')
print('ok')
