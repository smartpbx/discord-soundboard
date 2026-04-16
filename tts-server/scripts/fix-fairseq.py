#!/usr/bin/env python3
"""Patch fairseq 0.12.2 dataclass bug for Python 3.11+ compatibility.

fairseq uses mutable class defaults in dataclass fields like:
    common: CommonConfig = CommonConfig
Python 3.11+ rejects this. This script rewrites them to:
    common: CommonConfig = field(default_factory=CommonConfig)
"""
import re
import inspect

import fairseq.dataclass.configs as c

path = inspect.getfile(c)
print(f"Patching: {path}")

with open(path) as f:
    src = f.read()

original = src

# Fix: SomeField = SomeClass()  ->  SomeField = field(default_factory=SomeClass)
src = re.sub(
    r'^(\s+\w+:\s+\w+)\s*=\s*(\w+)\(\)\s*$',
    r'\1 = field(default_factory=\2)',
    src,
    flags=re.MULTILINE,
)

# Fix: some_field: SomeConfig = SomeConfig  ->  some_field: SomeConfig = field(default_factory=SomeConfig)
src = re.sub(
    r'^(\s+)(\w+):\s+(\w+Config)\s*=\s*(\3)\s*$',
    r'\1\2: \3 = field(default_factory=\4)',
    src,
    flags=re.MULTILINE,
)

# Ensure 'field' is imported from dataclasses
if 'from dataclasses import' in src:
    imports_line = src.split('from dataclasses import')[1].split('\n')[0]
    if 'field' not in imports_line:
        src = src.replace(
            'from dataclasses import dataclass',
            'from dataclasses import dataclass, field',
        )

if src != original:
    with open(path, 'w') as f:
        f.write(src)
    print("Patched successfully.")
else:
    print("No changes needed (already patched or different format).")
