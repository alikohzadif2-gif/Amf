import { Feather } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { Button } from '@/components/server/ui';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import type { LibraryEntry } from '../merge';
import { createAlbum, setAlbumItems, setTag, useUserData } from '../user-data';
import { resolveTypeTag, tagKeyOf, typeOptions } from '../type-tags';

function Sheet({
  title,
  visible,
  onClose,
  children,
}: {
  title: TranslationKey;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t(title)}
      cancelLabel={t('cancel')}
    >
      {children}
    </BottomSheet>
  );
}

function NameInput({
  placeholder,
  action,
  onSubmit,
}: {
  placeholder: TranslationKey;
  action: TranslationKey;
  onSubmit: (name: string) => void;
}) {
  const { isRTL, t } = useI18n();
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text);
    setText('');
  };
  return (
    <View style={[styles.inputRow, { flexDirection: rowOf(isRTL) }]}>
      <View style={{ flex: 1 }}>
        <Input
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          returnKeyType="done"
          placeholder={t(placeholder)}
          accessibilityLabel={t(placeholder)}
        />
      </View>
      <Button title={action} onPress={submit} primary compact icon="plus" />
    </View>
  );
}

function PickRow({ label, on, partial, onPress }: { label: string; on: boolean; partial?: boolean; onPress: () => void }) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pick,
        {
          flexDirection: rowOf(isRTL),
          backgroundColor: on ? colors.raised : colors.card,
          borderColor: on ? colors.primary : colors.border,
          opacity: pressed ? 0.76 : 1,
        },
      ]}
    >
      <Feather
        name={on ? 'check-circle' : partial ? 'minus-circle' : 'circle'}
        size={19}
        color={on || partial ? colors.primary : colors.mutedForeground}
      />
      <View style={[styles.pickLabel, { flexDirection: rowOf(isRTL) }]}>
        <Text
          numberOfLines={1}
          style={{
            flex: 1,
            color: colors.foreground,
            fontFamily: fontFamilyFor(language),
            fontSize: 15,
            textAlign: isRTL ? 'right' : 'left',
          }}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

/** Adds or removes types (tags) on all selected files and folders; several types per item. */
export function TagSheet({ entries, visible, onClose }: { entries: LibraryEntry[]; visible: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const allTags = useUserData((s) => s.allTags);
  const tagsByKey = useUserData((s) => s.tagsByKey);
  const count = (tag: string) => entries.filter((e) => tagsByKey[tagKeyOf(e)]?.includes(tag)).length;
  return (
    <Sheet title="tagAdd" visible={visible} onClose={onClose}>
      <NameInput placeholder="tagNew" action="tagCreate" onSubmit={(name) => setTag(entries, resolveTypeTag(name, t), true)} />
      <View style={styles.pickList}>
        {typeOptions(allTags, t).map((option) => {
          const n = count(option.tag);
          return (
            <PickRow
              key={option.tag}
              label={option.label}
              on={n === entries.length}
              partial={n > 0 && n < entries.length}
              onPress={() => setTag(entries, option.tag, n !== entries.length)}
            />
          );
        })}
      </View>
    </Sheet>
  );
}

/** Adds or removes the selected items from a manual album. */
export function AlbumSheet({ entries, visible, onClose }: { entries: LibraryEntry[]; visible: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const albums = useUserData((s) => s.albums);
  const albumKeys = useUserData((s) => s.albumKeys);
  const count = (id: number) => entries.filter((e) => albumKeys[id]?.includes(e.key)).length;
  return (
    <Sheet title="albumAddTo" visible={visible} onClose={onClose}>
      <NameInput
        placeholder="albumName"
        action="albumCreate"
        onSubmit={async (name) => {
          const id = await createAlbum(name);
          if (id !== null) await setAlbumItems(id, entries, true);
        }}
      />
      {albums.length === 0 ? (
        <EmptyState message={t('albumEmpty')} />
      ) : (
        <View style={styles.pickList}>
          {albums.map((album) => {
            const n = count(album.id);
            return (
              <PickRow
                key={album.id}
                label={album.name}
                on={n === entries.length}
                partial={n > 0 && n < entries.length}
                onPress={() => setAlbumItems(album.id, entries, n !== entries.length)}
              />
            );
          })}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  inputRow: { alignItems: 'center', gap: 10 },
  pickList: { gap: 8 },
  pick: { minHeight: 58, alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1, borderRadius: 18 },
  pickLabel: { flex: 1 },
});
