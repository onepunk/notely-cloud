# Audio Engine (arm64/Apple Silicon)

This directory should contain the audio-engine binary built for Apple Silicon Macs (arm64).

## Building the binary

The binary is automatically built by GitHub Actions CI. For local development:

```bash
cd src/main/transcription
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install pyinstaller
./build_server.sh arm64
```

The binary will be copied to `resources/audio-engine-arm64/audio-engine`
