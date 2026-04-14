#!/bin/bash
#
# GPG CI/CD Setup Script for Notely Linux Package Signing
# This script imports a GPG key from environment variables for use in CI/CD pipelines
#
# Usage: ./scripts/setup-gpg-ci.sh
#
# Required environment variables:
#   GPG_PRIVATE_KEY_BASE64 - Base64-encoded GPG private key
#   GPG_PASSPHRASE         - Passphrase for the GPG key
#
# Optional environment variables:
#   GPG_KEY_ID             - Key ID (will be auto-detected if not set)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo "========================================"
echo "Notely GPG CI/CD Setup"
echo "========================================"
echo ""

# Check required environment variables
if [ -z "$GPG_PRIVATE_KEY_BASE64" ]; then
    log_error "GPG_PRIVATE_KEY_BASE64 environment variable is not set."
    echo ""
    echo "To create this value from your local key:"
    echo "  gpg --armor --export-secret-keys YOUR_KEY_EMAIL | base64 -w 0"
    echo ""
    echo "Then set it as a secret in your CI/CD system."
    exit 1
fi

if [ -z "$GPG_PASSPHRASE" ]; then
    log_warn "GPG_PASSPHRASE is not set. Signing may require interactive input."
fi

# Configure GPG for non-interactive use
log_info "Configuring GPG for non-interactive use..."

mkdir -p ~/.gnupg
chmod 700 ~/.gnupg

# Disable TTY requirement for GPG
cat > ~/.gnupg/gpg.conf <<EOF
# Disable TTY requirement
no-tty
# Use loopback pinentry for passphrase
pinentry-mode loopback
# Batch mode
batch
# Trust imported keys
trust-model always
EOF

cat > ~/.gnupg/gpg-agent.conf <<EOF
# Allow loopback pinentry
allow-loopback-pinentry
# No TTY
default-cache-ttl 31536000
max-cache-ttl 31536000
EOF

chmod 600 ~/.gnupg/gpg.conf ~/.gnupg/gpg-agent.conf

# Restart GPG agent
log_info "Restarting GPG agent..."
gpgconf --kill gpg-agent 2>/dev/null || true
gpg-agent --daemon 2>/dev/null || true

# Import the private key
log_info "Importing GPG private key..."

# Decode and import
echo "$GPG_PRIVATE_KEY_BASE64" | base64 -d | gpg --batch --yes --import

if [ $? -ne 0 ]; then
    log_error "Failed to import GPG key."
    exit 1
fi

log_info "GPG key imported successfully."

# Get key ID if not set
if [ -z "$GPG_KEY_ID" ]; then
    log_info "Detecting GPG key ID..."
    GPG_KEY_ID=$(gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep -oP '(?<=sec\s{3}rsa4096/)[A-F0-9]+' | head -1)

    if [ -z "$GPG_KEY_ID" ]; then
        # Try different format
        GPG_KEY_ID=$(gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep -E "^sec" | head -1 | awk '{print $2}' | cut -d'/' -f2)
    fi

    if [ -z "$GPG_KEY_ID" ]; then
        log_error "Could not detect GPG key ID."
        echo "Available keys:"
        gpg --list-secret-keys
        exit 1
    fi

    log_info "Detected key ID: $GPG_KEY_ID"
    echo "export GPG_KEY_ID=\"$GPG_KEY_ID\"" >> "$GITHUB_ENV" 2>/dev/null || true
fi

# Trust the key
log_info "Setting key trust level..."
echo -e "5\ny\n" | gpg --command-fd 0 --edit-key "$GPG_KEY_ID" trust quit 2>/dev/null || true

# Test signing
log_info "Testing GPG signing..."
TEST_FILE=$(mktemp)
echo "test" > "$TEST_FILE"

if [ -n "$GPG_PASSPHRASE" ]; then
    echo "$GPG_PASSPHRASE" | gpg --batch --yes --passphrase-fd 0 \
        --pinentry-mode loopback \
        --default-key "$GPG_KEY_ID" \
        --armor --detach-sign \
        --output "${TEST_FILE}.sig" \
        "$TEST_FILE" 2>/dev/null
else
    gpg --batch --yes \
        --default-key "$GPG_KEY_ID" \
        --armor --detach-sign \
        --output "${TEST_FILE}.sig" \
        "$TEST_FILE" 2>/dev/null
fi

if [ -f "${TEST_FILE}.sig" ]; then
    log_info "GPG signing test successful!"
    rm -f "$TEST_FILE" "${TEST_FILE}.sig"
else
    log_error "GPG signing test failed."
    rm -f "$TEST_FILE"
    exit 1
fi

echo ""
echo "========================================"
echo "GPG Setup Complete!"
echo "========================================"
echo ""
echo "Key ID: $GPG_KEY_ID"
echo ""
echo "You can now run:"
echo "  npm run build:linux:signed"
echo "  npm run sign:linux"
echo ""
