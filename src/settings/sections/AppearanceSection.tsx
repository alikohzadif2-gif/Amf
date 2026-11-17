import { AccentRow, SelectRow, SettingGroup } from '@/components/settings/SettingRows';
import { useSettingsStore } from '@/src/state/settings-store';

export default function AppearanceSection() {
  const s = useSettingsStore();
  const set = s.setSetting;

  return (
    <>
      <SettingGroup>
        <SelectRow
          title="theme"
          value={s.theme}
          onChange={(v) => set('theme', v)}
          options={[
            { value: 'auto', label: 'system' },
            { value: 'light', label: 'light' },
            { value: 'dark', label: 'dark' },
          ]}
        />
        <AccentRow
          title="accentColor"
          icon="droplet"
          value={s.accent}
          onChange={(v) => set('accent', v)}
        />
      </SettingGroup>
    </>
  );
}
