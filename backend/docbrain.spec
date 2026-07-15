# PyInstaller spec: bundles the DocBrain engine + pre-built frontend into a
# single executable that runs with no separate Python install required.
#
# Build:  pyinstaller docbrain.spec --noconfirm
# Output: dist/DocBrain.exe (this spec's own dist/ folder, not frontend/dist)
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

block_cipher = None

datas = []
binaries = []
hiddenimports = []

# fastembed depends on onnxruntime + tokenizers + huggingface_hub, all of
# which ship native libs / data files that PyInstaller can't infer on its own.
for pkg in ("fastembed", "onnxruntime", "tokenizers", "huggingface_hub"):
    datas += collect_data_files(pkg)
    binaries += collect_dynamic_libs(pkg)
    hiddenimports += collect_submodules(pkg)

hiddenimports += [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "sqlite_vec",
    "docx",
    "openpyxl",
    "pptx",
    "striprtf",
    "keyring.backends",
    "PIL",
    "watchdog.observers",
]

# The pre-built frontend, so the exe serves the identical browser UI --
# lands under sys._MEIPASS/frontend_dist at runtime (see app/api.py).
datas.append(("../frontend/dist", "frontend_dist"))

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="DocBrain",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,  # keep a console window so startup errors are visible
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
