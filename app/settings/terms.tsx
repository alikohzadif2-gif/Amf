import { SettingsDocumentScreen } from '@/components/settings/SettingsDocumentScreen';

export default function TermsOfServiceScreen() {
  return (
    <SettingsDocumentScreen
      title="termsOfService"
      blocks={[
        { heading: 'termsUseTitle', body: 'termsUseBody' },
        { heading: 'termsStorageTitle', body: 'termsStorageBody' },
        { heading: 'termsServerTitle', body: 'termsServerBody' },
        { heading: 'termsDriveTitle', body: 'termsDriveBody' },
        { heading: 'termsPartnerTitle', body: 'termsPartnerBody' },
        { heading: 'termsAccessTitle', body: 'termsAccessBody' },
        { heading: 'termsResetTitle', body: 'termsResetBody' },
      ]}
    />
  );
}
