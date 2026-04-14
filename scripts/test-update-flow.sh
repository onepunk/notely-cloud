#!/bin/bash
#
# test-update-flow.sh
#
# Creates a dummy .deb package for testing the auto-update installation flow
# on Linux. The package does nothing harmful - just echoes a success message.
#
# Usage:
#   ./scripts/test-update-flow.sh           # Create test package
#   ./scripts/test-update-flow.sh --clean   # Remove test package
#
# After creating the package, test it with:
#   node scripts/test-update-install.js /tmp/notely-test.deb
#

set -e

TEST_PKG_DIR="/tmp/notely-test-pkg"
TEST_DEB="/tmp/notely-test.deb"

# Clean up function
cleanup() {
    echo "Cleaning up test package..."
    rm -rf "$TEST_PKG_DIR"
    rm -f "$TEST_DEB"
    echo "Done."
}

# Handle --clean flag
if [[ "$1" == "--clean" ]]; then
    cleanup
    exit 0
fi

echo "=== Creating Test .deb Package ==="
echo ""

# Create package directory structure
echo "Step 1: Creating package structure..."
mkdir -p "$TEST_PKG_DIR/DEBIAN"
mkdir -p "$TEST_PKG_DIR/usr/share/notely-test"

# Create control file
cat > "$TEST_PKG_DIR/DEBIAN/control" << 'EOF'
Package: notely-test
Version: 1.0.0
Section: utils
Priority: optional
Architecture: all
Installed-Size: 1
Maintainer: Notely Test <test@example.com>
Description: Test package for Notely auto-update flow
 This is a dummy package used to test the auto-update
 installation mechanism. It does nothing except create
 a marker file to indicate successful installation.
EOF

# Create postinst script
cat > "$TEST_PKG_DIR/DEBIAN/postinst" << 'EOF'
#!/bin/bash
echo ""
echo "=========================================="
echo "  Notely Test Package Post-Install"
echo "=========================================="
echo ""
echo "  SUCCESS: Package installed correctly!"
echo ""
echo "  This confirms that:"
echo "  1. pkexec authentication worked"
echo "  2. dpkg -i executed successfully"
echo "  3. Post-install script ran"
echo ""
echo "  Marker file created at:"
echo "  /usr/share/notely-test/installed"
echo ""
echo "=========================================="
echo ""

# Create a marker file to prove installation worked
echo "Installed at: $(date)" > /usr/share/notely-test/installed
EOF

chmod 755 "$TEST_PKG_DIR/DEBIAN/postinst"

# Create prerm script (for uninstall)
cat > "$TEST_PKG_DIR/DEBIAN/prerm" << 'EOF'
#!/bin/bash
echo "Removing Notely test package..."
rm -f /usr/share/notely-test/installed
EOF

chmod 755 "$TEST_PKG_DIR/DEBIAN/prerm"

# Create a placeholder file
echo "Notely test package placeholder" > "$TEST_PKG_DIR/usr/share/notely-test/README"

echo "  Package structure created at: $TEST_PKG_DIR"
echo ""

# Build the .deb package
echo "Step 2: Building .deb package..."
dpkg-deb --build "$TEST_PKG_DIR" "$TEST_DEB" 2>/dev/null

if [[ ! -f "$TEST_DEB" ]]; then
    echo "Error: Failed to create .deb package"
    exit 1
fi

echo "  Package created at: $TEST_DEB"
echo ""

# Show package info
echo "Step 3: Package info:"
dpkg-deb --info "$TEST_DEB" | head -15
echo ""

# Instructions
echo "=== Test Instructions ==="
echo ""
echo "1. Test the pkexec/dpkg flow:"
echo "   node scripts/test-update-install.js $TEST_DEB"
echo ""
echo "2. Verify installation worked (after test):"
echo "   cat /usr/share/notely-test/installed"
echo ""
echo "3. Remove the test package:"
echo "   sudo dpkg -r notely-test"
echo ""
echo "4. Clean up test files:"
echo "   ./scripts/test-update-flow.sh --clean"
echo ""
