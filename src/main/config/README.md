# Configuration System

This directory contains the configuration system for the Notely desktop client, including feature flags, sync configuration, and service URLs.

## Files

### `features.ts`

Core feature flag system implementation:

- **`FeatureFlags`** interface: Defines all available feature flags
- **`FeatureFlagLoader`**: Loads flags from remote/local sources with caching
- **Utility functions**: `getSyncUrl()`, `shouldUseV3Sync()`, etc.

**Key Features:**

- Remote configuration with timeout and retry
- Local file-based fallback for offline operation
- Caching with configurable TTL
- Automatic refresh on interval

### `FeatureFlagService.ts`

Singleton service for managing feature flags globally:

- **`FeatureFlagService`**: Main service class (singleton pattern)
- **Event emission**: Notifies listeners of flag updates
- **Auth context integration**: Auto-refreshes on user changes
- **Manual refresh**: Supports on-demand flag reloading

**Usage:**

```typescript
import { getFeatureFlagService } from './config/FeatureFlagService';

const featureFlagService = getFeatureFlagService();
await featureFlagService.initialize(authContext);

const flags = featureFlagService.getFlags();
if (flags.useV3SyncMicroservice) {
  // Use V3 sync
}
```

## Feature Flags

### Current Flags

1. **`useV3SyncMicroservice`** (boolean, default: `false`)
   - Enable V3 sync microservice instead of V2 monolithic API
   - Safe default: V2 (stable)

2. **`enableSyncTelemetry`** (boolean, default: `true`)
   - Enable enhanced telemetry for sync operations
   - Tracks backend usage, duration, success rates

3. **`enableV3Fallback`** (boolean, default: `true`)
   - Enable automatic fallback from V3 to V2 on errors
   - Safety mechanism for V3 rollout

4. **`featureFlagRefreshIntervalMs`** (number, default: `300000`)
   - Automatic refresh interval (5 minutes)
   - Set to 0 to disable auto-refresh

## Configuration Priority

Configuration is loaded in this order (highest priority first):

1. **Environment variables** (`USE_V3_SYNC`, `NOTELY_SYNC_URL`, etc.)
2. **Remote feature flag service** (if configured and reachable)
3. **Local configuration file** (if path provided)
4. **Default configuration** (safe defaults)

## Quick Start

### Enable V3 Sync Locally

```bash
# Option 1: Environment variable
export USE_V3_SYNC=true
npm start

# Option 2: Local config file
echo '{"useV3SyncMicroservice": true}' > feature-flags.json
npm start
```

### Check Current Backend

```typescript
const flags = featureFlagService.getFlags();
console.log('Using V3:', flags.useV3SyncMicroservice);
```

### Rollback to V2

```bash
# Disable V3
export USE_V3_SYNC=false

# Or unset variable (defaults to V2)
unset USE_V3_SYNC
```

## Integration

### SyncService Integration

The `SyncService` automatically uses feature flags to select the sync backend:

```typescript
// In src/main/SyncService.ts
const flags = this.featureFlagService.getFlags();
const backendType = flags.useV3SyncMicroservice ? 'v3' : 'v2';

// V3 fallback on error
if (!syncResult.success && backendType === 'v3' && flags.enableV3Fallback) {
  // Automatically retry with V2
}
```

### AppManager Integration

Initialize feature flags in `AppManager`:

```typescript
// In src/main/AppManager.ts
import { getFeatureFlagService } from './config/FeatureFlagService';

const featureFlagService = getFeatureFlagService({
  remoteConfigUrl: 'https://api.yourdomain.com/v3/config/features',
  localConfigPath: process.env.FEATURE_FLAGS_PATH,
});

await featureFlagService.initialize(authContext);
```

## Testing

### Unit Tests

```typescript
import { getFeatureFlagService } from './config/FeatureFlagService';

describe('Feature Flags', () => {
  it('should default to V2', () => {
    const service = getFeatureFlagService();
    const flags = service.getFlags();
    expect(flags.useV3SyncMicroservice).toBe(false);
  });
});
```

### Manual Testing

```bash
# Test V3 sync
export USE_V3_SYNC=true
npm start

# Check logs for:
# "SyncService: Using V3 sync microservice"
```

## Documentation

- **Full Documentation:** `/docs/FEATURE_FLAGS.md`
- **Quick Start:** `/docs/FEATURE_FLAGS_QUICKSTART.md`
- **Example Config:** `/feature-flags.example.json`

## Architecture

```
┌─────────────────────────────────────────┐
│         Feature Flag Service            │
│  (Singleton, Event Emitter)             │
├─────────────────────────────────────────┤
│  - Initialize with auth context         │
│  - Auto-refresh on interval             │
│  - Emit 'updated' events                │
│  - Safe defaults on error               │
└─────────┬───────────────────────────────┘
          │
          ├──> Remote Config Service
          │    (Priority 1: if available)
          │
          ├──> Local Config File
          │    (Priority 2: fallback)
          │
          └──> Default Flags
               (Priority 3: safe defaults)
```

## Environment Setup

### Development

```bash
# Use production API (stable)
export NOTELY_ENV=development
npm start
```

### Local Development

```bash
# Use localhost services
export NOTELY_ENV=local
export NOTELY_API_URL=http://localhost:3000
export NOTELY_SYNC_URL=http://localhost:3205
npm start
```

### Production

```bash
# Use production API
export NODE_ENV=production
npm start
```

## Security

- **Remote config requires authentication** (Bearer token)
- **Local config files are not committed** (add to `.gitignore`)
- **Feature flags are user-specific** (no cross-user leakage)
- **Telemetry does not log PII** (user IDs only, no sensitive data)

## Future Enhancements

- **A/B testing framework**
- **Percentage-based rollout**
- **Flag scheduling** (enable/disable at specific times)
- **Flag dependencies** (require flag A before B)
- **Analytics dashboard**

## Support

For questions or issues:

- Review `/docs/FEATURE_FLAGS.md` for detailed documentation
- Check `/docs/FEATURE_FLAGS_QUICKSTART.md` for common scenarios
- See `src/main/SyncService.ts` for integration examples
