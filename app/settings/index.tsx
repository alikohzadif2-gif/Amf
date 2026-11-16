import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { Avatar } from '@/components/partner/Avatar';
import { ScreenFrame } from '@/components/ScreenFrame';
import { AccentRow, NavRow, SegmentedRow, SelectRow, SettingGroup, ValueRow } from '@/components/settings/SettingRows';
import { ResetSettingsRow } from '@/components/settings/ResetSettingsRow';
import { ScreenHeader } from '@/components/ui';
import { useColors } from '@/hooks/useColors';
import { fontFamilyFor, useI18n } from '@/src/i18n';
import { rowOf } from '@/src/lib/layout';
import { settingsSections } from '@/src/constants/settings-sections';
import { usePartnerStore } from '@/src/state/partner-store';
import { useSettingsStore } from '@/src/state/settings-store';

const MAIN_SECTION_IDS = new Set(['google-drive', 'media-cache', 'security', 'tools']);

export default function SettingsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { language, isRTL, t } = useI18n();
  const me = usePartnerStore((state) => state.me);
  const settings = useSettingsStore();
  const visibleSections = settingsSections.filter(
    (section) => MAIN_SECTION_IDS.has(section.id) || !!section.flag,
  );
  const align = isRTL ? 'right' : 'left';

  const openSection = (section: string) =>
    router.push({ pathname: '/settings/[section]', params: { section } });

  return (
    <ScreenFrame scroll>
      <ScreenHeader title={t('settings')} />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${me.name || t('profileNoName')}, ${t('profileEdit')}`}
        onPress={() => router.push('/settings/profile')}
        style={({ pressed }) => [
          styles.profileCard,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: rowOf(isRTL),
            opacity: pressed ? 0.75 : 1,
          },
        ]}
      >
        <Avatar b64={me.avatarB64} uri={me.avatarUri} name={me.name} size={62} />
        <View style={styles.profileCopy}>
          <Text
            numberOfLines={1}
            style={[
              styles.profileName,
              { color: colors.foreground, fontFamily: fontFamilyFor(language, 'semibold'), textAlign: align },
            ]}
          >
            {me.name || t('profileNoName')}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.profileEdit,
              { color: colors.mutedForeground, fontFamily: fontFamilyFor(language), textAlign: align },
            ]}
          >
            {t('profileEdit')}
          </Text>
        </View>
        <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={19} color={colors.mutedForeground} />
      </Pressable>

      <SettingGroup title="settingsGeneral">
        <SelectRow
          title="language"
          icon="globe"
          value={language}
          onChange={settings.setLanguage}
          options={[
            { value: 'fa', label: 'persian' },
            { value: 'en', label: 'english' },
          ]}
        />
        <ValueRow
          title="calendar"
          icon="calendar"
          value={t(settings.calendarMode)}
          onPress={() => openSection('language-calendar')}
        />
        <SegmentedRow
          title="theme"
          icon="moon"
          value={settings.theme}
          onChange={settings.setTheme}
          options={[
            { value: 'auto', label: 'system' },
            { value: 'light', label: 'light' },
            { value: 'dark', label: 'dark' },
          ]}
        />
        <SelectRow
          title="displaySize"
          icon="type"
          value={settings.displaySize}
          onChange={settings.setDisplaySize}
          options={[
            { value: 'small', label: 'displaySizeSmall' },
            { value: 'normal', label: 'displaySizeNormal' },
            { value: 'large', label: 'displaySizeLarge' },
            { value: 'extraLarge', label: 'displaySizeExtraLarge' },
          ]}
        />
        <AccentRow
          title="accentColor"
          icon="droplet"
          value={settings.accent}
          onChange={settings.setAccent}
        />
        <SelectRow
          title="digits"
          icon="hash"
          value={settings.digits}
          onChange={settings.setDigits}
          options={[
            { value: 'persian', label: 'persianDigits' },
            { value: 'latin', label: 'latinDigits' },
          ]}
        />
        <NavRow
          title="widgetSetup"
          description="widgetSetupDesc"
          icon="grid"
          onPress={() => router.push('/settings/widget')}
        />
      </SettingGroup>

      <SettingGroup>
        <NavRow
          title="homeLibrary"
          description="homeLibraryHint"
          icon="image"
          onPress={() => router.push('/library')}
        />
      </SettingGroup>

      <SettingGroup title="settingsSections">
        {visibleSections.map((section) => (
          <NavRow
            key={section.id}
            title={section.title}
            icon={section.icon}
            onPress={() => openSection(section.id)}
          />
        ))}
      </SettingGroup>

      <SettingGroup title="settingsLegal">
        <NavRow
          title="privacyPolicy"
          icon="shield"
          onPress={() => router.push('/settings/privacy')}
        />
        <NavRow
          title="termsOfService"
          icon="file-text"
          onPress={() => router.push('/settings/terms')}
        />
      </SettingGroup>

      <SettingGroup title="settingsAccount">
        <ResetSettingsRow />
      </SettingGroup>
    </ScreenFrame>
  );
}

const styles = StyleSheet.create({
  profileCard: {
    alignItems: 'center',
    gap: 14,
    borderRadius: 26,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 15,
    marginTop: 8,
    marginBottom: 22,
  },
  profileCopy: { flex: 1, gap: 3 },
  profileName: { fontSize: 17 },
  profileEdit: { fontSize: 13 },
});
