# Build the audio-engine (transcription server) as a standalone executable for Windows
# Usage: .\build_server.ps1 [arch]
#   arch: x64 (defaults to x64)

param(
    [string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "=== Building Notely Audio Engine ===" -ForegroundColor Cyan
Write-Host "Working directory: $ScriptDir"
Write-Host "Target architecture: $Arch"

# Check for virtual environment
if (Test-Path ".venv") {
    Write-Host "Activating virtual environment..."
    & ".\.venv\Scripts\Activate.ps1"
} else {
    Write-Host "ERROR: Virtual environment not found at .venv" -ForegroundColor Red
    Write-Host "Please create it first:"
    Write-Host "  python -m venv .venv"
    Write-Host "  .\.venv\Scripts\Activate.ps1"
    Write-Host "  pip install -r requirements.txt"
    exit 1
}

# Install PyInstaller if not present
try {
    python -c "import PyInstaller" 2>$null
} catch {
    Write-Host "Installing PyInstaller..."
    pip install pyinstaller
}

# Clean previous builds
Write-Host "Cleaning previous builds..."
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue build, dist

# Build the executable
Write-Host "Building executable with PyInstaller..."
python -m PyInstaller whisper_server.spec --clean

# Check if build succeeded
$BinaryPath = "dist\audio-engine.exe"
if (Test-Path $BinaryPath) {
    Write-Host ""
    Write-Host "=== Build Successful ===" -ForegroundColor Green
    Write-Host "Executable: $ScriptDir\$BinaryPath"
    Get-Item $BinaryPath | Select-Object Name, Length

    # Copy to resources directory for electron-builder
    $ResourcesDir = Join-Path $ScriptDir "..\..\..\resources\audio-engine-$Arch"
    New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null

    Write-Host ""
    Write-Host "Copying to resources directory: $ResourcesDir"
    Copy-Item $BinaryPath $ResourcesDir

    # Copy the model if it exists
    $ModelSrc = Join-Path $ScriptDir "models\ctranslate2\small.en"
    $ModelDest = Join-Path $ResourcesDir "models\small.en"

    if (Test-Path $ModelSrc) {
        Write-Host "Copying small.en model..."
        New-Item -ItemType Directory -Force -Path $ModelDest | Out-Null
        Copy-Item -Recurse "$ModelSrc\*" $ModelDest
        Write-Host "Model copied to: $ModelDest"
    } else {
        Write-Host "WARNING: Model not found at $ModelSrc" -ForegroundColor Yellow
        Write-Host "Models will be downloaded on first use from Hugging Face."
    }

    Write-Host ""
    Write-Host "Resources ready for bundling ($Arch):" -ForegroundColor Cyan
    Get-ChildItem $ResourcesDir
} else {
    Write-Host "ERROR: Build failed - executable not found" -ForegroundColor Red
    exit 1
}
