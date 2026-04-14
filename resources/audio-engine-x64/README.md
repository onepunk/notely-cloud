# Audio Engine (x64/Intel)

This directory should contain the audio-engine binary built for Intel Macs (x64).

## Building the binary

The audio-engine binary must be built on an Intel Mac or via cross-compilation.

1. On an Intel Mac, run:

   ```bash
   cd src/main/transcription
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   pip install pyinstaller
   ./build_server.sh x64
   ```

2. The binary will be copied to `resources/audio-engine-x64/audio-engine`

## CI/CD Note

For automated builds, consider using GitHub Actions with both `macos-latest` (arm64)
and `macos-13` (Intel) runners to build architecture-specific binaries.
