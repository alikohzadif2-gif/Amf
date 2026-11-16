import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Button, Notice } from '@/components/server/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { importFromPhone } from '@/src/library/import-from-phone';
import { useLibraryIndex } from '@/src/library/index-store';
import { Thumb } from '@/src/library/ui/Thumb';

const MAX = 60;

/** Attach one photo/video of the Library (by its Library key) to an event. */
export function MediaPicker({ value, onChange }: { value: string | null; onChange: (key: string | null) => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const { status, entries, byKey, build } = useLibraryIndex();
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [failed, setFailed] = useState(false);
  const media = useMemo(
    () =>
      entries
        .filter((e) => e.item.type === 'image' || e.item.type === 'video')
        .sort((a, b) => b.item.mtime.localeCompare(a.item.mtime))
        .slice(0, MAX),
    [entries],
  );
  const current = value ? byKey.get(value) : undefined;

  const toggle = () => {
    if (!open && status === 'idle') void build();
    setOpen(!open);
  };

  const fromGallery = async () => {
    setFailed(false);
    setImporting(true);
    const result = await importFromPhone('gallery', false);
    setImporting(false);
    const key = result.keys[0];
    if (key) {
      onChange(key);
      setOpen(false);
    } else if (!result.cancelled) setFailed(true);
  };

  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 12, marginBottom: 6, textAlign: alignOf(isRTL) }}>{t('eventAttach')}</Text>
      <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12 }}>
        {current ? <Thumb entry={current} style={{ width: 64, height: 64, borderRadius: 12 }} /> : null}
        <View style={{ flex: 1, gap: 8 }}>
          <Button title="eventAttachGallery" icon="image" busy={importing} onPress={() => void fromGallery()} />
          <Button title={status === 'idle' ? 'eventAttachLoad' : 'eventAttach'} onPress={toggle} />
          {value ? <Button title="eventAttachRemove" destructive onPress={() => onChange(null)} /> : null}
        </View>
      </View>
      {failed ? <Notice tone="error">{t('libAddFailed')}</Notice> : null}
      {open ? (
        <View style={{ marginTop: 10 }}>
          {status === 'indexing' ? <Notice>{t('eventAttachLoading')}</Notice> : null}
          {status === 'ready' && media.length === 0 ? <Notice>{t('eventAttachEmpty')}</Notice> : null}
          <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 6 }}>
            {media.map((entry) => (
              <Pressable
                key={entry.key}
                accessibilityRole="button"
                accessibilityLabel={entry.item.name}
                accessibilityState={{ selected: entry.key === value }}
                onPress={() => {
                  onChange(entry.key);
                  setOpen(false);
                }}
              >
                <Thumb entry={entry} style={{ width: 76, height: 76, borderRadius: 10, borderWidth: 2, borderColor: entry.key === value ? colors.primary : 'transparent' }} />
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}
