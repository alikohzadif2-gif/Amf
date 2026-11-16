import { Feather } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { BackButton, Notice, Title } from '@/components/server/ui';
import { ScreenFrame } from '@/components/ScreenFrame';
import { useColors } from '@/hooks/useColors';
import { isGalleryAlbum } from '@/src/backup/backup-new';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { providerFor } from '@/src/library/providers';
import { useSettingsStore } from '@/src/state/settings-store';
import type { StorageItem } from '@/src/storage/types';

/** Settings > Backup > Choose albums: the phone folders whose photos and videos are backed up. */
export default function BackupAlbumsScreen() {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const chosen = useSettingsStore((s) => s.backupAlbums);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const [albums, setAlbums] = useState<StorageItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const phone = providerFor('local');
        if (!phone) return alive && setAlbums([]);
        let access = await phone.test();
        if (!access.ok && phone.requestAccess) access = await phone.requestAccess();
        const roots = access.ok ? (await phone.list(null)).items.filter(isGalleryAlbum) : [];
        if (alive) setAlbums(roots);
      } catch {
        if (alive) setAlbums([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (id: string) =>
    setSetting('backupAlbums', chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

  return (
    <ScreenFrame>
      <BackButton />
      <Title title="backupAlbumsTitle" intro="backupAlbumsIntro" />
      {albums === null ? (
        <ActivityIndicator color={colors.primary} />
      ) : albums.length === 0 ? (
        <Notice>{t('backupAlbumsEmpty')}</Notice>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false}>
          {albums.map((album) => {
            const on = chosen.includes(album.id);
            return (
              <Pressable
                key={album.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={album.name}
                onPress={() => toggle(album.id)}
                style={{ flexDirection: rowOf(isRTL), alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
              >
                <Feather name={on ? 'check-square' : 'square'} size={22} color={on ? colors.primary : colors.mutedForeground} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 15, textAlign: alignOf(isRTL) }}>{album.name}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </ScreenFrame>
  );
}
