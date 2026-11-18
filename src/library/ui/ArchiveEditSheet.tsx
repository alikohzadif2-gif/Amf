import { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Button } from '@/components/server/ui';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Chip } from '@/components/ui/Chip';
import { Input } from '@/components/ui/Input';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { archiveDate, type LibraryEntry } from '../merge';
import { parseArchiveDate, useUserData } from '../user-data';
import type { ArchiveCategoryOption } from '../archive-model';

function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
}

export function ArchiveEditSheet({
  entries,
  categories,
  visible,
  onClose,
  onSave,
}: {
  entries: LibraryEntry[];
  categories: ArchiveCategoryOption[];
  visible: boolean;
  onClose: () => void;
  onSave: (changes: { date?: string | null; category?: string }) => Promise<void>;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const metadata = useUserData((state) => state.archiveMeta);
  const [date, setDate] = useState('');
  const [category, setCategory] = useState('');
  const [clearDate, setClearDate] = useState(false);
  const [busy, setBusy] = useState(false);
  const entryKey = entries.map((entry) => entry.key).join('|');
  const mixedDate = useMemo(
    () => new Set(entries.map((entry) => archiveDate(entry, metadata).slice(0, 10))).size > 1,
    [entries, metadata],
  );
  const mixedCategory = useMemo(
    () => new Set(entries.map((entry) => metadata[entry.key]?.category ?? 'none')).size > 1,
    [entries, metadata],
  );

  useEffect(() => {
    if (!visible) return;
    setDate(entries.length > 0 && !mixedDate ? archiveDate(entries[0], metadata).slice(0, 10) : '');
    setCategory(entries.length > 0 && !mixedCategory ? metadata[entries[0].key]?.category ?? 'none' : '');
    setClearDate(false);
  }, [visible, entryKey, metadata, mixedDate, mixedCategory, entries]);

  const submit = async () => {
    let parsedDate: string | null | undefined;
    if (clearDate) parsedDate = null;
    else if (date.trim()) {
      parsedDate = parseArchiveDate(normalizeDigits(date));
      if (!parsedDate) {
        Alert.alert(t('archiveDateInvalid'));
        return;
      }
    }
    const changes = {
      ...(parsedDate !== undefined ? { date: parsedDate } : {}),
      ...(category ? { category } : {}),
    };
    if (!Object.keys(changes).length) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      await onSave(changes);
      onClose();
    } catch {
      Alert.alert(t('archiveEditFailed'));
    } finally {
      setBusy(false);
    }
  };

  const label = (text: string) => (
    <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 14, textAlign: isRTL ? 'right' : 'left' }}>
      {text}
    </Text>
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('archiveEdit')} cancelLabel={t('cancel')}>
      <View style={styles.content}>
        {label(t('archiveDate'))}
        <Input
          value={clearDate ? '' : date}
          onChangeText={(value) => { setDate(value); setClearDate(false); }}
          placeholder={t('archiveDatePlaceholder')}
          accessibilityLabel={t('archiveDate')}
          keyboardType="numbers-and-punctuation"
          editable={!busy}
        />
        <Button
          title="archiveDateOriginal"
          onPress={() => { setDate(''); setClearDate(true); }}
          disabled={busy}
          compact
        />
        {label(t('archiveCategory'))}
        {mixedCategory || entries.length > 1 ? (
          <Chip label={t('archiveKeepExisting')} selected={category === ''} onPress={() => setCategory('')} />
        ) : null}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.categories, { flexDirection: rowOf(isRTL) }]}>
          {categories.map((item) => (
            <Chip key={item.id} label={item.label} selected={category === item.id} onPress={() => setCategory(item.id)} />
          ))}
        </ScrollView>
        <Button title="archiveSave" onPress={() => void submit()} disabled={busy} primary />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: 10, paddingBottom: 8 },
  categories: { gap: 8, alignItems: 'center' },
});
