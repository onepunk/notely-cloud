# License Warning Components

Comprehensive UI components for displaying license expiry and cache validation warnings in Notely Desktop.

## Components Overview

### 1. ExpiryBanner

A fixed-position banner displayed at the top of the application window that shows progressive license expiry warnings.

**Warning Levels:**

- **Info (30 days)**: Blue banner - "License expires in X days"
- **Warning (7 days)**: Orange banner - "License expires soon (X days left)"
- **Critical (Expired)**: Red banner - "License expired"

**Features:**

- Dismissible for info and warning levels
- Always visible for critical level
- Shows countdown timer
- Provides "Renew License" action button
- Responsive design

**Usage:**

```tsx
import { ExpiryBanner } from '@features/license/components';

<ExpiryBanner onRenew={() => navigateToLicenseRenewal()} className="custom-banner-class" />;
```

**Props:**

- `onRenew?: () => void` - Callback when "Renew License" button is clicked
- `className?: string` - Additional CSS classes

---

### 2. ExpiredModal

A blocking modal dialog that prevents app usage when the license is expired.

**Features:**

- Cannot be dismissed when license is expired
- Shows expiry date and reason
- Provides license key input field for reactivation
- "Contact Support" link
- Prevents all app interaction until resolved
- Responsive design

**Usage:**

```tsx
import { ExpiredModal } from '@features/license/components';

<ExpiredModal
  open={licenseExpired}
  onDismiss={() => {
    /* Only called when license is reactivated */
  }}
  supportUrl="https://yourdomain.com/support"
/>;
```

**Props:**

- `open: boolean` - Controls modal visibility
- `onDismiss?: () => void` - Callback when modal is dismissed (only if license is valid)
- `supportUrl?: string` - URL for support link (default: "https://yourdomain.com/support")

---

### 3. CacheExpiryWarning

Displays warnings specific to offline cache expiry (separate from license expiry).

**Warning Stages:**

- **Day 5-6**: Info banner - "Connect to validate license (X days remaining)"
- **Day 7**: Warning banner - "Connect today to continue using app"
- **Day 8+**: Blocking modal - "Validation expired"

**Features:**

- Only appears in offline mode
- Progressive warning levels
- Blocking modal after 7 days
- Instructions for validation
- Responsive design

**Usage:**

```tsx
import { CacheExpiryWarning } from '@features/license/components';

<CacheExpiryWarning
  onConnectClick={() => attemptOnlineValidation()}
  className="custom-warning-class"
/>;
```

**Props:**

- `onConnectClick?: () => void` - Callback for connection/validation attempt
- `className?: string` - Additional CSS classes

---

### 4. LicenseWarnings (Unified Component)

A convenient wrapper that manages all license warning UI automatically based on license state.

**Features:**

- Automatically displays appropriate warnings
- Handles cache expiry and license expiry separately
- Shows blocking modal when license expires
- Single component for complete warning management

**Usage:**

```tsx
import { LicenseWarnings } from '@features/license/components';

<LicenseWarnings
  onRenewLicense={() => navigateToRenewal()}
  onConnectForValidation={() => attemptOnlineValidation()}
  supportUrl="https://yourdomain.com/support"
/>;
```

**Props:**

- `onRenewLicense?: () => void` - Callback for license renewal
- `onConnectForValidation?: () => void` - Callback for online validation
- `supportUrl?: string` - Support URL for expired modal
- `className?: string` - Additional CSS classes

---

## Integration

### Basic Integration

Add the unified component to your main app layout:

```tsx
// In your App.tsx or main layout component
import { LicenseWarnings } from '@features/license/components';
import { LicenseProvider } from '@shared/hooks/useLicense';

function App() {
  return (
    <LicenseProvider>
      <LicenseWarnings
        onRenewLicense={handleLicenseRenewal}
        onConnectForValidation={handleValidationAttempt}
        supportUrl="https://yourdomain.com/support"
      />
      {/* Your app content */}
    </LicenseProvider>
  );
}
```

### Advanced Integration

Use individual components for custom layouts:

```tsx
import { ExpiryBanner, ExpiredModal, CacheExpiryWarning } from '@features/license/components';
import { useLicense } from '@shared/hooks/useLicense';

function CustomLayout() {
  const { license } = useLicense();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    setShowModal(license.status === 'expired');
  }, [license.status]);

  return (
    <>
      {/* Cache warnings appear at top */}
      <CacheExpiryWarning onConnectClick={handleConnect} />

      {/* License expiry banner below cache warning */}
      {license.status !== 'expired' && <ExpiryBanner onRenew={handleRenew} />}

      {/* Blocking modal for expired licenses */}
      <ExpiredModal open={showModal} onDismiss={() => setShowModal(false)} />

      {/* Main app content */}
      <div style={{ marginTop: '48px' }}>{/* Account for fixed banners */}</div>
    </>
  );
}
```

