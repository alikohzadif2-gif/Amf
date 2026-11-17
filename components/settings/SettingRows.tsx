import { Feather } from '@expo/vector-icons';
import {
  Children,
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  PanResponder,
  StyleSheet,
  Switch,
  type KeyboardTypeOptions,
} from 'react-native';
import { Text, TextInput } from '@/components/ui/ScaledText';
import { ScaledPressable as Pressable, ScaledView as View } from '@/components/ui/ScaledSurface';
import { useColors } from '@/hooks/useColors';
import { accentColors, type AccentName } from '@/constants/colors';
import { typography } from '@/constants/theme';
import { fontFamilyFor, useI18n, type TranslationKey } from '@/src/i18n';
import { alignOf, rowOf } from '@/src/lib/layout';
import { sectionLabelSpacing, sectionLabelText } from '@/src/lib/ui-text';
import { toDigits } from '@/src/lib/calendar';
import { useSettingsStore } from '@/src/state/settings-store';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

/**
 * later  -> backend not built yet: row is shown but disabled.
 * pref   -> the preference is saved now but takes effect in a later phase.
 */
export type RowBadge = 'later' | 'pref';

type BaseRowProps = {
  title: TranslationKey;
  description?: TranslationKey;
  badge?: RowBadge;
  icon?: keyof typeof Feather.glyphMap;
};

