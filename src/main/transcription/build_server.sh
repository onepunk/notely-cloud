#!/bin/bash
# Build the audio-engine (transcription server) as a standalone executable
# This script should be run from the transcription directory
#
# Usage: ./build_server.sh [arch]
#   arch: arm64 or x64 (defaults to current machine architecture)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Detect or use specified architecture
if [ -n "$1" ]; then
    ARCH="$1"
else
    MACHINE_ARCH=$(uname -m)
    if [ "$MACHINE_ARCH" = "arm64" ]; then
        ARCH="arm64"
    else
        ARCH="x64"
    fi
fi

echo "=== Building Notely Audio Engine ==="
echo "Working directory: $SCRIPT_DIR"
echo "Target architecture: $ARCH"

# Activate virtual environment
if [ -d ".venv" ]; then
    echo "Activating virtual environment..."
    source .venv/bin/activate
else
    echo "ERROR: Virtual environment not found at .venv"
    echo "Please create it first: python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

# Install PyInstaller if not present
if ! .venv/bin/python3 -c "import PyInstaller" 2>/dev/null; then
    echo "Installing PyInstaller..."
    .venv/bin/python3 -m pip install pyinstaller
fi

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf build/ dist/

# Build the executable
echo "Building executable with PyInstaller..."
.venv/bin/python3 -m PyInstaller whisper_server.spec --clean

# Check if build succeeded
if [ -f "dist/audio-engine" ]; then
    echo ""
    echo "=== Build Successful ==="
    echo "Executable: $SCRIPT_DIR/dist/audio-engine"
    ls -lh dist/audio-engine

    # Copy to architecture-specific resources directory for electron-builder
    RESOURCES_DIR="$SCRIPT_DIR/../../../resources/audio-engine-${ARCH}"
    mkdir -p "$RESOURCES_DIR"

    echo ""
    echo "Copying to resources directory: $RESOURCES_DIR"
    cp dist/audio-engine "$RESOURCES_DIR/"

    # Copy the model if it exists
    MODEL_SRC="$SCRIPT_DIR/models/ctranslate2/small.en"
    MODEL_DEST="$RESOURCES_DIR/models/small.en"

    if [ -d "$MODEL_SRC" ]; then
        echo "Copying small.en model..."
        mkdir -p "$MODEL_DEST"
        cp -r "$MODEL_SRC"/* "$MODEL_DEST/"
        echo "Model copied to: $MODEL_DEST"
        du -sh "$MODEL_DEST"
    else
        echo "WARNING: Model not found at $MODEL_SRC"
        echo "You may need to download it or copy from ~/.cache/huggingface/hub/models--Systran--faster-whisper-small.en/"
    fi

    echo ""
    echo "Resources ready for bundling ($ARCH):"
    ls -la "$RESOURCES_DIR/"
    if [ -d "$RESOURCES_DIR/models" ]; then
        echo ""
        echo "Models:"
        ls -la "$RESOURCES_DIR/models/"
    fi
else
    echo "ERROR: Build failed - executable not found"
    exit 1
fi
