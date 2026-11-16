import {
  InfoRow,
  SelectRow,
  SettingGroup,
} from '@/components/settings/SettingRows';
import { useI18n } from '@/src/i18n';
import { useSettingsStore } from '@/src/state/settings-store';

export default function LanguageCalendarSection() {
  const { t } = useI18n();
  const s = useSettingsStore();
  const set = s.setSetting;

  return (
    <>
      <SettingGroup>
        <SelectRow
          title="language"
          value={s.language}
          onChange={(v) => set('language', v)}
          options={[
            { value: 'fa', label: 'persian' },
            { value: 'en', label: 'english' },
          ]}
        />
      </SettingGroup>
      <SettingGroup title="calendar">
        <SelectRow
          title="calendarMode"
          value={s.calendarMode}
          onChange={(v) => set('calendarMode', v)}
          options={[
            { value: 'jalali', label: 'jalali' },
            { value: 'gregorian', label: 'gregorian' },
            { value: 'both', label: 'both' },
          ]}
        />
        <SelectRow
          title="weekStarts"
          value={s.weekStart}
          onChange={(v) => set('weekStart', v)}
          options={[
            { value: 'sat', label: 'saturday' },
            { value: 'sun', label: 'sunday' },
            { value: 'mon', label: 'monday' },
          ]}
        />
        <SelectRow
          title="digits"
          value={s.digits}
          onChange={(v) => set('digits', v)}
          options={[
            { value: 'persian', label: 'persianDigits' },
            { value: 'latin', label: 'latinDigits' },
          ]}
        />
        <InfoRow title="utcNote" />
      </SettingGroup>
    </>
  );
}
