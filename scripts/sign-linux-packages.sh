#!/bin/bash
#
# Sign Linux Packages Script for Notely
# Signs .deb and .rpm files with GPG
#
# Usage: ./scripts/sign-linux-packages.sh [--key-id KEY_ID]
#
# Environment variables:
#   GPG_KEY_ID     - The GPG key ID to use for signing
#   GPG_PASSPHRASE - The passphrase for the GPG key (optional, will prompt if not set)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_ROOT/dist"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --key-id)
            GPG_KEY_ID="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [--key-id KEY_ID]"
            echo ""
            echo "Signs Linux packages (.deb, .rpm) with GPG"
            echo ""
            echo "Options:"
            echo "  --key-id KEY_ID   GPG key ID to use (or set GPG_KEY_ID env var)"
            echo ""
            echo "Environment variables:"
            echo "  GPG_KEY_ID        The GPG key ID to use for signing"
            echo "  GPG_PASSPHRASE    The passphrase for the GPG key"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

echo "========================================"
echo "Notely Linux Package Signing"
echo "========================================"
echo ""

# Check for GPG key ID
if [ -z "$GPG_KEY_ID" ]; then
    log_error "GPG_KEY_ID is not set."
    echo "Set it via environment variable or --key-id argument."
    echo ""
    echo "Available signing keys:"
    gpg --list-secret-keys --keyid-format LONG 2>/dev/null | grep -E "^sec|^uid" || echo "No keys found"
    exit 1
fi

log_info "Using GPG Key ID: $GPG_KEY_ID"

# Verify key exists
if ! gpg --list-secret-keys "$GPG_KEY_ID" &>/dev/null; then
    log_error "GPG key $GPG_KEY_ID not found in keyring."
    exit 1
fi

# Check for required tools
check_tool() {
    if command -v "$1" &>/dev/null; then
        log_info "Found: $1"
        return 0
    else
        log_warn "Not found: $1 - $2 signing will be skipped"
        return 1
    fi
}

echo ""
log_info "Checking required tools..."
HAS_DPKG_SIG=false
HAS_RPM=false

if check_tool "dpkg-sig" ".deb"; then
    HAS_DPKG_SIG=true
fi

if check_tool "rpm" ".rpm"; then
    HAS_RPM=true
fi

# GPG is required
if ! command -v gpg &>/dev/null; then
    log_error "gpg is required but not installed."
    exit 1
fi

# Check for packages to sign
echo ""
log_info "Looking for packages in: $DIST_DIR"

DEB_FILES=$(find "$DIST_DIR" -maxdepth 1 -name "*.deb" 2>/dev/null || true)
RPM_FILES=$(find "$DIST_DIR" -maxdepth 1 -name "*.rpm" 2>/dev/null || true)

if [ -z "$DEB_FILES" ] && [ -z "$RPM_FILES" ]; then
    log_error "No packages found to sign in $DIST_DIR"
    echo "Run 'npm run build:linux' first to create packages."
    exit 1
fi

# Setup GPG agent for non-interactive signing
setup_gpg_agent() {
    if [ -n "$GPG_PASSPHRASE" ]; then
        log_info "Configuring GPG agent for non-interactive signing..."

        # Start gpg-agent if not running
        gpg-agent --daemon 2>/dev/null || true

        # Cache the passphrase
        echo "$GPG_PASSPHRASE" | gpg --batch --yes --passphrase-fd 0 \
            --pinentry-mode loopback \
            -o /dev/null -s /dev/null 2>/dev/null || true
    fi
}

setup_gpg_agent

SIGNED_COUNT=0
FAILED_COUNT=0

# Sign .deb files
if [ -n "$DEB_FILES" ]; then
    echo ""
    echo "----------------------------------------"
    log_info "Signing .deb packages..."
    echo "----------------------------------------"

    if [ "$HAS_DPKG_SIG" = true ]; then
        for deb in $DEB_FILES; do
            log_info "Signing: $(basename "$deb")"

            if [ -n "$GPG_PASSPHRASE" ]; then
                echo "$GPG_PASSPHRASE" | dpkg-sig --sign builder -k "$GPG_KEY_ID" \
                    --gpg-options "--batch --yes --passphrase-fd 0 --pinentry-mode loopback" \
                    "$deb" && {
                    log_info "Successfully signed: $(basename "$deb")"
                    ((SIGNED_COUNT++))
                } || {
                    log_error "Failed to sign: $(basename "$deb")"
                    ((FAILED_COUNT++))
                }
            else
                dpkg-sig --sign builder -k "$GPG_KEY_ID" "$deb" && {
                    log_info "Successfully signed: $(basename "$deb")"
                    ((SIGNED_COUNT++))
                } || {
                    log_error "Failed to sign: $(basename "$deb")"
                    ((FAILED_COUNT++))
                }
            fi

            # Verify signature
            log_info "Verifying signature..."
            dpkg-sig --verify "$deb" || log_warn "Signature verification returned non-zero"
        done
    else
        log_warn "dpkg-sig not installed. Install with: sudo apt install dpkg-sig"
        log_warn "Skipping .deb signing."
    fi
