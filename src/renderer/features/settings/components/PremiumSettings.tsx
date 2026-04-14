import { Link, Text } from '@fluentui/react-components';
import { Open16Regular } from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { useLicense } from '../../../shared/hooks/useLicense';
import { useUpgradeAction } from '../../../shared/hooks/useUpgradeAction';
import { LicenseStatusRow } from '../../license/LicenseStatusRow';

import styles from './PremiumSettings.module.css';
import { SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

export const PremiumSettings: React.FC = () => {
  const { t } = useTranslation();

  const { license, loading: licenseLoading } = useLicense();
  const { handleUpgrade } = useUpgradeAction();

  const hasLicense = license.status === 'active' || license.status === 'expiring';

  const handleOpenPlans = () => {
    window.api.window.openExternal('https://yourdomain.com/plans');
  };

  return (
    <SettingsTabLayout
      title={t('settings.premium.title')}
      description={t('settings.premium.description')}
    >
      {/* License Section */}
      <SettingsSection
        title={t('settings.premium.license')}
        description={t('settings.premium.license_desc')}
      >
        <LicenseStatusRow
          status={license.status}
          type={license.type}
          tierName={license.tierName}
          grantType={license.grantType}
          isBeta={license.isBeta}
          expiresAt={license.expiresAt}
          daysRemaining={license.daysRemaining}
          loading={licenseLoading}
          onAction={handleUpgrade}
          actionLabel={hasLicense ? t('settings.premium.manage') : t('settings.premium.upgrade')}
        />
      </SettingsSection>

      {/* Premium Features Section */}
      <SettingsSection
        title={t('settings.premium.features')}
        description={t('settings.premium.features_desc')}
      >
        <div className={styles.plansPromo}>
          <Text>{t('settings.premium.unlock_potential')}</Text>
          <Link
            href="https://yourdomain.com/plans"
            onClick={(e) => {
              e.preventDefault();
              handleOpenPlans();
            }}
            className={styles.plansLink}
          >
            {t('settings.premium.view_plans')} <Open16Regular />
          </Link>
        </div>
      </SettingsSection>
    </SettingsTabLayout>
  );
};
