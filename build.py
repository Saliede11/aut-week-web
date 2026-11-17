#!/usr/bin/env python3
"""Builds the static web app into dist/ (run by GitHub Actions; also runnable locally)."""
import base64, hashlib, json, os, re, shutil, sys, urllib.request

SRC, OUT = 'src', 'dist'
FONT_BASE = 'https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/fonts/webfonts/Vazirmatn-%s.woff2'


def read(p, mode='r'):
    with open(p, mode, **({} if 'b' in mode else {'encoding': 'utf-8'})) as f:
        return f.read()


def write(p, data):
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    with open(p, 'wb') as f:
        f.write(data if isinstance(data, bytes) else data.encode('utf-8'))


shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)

# --- Persian font (soft fail: the app still works with the system font)
fonts = []
for w in ('Regular', 'Medium', 'SemiBold', 'Bold'):
    try:
        with urllib.request.urlopen(FONT_BASE % w, timeout=40) as r:
            data = r.read()
        if len(data) > 1000:
            write('%s/fonts/Vazirmatn-%s.woff2' % (OUT, w), data)
            fonts.append('fonts/Vazirmatn-%s.woff2' % w)
    except Exception as e:  # noqa
        print('font %s failed: %s' % (w, e))
print('fonts:', fonts)

# --- connector (runs inside the reservation site's page); pinned by SRI
def ascii_only(t):
    # the connector runs inside another site's page: keep it pure ASCII so the page's charset can never garble it
    return ''.join(c if ord(c) < 128 else ('\\u%04x' % ord(c) if ord(c) < 0x10000 else '\\u%04x\\u%04x' % (0xD800 + ((ord(c) - 0x10000) >> 10), 0xDC00 + ((ord(c) - 0x10000) & 0x3FF))) for c in t)


bridge = ascii_only(read(SRC + '/sync.js') + read(SRC + '/bridge-glue.js')).encode('ascii')
sri = 'sha384-' + base64.b64encode(hashlib.sha384(bridge).digest()).decode()
bridge_name = 'bridge-%s.js' % hashlib.sha256(bridge).hexdigest()[:10]
write('%s/%s' % (OUT, bridge_name), bridge)

# --- static files
for f in ('web-adapter.js', 'manifest.webmanifest'):
    shutil.copyfile('%s/%s' % (SRC, f), '%s/%s' % (OUT, f))
os.makedirs(OUT + '/icons', exist_ok=True)
for n in (180, 192, 512):
    shutil.copyfile('%s/icons/icon-%d.png' % (SRC, n), '%s/icons/icon-%d.png' % (OUT, n))

# --- page
html = read(SRC + '/index.html')
extra = ('<meta name="aw-bridge" content="%s" data-sri="%s">\n'
         '<link rel="manifest" href="manifest.webmanifest">\n'
         '<link rel="apple-touch-icon" href="icons/icon-180.png">\n'
         '<meta name="theme-color" content="#0f6b7a">\n'
         '<script src="web-adapter.js"></script>\n') % (bridge_name, sri)
marker = '<title>برنامه هفتگی</title>'
assert html.count(marker) == 1, 'title marker not found'
html = html.replace(marker, marker + '\n' + extra, 1)
write(OUT + '/index.html', html)

# --- service worker (offline copy of the app shell)
files = ['./', 'index.html', 'web-adapter.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'] + fonts
ver = hashlib.sha256(b''.join(read('%s/%s' % (OUT, f), 'rb') for f in files if f != './')).hexdigest()[:10]
sw = read(SRC + '/sw.template.js').replace('__VER__', ver).replace('__FILES__', json.dumps(files))
write(OUT + '/sw.js', sw)
write(OUT + '/.nojekyll', b'')

print('built', OUT, '| connector:', bridge_name, sri[:24] + '…', '| version:', ver)