---

## License State Flow

The components respond to license states from the `useLicense()` hook:

```
┌─────────────────────────────────────────────────────────────┐
│                     License State Flow                       │
└─────────────────────────────────────────────────────────────┘

1. ACTIVE (no warnings)
   ├─ No UI displayed
   └─ All features accessible

2. EXPIRING (30+ days)
   ├─ ExpiryBanner: Info level (blue, dismissible)
   └─ Message: "License expires in X days"

3. EXPIRING (7 days)
   ├─ ExpiryBanner: Warning level (orange, dismissible)
   └─ Message: "License expires soon (X days left)"

4. EXPIRED
   ├─ ExpiredModal: Blocking (cannot dismiss)
   ├─ ExpiryBanner: Hidden
   └─ App access blocked until license renewed

5. OFFLINE MODE (cache expiry)
   ├─ Day 5-6: CacheExpiryWarning banner (dismissible)
   ├─ Day 7: CacheExpiryWarning banner (urgent)
   └─ Day 8+: CacheExpiryWarning modal (blocking)
```

---

## Styling

All components use CSS modules with design tokens for theming:

- `var(--spacing-*)` - Spacing scale
- `var(--color-*)` - Color palette
- `var(--font-size-*)` - Typography scale
- `var(--bg-*)` - Background colors
- `var(--text-*)` - Text colors
- `var(--stroke)` - Border colors

### Customization

Override styles using className prop:

```tsx
<ExpiryBanner className="custom-banner" />
```

```css
.custom-banner {
  top: 64px; /* Position below header */
}
```

---

## Accessibility

All components follow accessibility best practices:

- **ARIA Labels**: All interactive elements have proper labels
- **Keyboard Navigation**: Full keyboard support
- **Screen Readers**: Semantic HTML and ARIA roles
- **Focus Management**: Proper focus trapping in modals
- **Color Contrast**: WCAG AA compliant

### Keyboard Shortcuts

- **Tab**: Navigate between interactive elements
- **Enter/Space**: Activate buttons
- **Escape**: Dismiss dismissible warnings (info/warning levels only)

---

## Testing

Components integrate with the existing test infrastructure:

```tsx
import { render, screen } from '@testing-library/react';
import { ExpiryBanner } from './ExpiryBanner';
import { LicenseProvider } from '@shared/hooks/useLicense';

describe('ExpiryBanner', () => {
  it('shows warning when license is expiring', () => {
    render(
      <LicenseProvider>
        <ExpiryBanner />
      </LicenseProvider>
    );

    expect(screen.getByTestId('expiry-banner')).toBeInTheDocument();
  });
});
```

---

## Technical Details

### Dependencies

- **@fluentui/react-components**: UI component library
- **@fluentui/react-icons**: Icon set
- **React 18+**: Framework
- **useLicense hook**: License state management

### Performance

- **Memoization**: Components use React.useMemo for expensive calculations
- **Efficient Rendering**: Only re-render when license state changes
- **Event Subscription**: Automatic cleanup of license change listeners
- **CSS Modules**: Scoped styles with minimal runtime overhead

### Real-time Updates

Components automatically respond to license changes via the `useLicense()` hook:

```tsx
// License changes are picked up automatically
const { license } = useLicense();

// Components subscribe to license:onChanged events
// No manual refresh needed
```

---

## Error Handling

Components gracefully handle error states:

- **Network Failures**: Show appropriate error messages
- **Invalid License Keys**: Display validation errors
- **Missing Data**: Use safe defaults
- **API Errors**: Surface user-friendly messages

---

## Browser Compatibility

Components work in all modern browsers supported by Electron:

- Chrome 108+
- Edge 108+
- Safari 16+
- Firefox 115+

---

## Future Enhancements

Potential improvements for future versions:

1. **Notification System**: Desktop notifications for expiry warnings
2. **Auto-renewal**: Automatic license renewal attempt
3. **Grace Period**: Extended functionality during grace period
4. **Offline License Generation**: Generate emergency offline licenses
5. **Analytics**: Track warning dismissals and renewal rates

---

## Support

For questions or issues:

- **Documentation**: See `/docs/LICENSE_MANAGEMENT.md`
- **Support**: https://yourdomain.com/support
- **Bug Reports**: File issues in the repository

---

## License

Copyright (c) 2025 Notely. All rights reserved.
