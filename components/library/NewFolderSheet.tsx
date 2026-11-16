import { useEffect, useState } from 'react';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/src/i18n';

/** Asks for a folder name (Android has no text prompt). Render it as the last child of a screen (BottomSheet rule). */
export function NewFolderSheet({ visible, onClose, onCreate }: { visible: boolean; onClose: () => void; onCreate: (name: string) => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  useEffect(() => { if (visible) setName(''); }, [visible]);
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t('driveNewFolder')}
      cancelLabel={t('cancel')}
      actionLabel={t('driveCreate')}
      actionDisabled={name.trim().length === 0}
      onAction={() => { onClose(); onCreate(name.trim()); }}
    >
      <Input value={name} onChangeText={setName} placeholder={t('driveNewFolderName')} autoFocus />
    </BottomSheet>
  );
}
