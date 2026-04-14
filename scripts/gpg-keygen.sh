#!/bin/bash
#
# GPG Key Generation Script for Notely Linux Package Signing
# This script generates a GPG key pair for signing Linux packages (deb, rpm, AppImage)
#
# Usage: ./scripts/gpg-keygen.sh
#

set -e

# Configuration
KEY_NAME="Notely Package Signing Key"
KEY_EMAIL="security@example.com"
KEY_COMMENT="Linux Package Signing"
KEY_EXPIRE="2y"  # Key expires in 2 years
KEY_TYPE="RSA"
KEY_LENGTH="4096"

# Output directories
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
KEYS_DIR="$PROJECT_ROOT/build/signing"
PUBLIC_KEY_FILE="$KEYS_DIR/notely-linux-signing.pub"
PRIVATE_KEY_FILE="$KEYS_DIR/notely-linux-signing.key"

echo "========================================"
echo "Notely GPG Key Generation"
echo "========================================"
echo ""

# Check if gpg is installed
if ! command -v gpg &> /dev/null; then
    echo "Error: gpg is not installed."
    echo "Install it with:"
    echo "  Ubuntu/Debian: sudo apt install gnupg"
    echo "  Fedora/RHEL:   sudo dnf install gnupg2"
    echo "  macOS:         brew install gnupg"
    exit 1
fi

# Create keys directory
mkdir -p "$KEYS_DIR"

# Check if key already exists
EXISTING_KEY=$(gpg --list-secret-keys --keyid-format LONG "$KEY_EMAIL" 2>/dev/null | grep -oP '(?<=sec\s{3}rsa4096/)[A-F0-9]+' || true)

if [ -n "$EXISTING_KEY" ]; then
    echo "Warning: A GPG key for $KEY_EMAIL already exists!"
    echo "Key ID: $EXISTING_KEY"
    echo ""
    read -p "Do you want to export the existing key instead? (y/n): " EXPORT_EXISTING

    if [ "$EXPORT_EXISTING" = "y" ] || [ "$EXPORT_EXISTING" = "Y" ]; then
        echo ""
        echo "Exporting existing key..."
        gpg --armor --export "$KEY_EMAIL" > "$PUBLIC_KEY_FILE"
        echo "Public key exported to: $PUBLIC_KEY_FILE"
        echo ""
        echo "To export the private key (for backup/CI), run:"
        echo "  gpg --armor --export-secret-keys $KEY_EMAIL > $PRIVATE_KEY_FILE"
        echo ""
        echo "Key ID for electron-builder: $EXISTING_KEY"
        exit 0
    else
        echo ""
        read -p "Do you want to generate a NEW key? This won't delete the old one. (y/n): " GEN_NEW
        if [ "$GEN_NEW" != "y" ] && [ "$GEN_NEW" != "Y" ]; then
            echo "Aborted."
            exit 0
        fi
    fi
fi

echo "Generating new GPG key pair..."
echo ""
echo "Key Details:"
echo "  Name:    $KEY_NAME"
echo "  Email:   $KEY_EMAIL"
echo "  Type:    $KEY_TYPE $KEY_LENGTH"
echo "  Expires: $KEY_EXPIRE"
echo ""

# Prompt for passphrase
echo "You will be prompted to enter a passphrase for the key."
echo "This passphrase will be needed for signing packages."
echo "IMPORTANT: Store this passphrase securely (e.g., in a password manager)."
echo ""

# Generate key using batch mode
# Note: For unattended generation, you can set --passphrase directly
# but for security, we use pinentry for interactive passphrase entry

cat > /tmp/gpg-key-params <<EOF
%echo Generating Notely package signing key
Key-Type: $KEY_TYPE
Key-Length: $KEY_LENGTH
Subkey-Type: $KEY_TYPE
Subkey-Length: $KEY_LENGTH
Name-Real: $KEY_NAME
Name-Comment: $KEY_COMMENT
Name-Email: $KEY_EMAIL
Expire-Date: $KEY_EXPIRE
%commit
%echo Key generation complete
EOF

gpg --batch --generate-key /tmp/gpg-key-params
rm /tmp/gpg-key-params

# Get the new key ID
NEW_KEY_ID=$(gpg --list-secret-keys --keyid-format LONG "$KEY_EMAIL" 2>/dev/null | grep -oP '(?<=sec\s{3}rsa4096/)[A-F0-9]+' | head -1)

if [ -z "$NEW_KEY_ID" ]; then
    echo "Error: Failed to retrieve the generated key ID."
    exit 1
fi

echo ""
echo "========================================"
echo "Key Generated Successfully!"
echo "========================================"
echo ""
echo "Key ID: $NEW_KEY_ID"
echo ""

# Export public key
gpg --armor --export "$KEY_EMAIL" > "$PUBLIC_KEY_FILE"
echo "Public key exported to: $PUBLIC_KEY_FILE"

echo ""
echo "========================================"
echo "Next Steps"
echo "========================================"
echo ""
echo "1. BACKUP YOUR KEY:"
echo "   Export private key for secure backup:"
echo "   gpg --armor --export-secret-keys $KEY_EMAIL > $PRIVATE_KEY_FILE"
echo ""
echo "2. SET ENVIRONMENT VARIABLES:"
echo "   Add to your shell profile or CI/CD secrets:"
echo "   export GPG_KEY_ID=\"$NEW_KEY_ID\""
echo "   export GPG_PASSPHRASE=\"<your-passphrase>\""
echo ""
echo "3. FOR CI/CD (GitHub Actions, etc.):"
echo "   - Store the private key as a secret (base64 encoded):"
echo "     gpg --armor --export-secret-keys $KEY_EMAIL | base64 -w 0"
echo "   - Store GPG_PASSPHRASE as a secret"
echo ""
echo "4. DISTRIBUTE PUBLIC KEY:"
echo "   - Host the public key at: https://yourdomain.com/gpg-key.asc"
echo "   - Add to your apt repository if hosting one"
echo ""
echo "5. BUILD SIGNED PACKAGES:"
echo "   npm run build:linux"
echo ""
echo "========================================"
