#!/usr/bin/env python3
"""Package an existing Godot Web export with the Eunnei viewing shell."""
import argparse
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
shutil.copytree(source, out / 'office', dirs_exist_ok=True)
shutil.copyfile(pathlib.Path(__file__).resolve().parents[1] / 'web/index.html', out / 'index.html')
print(f'Packaged {out}')
