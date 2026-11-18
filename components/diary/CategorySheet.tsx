import { Feather } from '@expo/vector-icons';
import { getRandomBytes } from 'expo-crypto';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Input } from '@/components/ui/Input';
import { useColors } from '@/hooks/useColors';
import { CUSTOM_CATEGORY_NAME_MAX, DIARY_CATEGORIES, type CustomCategory } from '@/src/diary/categories';
import { addCustomCategory, deleteCustomCategory, newCategoryId } from '@/src/diary/category-db';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';

/** Create and delete custom diary categories. `onChanged(added?)` runs after every change so the caller reloads its list. */
export function CategorySheet({
  visible,
  onClose,
  customs,
  onChanged,
  bottomOffset,
}: {
  visible: boolean;
  onClose: () => void;
  customs: CustomCategory[];
  onChanged: (added?: CustomCategory) => void;
  bottomOffset?: number;
}) {
  const colors = useColors();
  const db = useSQLiteContext();
  const { language, isRTL, t } = useI18n();
  const [name, setName] = useState('');
  const [error, setError] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const id = newCategoryId(Array.from(getRandomBytes(6), (b) => b.toString(16).padStart(2, '0')).join(''));
      const result = await addCustomCategory(db, name, id, DIARY_CATEGORIES.map((c) => t(c.name)).concat(t('diaryCategoryNone')));
      if (result.ok) {
        setName('');
        setError(null);
        onChanged(result.category);
      } else {
        setError(result.reason === 'exists' ? 'diaryCategoryExists' : result.reason === 'limit' ? 'diaryCategoryLimit' : 'diaryCategoryFailed');
      }
    } catch {
      setError('diaryCategoryFailed');
    } finally {
      setBusy(false);
    }
  };

  const remove = (category: CustomCategory) => {
    Alert.alert(t('diaryCategoryDeleteTitle'), t('diaryCategoryDeleteBody'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('diaryDeleteConfirmAction'),
        style: 'destructive',
        onPress: () => {
          void deleteCustomCategory(db, category.id).then(() => onChanged()).catch(() => setError('diaryCategoryFailed'));
        },
      },
    ]);
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('diaryCategoryManage')}
      cancelLabel={t('cancel')}
      actionLabel={t('diaryCategoryAddAction')}
      onAction={() => void add()}
      actionDisabled={busy || !name.trim()}
      bottomOffset={bottomOffset}
    >
      <View style={{ gap: 14 }}>
        <Input
          value={name}
          onChangeText={(value) => { setName(value); setError(null); }}
          placeholder={t('diaryCategoryNamePlaceholder')}
          maxLength={CUSTOM_CATEGORY_NAME_MAX}
          autoCapitalize="sentences"
          returnKeyType="done"
        />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }}>
            {t(error)}
          </Text>
        ) : null}
        {customs.length === 0 ? (
          <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: isRTL ? 'right' : 'left' }}>
            {t('diaryCategoryCustomEmpty')}
          </Text>
        ) : (
          customs.map((category) => (
            <View key={category.id} style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 10, minHeight: 44 }}>
              <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 16, textAlign: isRTL ? 'right' : 'left' }}>
                {category.name}
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('diaryCategoryDelete')} hitSlop={8} onPress={() => remove(category)}>
                <Feather name="trash-2" size={19} color={colors.destructive} />
              </Pressable>
            </View>
          ))
        )}
      </View>
    </BottomSheet>
  );
}
