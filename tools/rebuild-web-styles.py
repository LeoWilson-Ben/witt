#!/usr/bin/env python3
"""Rebuild the two Witt CSS bundles in manifest order, preserving the critical inline layer."""
import json
from pathlib import Path
import sys
root=Path(sys.argv[1] if len(sys.argv)>1 else str(Path(__file__).resolve().parents[1] / 'web'))
manifest=json.loads((root/'web-style-manifest.json').read_text())
for target,sources in manifest.items():
 content='\n\n'.join('/* '+name+' */\n'+(root/name).read_text() for name in sources)
 temp=root/(target+'.tmp');temp.write_text(content);temp.replace(root/target)
print('Witt styles rebuilt: 2 bundles')
