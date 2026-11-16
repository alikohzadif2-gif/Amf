import type { ComponentType } from 'react';
import AppearanceSection from './AppearanceSection';
import BackupRestoreSection from './BackupRestoreSection';
import GoogleDriveSection from './GoogleDriveSection';
import LanguageCalendarSection from './LanguageCalendarSection';
import MediaCacheSection from './MediaCacheSection';
import PartnerNotificationsSection from './PartnerNotificationsSection';
import SecuritySection from './SecuritySection';
import ServerConnectionSection from './ServerConnectionSection';
import SourcesSyncSection from './SourcesSyncSection';
import ToolsSection from './ToolsSection';

/** Keys match the ids in src/constants/settings-sections.ts. */
export const sectionComponents: Record<string, ComponentType> = {
  'sources-sync': SourcesSyncSection,
  'google-drive': GoogleDriveSection,
  'server-connection': ServerConnectionSection,
  'backup-restore': BackupRestoreSection,
  'media-cache': MediaCacheSection,
  'partner-notifications': PartnerNotificationsSection,
  'language-calendar': LanguageCalendarSection,
  appearance: AppearanceSection,
  security: SecuritySection,
  tools: ToolsSection,
};
