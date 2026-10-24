#!/usr/bin/env python3
"""Package an existing Godot Web export with the Eunnei viewing shell."""
import argparse
import hashlib
import json
import pathlib
import shutil
p = argparse.ArgumentParser()
p.add_argument('export_directory')
p.add_argument('output_directory')
a = p.parse_args()
source = pathlib.Path(a.export_directory).resolve()
out = pathlib.Path(a.output_directory).resolve()
if source == out or source in out.parents or out in source.parents:
    raise SystemExit('Export and package directories must not overlap')
if not (source / 'index.html').is_file() or not list(source.glob('*.wasm')):
    raise SystemExit('A complete Godot Web export is required')
out.mkdir(parents=True, exist_ok=True)
office = out / 'office'
office.mkdir(exist_ok=True)
shutil.copytree(source, office, dirs_exist_ok=True)

# The private Sites source transport rejects the 37 MB engine object. Keep the
# original export usable locally and split only its packaged copy. Eight MiB is
# comfortably below the transport's observed limit and common static-host caps.
chunk_size = 8 * 1024 * 1024
manifest = {}
for wasm in sorted(office.glob('*.wasm')):
    for stale in office.glob(wasm.name + '.part*'):
        stale.unlink()
    data = wasm.read_bytes()
    parts = []
    reconstructed = hashlib.sha256()
    for index, start in enumerate(range(0, len(data), chunk_size)):
        name = f'{wasm.name}.part{index:03d}'
        chunk = data[start:start + chunk_size]
        (office / name).write_bytes(chunk)
        reconstructed.update((office / name).read_bytes())
        parts.append(name)
    digest = hashlib.sha256(data).hexdigest()
    if reconstructed.hexdigest() != digest:
        raise SystemExit(f'Chunk verification failed: {wasm.name}')
    manifest[wasm.name] = {'parts': parts, 'size': len(data), 'sha256': digest}
    wasm.unlink()

# Intercept only these exact engine asset URLs. All API requests and other
# assets continue through native Fetch. Godot's own loader receives the same
# bytes and MIME type it expects, without changing its generated engine script.
loader = r'''(() => {
  const base = document.currentScript.src;
  const manifest = MANIFEST;
  const engines = new Map(Object.entries(manifest).map(([name, entry]) =>
    [new URL(name, base).href, entry]));
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : input, document.baseURI);
    const entry = engines.get(url.href);
    const method = init?.method || request?.method || 'GET';
    if (!entry || method.toUpperCase() !== 'GET') return nativeFetch(input, init);
    const options = {...init, signal: init?.signal || request?.signal};
    const buffers = await Promise.all(entry.parts.map(async name => {
      const response = await nativeFetch(new URL(name, base), options);
      if (!response.ok) throw new Error(`Failed loading engine chunk ${name}: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    }));
    const size = buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
    if (size !== entry.size) throw new Error('Engine download was incomplete. Please reload.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const buffer of buffers) { bytes.set(buffer, offset); offset += buffer.byteLength; }
    return new Response(bytes, {headers: {
      'Content-Type': 'application/wasm', 'Content-Length': String(size)
    }});
  };
})();
'''.replace('MANIFEST', json.dumps(manifest, separators=(',', ':')))
(office / 'wasm-chunks.js').write_text(loader)
(office / 'wasm-chunks.json').write_text(json.dumps(manifest, indent=2) + '\n')
html = (office / 'index.html').read_text()
marker = '<script src="index.js"></script>'
if html.count(marker) != 1:
    raise SystemExit('Expected the Godot index.js loader exactly once in index.html')
(office / 'index.html').write_text(html.replace(marker, '<script src="wasm-chunks.js"></script>\n\t\t' + marker))
shutil.copyfile(pathlib.Path(__file__).resolve().parents[1] / 'web/index.html', out / 'index.html')
print(f'Packaged {out}')
for name, entry in manifest.items():
    print(f'{name}: {len(entry["parts"])} chunks, SHA-256 {entry["sha256"]}')
