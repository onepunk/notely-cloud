'use strict';

/**
 * Custom signing script for electron-builder using DigiCert Software Trust Manager.
 * Uses smctl CLI to sign Windows executables with EV code signing certificate.
 *
 * OPTIMIZATION: Only signs the final NSIS installer (not individual executables)
 * to reduce DigiCert API calls from 4-5 per build down to 1.
 *
 * Required environment variables:
 * - SM_KEYPAIR_ALIAS: The keypair alias from DigiCert (e.g., key_1504094077)
 *
 * The following must be configured before signing (via smctl credentials or env vars):
 * - SM_HOST: DigiCert API endpoint (https://clientauth.one.nl.digicert.com)
 * - SM_API_KEY: API token from DigiCert ONE
 * - SM_CLIENT_CERT_FILE: Path to client authentication certificate (.p12)
 * - SM_CLIENT_CERT_PASSWORD: Password for the client certificate
 */

const path = require('path');

exports.default = async function (configuration) {
  if (!configuration.path) {
    console.log('No file path provided, skipping signing');
    return;
  }

  const filename = path.basename(configuration.path).toLowerCase();

  // Only sign the final NSIS installer, not individual executables
  // The installer filename format is "Notely Setup X.X.X.exe"
  // This reduces DigiCert API calls from 4-5 per build to just 1
  if (!filename.includes('setup')) {
    console.log(`Skipping DigiCert signing for: ${filename} (not the final installer)`);
    return;
  }

  const { execSync } = require('child_process');
  const keypairAlias = process.env.SM_KEYPAIR_ALIAS;

  if (!keypairAlias) {
    throw new Error('SM_KEYPAIR_ALIAS environment variable not set');
  }

  console.log(`Signing with DigiCert: ${configuration.path}`);

  try {
    const output = execSync(
      `smctl sign --keypair-alias="${keypairAlias}" --timestamp --input "${String(configuration.path)}"`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );
    console.log(output);

    // smctl can exit 0 even when signing fails — verify the signature
    console.log(`Verifying signature on: ${configuration.path}`);
    const verifyOutput = execSync(
      `signtool verify /pa "${String(configuration.path)}"`,
      { stdio: 'pipe', encoding: 'utf-8' }
    );
    console.log(verifyOutput);
    console.log(`Successfully signed and verified: ${configuration.path}`);
  } catch (error) {
    console.error(`Failed to sign ${configuration.path}:`, error.message);
    throw error;
  }
};
