import type { TranslationKey } from '@/src/i18n';
import { FEATURES } from '@/src/constants/features';

export type SettingsSection = {
  id: string;
  title: TranslationKey;
  icon:
    | 'folder'
    | 'cloud'
    | 'server'
    | 'download'
    | 'image'
    | 'users'
    | 'globe'
    | 'sliders'
    | 'shield'
    | 'tool';
  /** Hidden while this feature flag is off (src/constants/features.ts). */
  flag?: keyof typeof FEATURES;
};

const allSections: SettingsSection[] = [
  { id: 'sources-sync', title: 'sourcesSync', icon: 'folder', flag: 'serverLibrary' },
  { id: 'google-drive', title: 'googleDrive', icon: 'cloud' },
  { id: 'server-connection', title: 'serverConnection', icon: 'server', flag: 'server' },
  { id: 'backup-restore', title: 'backupRestore', icon: 'download', flag: 'serverBackup' },
  { id: 'media-cache', title: 'mediaCache', icon: 'image' },
  {
    id: 'partner-notifications',
    title: 'partnerNotifications',
    icon: 'users',
    flag: 'partner',
  },
  { id: 'language-calendar', title: 'languageCalendar', icon: 'globe' },
  { id: 'appearance', title: 'appearanceSettings', icon: 'sliders' },
  { id: 'security', title: 'security', icon: 'shield' },
  { id: 'tools', title: 'tools', icon: 'tool' },
];

export const settingsSections: SettingsSection[] = allSections.filter((s) => !s.flag || FEATURES[s.flag]);
