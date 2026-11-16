import { useRouter } from 'expo-router';
import { NavRow, SelectRow, SettingGroup } from '@/components/settings/SettingRows';
import { TIME_ORDERS, type TimeOrder } from '@/src/library/time-order';
import { useSettingsStore } from '@/src/state/settings-store';
import type { TranslationKey } from '@/src/i18n';

const LABEL: Record<TimeOrder, TranslationKey> = {
  all: 'timeAll', today: 'timeToday', week: 'timeWeek', month: 'timeMonth', year: 'timeYear', newest: 'archiveSortNewest', oldest: 'archiveSortOldest',
};

export default function SourcesSyncSection() {
  const router = useRouter();
  const order = useSettingsStore((s) => s.archiveTimeOrder);
  const setSetting = useSettingsStore((s) => s.setSetting);

  return (
    <>
      <SettingGroup>
        <NavRow
          title="manageSources"
          description="manageSourcesDesc"
          onPress={() => router.push('/settings/sources')}
        />
      </SettingGroup>
      <SettingGroup>
        <SelectRow
          title="archiveDefaultTime"
          description="archiveDefaultTimeDesc"
          value={order}
          onChange={(v) => setSetting('archiveTimeOrder', v)}
          options={TIME_ORDERS.map((value) => ({ value, label: LABEL[value] }))}
        />
      </SettingGroup>
    </>
  );
}
