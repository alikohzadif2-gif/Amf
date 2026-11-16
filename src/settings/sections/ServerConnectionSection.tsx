import { useRouter } from 'expo-router';
import { ActionRow, NavRow, SettingGroup, SwitchRow } from '@/components/settings/SettingRows';
import { useSettingsStore } from '@/src/state/settings-store';

/**
 * S2: only what is real today. Add (QR / link / URL + token), test, list, remove.
 * Hidden until their phases: the SSH quick setup (never built) and the certificate-fingerprint switch
 * (the meYou server sits behind Caddy and reports no fingerprint).
 */
export default function ServerConnectionSection() {
  const s = useSettingsStore();
  const set = s.setSetting;
  const router = useRouter();

  return (
    <>
      <SettingGroup>
        <NavRow title="serversTitle" description="serversOpenDesc" onPress={() => router.push('/settings/servers')} />
        <ActionRow
          title="addServerQr"
          icon="camera"
          onPress={() => router.push({ pathname: '/settings/add-server', params: { method: 'qr' } })}
        />
        <ActionRow title="addServerManual" onPress={() => router.push('/settings/add-server')} />
      </SettingGroup>
      <SettingGroup>
        <SwitchRow
          title="serverFailover"
          description="serverFailoverDesc"
          value={s.serverFailover}
          onChange={(v) => set('serverFailover', v)}
        />
      </SettingGroup>
      <SettingGroup>
        <ActionRow title="testConnection" onPress={() => router.push('/settings/servers')} />
      </SettingGroup>
    </>
  );
}
