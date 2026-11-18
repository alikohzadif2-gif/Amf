import { SettingsDocumentScreen } from '@/components/settings/SettingsDocumentScreen';

export default function PrivacyPolicyScreen() {
  return (
    <SettingsDocumentScreen
      title="privacyPolicy"
      blocks={[
        { heading: 'privacyDataTitle', body: 'privacyDataBody' },
        { heading: 'privacyServerTitle', body: 'privacyServerBody' },
        { heading: 'privacySecurityTitle', body: 'privacySecurityBody' },
        { heading: 'privacyPushTitle', body: 'privacyPushBody' },
        { heading: 'privacyTrackingTitle', body: 'privacyTrackingBody' },
        { heading: 'privacyMediaTitle', body: 'privacyMediaBody' },
        { heading: 'privacyLogsTitle', body: 'privacyLogsBody' },
        { heading: 'privacyRevokeTitle', body: 'privacyRevokeBody' },
      ]}
    />
  );
}
