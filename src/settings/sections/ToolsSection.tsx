import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { ActionRow, InfoRow, SettingGroup } from '@/components/settings/SettingRows';

export default function ToolsSection() {
  const router = useRouter();

  return (
    <>
      <SettingGroup>
        <ActionRow title="duplicateFinder" description="duplicateFinderDesc" onPress={() => router.push('/settings/duplicates')} />
        <ActionRow title="storageAnalyzer" description="storageAnalyzerDesc" onPress={() => router.push('/settings/storage-analyzer')} />
        <ActionRow title="diagnostics" description="diagnosticsDesc" onPress={() => router.push('/settings/diagnostics')} />
      </SettingGroup>
      <SettingGroup>
        <InfoRow title="appVersion" value={Constants.expoConfig?.version ?? '—'} />
      </SettingGroup>
    </>
  );
}
