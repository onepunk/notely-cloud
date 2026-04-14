# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec file for Notely Audio Engine (Transcription Server)

This creates a standalone executable that includes:
- FastAPI/Uvicorn server
- faster-whisper inference engine
- CTranslate2 runtime
- All required dependencies

The model files are NOT bundled here - they are included separately
via electron-builder's extraResources.
"""

import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# Collect all submodules for packages that have hidden imports
hiddenimports = [
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'faster_whisper',
    'ctranslate2',
    'huggingface_hub',
    'tokenizers',
    'soundfile',
    'numpy',
    'scipy',
    'scipy.signal',
]

# Add all ctranslate2 submodules
hiddenimports += collect_submodules('ctranslate2')
hiddenimports += collect_submodules('faster_whisper')

# Collect data files needed by packages
datas = []
datas += collect_data_files('faster_whisper')
datas += collect_data_files('ctranslate2')

a = Analysis(
    ['server_v3.py', 'utils.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'PIL',
        'cv2',
        'torch',  # We use ctranslate2, not torch for inference
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='audio-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