export function SettingGroup({
  title,
  children,
}: {
  title?: TranslationKey;
  children: ReactNode;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const rows = Children.toArray(children);
  return (
    <View style={styles.groupWrap}>
      {title ? (
        <Text
          style={[
            styles.groupTitle,
            {
              color: colors.mutedForeground,
              fontFamily: fontFamilyFor(language, 'medium'),
              textAlign: alignOf(isRTL),
              letterSpacing: sectionLabelSpacing(language, typography.sectionLabel.letterSpacing),
            },
          ]}
        >
          {sectionLabelText(t(title), language)}
        </Text>
      ) : null}
      <View
        style={[
          styles.group,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? (
              <View style={[styles.separator, { backgroundColor: colors.border }]} />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

export function BadgePill({ badge }: { badge: RowBadge }) {
  const colors = useColors();
  const { language, t } = useI18n();
  return (
    <View style={[styles.badge, { backgroundColor: colors.accent + '24' }]}>
      <Text
        style={[
          styles.badgeText,
          { color: colors.primary, fontFamily: fontFamilyFor(language, 'medium') },
        ]}
      >
        {t(badge === 'later' ? 'badgeLater' : 'badgePref')}
      </Text>
    </View>
  );
}

function RowText({ title, description, badge, icon }: BaseRowProps) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const align = alignOf(isRTL);
  const copy = (
    <>
      <Text
        style={[
          styles.rowTitle,
          {
            color: colors.foreground,
            fontFamily: fontFamilyFor(language, 'medium'),
            textAlign: align,
          },
        ]}
      >
        {t(title)}
      </Text>
      {description ? (
        <Text
          style={[
            styles.rowDescription,
            {
              color: colors.mutedForeground,
              fontFamily: fontFamilyFor(language),
              textAlign: align,
            },
          ]}
        >
          {t(description)}
        </Text>
      ) : null}
      {badge ? (
        <View style={[styles.badgeLine, { flexDirection: rowOf(isRTL) }]}>
          <BadgePill badge={badge} />
        </View>
      ) : null}
    </>
  );
  if (!icon) return <View style={styles.rowText}>{copy}</View>;

  return (
    <View style={[styles.rowText, styles.rowTextWithIcon, { flexDirection: rowOf(isRTL) }]}>
      <View style={[styles.leadingIcon, { backgroundColor: colors.accent + '24' }]}>
        <Feather name={icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.rowCopy}>{copy}</View>
    </View>
  );
}

function Row({
  children,
  disabled,
  stacked,
}: {
  children: ReactNode;
  disabled?: boolean;
  stacked?: boolean;
}) {
  const { isRTL } = useI18n();
  return (
    <View
      style={[
        styles.row,
        stacked
          ? { flexDirection: 'column', alignItems: 'stretch' }
          : { flexDirection: rowOf(isRTL), alignItems: 'center' },
        { opacity: disabled ? 0.5 : 1 },
      ]}
      pointerEvents={disabled ? 'none' : 'auto'}
    >
      {children}
    </View>
  );
}

export function SwitchRow({
  value,
  onChange,
  ...base
}: BaseRowProps & { value: boolean; onChange: (value: boolean) => void }) {
  const colors = useColors();
  return (
    <Row disabled={base.badge === 'later'}>
      <RowText {...base} />
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={base.title}
        trackColor={{ false: colors.track, true: colors.switchOn }}
        thumbColor="#FFFFFF"
      />
    </Row>
  );
}

export type SelectOption<T extends string> = { value: T; label: TranslationKey };

export function SelectRow<T extends string>({
  value,
  options,
  onChange,
  ...base
}: BaseRowProps & {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <Row stacked disabled={base.badge === 'later'}>
      <RowText {...base} />
      <View style={[styles.choiceRow, { flexDirection: rowOf(isRTL) }]}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={t(option.label)}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [
                styles.choice,
                {
                  backgroundColor: selected ? colors.primary : colors.background,
                  borderColor: selected ? colors.primary : colors.border,
                  opacity: pressed ? 0.78 : 1,
                },
              ]}
            >
              <Text
                style={[
                  styles.choiceText,
                  {
                    color: selected ? colors.primaryForeground : colors.foreground,
                    fontFamily: fontFamilyFor(language, selected ? 'medium' : 'regular'),
                  },
                ]}
              >
                {t(option.label)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Row>
  );
}

/** A reusable tappable setting row with a current value and RTL-aware chevron. */
export function ValueRow({
  value,
  onPress,
  ...base
}: BaseRowProps & { value: string; onPress: () => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t(base.title)}: ${value}`}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
    >
      <View style={[styles.row, { flexDirection: rowOf(isRTL), alignItems: 'center' }]}>
        <RowText {...base} />
        <Text
          numberOfLines={1}
          style={[styles.infoValue, { color: colors.mutedForeground, fontFamily: fontFamilyFor(language) }]}
        >
          {value}
        </Text>
        <Feather name={isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={colors.mutedForeground} />
      </View>
    </Pressable>
  );
}

/** A shared labeled segmented control for settings such as System / Light / Dark. */
export function SegmentedRow<T extends string>({
  options,
  value,
  onChange,
  ...base
}: BaseRowProps & {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { t } = useI18n();
  return (
    <Row stacked disabled={base.badge === 'later'}>
      <RowText {...base} />
      <SegmentedControl<T>
        fullWidth
        options={options.map((option) => ({
          value: option.value,
          label: t(option.label),
          accessibilityLabel: t(option.label),
        }))}
        value={value}
        onChange={onChange}
      />
    </Row>
  );
}

/** Shared accent selector; used by both the Settings home and Appearance section. */
export function AccentRow({
  value,
  onChange,
  ...base
}: BaseRowProps & { value: AccentName; onChange: (value: AccentName) => void }) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  return (
    <View style={[styles.row, styles.accentRow]}>
      <RowText {...base} />
      <View style={[styles.accentChoices, { flexDirection: rowOf(isRTL) }]}>
        {(Object.entries(accentColors) as [AccentName, string][]).map(([name, color]) => {
          const key = `accent${name[0].toUpperCase()}${name.slice(1)}` as TranslationKey;
          const selected = value === name;
          return (
            <Pressable
              key={name}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={t(key)}
              disabled={base.badge === 'later'}
              onPress={() => onChange(name)}
              style={[
                styles.accentChoice,
                { borderColor: selected ? colors.foreground : 'transparent' },
              ]}
            >
              <View style={[styles.accentSwatch, { backgroundColor: color }]}>
                {selected ? <Feather name="check" size={15} color="#FFFFFF" /> : null}
              </View>
              <Text
                numberOfLines={1}
                style={{ color: colors.mutedForeground, fontFamily: fontFamilyFor(language), fontSize: 10 }}
              >
                {t(key)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function SliderRow({
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  ...base
}: BaseRowProps & {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  const digits = useSettingsStore((state) => state.digits);
  const widthRef = useRef(1);
  const startXRef = useRef(0);
  const latest = useRef({ min, max, step, onChange, isRTL });
  latest.current = { min, max, step, onChange, isRTL };

  const apply = (x: number) => {
    const { min: lo, max: hi, step: st, onChange: emit, isRTL: rtl } = latest.current;
    let ratio = Math.min(1, Math.max(0, x / widthRef.current));
    if (rtl) ratio = 1 - ratio;
    const raw = lo + ratio * (hi - lo);
    const snapped = Math.round(raw / st) * st;
    emit(Math.min(hi, Math.max(lo, Number(snapped.toFixed(4)))));
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        startXRef.current = event.nativeEvent.locationX;
        apply(startXRef.current);
      },
      onPanResponderMove: (_event, gesture) => apply(startXRef.current + gesture.dx),
    }),
  ).current;

  const ratio = max === min ? 0 : (value - min) / (max - min);
  const shown = formatValue ? formatValue(value) : String(value);

  return (
    <Row stacked disabled={base.badge === 'later'}>
      <View style={[styles.sliderHead, { flexDirection: rowOf(isRTL) }]}>
        <RowText {...base} />
        <Text
          style={[
            styles.sliderValue,
            { color: colors.primary, fontFamily: fontFamilyFor(language, 'semibold') },
          ]}
        >
          {toDigits(shown, digits)}
        </Text>
      </View>
      <View
        style={styles.sliderHit}
        onLayout={(event) => {
          widthRef.current = Math.max(1, event.nativeEvent.layout.width);
        }}
        {...responder.panHandlers}
      >
        <View style={[styles.track, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.fill,
              {
                backgroundColor: colors.primary,
                width: `${ratio * 100}%`,
                ...(isRTL ? { right: 0 } : { left: 0 }),
              },
            ]}
          />
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              backgroundColor: colors.primary,
              borderColor: colors.card,
              ...(isRTL
                ? { right: `${ratio * 100}%`, marginRight: -11 }
                : { left: `${ratio * 100}%`, marginLeft: -11 }),
            },
          ]}
        />
      </View>
    </Row>
  );
}

export function TextRow({
  value,
  onSubmit,
  placeholder,
  keyboardType,
  secure,
  ...base
}: BaseRowProps & {
  value: string;
  onSubmit: (value: string) => void;
  placeholder?: TranslationKey;
  keyboardType?: KeyboardTypeOptions;
  secure?: boolean;
}) {
  const colors = useColors();
  const { language, isRTL, t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onSubmit(draft);
  };
  return (
    <Row stacked disabled={base.badge === 'later'}>
      <RowText {...base} />
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        placeholder={placeholder ? t(placeholder) : undefined}
        placeholderTextColor={colors.mutedForeground}
        keyboardType={keyboardType}
        secureTextEntry={secure}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t(base.title)}
        style={[
          styles.input,
          {
            color: colors.foreground,
            backgroundColor: colors.background,
            borderColor: colors.border,
            fontFamily: fontFamilyFor(language),
            textAlign: alignOf(isRTL),
          },
        ]}
      />
    </Row>
  );
}

export function ActionRow({
  onPress,
  busy,
  destructive,
  icon = 'chevron-right',
  ...base
}: BaseRowProps & {
  onPress?: () => void;
  busy?: boolean;
  destructive?: boolean;
  icon?: keyof typeof Feather.glyphMap;
}) {
  const colors = useColors();
  const { isRTL, t } = useI18n();
  const disabled = base.badge === 'later' || !onPress;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(base.title)}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : disabled ? 0.5 : 1 })}
    >
      <View style={[styles.row, { flexDirection: rowOf(isRTL), alignItems: 'center' }]}>
        <RowText {...base} />
        {busy ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Feather
            name={icon}
            size={19}
            color={destructive ? colors.destructive : colors.primary}
          />
        )}
      </View>
    </Pressable>
  );
}

export function NavRow({ onPress, ...base }: BaseRowProps & { onPress?: () => void }) {
  const colors = useColors();
  const { isRTL, t } = useI18n();
  const disabled = base.badge === 'later' || !onPress;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(base.title)}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : disabled ? 0.5 : 1 })}
    >
      <View style={[styles.row, { flexDirection: rowOf(isRTL), alignItems: 'center' }]}>
        <RowText {...base} />
        <Feather
          name={isRTL ? 'chevron-left' : 'chevron-right'}
          size={18}
          color={colors.mutedForeground}
        />
      </View>
    </Pressable>
  );
}

export function InfoRow({
  title,
  description,
  value,
}: {
  title: TranslationKey;
  description?: TranslationKey;
  value?: string;
}) {
  const colors = useColors();
  const { language, isRTL } = useI18n();
  return (
    <Row>
      <RowText title={title} description={description} />
      {value ? (
        <Text
          style={[
            styles.infoValue,
            { color: colors.mutedForeground, fontFamily: fontFamilyFor(language) },
          ]}
        >
          {value}
        </Text>
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  groupWrap: { marginBottom: 18 },
  groupTitle: { fontSize: 12, marginBottom: 8, paddingHorizontal: 4 },
  group: { borderWidth: 1, borderRadius: 21, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
  row: { paddingHorizontal: 16, paddingVertical: 14, gap: 12, minHeight: 58 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 14, lineHeight: 22 },
  rowDescription: { fontSize: 12, lineHeight: 19, marginTop: 2 },
  badgeLine: { marginTop: 7 },
  badge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 11 },
  choiceRow: { flexWrap: 'wrap', gap: 8, marginTop: 12 },
  choice: {
    minHeight: 38,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceText: { fontSize: 12 },
  sliderHead: { alignItems: 'center', gap: 12 },
  sliderValue: { fontSize: 13 },
  sliderHit: { height: 40, justifyContent: 'center', marginTop: 4 },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, bottom: 0, borderRadius: 3 },
  thumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
    top: 9,
  },
  input: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  infoValue: { fontSize: 12 },
  rowTextWithIcon: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowCopy: { flex: 1 },
  leadingIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  accentRow: { flexDirection: 'column', alignItems: 'stretch' },
  accentChoices: { flexWrap: 'wrap', gap: 8, marginTop: 12 },
  accentChoice: { minWidth: 52, minHeight: 62, borderWidth: 1.5, borderRadius: 14, alignItems: 'center', justifyContent: 'center', padding: 5, gap: 4 },
  accentSwatch: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
});
