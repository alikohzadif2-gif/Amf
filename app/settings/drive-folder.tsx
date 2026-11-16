import { useRouter } from 'expo-router';
import { DriveFolderBrowser } from '@/components/drive/DriveFolderBrowser';
import { ScreenFrame } from '@/components/ScreenFrame';
import { BackButton, Title } from '@/components/server/ui';
import { chooseDriveRoot } from '@/src/drive/manage';
import { useI18n } from '@/src/i18n';

/** Pick the Drive folder the Archive and Explore read from (the top of My Drive itself is not allowed: it would index everything). */
export default function DriveFolderScreen() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <ScreenFrame scroll>
      <BackButton />
      <Title title="driveFolderPickTitle" intro="driveFolderDesc" />
      <DriveFolderBrowser
        start={{ id: 'root', name: t('driveMyDrive') }}
        allowStart={false}
        onUse={(folder) => {
          chooseDriveRoot(folder);
          router.back();
        }}
      />
    </ScreenFrame>
  );
}
