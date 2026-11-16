import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BottomSheet, Input } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { MOOD_PRESETS } from '@/src/partner/mood-colors';
import { isValidStatusEmoji, LABEL_MAX, normalizeLabel, type ActivityItem, type MoodItem } from '@/src/partner/status-custom';

export type ItemSheetTarget = { kind: 'mood'; item?: MoodItem } | { kind: 'activity'; item?: ActivityItem };
export type ItemSheetResult = { emoji: string; label: string; preset: number };

/**
 * Q4: one sheet for "new mood/activity" and "rename". New or own items: emoji + name (+ colour for a mood). Built-in items: only the name
 * (emoji fixed), with "back to the original name" when it was edited. Own items can be deleted. All saving/validating lives in the screen.
 */
export function StatusItemSheet({
  target,
  error,
  onClose,
  onSave,
  onReset,
  onDelete,
}: {
  target: ItemSheetTarget | null;
  error: TranslationKey | null;
  onClose: () => void;
  onSave: (r: ItemSheetResult) => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const item = target?.item;
  const builtIn = !!item && !item.custom;
  const [emoji, setEmoji] = useState('');
  const [label, setLabel] = useState('');
  const [preset, setPreset] = useState(0);
  useEffect(() => {
    if (!target) return;
    setEmoji(item?.emoji ?? '');
    setLabel(item?.label ?? '');
    setPreset(item && 'preset' in item && typeof item.preset === 'number' ? item.preset : 0);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const isMood = target?.kind === 'mood';
  const title = !target ? '' : t(item ? (isMood ? 'statusEditMood' : 'statusEditActivity') : isMood ? 'statusAddMood' : 'statusAddActivity');
  const ready = normalizeLabel(label) !== '' && (builtIn || isValidStatusEmoji(emoji));
  const fieldLabel = (key: TranslationKey) => (
    <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13, marginTop: 14, marginBottom: 6, textAlign: isRTL ? 'right' : 'left' }}>{t(key)}</Text>
  );
  const link = (key: TranslationKey, onPress: () => void, color: string) => (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}>
      <Text style={{ color, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: 'center' }}>{t(key)}</Text>
    </Pressable>
  );
  return (
    <BottomSheet visible={!!target} onClose={onClose} title={title} cancelLabel={t('cancel')} actionLabel={t('archiveSave')} actionDisabled={!ready} onAction={() => onSave({ emoji, label, preset })}>
      {target ? (
        <View>
          {builtIn ? (
            <Text style={{ fontSize: 40, textAlign: 'center', marginTop: 4 }}>{item?.emoji}</Text>
          ) : (
            <>
              {fieldLabel('statusEmojiField')}
              <Input value={emoji} onChangeText={setEmoji} maxLength={16} accessibilityLabel={t('statusEmojiField')} autoFocus={!item} />
            </>
          )}
          {fieldLabel('statusLabelField')}
          <Input value={label} onChangeText={setLabel} maxLength={LABEL_MAX} accessibilityLabel={t('statusLabelField')} autoFocus={builtIn} />
          {isMood && !builtIn ? (
            <>
              {fieldLabel('statusColorField')}
              <View style={{ flexDirection: rowOf(isRTL), flexWrap: 'wrap', gap: 12 }}>
                {MOOD_PRESETS.map((p, i) => (
                  <Pressable
                    key={p.id}
                    accessibilityRole="button"
                    accessibilityLabel={`${t('statusColorField')} ${i + 1}`}
                    accessibilityState={{ selected: preset === i }}
                    onPress={() => setPreset(i)}
                    style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: p.colors[0], borderWidth: preset === i ? 3 : 0, borderColor: colors.foreground }}
                  />
                ))}
              </View>
            </>
          ) : null}
          {error ? <Text style={{ color: colors.destructive, fontFamily: fontFamilyFor(language), fontSize: 13, marginTop: 12, textAlign: isRTL ? 'right' : 'left' }}>{t(error)}</Text> : null}
          {builtIn && item?.edited ? link('statusResetLabel', onReset, colors.primary) : null}
          {item?.custom ? link('statusDeleteItem', onDelete, colors.destructive) : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}
