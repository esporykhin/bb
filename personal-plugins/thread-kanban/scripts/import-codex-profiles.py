import argparse
import json
import os
from pathlib import Path
import sys
import tomllib

parser = argparse.ArgumentParser(description='Export Codex role instructions for the Thread Kanban profiles_import RPC.')
parser.add_argument('--config', type=Path, default=Path.home() / '.codex/config.toml')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
config = args.config.expanduser().resolve()
settings = tomllib.loads(config.read_text())
profiles = {}
configured_names = {name for name, descriptor in settings.get('agents', {}).items() if isinstance(descriptor, dict)}
for name, descriptor in settings.get('agents', {}).items():
    if not isinstance(descriptor, dict) or not descriptor.get('config_file'):
        continue
    path = (config.parent / descriptor['config_file']).resolve()
    role = tomllib.loads(path.read_text())
    instructions = role.get('developer_instructions', '').strip()
    if not instructions:
        continue
    profiles[name] = {'id': name, 'name': name, 'instructions': instructions}
for path in sorted((config.parent / 'agents').glob('*.toml')):
    try:
        role = tomllib.loads(path.read_text())
        name = role.get('name')
        if not isinstance(name, str) or not name.strip() or name in configured_names or name in profiles:
            continue
        instructions = role.get('developer_instructions', '')
        if not isinstance(instructions, str) or not instructions.strip():
            continue
        profiles[name] = {'id': name, 'name': name, 'instructions': instructions.strip()}
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        print(f'Skipped malformed role file {path.name}: {type(error).__name__}', file=sys.stderr)
if not profiles:
    raise SystemExit('No role instructions were found in the supplied Codex configuration.')
output = args.output.expanduser()
fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as stream:
    json.dump({'profiles': list(profiles.values())}, stream, ensure_ascii=False)
print(f'Exported {len(profiles)} profiles to {output}. Provider model and permissions are not imported.', file=sys.stderr)
