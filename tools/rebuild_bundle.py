#!/usr/bin/env python3
"""Re-pack index.html from source/ after editing the app.

index.html is a self-contained bundle: a JSON template (the page) plus a manifest of
gzip+base64 assets. This script swaps in the current source/ page markup and lib/*.js
files, keeping every other asset (React, pdf.js, fonts, the inlined CSS head) as is.

Usage: python3 tools/rebuild_bundle.py [--check]
  --check  exit 1 if index.html is out of date with source/ (writes nothing)
"""
import base64, gzip, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'source'
BUNDLE = ROOT / 'index.html'
LIBS = {'libEngine': 'lib/engine.js', 'libStore': 'lib/store.js', 'libImporter': 'lib/importer.js', 'libTests': 'lib/tests.js', 'libData': 'lib/data.js'}


def island(html, kind):
    m = re.search(r'(<script type="__bundler/%s">)(.*?)(</script>)' % kind, html, re.S)
    return m


def decode(entry):
    b = base64.b64decode(entry['data'])
    return gzip.decompress(b) if entry.get('compressed') else b


def encode(entry, raw):
    data = gzip.compress(raw, mtime=0) if entry.get('compressed') else raw
    return {**entry, 'data': base64.b64encode(data).decode()}


def camel_attrs(markup):
    # The bundle stores camelCase attributes (onClick, onChange, …) as sc-camel-on-click etc.
    def fix_tag(t):
        return re.sub(r'(\s)([a-z]+[A-Z][A-Za-z]*)(=)', lambda m: m.group(1) + 'sc-camel-' + re.sub(r'[A-Z]', lambda c: '-' + c.group(0).lower(), m.group(2)) + m.group(3), t.group(0))
    return re.sub(r'<[a-zA-Z][^<>]*>', fix_tag, markup)


def build(html):
    man_m, tpl_m, ext_m = island(html, 'manifest'), island(html, 'template'), island(html, 'ext_resources')
    manifest = json.loads(man_m.group(2))
    template = json.loads(tpl_m.group(2))
    ext = {r['id']: r['uuid'] for r in json.loads(ext_m.group(2))}

    # lib/*.js
    for rid, rel in LIBS.items():
        uuid = ext[rid]
        raw = (SRC / rel).read_bytes()
        if decode(manifest[uuid]) != raw:
            manifest[uuid] = encode(manifest[uuid], raw)

    # icons: match bundle assets to source files by content
    icon_uuid = {}
    for f in sorted((SRC / 'icons').glob('*.svg')):
        b = f.read_bytes()
        for uuid, e in manifest.items():
            if e['mime'] == 'image/svg+xml' and decode(e) == b:
                icon_uuid['icons/' + f.name] = uuid

    # page: keep the bundled <head>…</helmet> (inlined CSS/fonts), replace the rest from source
    page = (SRC / 'Meal Planner.dc.html').read_text(encoding='utf-8')
    head_end = template.index('</helmet>') + len('</helmet>')
    body = page[page.index('</helmet>') + len('</helmet>'):]
    script_at = body.index('<script type="text/x-dc" data-dc-script>')
    markup, script = body[:script_at], body[script_at:]
    for path in re.findall(r'src="(icons/[^"]+)"', markup):
        if path not in icon_uuid:
            sys.exit(f'{path} is not in the bundle; add it to the manifest first')
    markup = re.sub(r'src="(icons/[^"]+)"', lambda m: 'src="%s"' % icon_uuid[m.group(1)], markup)
    markup = camel_attrs(markup)
    markup = re.sub(r'<(/?)select\b', r'<\1sc-raw-select', markup)
    script = script.replace('data-dc-script>', 'data-dc-script="">', 1)
    script = re.sub(r'\n?</body>\s*</html>\s*$', '\n\n\n</body></html>', script)
    template = template[:head_end] + markup + script

    def put(h, m, text):
        return h[:m.start(2)] + text + h[m.end(2):]
    out = put(html, tpl_m, '\n' + json.dumps(template, ensure_ascii=False).replace('</', '<\\u002F') + '\n  ')
    out = put(out, island(out, 'manifest'), '\n' + json.dumps(manifest, separators=(',', ':')) + '\n  ')
    return out


if __name__ == '__main__':
    html = BUNDLE.read_text(encoding='utf-8')
    out = build(html)
    if '--check' in sys.argv:
        print('index.html is up to date' if out == html else 'index.html is out of date; run tools/rebuild_bundle.py')
        sys.exit(0 if out == html else 1)
    BUNDLE.write_text(out, encoding='utf-8')
    print('index.html rebuilt' if out != html else 'index.html already up to date')
