import type { ComponentType } from 'react';
import AppearanceSection from './AppearanceSection';
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
  'server-connection': ServerConnectionSection,
  'media-cache': MediaCacheSection,
  'partner-notifications': PartnerNotificationsSection,
  'language-calendar': LanguageCalendarSection,
  appearance: AppearanceSection,
  security: SecuritySection,
  tools: ToolsSection,
};
