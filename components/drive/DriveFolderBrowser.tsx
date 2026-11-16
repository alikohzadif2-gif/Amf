import { Feather } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { Button, Card, Notice } from '@/components/server/ui';
import { Input } from '@/components/ui/Input';
import { useColors } from '@/hooks/useColors';
import { driveProvider } from '@/src/drive/manage';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';

export type DriveFolderChoice = { id: string; name: string };

/**
 * Browse the folders of Google Drive from `start` downward (never above it), make a new folder, and pick one.
 * Used by Settings (start = My Drive) and by the Diary (start = the Archive's folder, so a memory's files stay in the Archive).
 */
export function DriveFolderBrowser({
  start,
  allowStart,
  onUse,
}: {
  start: DriveFolderChoice;
  /** May the start folder itself be chosen? (Not in Settings: choosing all of My Drive would index everything.) */
  allowStart: boolean;
  onUse: (folder: DriveFolderChoice) => void;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const [trail, setTrail] = useState<DriveFolderChoice[]>([start]);
  const [folders, setFolders] = useState<DriveFolderChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const current = trail[trail.length - 1]!;

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setFailed(false);
    try {
      setFolders((await driveProvider()?.listFolders(id)) ?? []);
    } catch {
      setFolders([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(current.id); }, [current.id, load]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const made = await driveProvider()?.makeFolder(name, current.id);
      setNewName('');
      setCreating(false);
      if (made) setFolders((list) => [...list, made].sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      Alert.alert(t('driveCreateFailed'));
    }
  };

  return (
    <View>
      <Notice>{trail.map((c) => c.name).join(' › ')}</Notice>
      <Card>
        {loading ? <ActivityIndicator color={colors.primary} /> : null}
        {failed ? <Notice tone="error">{t('driveSignInFailed')}</Notice> : null}
        {!loading && !failed && folders.length === 0 ? <Notice>{t('driveFolderEmpty')}</Notice> : null}
        {folders.map((folder) => (
          <Pressable
            key={folder.id}
            accessibilityRole="button"
            onPress={() => setTrail((x) => [...x, folder])}
            style={({ pressed }) => [styles.row, { flexDirection: rowOf(isRTL), opacity: pressed ? 0.7 : 1, borderBottomColor: colors.border }]}
          >
            <Feather name="folder" size={20} color={colors.primary} />
            <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontFamily: fontFamilyFor(language), fontSize: 15, textAlign: alignOf(isRTL) }}>{folder.name}</Text>
            <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={colors.mutedForeground} />
          </Pressable>
        ))}
      </Card>
      {trail.length > 1 ? <Button title="back" onPress={() => setTrail((x) => x.slice(0, -1))} icon="corner-left-up" /> : null}
      {creating ? (
        <View style={{ marginVertical: 12, gap: 10 }}>
          <Input value={newName} onChangeText={setNewName} placeholder={t('driveNewFolderName')} autoFocus />
          <Button title="driveCreate" onPress={create} disabled={newName.trim().length === 0} />
        </View>
      ) : (
        <Button title="driveNewFolder" icon="folder-plus" onPress={() => setCreating(true)} />
      )}
      <View style={{ height: 10 }} />
      <Button title="driveFolderUse" primary disabled={!allowStart && trail.length === 1} onPress={() => onUse(current)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
