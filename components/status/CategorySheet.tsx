import { useEffect, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BottomSheet, Input } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { LABEL_MAX, normalizeLabel } from '@/src/partner/status-custom';

export type CategorySheetTarget = { name: string; edited: boolean; showNames: boolean };
export type CategorySheetResult = { name: string; showNames: boolean };

/** Q5: rename one Status category (press and hold its chip) and choose whether its text shows; "back to the original name" when edited. */
export function CategorySheet({ target, onClose, onSave, onReset }: { target: CategorySheetTarget | null; onClose: () => void; onSave: (r: CategorySheetResult) => void; onReset: () => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const [name, setName] = useState('');
  const [showNames, setShowNames] = useState(true);
  useEffect(() => {
    if (!target) return;
    setName(target.name);
    setShowNames(target.showNames);
  }, [target]);
  const ready = normalizeLabel(name) !== '';
  return (
    <BottomSheet visible={!!target} onClose={onClose} title={t('statusEditCategory')} cancelLabel={t('cancel')} actionLabel={t('archiveSave')} actionDisabled={!ready} onAction={() => onSave({ name, showNames })}>
      {target ? (
        <View>
          <Text style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language, 'medium'), fontSize: 13, marginTop: 14, marginBottom: 6, textAlign: isRTL ? 'right' : 'left' }}>{t('statusLabelField')}</Text>
          <Input value={name} onChangeText={setName} maxLength={LABEL_MAX} accessibilityLabel={t('statusLabelField')} autoFocus />
          <View style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, marginTop: 16 }}>
            <Text style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 15, textAlign: isRTL ? 'right' : 'left' }}>{t('statusShowCatName')}</Text>
            <Switch value={showNames} onValueChange={setShowNames} accessibilityLabel={t('statusShowCatName')} trackColor={{ false: colors.track, true: colors.switchOn }} thumbColor="#FFFFFF" />
          </View>
          {target.edited ? (
            <Pressable accessibilityRole="button" onPress={onReset} style={({ pressed }) => ({ paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold'), fontSize: 15, textAlign: 'center' }}>{t('statusResetLabel')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}