fi

# Sign .rpm files
if [ -n "$RPM_FILES" ]; then
    echo ""
    echo "----------------------------------------"
    log_info "Signing .rpm packages..."
    echo "----------------------------------------"

    if [ "$HAS_RPM" = true ]; then
        # Setup RPM macros for GPG signing
        mkdir -p ~/.gnupg

        # Create/update ~/.rpmmacros
        cat > ~/.rpmmacros <<EOF
%_signature gpg
%_gpg_name $GPG_KEY_ID
%__gpg /usr/bin/gpg
EOF

        for rpm_file in $RPM_FILES; do
            log_info "Signing: $(basename "$rpm_file")"

            if [ -n "$GPG_PASSPHRASE" ]; then
                echo "$GPG_PASSPHRASE" | rpm --addsign "$rpm_file" \
                    --define "_gpg_sign_cmd_extra_args --batch --yes --passphrase-fd 0 --pinentry-mode loopback" \
                    && {
                    log_info "Successfully signed: $(basename "$rpm_file")"
                    ((SIGNED_COUNT++))
                } || {
                    log_error "Failed to sign: $(basename "$rpm_file")"
                    ((FAILED_COUNT++))
                }
            else
                rpm --addsign "$rpm_file" && {
                    log_info "Successfully signed: $(basename "$rpm_file")"
                    ((SIGNED_COUNT++))
                } || {
                    log_error "Failed to sign: $(basename "$rpm_file")"
                    ((FAILED_COUNT++))
                }
            fi

            # Verify signature
            log_info "Verifying signature..."
            rpm --checksig "$rpm_file" || log_warn "Signature verification returned non-zero"
        done
    else
        log_warn "rpm not installed. Install with: sudo apt install rpm"
        log_warn "Skipping .rpm signing."
    fi
fi

# Generate checksums
echo ""
echo "----------------------------------------"
log_info "Generating SHA256 checksums..."
echo "----------------------------------------"

CHECKSUMS_FILE="$DIST_DIR/SHA256SUMS"
rm -f "$CHECKSUMS_FILE"

cd "$DIST_DIR"
for pkg in *.deb *.rpm 2>/dev/null; do
    if [ -f "$pkg" ]; then
        sha256sum "$pkg" >> "$CHECKSUMS_FILE"
        log_info "Checksum: $pkg"
    fi
done

# Sign the checksums file
if [ -f "$CHECKSUMS_FILE" ]; then
    log_info "Signing checksums file..."

    if [ -n "$GPG_PASSPHRASE" ]; then
        echo "$GPG_PASSPHRASE" | gpg --batch --yes --passphrase-fd 0 \
            --pinentry-mode loopback \
            --default-key "$GPG_KEY_ID" \
            --armor --detach-sign \
            --output "${CHECKSUMS_FILE}.sig" \
            "$CHECKSUMS_FILE"
    else
        gpg --default-key "$GPG_KEY_ID" \
            --armor --detach-sign \
            --output "${CHECKSUMS_FILE}.sig" \
            "$CHECKSUMS_FILE"
    fi

    log_info "Signed checksums: SHA256SUMS.sig"
fi

cd "$PROJECT_ROOT"

# Summary
echo ""
echo "========================================"
echo "Signing Complete!"
echo "========================================"
echo ""
echo "Signed: $SIGNED_COUNT packages"
if [ $FAILED_COUNT -gt 0 ]; then
    echo "Failed: $FAILED_COUNT packages"
fi
echo ""
echo "Output files in $DIST_DIR:"
ls -la "$DIST_DIR"/*.deb "$DIST_DIR"/*.rpm "$DIST_DIR"/*.sig "$DIST_DIR"/SHA256SUMS* 2>/dev/null || true
echo ""
echo "----------------------------------------"
echo "Distribution Instructions:"
echo "----------------------------------------"
echo ""
echo "1. Upload packages and signature files to your download server"
echo "2. Host your public key at: https://yourdomain.com/gpg-key.asc"
echo "3. Users can verify with:"
echo "   dpkg-sig --verify notely-desktop_*.deb"
echo "   rpm --checksig notely-desktop-*.rpm"
echo ""
